#!/usr/bin/env node
/**
 * sync-prune.mjs — 日志与报告的保留策略：不让它们无限堆积
 *
 * 为什么需要：`sync/reports/*.md` 每跑一次 tree-sync（首次对齐、每晚重活都会跑）就新增一个，
 * 一天几十个、**永不清理**，而且它们原先全部被 git 跟踪 ⇒ 还会传染给每一台机器、撑大仓库历史。
 * `sync/logs/tick-<机器>.log` 每 5 分钟一行（约 47 KB/天、17 MB/年）同样没有上限。
 * 2026-09-17 实测：reports 里已积 73 个文件（按前缀分 6 组，最多的一组 32 个）。
 *
 * 策略（保守：近期证据一律留着）
 *   reports：按「前缀」分组（`tree-sync-<机器>`、`reconcile-<机器>`…），每组保留
 *            「最新 keepReports 个」∪「keepDays 天内（且不超过 maxKeep 个）」；其余删除。不认识的命名一律不碰。
 *   logs   ：`daily-*.log` 只留最新 keepDaily 个；`tick-*.log` 超过 logMaxMb 时截断为最后 keepLines 行。
 *   其它文件（含 `.tray-last-state.json` / `.sync.lock` 等点文件）绝不触碰。
 *
 * 用法：node tools/sync-prune.mjs [--instance <dir>] [--dry-run] [--json] [--quiet]
 *        [--keep-reports 5] [--keep-days 7] [--keep-daily 14] [--log-max-mb 2] [--log-lines 5000]
 * 退出码：0 正常；2 有失败项（删除/截断失败）。
 */
import { readdirSync, statSync, readFileSync, writeFileSync, unlinkSync, renameSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(process.env.AI_SYNC_ENGINE || join(HERE, '..'));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);
const DRY = has('--dry-run');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const KEEP_REPORTS = Number(val('--keep-reports', '5'));
const KEEP_DAYS = Number(val('--keep-days', '7'));
const MAX_KEEP = Number(val('--max-keep', '20')); // 每组硬上限：光按"7 天内"会无界（实测 2 天就 33 个）
const KEEP_DAILY = Number(val('--keep-daily', '14'));
const LOG_MAX_MB = Number(val('--log-max-mb', '2'));
const LOG_LINES = Number(val('--log-lines', '5000'));
const say = (m) => {
  if (!QUIET && !JSON_OUT) console.log('   ' + m);
};

const deleted = [];
const truncated = [];
const failures = [];
const sizeOf = (p) => {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
};

/* ---------------- reports：<前缀>-<YYYYMMDD-HHMM>.md ---------------- */

const reportsDir = join(INSTANCE, 'sync', 'reports');
let groups = 0;
let kept = 0;
let deletedReports = 0;
if (existsSync(reportsDir)) {
  const byPrefix = new Map();
  for (const f of readdirSync(reportsDir)) {
    if (!f.endsWith('.md') || f.startsWith('.')) continue;
    const m = /^(.*)-(\d{8}-\d{4})\.md$/.exec(f);
    if (!m) continue; // 命名不认识 ⇒ 不动它（宁可留着，也不误删）
    if (!byPrefix.has(m[1])) byPrefix.set(m[1], []);
    byPrefix.get(m[1]).push({ f, stamp: m[2] });
  }
  const now = Date.now();
  for (const items of byPrefix.values()) {
    groups++;
    items.sort((a, b) => (a.stamp < b.stamp ? 1 : -1)); // 新的在前
    items.forEach((it, i) => {
      const iso = `${it.stamp.slice(0, 4)}-${it.stamp.slice(4, 6)}-${it.stamp.slice(6, 8)}T${it.stamp.slice(9, 11)}:${it.stamp.slice(11, 13)}:00`;
      const t = Date.parse(iso);
      const fresh = Number.isFinite(t) && now - t < KEEP_DAYS * 86400000;
      // 保留规则：最新 KEEP_REPORTS 个一定要留；此外 7 天内的也留，但整组不超过 MAX_KEEP 个
      if (i < KEEP_REPORTS || (fresh && i < MAX_KEEP)) {
        kept++;
        return;
      }
      const p = join(reportsDir, it.f);
      const bytes = sizeOf(p);
      try {
        if (!DRY) unlinkSync(p);
        deleted.push({ path: p, bytes });
        deletedReports++;
      } catch (e) {
        failures.push(`删不掉 ${it.f}：${e.message}`);
      }
    });
  }
}

/* ---------------- logs ---------------- */

const logsDir = join(INSTANCE, 'sync', 'logs');
if (existsSync(logsDir)) {
  const files = readdirSync(logsDir).filter((f) => f.endsWith('.log') && !f.startsWith('.'));
  const daily = files.filter((f) => /^daily-\d{8}\.log$/.test(f)).sort().reverse();
  for (const f of daily.slice(KEEP_DAILY)) {
    const p = join(logsDir, f);
    const bytes = sizeOf(p);
    try {
      if (!DRY) unlinkSync(p);
      deleted.push({ path: p, bytes });
    } catch (e) {
      failures.push(`删不掉 ${f}：${e.message}`);
    }
  }
  for (const f of files.filter((x) => /^tick-.*\.log$/.test(x))) {
    const p = join(logsDir, f);
    const bytes = sizeOf(p);
    if (bytes < LOG_MAX_MB * 1024 * 1024) continue;
    try {
      const lines = readFileSync(p, 'utf8').split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop(); // 末尾换行会产生一个空串，不修就会少留一行
      const body =
        `（本文件超过 ${LOG_MAX_MB} MB，已截断为最近 ${LOG_LINES} 行；更早的记录见 git 提交与 sync/reports）\n` +
        lines.slice(-LOG_LINES).join('\n') +
        '\n';
      if (!DRY) {
        const tmp = `${p}.tmp`;
        writeFileSync(tmp, body, 'utf8');
        renameSync(tmp, p); // 先写临时文件再改名：中途失败不会留下半个日志
      }
      truncated.push({ path: p, wasBytes: bytes });
    } catch (e) {
      failures.push(`截断 ${f} 失败：${e.message}`);
    }
  }
}

const freedBytes = deleted.reduce((a, x) => a + (x.bytes || 0), 0);
const freedKB = Math.round(freedBytes / 1024);
const freedText = freedBytes >= 1024 ? `${freedKB} KB` : `${freedBytes} B`; // 别显示 "-0KB"
const result = {
  ok: failures.length === 0,
  dryRun: DRY,
  reports: { groups, kept, deleted: deletedReports },
  truncated: truncated.length,
  freedKB,
  freed: freedText,
  deleted,
  failures,
};
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else {
  say(`报告：${groups} 组，保留 ${kept} 个，删除 ${deletedReports} 个`);
  if (truncated.length) say(`日志：截断 ${truncated.length} 个（超过 ${LOG_MAX_MB} MB）`);
  if (!deleted.length && !truncated.length) say('无需清理');
  if (freedBytes) say(`释放约 ${freedText}${DRY ? '（--dry-run，未真删）' : ''}`);
  for (const f of failures) say(`[FAIL] ${f}`);
}
process.exitCode = failures.length ? 2 : 0;
