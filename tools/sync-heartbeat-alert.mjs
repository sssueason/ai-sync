#!/usr/bin/env node
/**
 * sync-heartbeat-alert —— 跨机心跳告警（补 Windows 侧；mac 侧原本只有 osascript 一条）
 *
 * 为什么需要（审计 XD-5 / §8.2）：`sync/state/tick-<machine>.json` 是**自报**快照，且只由各机的
 * daily（1–2 次/天）写入 ⇒ 光看它无法区分三种完全不同的状态：
 *   ① 该机 tick 真停了（要救）   ② 该机 daily 今天还没跑（快照过期，但机器活着）   ③ 该机离线
 * 本工具把三态分开报，并在**状态变化**时弹本机通知（Windows 气泡 / macOS 通知），避免刷屏。
 *
 * 判据（与 sync/state/README.md 的契约对齐，并补两条）：
 *   · 本机（self）：看**本地 tick 日志**（每轮都写 ⇒ 新鲜）→ 末行时间 > staleMin*3 视为停
 *   · 对端（peer）：看**已提交快照**
 *       - heavy.lastStartedAt  > heavyStaleHours(26h)          → ALERT 重活未跑
 *       - writtenAt            > snapStaleHours(14h)           → ALERT 快照过期（该机 daily 没跑）
 *       - tick.lastAt          > staleMin(20min) 且 writtenAt 新鲜(<2h) → ALERT tick 停
 *     ★ 关键：只有"快照本身新鲜"时才敢断言"对端 tick 停了"；否则只报"快照过期"。
 *       否则一个 9 小时前的快照会被误读成"tick 停了"（本机 2026-09-18 实测正是这个形态）。
 *
 * 用法：node tools/sync-heartbeat-alert.mjs [--instance <dir>] [--no-notify] [--rc] [--json] [--quiet]
 *   --rc      有告警时 exit 1（给 daily 用；**不要**放进 tick 的 rc，避免每 20 分钟一次假红）
 *   --no-notify  只算不弹（排障用）
 * 退出码：0 = 无告警（或未加 --rc）；1 = 有告警且加了 --rc；2 = 用法/环境错误
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const ENGINE = resolve(val('--engine') || process.env.AI_SYNC_ENGINE || join(HERE, '..'));
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);
const STATE = join(INSTANCE, 'sync', 'state');
const LOGS = join(INSTANCE, 'sync', 'logs');
const DRY = has('--dry-run');

// ★ 阈值必须**从配置推导**，不能硬编码：`sync/state/README.md` 写的是"20 分钟（4× 5 分钟间隔）"，
// 但 instance.json 的 tick.intervalMinutes 现在是 20 ⇒ 4× 规则应为 80 分钟。硬编码 20 会把
// "漏跑一轮"误报成"停了"（假红一多，人就开始忽略所有红 —— 项目自述的教训）。
// 本机 2026-09-18 实测：campus 34 分钟未 tick，按 4×20=80 就不该报。
function readIntervalMinutes() {
  try {
    const j = JSON.parse(readFileSync(join(INSTANCE, 'sync', 'instance.json'), 'utf8'));
    const n = Number(j?.tick?.intervalMinutes);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 缺失/坏 JSON ⇒ 用默认 */ }
  return 20;
}
const TICK_INTERVAL_MIN = readIntervalMinutes();
const WARN_MIN = Number(val('--warn-min', String(TICK_INTERVAL_MIN * 2)));       // 错过一轮（只记 INFO）
const STALE_MIN = Number(val('--stale-min', String(TICK_INTERVAL_MIN * 4)));     // 4× 间隔 ⇒ ALERT
const HEAVY_STALE_H = Number(val('--heavy-stale-hours', '26')); // 重活判停阈值（契约值）
const SNAP_STALE_H = Number(val('--snap-stale-hours', '14'));   // 快照自身过期阈值（daily 1–2 次/天 ⇒ 14h 足够宽）
const SNAP_FRESH_H = Number(val('--snap-fresh-hours', '2'));    // "敢断言对端 tick 停了"的前提：快照足够新鲜

