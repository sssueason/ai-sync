#!/usr/bin/env node
/**
 * sync-status.mjs — 全队同步状态：本机实况 + 各端状态 + 断言表（托盘/控制台/测试共用一份输出）
 *
 * 三件事：
 *   1. **看**（默认）：出一张 PASS/WARN/FAIL 表，退出码 0=全 PASS、2=有 FAIL（可直接进 CI/巡检）。
 *   2. **喂 UI**（--json）：托盘/控制台只读这一个 JSON（含"待办事项"，即鼠标悬浮要显示的东西）。
 *   3. **写状态**（--write-state）：把本机紧凑状态推到 `sync-state` 分支，让**其他机器**也能看到本机
 *      的最后同步时间与待办（跨端互见）。由 tick 在结尾调用。
 *
 * 设计取舍：
 *   - 所有断言都给出 expected/actual（照 conventions §3：**不能失败的检查不算控制**）。
 *   - 状态推送失败**不算 rc 失败**：状态是派生数据，丢了不丢内容（离线是笔记本的常态），
 *     失败会记进 statePush.ok=false 并由本工具下一轮显示成 WARN —— 有信号，但不误报成"同步坏了"。
 *
 * 用法：
 *   node tools/sync-status.mjs [--instance <dir>] [--json] [--quiet]
 *   node tools/sync-status.mjs --write-state --rc 0 --elapsed 7 [--tick-at "YYYY-MM-DD HH:MM:SS"]
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { readFleet, writeMachine, isGitRepo } from './sync-state.mjs';
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

// 调度现状的"真值"只有一处实现（install.mjs）；这里复用，避免第二份漂移。
// 必须放在常量之后：动态 import 是顶层 await，引用尚未初始化的 const 会 TDZ 报错。
const installPath = [join(HERE, '..', 'install', 'install.mjs'), join(HERE, '..', 'engine', 'install', 'install.mjs')].find((p) => existsSync(p));
const installMod = installPath ? await import(pathToFileURL(installPath).href) : null;
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const WRITE_STATE = has('--write-state');

/* ---------------------------------------------------------------- 基础工具 */

const git = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
  } catch {
    return null;
  }
};
const nowMs = () => Date.now();
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
const parseStamp = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
};
const mins = (ms) => (ms === null ? null : Math.round((nowMs() - ms) / 60000));

function loadInstance() {
  const f = join(INSTANCE, 'sync', 'instance.json');
  const base = {
    tick: { intervalMinutes: 5, jitterSeconds: 45, statePushMinutes: 15 },
    state: { branch: 'sync-state' },
    owners: {},
    adapters: {},
    console: { enabled: true, bind: '127.0.0.1', port: 7788 },
  };
  if (!existsSync(f)) return { cfg: base, file: null };
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return { cfg: { ...base, ...j, tick: { ...base.tick, ...(j.tick || {}) }, state: { ...base.state, ...(j.state || {}) } }, file: f };
  } catch (e) {
    return { cfg: base, file: f, error: e.message };
  }
}
const { cfg, file: cfgFile, error: cfgError } = loadInstance();
const machine =
  process.env.AI_SYNC_MACHINE ||
  process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim() : hostname().toLowerCase());

/* ---------------------------------------------------------------- 本机：仓库 */

function machineCfg() {
  const f = join(INSTANCE, 'sync', 'machines', `${machine}.json`);
  if (!existsSync(f)) return null;
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}
const expand = (p) => (!p ? p : p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

function repoFacts() {
  const mc = machineCfg();
  const out = [];
  for (const r of mc?.mu1 || []) {
    if (!r.repo) continue;
    const path = expand(r.path);
    const rec = { id: r.id, path, exists: existsSync(join(path, '.git')), dirty: null, branch: null, ahead: null, behind: null };
    if (rec.exists) {
      rec.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], path);
      rec.dirty = (git(['status', '--porcelain'], path) || '').split('\n').filter(Boolean).length;
      const ab = git(['rev-list', '--left-right', '--count', `origin/${rec.branch}...HEAD`], path);
      if (ab) {
        const [behind, ahead] = ab.split(/\s+/).map(Number);
        rec.behind = behind;
        rec.ahead = ahead;
      }
    }
    out.push(rec);
  }
  return out;
}

