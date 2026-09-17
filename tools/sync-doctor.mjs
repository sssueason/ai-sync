#!/usr/bin/env node
/**
 * sync-doctor — 引擎自检：**这台机器的配置与仓库到底对不对**（跨平台，只要 node）
 *
 * 为什么需要它：
 *   · 实例侧有 `health_check.py`，但它需要 Python 3（有的机器没有）⇒ 引擎要有一份纯 node 的等价物；
 *   · 控制台向导要"写前校验"，若把那套规则写在控制台里，就会和这里漂成两份 ⇒ **规则只此一份**，
 *     控制台 `import { validateMachineConfig }` 复用它。
 *
 * 检查项：
 *   1. instance.json 能否解析 + tick/console 取值范围
 *   2. machines/<机器>.json：存在、可解析、mu1 的路径真的存在且是 git 仓
 *   3. mu2（云盘镜像，可选）：根存在/是目录/不含 .git；每个集合 id/source/target 合法、target 唯一
 *   4. 适配器：producers/owners 的 JSON 可解析；instance.json 里启用的 id 真的存在
 *   5. 仓库卫生：跟踪集里**不该有** node_modules / *.db / *.pem / *.key / 原始数据扩展名 / .DS_Store
 *   6. 调度：平台任务是否装了、间隔与配置是否一致（复用 install.mjs 的 detectSchedule）
 *
 * 用法：
 *   node tools/sync-doctor.mjs [--instance <dir>] [--machine <id>] [--json] [--quiet]
 * 退出码：0 = 只有 PASS/WARN；2 = 有 FAIL。
 */
import { readFileSync, existsSync, statSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir, hostname } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(process.env.AI_SYNC_ENGINE || join(HERE, '..'));
const argv = process.argv.slice(2);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);
const JSON_OUT = argv.includes('--json');
const QUIET = argv.includes('--quiet');

const expand = (p) => (!p ? p : p === '~' ? homedir() : String(p).startsWith('~/') ? join(homedir(), String(p).slice(2)) : p);
export const ID_RE = /^[a-z0-9._-]+$/i;

/**
 * 校验「机器配置」的 mu2 段 + mu1 段。**这是全网唯一的实现**：控制台向导调用它做写前校验，
 * doctor 调用它做自检。（2026-09-17：先前控制台里内联了一份，那份已删。）
 * @returns {{errors: string[], warnings: string[], mu2: object|null, dest: string|null}}
 */
