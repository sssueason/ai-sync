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
// 参数解析必须在 ENGINE/INSTANCE 之前（TDZ：这些是 const，后面的代码不能提前引用 —— 本轮真踩了一次）
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
// `--engine` 与 `--instance` 对称（2026-09-19 补）：sync-tick 一直支持 --engine，这里却只认环境变量，
// 结果就是"我以为在测夹具、其实在测真仓"（本轮真踩：A/B 的对照两版都 PASS，因为都在看真仓）。
const ENGINE = resolve(val('--engine') || process.env.AI_SYNC_ENGINE || join(HERE, '..'));
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
const MACHINE_ENV = process.env.AI_SYNC_MACHINE || process.env.DSH_MACHINE || '';
const MACHINE_FILE = existsSync(join(INSTANCE, 'sync', 'local.machine'))
  ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim()
  : '';
const MACHINE_SOURCE = MACHINE_ENV ? 'AI_SYNC_MACHINE / DSH_MACHINE 环境变量' : MACHINE_FILE ? 'sync/local.machine' : '**主机名（回退值，最不可信）**';
const machine = MACHINE_ENV || MACHINE_FILE || hostname().toLowerCase();

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

/* 机器卡缺失 ⇒ **硬失败**（2026-09-19 采纳对端建议）。
 * 原先的行为：machineCfg() 返回 null ⇒ repoFacts() 空 ⇒ 后面**每一条**断言各自 FAIL 一屏。
 * 那不是报错、是**稳定造假红**：每天固定一屏红，人就不再看红了 —— 假红的代价与假绿一样，
 * 都是让告警失去意义。判据很简单：连"我是哪台机器、我有哪些仓库"都不知道，就不可能有可信结论，
 * 所以这里只给**一个明确的失败 + 怎么办**，不再往下算。
 * 退出码 4：与 0（无问题）/ 2（有 FAIL）/ 3（写 --out 失败）区分开，便于脚本/托盘单独识别。 */
