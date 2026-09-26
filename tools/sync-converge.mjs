#!/usr/bin/env node
/**
 * sync-converge.mjs — 收敛：**哪份 live 配置变了 → 谁该重载/重启**
 *
 * 为什么需要它（2026-09-17）：渲染链已经把「单源 → 各端 live 配置」自动化了，但没有一步把
 * "这些文件变了"翻译成"哪个应用要重载"。实测：`cordis.patch.yml`（MCP 配置）由 dsh 的 HMR 直接热重载、
 * `AGENTS.md` 由 agent-instructions 逐请求 reconcile —— **都不需要重启**；而插件集合
 * （`profiles/<p>/package.json`）在 boot 时解析，**必须重启**，却没有任何东西会通知应用
 * （当年 dsh 侧的 restart-guard 只 watch `pnpm-lock.yaml` 与 patch 文件）⇒ 这是唯一真正缺的自动触发点。
 * ⚠️ 2026-09-26（dsh 依赖撤除·第二步）：dsh 已转桌面端，`adapters/owners/dsh.json` 随之撤除 ⇒
 *    本工具不再替 dsh 登记重启；上面这段保留作**设计动机**（http 模式仍在，任何应用都能用 owner 卡接上）。
 *
 * 设计（不重造轮子）：
 *   - 目标清单来自**渲染器自己**（`--targets-json`），不在本文件里再抄一份路径表；
 *   - "要不要重启"由**应用自己**回答：声明 `http` 模式的 owner 走它的 `GET /restart/classify`（权威判据），
 *     交互式应用走 `manual`（只通知，绝不杀用户会话）；
 *   - 本文件只做：变更检测（内容 sha256）→ 分类 → 登记/通知 → 落状态。
 *
 * 用法：
 *   node tools/sync-converge.mjs                 # 正常收敛（写状态；需要时登记重启）
 *   node tools/sync-converge.mjs --dry-run       # 只报告，不写状态、不发请求
 *   node tools/sync-converge.mjs --json          # 机器可读（托盘/控制台/测试用）
 *   node tools/sync-converge.mjs --force         # 登记时带 force（guard 语义：当前回合结束后立即重启）
 *   node tools/sync-converge.mjs --apply-commands # 允许执行 owner 声明的 command 模式重载命令
 *   node tools/sync-converge.mjs --instance <dir> # 指定实例根（默认 $AI_SYNC_INSTANCE → 引擎根）
 *
 * 退出码：0 = 无事 / 已登记；3 = 真问题（producer 跑不起来、guard 在监听但不可用、变更无法分类）。
 * 退出码 3 是刻意的（conventions §3「假绿防线」）：**跳过与降级必须带 rc 信号**。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';

/* ---------------------------------------------------------------- 参数与环境 */

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};

const DRY = has('--dry-run');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const FORCE = has('--force');
const APPLY_COMMANDS = has('--apply-commands');
const HTTP_TIMEOUT_MS = Number(val('--http-timeout', '3000'));
const PRODUCER_TIMEOUT_MS = Number(val('--producer-timeout', '30000'));

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(val('--engine') || join(HERE, '..'));            // 引擎根（现在=本仓根；抽仓后=~/.ai-sync/engine@<tag>）
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);

const failures = [];      // 真问题 → 非零退出
const skipped = [];       // 良性跳过（记录，但不算失败）
const classify = [];      // 每个变更目标的分类结果
const requested = [];     // 已登记的（或 dry-run 下将登记的）重启
const actions = [];       // 需要人做的事（通知/托盘/控制台显示）
const note = (...m) => { if (!QUIET && !JSON_OUT) console.log('   ' + m.join(' ')); };

/* ---------------------------------------------------------------- 机器标识（与 sync/_load.ps1 同源） */

function machineId() {
  if (process.env.AI_SYNC_MACHINE) return process.env.AI_SYNC_MACHINE;
  if (process.env.DSH_MACHINE) return process.env.DSH_MACHINE;
  const lm = join(INSTANCE, 'sync', 'local.machine');
  if (existsSync(lm)) return readFileSync(lm, 'utf8').trim();
  return hostname().toLowerCase();
}
const MACHINE = machineId();

/* ---------------------------------------------------------------- 实例配置 */

const DEFAULTS = {
  tick: { intervalMinutes: 5, jitterSeconds: 45, statePushMinutes: 15 },
  console: { enabled: true, bind: '127.0.0.1', port: 7788, autostart: true },
  producers: {},
  owners: {},
  cloudMirror: { enabled: false, schedule: { mode: 'dailyAt', times: ['22:00'] } },
  auth: { mode: 'auto' },
};