const machine =
  process.env.AI_SYNC_MACHINE ||
  process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim() : hostname().toLowerCase());

const ALERT_STATE = join(STATE, `.heartbeat-alert-${machine}.json`);
const RENOTIFY_H = 6; // 同一告警最多每 6 小时重弹一次（否则被遗忘）

const say = (s) => { if (!has('--quiet')) console.log(s); };
const now = () => Date.now();
const ageMin = (ms) => (now() - ms) / 60000;
const parseTs = (s) => { // "2026-09-18 22:01:57"
  if (!s || typeof s !== 'string') return null;
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
};

const alerts = [];
const infos = [];

/* ---------- 本机：看本地 tick 日志（新鲜、每轮都写） ---------- */
function checkSelf() {
  const cands = [join(LOGS, `tick-${machine}.log`)];
  const today = new Date();
  const ymd = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`;
  cands.push(join(LOGS, `tick-${ymd}.log`));
  const f = cands.find((p) => existsSync(p));
  if (!f) { infos.push(`本机 tick 日志不存在（${cands[0]}）⇒ 无法判定本机 tick 是否在跑`); return; }
  let last = 0;
  try {
    const lines = readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).slice(-40);
    for (const l of lines.reverse()) {
      const m = l.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      const t = m && parseTs(m[1]);
      if (t) { last = t; break; }
    }
  } catch { /* 读不到就当没信号 */ }
  if (!last) { infos.push('本机 tick 日志里找不到时间戳 ⇒ 跳过本机判活'); return; }
  const age = ageMin(last);
  if (age > STALE_MIN) alerts.push({ key: `self-tick-stale`, who: machine, what: `本机 tick 已 ${Math.round(age)} 分钟没写日志（阈值 ${STALE_MIN} = 4×${TICK_INTERVAL_MIN}）→ 计划任务/launchd 可能停了`, ageMin: Math.round(age) });
  else if (age > WARN_MIN) infos.push(`本机 tick 落后 ${Math.round(age)} 分钟（阈值 ${WARN_MIN}：可能只是漏跑一轮）`);
  else infos.push(`本机 tick 正常（${Math.round(age)} 分钟前）`);
}

/* ---------- 对端：看已提交快照 ---------- */
function checkPeers() {
  let files = [];
  try { files = readdirSync(STATE).filter((f) => /^tick-.+\.json$/.test(f)); } catch { /* 目录不存在 */ }
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(readFileSync(join(STATE, f), 'utf8')); } catch { continue; }
    const who = j.machine || f.replace(/^tick-/, '').replace(/\.json$/, '');
    if (who === machine) continue;
    const writtenAt = parseTs(j.writtenAt);
    const lastTick = parseTs(j.tick?.lastAt);
    const heavyAt = parseTs(j.heavy?.lastStartedAt);
    const wAgeH = writtenAt ? ageMin(writtenAt) / 60 : null;
    const tAgeMin = lastTick ? ageMin(lastTick) : null;
    const hAgeH = heavyAt ? ageMin(heavyAt) / 60 : null;

    if (wAgeH === null) { infos.push(`${who}: 快照缺 writtenAt ⇒ 无法判定`); continue; }
    if (wAgeH > SNAP_STALE_H) {
      alerts.push({ key: `${who}-snapshot-stale`, who, what: `${who} 的心跳快照已过期 ${wAgeH.toFixed(1)}h（阈值 ${SNAP_STALE_H}h）→ 该机 daily 没在跑；**不能据此判定其 tick 停了**`, ageHours: Number(wAgeH.toFixed(1)) });
      continue; // 快照过期时不再对 tick 下结论（避免误报）
    }
    if (tAgeMin !== null && tAgeMin > STALE_MIN && wAgeH <= SNAP_FRESH_H) {
      alerts.push({ key: `${who}-tick-stale`, who, what: `${who} 的 tick 最后一次是 ${Math.round(tAgeMin)} 分钟前（阈值 ${STALE_MIN} = 4×${TICK_INTERVAL_MIN}）且快照新鲜（${wAgeH.toFixed(1)}h）→ 该机 tick 大概率已停`, ageMin: Math.round(tAgeMin) });
    }
    if (hAgeH !== null && hAgeH > HEAVY_STALE_H) {
      alerts.push({ key: `${who}-heavy-stale`, who, what: `${who} 的重活已 ${hAgeH.toFixed(1)}h 未跑（阈值 ${HEAVY_STALE_H}h）`, ageHours: Number(hAgeH.toFixed(1)) });
    }
    // ★ 措辞必须如实：快照不够新鲜时**不能**说"正常"，只能说"只能确认它最后一次 tick 在何时"
    if (!alerts.some((a) => a.who === who)) {
      const tTxt = tAgeMin === null ? '未知' : `${Math.round(tAgeMin)} 分钟前`;
      if (wAgeH > SNAP_FRESH_H) {
        infos.push(`${who}: 快照 ${wAgeH.toFixed(1)}h（该机 daily 未跑）⇒ 只能确认它最后一次 tick 在 ${tTxt}；**它现在是否在跑，本机无法判定**`);
        if (tAgeMin !== null && tAgeMin > WARN_MIN) infos.push(`${who}: 按快照口径已落后 ${Math.round(tAgeMin)} 分钟（>${WARN_MIN}），但快照不新鲜 ⇒ 先不计告警`);
      } else {
        infos.push(`${who}: 正常（tick ${tTxt}，快照 ${wAgeH.toFixed(1)}h）`);
      }
    }
  }
}

/* ---------- 通知（状态变化去重 + 最多 6h 重弹一次） ---------- */
function loadAlertState() {
  try { return JSON.parse(readFileSync(ALERT_STATE, 'utf8')); } catch { return { sig: '', at: 0 }; }
}
function saveAlertState(sig) {
  try {
    mkdirSync(dirname(ALERT_STATE), { recursive: true });
    const tmp = `${ALERT_STATE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sig, at: now(), machine }, null, 2));
    renameSync(tmp, ALERT_STATE);
  } catch { /* 状态写不了不影响告警本身 */ }
}
function notify(title, body) {
  const t = String(title).replace(/'/g, "''");
  const b = String(body).replace(/'/g, "''").slice(0, 240);
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $n=New-Object System.Windows.Forms.NotifyIcon; $n.Icon=[System.Drawing.SystemIcons]::Warning; $n.Visible=$true; $n.ShowBalloonTip(15000,'${t}','${b}',[System.Windows.Forms.ToolTipIcon]::Warning); Start-Sleep -Seconds 8; $n.Dispose()`;
      spawn('powershell', ['-NoProfile', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification "${b}" with title "${t}" sound name "Basso"`], { detached: true, stdio: 'ignore' }).unref();
    } else {
      say(`[ALERT] ${title}: ${b}`);
    }
  } catch { /* best-effort：通知失败不影响判据 */ }
}

/* ---------- 主流程 ---------- */
checkSelf();
checkPeers();

const sig = alerts.map((a) => a.key).sort().join('|');
const prev = loadAlertState();
const changed = sig !== prev.sig;
const reNotify = prev.at && ageMin(prev.at) / 60 > RENOTIFY_H;
if (!DRY) saveAlertState(sig);

if (has('--json')) {
  console.log(JSON.stringify({ machine, at: new Date().toISOString(), alerts, infos, changed, notified: false }, null, 2));
} else {
  for (const i of infos) say(`[ok] ${i}`);
  for (const a of alerts) say(`[ALERT] ${a.what}`);
  if (alerts.length === 0) say('心跳：全部正常');
}
if (alerts.length > 0 && !DRY && !has('--no-notify') && (changed || reNotify)) {
  notify('同步心跳告警', alerts.map((a) => a.what).join('；'));
  say(`[notify] 已弹通知（${changed ? '状态变化' : '距上次 >' + RENOTIFY_H + 'h'}）：${alerts.map((a) => a.who).join(',')}`);
}
if (alerts.length > 0 && has('--rc')) process.exitCode = 1;