(function guardMachineCard() {
  const cardPath = join(INSTANCE, 'sync', 'machines', `${machine}.json`);
  if (existsSync(cardPath)) return;
  const dir = join(INSTANCE, 'sync', 'machines');
  const cards = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
  const isInstance = existsSync(join(INSTANCE, 'sync', 'instance.json')) || cards.length > 0;
  const lines = [
    `[FAIL] 找不到本机机器卡：${cardPath}`,
    `       实例根：${INSTANCE}`,
    `       判定本机为：${machine}（来源：${MACHINE_SOURCE}）`,
  ];
  if (!isInstance) {
    lines.push('       ★ 这个目录看起来**根本不是实例**（既没有 sync/instance.json，也没有 sync/machines/）。');
    lines.push('         请用 `--instance <实例根>` 指定，或设 AI_SYNC_INSTANCE。');
  } else if (cards.length) {
    lines.push(`       这个实例里有这些机器卡：${cards.join(' / ')}。本机该用哪一个？用 DSH_MACHINE 指对（或确认 --instance 指向本机实例）。`);
  } else {
    lines.push('       这个实例里一张机器卡都没有 ⇒ 还没配过（新机上手见 docs/sync-runbook.md）。');
  }
  lines.push('       为什么直接失败而不是继续算：机器卡决定"本机有哪些仓库/路径"，缺了它后面每条断言都会各自亮红 ——');
  lines.push('       一屏稳定假红比一句明确的失败更糟：它会训练人忽略红色。');
  console.error(lines.join('\n'));
  process.exit(4);
})();

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
  const out = { path: ENGINE, rev: null, branch: null, behind: null, remote: null, detail: '', inPlace: false };
  /* 原地布局（引擎就是实例仓）时，真正决定"该更新谁"的是**已安装的引擎**（计划任务/托盘跑的那份）。
     2026-09-17 实测的坑：手动跑实例副本时这句检查只能算"不适用" ⇒ 写出的心跳里 engineRev=null，
     控制台对其他机器的表里本机就一直显示"未上报"。所以这里退回去看 ~/.ai-sync/engine：有就报它的版本，
     没有才如实说"不适用"。规则与 Windows 托盘的 $engineForRun 完全一致（同一套判据，免得两边漂）。 */
  let dir = ENGINE;
  if (resolve(ENGINE) === resolve(INSTANCE)) {
    const sib = join(homedir(), '.ai-sync', 'engine');
    if (existsSync(join(sib, 'tools', 'sync-tick.mjs'))) {
      dir = sib;
      out.path = sib;
      out.inPlace = true;
    } else {
      out.detail = '本机为原地布局（引擎与实例同目录）且没有独立安装的引擎，版本追随由 tick 的仓库拉取负责';
      return out;
    }
  }
  if (!isGitRepo(dir)) {
    out.detail = `引擎目录不是 git 仓（${dir}），无法比对远端`;
    return out;
  }
  out.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], dir) || null;
  out.rev = git(['rev-parse', '--short', 'HEAD'], dir) || null;
  out.remote = git(['remote', 'get-url', 'origin'], dir) || null;
  if (!out.branch || out.branch === 'HEAD') {
    out.detail = '游离 HEAD（不在分支上），无法比对远端';
    return out;
  }
  const ref = `origin/${out.branch}`;
  if (git(['rev-parse', '--verify', '--quiet', ref], dir) === '') {
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
      execFileSync('git', ['-C', dir, 'fetch', '-q', 'origin', out.branch], {
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
  //
  // 2026-09-19（采纳对端洞见）：**方向对了还不够** —— `rev-list HEAD..origin/x` 比的是**本地那份
  // origin/x 引用**，而它只有在 fetch 成功之后才更新。远端不可达 / fetch 静默失败时，这个引用是旧的，
  // 于是 rev-list 照样输出 0 ⇒ 被渲染成"与远端一致（0 落后）"，而真相是"根本没比过"。
  // 判据改成两条**独立**的事实：① 这份远端引用有多新（能不能信）；② 远端此刻可不可达（ls-remote 的 rc/用时）。
  // 不可信就不给落后数，明说"未比对"——**不许把"没比过"渲染成"没落后"**。
  const n = git(['rev-list', '--count', `HEAD..${ref}`], dir);
  const rawBehind = n === '' ? null : Number(n);
  const ageMin = lastFetch ? Math.round((Date.now() - lastFetch) / 60000) : null;
  // 引用可信窗口：刷新节流是 fetchMinutes，取它两倍（且不少于 90 分钟）当"还能信"的上限。
  const trustMinutes = Math.max(fetchMinutes * 2, 90);
  out.freshness = out.fetched ? 'just-fetched'
    : ageMin === null ? 'never'
    : ageMin <= trustMinutes ? `recent(${ageMin}min)`
    : `stale(${ageMin}min)`;
  out.trusted = out.freshness === 'just-fetched' || String(out.freshness).startsWith('recent');
  if (has('--no-fetch')) out.trusted = false;
  // 远端可达性探针（只在"引用不可信"时打一次网络：这是唯一能区分"远端真的不可达"与"只是没到点刷新"的办法）
  out.reachable = null;
  let probeMs = null;
  if (!out.trusted && !has('--no-fetch')) {
    const t0 = Date.now();
    try {
      execFileSync('git', ['-C', dir, 'ls-remote', '--exit-code', 'origin', 'HEAD'], {
        encoding: 'utf8', windowsHide: true, timeout: 25000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      });
      out.reachable = true;
    } catch (e) {
      out.reachable = false;
      out.probeError = String(e.message || e).split('\n')[0];
    }
    probeMs = Date.now() - t0;
    out.probeMs = probeMs;
  }
  if (out.trusted) {
    out.behind = rawBehind;
    const howFresh = out.fetched ? '刚刚刷新' : `${ageMin} 分钟前刷新的远端信息`;
    const head = out.behind === 0 ? `与 ${ref} 一致` : `落后 ${ref} ${out.behind} 个提交`;
    out.detail = `${head}（${howFresh}${out.fetchError ? `；上次刷新失败：${out.fetchError}` : ''}）`;
  } else {
    out.behind = null;
    out.detail = out.reachable === false
      ? `**未比对**：远端不可达（ls-remote 失败，${probeMs} ms；${out.probeError || '无 stderr'}）⇒ 落后多少**不可知**（本地引用 ${out.freshness}）`
      : out.reachable === true
        ? `**未比对**：远端可达但本地引用过旧（${out.freshness}，超过可信窗口 ${trustMinutes} 分钟）⇒ 下一轮刷新后再判`
        : `**未比对**：本轮不联网（--no-fetch），本地引用 ${out.freshness} ⇒ 落后多少不可知`;
  }
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
  if (m.enabled === false) add('夜间任务调度按配置关闭', m.installed ? 'FAIL' : 'PASS', 'enabled=false ⇒ 无任务', m.installed ? `${m.task} 仍存在（应卸下）` : '已关闭（无任务）');
  else if (m.skipped || m.inSync === null) add('夜间任务调度', 'WARN', '该平台应有夜间调度', m.detail || '未实现/未知');
  else if (m.installed && m.inSync === true) add('夜间任务调度与配置一致', 'PASS', `${m.task} 已按配置注册`, m.detail || '一致');
  else add('夜间任务调度与配置一致', 'FAIL', `${m.task} 与 cloudMirror.schedule 一致`, m.installed ? m.detail || '时间/模式不一致' : `${m.task} 不存在`);
}

/* 镜像"真的跑过"（2026-09-18 新增）：调度注册 ≠ 跑过。实测两种误判都会发生 ——
   ① 假红：重新注册会把 LastRunTime 重置成"从未运行"（本次就见到 267011），任务看着从没跑过；
   ② 假绿：任务在、但每晚静默失败时没人会去看那份 transcript。

   2026-09-19 改判据（§6 退役）：原判据"≤36h 内有 tree-sync 报告"在 µ2 退役后**必然假红** ——
   夜间槽改成只跑 doctor、不再写 tree-sync 报告（campus 09-19 预判 09-20 11:26 转红：判据本身失效了）。
   新判据 = **夜间槽自己的产物**：sync/logs/daily-*.log 末尾那条 `=== daily end ... rc=N ===`。
   · 与"槽里跑什么"无关（跑完整 daily 还是只跑 doctor，都写这一行）⇒ 职责再变也不会失效；
   · 直接回答"跑过没有、成没成"，比 tree-sync 报告这个**副产物**更贴近问题本身；
   · 未配置夜间槽（enabled=false 且没给 script）时按"按配置关闭"处理，不给红。 */
{
  const mirrorCfg = cfg.cloudMirror || {};
  const MIRROR_MAX_H = 36;
  const nightlyConfigured = mirrorCfg.enabled !== false || !!mirrorCfg.script;
  const ldir = join(INSTANCE, 'sync', 'logs');
  let newest = null;
  try {
    for (const f of readdirSync(ldir)) {
      if (!/^daily-.*\.log$/.test(f)) continue;
      const st = statSync(join(ldir, f));
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { f, mtimeMs: st.mtimeMs, path: join(ldir, f) };
    }
  } catch {}
  if (!nightlyConfigured) add('夜间任务实际运行', 'PASS', '按配置关闭', 'cloudMirror.enabled=false 且未配置 script ⇒ 无夜间任务');
  else if (!newest) add('夜间任务实际运行', 'WARN', `≤ ${MIRROR_MAX_H} 小时内有 daily 日志`, '本机没有 sync/logs/daily-*.log（首次注册？）');
  else {
    const ageH = (Date.now() - newest.mtimeMs) / 3600000;
    let rc = null;
    try {
      const txt = readFileSync(newest.path, 'utf8');
      const ms = [...txt.matchAll(/^=== daily end .*?rc=(-?\d+) ===$/gm)];
      if (ms.length) rc = Number(ms[ms.length - 1][1]);
    } catch {}
    const detail = `${newest.f}（${ageH.toFixed(1)} 小时前${rc === null ? '' : `，末次 rc=${rc}`}）`;
    if (ageH > MIRROR_MAX_H) add('夜间任务实际运行', 'FAIL', `≤ ${MIRROR_MAX_H} 小时内有 daily 日志`, `${detail} —— 夜间任务可能没在跑：查计划任务/launchd 的 ${mirrorCfg.taskName || 'ai-sync-mirror'}，或手动跑 sync/daily.ps1`);
    else if (rc === null) add('夜间任务实际运行', 'WARN', '末次运行有 rc 记录', `${detail} —— 找不到 '=== daily end ... rc=N ===' 行（旧版脚本？）`);
    else if (rc !== 0) add('夜间任务实际运行', 'FAIL', '末次运行 rc=0', `${detail} —— 失败阶段见该日志的 'failed stages' 行`);
    else add('夜间任务实际运行', 'PASS', `≤ ${MIRROR_MAX_H} 小时内跑过且 rc=0`, detail);
  }
}

/* daily 日志编码自检（2026-09-18）：Start-Transcript 会把汉字逐字写两遍（成因未查明），
   daily.ps1 每轮自检并落状态文件；这里把它**抬到看得见的地方**。不影响同步正确性 ⇒ WARN 而非 FAIL。 */
{
  const f = join(INSTANCE, 'sync', 'logs', '.daily-log-encoding');
  if (!existsSync(f)) add('daily 日志编码自检', 'WARN', 'ok', '尚无自检结果（daily 还没跑过新版本）');
  else {
    const v = readFileSync(f, 'utf8').trim();
    if (v === 'ok') add('daily 日志编码自检', 'PASS', 'ok', '汉字未双写');
    else add('daily 日志编码自检', 'WARN', 'ok', `自检=${v}（daily 日志汉字被逐字写两遍，见 sync/logs/daily-*.log 末尾判决行）`);
  }
}
/* 文本卫生门禁（2026-09-18）：tick 每轮跑 tools/sync-hygiene.mjs 并落 sync/state/hygiene-<machine>.json；
   这里把它抬到看得见的地方。分级依据"是否会真的坏"：BOM 缺失/EOL 索引违规/冲突标记/机器本地文件被提交
   ⇒ FAIL（到 5.1、到 bash、或到别的机器上必然出问题）；门禁本身跑不起来 ⇒ FAIL（不能假装通过）；
   只是没跑过 ⇒ WARN。 */
{
  const f = join(INSTANCE, 'sync', 'state', `hygiene-${machine}.json`);
  if (!existsSync(f)) add('文本卫生门禁', 'WARN', '有 hygiene-<machine>.json', '还没跑过（下一轮 tick 生成）');
  else {
    let h = null;
    try { h = JSON.parse(readFileSync(f, 'utf8')); } catch { h = null; }
    if (!h) add('文本卫生门禁', 'FAIL', '可解析状态文件', `解析失败：${f}`);
    else if (h.broken) add('文本卫生门禁', 'FAIL', '门禁可运行', '门禁未返回结果（工具在但拿不到输出）');
    else if (h.missing) add('文本卫生门禁', 'FAIL', '门禁可运行', '缺少 tools/sync-hygiene.mjs（本轮未检查）');
    else if (h.fails > 0) {
      const top = (h.top || []).slice(0, 2).map((x) => `${x.rule} ${x.repo}/${x.rel}`).join(' | ');
      add('文本卫生门禁', 'FAIL', 'FAIL=0', `${h.fails} 条 FAIL：${top}（明细 ${f}）`);
    } else add('文本卫生门禁', 'PASS', 'FAIL=0', `WARN=${h.warns}（${h.at}）`);
  }
}
/* 一次性迁移（2026-09-18）：tick 每轮跑引擎的 tools/sync-migrate.mjs（只跑 danger=safe 的），
   结果落 sync/state/migrations-<machine>.json。这里分级：
   有 safe 迁移失败/熔断 ⇒ FAIL（这台机器没跟上，且已经连续失败，需要人看）；
   只有 manual-only 待人工 ⇒ WARN（脚本按纪律不代劳，但要让你看得见）；
   状态文件都没有 ⇒ WARN（还没跑过）；全绿 ⇒ PASS。 */
{
  const f = join(INSTANCE, 'sync', 'state', `migrations-${machine}.json`);
  if (!existsSync(f)) add('一次性迁移', 'WARN', '有 migrations-<machine>.json', '还没跑过（下一轮 tick 生成）');
  else {
    let m = null;
    try { m = JSON.parse(readFileSync(f, 'utf8')); } catch { m = null; }
    if (!m) add('一次性迁移', 'FAIL', '可解析状态文件', `解析失败：${f}`);
    else {
      const applied = Object.entries(m.applied || {}).filter(([, v]) => v && v.ok).map(([k]) => k);
      const blocked = Object.entries(m.blocked || {});
      const manual = (m.pendingManual || []).filter((p) => !p.done);
      if (blocked.length) add('一次性迁移', 'FAIL', '无失败/熔断', `${blocked.length} 条熔断：${blocked.map(([k, v]) => `${k}(×${v.tries})`).join(' | ')}`);
      else if (manual.length) add('一次性迁移', 'WARN', '待人工 0 条', `${manual.length} 条待人工：${manual.map((p) => p.id).join(' | ')}（命令见 sync/migrations/README.md）`);
      else add('一次性迁移', 'PASS', '无待人工', `已生效 ${applied.length} 条（${m.at || ''}）`);
    }
  }
}
/* 应用一致性（2026-09-18）：tick 每轮跑引擎的 tools/sync-apply.mjs（幂等应用：调度对账、需要重编的产物），
   结果落 sync/state/apply-<machine>.json。分级：有 unit 熔断/失败 ⇒ FAIL（这台机器没跟上）；
   全绿 ⇒ PASS（并报出发起时"当前是否真的生效"的 verify 结论数量）。 */
{
  const f = join(INSTANCE, 'sync', 'state', `apply-${machine}.json`);
  if (!existsSync(f)) add('应用一致性', 'WARN', '有 apply-<machine>.json', '还没跑过（下一轮 tick 生成）');
  else {
    let a = null;
    try { a = JSON.parse(readFileSync(f, 'utf8')); } catch { a = null; }
    if (!a) add('应用一致性', 'FAIL', '可解析状态文件', `解析失败：${f}`);
    else {
      const units = Object.entries(a.units || {});
      const okUnits = units.filter(([, v]) => v && v.ok).map(([k]) => k);
      const badUnits = units.filter(([, v]) => v && v.ok === false).map(([k]) => k);
      const blocked = Object.entries(a.blocked || {});
      if (blocked.length) add('应用一致性', 'FAIL', '无熔断', `${blocked.length} 条熔断：${blocked.map(([k, v]) => `${k}(×${v.tries})`).join(' | ')}`);
      else if (badUnits.length) add('应用一致性', 'FAIL', '全部 unit 已生效', `${badUnits.join(' | ')}`);
      else add('应用一致性', 'PASS', '全部 unit 已生效', `${okUnits.length} 条生效（${okUnits.join(', ') || '无 unit'}）`);
    }
  }
}
/* 诊断包（2026-09-18）：条件命中时（卫生/迁移/应用有失败）tick 会生成一份自包含诊断包到 sync/reports/。
   这里只做一件事：**当前是否还有未处理的问题、有没有对应的档案可看**。
   条件已清 ⇒ PASS（不长期挂黄）；条件在、包也在 ⇒ WARN 指路；条件在、包还没生成 ⇒ WARN。 */
{
  const rd = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } };
  const hyg = rd(join(INSTANCE, 'sync', 'state', `hygiene-${machine}.json`));
  const mig = rd(join(INSTANCE, 'sync', 'state', `migrations-${machine}.json`));
  const app = rd(join(INSTANCE, 'sync', 'state', `apply-${machine}.json`));
  const sig = rd(join(INSTANCE, 'sync', 'state', `ops-bundle-${machine}.json`));
  const cond = [];
  if (hyg && hyg.fails > 0) cond.push(`卫生 FAIL=${hyg.fails}`);
  if (mig && Object.keys(mig.blocked || {}).length) cond.push(`迁移熔断 ${Object.keys(mig.blocked).length}`);
  if (app && Object.keys(app.blocked || {}).length) cond.push(`应用熔断 ${Object.keys(app.blocked).length}`);
  if (app && Object.values(app.units || {}).some((u) => u && u.ok === false)) cond.push('应用未生效');
  if (!cond.length) add('诊断包', 'PASS', '无待看诊断包', '当前无触发条件（卫生/迁移/应用均正常）');
  else if (sig && sig.out) add('诊断包', 'WARN', '有档案可看', `${cond.join(' · ')} ⇒ sync/reports/${sig.out}`);
  else add('诊断包', 'WARN', '有档案可看', `${cond.join(' · ')} ⇒ 尚未生成（下一轮 tick 会生成，或手动跑 tools/sync-ops-bundle.mjs --force）`);
}
/* 免费模型只读分诊（2026-09-18）：条件命中时 tick 会把诊断包的事实交给免费模型，得到"类别 + 建议 id"。
   它是**建议**，所以只在"条件仍在 且 有新鲜判定"时显示成 WARN（那才可行动）；条件已清 ⇒ PASS（不长期挂黄）；
   配置里关掉 ⇒ 直接 PASS 并说明未启用。 */
{
  const rd = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } };
  const enabled = (() => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'instance.json'), 'utf8')).triage?.enabled !== false } catch { return true } })();
  const t = rd(join(INSTANCE, 'sync', 'state', `triage-${machine}.json`));
  if (!enabled) add('免费模型分诊', 'PASS', '按配置关闭', 'sync/instance.json 的 triage.enabled=false');
  else {
    const hyg = rd(join(INSTANCE, 'sync', 'state', `hygiene-${machine}.json`));
    const mig = rd(join(INSTANCE, 'sync', 'state', `migrations-${machine}.json`));
    const app = rd(join(INSTANCE, 'sync', 'state', `apply-${machine}.json`));
    const cond = [];
    if (hyg && hyg.fails > 0) cond.push(`卫生 FAIL=${hyg.fails}`);
    if (mig && Object.keys(mig.blocked || {}).length) cond.push('迁移熔断');
    if (app && (Object.keys(app.blocked || {}).length || Object.values(app.units || {}).some((u) => u && u.ok === false))) cond.push('应用未生效');
    if (!cond.length) add('免费模型分诊', 'PASS', '无待处理判定', t && t.verdict ? `上次判定 ${t.verdict.class}（条件已清）` : '无触发条件时不调用');
    else if (t && t.verdict) add('免费模型分诊', 'WARN', '有建议可看', `${t.verdict.class} → ${t.verdict.remedy}（置信 ${t.verdict.confidence}）${t.verdict.human_reason || ''} · ${t.at}`);
    else if (t && t.ok === false) add('免费模型分诊', 'WARN', '有建议可看', `未得到判定（${t.why || t.parse || '未知'}）${t.lastGood ? `；上次判定 ${t.lastGood.class} → ${t.lastGood.remedy}` : ''} —— 基线行为不变，看诊断包`);
    else add('免费模型分诊', 'WARN', '有建议可看', `${cond.join(' · ')} ⇒ 尚未分诊（下一轮 tick 会做，或手动 tools/sync-triage.mjs --force）`);
  }
}
// 引擎更新提示：落后 ⇒ WARN（不是 FAIL —— 旧代码照样能跑，但不能装作没这回事）
const eng = engineFacts();
const inPlaceNote = eng.inPlace ? '（本机为原地布局：这里报的是已安装引擎的版本）' : '';
if (eng.trusted && eng.behind === null) add('引擎代码与远端一致', 'INFO', '与远端一致', (eng.detail || '未检查') + inPlaceNote);
else if (eng.trusted && eng.behind > 0)
  add('引擎代码与远端一致', 'WARN', `与 origin/${eng.branch} 一致`, `落后 ${eng.behind} 个提交（当前 ${eng.rev}）—— 更新：git -C "${eng.path}" pull${inPlaceNote}`);