/* ---------------------------------------------------------------- 本机：tick 新鲜度 */

function tickFacts() {
  const dir = join(INSTANCE, 'sync', 'logs');
  if (!existsSync(dir)) return { lastAt: null, rc: null, source: 'none' };
  // Windows: tick-<machine>.log（每轮一行）· macOS: tick-YYYYMMDD.log（按天，取当天/最近一天）
  const cands = [];
  const win = join(dir, `tick-${machine}.log`);
  if (existsSync(win)) cands.push(win);
  try {
    const days = readdirSync(dir)
      .filter((f) => /^tick-\d{8}\.log$/.test(f))
      .sort()
      .map((f) => join(dir, f));
    if (days.length) cands.push(days[days.length - 1]);
  } catch {}
  for (const f of cands) {
    try {
      const lines = readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean);
      const last = lines.reverse().find((l) => /\btick\b/.test(l) && /\d{4}-\d{2}-\d{2}/.test(l));
      if (!last) continue;
      const m = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/.exec(last);
      const rc = /rc=(-?\d+)/.exec(last);
      return { lastAt: m ? m[1] : null, rc: rc ? Number(rc[1]) : null, source: 'log', line: last.trim() };
    } catch {}
  }
  return { lastAt: null, rc: null, source: 'none' };
}

/* ---------------------------------------------------------------- 本机：收敛状态 */

function convergeFacts() {
  const f = join(INSTANCE, 'sync', 'state', `local-${machine}.json`);
  // 2026-09-17 TR6 抓到：全新实例上（还没跑过 converge）此文件不存在，返回的对象**只有 present/file**，
  // 下面任何 conv.actions / conv.failures 都会 TypeError 崩掉——而这是新用户跑的第一条命令。
  // ⇒ 统一补默认值，让"还没跑过"变成一条 WARN 而不是崩溃。
  const emptyConv = { present: false, file: f, at: null, targets: 0, changed: 0, requested: 0, failures: [], skipped: [], actions: [], classify: [], statePush: null };
  if (!existsSync(f)) return emptyConv;
  try {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return {
      present: true,
      file: f,
      at: j.at,
      targets: Object.keys(j.targets || {}).length,
      changed: j.last?.changed?.length ?? 0,
      requested: j.last?.requested?.length ?? 0,
      failures: j.last?.failures || [],
      skipped: j.last?.skipped || [],
      actions: j.last?.actions || [],
      classify: j.last?.classify || [],
      statePush: j.statePush || null,
    };
  } catch (e) {
    return { ...emptyConv, error: e.message };
  }
}

/* ---------------------------------------------------------------- dsh guard */

const httpJson = (method, url, body, timeoutMs = 3000) =>
  new Promise((done, fail) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      fail(e);
      return;
    }
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        timeout: timeoutMs,
        headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {}
          done({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => fail(e));
    if (payload) req.write(payload);
    req.end();
  });

const portListening = (host, port) =>
  new Promise((done) => {
    const s = net.connect({ host, port });
    const fin = (v) => {
      try {
        s.destroy();
      } catch {}
      done(v);
    };
    s.setTimeout(800);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });

