#!/usr/bin/env node
/**
 * sync-heartbeat-alert —— 跨机心跳告警（补 Windows 侧；对端 侧原本只有 osascript 一条）
 *
 * 为什么需要（审计 XD-5 / §8.2）：`sync/state/tick-<machine>.json` 是**自报**快照，且只由各机的
 * daily（1–2 次/天）写入 ⇒ 光看它无法区分三种完全不同的状态：
 *   ① 该机 tick 真停了（要救）   ② 该机 daily 今天还没跑（快照过期，但机器活着）   ③ 该机离线
 * 本工具把三态分开报，并在**状态变化**时弹本机通知（Windows 气泡 / macOS 通知），避免刷屏。
 *
 * 判据（与 sync/state/README.md 的契约对齐，并补两条）：
 *   · 本机（self）：看**本地 tick 日志**（每轮都写 ⇒ 新鲜）→ 末行时间 > staleMin*3 视为停
 *   · 对端（peer）分两个数据源，**各问各的**（2026-09-19 修，理由见下方 ★）：
 *       - **tick 在跑吗？** ← 每轮推上来的状态（`sync-state` 分支 `state/<machine>.json`）里的
 *                              `tick.lastAt` > 4×该机 intervalMin → ALERT tick 停；
 *                              读不到同源状态 ⇒ 只报"无法判定"，**不**拿照片告警
 *       - **夜间重活跑了吗？** ← 已提交快照：`heavy.lastStartedAt` > 26h / `writtenAt` > 14h → ALERT
 *     ★ 为什么必须分开（2026-09-19 实测假红）：快照里的 `tick.lastAt` 是**一次性照片**、冻在写入那一刻，
 *       而 `tAge ≈ 快照龄` ⇒ 只要快照龄落在 80 分钟~2 小时之间，就**必然**判对端 tick 停了
 *       （实测：campus 快照 13:40 写、里面记的 tick 是 13:32，14:56/15:17/15:36 连续三轮被误报）。
 *       代价：**每台机器每晚跑完重活，对端都会必然假报一次**，并天天把"连续 72h 零告警"的退役门禁
 *       顶回去（门禁因此永远过不去）。照片只能用来看"照片里那一刻"，不能用它判"现在在不在跑"。
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
import { maintenanceOf as maintOf, maintText } from './lib/maintenance.mjs';
// 2026-09-19：对端"tick 还在跑吗"的判据改用**每轮推上来的状态**（sync-state 分支），
// 不再用快照里那个冻结的 tick.lastAt（详见 checkPeers() 的函数头注释）。
import { readFleet } from './sync-state.mjs';

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
// 本机 2026-09-18 实测：对端 34 分钟未 tick，按 4×20=80 就不该报。
function readIntervalMinutes() {
  try {
    const j = JSON.parse(readFileSync(join(INSTANCE, 'sync', 'instance.json'), 'utf8'));
    const n = Number(j?.tick?.intervalMinutes);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* 缺失/坏 JSON ⇒ 用默认 */ }
  return 20;
}
const TICK_INTERVAL_MIN = readIntervalMinutes();
// 宽容同步的机器（移动端/按需同步）：**不预警**，只记录 —— 用户裁决 2026-09-18（mac 作为移动端）。
// 名单属**实例配置**（instance.json 的 heartbeat.tolerantMachines），刻意不写死在公开引擎里。
// 语义：本机在名单里 ⇒ 跳过本机判活；对端在名单里 ⇒ 只记 INFO（不 ALERT、不弹通知、不计 rc）。
function readTolerant() {
  try {
    const j = JSON.parse(readFileSync(join(INSTANCE, 'sync', 'instance.json'), 'utf8'));
    const list = j?.heartbeat?.tolerantMachines;
    if (Array.isArray(list)) return new Set(list.map((x) => String(x)));
  } catch {}
  return new Set();
}
const TOLERANT = (() => {
  const ov = val('--tolerant', null);
  if (ov !== null) return new Set(String(ov).split(',').map((s) => s.trim()).filter(Boolean));
  return readTolerant();
})();
const WARN_MIN = Number(val('--warn-min', String(TICK_INTERVAL_MIN * 2)));       // 错过一轮（只记 INFO）
const STALE_MIN = Number(val('--stale-min', String(TICK_INTERVAL_MIN * 4)));     // 4× 间隔 ⇒ ALERT
const HEAVY_STALE_H = Number(val('--heavy-stale-hours', '26')); // 重活判停阈值（契约值）
const SNAP_STALE_H = Number(val('--snap-stale-hours', '14'));   // 快照自身过期阈值（daily 1–2 次/天 ⇒ 14h 足够宽）
// 注：原先这里还有一个 SNAP_FRESH_H(2h)——"敢断言对端 tick 停了"的前提。2026-09-19 取消：
//     对端 tick 的判据已改用**每轮状态**（同源），不再依赖"快照够不够新鲜"这个代理条件。
//     （保留这个说明是因为它正是那条假红的根源：用照片的新鲜度去担保一个它回答不了的问题。）

