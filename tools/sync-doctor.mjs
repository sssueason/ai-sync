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
 *   3. mu2（云盘镜像，可选）：根存在/是目录/不含 .git；每个集合 id/source/target 合法、target 唯一、
 *      **过滤字段齐备**（没有任何过滤字段 = 整树镜像；源是 Documents/Desktop/Downloads 这类宽目录
 *      必须声明 onlySubdirs 或 includeExt——2026-09-18 的 16.7 万文件误镜像事故即由此而来）
 *   4. 适配器：producers/owners 的 JSON 可解析；instance.json 里启用的 id 真的存在
 *   5. 仓库卫生：跟踪集里**不该有** node_modules / *.db / *.pem / *.key / 原始数据扩展名 / .DS_Store / sync/state 下的机器本地点文件
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
    /* ---------------------------------------------------------------- 过滤字段必须齐备（2026-09-18 实测事故）
     * 事故形态：某台机器的 8 个集合被一次编辑**抹掉全部过滤字段**（excludeExt / excludeDirNames /
     * onlySubdirs / onlyFiles / includeExt），退化成"整棵树全镜像" ⇒ tree-sync 报"待推 167,731"，
     * 手动 seed 把 16.7 万文件（含 12,387 个 node_modules、470 个 .git、大量 .tif/.zip 原始数据）
     * 推进了云盘同步空间。下面两条规则让这种回归在**写前校验**与**巡检**当场变红。
     * 注意：同一个 target 被**不同机器**的集合共用是设计（union mirror，9 个目标名都是多机共用），
     * 所以这里只查"一台机器内重复"，不查跨机重复。 */
    const FILTER_KEYS = ['onlySubdirs', 'onlyFiles', 'includeExt', 'excludeExt', 'excludeDirNames'];
    const hasFilter = FILTER_KEYS.some((k) => (Array.isArray(s[k]) ? s[k].length > 0 : Boolean(s[k])));
    if (!hasFilter) {
      errors.push(`${at}（${id}）: 没有任何过滤字段（${FILTER_KEYS.join(' / ')}）⇒ 会把整棵 source 树镜像出去；至少给一个 excludeExt 或 excludeDirNames`);
    }
    // 宽源（家目录本身，或家目录下的 Documents / Desktop / Downloads）**只给黑名单是不够的**：
    // 黑名单挡住原始数据，挡不住"整个用户文档夹里的游戏、聊天缓存、App 数据"——本次就是这么
    // 把 111,138 个文件当成了"该镜像的内容"。宽源必须白名单（onlySubdirs 或 includeExt）。
    const srcRaw = String(s.source || '').trim().replace(/\\/g, '/');
    const broadSource = !srcRaw || /^~\/?$/.test(srcRaw) || /(^|\/)(Documents|Desktop|Downloads|文档|桌面|下载)\/?$/i.test(srcRaw);
    const hasAllow = (Array.isArray(s.onlySubdirs) && s.onlySubdirs.length > 0) || (Array.isArray(s.includeExt) && s.includeExt.length > 0);
    if (broadSource && !hasAllow) {
      errors.push(`${at}（${id}）: source 是用户家目录级宽目录（${s.source}）⇒ 必须声明 onlySubdirs 或 includeExt（只给黑名单等于把整个文档夹镜像出去，2026-09-18 因此误镜像 111,138 个文件）`);
    }
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

  /* ---- 机器本地点文件（这一类已经复发 4 次）------------------------------------
     计划任务命令文件（含绝对路径）、诊断报告（每天新增）、`.last-state-*` 抖动、引擎比对节流戳。
     后果完全一样：每台机器各自改写这些文件 ⇒ 自动提交 ⇒ 撞 rebase ⇒ integrate 永久失败
     （对端实测 tick 连续 rc=1、单轮 1019s）。判据：实例仓库 `sync/state/` 下被 git 跟踪的隐藏文件一律 FAIL。
     为什么单列一节、而不是搭上面 mu1 循环的便车：循环顺带能查到实例仓库只是**巧合**（mu1 是"本机同步的仓库"），
     一旦清单变了或 doctor 从引擎目录跑，同一份代码就会静默变成永远 PASS 的装饰性断言 —— 那正是假绿。
     这里直接判 INSTANCE；git 用不了时记 WARN（"未检查"是一个状态），不静默略过。 */
  {
    let tracked = null;
    try {
      tracked = execFileSync('git', ['-C', INSTANCE, 'ls-files', 'sync/state'], { encoding: 'utf8', windowsHide: true }).split('\n').filter(Boolean);
    } catch { /* 落到下面的 WARN 分支 */ }
    if (tracked === null) {
      add('状态目录无被跟踪的点文件', 'WARN', '0 个（机器本地状态不进 git）', '实例目录不是 git 仓库或 git 不可用 ⇒ 本项未检查');
    } else {
      const strays = tracked.filter((x) => basename(x).startsWith('.') && x !== 'sync/state/.gitkeep');
      add('状态目录无被跟踪的点文件', strays.length ? 'FAIL' : 'PASS', '0 个（机器本地状态不进 git）', strays.length ? strays.join(' | ') : '0');
    }
  }

  // 6. 调度（复用 install.mjs，唯一实现）
  /* ---------------------------------------------------------------- 日志与报告体量
   * 保留策略在 tools/sync-prune.mjs（tick 每轮自动跑一次）。这里断言它**确实在生效**：
   * 报告是"每次运行新增一个"的文件，策略失效时唯一的表现就是数量悄悄涨回去。 */
  const reportsDir = join(INSTANCE, 'sync', 'reports');
  if (existsSync(reportsDir)) {
    const md = readdirSync(reportsDir).filter((f) => f.endsWith('.md') && /-\d{8}-\d{4}\.md$/.test(f));
    const byGroup = {};
    for (const f of md) {
      const g = f.replace(/-\d{8}-\d{4}\.md$/, '');
      byGroup[g] = (byGroup[g] || 0) + 1;
    }
    const worst = Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0];
    const over = md.length > 200 || (worst && worst[1] > 25);
    add('报告目录体量', over ? 'WARN' : 'PASS', '每组 ≤ 25 个（保留策略：最新 5 ∪ 7 天，硬上限 20）', `${md.length} 个 / ${Object.keys(byGroup).length} 组${worst ? `（最多 ${worst[0]} ${worst[1]} 个）` : ''}${over ? ' —— 清理可能没跑：node tools/sync-prune.mjs' : ''}`);
  }
  const logsDir = join(INSTANCE, 'sync', 'logs');
  if (existsSync(logsDir)) {
    const logs = readdirSync(logsDir).filter((f) => f.endsWith('.log'));
    const bytes = logs.reduce((a, f) => a + statSync(join(logsDir, f)).size, 0);
    const mb = bytes / 1048576;
    add('日志目录体量', mb > 20 ? 'WARN' : 'PASS', '≤ 20 MB（tick 日志超 2 MB 自动截断、每日日志留 14 天）', `${logs.length} 个 / ${mb.toFixed(1)} MB`);
  }

  const installPath = [join(ENGINE, 'install', 'install.mjs'), join(ENGINE, 'engine', 'install', 'install.mjs')].find((p) => existsSync(p));
  if (installPath) {
    const mod = await import(pathToFileURL(installPath).href);
    const d = mod.detectSchedule(INSTANCE, cfg);
    if (!d.installed) add('调度已安装', 'FAIL', d.task || 'ai-sync-tick', d.detail || '未安装');
    else if (d.inSync === false) add('调度间隔与配置一致', 'FAIL', `${d.want} 分钟`, `实际 ${d.actual}${d.unit === 'sec' ? 's' : ' 分钟'}`);
    else add('调度已安装', 'PASS', d.task, `间隔 ${d.want} 分钟一致`);
    /* 传输层自启的**形态**（2026-09-21 batch 18）：判据与 sync-status 同一处（install.mjs 的
       detectTransport → transportTaskProblems），不另写第二份。WARN 不进 rc：形态不对 ≠ 今晚这轮
       体检失败，但它是"下次退出就静默停摆"的隐患 —— 本机 2026-09-21 的 44 分钟断链就是这个形态
       （裸 exe 动作 + 只有 AtLogOn、没有保活触发器）。mac 侧载体是 brew services，故只判 Windows。 */
    if (process.platform === 'win32' && mod.detectTransport) {
      const t = mod.detectTransport(INSTANCE, cfg);
      if (t.enabled === false) { /* 按配置未启用：没有任务才是对的，不报 */ }
      else if (!t.installed) add('传输层自启已安装', 'WARN', t.task, t.detail || '任务不存在');
      else if (t.inSync === false) add('传输层任务形态与配置一致', 'WARN', '隐藏运行器 + 保活触发器 + 命令内容与配置一致', t.detail);
      else add('传输层自启已安装', 'PASS', t.task, t.detail || '与配置一致');
    }
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

  /* ---------------------------------------------------------------- 7) 备份层（restic）
   * 只读**状态文件**，不重跑备份（doctor 每 20 分钟跑一次，重跑一次备份等于每轮走 19 万文件）。
   * 阈值全部从 sync/backup/policy.json 派生，不硬编码（本项目的规矩：阈值必须能追溯到配置）。
   * 只在机器**确实声明启用**时才检查 —— 否则没装备份的机器会被每轮判红。 */
  const mcfg = (() => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'machines', `${machine}.json`), 'utf8')); } catch { return null; } })();
  if (mcfg?.backup?.enabled === true) {
    const pol = (() => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'backup', 'policy.json'), 'utf8')); } catch { return {}; } })();
    const bstate = (() => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'state', `backup-${machine}.json`), 'utf8')); } catch { return null; } })();
    const parseTs = (s) => { const m = String(s || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/); return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null; };
    const ageH = (s) => { const t = parseTs(s); return t === null ? null : (Date.now() - t) / 3600000; };
    const ageD = (s) => { const h = ageH(s); return h === null ? null : h / 24; };
    const fresh = ageH(bstate?.lastRunAt);
    add('备份新鲜度', fresh === null ? 'FAIL' : fresh <= 36 ? 'PASS' : 'FAIL', '≤ 36 小时内有成功快照',
      bstate ? `${fresh === null ? '时间戳解析失败' : fresh.toFixed(1) + ' 小时前'}（${bstate.snapshot?.shortId || '无快照'}）` : '没有状态文件（备份任务还没跑过？）');
    if (bstate) {
      add('备份无待处理信号', bstate.attention ? 'FAIL' : 'PASS', 'attention=false',
        bstate.attention ? `需要人看一眼：${(bstate.flags || []).join('、') || '见状态文件'}` : `${(bstate.flags || []).join('、') || '无'}`);
      const cEvery = pol.verify?.checkEveryDays ?? 7, dEvery = pol.verify?.drillEveryDays ?? 30;
      // 演练红线按**已批准方案**写死为 35 天（方案 §6：超过 35 天没跑演练 ⇒ doctor FAIL）；
      // 30–35 天之间只 WARN（还没到方案红线，但该做了）。
      const dFail = pol.verify?.drillFailDays ?? 35;
      const cAge = ageD(bstate.verify?.check?.at), dAge = ageD(bstate.verify?.drill?.at);
      const lvl = (a, every) => (a === null ? 'FAIL' : a <= every ? 'PASS' : a <= every * 2 ? 'WARN' : 'FAIL');
      add('备份数据校验时效', lvl(cAge, cEvery), `≤ ${cEvery} 天跑一次 restic check（超 ${cEvery * 2} 天判红）`,
        cAge === null ? '从未跑过' : `${cAge.toFixed(1)} 天前${bstate.verify?.check?.ok === false ? '（上次失败）' : ''}`);
      add('恢复演练时效', dAge === null ? 'FAIL' : dAge <= dEvery ? 'PASS' : dAge <= dFail ? 'WARN' : 'FAIL',
        `≤ ${dEvery} 天做一次恢复演练（超 ${dFail} 天判红，按方案 §6）`,
        dAge === null ? '从未做过' : `${dAge.toFixed(1)} 天前，上次 ${bstate.verify?.drill ? `${bstate.verify.drill.samples - bstate.verify.drill.failed}/${bstate.verify.drill.samples} 通过` : '无记录'}`);
      const cap = bstate.verify?.capacity?.freePercent;
      if (typeof cap === 'number') add('备份盘余量', cap < (pol.capacity?.diskFreeAlertPercent ?? 20) ? 'FAIL' : 'PASS', `≥ ${pol.capacity?.diskFreeAlertPercent ?? 20}%`, `${cap}%`);
    }
  }

  /* ---------------------------------------------------------------- 8) 传输层（Syncthing）
   * 只调 tools/syncthing-health.mjs（判据的单一源），把它的结论映射成 doctor 的检查项；
   * 同样只在机器声明了自启（transport.autostart=true）时才查，避免给"还没装"的机器每轮判红。 */
  if (mcfg?.transport?.autostart === true) {
    const declared = (mcfg.transport.folders || []).length;
    const r = spawnSync(process.execPath, [join(ENGINE, 'tools', 'syncthing-health.mjs'), '--instance', INSTANCE, '--json', '--no-write'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    let h = null; try { h = JSON.parse(r.stdout || ''); } catch { /* 没输出 */ }
    if (!h) add('传输层可检查', 'FAIL', 'syncthing-health 给出 JSON', `rc=${r.status} ${(r.stderr || '').slice(0, 120)}`);
    else {
      add('传输层 REST 可达', h.reachable ? 'PASS' : 'FAIL', '本机 Syncthing 在跑且能连', h.reachable ? String(h.version || '已连上') : (h.problems || []).join('；') || '连不上');
      add('传输层无问题项', (h.problems || []).length ? 'FAIL' : 'PASS', '0 个问题', (h.problems || []).length ? h.problems.join('；') : '0');
      if (declared && !(h.folders || []).length) add('传输层 folder 已落', 'WARN', `配置声明 ${declared} 个 folder`, 'Syncthing 里 0 个（还没 --provision？未迁到的集合归 µ2 管，属正常）');
      else if (declared) add('传输层 folder 已落', 'PASS', `配置声明 ${declared} 个 folder`, `已落 ${(h.folders || []).length} 个`);
      const unreg = (h.connections || []).length === 0 && (h.knownPeers || []).length === 0;
      if (unreg) add('传输层对端登记', 'WARN', '至少登记一个对端 device ID', 'devices.json 里还没有对端');
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
