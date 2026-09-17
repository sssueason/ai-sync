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
 *   Windows 计划任务名 = `tick.taskName`（默认 `ai-sync-tick`）→ 动作 =
 *     `wscript <引擎根>\install\run-hidden.vbs <实例根>\sync\state\tick-cmd.txt`
 *     （命令文件里是 `node <引擎根>/tools/sync-tick.mjs --instance <实例根>`；走 run-hidden.vbs 是为了
 *      **不冒控制台窗口**，同时把子进程退出码原样交回任务计划 —— 细节见 docs/OPERATIONS.md §8）
 *   Windows 镜像任务名 = `cloudMirror.taskName`（默认 `ai-sync-mirror`）→ 同一套隐藏执行，按
 *     `cloudMirror.schedule` 触发；`cloudMirror.enabled=false` 时会被主动卸下
 *   macOS launchd label = `tick.launchdLabel`（默认 `ai-sync.tick`）→ 同一个 tick 动作
 *
 * 用法：
 *   node install/install.mjs --instance <实例根> [--register] [--unregister] [--interval 5] [--json]
 *   不带动作 = 只报告（等于 --status）
 * 退出码：0 正常；2 = 报告模式下"未安装或间隔不一致"；3 = 动作失败
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));

/** 引擎根 = **真正含有 tools/sync-tick.mjs 的那一层**。
 *  两种布局要同时认：
 *    · 拆分：`<引擎根>/install/` 与 `<引擎根>/tools/` 同级 ⇒ `join(HERE,'..')`
 *    · 原地：`<实例根>/engine/install/`，而工具在 `<实例根>/tools/` ⇒ `join(HERE,'..','..')`
 *  2026-09-17 实测踩到：只看 `join(HERE,'..')` 时，原地布局会算出 `<实例根>/engine` —— 那里**没有 tools/**，
 *  于是注册出来的计划任务指向一个不存在的脚本（MODULE_NOT_FOUND，任务结果 1，而且死得太早连日志行都没有）；
 *  更糟的是 tick 每轮的 `--reconcile` 会用这个错根**反复重写**命令文件，把手工修好的注册又改坏。
 *  这里按"哪层有 tick 脚本"来定，两种布局都能自愈。 */
function resolveEngine() {
  const cands = [join(HERE, '..'), join(HERE, '..', '..')];
  return resolve(cands.find((p) => existsSync(join(p, 'tools', 'sync-tick.mjs'))) || cands[0]);
}
export const ENGINE = resolve(process.env.AI_SYNC_ENGINE || resolveEngine());

export function loadInstance(instance) {
  try {
    return JSON.parse(readFileSync(join(instance, 'sync', 'instance.json'), 'utf8'));
  } catch {
    return {};
  }
}
export const tickTaskName = (cfg) => cfg?.tick?.taskName || 'ai-sync-tick';
export const tickLabel = (cfg) => cfg?.tick?.launchdLabel || 'ai-sync.tick';
export const mirrorTaskName = (cfg) => cfg?.cloudMirror?.taskName || 'ai-sync-mirror';
/** macOS 的镜像调度 label（默认与 tick 的 `ai-sync.tick` 对称；想跟本机 tick 的命名风格一致就在
 *  instance.json 里设 `cloudMirror.launchdLabel`） */
export const mirrorLabel = (cfg) => cfg?.cloudMirror?.launchdLabel || 'ai-sync.mirror';
/** 镜像重活实际跑哪个脚本：默认实例的 daily.ps1（与 Windows 的 ai-sync-mirror 同一份），可配置覆盖 */
const mirrorScript = (instance) => {
  const cfg = loadInstance(instance);
  const custom = cfg?.cloudMirror?.script;
  return custom ? resolve(instance, custom) : join(instance, 'sync', 'daily.ps1');
};

/* ---------------------------------------------------------------- 隐藏执行（Windows）
 * 计划任务的动作**不能**直接写 node.exe/pwsh.exe：交互式身份下每次运行都会创建控制台窗口，
 * 屏幕上每 N 分钟闪一次黑框（2026-09-17 用户反馈）。统一改成
 *   wscript.exe run-hidden.vbs "<命令文件>"
 * —— wscript 没有控制台，run-hidden.vbs 再用 SW_HIDE 拉真正的子进程，全程无窗口。
 * 退出码由 run-hidden.vbs 原样交回计划任务 ⇒「上次运行结果」仍是真信号（恒 0 就是假绿）。 */

