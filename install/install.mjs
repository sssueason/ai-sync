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
import { homedir, hostname } from 'node:os';
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

/** 幂等卸载：**先查再删**。
 *  2026-09-19 修（对端实测假红）：原先靠匹配本地化错误文本（`/cannot find|找不到/`）判断"任务不存在"，
 *  而 schtasks 在中文 Windows 上按 **GBK** 写 stderr、Node 按 **UTF-8** 解码 ⇒ 中文匹配时灵时不灵
 *  （campus 实测：`ai-sync-backup` 本就不存在，却拿到 ok:false + "系统找不到指定的文件。" ⇒ 注册流程 rc=3）。
 *  改成先查再删后，不依赖任何语言/编码的文本，语义也更准：本就不存在 = 目标已达成。 */
function deleteTaskIdempotent(name) {
  if (!taskExists(name)) return { ok: true, task: name, detail: '任务本就不存在（幂等）' };
  const r = spawnSync('schtasks', ['/delete', '/tn', name, '/f'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status === 0) return { ok: true, task: name };
  const why = (r.stderr || r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || `schtasks exit ${r.status}`;
  return { ok: false, task: name, error: why };
}

/** launchd 的 bootout 是**异步**的：紧接着 bootstrap 常撞上 "Bootstrap failed: 5: Input/output error"
 *  （2026-09-19 在 macOS 节点实测：重注册首跑必失败，要等下一轮 --reconcile 自愈才好）。
 *  给 3 次重试 + 递增退避；Node 没有同步 sleep，用 Atomics.wait 同步等。 */
function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* 环境不支持就跳过等待 */ }
}
function bootstrapLaunchd(uid, plist) {
  let b = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
  for (let i = 1; i <= 2 && b.status !== 0; i++) {
    sleepMs(400 * i);
    b = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plist], { encoding: 'utf8' });
  }
  return b;
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
  const cmdFile = writeCmdFile(instance, 'tick-cmd.txt', `"${nodeExe()}" "${tick}" --instance "${instance}" --trigger=scheduler`);
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
    // 2026-09-19（§6）：槽里跑的**脚本**也是"装的是什么"的一部分。以前它不在 spec 里 ⇒ 只改
    // cloudMirror.script 而不改时间/名字时，对账看不出差异、任务仍指着旧脚本（假绿面）。
    script: cm.script || '',
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
  return deleteTaskIdempotent(name);
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
    const b = bootstrapLaunchd(uid, plist);
    if (b.status !== 0) return { ok: false, error: (b.stderr || '').split('\n')[0] || `bootstrap exit ${b.status}` };
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    return { ok: true, task: name, via: 'launchd', plist, spec };
  }
  if (process.platform !== 'win32') return { ok: true, skipped: true, task: name, detail: '该平台没有安装器（非失败）' };
  // 任务改名后的收尾（2026-09-19，§6 退役）：默认名那条**不会自己消失**，而它仍会在每晚跑
  // **完整 daily.ps1**（doctor 双份 + µ2 老路径 + 一次多余的 pull/push）。只要配置名与默认名不同，
  // 就顺手把默认名收走 —— 幂等，不存在就不动。
  const legacyTask = 'ai-sync-mirror';
  let cleanedLegacy = false;
  if (name !== legacyTask && taskExists(legacyTask)) {
    const d = spawnSync('schtasks', ['/delete', '/tn', legacyTask, '/f'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    cleanedLegacy = d.status === 0 || /cannot find|找不到/i.test(`${d.stderr}${d.stdout}`);
  }
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
  return { ok: true, task: name, via: 'run-hidden.vbs', cmdFile, spec, cleanedLegacy };
}

/* ---------------------------------------------------------------- 备份（restic）调度
 * 背景（2026-09-19 用户裁决）：传输层改用 Syncthing 后**删除会传播** ⇒ 误删防线必须有 L2 快照层。
 * 备份与"镜像"是两件事：镜像刷的是云盘里的文档副本，备份是 restic 增量快照到**另一块物理盘**。
 * 本段只负责把配置落到平台调度（复用与 tick/mirror 同一套 run-hidden.vbs / launchd 机制），
 * 备份逻辑本身在实例的 tools/backup-run.mjs（`--verify-auto` 会顺带按到期情况跑周检/月演练）。
 * 语义：`backup` 段缺失或 enabled !== true ⇒ **不注册**（没启用备份的机器不该凭空多一个任务）。
 * 说明：µ2 退役后 mirror 段会被删除，届时这里就是唯一的"每日作业"实现。 */

export const backupTaskName = (cfg) => cfg?.backup?.taskName || 'ai-sync-backup';
export const backupLabel = (cfg) => cfg?.backup?.launchdLabel || 'ai-sync.backup';

/** 本机标识（与各工具同一套解析顺序：env → sync/local.machine → hostname） */
function machineOf(instance) {
  const env = process.env.AI_SYNC_MACHINE || process.env.DSH_MACHINE;
  if (env) return String(env).trim();
  for (const p of [join(instance, 'sync', 'local.machine'), join(ENGINE, 'sync', 'local.machine')]) {
    try { const s = readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim(); if (s) return s; } catch { /* 换下一个 */ }
  }
  try { return hostname().toLowerCase(); } catch { return 'unknown'; }
}
/** 机器级配置（备份的范围/仓库/密码文件都在这里 —— 它天生是"每机"的东西） */
function machineCfgOf(instance) {
  try { return JSON.parse(readFileSync(join(instance, 'sync', 'machines', `${machineOf(instance)}.json`), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
/** 合并：机器级覆盖实例级。★ 备份**必须**以机器级为准，否则"只在某一台机器上启用备份"这种意图
 *  表达不出来（实例级配置是三端共享的，写进去等于三端都注册）。 */
export function backupConfigOf(instance, cfg = loadInstance(instance)) {
  const ib = cfg?.backup || {};
  const mb = machineCfgOf(instance)?.backup || {};
  return { ...ib, ...mb };
}
const backupScript = (instance, cfg) => {
  const custom = backupConfigOf(instance, cfg).script;
  return custom ? resolve(instance, custom) : join(instance, 'tools', 'backup-run.mjs');
};
function backupSpecOf(instance, cfg) {
  const b = backupConfigOf(instance, cfg);
  return {
    enabled: b.enabled === true,
    mode: 'dailyAt',
    times: b.schedule?.times || ['22:00'],
    verifyAuto: b.verifyAuto !== false,
  };
}
function readBackupSpec(instance) {
  try { return JSON.parse(readFileSync(join(instance, 'sync', 'state', 'backup-spec.json'), 'utf8')); } catch { return null; }
}

/** 检测备份调度现状。返回 {platform,task,enabled,installed,inSync,detail} */
export function detectBackup(instance, cfg = loadInstance(instance)) {
  const spec = backupSpecOf(instance, cfg);
  const out = { platform: process.platform, task: process.platform === 'darwin' ? backupLabel(cfg) : backupTaskName(cfg), enabled: spec.enabled, want: spec.enabled ? spec : null, installed: false, inSync: null, detail: '' };
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${out.task}.plist`);
    out.installed = existsSync(plist);
    out.plist = plist;
  } else if (process.platform === 'win32') {
    out.installed = taskExists(out.task);
  } else {
    out.detail = '该平台没有安装器（Linux 请自行接 systemd/cron）';
    return out;
  }
  if (!spec.enabled) {
    out.inSync = !out.installed;
    out.detail = out.installed ? 'backup.enabled 未开启但任务还在（应卸下）' : '未启用备份（无任务）';
    return out;
  }
  if (!out.installed) { out.inSync = false; out.detail = '任务不存在'; return out; }
  const recorded = readBackupSpec(instance);
  const same = !!recorded && JSON.stringify(recorded) === JSON.stringify(spec);
  out.inSync = same;
  out.detail = same ? '与配置一致' : recorded ? `配置已变（上次装的是 ${JSON.stringify(recorded)}）` : '缺少 backup-spec.json（多半是手工任务，应收编）';
  return out;
}

export function unregisterBackup(instance, cfg = loadInstance(instance)) {
  const name = process.platform === 'darwin' ? backupLabel(cfg) : backupTaskName(cfg);
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${name}`], { encoding: 'utf8' });
    try { rmSync(plist, { force: true }); } catch (e) { return { ok: false, task: name, error: e.message }; }
    return { ok: true, task: name };
  }
  if (process.platform !== 'win32') return { ok: true, skipped: true, task: name, detail: '该平台没有安装器（非失败）' };
  return deleteTaskIdempotent(name);
}

export function registerBackup(instance, cfg = loadInstance(instance)) {
  const name = process.platform === 'darwin' ? backupLabel(cfg) : backupTaskName(cfg);
  const spec = backupSpecOf(instance, cfg);
  const specFile = join(instance, 'sync', 'state', 'backup-spec.json');
  if (!spec.enabled) {
    const del = unregisterBackup(instance, cfg);
    mkdirSync(dirname(specFile), { recursive: true });
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    return { ok: del.ok, task: name, disabled: true, detail: 'backup.enabled 未开启 → 未注册备份任务', error: del.error };
  }
  const script = backupScript(instance, cfg);
  if (!existsSync(script)) return { ok: false, error: `找不到备份脚本 ${script}` };
  const cmdLine = `"${nodeExe()}" "${script}" --instance "${instance}" --rc${spec.verifyAuto ? ' --verify-auto' : ''}`;
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    const items = spec.times.map((t) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(t).trim());
      return m ? `    <dict><key>Hour</key><integer>${Number(m[1])}</integer><key>Minute</key><integer>${Number(m[2])}</integer></dict>` : null;
    }).filter(Boolean);
    if (!items.length) return { ok: false, error: `backup.schedule.times 解析不出时刻：${JSON.stringify(spec.times)}` };
    const args = [`"${nodeExe()}"`, `"${script}"`, '--instance', `"${instance}"`, '--rc'].map((a) => `    <string>${a.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key><array>
${args}${spec.verifyAuto ? '\n    <string>--verify-auto</string>' : ''}
  </array>
  <key>StartCalendarInterval</key><array>
${items.join('\n')}
  </array>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/tmp/ai-sync-backup.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-sync-backup.err.log</string>
</dict></plist>
`;
    writeFileSync(plist, xml, 'utf8');
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${name}`], { encoding: 'utf8' });
    const b = bootstrapLaunchd(uid, plist);
    if (b.status !== 0) return { ok: false, error: (b.stderr || '').split('\n')[0] || `bootstrap exit ${b.status}` };
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    return { ok: true, task: name, via: 'launchd', plist, spec };
  }
  if (process.platform !== 'win32') return { ok: true, skipped: true, task: name, detail: '该平台没有安装器（非失败）' };
  const cmdFile = writeCmdFile(instance, 'backup-cmd.txt', cmdLine);
  const triggers = `@(${spec.times.map((t) => `New-ScheduledTaskTrigger -Daily -At '${q(t)}'`).join(', ')})`;
  const ps = `
$ErrorActionPreference='Stop'
$action = New-ScheduledTaskAction -Execute '${q(wscriptPath())}' -Argument '"${q(runnerPath())}" "${q(cmdFile)}"' -WorkingDirectory '${q(ENGINE)}'
$triggers = ${triggers}
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 6)
Register-ScheduledTask -TaskName '${q(name)}' -Action $action -Trigger $triggers -Settings $settings -Force | Out-Null
Write-Output 'registered'
`;
  const r = runPs(ps);
  if (!r.ok) return { ok: false, error: r.error };
  writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return { ok: true, task: name, via: 'run-hidden.vbs', cmdFile, spec };
}

/* ---------------------------------------------------------------- 传输层（Syncthing）自启
 * 与 tick / mirror / backup 不同：Syncthing 是**常驻进程**，触发条件也不同 ——
 * 登录时启动、失败自动重启、不设执行时限（定时作业那套 -Daily/-At 与 3–6 小时上限都不适用）。
 * 同样以**机器级**配置为准（`transport.autostart === true` 才注册），否则三端共享的实例配置
 * 会让没启用的机器也长出一个任务。 */

export const transportTaskName = (cfg) => cfg?.transport?.taskName || 'ai-sync-syncthing';
export const transportLabel = (cfg) => cfg?.transport?.launchdLabel || 'ai-sync.syncthing';
export function transportConfigOf(instance, cfg = loadInstance(instance)) {
  const ib = cfg?.transport || {};
  const mb = machineCfgOf(instance)?.transport || {};
  return { ...ib, ...mb };
}
/** Syncthing 可执行文件：配置优先 → PATH → winget shim / brew 前缀（与 backup 的 restic 同一套兜底思路） */
function syncthingExe(instance, cfg) {
  const t = transportConfigOf(instance, cfg);
  if (t.exe) return t.exe;
  const exe = process.platform === 'win32' ? 'syncthing.exe' : 'syncthing';
  for (const d of (process.env.PATH || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)) {
    const p = join(d, exe);
    if (existsSync(p)) return p;
  }
  return [
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', exe),
    join(homedir(), 'bin', exe),
    '/opt/homebrew/bin/syncthing',
    '/usr/local/bin/syncthing'
  ].filter(Boolean).find((p) => existsSync(p)) || null;
}
/** 配置与数据目录：默认各平台的常规位置，可由 transport.home 覆盖 */
function syncthingHome(instance, cfg) {
  const t = transportConfigOf(instance, cfg);
  if (t.home) return String(t.home).replace(/^~/, homedir());
  return process.platform === 'win32' ? join(process.env.LOCALAPPDATA || homedir(), 'Syncthing') : join(homedir(), 'Library', 'Application Support', 'Syncthing');
}
function transportSpecOf(instance, cfg) {
  const t = transportConfigOf(instance, cfg);
  return { enabled: t.autostart === true, exe: syncthingExe(instance, cfg), home: syncthingHome(instance, cfg) };
}
function readTransportSpec(instance) {
  try { return JSON.parse(readFileSync(join(instance, 'sync', 'state', 'transport-spec.json'), 'utf8')); } catch { return null; }
}

export function detectTransport(instance, cfg = loadInstance(instance)) {
  const spec = transportSpecOf(instance, cfg);
  const out = { platform: process.platform, task: process.platform === 'darwin' ? transportLabel(cfg) : transportTaskName(cfg), enabled: spec.enabled, want: spec.enabled ? { exe: spec.exe, home: spec.home } : null, installed: false, inSync: null, detail: '' };
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${out.task}.plist`);
    out.installed = existsSync(plist);
    out.plist = plist;
  } else if (process.platform === 'win32') {
    out.installed = taskExists(out.task);
  } else {
    out.detail = '该平台没有安装器（Linux 请自行接 systemd）';
    return out;
  }
  if (!spec.enabled) {
    out.inSync = !out.installed;
    out.detail = out.installed ? 'transport.autostart 未开启但任务还在（应卸下）' : '未启用传输层自启（无任务）';
    return out;
  }
  if (!spec.exe) { out.inSync = false; out.detail = '找不到 syncthing 可执行文件（先安装或配 transport.exe）'; return out; }
  if (!out.installed) { out.inSync = false; out.detail = '任务不存在'; return out; }
  const rec = readTransportSpec(instance);
  const same = !!rec && rec.exe === spec.exe && rec.home === spec.home;
  out.inSync = same;
  out.detail = same ? '与配置一致' : rec ? `配置已变（上次装的是 ${rec.exe} / ${rec.home}）` : '缺少 transport-spec.json（多半是手工任务，应收编）';
  return out;
}