else if (eng.trusted) add('引擎代码与远端一致', 'PASS', `与 origin/${eng.branch} 一致`, `0 落后（${eng.rev}）${inPlaceNote}`);
else {
  /* 未比对（2026-09-19 修假绿）：以前这种情形会走进 `behind===0` 的 PASS 分支 —— 因为比的是**本地那份
     过旧的 origin 引用**。远端不可达时它照样输出 0，于是"根本没比过"被渲染成"和远端一致"。
     现在：远端不可达 = 需要人处理（FAIL）；引用过旧 / 不联网但引擎正常 = 下一轮自愈（WARN）；
     其余（游离 HEAD、没有远端引用等）= INFO 说明原因。**任何分支都不许出现"0 落后"。** */
  const lvl = eng.reachable === false ? 'FAIL' : eng.rev ? 'WARN' : 'INFO';
  add('引擎代码与远端一致', lvl, '与 origin/' + (eng.branch || 'x') + ' 一致，或明确“未比对”', (eng.detail || '未检查') + inPlaceNote);
}

if (conv.statePush && conv.statePush.ok === false) add('跨端状态已推送', 'WARN', '推送成功', conv.statePush.error || '上轮推送失败');

const fleetList = [];
for (const [id, s] of Object.entries(fleet.machines)) {
  const age = mins(parseStamp(s.at));
  fleetList.push({ machine: id, at: s.at, ageMin: age, rc: s.tick?.rc ?? null, actions: s.actions || [], intervalMin: s.tick?.intervalMin ?? null, engineRev: s.engineRev ?? null, engineBehind: s.engineBehind ?? null, engineCompared: s.engineCompared ?? null, ops: s.ops ?? null });
  if (age !== null && age > statePushMinutes * 2 && id !== machine) {
    add(`远端 ${id} 状态新鲜`, 'WARN', `≤ ${statePushMinutes * 2} 分钟`, `${age} 分钟前`);
  }
}
if (fleet.note && !JSON_OUT && !QUIET) checks.push({ name: '状态分支', level: 'INFO', expected: cfg.state.branch, actual: fleet.note });