/** PowerShell 单引号字符串转义（路径里出现撇号时不会把生成的脚本撕开） */
const q = (s) => String(s).replace(/'/g, "''");
export const runnerPath = () => join(ENGINE, 'install', 'run-hidden.vbs');
const wscriptPath = () => join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

/** PowerShell 可执行文件。
 *  Windows：优先固定路径的 pwsh7（`where pwsh` 可能撞上 WindowsApps 的 0 字节别名，非交互下跑不起来）。
 *  macOS：launchd 的 PATH 极小，ProgramArguments[0] 必须是**绝对路径** ⇒ 先看 homebrew 两个常见前缀，
 *  再退回 `which pwsh` 的结果（Apple Silicon = /opt/homebrew，Intel = /usr/local）。 */
function pwshPath() {
  if (process.platform === 'darwin') {
    for (const p of ['/opt/homebrew/bin/pwsh', '/usr/local/bin/pwsh']) if (existsSync(p)) return p;
    const r = spawnSync('/usr/bin/which', ['pwsh'], { encoding: 'utf8' });
    const first = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
    return first || '/usr/local/bin/pwsh';
  }
  const fixed = join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (existsSync(fixed)) return fixed;
  const r = spawnSync('where', ['pwsh'], { encoding: 'utf8', windowsHide: true });
  const first = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).find((p) => !/WindowsApps/i.test(p));
  return first || 'powershell';
}

/** 把"要跑的一整行命令"写成 UTF-16LE(**带 BOM**)命令文件，返回路径。
 *  为什么用文件：计划任务参数是原始字符串，里面再嵌引号会被 WSH 的命令行解析合并掉（相邻引号会丢）。
 *  为什么 UTF-16LE：run-hidden.vbs 用 TristateTrue 读它；按 ANSI 读会把非 ASCII 路径
 *  （用户名含中文的机器就是这种）变成问号，子进程根本起不来。**BOM 必需**，缺了会读成空。 */
export function writeCmdFile(instance, base, cmdline) {
  const dir = join(instance, 'sync', 'state');
  mkdirSync(dir, { recursive: true });
  const f = join(dir, base);
  writeFileSync(f, '\uFEFF' + cmdline + '\r\n', 'utf16le');
  return f;
}

/** 跑一段 PowerShell（pwsh 优先，退回 Windows PowerShell 5.1 —— ScheduledTasks 模块两边都有） */
function runPs(ps) {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r.status === 0) return { ok: true };
  const r2 = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (r2.status === 0) return { ok: true };
  const err = [r2.stderr, r.stderr].filter(Boolean).join('\n').split('\n').map((s) => s.trim()).filter(Boolean)[0];
  return { ok: false, error: err || `exit ${r2.status}` };
}