async function guardFacts() {
  const ownersDir = join(ENGINE, 'adapters', 'owners');
  const dshFile = join(ownersDir, 'dsh.json');
  if (!existsSync(dshFile)) return { configured: false };
  let dsh;
  try {
    dsh = JSON.parse(readFileSync(dshFile, 'utf8'));
  } catch {
    return { configured: false };
  }
  const sw = cfg.owners?.['dsh'];
  const overrideBase = sw && typeof sw === 'object' ? sw.guardBase : null;
  const base = overrideBase || dsh.reload?.guardBase;
  if (!base) return { configured: false };
  const u = new URL(base);
  try {
    const r = await httpJson('GET', `${base}/restart/status`);
    if (r.status === 200 && r.json) {
      // patch 层必须是 live（否则 MCP/约定改动不会自动生效）—— 用 classify 做**功能性**探测
      const probe = expand('~/.dsh/profiles/web/cordis.patch.yml');
      let patchKind = null;
      try {
        const c = await httpJson('GET', `${base}/restart/classify?path=${encodeURIComponent(probe)}`);
        patchKind = c.json?.kind ?? null;
      } catch {}
      return {
        configured: true,
        reachable: true,
        state: r.json.state,
        pending: (r.json.pending || []).length,
        lastRestart: r.json.lastRestart || null,
        autoRestart: r.json.config?.autoRestart ?? null,
        reloadEngine: r.json.reloadEngine ? { active: r.json.reloadEngine.active, watching: r.json.reloadEngine.watching } : null,
        patchKind,
      };
    }
    return { configured: true, reachable: true, badStatus: r.status };
  } catch (e) {
    const listening = await portListening(u.hostname, Number(u.port || 80));
    return { configured: true, reachable: false, listening, error: e.message };
  }
}

/* ---------------------------------------------------------------- 调度（间隔是否与配置一致） */

function scheduleFacts() {
  if (installMod?.detectSchedule) {
    const d = installMod.detectSchedule(INSTANCE, cfg);
    const mirror = installMod.detectMirror ? installMod.detectMirror(INSTANCE, cfg) : null;
    return { ...d, mirror, want: d.want ?? cfg.tick.intervalMinutes, actualMin: d.unit === 'min' ? d.actual : null, actualSec: d.unit === 'sec' ? d.actual : null };
  }
  return { platform: process.platform, task: '(未找到 install/install.mjs)', installed: false, want: cfg.tick.intervalMinutes, inSync: null, mirror: null, detail: '缺安装器' };
}
/* ---------------------------------------------------------------- 引擎自身版本（更新提示） */

/** 本机正在跑的引擎落后远端多少 —— 落后就提示更新，并把命令写清楚。
 *  为什么值得单列：引擎装在各机器的独立 clone 里，只有人手动 `git pull` 才会前进；
 *  没有这条检查时，"某台机器还在跑两周前的代码"是完全不可见的。 */
function engineFacts() {
  const out = { path: ENGINE, rev: null, branch: null, behind: null, remote: null, detail: '' };
  // 原地布局（引擎就是实例仓）时这条检查没有意义：那个仓的落后已由「仓库 ...」几项覆盖，
  // 而且 tick 每轮自己会拉 ⇒ 在这里再报一次只会闪出"要及时更新"的假警报（2026-09-17 实测）。
  if (resolve(ENGINE) === resolve(INSTANCE)) {
    out.detail = '本机为原地布局（引擎与实例同目录），版本追随由 tick 的仓库拉取负责';
    return out;
  }
  if (!isGitRepo(ENGINE)) {
    out.detail = '引擎目录不是 git 仓，无法比对远端';
    return out;
  }
  out.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], ENGINE) || null;
  out.rev = git(['rev-parse', '--short', 'HEAD'], ENGINE) || null;
  out.remote = git(['remote', 'get-url', 'origin'], ENGINE) || null;
  if (!out.branch || out.branch === 'HEAD') {
    out.detail = '游离 HEAD（不在分支上），无法比对远端';
    return out;
  }
  const ref = `origin/${out.branch}`;
  if (git(['rev-parse', '--verify', '--quiet', ref], ENGINE) === '') {
    out.detail = `本地还没有 ${ref} 引用（clone 未完成？），无法比对`;
    return out;
  }
  /* 远端信息刷新是**节流**的：状态每次 tick（5 分钟）都要算，但没必要每次都打网络
     （2026-09-17 实测：并发 fetch 还会撞 git 的锁，报出一个没意义的"fetch 失败，未比对"）。
     策略 = 到点才 fetch（默认 30 分钟，cfg.engine.fetchMinutes 可调），没到点就**用已有引用比对** ——
     宁可给出"可能略滞后"的落后数，也不要返回"未知"（未知就等于这条检查白设）。 */
  const stampFile = join(INSTANCE, 'sync', 'state', '.engine-fetch-stamp');
  const fetchMinutes = Number(cfg?.engine?.fetchMinutes ?? 30);
  const lastFetch = existsSync(stampFile) ? Number(String(readFileSync(stampFile, 'utf8')).trim()) || 0 : 0;
  const due = Date.now() - lastFetch > fetchMinutes * 60000;
  out.fetched = false;
  if (!has('--no-fetch') && due) {
    try {
      execFileSync('git', ['-C', ENGINE, 'fetch', '-q', 'origin', out.branch], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 60000,
        // 与 tick 的 git 调用同一套：绝不弹交互提示（后台跑，没人看得见 = 隐形挂死）
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      });
      mkdirSync(dirname(stampFile), { recursive: true });
      writeFileSync(stampFile, String(Date.now()), 'utf8');
      out.fetched = true;
    } catch (e) {
      out.fetchError = String(e.message || e).split('\n')[0];
    }
  }
  // 注意方向：`HEAD..origin/<branch>` 才是"远端有、本地没有"= 落后。
  // （2026-09-17 故障注入抓到：写成 `origin/<branch>..HEAD` 数的是领先，落后永远算成 0 ⇒ 假绿。）
  const n = git(['rev-list', '--count', `HEAD..${ref}`], ENGINE);
  out.behind = n === '' ? null : Number(n);
  const ageMin = lastFetch ? Math.round((Date.now() - lastFetch) / 60000) : null;
  const howFresh = out.fetched ? '刚刚刷新' : ageMin === null ? '尚未刷新过' : `${ageMin} 分钟前刷新的远端信息`;
  const head = out.behind === 0 ? `与 ${ref} 一致` : `落后 ${ref} ${out.behind} 个提交`;
  out.detail = `${head}（${howFresh}${out.fetchError ? `；上次刷新失败：${out.fetchError}` : ''}）`;
  return out;
}