const cfgFile = join(INSTANCE, 'sync', 'instance.json');
let cfg = DEFAULTS;
if (existsSync(cfgFile)) {
  try {
    cfg = { ...DEFAULTS, ...JSON.parse(readFileSync(cfgFile, 'utf8')) };
  } catch (e) {
    failures.push(`实例配置解析失败 ${cfgFile}: ${e.message}`);
  }
} else {
  skipped.push(`instance-json-absent(${cfgFile}) → 用内置默认`);
}

/** owner/producer 的开关：支持 `true|false|{enabled,guardBase,...}` 三种写法 */
const normSwitch = (v) => (v === false ? { enabled: false } : v === true || v === undefined ? { enabled: true } : { enabled: v.enabled !== false, ...v });

/* ---------------------------------------------------------------- 载入 descriptor */

function loadDescriptors(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      out.push({ _file: join(dir, f), ...JSON.parse(readFileSync(join(dir, f), 'utf8')) });
    } catch (e) {
      failures.push(`descriptor 解析失败 adapters/${dir.split(/[\\/]/).pop()}/${f}: ${e.message}`);
    }
  }
  return out;
}

const producers = loadDescriptors(join(ENGINE, 'adapters', 'producers'));
const owners = loadDescriptors(join(ENGINE, 'adapters', 'owners'));
const ownerMap = new Map();

/* ---------------------------------------------------------------- 目标清单 */

const expand = (p) => (p && p.startsWith('~') ? join(homedir(), p.slice(1).replace(/^[\\/]/, '')) : p);
/** path → { path, owner, families:Set, source:Set } */
const targets = new Map();

function addTarget(path, owner, family, source) {
  if (!path || !owner) return;
  const key = resolve(path);
  const cur = targets.get(key);
  if (cur === undefined) {
    targets.set(key, { path: key, owner, families: new Set(family ? [family] : []), source: new Set([source]) });
    return;
  }
  if (cur.owner !== owner) {
    // 同一份文件被两个应用声明 = 建模错误（重载策略会含糊）⇒ 报失败，不猜
    failures.push(`目标 ${key} 被两个 owner 声明（${cur.owner} / ${owner}）→ 请修正 adapters/owners`);
    return;
  }
  if (family) cur.families.add(family);
  cur.source.add(source);
}

for (const p of producers) {
  const sw = normSwitch(cfg.producers?.[p.id]);
  if (!sw.enabled || p.enabled === false) {
    skipped.push(`producer:${p.id}:disabled`);
    continue;
  }
  const cmd = (p.cmd || []).map((x) => String(x).replace('{engine}', ENGINE));
  if (cmd.length === 0) {
    failures.push(`producer ${p.id} 缺 cmd`);
    continue;
  }
  const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: PRODUCER_TIMEOUT_MS, windowsHide: true, env: { ...process.env, AI_SYNC_INSTANCE: INSTANCE, AI_SYNC_ENGINE: ENGINE } });
  if (r.error || r.status !== 0) {
    // node 不在 PATH / 渲染器崩了 —— 都必须可见（假绿防线）
    const why = r.error ? `${r.error.code || r.error.message}` : `退出码 ${r.status}`;
    failures.push(`producer ${p.id} 无法产出目标清单（${why}）`);
    continue;
  }
  const last = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    failures.push(`producer ${p.id} 输出不是 JSON：${String(last).slice(0, 120)}`);
    continue;
  }
  for (const t of parsed.targets || []) addTarget(t.path, t.owner, t.family, `producer:${p.id}`);
}

for (const o of owners) {
  const sw = normSwitch(cfg.owners?.[o.id]);
  if (!sw.enabled || o.enabled === false) {
    skipped.push(`owner:${o.id}:disabled`);
    continue;
  }
  ownerMap.set(o.id, { ...o, _sw: sw });
  for (const t of o.targets || []) addTarget(t.path, o.id, t.family, `owner:${o.id}`);
}

/* owner 被关掉（或没有 descriptor）⇒ 它的目标不进入收敛 */
const tracked = [];
for (const t of targets.values()) {
  if (!ownerMap.has(t.owner)) {
    skipped.push(`target:${t.path}:owner(${t.owner})-未启用`);
    continue;
  }
  tracked.push(t);
}

/* ---------------------------------------------------------------- 变更检测（内容 sha256，不用 mtime） */

const sha = (p) => {
  try {
    return createHash('sha256').update(readFileSync(p)).digest('hex');
  } catch {
    return null;
  }
};