/* ---- 备份层与传输层（P7 观测）----
 * 数据来自 tools/backup-run.mjs 与 tools/syncthing-health.mjs 写的**状态文件**；此处只做展示，
 * 判据一律**引用它们已给出的结论**（例如 audit.tripped），不在这里重算一遍 —— 否则又是两套判据。 */
const tCfg = (() => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'machines', `${machine}.json`), 'utf8')); } catch { return null; } })();
const ageMinOf = (s) => { const t = parseStamp(s); return t === null ? null : mins(t); };
let backup = null, transport = null;

if (tCfg?.backup?.enabled === true) {
  const bs = (() => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'state', `backup-${machine}.json`), 'utf8')); } catch { return null; } })();
  if (!bs) add('备份已跑过', 'FAIL', `有 backup-${machine}.json`, '没有状态文件（备份任务还没跑过？）');
  else {
    const ageMin = ageMinOf(bs.lastRunAt);
    backup = {
      at: bs.lastRunAt, snapshot: bs.snapshot?.shortId || null, ageMin, ok: bs.ok !== false,
      attention: !!bs.attention, flags: bs.flags || [], scopeFiles: bs.scope?.files ?? null,
      scopeBytes: bs.scope?.bytes ?? null, removed: bs.removed || null, added: bs.added || null,
      unreadable: (bs.unreadable || []).length, verify: bs.verify || null,
      capacity: bs.verify?.capacity || bs.capacity || null
    };
    add('备份新鲜度', ageMin === null ? 'FAIL' : ageMin <= 36 * 60 ? 'PASS' : 'FAIL', '≤ 36 小时',
      ageMin === null ? '时间戳异常' : `${(ageMin / 60).toFixed(1)} 小时前（${backup.snapshot || '无快照'}）`);
    if (backup.attention) add('备份待处理信号', 'FAIL', 'attention=false', (backup.flags || []).join('、') || '见状态文件');
    if (backup.unreadable) add('备份读不到的文件', 'WARN', '0 个', `${backup.unreadable} 个（清单变化才升级，见 backup-restic.md §6）`);
    if (backup.removed) {
      add('误删审计', bs.audit?.tripped ? 'FAIL' : 'PASS', `≤ ${bs.audit?.thresholds?.files ?? 20} 个 · ≤ ${Math.round((bs.audit?.thresholds?.bytes ?? 209715200) / 1048576)} MB`,
        `上次比对：删除 ${backup.removed.files} 个 / ${(backup.removed.bytes / 1048576).toFixed(1)} MB，新增 ${backup.added?.files ?? 0} 个`);
    }
    const d = backup.verify?.drill, c = backup.verify?.check;
    if (c) add('备份数据校验', c.ok ? 'PASS' : 'FAIL', 'restic check 通过', c.ok ? `OK（抽样 ${c.subset}，${c.durationSec}s）` : `上次失败：${c.detail || ''}`);
    if (d) add('恢复演练', d.failed ? 'FAIL' : 'PASS', '样本全部恢复且哈希一致', `${d.samples - d.failed}/${d.samples} 通过（${d.at || '?'}）`);
    if (backup.capacity?.freePercent != null) add('备份盘余量', backup.capacity.freePercent < 20 ? 'FAIL' : 'PASS', '≥ 20%', `${backup.capacity.freePercent}%`);
  }
}