/* ---------------------------------------------------------------- 渲染产物对账 */

function artifactFacts() {
  const producers = join(ENGINE, 'adapters', 'producers');
  const out = [];
  if (!existsSync(producers)) return out;
  for (const f of readdirSync(producers).filter((x) => x.endsWith('.json')).sort()) {
    let d;
    try {
      d = JSON.parse(readFileSync(join(producers, f), 'utf8'));
    } catch {
      out.push({ id: f, ok: false, note: 'descriptor 解析失败' });
      continue;
    }
    const cmd = (d.cmd || []).map((x) => String(x).replace('{engine}', ENGINE));
    // 用同一个 producer 命令，把 --targets-json 换成 --audit
    const auditCmd = cmd.map((x) => (x === '--targets-json' ? '--audit' : x));
    if (auditCmd.length === 0) continue;
    const r = spawnSync(auditCmd[0], auditCmd.slice(1), { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, AI_SYNC_INSTANCE: INSTANCE, AI_SYNC_ENGINE: ENGINE } });
    const last = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    const drift = /(\d+) target\(s\) drifted/.exec(last);
    out.push({ id: d.id || f, ok: r.status === 0, rc: r.status, drifted: drift ? Number(drift[1]) : null, line: last });
  }
  return out;
}

/* ---------------------------------------------------------------- 组装 */

const checks = [];
const add = (name, level, expected, actual) => checks.push({ name, level, expected, actual });

const repos = repoFacts();
const tick = tickFacts();
const conv = convergeFacts();
const schedule = scheduleFacts();
const artifacts = artifactFacts();
const guard = await guardFacts();
const fleet = readFleet(INSTANCE, { branch: cfg.state.branch, fetch: !has('--no-fetch') });

const statePushMinutes = cfg.tick.statePushMinutes ?? 15;
const tickStaleMin = (cfg.tick.intervalMinutes ?? 5) * 4;

if (cfgError) add('实例配置可解析', 'FAIL', '合法 JSON', `解析失败：${cfgError}`);
if (repos.length === 0) add('本机仓库已配置', 'FAIL', '≥1 个 git 仓', 'machines/<machine>.json 里没有 mu1 条目');
for (const r of repos) {
  if (!r.exists) add(`仓库 ${r.id} 存在`, 'FAIL', 'git 仓', r.path);
  else {
    if (r.ahead > 0) add(`仓库 ${r.id} 已全部推送`, 'WARN', 'ahead=0', `ahead=${r.ahead}`);
    if (r.behind > 0) add(`仓库 ${r.id} 已拉到最新`, 'WARN', 'behind=0', `behind=${r.behind}`);
  }
}