/* ★ 跨端维护登记（2026-09-19 新增，闭掉审计里的"对端维护状态互相不可见"）：
 *   本机做维护时，对端只能从"它不 tick 了"推断，长得和故障一模一样 —— 实测某台对端按用户指令
 *   暂停自动化后，本机每轮都判"该机 tick 疑似已停"，并在 6 小时里反复弹。所以维护也要**有登记**。
 *   与本地 .freeze-<machine> 的分工：本地标记 = 瞬时、不必让对端知道；本文件 = 跨天、要让对端别报。
 *   到期自动恢复判活（避免"维护"变成永久静默）。
 *   规则实现在 tools/lib/maintenance.mjs（与传输健康检查共用一份 —— 2026-09-19 实测踩过
 *   "心跳降级了但健康检查仍判 FAIL"这种同一件事两套判据）。 */
const maintenanceOf = (who) => maintOf(INSTANCE, who);

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
// ★ 2026-09-18（对端反馈）：维护/冻结与"停摆"在证据上**同形** —— 本机做维护冻结期间，
//   两台对端各收到一条"本机 tick 疑似已停"，其中一台的 daily 还被顶成 rc=10。
//   所以本机侧先看**冻结标记**：`sync/state/.freeze-<machine>`（人在维护前放下）或活着的 `.sync.lock`
//   （同步正在跑/被有意持有）⇒ 记 INFO「维护冻结（预期）」，**不**报 ALERT。
function freezeReason() {
  const marker = join(STATE, `.freeze-${machine}`);
  if (existsSync(marker)) {
    let why = '';
    try { why = readFileSync(marker, 'utf8').trim().split(/\r?\n/)[0] || ''; } catch {}
    return `本机维护冻结标记存在（${marker}）${why ? '：' + why : ''}`;
  }
  const lock = join(STATE, '.sync.lock');
  if (existsSync(lock)) {
    try {
      const j = JSON.parse(readFileSync(lock, 'utf8'));
      const ageMin = j?.at ? ageMinFrom(j.at) : null;
      if (j?.pid && ageMin !== null && ageMin < 30) return `同步锁被持有（pid=${j.pid}，${Math.round(ageMin)} 分钟）⇒ 视为进行中/有意持有`;
    } catch {}
  }
  return '';
}
function ageMinFrom(ts) { const t = parseTs(ts); return t === null ? null : ageMin(t); }

