#!/usr/bin/env node
/**
 * render_conventions.mjs — 把 docs/conventions.md 的 §1/§2 canonical 文本渲染进各端派生副本
 *
 * 单一源：<实例根>/docs/conventions.md（§1 国内镜像规则 / §2 Top Expert 应答规则）
 *
 * 目标（按本机布局自动选择，与 health_check.py 的 _pick_inject 同规则）：
 *   1. ~/.config/opencode/CN-MIRROR.md    ← §1 全文（+ 可选本机附加说明 CN-MIRROR.local.md）
 *   2. ~/.config/opencode/top-expert.md   ← §2 全文
 *   3. ~/.dsh/AGENTS.md                   ← §1/§2 各替换对应小节，其余原样保留
 *   合并布局（<机器>：opencode 侧只有单个 AGENTS.md）→ 改写该文件的对应小节
 *
 * 为什么需要它（2026-09-17）：这两份副本原先靠**手工同步**。权威源改一行
 * （ghproxy.com → gh-proxy.com），三端不会自动跟，health_check 一直 FAIL 而没人看。
 * 加了这个渲染器，canonical 改动随 tick 的 render 阶段自动落到各端。
 *
 * 本机附加内容（不在 canonical 断言内）：写 ~/.config/opencode/CN-MIRROR.local.md，
 * 渲染时原样追加到 CN-MIRROR.md 末尾；该文件是机器本地文件，不入 git。
 *
 * 用法：
 *   node render_conventions.mjs            # 渲染写入
 *   node render_conventions.mjs --audit    # 只报告偏差，不写文件
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HOME = homedir();
// **引擎根 vs 实例根**（2026-09-17 泛化）：单一源 `docs/conventions.md` 属于**实例**（你的约定文本），
// 渲染目标（opencode / dsh 的 live 文件）是**本机**文件。原地部署时两者同目录；引擎独立部署时用
// $AI_SYNC_ENGINE / $AI_SYNC_INSTANCE 区分。写死某个仓名会让公开引擎在别人机器上找不到东西。
const ENGINE = process.env.AI_SYNC_ENGINE ? join(process.env.AI_SYNC_ENGINE) : join(dirname(fileURLToPath(import.meta.url)), '..');
const AI = process.env.AI_SYNC_INSTANCE ? join(process.env.AI_SYNC_INSTANCE) : ENGINE;
const SRC = join(AI, 'docs', 'conventions.md');

/** 展示用路径：本机绝对路径 → `~/...` 形式（指针句里写进 live 文件的是**真实位置**，不是占位符）。 */
const tilde = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length).replace(/\\/g, '/') : p.replace(/\\/g, '/'));
const SRC_DISPLAY = `${tilde(SRC)}`;
const ENGINE_DISPLAY = tilde(join(ENGINE, 'tools', 'render_conventions.mjs'));
const OC = join(HOME, '.config', 'opencode');
const DSH_AGENTS = join(HOME, '.dsh', 'AGENTS.md');
const audit = process.argv.includes('--audit');
/* --targets-json（2026-09-17 新增）：只打印本渲染器负责的 live 目标清单（供 tools/sync-converge.mjs
 * 组装变更清单用；见 tools/render_agent_files.mjs 同名注释）。布局判定与下面的 targets 段同规则。 */
const targetsJson = process.argv.includes('--targets-json');

/* 本机布局：opencode 侧是「拆分」（CN-MIRROR.md + top-expert.md）还是「合并」（单 AGENTS.md） */
const OC_MIRROR = join(OC, 'CN-MIRROR.md');
const OC_TOPEXP = join(OC, 'top-expert.md');
const OC_AGENTS = join(OC, 'AGENTS.md');

if (targetsJson) {
  const list = [];
  if (existsSync(OC_MIRROR)) list.push({ path: OC_MIRROR, owner: 'opencode', family: 'conventions' });
  if (existsSync(OC_TOPEXP)) list.push({ path: OC_TOPEXP, owner: 'opencode', family: 'conventions' });
  if (!existsSync(OC_MIRROR) && !existsSync(OC_TOPEXP) && existsSync(OC_AGENTS)) {
    list.push({ path: OC_AGENTS, owner: 'opencode', family: 'conventions' });
  }
  if (existsSync(DSH_AGENTS)) list.push({ path: DSH_AGENTS, owner: 'dsh', family: 'conventions' });
  console.log(JSON.stringify({ renderer: 'conventions', targets: list }));
  process.exit(0);
}

const src = readFileSync(SRC, 'utf8');