const tickAge = mins(parseStamp(tick.lastAt));
if (tick.lastAt === null) add('本机 tick 有记录', 'FAIL', '有 tick 日志', '找不到 tick 日志');
else if (tickAge > tickStaleMin) add('本机 tick 新鲜', 'FAIL', `≤ ${tickStaleMin} 分钟`, `${tickAge} 分钟前（rc=${tick.rc}）`);
else add('本机 tick 新鲜', 'PASS', `≤ ${tickStaleMin} 分钟`, `${tickAge} 分钟前（rc=${tick.rc}）`);
if (tick.rc !== null && tick.rc !== 0) add('本机上轮 tick rc=0', 'FAIL', 'rc=0', `rc=${tick.rc}`);

if (!conv.present) add('收敛状态已生成', 'WARN', '有 local-<machine>.json', conv.error || '还没跑过 converge');
else {
  if (conv.failures.length) add('收敛无失败项', 'FAIL', '0 条', conv.failures.join(' | '));
  else add('收敛无失败项', 'PASS', '0 条', `目标 ${conv.targets} 个，本轮变更 ${conv.changed}`);
}

for (const a of artifacts) {
  if (a.drifted === null) add(`渲染对账 ${a.id}`, a.ok ? 'WARN' : 'FAIL', '可解析 drift', a.line || '无输出');
  else if (a.drifted > 0) add(`渲染对账 ${a.id}`, 'FAIL', '0 drift', `${a.drifted} drift`);
  else add(`渲染对账 ${a.id}`, 'PASS', '0 drift', '0');
}

if (guard.configured) {
  if (!guard.reachable) {
    if (guard.listening) add('dsh restart-guard 可达', 'FAIL', 'HTTP 200', `端口在听但请求失败：${guard.error}`);
    else add('dsh restart-guard 可达', 'WARN', 'HTTP 200', 'dsh 未运行（良性：下次启动自然读到新配置）');
  } else if (guard.patchKind && guard.patchKind !== 'hot-patch') {
    add('patch 层为 live', 'FAIL', 'classify=hot-patch', `classify=${guard.patchKind} ⇒ MCP/约定改动不会自动生效`);
  } else {
    add('dsh restart-guard 可达', 'PASS', 'HTTP 200', `state=${guard.state} autoRestart=${guard.autoRestart}`);
    if (guard.patchKind) add('patch 层为 live', 'PASS', 'classify=hot-patch', guard.patchKind);
  }
}

if (!schedule.installed) add('tick 调度已安装', 'FAIL', '有平台任务', `${schedule.task} 不存在`);
else if (schedule.inSync === false) add('tick 间隔与配置一致', 'FAIL', `配置 ${schedule.want} 分钟`, `实际 ${schedule.actualMin ?? schedule.actualSec}${schedule.actualMin ? ' 分钟' : ' 秒'}`);
else add('tick 间隔与配置一致', 'PASS', `配置 ${schedule.want} 分钟`, '一致');

// 镜像调度：这条断言的存在意义就是不让 cloudMirror.schedule 重新变成死旋钮
if (schedule.mirror) {
  const m = schedule.mirror;
  if (m.enabled === false) add('镜像调度按配置关闭', m.installed ? 'FAIL' : 'PASS', 'enabled=false ⇒ 无任务', m.installed ? `${m.task} 仍存在（应卸下）` : '已关闭（无任务）');
  else if (m.skipped || m.inSync === null) add('镜像调度', 'WARN', '该平台应有镜像调度', m.detail || '未实现/未知');
  else if (m.installed && m.inSync === true) add('镜像调度与配置一致', 'PASS', `${m.task} 已按配置注册`, m.detail || '一致');
  else add('镜像调度与配置一致', 'FAIL', `${m.task} 与 cloudMirror.schedule 一致`, m.installed ? m.detail || '时间/模式不一致' : `${m.task} 不存在`);
}

