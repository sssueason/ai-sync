#!/usr/bin/env node
/**
 * sync-schedule.mjs — 把 instance.json 里的 tick 间隔**落到平台调度**上（可调 + 自愈）
 *
 * 为什么需要它：用户要求"tick 时间可调"。间隔只写在配置里没用 —— 真正决定节拍的是 Windows 计划任务
 * 的 `RepetitionInterval` 或 macOS 的 launchd `StartInterval`。这里做**单向对账**：
 *   配置 → 平台调度；不一致就重排，一致就什么都不做（幂等）。
 * 由 tick 每轮开头调用一次（`schtasks /query /xml` 约 30ms，代价可忽略）⇒ 改完配置**下一轮即生效**，
 * 不需要命令行、不需要重装。
 *
 * 用法：
 *   node tools/sync-schedule.mjs [--instance <dir>] [--reconcile] [--json] [--quiet]
 *   不加 --reconcile 只报告（默认）。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(process.env.AI_SYNC_ENGINE || join(HERE, '..'));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);

// installer 的位置取决于布局：**公开引擎仓**里是 <引擎根>/install/install.mjs（tools/ 的兄弟），
// 而**原地（引擎在实例仓的 engine/ 下）**时是 <仓根>/engine/install/install.mjs。两种都认。
// 放在常量之后：动态 import 是顶层 await，不能引用尚未初始化的 const（TDZ）。
const installPath = [join(HERE, '..', 'install', 'install.mjs'), join(HERE, '..', 'engine', 'install', 'install.mjs')].find((p) => existsSync(p));
const installMod = installPath ? await import(pathToFileURL(installPath).href) : null;
const detectSchedule = installMod?.detectSchedule ?? ((_i, c) => ({ platform: process.platform, want: c?.tick?.intervalMinutes ?? 5, installed: false, inSync: null, detail: '找不到 install/install.mjs' }));
const registerTick = installMod?.registerTick ?? (() => ({ ok: false, error: '找不到 install/install.mjs' }));
const RECONCILE = has('--reconcile');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const say = (m) => {
  if (!QUIET && !JSON_OUT) console.log('   ' + m);
};

const cfgFile = join(INSTANCE, 'sync', 'instance.json');
let want = 5;
if (existsSync(cfgFile)) {
  try {
    want = JSON.parse(readFileSync(cfgFile, 'utf8')).tick?.intervalMinutes ?? 5;
  } catch {}
}

const detected = detectSchedule(INSTANCE);
const result = { ...detected, action: 'none' };
if (RECONCILE && (!result.installed || result.inSync === false)) {
  const r = registerTick(INSTANCE, want);
  result.action = r.ok ? 're-registered' : 'error';
  result.detail = r.ok ? `已重排为 ${want} 分钟` : r.error || '重排失败';
  if (r.ok) result.inSync = true;
} else if (!RECONCILE && result.installed && result.inSync === false) {
  result.action = 'would-re-register';
}
if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else {
  const state = result.inSync === true ? (result.action === 're-registered' ? '已重排' : 'OK') : result.inSync === false ? '不一致' : '未安装';
  const actual = result.actualMinutes ? ` / 实际 ${result.actualMinutes} 分钟` : result.actualSeconds ? ` / 实际 ${result.actualSeconds}s` : '';
  say(`调度：${result.task} → ${state}（配置 ${want} 分钟${result.inSync === true && result.action === 're-registered' ? '' : actual}）${result.action !== 'none' ? ` · ${result.action}` : ''}${result.detail ? ` · ${result.detail}` : ''}`);
}

// 报告模式下"不一致"退出码 2（可进巡检）；--reconcile 模式下只有真错误才非零
process.exitCode = result.action === 'error' ? 3 : result.inSync === false && !RECONCILE ? 2 : 0;