const stateDir = join(INSTANCE, 'sync', 'state');
const stateFile = join(stateDir, `local-${MACHINE}.json`);
let prev = { targets: {} };
if (existsSync(stateFile)) {
  try {
    prev = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (e) {
    failures.push(`上次状态解析失败 ${stateFile}: ${e.message}`);
  }
}

const changed = [];
const nowTargets = {};
for (const t of tracked) {
  const digest = sha(t.path);
  if (digest === null) {
    skipped.push(`target:${t.path}:读不到（已删除？）`);
    continue;
  }
  const families = [...t.families].sort();
  nowTargets[t.path] = { sha256: digest, owner: t.owner, families };
  const was = prev.targets?.[t.path];
  if (was === undefined || was.sha256 !== digest) changed.push({ ...t, families, digest, isNew: was === undefined });
}

/* ---------------------------------------------------------------- 分类与施加 */

const probeOk = (o) => {
  const items = o.probe?.any || [];
  if (items.length === 0) return true;
  for (const item of items) {
    const looksPath = item.startsWith('~') || item.includes('/') || item.includes('\\');
    if (looksPath) {
      if (existsSync(expand(item))) return true;
    } else {
      const r = spawnSync(item, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true, shell: process.platform === 'win32' });
      if (r.status === 0) return true;
    }
  }
  return false;
};

/** 本机服务一律走 node:http（**不用 fetch**）。
 *  2026-09-17 实测（Node v24 / Windows）：`fetch` + `AbortSignal.timeout` 之后 `process.exit()` 会让
 *  进程以 0xC0000409 崩溃并打印 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`——
 *  即 undici 的连接池/定时器与立即退出打架。这里改成自带清理的 http.request + `process.exitCode`
 *  （不强制退出，让事件循环自然结束），跑完即净退出，无残留句柄。 */
function httpJson(method, url, body) {
  return new Promise((done, fail) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      fail(e);
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = mod.request(
      {
        method,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        timeout: HTTP_TIMEOUT_MS,
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
          } catch {
            /* 非 JSON 也算可用响应——由调用方按 status 判定 */
          }
          done({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => fail(e));
    if (payload) req.write(payload);
    req.end();
  });
}

/** 「在监听」= 服务在跑；用来区分"应用没启动"（良性）与"启动了但坏了"（真问题） */
async function portListening(base) {
  let u;
  try {
    u = new URL(base);
  } catch {
    return false;
  }
  return await new Promise((done) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
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
}

const byOwner = new Map();
for (const c of changed) {
  if (!byOwner.has(c.owner)) byOwner.set(c.owner, []);
  byOwner.get(c.owner).push(c);
}

for (const [ownerId, list] of byOwner) {
  const o = ownerMap.get(ownerId);
  const rl = o.reload || { mode: 'none' };
  if (!probeOk(o)) {
    skipped.push(`owner:${ownerId}:本机未安装（probe 全不成立）`);
    continue;
  }
  const mode = rl.mode || 'none';

  if (mode === 'none' || mode === 'hot') {
    for (const c of list) classify.push({ path: c.path, owner: ownerId, kind: mode, restart: false, hint: rl.hint || '' });
    continue;
  }

  if (mode === 'manual') {
    for (const c of list) classify.push({ path: c.path, owner: ownerId, kind: 'manual', restart: false, hint: rl.hint || '' });
    actions.push({ level: 'warn', owner: ownerId, text: rl.hint || `${ownerId} 需重启生效`, paths: list.map((c) => c.path) });
    continue;
  }

  if (mode === 'command') {
    for (const c of list) classify.push({ path: c.path, owner: ownerId, kind: 'command', restart: false, hint: rl.hint || '' });
    const cmd = (rl.cmd || []).map((x) => String(x).replace('{engine}', ENGINE));
    if (cmd.length === 0) {
      failures.push(`owner ${ownerId} 声明了 command 模式但没有 cmd`);
      continue;
    }
    if (DRY) {
      actions.push({ level: 'warn', owner: ownerId, text: `（dry-run）将执行重载命令：${cmd.join(' ')}`, paths: list.map((c) => c.path) });
    } else if (!APPLY_COMMANDS) {
      actions.push({ level: 'warn', owner: ownerId, text: `需手动执行重载命令（未加 --apply-commands）：${cmd.join(' ')}`, paths: list.map((c) => c.path) });
    } else {
      const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, AI_SYNC_INSTANCE: INSTANCE, AI_SYNC_ENGINE: ENGINE } });
      if (r.status !== 0) failures.push(`owner ${ownerId} 重载命令失败（退出码 ${r.status}）：${cmd.join(' ')}`);
      else note(`[OK] ${ownerId} 重载命令已执行`);
    }
    continue;
  }

  if (mode === 'http') {
    const base = o._sw.guardBase || rl.guardBase;
    if (!base) {
      failures.push(`owner ${ownerId} 声明了 http 模式但缺 guardBase`);
      continue;
    }
    const needs = [];
    let guardDown = false;
    for (const c of list) {
      const url = base + String(rl.classify || '/restart/classify?path={path}').replace('{path}', encodeURIComponent(c.path));
      let r;
      try {
        r = await httpJson('GET', url);
      } catch (e) {
        if (!(await portListening(base))) {
          guardDown = true;
          break;
        }
        failures.push(`owner ${ownerId}: classify 请求失败但 ${base} 在监听（${e.name}: ${e.message}）`);
        break;
      }
      if (r.status !== 200 || r.json === null) {
        if (!(await portListening(base))) {
          guardDown = true;
          break;
        }
        failures.push(`owner ${ownerId}: classify 返回 HTTP ${r.status} 且 ${base} 在监听`);
        break;
      }
      classify.push({ path: c.path, owner: ownerId, kind: r.json.kind, restart: !!r.json.restart, hint: r.json.hint || '' });
      if (r.json.restart) needs.push(c.path);
    }
    if (guardDown) {
      // 应用没在跑 = **良性**：下次启动自然读到新文件（记 pending，不谎报"已生效"）
      skipped.push(`owner:${ownerId}:服务未运行 → 变更待其下次启动生效`);
      continue;
    }
    if (needs.length > 0) {
      const body = {
        reason: `sync-converge: ${needs.length} 项 live 配置变更（${needs.map((p) => p.split(/[\\/]/).pop()).join(', ')}）`,
        kind: rl.kind || 'sync-converge',
        force: FORCE,
      };
      if (DRY) {
        requested.push({ dryRun: true, ...body, paths: needs });
        note(`[dry-run] 将登记重启：${body.reason}`);
      } else {
        try {
          const r = await httpJson('POST', base + (rl.request || '/restart/request'), body);
          if (r.status !== 200) failures.push(`owner ${ownerId}: 登记重启返回 HTTP ${r.status}`);
          else requested.push({ ...body, id: r.json?.id, paths: needs });
        } catch (e) {
          failures.push(`owner ${ownerId}: 登记重启请求失败（${e.name || e.message}）`);
        }
      }
      actions.push({ level: 'warn', owner: ownerId, text: `${needs.length} 项变更需重启（已登记，空闲后自动执行）`, paths: needs });
    }
    continue;
  }

  failures.push(`owner ${ownerId} 的 reload.mode 不认识：${mode}`);
}