if (tCfg?.transport?.autostart === true || (tCfg?.transport?.folders || []).length) {
  const tstate = (() => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'state', `transport-${machine}.json`), 'utf8')); } catch { return null; } })();
  const h = tstate?.health || null;
  if (!h) add('传输层健康快照', 'WARN', `有 transport-${machine}.json 的 health 段`, '没有快照 —— 跑一次 node tools/syncthing-health.mjs');
  else {
    const ageMin = ageMinOf(h.at);
    transport = {
      at: h.at, ageMin, reachable: !!h.reachable, version: h.version || null,
      folders: (h.folders || []).map((f) => ({ id: f.id, state: f.state, paused: f.paused, needFiles: f.needFiles, localFiles: f.localFiles, globalFiles: f.globalFiles, versioning: f.versioning, peersDone: f.peersDone || [] })),
      connections: (h.connections || []).map((c) => ({ machine: c.machine, connected: c.connected, viaRelay: c.viaRelay, type: c.type, tolerated: c.tolerated })),
      problems: h.problems || [], foldersDeclared: (tCfg.transport.folders || []).length
    };
    add('传输层健康快照', ageMin !== null && ageMin <= statePushMinutes * 2 ? 'PASS' : 'WARN', `≤ ${statePushMinutes * 2} 分钟`,
      ageMin === null ? '时间戳异常' : `${ageMin} 分钟前`);
    add('传输层 REST 可达', h.reachable ? 'PASS' : 'FAIL', '本机 Syncthing 在跑且能连', h.reachable ? String(h.version || '已连上') : (h.problems || []).join('；'));
    add('传输层无问题项', (h.problems || []).length ? 'FAIL' : 'PASS', '0 个', (h.problems || []).length ? h.problems.join('；') : '0');
    if (transport.connections.length) {
      add('传输层对端连接', transport.connections.some((c) => c.connected) ? 'PASS' : 'WARN', '至少一个对端连上',
        transport.connections.map((c) => `${c.machine}:${c.connected ? (c.viaRelay ? '中继' : '直连') : '未连'}`).join(' '));
    }
    add('传输层 folder 已落', transport.folders.length === 0 && transport.foldersDeclared > 0 ? 'WARN' : 'PASS',
      `配置声明 ${transport.foldersDeclared} 个`, `Syncthing 里 ${transport.folders.length} 个（未迁到的集合归 µ2 管，属正常）`);
    /* 同步冲突副本（2026-09-19 补）：Syncthing 遇到"两端同时改同一文件"时**故意保留两版**
       （`<原名>.sync-conflict-<日期>-<id>.<扩展>`），系统**不替人判断内容谁对**。
       此前工具链里**零引用** ⇒ 没有任何东西会告诉你它们存在 —— 属于"要你眼尖"的盲区
       （实测：本机曾有 12 个躺了整天没人知道，其中 4 个 PDF 是真的内容不同）。
       代价控制：只 `readdir` 看文件名（不 stat 内容），跳过 `.stversions` 等目录，并有文件数上限；
       路径直接用 **Syncthing 自己报的 folder 路径**（避免 `~` 展开等第二套实现）。 */
    {
      const SKIP = new Set(['.stversions', '.git', 'node_modules', '$RECYCLE.BIN', 'System Volume Information']);
      const re = /\.sync-conflict-\d{8}-\d{6}-[A-Z0-9]+\./i;
      const found = [];
      let scanned = 0, capped = false;
      const walk = (dir, depth) => {
        if (capped || depth > 12) return;
        let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (found.length >= 200 || scanned > 300000) { capped = true; return; }
          if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(join(dir, e.name), depth + 1); continue; }
          scanned++;
          if (re.test(e.name)) found.push(`${dir}${process.platform === 'win32' ? '\\' : '/'}${e.name}`);
        }
      };
      for (const f of (h.folders || [])) if (f.path) walk(resolve(f.path), 0);
      if (transport) transport.conflictCopies = found;
      add('同步冲突副本', found.length ? 'WARN' : 'PASS', '0 个（有则需要人裁决留哪版）',
        found.length
          ? `${found.length} 个待裁决${capped ? '（已截断）' : ''}（扫 ${scanned} 个文件）：` + found.slice(0, 3).map((p) => p.split(/[\\/]/).pop()).join('、')
          : `0 个（扫 ${scanned} 个文件）`);
    }
    /* 每 folder 一行 —— **只报不健康的那些**（A9 要"一屏看到每 folder 状态"，但 14 个健康的行会把表淹掉：
     * 健康的用上面的汇总行代表，异常的才单独列出，这是"信号 vs 噪音"的取舍）。 */
    for (const f of transport.folders) {
      const bad = f.paused || (f.state && f.state !== 'idle') || (f.needFiles ?? 0) > 0 || (f.versioning && f.versioning !== 'staggered');
      if (!bad) continue;
      const why = [
        f.paused ? '已暂停' : null,
        f.state && f.state !== 'idle' ? `state=${f.state}` : null,
        (f.needFiles ?? 0) > 0 ? `待同步 ${f.needFiles} 个` : null,
        f.versioning && f.versioning !== 'staggered' ? `版本化=${f.versioning}（应为 staggered，误删防线 L1 缺失）` : null
      ].filter(Boolean).join(' · ');
      add(`传输层 folder ${f.id}`, f.versioning && f.versioning !== 'staggered' ? 'FAIL' : 'WARN',
        'idle · 待同步 0 · staggered', `${why}（本地 ${f.localFiles ?? '?'} / 全局 ${f.globalFiles ?? '?'}；对端 ${(f.peersDone || []).map((p) => `${p.machine}=${p.completion}%`).join(' ') || '无' }）`);
    }
  }
}

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
  // 2026-09-19：`engineBehind` 为 null 时，消费方必须知道是"没比过"而不是"没落后"。
  // compared=false ⇒ behind 不可信（远端不可达 / 本地引用过旧 / 本轮不联网）；freshness 说明原因。
  engineCompared: !!eng.trusted,
  engineFreshness: eng.freshness ?? null,
  engineReachable: eng.reachable ?? null,
  instance: INSTANCE,
  instanceRepo: isGitRepo(INSTANCE),
  lastSyncAt: tick.lastAt,
  lastSyncAgoMin: tickAge,
  intervalMinutes: cfg.tick.intervalMinutes,
  checks,
  backup,
  transport,
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
  // 应用一致性（2026-09-18）：把三件"应用层"的事实一并跨机广播，别的机器才能一眼看出"谁没跟上"。
  // 缺文件 ⇒ 该项为 null（对端渲染成 `-`）；**不要**把"没跑过"渲染成 0 或 FAIL（那是假红）。
  const rdState = (n) => { try { return JSON.parse(readFileSync(join(INSTANCE, 'sync', 'state', n), 'utf8')); } catch { return null; } };
  const hygS = rdState(`hygiene-${machine}.json`);
  const migS = rdState(`migrations-${machine}.json`);
  const appS = rdState(`apply-${machine}.json`);
  const bunS = rdState(`ops-bundle-${machine}.json`);
  const ops = {
    hygiene: hygS ? { fails: hygS.fails ?? null, warns: hygS.warns ?? null, at: hygS.at ?? null } : null,
    migrations: migS ? {
      applied: Object.keys(migS.applied || {}).filter((k) => migS.applied[k] && migS.applied[k].ok).length,
      pendingManual: (migS.pendingManual || []).filter((p) => !p.done).length,
      blocked: Object.keys(migS.blocked || {}).length,
    } : null,
    apply: appS ? {
      ok: Object.values(appS.units || {}).filter((u) => u && u.ok).length,
      bad: Object.values(appS.units || {}).filter((u) => u && u.ok === false).length,
      blocked: Object.keys(appS.blocked || {}).length,
    } : null,
    bundle: bunS && bunS.out ? bunS.out : null,
  };
  const compact = {
    machine,
    engine: ENGINE,
    engineRev: eng.rev,
    engineBehind: eng.behind,
    // 对端要能区分"落后 0"与"没比过"（2026-09-19 修假绿）：把可比性一起推上去，否则对端只能看到 null 并自己猜。
    engineCompared: !!eng.trusted,
    engineFreshness: eng.freshness ?? null,
    at: payload.at,
    tick: { intervalMin: cfg.tick.intervalMinutes, lastAt: tickAt, rc: Number.isFinite(rc) ? rc : null, elapsedSec: Number.isFinite(elapsed) ? elapsed : null },
    repos: repos.map((r) => ({ id: r.id, ahead: r.ahead, behind: r.behind, dirty: r.dirty })),
    converge: payload.converge ? { at: conv.at, changed: conv.changed, pendingOwners: [...new Set(conv.actions.map((a) => a.owner).filter(Boolean))], guard: guard.reachable ? 'ok' : guard.listening ? 'error' : 'down' } : null,
    actions: conv.actions.map((a) => ({ level: a.level || 'warn', text: a.text, owner: a.owner || null })),
    ops,
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
    // 应用一致性视图（2026-09-18）：每端报出 引擎rev / 卫生 / 迁移 / 应用 四项。
    // 对端还没升级到带 ops 的版本时显示 `-`（跨版本容忍：字段缺失不是错误，别把它渲染成 0 或 FAIL）。
    for (const m of fleetList) {
      const o = m.ops || null;
      const tok = []
      // 对端报 (-0) = 真的与远端一致；(-?) = 它明确说了"没比过"（远端不可达/引用过旧）—— 不许把后者显示成 0。
      tok.push(`引擎=${m.engineRev ? String(m.engineRev).slice(0, 7) : '-'}${Number.isFinite(m.engineBehind) ? `(-${m.engineBehind})` : m.engineCompared === false ? '(-?)' : ''}`)
      tok.push(`卫生=${o && o.hygiene ? (o.hygiene.fails ? `FAIL${o.hygiene.fails}` : `ok(${o.hygiene.warns ?? 0}W)`) : '-'}`)
      tok.push(`迁移=${o && o.migrations ? (o.migrations.blocked ? `FAIL${o.migrations.blocked}` : `${o.migrations.applied}条${o.migrations.pendingManual ? `/${o.migrations.pendingManual}待人工` : ''}`) : '-'}`)
      tok.push(`应用=${o && o.apply ? (o.apply.blocked || o.apply.bad ? `FAIL${(o.apply.blocked || 0) + (o.apply.bad || 0)}` : `ok(${o.apply.ok})`) : '-'}`)
      console.log(`  ${m.machine.padEnd(12)} ${m.at || '?'}  ${m.ageMin === null ? '' : m.ageMin + ' 分钟前'}  rc=${m.rc}  待办=${(m.actions || []).length}  ${tok.join('  ')}`);
    }
  }
  if (actions.length) {
    console.log('  --- 待办（悬浮/菜单要显示的）---');
    for (const a of actions) console.log(`  · [${a.source}] ${a.text}`);
  }
}

process.exitCode = problems.length ? 2 : 0;
