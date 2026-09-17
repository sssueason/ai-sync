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
// 镜像（µ2）调度走同一个安装器：cloudMirror.schedule 原先没有任何消费者（死旋钮，2026-09-17 发现）
const detectMirror = installMod?.detectMirror ?? ((_i, c) => ({ platform: process.platform, task: 'ai-sync-mirror', enabled: c?.cloudMirror?.enabled !== false, installed: false, inSync: null, detail: '找不到 install/install.mjs' }));
const registerMirror = installMod?.registerMirror ?? (() => ({ ok: false, error: '找不到 install/install.mjs' }));
const RECONCILE = has('--reconcile');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const say = (m) => {
  if (!QUIET && !JSON_OUT) console.log('   ' + m);
};

const cfgFile = join(INSTANCE, 'sync', 'instance.json');
let want = 5;
let cfg = {};
if (existsSync(cfgFile)) {
  try {
    cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    want = cfg.tick?.intervalMinutes ?? 5;
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

/* 镜像调度对账：装上 / 按 enabled=false 卸下 / 时间改了重排，全在 registerMirror 一处收敛。
   未实现的平台返回 skipped ⇒ 不算失败，但 detail 会带到输出里（跳过必须看得见，别静默）。 */
const mDetected = detectMirror(INSTANCE, cfg);
const mirror = { ...mDetected, action: 'none' };
const mirrorStale = mDetected.inSync === false;
if (RECONCILE && mirrorStale) {
  const r = registerMirror(INSTANCE, cfg);
  if (r.skipped) {
    mirror.action = 'skipped';
    mirror.detail = r.detail;
  } else {
    mirror.action = r.ok ? (r.disabled ? 'unregistered' : 're-registered') : 'error';
    mirror.detail = r.ok ? r.detail || (r.disabled ? '已按配置卸下' : `已排为 ${r.spec?.mode === 'interval' ? `每 ${r.spec.intervalMinutes} 分钟` : (r.spec?.times || []).join(' / ')}`) : r.error || '重排失败';
    if (r.ok) mirror.inSync = true;
  }
} else if (!RECONCILE && mirrorStale) {
  mirror.action = 'would-re-register';
}
result.mirror = mirror;

if (JSON_OUT) console.log(JSON.stringify(result, null, 2));
else {
  const state = result.inSync === true ? (result.action === 're-registered' ? '已重排' : 'OK') : result.inSync === false ? '不一致' : '未安装';
  const actual = result.actualMinutes ? ` / 实际 ${result.actualMinutes} 分钟` : result.actualSeconds ? ` / 实际 ${result.actualSeconds}s` : '';
  say(`调度：${result.task} → ${state}（配置 ${want} 分钟${result.inSync === true && result.action === 're-registered' ? '' : actual}）${result.action !== 'none' ? ` · ${result.action}` : ''}${result.detail ? ` · ${result.detail}` : ''}`);
  const mState = mirror.skipped || mirror.enabled === false ? (mirror.enabled === false ? '已关闭' : '未实现') : mirror.inSync === true ? (mirror.action === 're-registered' ? '已重排' : 'OK') : mirror.inSync === false ? '不一致' : '未安装';
  say(`镜像：${mirror.task} → ${mState}${mirror.action !== 'none' ? ` · ${mirror.action}` : ''}${mirror.detail ? ` · ${mirror.detail}` : ''}`);
}

// 报告模式下"不一致"退出码 2（可进巡检）；--reconcile 模式下只有真错误才非零
process.exitCode = mirror.action === 'error' || result.action === 'error' ? 3 : (mirrorStale || result.inSync === false) && !RECONCILE ? 2 : 0;