// 引擎更新提示：落后 ⇒ WARN（不是 FAIL —— 旧代码照样能跑，但不能装作没这回事）
const eng = engineFacts();
if (eng.behind === null) add('引擎代码与远端一致', 'INFO', '与远端一致', eng.detail || '未检查');
else if (eng.behind > 0)
  add('引擎代码与远端一致', 'WARN', `与 origin/${eng.branch} 一致`, `落后 ${eng.behind} 个提交（当前 ${eng.rev}）—— 更新：git -C "${eng.path}" pull`);
else add('引擎代码与远端一致', 'PASS', `与 origin/${eng.branch} 一致`, `0 落后（${eng.rev}）`);

if (conv.statePush && conv.statePush.ok === false) add('跨端状态已推送', 'WARN', '推送成功', conv.statePush.error || '上轮推送失败');

const fleetList = [];
for (const [id, s] of Object.entries(fleet.machines)) {
  const age = mins(parseStamp(s.at));
  fleetList.push({ machine: id, at: s.at, ageMin: age, rc: s.tick?.rc ?? null, actions: s.actions || [], intervalMin: s.tick?.intervalMin ?? null, engineRev: s.engineRev ?? null, engineBehind: s.engineBehind ?? null });
  if (age !== null && age > statePushMinutes * 2 && id !== machine) {
    add(`远端 ${id} 状态新鲜`, 'WARN', `≤ ${statePushMinutes * 2} 分钟`, `${age} 分钟前`);
  }
}
if (fleet.note && !JSON_OUT && !QUIET) checks.push({ name: '状态分支', level: 'INFO', expected: cfg.state.branch, actual: fleet.note });

const actions = [
  ...conv.actions.map((a) => ({ source: machine, level: a.level || 'warn', text: a.text })),
  ...fleetList.flatMap((m) => (m.actions || []).map((a) => ({ source: m.machine, level: a.level || 'warn', text: a.text }))),
];
const problems = checks.filter((c) => c.level === 'FAIL').map((c) => c.name);
const warns = checks.filter((c) => c.level === 'WARN').map((c) => c.name);
const state = problems.length ? 'fail' : actions.length || warns.length ? 'warn' : 'ok';

const payload = {
  state,
  at: stamp(),
  machine,
  engine: ENGINE,
  engineRev: eng.rev,
  engineBehind: eng.behind,
  instance: INSTANCE,
  instanceRepo: isGitRepo(INSTANCE),
  lastSyncAt: tick.lastAt,
  lastSyncAgoMin: tickAge,
  intervalMinutes: cfg.tick.intervalMinutes,
  checks,
  problems,
  warnings: warns,
  actions,
  repos,
  machines: fleetList,
  guard,
  converge: conv.present ? { at: conv.at, changed: conv.changed, targets: conv.targets, requested: conv.requested } : null,
  schedule,
};

/* ---------------------------------------------------------------- 写状态（tick 调） */