/* ---------------------------------------------------------------- 落状态 */

const now = new Date();
const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

const state = {
  machine: MACHINE,
  engine: ENGINE,
  instance: INSTANCE,
  at: stamp,
  dryRun: DRY,
  targets: nowTargets,
  last: {
    at: stamp,
    changed: changed.map((c) => ({ path: c.path, owner: c.owner, families: c.families, isNew: c.isNew })),
    classify,
    requested,
    actions,
    skipped,
    failures,
  },
};

if (!DRY) {
  try {
    mkdirSync(stateDir, { recursive: true });
    // 2026-09-17 TR6 实测：本工具写的是**整份**状态文件（自己的 schema），会把 sync-status 追加进去的
    // `statePush` 字段抹掉 ⇒ "跨端状态推送失败"这条 WARN 永远看不到。这里把它带过去，保持两个写入方互不破坏。
    if (prev?.statePush) state.statePush = prev.statePush;
    writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch (e) {
    failures.push(`状态写盘失败 ${stateFile}: ${e.message}`);
  }
}

/* ---------------------------------------------------------------- 输出 */

const rc = failures.length > 0 ? 3 : 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ ...state, rc }, null, 2));
} else {
  note(`converge: machine=${MACHINE} targets=${tracked.length} changed=${changed.length}`);
  for (const c of classify) note(`  ${c.restart ? 'RESTART' : c.kind.padEnd(7)} ${c.path}${c.hint ? `  ← ${c.hint}` : ''}`);
  for (const r of requested) note(`  [登记] ${r.dryRun ? '(dry-run) ' : ''}${r.reason}`);
  for (const a of actions) note(`  [待办] ${a.text}`);
  for (const s of skipped) note(`  [跳过] ${s}`);
  for (const f of failures) note(`  [FAIL] ${f}`);
  note(`converge done: rc=${rc} changed=${changed.length} targets=${tracked.length} requested=${requested.length} todo=${actions.length}${DRY ? ' (dry-run)' : ''} → ${stateFile}`);
}

// 不调 process.exit()：见上面 httpJson 的注释（Windows 上立即退出会撞 libuv 断言）。
// 所有句柄都已显式清理，事件循环自己会结束。
process.exitCode = rc;