export function unregisterTransport(instance, cfg = loadInstance(instance)) {
  const name = process.platform === 'darwin' ? transportLabel(cfg) : transportTaskName(cfg);
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${name}`], { encoding: 'utf8' });
    try { rmSync(plist, { force: true }); } catch (e) { return { ok: false, task: name, error: e.message }; }
    return { ok: true, task: name };
  }
  if (process.platform !== 'win32') return { ok: true, skipped: true, task: name, detail: '该平台没有安装器（非失败）' };
  return deleteTaskIdempotent(name);
}

export function registerTransport(instance, cfg = loadInstance(instance)) {
  const name = process.platform === 'darwin' ? transportLabel(cfg) : transportTaskName(cfg);
  const spec = transportSpecOf(instance, cfg);
  const specFile = join(instance, 'sync', 'state', 'transport-spec.json');
  if (!spec.enabled) {
    const del = unregisterTransport(instance, cfg);
    mkdirSync(dirname(specFile), { recursive: true });
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    return { ok: del.ok, task: name, disabled: true, detail: 'transport.autostart 未开启 → 未注册自启', error: del.error };
  }
  if (!spec.exe) return { ok: false, error: '找不到 syncthing 可执行文件：请先安装（winget install Syncthing.Syncthing）或设 transport.exe' };
  if (process.platform === 'darwin') {
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${name}.plist`);
    mkdirSync(dirname(plist), { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${name}</string>
  <key>ProgramArguments</key><array>
    <string>${spec.exe}</string>
    <string>serve</string>
    <string>--home=${spec.home}</string>
    <string>--no-browser</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/ai-sync-syncthing.out.log</string>
  <key>StandardErrorPath</key><string>/tmp/ai-sync-syncthing.err.log</string>
</dict></plist>
`;
    writeFileSync(plist, xml, 'utf8');
    const uid = process.getuid ? process.getuid() : 501;
    spawnSync('launchctl', ['bootout', `gui/${uid}/${name}`], { encoding: 'utf8' });
    const b = bootstrapLaunchd(uid, plist);
    if (b.status !== 0) return { ok: false, error: (b.stderr || '').split('\n')[0] || `bootstrap exit ${b.status}` };
    writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
    return { ok: true, task: name, via: 'launchd', plist, spec };
  }
  if (process.platform !== 'win32') return { ok: true, skipped: true, task: name, detail: '该平台没有安装器（非失败）' };
  const ps = `
$ErrorActionPreference='Stop'
$action = New-ScheduledTaskAction -Execute '${q(spec.exe)}' -Argument 'serve --home="${q(spec.home)}" --no-browser'
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName '${q(name)}' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Output 'registered'
`;
  const r = runPs(ps);
  if (!r.ok) return { ok: false, error: r.error };
  writeFileSync(specFile, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return { ok: true, task: name, via: 'scheduled-task', spec };
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
    <string>--trigger=scheduler</string>
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
  const b = bootstrapLaunchd(uid, plist);
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
  /** 复合结果：主任务 + 三个作业槽。**失败必须带原因**。
   *  2026-09-19 修（对端实测假红）：以前只把 ok 置 false、却不写 error，而打印端是
   *  `result.error || result.detail` ⇒ 输出 "register 失败：undefined" —— 看起来像注册坏了，
   *  实际只是 backup 那个任务本就不存在。假红与假绿一样贵：多了就没人看红了。 */
  const jobOk = (x) => !x || x.ok !== false || x.skipped === true;
  const reasonsOf = (main, jobs) => {
    const why = [];
    if (main && main.ok === false) why.push(main.error || '主任务失败（未给出原因）');
    for (const [label, x] of jobs) if (x && x.ok === false && x.skipped !== true) why.push(`${label}：${x.error || x.detail || '未给出原因'}`);
    return why;
  };

  if (argv.includes('--unregister')) {
    const t = unregisterTick(INSTANCE);
    const m = unregisterMirror(INSTANCE, cfg);
    const b = unregisterBackup(INSTANCE, cfg);
    const tr = unregisterTransport(INSTANCE, cfg);
    result = { action: 'unregister', ...t, mirror: m, backup: b, transport: tr, ok: t.ok !== false && jobOk(m) && jobOk(b) && jobOk(tr) };
    if (!result.ok) result.error = reasonsOf(t, [['镜像', m], ['备份', b], ['传输', tr]]).join('；') || '未给出原因（这是 bug：失败必须带原因）';
  } else if (argv.includes('--register')) {
    const r = process.platform === 'win32' ? registerWindows(INSTANCE, interval) : process.platform === 'darwin' ? registerMac(INSTANCE, interval) : { ok: false, error: '该平台未提供安装器' };
    // 镜像调度：enabled=false 时 registerMirror 会主动卸下 —— 装上/卸下都由它一处收敛。
    // macOS 返回 skipped（未实现），不算失败，但 detail 会一路带到 status 里（跳过必须看得见）。
    const m = registerMirror(INSTANCE, cfg);
    // 备份调度（2026-09-19）：同款机制；未启用备份的机器返回 disabled，同样不算失败。
    const b = registerBackup(INSTANCE, cfg);
    // 传输层自启（2026-09-19）：常驻进程，触发条件不同（登录 + 失败重启 + 不限时）。
    const tr = registerTransport(INSTANCE, cfg);
    result = { action: 'register', interval, ...r, ok: r.ok !== false && jobOk(m) && jobOk(b) && jobOk(tr), mirror: m, backup: b, transport: tr };
    if (!result.ok) result.error = reasonsOf(r, [['镜像', m], ['备份', b], ['传输', tr]]).join('；') || '未给出原因（这是 bug：失败必须带原因）';
  } else {
    const d = detectSchedule(INSTANCE, cfg);
    result = { action: 'status', ...d, mirror: detectMirror(INSTANCE, cfg), backup: detectBackup(INSTANCE, cfg), transport: detectTransport(INSTANCE, cfg) };
  }

  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    /** 作业调度行（mirror / backup 共用一套措辞，避免两处漂移） */
    const jobLine = (j, mode, label) => {
      if (!j) return null;
      if (j.skipped) return `   [--] ${label}调度：${j.detail || '该平台未实现'}`;
      if (mode === 'register') {
        if (j.disabled) return `   [--] ${label}调度：${j.detail}`;
        if (j.ok) return `   [OK] ${label}调度：${j.task}（${j.spec ? (j.spec.mode === 'interval' ? `每 ${j.spec.intervalMinutes} 分钟` : (j.spec.times || []).join(' / ')) : ''}）`;
        return `   [FAIL] ${label}调度：${j.error || j.detail}`;
      }
      const st = j.enabled === false ? '已关闭' : j.inSync === true ? 'OK' : j.inSync === false ? '不一致' : '未实现';
      return `   ${label}：${j.task} → ${st}${j.detail ? ` · ${j.detail}` : ''}`;
    };
    if (result.action === 'status') {
      console.log(`   调度：${result.task ?? '(无)'} → ${result.installed ? (result.inSync ? 'OK' : '间隔不一致') : '未安装'}（配置 ${result.want} 分钟${result.installed ? ` / 实际 ${result.actual}${result.unit === 'sec' ? 's' : ' 分钟'}` : ''}）${result.detail ? ` · ${result.detail}` : ''}`);
      const ml = jobLine(result.mirror, 'status', '镜像');
      if (ml) console.log(ml);
      const bl = jobLine(result.backup, 'status', '备份');
      if (bl) console.log(bl);
      const tl = jobLine(result.transport, 'status', '传输');
      if (tl) console.log(tl);
    } else {
      if (result.ok) console.log(`   [OK] ${result.action} 成功${result.task ? `（${result.task}）` : ''}`);
      else console.log(`   [FAIL] ${result.action} 失败：${result.error || result.detail || '未给出原因（这是 bug：失败必须带原因）'}`);
      const ml = jobLine(result.mirror, 'register', '镜像');
      if (ml) console.log(ml);
      const bl = jobLine(result.backup, 'register', '备份');
      if (bl) console.log(bl);
      const tl = jobLine(result.transport, 'register', '传输');
      if (tl) console.log(tl);
    }
  }
  // 报告模式：调度不一致 → 2；动作模式：真失败 → 3。作业只有**启用且明确不一致**才算不一致（未实现的平台不冤枉报错）。
  const bad = (j) => j && j.enabled !== false && j.inSync === false;
  const jobBad = bad(result.mirror) || bad(result.backup) || bad(result.transport);
  process.exitCode = result.action === 'status' ? (!result.installed || result.inSync === false || jobBad ? 2 : 0) : result.ok ? 0 : 3;
}
