#!/usr/bin/env node
/**
 * syncthing-health.mjs —— 传输层健康快照（P7 观测；给 doctor / status / 心跳 / 控制台共用）
 *
 * 为什么需要：传输层是"看起来在跑"最容易骗人的一层 —— 进程活着但某个 folder 报错、或对端压根没连上，
 * 界面上都写着"运行中"。本工具把三件可证伪的事落成结构化状态：
 *   ① 进程与 REST 是否可达（不可达就是一切判断的前提没了）
 *   ② 每个 folder 的状态/错误/待同步数 + **每个对端的完成度**
 *   ③ 连接**走的是直连还是中继**（公共中继方案下这是关键事实）、对端最后可见时间
 *
 * 判据分级（避免假红）：
 *   · 未登记 device ID 的对端  → INFO（还没开始配，不是故障）
 *   · `heartbeat.tolerantMachines` 里的机器（移动端/按需） → 只记录，不计问题
 *   · folder 报错 / 被暂停 / 有对端却没一个连上 → 计问题（--rc 时 exit 1）
 *
 * 用法：node tools/syncthing-health.mjs [--instance DIR] [--json] [--quiet] [--rc] [--no-write]
 * 退出码：0 = 无问题；1 = 有问题（配 --rc）；2 = 环境错误（找不到配置/连不上 REST）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import { syncthingApi, stApi } from './lib/syncthing-api.mjs';
import { readMaintenance } from './lib/maintenance.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || join(HERE, '..'));
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const say = (s) => { if (!QUIET && !JSON_OUT) console.log(s); };
const nowStr = () => { const d = new Date(); const z = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

const machine = val('--machine') || process.env.AI_SYNC_MACHINE || process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').replace(/^\uFEFF/, '').trim() : hostname().toLowerCase());

const out = {
  schema: 1, machine, at: nowStr(), ok: false, reachable: false,
  version: null, folders: [], connections: [], knownPeers: [], unregisteredPeers: [],
  tolerant: [], problems: [], notes: []
};

const instance = readJson(join(INSTANCE, 'sync', 'instance.json')) || {};
const tolerant = new Set(instance.heartbeat?.tolerantMachines || []);
out.tolerant = [...tolerant];
const devices = readJson(join(INSTANCE, 'sync', 'syncthing', 'devices.json'))?.devices || {};
const maint = readMaintenance(INSTANCE);
const meCfg = readJson(join(INSTANCE, 'sync', 'machines', `${machine}.json`)) || {};
const myFolders = (meCfg.transport?.folders || []);

const api = syncthingApi();
if (!api) {
  out.problems.push('找不到 Syncthing 配置（config.xml）：先安装并 `syncthing generate`，或设 ST_HOME');
  finish(2);
}

const st = await stApi(api, '/rest/system/status');
if (st.status !== 200 || !st.json?.myID) {
  out.problems.push(`连不上本机 Syncthing REST（${api.base}，status=${st.status}）：进程没跑或端口不对`);
  finish(2);
}
out.reachable = true;
// v2 里版本号不在 /rest/system/status，而在 /rest/system/version
const ver = (await stApi(api, '/rest/system/version')).json || {};
out.version = String(ver.version || '').replace(/^syncthing\s*/i, '') || null;
out.deviceId = st.json.myID;
say(`Syncthing ${out.version || '?'}  deviceID=${String(out.deviceId).slice(0, 7)}…  ${api.base}`);

/* 对端：已登记 / 未登记（devices.json 是唯一源） */
const knownPeerIds = Object.entries(devices).filter(([m]) => m !== machine && devices[m]?.id).map(([m, d]) => ({ machine: m, id: d.id }));
out.knownPeers = knownPeerIds.map((p) => p.machine);
if (!knownPeerIds.length) out.unregisteredPeers = ['(devices.json 还没有任何 device ID)'];