export function validateMachineConfig(machineCfg, { requirePaths = true } = {}) {
  const errors = [];
  const warnings = [];
  const mu1 = Array.isArray(machineCfg?.mu1) ? machineCfg.mu1 : [];
  if (!mu1.length) warnings.push('machine.mu1 为空：这台机器没有任何要被同步的 git 仓（引擎会无事可做）');
  for (const [i, r] of mu1.entries()) {
    const at = `mu1[${i}]`;
    if (!ID_RE.test(String(r.id || ''))) errors.push(`${at}: id 只能含字母数字._-（当前「${r.id ?? ''}」）`);
    if (r.repo === false) continue;
    const p = expand(r.path);
    if (!p) errors.push(`${at}: path 不能为空`);
    else if (!existsSync(p)) errors.push(`${at}: 路径不存在：${p}`);
    else if (!existsSync(join(p, '.git'))) warnings.push(`${at}: ${p} 不是 git 仓（repo=true 时应是）`);
  }

  const mu2in = machineCfg?.mu2;
  if (!mu2in) return { errors, warnings, mu2: null, dest: null };
  const dest = expand(String(mu2in.dest || ''));
  if (!dest) errors.push('mu2.dest（同步空间根）不能为空');
  else if (!existsSync(dest)) errors.push(`mu2.dest 不存在：${dest}`);
  else if (!statSync(dest).isDirectory()) errors.push(`mu2.dest 不是目录：${dest}`);
  else if (existsSync(join(dest, '.git'))) errors.push(`mu2.dest 里有 .git —— 云盘不能托管 git 仓：${dest}`);

  const sets = Array.isArray(mu2in.sets) ? mu2in.sets : [];
  const seen = new Set();
  const normalizedSets = [];
  for (const [i, s] of sets.entries()) {
    const at = `mu2.sets[${i}]`;
    const id = String(s.id || '').trim();
    const source = expand(String(s.source || '').trim());
    const target = String(s.target || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!ID_RE.test(id)) errors.push(`${at}: id 只能含字母数字._-（当前「${id}」）`);
    if (!source) errors.push(`${at}: source（权威目录）不能为空`);
    else if (requirePaths && !existsSync(source)) errors.push(`${at}: source 不存在：${source}`);
    else if (requirePaths && !statSync(source).isDirectory()) errors.push(`${at}: source 不是目录：${source}`);
    if (!target) errors.push(`${at}: target（镜像内子目录）不能为空`);
    else if (/^([a-zA-Z]:|\/)/.test(target)) errors.push(`${at}: target 必须是相对子目录，不能是绝对路径（当前「${target}」）`);
    else if (target.split('/').includes('..')) errors.push(`${at}: target 不能含 ..（当前「${target}」）`);
    if (target && seen.has(target.toLowerCase())) errors.push(`${at}: target 与前面的集合重复（${target}）——两个集合写同一处必然冲突`);
    seen.add(target.toLowerCase());
    normalizedSets.push({ id, source, target });
  }
  if (dest && !/baidu|百度|nutstore|坚果|onedrive|dropbox|icloud|syncdisk|同步空间/i.test(basename(dest))) {
    warnings.push(`mu2.dest 目录名不像常见网盘同步根（${basename(dest)}）——确认它真的是客户端配的那个同步文件夹`);
  }
  // 归一化后的 mu2（`~` 已展开、target 已去反斜杠/末尾斜杠）——**保存方直接用这份**，别再自己归一化一遍
  const normalized = { dest, autoSeed: mu2in.autoSeed !== false, sets: normalizedSets };
  return { errors, warnings, mu2: mu2in, dest: dest || null, normalized };
}