/** 任务是否存在（schtasks 查询约 30ms，比启 pwsh 快得多） */
function taskExists(name) {
  const r = spawnSync('schtasks', ['/query', '/tn', name], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  return r.status === 0;
}

/** 检测平台调度现状。返回 {platform,task,installed,want,actual,unit,inSync,detail} */
/* ---------------------------------------------------------------- 调度动作是否真的可用
 * 2026-09-18（某台机器指出，结构性假绿）：原先只比 `<Interval>` / `StartInterval`，
 * 完全**不看动作指向什么** ⇒ 分不出"注册正确"和"动作指向一个不存在的脚本"。
 * 两种形态都真出现过：① 原地布局下引擎根算错，注册出 `<实例>/engine/tools/…`（不存在）；
 * ② 引擎被移到新路径 / 旧 clone 被删 / 任务被手改。此时 interval 依然"一致"，巡检却全绿。
 * 这里把"动作 → 运行器 → 命令文件 → 真正的脚本"这条链逐段验存在性，任一环缺失就算不一致。 */
function winActionProblems(taskXml) {
  const problems = [];
  const args = (/<Arguments>([\s\S]*?)<\/Arguments>/.exec(taskXml) || [])[1] || '';
  const quoted = [...args.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const runner = quoted.find((f) => /run-hidden\.vbs$/i.test(f));
  const cmdFile = quoted.find((f) => /-cmd\.txt$/i.test(f));
  if (!runner) problems.push('动作里没有 run-hidden.vbs（隐藏运行器）');
  else if (!existsSync(runner)) problems.push(`隐藏运行器不存在：${runner}`);
  if (!cmdFile) problems.push('动作里没有命令文件（*-cmd.txt）');
  else if (!existsSync(cmdFile)) problems.push(`命令文件不存在：${cmdFile}`);
  else {
    // 命令文件 = UTF-16LE(带 BOM) 的一整行；里面第一个 .mjs 就是要跑的脚本
    try {
      const line = readFileSync(cmdFile, 'utf16le').replace(/^\uFEFF/, '');
      const inner = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      const script = inner.find((f) => /\.(mjs|ps1)$/i.test(f));
      if (!script) problems.push(`命令文件里没有脚本路径：${line.trim().slice(0, 80)}`);
      else if (!existsSync(script)) problems.push(`命令文件指向不存在的脚本：${script}`);
    } catch (e) {
      problems.push(`命令文件读不出来：${e.message}`);
    }
  }
  return problems;
}

/** 读计划任务 XML。
 *  ⚠️ `schtasks /xml` 用的是**控制台代码页**（中文机 = GBK），按 UTF-8 读会把中文用户名变成 `??????` ⇒
 *  路径存在性检查必然假失败（2026-09-18 实测：用户名含中文时，路径里的中文会被解成一串 `?`）。
 *  所以按字节读，再依次试 UTF-16LE(BOM) → UTF-8(严格) → GBK。 */
function readTaskXml(name) {
  const r = spawnSync('schtasks', ['/query', '/tn', name, '/xml', 'ONE'], { windowsHide: true, maxBuffer: 8 << 20 });
  if (r.status !== 0 || !r.stdout || !r.stdout.length) return null;
  const buf = r.stdout;
  if (buf.length > 1 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

export function detectSchedule(instance, cfg = loadInstance(instance)) {
  const want = cfg?.tick?.intervalMinutes ?? 5;
  const out = { platform: process.platform, want, installed: false, actual: null, unit: 'min', inSync: null, detail: '' };
  if (process.platform === 'win32') {
    out.task = tickTaskName(cfg);
    const xml = readTaskXml(out.task);
    if (xml === null) {
      out.detail = '计划任务不存在（或查询失败）';
      return out;
    }
    out.installed = true;
    const m = /<Interval>PT(\d+)M<\/Interval>/.exec(xml);
    out.actual = m ? Number(m[1]) : null;
    const probs = winActionProblems(xml);
    out.actionOk = probs.length === 0;
    if (probs.length) out.actionProblems = probs;
    out.inSync = out.actual === want && out.actionOk;
    out.detail = probs.length ? probs.join('；') : '';
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
    const xml = readFileSync(plist, 'utf8');
    const m = /<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/.exec(xml);
    out.actual = m ? Number(m[1]) : null;
    out.unit = 'sec';
    const wantSec = want * 60;
    // 同样验动作：ProgramArguments 里那个 .mjs 必须真的存在（引擎被移动/删掉后 interval 仍会"一致"）
    const pargs = [...((/<key>ProgramArguments<\/key>[\s\S]*?<\/array>/.exec(xml) || [''])[0]).matchAll(/<string>([^<]+)<\/string>/g)].map((x) => x[1]);
    const script = pargs.find((a) => /\.(mjs|ps1)$/i.test(a));
    const probs = [];
    if (!script) probs.push('plist 里没有脚本路径');
    else if (!existsSync(script)) probs.push(`plist 指向不存在的脚本：${script}`);
    out.actionOk = probs.length === 0;
    if (probs.length) out.actionProblems = probs;
    out.inSync = out.actual === wantSec && out.actionOk;
    out.detail = probs.length ? probs.join('；') : '';
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
  const cmdFile = writeCmdFile(instance, 'tick-cmd.txt', `"${nodeExe()}" "${tick}" --instance "${instance}"`);
  const ps = `
$ErrorActionPreference='Stop'
$action = New-ScheduledTaskAction -Execute '${q(wscriptPath())}' -Argument '"${q(runnerPath())}" "${q(cmdFile)}"' -WorkingDirectory '${q(ENGINE)}'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${interval})
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
Register-ScheduledTask -TaskName '${q(name)}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output 'registered'
`;
  const r = runPs(ps);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, task: name, via: 'run-hidden.vbs', cmdFile };
}

/* ---------------------------------------------------------------- 镜像（µ2）调度
 * `cloudMirror.schedule` 以前是**死旋钮**：没有任何东西把它落到平台调度上，实际跑的是手搓的
 * DSH-Sync-Evening 任务 ⇒ 控制台里改时间只改了 JSON、任务不动（2026-09-17 发现）。
 * 现在由这里统一注册，并用 mirror-spec.json 记录"上次按什么配置装的"，便于对账。 */

function mirrorSpecOf(cfg) {
  const cm = cfg?.cloudMirror || {};
  return {
    enabled: cm.enabled !== false,
    mode: cm.schedule?.mode || 'dailyAt',
    times: cm.schedule?.times || ['22:00'],
    intervalMinutes: cm.schedule?.intervalMinutes ?? 60,
  };
}
function readMirrorSpec(instance) {
  try {
    return JSON.parse(readFileSync(join(instance, 'sync', 'state', 'mirror-spec.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 检测镜像调度现状。返回 {platform,task,enabled,installed,want,inSync,detail} */
export function detectMirror(instance, cfg = loadInstance(instance)) {
  const spec = mirrorSpecOf(cfg);
  const out = { platform: process.platform, task: process.platform === 'darwin' ? mirrorLabel(cfg) : mirrorTaskName(cfg), enabled: spec.enabled, want: spec.enabled ? spec : null, installed: false, inSync: null, detail: '' };
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${out.task}.plist`);
    out.installed = existsSync(plist);
    out.plist = plist;
    /* 手工挂过的旧同步类 LaunchAgent 也要看见：引擎接管后如果它还留着，会一天跑两趟（且没人知道）。
       ⚠️ 只认**同步类** label，并**排除引擎自己的**（tick / mirror / 托盘）——
       2026-09-18 实测误报：第一版用 `cn.ai-*` 前缀筛选，把本机合法的 tick label（形如
       `cn.<实例名>.tick`）与托盘 label 也列成"旧 LaunchAgent，应 bootout"，等于让人去删自己的 tick。 */
    const known = new Set([out.task, tickLabel(cfg), 'cn.ai-sync.tray']);
    const legacy = readdirSync(join(homedir(), 'Library', 'LaunchAgents'))
      .filter((f) => f.endsWith('.plist'))
      .map((f) => f.replace(/\.plist$/, ''))
      .filter((l) => !known.has(l) && /sync|mirror|daily|shared/i.test(l));
    if (legacy.length) out.legacy = legacy;
    if (!spec.enabled) {
      out.inSync = !out.installed;
      out.detail = out.installed ? 'cloudMirror.enabled=false 但 LaunchAgent 还在（应卸下）' : '已按配置关闭（无 LaunchAgent）';
    } else if (!out.installed) {
      out.inSync = false;
      out.detail = 'LaunchAgent 不存在';
    } else {
      const recorded = readMirrorSpec(instance);
      const same = !!recorded && JSON.stringify(recorded) === JSON.stringify(spec);
      out.inSync = same;
      out.detail = same ? '与配置一致' : recorded ? `配置已变（上次装的是 ${JSON.stringify(recorded)}）` : '缺少 mirror-spec.json（多半是手工挂的，应收编）';
    }
    if (legacy.length) out.detail += `；发现疑似同步类旧 LaunchAgent：${legacy.join('、')}（核对确认引擎那条已在跑之后再 bootout，否则会重复跑）`;
    return out;
  }
  if (process.platform !== 'win32') {
    out.detail = '该平台没有安装器（Linux 请自行接 systemd/cron 调 sync/daily.ps1 或等价脚本）';
    return out;
  }
  out.installed = taskExists(out.task);
  if (!spec.enabled) {
    out.inSync = !out.installed;
    out.detail = out.installed ? 'cloudMirror.enabled=false 但任务还在（应卸下）' : '已按配置关闭（无任务）';
    return out;
  }
  if (!out.installed) {
    out.inSync = false;
    out.detail = '任务不存在';
    return out;
  }
  const recorded = readMirrorSpec(instance);
  const same = !!recorded && JSON.stringify(recorded) === JSON.stringify(spec);
  out.inSync = same;
  out.detail = same ? '与配置一致' : recorded ? `配置已变（上次装的是 ${JSON.stringify(recorded)}）` : '缺少 mirror-spec.json（多半是手工任务，应收编）';
  return out;
}

export function unregisterMirror(instance, cfg = loadInstance(instance)) {
  if (process.platform === 'darwin') {
    const label = mirrorLabel(cfg);
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${label}`], { encoding: 'utf8' });
    try {
      rmSync(plist, { force: true });
    } catch (e) {
      return { ok: false, task: label, error: e.message };
    }
    return { ok: true, task: label };
  }
  const name = mirrorTaskName(cfg);
  if (process.platform !== 'win32') return { ok: true, skipped: true, task: name, detail: '该平台没有安装器（非失败）' };
  const r = spawnSync('schtasks', ['/delete', '/tn', name, '/f'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const gone = r.status === 0 || /cannot find|找不到/i.test(`${r.stderr}${r.stdout}`);
  return gone ? { ok: true, task: name } : { ok: false, error: (r.stderr || r.stdout || '').split('\n')[0] || `exit ${r.status}` };
}

export function registerMirror(instance, cfg = loadInstance(instance)) {
  const name = process.platform === 'darwin' ? mirrorLabel(cfg) : mirrorTaskName(cfg);
  const spec = mirrorSpecOf(cfg);
  const specFile = join(instance, 'sync', 'state', 'mirror-spec.json');
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
    if (!spec.enabled) {
      const del = unregisterMirror(instance, cfg);
      mkdirSync(dirname(specFile), { recursive: true });
      writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
      return { ok: del.ok, task: name, disabled: true, detail: 'cloudMirror.enabled=false → 已卸下镜像 LaunchAgent', error: del.error };
    }
    const script = mirrorScript(instance);
    if (!existsSync(script)) return { ok: false, error: `找不到镜像脚本 ${script}` };
    mkdirSync(dirname(plist), { recursive: true });
    // 触发条件：dailyAt → 每个时刻一条 StartCalendarInterval；interval → StartInterval（秒）
    let trigger;
    if (spec.mode === 'interval') {
      trigger = `  <key>StartInterval</key><integer>${(Number(spec.intervalMinutes) || 60) * 60}</integer>`;
    } else {
      const items = spec.times
        .map((t) => {
          const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
          if (!m) return null;
          return `    <dict><key>Hour</key><integer>${Number(m[1])}</integer><key>Minute</key><integer>${Number(m[2])}</integer></dict>`;
        })
        .filter(Boolean);
      if (!items.length) return { ok: false, error: `cloudMirror.schedule.times 解析不出时刻：${JSON.stringify(spec.times)}` };
      trigger = `  <key>StartCalendarInterval</key><array>\n${items.join('\n')}\n  </array>`;
    }
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key><array>
    <string>${pwshPath()}</string>
    <string>-NoProfile</string>
    <string>-File</string>
    <string>${script}</string>
  </array>
${trigger}
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${(process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>
  </dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/tmp/ai-sync-mirror.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-sync-mirror.err.log</string>
</dict></plist>
`;
    writeFileSync(plist, xml, 'utf8');
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${name}`], { encoding: 'utf8' }); // 先卸旧的（不存在也无妨）
    const b = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
    if (b.status !== 0) return { ok: false, error: (b.stderr || '').split('\n')[0] || `bootstrap exit ${b.status}` };
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    return { ok: true, task: name, via: 'launchd', plist, spec };
  }
  if (process.platform !== 'win32') return { ok: true, skipped: true, task: name, detail: '该平台没有安装器（非失败）' };
  if (!spec.enabled) {
    const del = unregisterMirror(instance, cfg);
    mkdirSync(dirname(specFile), { recursive: true });
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    return { ok: del.ok, task: name, disabled: true, detail: 'cloudMirror.enabled=false → 已卸下镜像任务', error: del.error };
  }
  const script = mirrorScript(instance);
  if (!existsSync(script)) return { ok: false, error: `找不到镜像脚本 ${script}` };
  const cmdFile = writeCmdFile(instance, 'mirror-cmd.txt', `"${pwshPath()}" -NoProfile -File "${script}"`);
  const trigger =
    spec.mode === 'interval'
      ? `New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${Number(spec.intervalMinutes) || 60})`
      : `@(${spec.times.map((t) => `New-ScheduledTaskTrigger -Daily -At '${q(t)}'`).join(', ')})`;
  const ps = `
$ErrorActionPreference='Stop'
$action = New-ScheduledTaskAction -Execute '${q(wscriptPath())}' -Argument '"${q(runnerPath())}" "${q(cmdFile)}"' -WorkingDirectory '${q(ENGINE)}'
$triggers = ${trigger}
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName '${q(name)}' -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
Write-Output 'registered'
`;
  const r = runPs(ps);
  if (!r.ok) return { ok: false, error: r.error };
  writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return { ok: true, task: name, via: 'run-hidden.vbs', cmdFile, spec };
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
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>${(process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>
  </dict>
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
  if (argv.includes('--unregister')) {
    const t = unregisterTick(INSTANCE);
    const m = unregisterMirror(INSTANCE, cfg);
    result = { action: 'unregister', ...t, mirror: m };
  } else if (argv.includes('--register')) {
    const r = process.platform === 'win32' ? registerWindows(INSTANCE, interval) : process.platform === 'darwin' ? registerMac(INSTANCE, interval) : { ok: false, error: '该平台未提供安装器' };
    // 镜像调度：enabled=false 时 registerMirror 会主动卸下 —— 装上/卸下都由它一处收敛。
    // macOS 返回 skipped（未实现），不算失败，但 detail 会一路带到 status 里（跳过必须看得见）。
    const m = registerMirror(INSTANCE, cfg);
    result = { action: 'register', interval, ...r, ok: r.ok !== false && (m.ok !== false || m.skipped === true), mirror: m };
  } else {
    const d = detectSchedule(INSTANCE, cfg);
    result = { action: 'status', ...d, mirror: detectMirror(INSTANCE, cfg) };
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    const mirrorLine = (m, mode) => {
      if (!m) return null;
      if (m.skipped) return `   [--] 镜像调度：${m.detail || '该平台未实现'}`;
      if (mode === 'register') {
        if (m.disabled) return `   [--] 镜像调度：${m.detail}`;
        if (m.ok) return `   [OK] 镜像调度：${m.task}（${m.spec ? (m.spec.mode === 'interval' ? `每 ${m.spec.intervalMinutes} 分钟` : m.spec.times.join(' / ')) : ''}）`;
        return `   [FAIL] 镜像调度：${m.error || m.detail}`;
      }
      const st = m.enabled === false ? '已关闭' : m.inSync === true ? 'OK' : m.inSync === false ? '不一致' : '未实现';
      return `   镜像：${m.task} → ${st}${m.detail ? ` · ${m.detail}` : ''}`;
    };
    if (result.action === 'status') {
      console.log(`   调度：${result.task ?? '(无)'} → ${result.installed ? (result.inSync ? 'OK' : '间隔不一致') : '未安装'}（配置 ${result.want} 分钟${result.installed ? ` / 实际 ${result.actual}${result.unit === 'sec' ? 's' : ' 分钟'}` : ''}）${result.detail ? ` · ${result.detail}` : ''}`);
      const ml = mirrorLine(result.mirror, 'status');
      if (ml) console.log(ml);
    } else {
      if (result.ok) console.log(`   [OK] ${result.action} 成功${result.task ? `（${result.task}）` : ''}`);
      else console.log(`   [FAIL] ${result.action} 失败：${result.error || result.detail}`);
      const ml = mirrorLine(result.mirror, 'register');
      if (ml) console.log(ml);
    }
  }
  // 报告模式：调度不一致 → 2；动作模式：真失败 → 3。镜像只有**启用且明确不一致**才算不一致（未实现的平台不冤枉报错）。
  const mirrorBad = result.mirror && result.mirror.enabled !== false && result.mirror.inSync === false;
  process.exitCode = result.action === 'status' ? (!result.installed || result.inSync === false || mirrorBad ? 2 : 0) : result.ok ? 0 : 3;
}
