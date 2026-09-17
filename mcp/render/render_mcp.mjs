#!/usr/bin/env node
/**
 * render_mcp.mjs — 四工具共享 MCP 渲染器
 *
 * 源配置:   <实例根>/mcp/servers.json  (标准 mcpServers 格式 + enabled/timeout 扩展字段)
 * 渲染目标:
 *   1. WorkBuddy   ~/.workbuddy/mcp.json                 (标准 mcpServers)
 *   2. dsh         ~/.dsh/profiles/<name>/cordis.patch.yml (托管标记块内的 dsh-mcp-client 插件行)
 *                  ——注意: 不写 ~/.dsh/cordis.patch.yml(全局层)，避免与 profile 层同 id 冲突
 *                    (loader 对重复 entry id 直接抛错)
 *   3. opencode    ~/.config/opencode/opencode.jsonc     (仅替换 mcp 段，其余字段原样保留)
 *
 * 用法:
 *   node render_mcp.mjs                 # 渲染写入全部目标
 *   node render_mcp.mjs --audit         # 只报告偏差，不写文件
 *   node render_mcp.mjs --extra '<json>'  # 追加/覆盖 server 定义(凭据注入用)，如
 *                                       # --extra '{"github":{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer xxx"},"enabled":true}}'
 *
 * 源配置条目格式:
 *   stdio: { "command": "...", "args": [...], "env": {...}?, "enabled": true, "timeout": ms? }
 *   http : { "url": "...", "headers": {...}?, "enabled": true, "timeout": ms? }
 * 凭据绝不写入 servers.json，用 --extra 注入。
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname, platform } from 'node:os';
import { execSync } from 'node:child_process';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
// **引擎根 vs 实例根**（2026-09-17 泛化）：源配置 `mcp/servers.json` 属于**实例**（你的 MCP 清单），
// 渲染目标（workbuddy / dsh profile / opencode）是**本机 live 文件**。原地部署时两者同目录；
// 引擎独立部署时靠 $AI_SYNC_ENGINE / $AI_SYNC_INSTANCE 区分。写死 `<实例根>` 会让别人跑不起来。
const ENGINE = process.env.AI_SYNC_ENGINE ? join(process.env.AI_SYNC_ENGINE) : join(HERE, '..', '..');
const AI = process.env.AI_SYNC_INSTANCE ? join(process.env.AI_SYNC_INSTANCE) : ENGINE;
const SRC = join(AI, 'mcp', 'servers.json');
const WB = join(HOME, '.workbuddy', 'mcp.json');
const OC = join(HOME, '.config', 'opencode', 'opencode.jsonc');
const DSH_PROFILES = join(HOME, '.dsh', 'profiles');
const BEGIN = '# ==== ai-shared-managed: MCP servers (BEGIN) ====';
const END = '# ==== ai-shared-managed: MCP servers (END) ====';

const audit = process.argv.includes('--audit');
/* --targets-json（2026-09-17 新增）：只打印本渲染器负责的 live 目标清单（供 tools/sync-converge.mjs
 * 组装变更清单用；见 tools/render_agent_files.mjs 同名注释）。存在性判定与下面的写入块同规则。 */
const targetsJson = process.argv.includes('--targets-json');
const extraIdx = process.argv.indexOf('--extra');
let extra = {};
if (extraIdx !== -1 && process.argv[extraIdx + 1]) {
  extra = JSON.parse(process.argv[extraIdx + 1]);
}

const src = JSON.parse(readFileSync(SRC, 'utf8')).mcpServers;
for (const [k, v] of Object.entries(extra)) src[k] = { ...src[k], ...v };

/* ---------------- 机器维度（2026-09-16） ----------------
 * servers.json 是 git 共享文件，绝不写机器专属绝对路径；改用占位符：
 *   ${NODE}        node 解释器绝对路径
 *   ${NPM_GLOBAL}  npm 全局 node_modules 根
 *   ${EDGE_DEV}    Edge Dev 可执行文件
 *   ${SKILLS}      本机 skills 根（随技能发布的 MCP server 用它定位）
 *   （{env:VAR} 是另一种语法，供下游消费，本渲染器不动它）
 * 取值顺序：mcp/machines/<machine>.json 的 values → 自动探测 → 取不到则硬报错。
 * 机器标识：DSH_MACHINE → sync/local.machine → hostname（与 sync/_load.ps1 一致）。
 * 用法：node render_mcp.mjs --detect   # 只打印本机探测值（可粘进 machines/<machine>.json），不渲染
 * ------------------------------------------------------------------------- */
