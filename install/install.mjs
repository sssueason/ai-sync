#!/usr/bin/env node
/**
 * install.mjs — 引擎自带的安装/卸载器（跨平台）：把 tick 挂到平台调度上
 *
 * 职责边界（只此一处）：
 *   · **检测**平台调度现状（`detectSchedule`，被 sync-status / sync-schedule 复用 —— 单一源）
 *   · **注册/更新/卸载** 计划任务（Windows）或 launchd（macOS）
 * 引擎里只有这一个地方知道"平台调度怎么装"，避免三处各写一份（旧实现就是这样漂的）。
 *
 * 装出来的东西：
 *   Windows 计划任务名 = `tick.taskName`（默认 `ai-sync-tick`）→ 动作 = `node <引擎根>/tools/sync-tick.mjs --instance <实例根>`
 *   macOS launchd label = `tick.launchdLabel`（默认 `ai-sync.tick`）→ 同一个动作
 *
 * 用法：
 *   node install/install.mjs --instance <实例根> [--register] [--unregister] [--interval 5] [--json]
 *   不带动作 = 只报告（等于 --status）
 * 退出码：0 正常；2 = 报告模式下"未安装或间隔不一致"；3 = 动作失败
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENGINE = resolve(process.env.AI_SYNC_ENGINE || join(HERE, '..'));

export function loadInstance(instance) {
  try {
    return JSON.parse(readFileSync(join(instance, 'sync', 'instance.json'), 'utf8'));
  } catch {
    return {};
  }
}
export const tickTaskName = (cfg) => cfg?.tick?.taskName || 'ai-sync-tick';
export const tickLabel = (cfg) => cfg?.tick?.launchdLabel || 'ai-sync.tick';

/** 检测平台调度现状。返回 {platform,task,installed,want,actual,unit,inSync,detail} */
export function detectSchedule(instance, cfg = loadInstance(instance)) {
  const want = cfg?.tick?.intervalMinutes ?? 5;
  const out = { platform: process.platform, want, installed: false, actual: null, unit: 'min', inSync: null, detail: '' };
  if (process.platform === 'win32') {
    out.task = tickTaskName(cfg);
    const q = spawnSync('schtasks', ['/query', '/tn', out.task, '/xml', 'ONE'], { encoding: 'utf8', windowsHide: true });
    if (q.status !== 0) {
      out.detail = '计划任务不存在';
      return out;
    }
    out.installed = true;
    const m = /<Interval>PT(\d+)M<\/Interval>/.exec(q.stdout || '');
    out.actual = m ? Number(m[1]) : null;
    out.inSync = out.actual === want;
    return out;
  }
  if (process.platform === 'darwin') {
    out.task = tickLabel(cfg);
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${out.task}.plist`);
    out.plist = plist;
    out.installed = existsSync(plist);
    if (!out.installed) {
      out.detail = 'LaunchAgent 不存在';
      return out;
    }
    const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(readFileSync(plist, 'utf8'));
    out.actual = m ? Number(m[1]) : null;
    out.unit = 'sec';
    const wantSec = want * 60;
    out.inSync = out.actual === wantSec;
    out.wantSec = wantSec;
    return out;
  }
  out.detail = '未提供该平台的调度安装器（Linux 请自行接 systemd/cron 调 sync-tick.mjs）';
  return out;
}

/* ---------------------------------------------------------------- 注册 */

function nodeExe() {
  return process.execPath;
}

function registerWindows(instance, interval) {
  const name = tickTaskName(loadInstance(instance));
  const tick = join(ENGINE, 'tools', 'sync-tick.mjs');
  const ps = `
$ErrorActionPreference='Stop'
$action = New-ScheduledTaskAction -Execute '${nodeExe().replace(/'/g, "''")}' -Argument '${`"${tick}" --instance "${instance}"`.replace(/'/g, "''")}' -WorkingDirectory '${ENGINE.replace(/'/g, "''")}'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${interval})
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName '${name}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output 'registered'
`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.status !== 0) {
    // 退一步用 Windows PowerShell 5.1（ScheduledTasks 模块在 5.1 也有）
    const r2 = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (r2.status !== 0) return { ok: false, error: (r2.stderr || r.stderr || '').split('\n')[0] || `exit ${r2.status}` };
  }
  return { ok: true, task: name };
}

function registerMac(instance, interval) {
  const cfg = loadInstance(instance);
  const label = tickLabel(cfg);
  const dir = join(homedir(), 'Library', 'LaunchAgents');
  mkdirSync(dir, { recursive: true });
  const plist = join(dir, `${label}.plist`);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${nodeExe()}</string>
    <string>${join(ENGINE, 'tools', 'sync-tick.mjs')}</string>
    <string>--instance</string>
    <string>${instance}</string>
  </array>
  <key>StartInterval</key><integer>${interval * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/tmp/ai-sync-tick.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-sync-tick.err.log</string>
</dict></plist>
`;
  writeFileSync(plist, xml, 'utf8');
  const uid = process.getuid ? process.getuid() : 501;
  spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
  const b = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
  if (b.status !== 0) return { ok: false, error: (b.stderr || '').split('\n')[0] || `bootstrap exit ${b.status}` };
  return { ok: true, task: label, plist };
}