/* 连接（含"直连还是中继"这一关键事实） */
const conns = (await stApi(api, '/rest/system/connections')).json?.connections || {};
let anyConnected = false;
for (const p of knownPeerIds) {
  const c = conns[p.id] || {};
  const isRelay = /relay/i.test(String(c.type || '')) || /relay/i.test(String(c.address || ''));
  const rec = { machine: p.machine, connected: !!c.connected, type: c.type || null, address: c.address || null, viaRelay: isRelay, tolerated: tolerant.has(p.machine) };
  out.connections.push(rec);
  if (rec.connected) anyConnected = true;
  const tag = rec.connected ? `${isRelay ? '中继' : '直连'}(${c.type})` : '未连接';
  say(`  ${p.machine.padEnd(10)} ${tag}${rec.address ? ' ' + rec.address : ''}${rec.tolerated ? '  [宽容机器]' : ''}`);
}
if (knownPeerIds.length && !anyConnected) {
  // 规则与心跳一致（tools/lib/maintenance.mjs 单一源）：登记维护中 / 宽容机器都只记录，不判问题
  const hard = knownPeerIds.filter((p) => !tolerant.has(p.machine) && !(maint[p.machine] && !maint[p.machine].expired)).map((p) => p.machine);
  if (hard.length) out.problems.push(`没有任何对端连上（非宽容、非维护中：${hard.join('、')}）⇒ 公共发现/中继或出口策略要先查；若对端本来就没在跑，把它登记进 sync/maintenance.json`);
  else out.notes.push('对端均未连接，但它们都是宽容机器或已登记维护 ⇒ 仅记录');
}
if (!knownPeerIds.length) out.notes.push('还没有登记任何对端 device ID ⇒ 文件夹会是"只有自己"的状态（等采集后重跑 --provision）');

/* 文件夹 */
const folders = (await stApi(api, '/rest/config/folders')).json || [];
if (!folders.length) out.notes.push('本机还没有配置任何 folder（P4 逐集合迁移时才会有）');
for (const f of folders) {
  const s = (await stApi(api, `/rest/db/status?folder=${f.id}`)).json || {};
  const rec = {
    id: f.id, label: f.label, path: f.path, type: f.type, paused: !!f.paused,
    state: s.state || null, errors: s.errors || 0, needFiles: s.needFiles ?? null,
    localFiles: s.localFiles ?? null, globalFiles: s.globalFiles ?? null,
    versioning: f.versioning?.type || 'none', devices: (f.devices || []).length, peersDone: []
  };
  for (const p of knownPeerIds) {
    const c = (await stApi(api, `/rest/db/completion?folder=${f.id}&device=${p.id}`)).json;
    if (c && typeof c.completion === 'number') rec.peersDone.push({ machine: p.machine, completion: Number(c.completion.toFixed(1)) });
  }
  out.folders.push(rec);
  if (rec.paused) out.problems.push(`folder ${rec.id} 被暂停（paused=true）`);
  if (rec.errors) out.problems.push(`folder ${rec.id} 有 ${rec.errors} 个错误（state=${rec.state}）`);
  if (rec.versioning !== 'staggered') out.notes.push(`folder ${rec.id} 未开 staggered 版本化（当前 ${rec.versioning}）⇒ 误删防线 L1 缺失`);
  const lag = rec.peersDone.filter((x) => x.completion < 100 && !tolerant.has(x.machine));
  if (lag.length) out.notes.push(`folder ${rec.id} 对端未追平：${lag.map((x) => `${x.machine}=${x.completion}%`).join(' ')}`);
  say(`  ${rec.id.padEnd(28)} ${String(rec.state).padEnd(8)} 本地 ${rec.localFiles ?? '?'} / 全局 ${rec.globalFiles ?? '?'} 待 ${rec.needFiles ?? '?'} ${rec.versioning}${rec.paused ? ' [暂停]' : ''}`);
}

out.ok = out.problems.length === 0;
finish(out.ok ? 0 : 1);

function finish(code) {
  if (!JSON_OUT) {
    for (const n of out.notes) say(`[info] ${n}`);
    for (const p of out.problems) say(`[FAIL] ${p}`);
    say(out.problems.length ? `传输层：${out.problems.length} 个问题` : '传输层：无问题');
  }
  if (!has('--no-write') && out.reachable) {
    const file = join(INSTANCE, 'sync', 'state', `transport-${machine}.json`);
    try {
      const prev = readJson(file) || {};
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      // 与生成器共用同一个状态文件：各自只改自己的键（生成器写 plan，这里写 health）
      writeFileSync(tmp, JSON.stringify({ ...prev, health: out }, null, 2), 'utf8');
      renameSync(tmp, file);
    } catch (e) { say(`[WARN] 状态写不了：${e.message}`); }
  }
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
  process.exitCode = has('--rc') ? code : 0;
}