if (WRITE_STATE) {
  const rc = Number(val('--rc', '0'));
  const elapsed = Number(val('--elapsed', '0'));
  const tickAt = val('--tick-at', tick.lastAt || stamp());
  const compact = {
    machine,
    engine: ENGINE,
    engineRev: eng.rev,
    engineBehind: eng.behind,
    at: payload.at,
    tick: { intervalMin: cfg.tick.intervalMinutes, lastAt: tickAt, rc: Number.isFinite(rc) ? rc : null, elapsedSec: Number.isFinite(elapsed) ? elapsed : null },
    repos: repos.map((r) => ({ id: r.id, ahead: r.ahead, behind: r.behind, dirty: r.dirty })),
    converge: payload.converge ? { at: conv.at, changed: conv.changed, pendingOwners: [...new Set(conv.actions.map((a) => a.owner).filter(Boolean))], guard: guard.reachable ? 'ok' : guard.listening ? 'error' : 'down' } : null,
    actions: conv.actions.map((a) => ({ level: a.level || 'warn', text: a.text, owner: a.owner || null })),
    problems,
  };
  const stampFile = join(INSTANCE, 'sync', 'state', `.last-state-push-${machine}`);
  const prevFile = join(INSTANCE, 'sync', 'state', `.last-state-${machine}.json`);
  let prev = null;
  try {
    prev = JSON.parse(readFileSync(prevFile, 'utf8'));
  } catch {}
  const lastPushMs = existsSync(stampFile) ? statSync(stampFile).mtimeMs : 0;
  const cmp = (o) => JSON.stringify({ ...o, at: null, tick: { ...o.tick, lastAt: null, elapsedSec: null } });
  const same = prev !== null && cmp(prev) === cmp(compact);
  const stale = nowMs() - lastPushMs > statePushMinutes * 60000;
  let push = { ok: true, skipped: true, reason: same && !stale ? '内容未变且未到刷新间隔' : null };
  if (!same || stale) {
    push = writeMachine(INSTANCE, machine, compact, { branch: cfg.state.branch, message: `state: ${machine} ${payload.at}` });
  }
  // 本地状态文件里记下推送结果（下一轮 status 会显示 WARN）
  try {
    const localFile = join(INSTANCE, 'sync', 'state', `local-${machine}.json`);
    const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {};
    local.statePush = { at: payload.at, ok: push.ok !== false, skipped: !!push.skipped, error: push.error || null, branch: cfg.state.branch };
    mkdirSync(dirname(localFile), { recursive: true });
    writeFileSync(localFile, JSON.stringify(local, null, 2) + '\n', 'utf8');
  } catch {}
  if (!JSON_OUT) {
    if (push.skipped) console.log(`   状态：跳过推送（${push.reason}）`);
    else if (push.ok) console.log(`   状态：已推送到 ${cfg.state.branch}（${String(push.commit || '').slice(0, 8)}）`);
    else console.log(`   [WARN] 状态推送失败（离线？）：${push.error}`);
  }
  writeFileSync(prevFile, JSON.stringify(compact, null, 2) + '\n', 'utf8');
  if (push.ok && !push.skipped) writeFileSync(stampFile, '', 'utf8');
}

/* ---------------------------------------------------------------- 输出 */

// --out <file>：把 JSON 写进 UTF-8 文件（供托盘/控制台/其他脚本读）。
// 为什么需要它（2026-09-17 实测）：Windows 上原生命令的输出解码走 [Console]::OutputEncoding，
// 在 `Start-Job` / 无控制台（wscript 拉起）等上下文里会按 GBK 解码 ⇒ 中文路径变乱码、JSON 被破坏
// （`Bad JSON escape sequence`）。**文件读写完全不经过控制台代码页**，是这类问题的根治办法。
const OUT = val('--out');

if (OUT) {
  try {
    writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error(`[FAIL] 写 ${OUT} 失败：${e.message}`);
    process.exitCode = 3;
  }
  if (!QUIET) console.log(`   状态 JSON → ${OUT}`);
} else if (JSON_OUT) {
  console.log(JSON.stringify(payload, null, 2));
} else if (!QUIET) {
  const icon = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL', INFO: 'INFO' };
  console.log(`=== 同步状态 · ${machine} · ${payload.at} · 判定 ${state.toUpperCase()} ===`);
  console.log(`最后同步：${tick.lastAt || '未知'}${tickAge !== null ? `（${tickAge} 分钟前）` : ''}   间隔：${cfg.tick.intervalMinutes} 分钟   实例仓：${payload.instanceRepo ? 'git' : '本地'}`);
  for (const c of checks) console.log(`  [${icon[c.level] || c.level}] ${c.name}  ← 期望 ${c.expected} / 实际 ${c.actual}`);
  if (fleetList.length) {
    console.log('  --- 全队（来自状态分支）---');
    for (const m of fleetList) console.log(`  ${m.machine.padEnd(12)} ${m.at || '?'}  ${m.ageMin === null ? '' : m.ageMin + ' 分钟前'}  rc=${m.rc}  待办=${(m.actions || []).length}`);
  }
  if (actions.length) {
    console.log('  --- 待办（悬浮/菜单要显示的）---');
    for (const a of actions) console.log(`  · [${a.source}] ${a.text}`);
  }
}

process.exitCode = problems.length ? 2 : 0;