function checkSelf() {
  if (TOLERANT.has(machine)) { infos.push(`本机（${machine}）登记为**宽容同步**（移动端/按需）⇒ 不预警，仅记录`); return; }
  const ms = maintenanceOf(machine);
  if (ms && !ms.expired) { infos.push(`本机：${maintText(ms)} ⇒ 跳过 tick 判活`); return; }
  if (ms && ms.expired) infos.push(`本机：维护登记已于 ${ms.until} 到期 ⇒ 恢复判活（若仍在维护请续期，否则删掉该条）`);
  const frozen = freezeReason();
  if (frozen) { infos.push(`本机：${frozen} ⇒ 跳过 tick 判活（维护中的停摆是预期的）`); return; }
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
  /* ★ 2026-09-19 修：回答"对端 tick 还在跑吗"必须用**每轮推上来的状态**（`sync-state` 分支的
     `state/<machine>.json`），**不能**用快照里那个 `tick.lastAt` —— 那是**一次性照片**，冻在快照写入的
     那一刻。拿它去比 80 分钟阈值，等价于在测"这份快照多久前写的"：因为 `tAge ≈ 快照龄`，所以只要快照龄
     落在 80 分钟 ~ 2 小时之间，就**必然**判对端 tick 停了。
     实测代价（2026-09-19）：某对端快照写于 13:40、里面记的最后一次 tick 是 13:32（写的时候只差
     7.3 分钟，完全健康），而 14:56 / 15:17 / 15:36 连续三轮被报成 `<该机>-tick-stale`；直到 15:56
     快照超过 2h，工具才改口说"无法判定"。⇒ **每台机器每晚跑完重活，都会让对端必然假报一次**，而且天天把
     "连续 72h 零告警"的退役门禁顶回去 ⇒ 门禁永远过不去。
     两件事各有各的同源判据：**"tick 在跑吗" ← 每轮状态；"夜间重活跑了吗" ← 快照的 writtenAt / heavy**。 */
  const fleet = (() => { try { return readFleet(INSTANCE, { fetch: true }); } catch { return { ok: false, machines: {} }; } })();
  for (const f of files) {
    let j = null;
    try { j = JSON.parse(readFileSync(join(STATE, f), 'utf8')); } catch { continue; }
    const who = j.machine || f.replace(/^tick-/, '').replace(/\.json$/, '');
    if (who === machine) continue;
    if (TOLERANT.has(who)) {
      infos.push(`${who}: 登记为**宽容同步**（移动端/按需）⇒ 不预警，仅记录（快照 ${j.writtenAt || '?'}，最后 tick ${j.tick?.lastAt || '?'}）`);
      continue;
    }
    const mm = maintenanceOf(who);
    if (mm && !mm.expired) {
      infos.push(`${who}: ${maintText(mm)} ⇒ 不预警，仅记录（快照 ${j.writtenAt || '?'}，最后 tick ${j.tick?.lastAt || '?'}）`);
      continue;
    }
    if (mm && mm.expired) infos.push(`${who}: 维护登记已于 ${mm.until} 到期 ⇒ 恢复判活（若仍在维护请续期，否则删掉该条）`);
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
    /* tick 是否在跑：用**每轮状态**判（同源），不用快照里那个冻结值（见函数头注释） */
    const st = fleet.machines?.[who] || null;
    const stAt = parseTs(st?.tick?.lastAt || st?.at);
    const stAgeMin = stAt ? ageMin(stAt) : null;
    const stInterval = Number(st?.tick?.intervalMin) || TICK_INTERVAL_MIN;
    const stThr = stInterval * 4;
    if (stAgeMin !== null && stAgeMin > stThr) {
      // ★ 措辞软化（对端反馈）：对端停摆也可能是**它在做维护冻结** —— 断言"大概率已停"会让对端白跑一趟。
      alerts.push({ key: `${who}-tick-stale`, who, peer: true, what: `${who} 的 tick 最后一次是 ${Math.round(stAgeMin)} 分钟前（阈值 ${stThr} = 4×${stInterval}），依据 = **它每轮推上来的状态**；该机 tick 疑似已停**或正在维护**（请到那台机器确认）`, ageMin: Math.round(stAgeMin) });
    }
    if (hAgeH !== null && hAgeH > HEAVY_STALE_H) {
      alerts.push({ key: `${who}-heavy-stale`, who, peer: true, what: `${who} 的重活已 ${hAgeH.toFixed(1)}h 未跑（阈值 ${HEAVY_STALE_H}h）`, ageHours: Number(hAgeH.toFixed(1)) });
    }
    // ★ 措辞必须如实：读不到同源数据时**不能**说"正常"，也不能拿照片当判据
    if (!alerts.some((a) => a.who === who)) {
      if (stAgeMin !== null) {
        infos.push(`${who}: 正常（tick ${Math.round(stAgeMin)} 分钟前〔按每轮状态〕；心跳快照 ${wAgeH.toFixed(1)}h）`);
      } else {
        infos.push(`${who}: 读不到它每轮推的状态（sync-state 分支）⇒ **无法判定 tick 是否在跑**（不据此告警）；快照里记的最后一次 tick 是 ${tAgeMin === null ? '未知' : `${Math.round(tAgeMin)} 分钟前`}，但那是照片、不作判据`);
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
// ★ rc 语义（对端反馈）：**只有本机自己的异常才该让本机 rc 变红**。对端停摆/在维护是"信息"——
//   它会弹通知、会进日志行，但不该把本机的 daily 顶成 rc=10（实测：本机做维护冻结时，对端的 daily
//   被这条对端告警顶红过一次）。
if (has('--rc')) {
  const selfAlerts = alerts.filter((a) => a.who === machine && !a.peer);
  if (selfAlerts.length) process.exitCode = 1;
  else if (alerts.length) say(`[info] 有 ${alerts.length} 条**对端**告警 → 不计入本机 rc（避免把别人的维护/停摆算成本机故障）`);
}