const AI_SHARED = AI;   // 实例根（原地部署时 = 引擎根；见文件头的引擎/实例说明）
/** 本渲染器路径的展示形式（写进受管块头部注释）：源码不留个人串，渲染期按本机位置算。 */
const ENGINE_DISPLAY = (() => {
  const p = join(ENGINE, 'mcp', 'render', 'render_mcp.mjs');
  return p.startsWith(HOME) ? '~' + p.slice(HOME.length).replace(/\\/g, '/') : p.replace(/\\/g, '/');
})();
const MACHINE = (() => {
  if (process.env.DSH_MACHINE) return process.env.DSH_MACHINE;
  const lm = join(AI_SHARED, 'sync', 'local.machine');
  if (existsSync(lm)) return readFileSync(lm, 'utf8').trim();
  return hostname().toLowerCase();
})();
const MACHINE_FILE = join(AI_SHARED, 'mcp', 'machines', `${MACHINE}.json`);
let MACHINE_VALUES = {};
let MACHINE_FILE_ERROR = null;
if (existsSync(MACHINE_FILE)) {
  try {
    MACHINE_VALUES = JSON.parse(readFileSync(MACHINE_FILE, 'utf8')).values ?? {};
  } catch (e) {
    // 共享文件里一个引号写错不该让渲染崩掉：报警 + 回退自动探测（绝不用空值静默渲染）
    MACHINE_FILE_ERROR = e.message;
    console.warn(`[WARN] ${MACHINE_FILE} 解析失败（${e.message}）→ 本次回退到自动探测；请修好该文件`);
  }
}

function detectNode() {
  return process.execPath;
}
function detectNpmGlobal() {
  try {
    const out = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (out) return out;
  } catch { /* npm 不在 PATH 或超时 → 走兜底 */ }
  const guess = platform() === 'win32'
    ? join(HOME, 'AppData', 'Roaming', 'npm', 'node_modules')
    : join(HOME, '.npm-global', 'lib', 'node_modules');
  return existsSync(guess) ? guess : null;
}
function detectEdgeDev() {
  const cands = [
    join('C:\\', 'Program Files (x86)', 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
    join('C:\\', 'Program Files', 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
  ];
  return cands.find((p) => existsSync(p)) ?? null;
}
/* 2026-09-17（<机器>）：随技能一起发布的 MCP server（如 nature-academic-search/mcp-server）
   必须用本机 skills 根定位——skills 是符号链接/junction，绝对路径两端不同，不能写进共享源。
   HOME 派生即可，无需进 machines/<machine>.json。 */
function detectSkills() {
  const p = join(AI, 'skills');
  return existsSync(p) ? p : null;
}
const DETECTORS = { NODE: detectNode, NPM_GLOBAL: detectNpmGlobal, EDGE_DEV: detectEdgeDev, SKILLS: detectSkills };
const VALUES = {};
const VALUE_SOURCE = {};
function valueOf(key) {
  if (key in VALUES) return VALUES[key];
  if (key in MACHINE_VALUES) { VALUES[key] = MACHINE_VALUES[key]; VALUE_SOURCE[key] = `machines/${MACHINE}.json`; return VALUES[key]; }
  const d = DETECTORS[key] ? DETECTORS[key]() : null;
  if (d) { VALUES[key] = d; VALUE_SOURCE[key] = 'auto-detect'; return d; }
  return null;
}

const detectOnly = process.argv.includes('--detect');
if (detectOnly) {
  const KEYS = Object.keys(DETECTORS);
  const out = {};
  for (const k of KEYS) out[k] = valueOf(k);
  console.log(JSON.stringify({ machine: MACHINE, machineFile: MACHINE_FILE, machineFileExists: existsSync(MACHINE_FILE), detected: out, source: VALUE_SOURCE }, null, 2));
  console.log('\n把 detected 里的值填进 ' + MACHINE_FILE + ' 的 values 字段即可（也可留空靠自动探测）：');
  console.log(JSON.stringify({ machine: MACHINE, values: out }, null, 2));
  process.exit(0);
}

/* 展开 ${TOKEN}；未解析的占位符会让本次渲染硬失败（绝不静默写错路径） */
const unresolved = new Set();
function expand(v) {
  if (typeof v === 'string') {
    const out = v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, k) => {
      const val = valueOf(k);
      if (val === null) { unresolved.add(k); return m; }
      return val;
    });
    /* servers.json 的路径后缀按 Windows 写（\\）；非 Windows 平台统一规范为 /（Windows 输出逐字节不变） */
    return process.platform === 'win32' ? out : out.replace(/\\/g, '/');
  }
  if (Array.isArray(v)) return v.map(expand);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
  return v;
}
for (const [name, s] of Object.entries(src)) src[name] = expand(s);
if (unresolved.size > 0) {
  console.error(`[FAIL] 以下占位符在本机（${MACHINE}）无法取值：${[...unresolved].join(', ')}`);
  console.error(`       修法：运行 node render_mcp.mjs --detect，把值填进 ${MACHINE_FILE}`);
  console.error(`       或直接创建该文件：{"machine":"${MACHINE}","values":{"NPM_GLOBAL":"...","EDGE_DEV":"..."}}`);
  process.exit(2);
}
if (process.argv.includes('--verbose') || !existsSync(MACHINE_FILE)) {
  const used = Object.entries(VALUE_SOURCE).map(([k, v]) => `${k}<-${v}`).join(' ');
  console.log(`[machine] ${MACHINE}${existsSync(MACHINE_FILE) ? '' : '（无 machines 值文件，全部走自动探测）'} ${used}`);
}