/** 取 `## §N` 小节正文：**去掉标题行**与末尾的「**派生副本**」清单块（那是元信息，含他机路径） */
function section(n) {
  const start = src.indexOf(`\n## §${n}`);
  if (start === -1) throw new Error(`conventions.md 里找不到 §${n}`);
  const rest = src.slice(start + 1);
  let body = rest.slice(rest.indexOf('\n') + 1);            // 跳过标题行本身
  const nextIdx = body.indexOf('\n## §');
  if (nextIdx !== -1) body = body.slice(0, nextIdx);
  const cut = body.search(/\*\*派生副本\*\*|\*\*副本\*\*/);   // 元信息块起点
  if (cut !== -1) body = body.slice(0, cut);
  body = body.replace(/\n---\s*$/, '');                     // 去掉小节尾部分隔线
  return body.replace(/^\n+/, '').replace(/\s+$/, '') + '\n';
}

const MIRROR_BODY = section(1);
const TOPEXP_BODY = section(2);

/* ---------------- 1/2. 拆分布局：整文件渲染 ---------------- */

/* 指针句里的路径**在渲染期按本机实际位置算**（2026-09-17 定）：
 *   · 写死某个仓名 ⇒ 公开引擎里带个人标识（扫描器会拦）；
 *   · 写占位符 `<实例根>` ⇒ 用户自己的 live 文件里出现一个**不存在的路径**（指针句变假话）。
 * 两者都不行，所以用 tilde 形式渲染出真实位置：本机显示为自己的实例根（如 `~/<实例目录>/...`），别人机器上是各自的。 */
const POINTER_MIRROR =
  `> 权威源：\`${SRC_DISPLAY}#§1\`；修改请改权威源后同步本文件。\n` +
  `> **本副本由 \`${ENGINE_DISPLAY}\` 渲染**——勿手改；机器本地补充写 \`CN-MIRROR.local.md\`。\n`;

const MIRROR_HEADER = `# 国内镜像规则 (China Mirror Policy)\n\n${POINTER_MIRROR}\n以下规则对本会话所有 opencode 常用操作强制生效。\n\n`;
const LOCAL_MIRROR = join(OC, 'CN-MIRROR.local.md');
let localExtra = '';
if (existsSync(LOCAL_MIRROR)) {
  const raw = readFileSync(LOCAL_MIRROR, 'utf8').replace(/\s+$/, '');
  // ⚠️ 本机附加说明里**不能出现 `## ` 级标题**：小节替换（splice）以「下一个 `## `」为边界，
  // 附加说明里的 `## X` 会被当成分节边界 → 每渲染一次就重复追加一份（2026-09-17 实测踩到）。
  // 要分级就用 `### `。这里硬报错，宁可渲染失败也不要静默写坏文件。
  if (/^## /m.test(raw)) {
    throw new Error(`${LOCAL_MIRROR} 含 '## ' 级标题——会破坏小节边界导致重复追加；请改用 '### '`);
  }
  localExtra = '\n' + raw + '\n';
}
const MIRROR_EXPECTED = MIRROR_HEADER + MIRROR_BODY + localExtra;

/* top-expert.md：保留原标题/引言行，正文 = §2 canonical（指针句在 CN-MIRROR.md 与 dsh AGENTS.md 里，
   本文件历史上就是裸正文，不加指针以免多一处要维护的副本） */
const TOPEXP_HEADER = '# Top Expert Rules (global)\n\nGlobal response rules for every session. Follow verbatim; do not weaken or drop them.\n\n';
const TOPEXP_EXPECTED = TOPEXP_HEADER + TOPEXP_BODY;

/* ---------------- 3. 小节替换（dsh AGENTS.md / 合并布局的 opencode AGENTS.md） ---------------- */