/* ---------------------------------------------------------------- 主流程（仅当作为入口运行时） */

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const checks = [];
  const add = (name, level, expected, actual) => checks.push({ name, level, expected, actual });
  const machine =
    val('--machine') ||
    process.env.AI_SYNC_MACHINE ||
    process.env.DSH_MACHINE ||
    (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim() : hostname().toLowerCase());

  // 1. instance.json
  let cfg = {};
  const cfgFile = join(INSTANCE, 'sync', 'instance.json');
  if (!existsSync(cfgFile)) {
    add('instance.json 存在', 'FAIL', cfgFile, '不存在（新机请从 instance.example.json 复制）');
  } else {
    try {
      cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
      add('instance.json 可解析', 'PASS', '合法 JSON', 'OK');
    } catch (e) {
      add('instance.json 可解析', 'FAIL', '合法 JSON', e.message);
    }
  }
  const t = cfg.tick || {};
  const rng = (k, v, lo, hi) => (v === undefined ? null : Number.isFinite(v) && v >= lo && v <= hi ? true : `${k}=${v} 超出 ${lo}..${hi}`);
  for (const [k, v, lo, hi] of [['intervalMinutes', t.intervalMinutes, 1, 120], ['jitterSeconds', t.jitterSeconds, 0, 300], ['statePushMinutes', t.statePushMinutes, 1, 1440]]) {
    const r = rng(k, v, lo, hi);
    if (r === true) add(`tick.${k} 合法`, 'PASS', `${lo}..${hi}`, String(v));
    else if (r) add(`tick.${k} 合法`, 'FAIL', `${lo}..${hi}`, r);
  }

  // 2/3. 机器配置（复用上面那份唯一实现）
  const mfile = join(INSTANCE, 'sync', 'machines', `${machine}.json`);
  if (!existsSync(mfile)) {
    add('机器配置存在', 'FAIL', mfile, '不存在（见 machines.example.json）');
  } else {
    let mc = null;
    try {
      mc = JSON.parse(readFileSync(mfile, 'utf8'));
      add('机器配置可解析', 'PASS', '合法 JSON', 'OK');
    } catch (e) {
      add('机器配置可解析', 'FAIL', '合法 JSON', e.message);
    }
    if (mc) {
      const v = validateMachineConfig(mc);
      add('机器配置校验', v.errors.length ? 'FAIL' : 'PASS', '0 个错误', v.errors.length ? v.errors.join(' | ') : '0');
      for (const w of v.warnings) add('机器配置提示', 'WARN', '—', w);
    }
  }

  // 4. 适配器
  const loadDir = (d) => {
    const dir = join(ENGINE, 'adapters', d);
    if (!existsSync(dir)) return { list: [], errs: [`缺目录 adapters/${d}`] };
    const list = [];
    const errs = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      try {
        list.push({ file: f, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) });
      } catch (e) {
        errs.push(`${d}/${f}: ${e.message}`);
      }
    }
    return { list, errs };
  };
  const producers = loadDir('producers');
  const owners = loadDir('owners');
  add('适配器可解析', producers.errs.length + owners.errs.length ? 'FAIL' : 'PASS', '0 个错误', [...producers.errs, ...owners.errs].join(' | ') || '0');
  const knownOwners = new Set(owners.list.map((o) => o.id));
  const knownProducers = new Set(producers.list.map((p) => p.id));
  for (const [kind, known] of [['owners', knownOwners], ['producers', knownProducers]]) {
    for (const [id, sw] of Object.entries(cfg[kind] || {})) {
      if (!known.has(id)) add(`${kind}.${id} 存在`, 'FAIL', 'descriptor 存在', `instance.json 启用了不存在的 ${kind}：${id}`);
    }
  }
  if (!producers.list.filter((p) => (cfg.producers?.[p.id] ?? p.enabled !== false) && p.renderCmd).length) {
    add('至少一个渲染器启用', 'FAIL', '≥1', '全部被关掉或都没有 renderCmd → 不会渲染任何 live 配置');
  }

  // 5. 仓库卫生（只用 git 跟踪集，不扫盘）
  const FORBIDDEN = [
    [/(^|\/)node_modules\//, 'node_modules'],
    [/\.(db|db-shm|db-wal|sqlite)$/i, '数据库文件'],
    [/\.(pem|key|p12|pfx)$/i, '密钥/证书'],
    [/\.(dcm|gz|bam|tif|tiff|raw|fcs)$/i, '原始科研数据'],
    [/(^|\/)\.DS_Store$/, '.DS_Store'],
  ];
  const mc = existsSync(mfile) ? JSON.parse(readFileSync(mfile, 'utf8')) : {};
  for (const r of (mc.mu1 || []).filter((x) => x.repo)) {
    const p = expand(r.path);
    if (!existsSync(join(p, '.git'))) continue;
    let files = [];
    try {
      files = execFileSync('git', ['-C', p, 'ls-files'], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
    } catch {
      add(`仓库 ${r.id} 可读跟踪集`, 'WARN', 'git ls-files', '失败');
      continue;
    }
    const bad = [];
    for (const f of files) for (const [re, why] of FORBIDDEN) if (re.test(f)) bad.push(`${f}（${why}）`);
    add(`仓库 ${r.id} 无禁同步物`, bad.length ? 'FAIL' : 'PASS', '0 个', bad.length ? bad.slice(0, 5).join(' | ') : '0');
  }

  // 6. 调度（复用 install.mjs，唯一实现）
  const installPath = [join(ENGINE, 'install', 'install.mjs'), join(ENGINE, 'engine', 'install', 'install.mjs')].find((p) => existsSync(p));
  if (installPath) {
    const mod = await import(pathToFileURL(installPath).href);
    const d = mod.detectSchedule(INSTANCE, cfg);
    if (!d.installed) add('调度已安装', 'FAIL', d.task || 'ai-sync-tick', d.detail || '未安装');
    else if (d.inSync === false) add('调度间隔与配置一致', 'FAIL', `${d.want} 分钟`, `实际 ${d.actual}${d.unit === 'sec' ? 's' : ' 分钟'}`);
    else add('调度已安装', 'PASS', d.task, `间隔 ${d.want} 分钟一致`);
  } else {
    add('安装器存在', 'FAIL', 'install/install.mjs', '找不到');
  }

  /* ---------------------------------------------------------------- 隐藏执行（Windows）
   * 计划任务的动作应该是 `wscript run-hidden.vbs <命令文件>`；若直接写 node.exe，交互式身份下
   * 每轮都会闪一个控制台窗口（2026-09-17 用户反馈）。这里两条断言：
   *   1) run-hidden.vbs 必须**纯 ASCII** —— wscript 按 ANSI 代码页读 .vbs，中文注释的字节会被
   *      误解码并吞掉换行，把下面的代码整段注释掉（实测退出码从 7 变成 3，静默失效）。
   *   2) 真跑一次探测（`cmd /c exit 0` 期望 0）。只看字节不算数：假绿防线要求它能失败也能真跑通。 */
  if (process.platform === 'win32') {
    // 两种布局都要认：拆分时 <引擎根>/install/run-hidden.vbs；原地时 <仓根>/engine/install/run-hidden.vbs
    const runner = [join(ENGINE, 'install', 'run-hidden.vbs'), join(ENGINE, 'engine', 'install', 'run-hidden.vbs')].find((p) => existsSync(p)) || join(ENGINE, 'install', 'run-hidden.vbs');
    if (!existsSync(runner)) add('隐藏运行器存在', 'FAIL', 'install/run-hidden.vbs', '找不到（计划任务会闪窗）');
    else {
      const buf = readFileSync(runner);
      const at = buf.findIndex((b) => b > 127);
      add('隐藏运行器为纯 ASCII', at === -1 ? 'PASS' : 'FAIL', '没有非 ASCII 字节（wscript 按 ANSI 读脚本）', at === -1 ? '0 个' : `第 ${at} 字节 = 0x${buf[at].toString(16)}，中文注释会吞掉换行并注释掉代码`);
      const stateDir = join(INSTANCE, 'sync', 'state');
      const probe = join(stateDir, '.doctor-runner-probe.txt');
      try {
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(probe, '\uFEFF' + 'cmd /c exit 0\r\n', 'utf16le'); // UTF-16LE **带 BOM**：缺 BOM 会被读成空
        const r = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe'), [runner, probe], { windowsHide: true, timeout: 30000 });
        add('隐藏运行器可跑通', r.status === 0 ? 'PASS' : 'FAIL', '探测命令退出码 0', `实际 ${r.status}`);
      } catch (e) {
        add('隐藏运行器可跑通', 'FAIL', '探测命令退出码 0', e.message);
      } finally {
        try {
          rmSync(probe, { force: true });
        } catch {}
      }
    }
  }

  const fails = checks.filter((c) => c.level === 'FAIL');
  if (JSON_OUT) console.log(JSON.stringify({ instance: INSTANCE, machine, checks, fails: fails.length }, null, 2));
  else if (!QUIET) {
    console.log(`=== sync-doctor · ${machine} · ${INSTANCE} ===`);
    for (const c of checks) console.log(`  [${c.level}] ${c.name}  ← 期望 ${c.expected} / 实际 ${c.actual}`);
    console.log(`=== ${checks.filter((c) => c.level === 'PASS').length} PASS · ${checks.filter((c) => c.level === 'WARN').length} WARN · ${fails.length} FAIL ===`);
  }
  process.exitCode = fails.length ? 2 : 0;
}