/* ---- 供其它工具复用的入口（sync-schedule.mjs 用它做自愈重排，避免第二份实现） ---- */

export function registerTick(instance, interval) {
  if (process.platform === 'win32') return registerWindows(instance, interval);
  if (process.platform === 'darwin') return registerMac(instance, interval);
  return { ok: false, error: '该平台未提供安装器（Linux 请自行接 systemd/cron）' };
}

export function unregisterTick(instance) {
  const cfg = loadInstance(instance);
  if (process.platform === 'win32') {
    const name = tickTaskName(cfg);
    const r = spawnSync('schtasks', ['/delete', '/tn', name, '/f'], { encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, detail: (r.stdout || r.stderr || '').trim().split('\n')[0] };
  }
  if (process.platform === 'darwin') {
    const label = tickLabel(cfg);
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    if (existsSync(plist)) rmSync(plist, { force: true });
    return { ok: true, detail: plist };
  }
  return { ok: false, detail: '该平台未提供卸载器' };
}

/* ---------------------------------------------------------------- CLI */

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const val = (f, d = null) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
  };
  const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);
  const cfg = loadInstance(INSTANCE);
  const interval = Number(val('--interval', String(cfg?.tick?.intervalMinutes ?? 5)));
  const json = argv.includes('--json');

  let result;
  if (argv.includes('--unregister')) result = { action: 'unregister', ...unregisterTick(INSTANCE) };
  else if (argv.includes('--register')) {
    const r = process.platform === 'win32' ? registerWindows(INSTANCE, interval) : process.platform === 'darwin' ? registerMac(INSTANCE, interval) : { ok: false, error: '该平台未提供安装器' };
    result = { action: 'register', interval, ...r };
  } else {
    const d = detectSchedule(INSTANCE, cfg);
    result = { action: 'status', ...d };
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    if (result.action === 'status') {
      console.log(`   调度：${result.task ?? '(无)'} → ${result.installed ? (result.inSync ? 'OK' : '间隔不一致') : '未安装'}（配置 ${result.want} 分钟${result.installed ? ` / 实际 ${result.actual}${result.unit === 'sec' ? 's' : ' 分钟'}` : ''}）${result.detail ? ` · ${result.detail}` : ''}`);
    } else if (result.ok) console.log(`   [OK] ${result.action} 成功${result.task ? `（${result.task}）` : ''}`);
    else console.log(`   [FAIL] ${result.action} 失败：${result.error || result.detail}`);
  }
  process.exitCode = result.action === 'status' ? (!result.installed || result.inSync === false ? 2 : 0) : result.ok ? 0 : 3;
}