/* ---- 按工具路由：server 条目内 targets: ["workbuddy","dsh","opencode"]，省略=全端 ----
   2026-09-17 新增：excludeMachines: ["<机器>"] —— 按机器排除（如 desktop-touch 是 Windows 专有后端）。
   机器 id 取自 _load/渲染器同一套解析（DSH_MACHINE → local.machine）。 */
const TOOLS = ['workbuddy', 'dsh', 'opencode'];
const targetsOf = (s) => (Array.isArray(s.targets) && s.targets.length ? s.targets : TOOLS);
const filter = (servers, tool) =>
  Object.fromEntries(Object.entries(servers).filter(([, s]) =>
    targetsOf(s).includes(tool) &&
    !(Array.isArray(s.excludeMachines) && s.excludeMachines.includes(MACHINE))));

/* ---------------- helpers ---------------- */

const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // YAML single-quote escape

function renderDshEntries(servers) {
  const lines = [];
  for (const [name, s] of Object.entries(servers)) {
    if (s.enabled === false) continue;
    lines.push(`    - id: mcp-${name}`);
    lines.push(`      name: '@deepseek-ai/dsh-mcp-client'`);
    lines.push(`      config:`);
    lines.push(`        serverName: ${name}`);
    if (s.url) {
      lines.push(`        transport: 'streamable-http'`);
      lines.push(`        url: ${q(s.url)}`);
      if (s.headers) {
        lines.push(`        headers:`);
        for (const [k, v] of Object.entries(s.headers)) lines.push(`          ${k}: ${q(v)}`);
      }
    } else {
      lines.push(`        transport: stdio`);
      lines.push(`        command: ${q(s.command)}`);
      if (s.args?.length) {
        lines.push(`        args:`);
        for (const a of s.args) lines.push(`          - ${q(a)}`);
      }
      if (s.env && Object.keys(s.env).length) {
        lines.push(`        env:`);
        for (const [k, v] of Object.entries(s.env)) lines.push(`          ${k}: ${q(v)}`);
      }
    }
    if (s.timeout) lines.push(`        toolCallTimeoutMs: ${s.timeout}`);
  }
  return lines.join('\n');
}

function renderWorkbuddy(servers) {
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    if (s.enabled === false) continue;
    if (s.url) {
      const e = { url: s.url };
      if (s.headers) e.headers = s.headers;
      out[name] = e;
    } else {
      const e = { command: s.command, args: s.args ?? [] };
      if (s.env) e.env = s.env;
      out[name] = e;
    }
  }
  return JSON.stringify({ mcpServers: out }, null, 2) + '\n';
}

function renderOpencode(servers) {
  const out = {};
  for (const [name, s] of Object.entries(servers)) {
    if (s.url) {
      const e = { type: 'remote', url: s.url, enabled: s.enabled !== false };
      if (s.headers) e.headers = s.headers;
      if (s.timeout) e.timeout = s.timeout;
      out[name] = e;
    } else {
      const e = {
        type: 'local',
        command: [s.command, ...(s.args ?? [])],
        enabled: s.enabled !== false,
      };
      if (s.env) e.env = s.env;
      if (s.timeout) e.timeout = s.timeout;
      out[name] = e;
    }
  }
  return out;
}