/** 把 `## <heading>` 到下一个 `## ` 之间的内容替换为 heading + 指针块 + canonical 正文 */
function splice(text, heading, pointer, body) {
  const i = text.indexOf(heading);
  if (i === -1) return { text, found: false };
  const rest = text.slice(i + heading.length);
  const m = rest.match(/\n## /);
  const tail = m ? rest.slice(m.index) : '';
  const block = `${heading}\n\n${pointer}\n${body}`;
  return { text: text.slice(0, i) + block + tail, found: true };
}

/* 指针句必须与**本机实际布局**一致。
 *  2026-09-17 <机器> 指出：合并布局（opencode 侧只有单个 `AGENTS.md`，没有 CN-MIRROR.md / top-expert.md）
 *  下，渲染出来的指针却写「本段与 `~/.config/opencode/CN-MIRROR.md` 逐字相同」——**那是假话**，
 *  读它的 agent 会去找一个本机不存在的文件。与"注入文件里写不存在路径"是同一类缺陷。
 *  ⇒ 按"同级副本是否存在"选文案，而不是硬编码拆分布局。 */
const hasMirrorSib = existsSync(OC_MIRROR);
const hasTopexpSib = existsSync(OC_TOPEXP);
/* 源码里用 `<实例根>` 占位（这样**引擎源码零个人串**、可公开），
 * 渲染期再填成**本机真实位置**（这样**用户 live 文件里是真路径**，不是假路径）。
 * 两边都要满足：写死仓名 = 泄露；把占位符原样写进 live 文件 = 指针句变假话。 */
const fill = (s) => s.split('<实例根>').join(tilde(AI));
const PTR_MIRROR_LOCAL = fill(hasMirrorSib
  ? '> 权威源：`<实例根>/docs/conventions.md#§1`；修改请改权威源后同步本文件（本段与 `~/.config/opencode/CN-MIRROR.md` 逐字相同，`health_check.py conventions` 会逐条断言）。'
  : '> 权威源：`<实例根>/docs/conventions.md#§1`；修改请改权威源后同步本文件（**本机为合并布局**：opencode 侧无独立 `CN-MIRROR.md`，本段即其载体；`health_check.py conventions` 逐条断言本段内容）。');
const PTR_TOPEXP_LOCAL = fill(hasTopexpSib
  ? '> 权威源：`<实例根>/docs/conventions.md#§2`；本段与 `~/.config/opencode/top-expert.md` 逐字相同（巡检会断言）。'
  : '> 权威源：`<实例根>/docs/conventions.md#§2`；**本机为合并布局**：无独立 `top-expert.md`，本段即其载体（巡检断言本段内容）。');

const targets = [];
/** 找不到小节 = **硬失败**（不是 WARN 后跳过）。
 *  2026-09-17 实测踩到：旧实现只 WARN + continue，于是 expected==actual ⇒ 该文件照样打印 [OK]，
 *  而 canonical 内容早已过期（<机器> 的 dsh AGENTS.md 标题少了「，逐字」，§2 永远不会被更新却一直显示 OK）
 *  —— 这正是"假绿"：渲染器无法 splice 这件事**没有进入任何断言**。现在改成收集失败 + 非零退出。 */
const failures = [];

function planSplice(path, label, sections) {
  if (!existsSync(path)) return;
  let text = readFileSync(path, 'utf8');
  let next = text;
  for (const [heading, ptr, body] of sections) {
    const r = splice(next, heading, ptr, body);
    if (!r.found) {
      failures.push(`${label}: 找不到小节「${heading.trim()}」（标题必须与渲染器期望逐字一致）`);
      continue;
    }
    next = r.text;
  }
  targets.push({ label, path, expected: next, actual: text });
}

if (existsSync(OC_MIRROR)) targets.push({ label: 'opencode CN-MIRROR.md', path: OC_MIRROR, expected: MIRROR_EXPECTED, actual: readFileSync(OC_MIRROR, 'utf8') });
if (existsSync(OC_TOPEXP)) targets.push({ label: 'opencode top-expert.md', path: OC_TOPEXP, expected: TOPEXP_EXPECTED, actual: readFileSync(OC_TOPEXP, 'utf8') });
if (!existsSync(OC_MIRROR) && !existsSync(OC_TOPEXP) && existsSync(OC_AGENTS)) {
  // 合并布局（<机器>）：单 AGENTS.md 里两节
  planSplice(OC_AGENTS, 'opencode AGENTS.md（合并布局）', [
    ['## 国内镜像规则', PTR_MIRROR_LOCAL, MIRROR_BODY + localExtra],
    ['## Top Expert 应答规则（全局强制，逐字）', PTR_TOPEXP_LOCAL, TOPEXP_BODY],
  ]);
}
planSplice(DSH_AGENTS, 'dsh AGENTS.md', [
  ['## 国内镜像规则', PTR_MIRROR_LOCAL, MIRROR_BODY + localExtra],
  ['## Top Expert 应答规则（全局强制，逐字）', PTR_TOPEXP_LOCAL, TOPEXP_BODY],
]);

/* ---------------- report ---------------- */

let dirty = 0;
if (targets.length === 0) {
  console.log('  [WARN] 未找到任何派生副本目标（CN-MIRROR.md / top-expert.md / AGENTS.md 都不存在？）');
}
for (const t of targets) {
  const changed = t.expected !== t.actual;
  if (changed) dirty++;
  console.log(`[${changed ? (audit ? 'DRIFT' : 'WRITTEN') : 'OK'}] ${t.label} -> ${t.path}`);
  if (!audit && changed) writeFileSync(t.path, t.expected, 'utf8');
}
for (const f of failures) console.log(`[FAIL] ${f}`);
console.log(
  (audit ? `audit done: ${dirty} target(s) drifted` : `render done: ${dirty} target(s) written`) +
    (failures.length ? ` + ${failures.length} FAIL (小节缺失，canonical 无法落到该文件)` : ''),
);
// 先写盘再退出：即使有 FAIL，能渲染的部分仍然渲染；非零退出让 tick/CI 看得见
if (failures.length) process.exit(2);