/** strip JSONC comments + trailing commas -> strict JSON text */
function stripJsonc(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[i + 1] ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++; continue;
    }
    if (c === '"') { inStr = true; out += c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i += 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/* ---------------- targets ---------------- */

if (targetsJson) {
  const list = [];
  if (existsSync(DSH_PROFILES)) {
    for (const prof of readdirSync(DSH_PROFILES, { withFileTypes: true })) {
      if (!prof.isDirectory()) continue;
      const patch = join(DSH_PROFILES, prof.name, 'cordis.patch.yml');
      if (existsSync(patch)) list.push({ path: patch, owner: 'dsh', family: 'mcp' });
    }
  }
  if (existsSync(WB)) list.push({ path: WB, owner: 'workbuddy', family: 'mcp' });
  if (existsSync(OC)) list.push({ path: OC, owner: 'opencode', family: 'mcp' });
  console.log(JSON.stringify({ renderer: 'mcp', targets: list }));
  process.exit(0);
}

const report = [];

// 1. WorkBuddy（无路由 server 时删除 mcp.json）
{
  const subset = filter(src, 'workbuddy');
  if (Object.keys(subset).length === 0) {
    const exists = existsSync(WB);
    report.push({ name: 'workbuddy mcp.json', path: WB, expected: '(deleted)', actual: exists ? '(present)' : '(absent)', changed: exists });
    if (!audit && exists) unlinkSync(WB);
  } else {
    const expected = renderWorkbuddy(subset);
    const actual = existsSync(WB) ? readFileSync(WB, 'utf8') : '(absent)';
    report.push({ name: 'workbuddy mcp.json', path: WB, expected, actual, changed: expected !== actual });
    if (!audit && expected !== actual) writeFileSync(WB, expected, 'utf8');
  }
}

// 2. dsh profiles (每个 profile 自己的 cordis.patch.yml; 全局层不动)
if (existsSync(DSH_PROFILES)) {
  for (const prof of readdirSync(DSH_PROFILES, { withFileTypes: true })) {
    if (!prof.isDirectory()) continue;
    const patch = join(DSH_PROFILES, prof.name, 'cordis.patch.yml');
    if (!existsSync(patch)) {
      report.push({ name: `dsh profile ${prof.name}`, path: patch, expected: '(absent, skipped)', actual: '(absent)', changed: false });
      continue;
    }
    const text = readFileSync(patch, 'utf8');
    const b = text.indexOf(BEGIN), e = text.indexOf(END);
    const hasBlock = b !== -1 && e !== -1;
    let before = hasBlock ? text.slice(0, b) : text;
    // 2026-09-17（<机器> 发现）：dsh 首次生成的 patch 文件 = 注释头 + 空数组文档 `[]`。
    // 直接在其后追加 `- insert:` 会形成"两个 YAML 文档缺 --- 分隔符" → dsh 启动报
    // "document separator is expected"。把孤立空数组文档去掉（无该行时是本替换的空操作）。
    before = before.replace(/(^|\n)[ \t]*\[\][ \t]*(?=\n|$)/, '$1');
    const after = hasBlock ? text.slice(e + END.length) : '';
    const entries = renderDshEntries(filter(src, 'dsh'));
    const block = entries
      ? `${BEGIN}\n# 由 ${ENGINE_DISPLAY} 生成，勿在标记内手工编辑\n- insert:\n${entries}\n${END}`
      : '';
    const expected = (before.replace(/\n*$/, '\n') + block + after.replace(/^\n*/, '\n')).replace(/^\n+/, '');
    const changed = expected !== text;
    report.push({ name: `dsh profile ${prof.name}`, path: patch, expected: '(managed block)', actual: hasBlock ? '(managed block present)' : '(legacy/unmanaged)', changed });
    if (!audit && changed) writeFileSync(patch, expected, 'utf8');
  }
}

// 3. opencode (仅替换 mcp 段)
{
  const raw = readFileSync(OC, 'utf8');
  const obj = JSON.parse(stripJsonc(raw));
  const rendered = renderOpencode(filter(src, 'opencode'));
  if (Object.keys(rendered).length === 0) delete obj.mcp; else obj.mcp = rendered;
  const expected = JSON.stringify(obj, null, 2) + '\n';
  const changed = expected !== raw;
  report.push({ name: 'opencode opencode.jsonc', path: OC, expected: '(mcp section merged)', actual: changed ? '(drift)' : '(in sync)', changed });
  if (!audit && changed) writeFileSync(OC, expected, 'utf8');
}

/* ---------------- report ---------------- */

let dirty = 0;
for (const r of report) {
  // 2026-09-17 修（假绿，同 conventions §3）：目标文件**不存在**时原先也打印 `[OK]`，
  // 读日志的人会以为 `profiles/node_modules` 这种非 profile 目录真的被处理了。
  // 现在按"跳过"显式打印 `[--]`，不参与 drift 计数。
  const skipped = r.actual === '(absent)' && r.expected === '(absent, skipped)';
  const status = skipped ? '--' : r.changed ? (audit ? 'DRIFT' : 'WRITTEN') : 'OK';
  if (r.changed) dirty++;
  console.log(`[${status}] ${r.name} -> ${r.path}`);
}
console.log(audit ? `audit done: ${dirty} target(s) drifted` : `render done: ${dirty} target(s) written`);
process.exit(0);
