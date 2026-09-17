#!/usr/bin/env node
/**
 * render_agent_files.mjs — 把「双机协作」注入块渲染进四端指令文件（幂等）
 *
 * 单一源：<实例根>/agents/injection-block.md（含 ${MACHINE} / ${VAULT_PATH} 占位符）
 * 目标：
 *   1. ~/.dsh/AGENTS.md                        （dsh）
 *   2. ~/.config/opencode/MEMORY-POINTER.md    （opencode / Claudian / Lody 共用入口）
 *   3. ~/.workbuddy/USER.md                    （WorkBuddy）
 *   4. <vault>/AGENTS.md                       （vault 内会话自动加载）
 *
 * 渲染规则（幂等）：
 *   - 若目标已含标记块 `<!-- ai-shared-managed: injection BEGIN/END -->` → 整块替换
 *   - 若没有标记但存在**旧的手工块**（见 LEGACY_HEADINGS）→ 从该标题替换到下一个 `## ` 或文件末尾
 *     （2026-09-16 迁移用：早期是人工粘贴的无标记块，校园机实测根本没贴成功）
 *   - 都没有 → 追加到文件末尾
 *
 * ⚠️ **受管块之后的尾部内容是"用户内容"，渲染器刻意原样保留**（2026-09-17 实测）：
 *    如果往单一源末尾追加东西（例如测试标记），它会随块一起落到各端、并**粘在块之后**——
 *    之后即使从单一源删掉，各端也不会自动消失（渲染器认为那是用户自己写的内容）。
 *    要清就得在各端 live 文件里手工删掉。⇒ 别拿单一源当临时便签。
 *
 * 用法：
 *   node render_agent_files.mjs            # 渲染写入
 *   node render_agent_files.mjs --audit    # 只报告偏差，不写文件
 *   node render_agent_files.mjs --verbose  # 打印每个目标的动作
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';

const HOME = homedir();
const HERE = dirname(fileURLToPath(import.meta.url));
// **引擎根 vs 实例根**（2026-09-17 泛化）：本文件属于引擎（代码），而它读写的**源**与**目标**
// 大多属于实例（`agents/injection-block.md`、`machines/<机器>.json`、各 agent 的 live 文件）。
// 原地部署时两者同目录；引擎独立部署时用 $AI_SYNC_ENGINE / $AI_SYNC_INSTANCE 区分。
// 写死 `<实例根>` 会让公开引擎在别人机器上找不到东西——所以这里一律动态解析。
const ENGINE = process.env.AI_SYNC_ENGINE ? join(process.env.AI_SYNC_ENGINE) : join(HERE, '..');
const AI = process.env.AI_SYNC_INSTANCE ? join(process.env.AI_SYNC_INSTANCE) : ENGINE;
const SRC = join(AI, 'agents', 'injection-block.md');
const BEGIN = '<!-- ai-shared-managed: injection BEGIN -->';
const END = '<!-- ai-shared-managed: injection END -->';
const audit = process.argv.includes('--audit');
const verbose = process.argv.includes('--verbose');
/* --targets-json（2026-09-17 新增）：只打印本渲染器负责的 live 目标清单，**不做任何写盘**。
 * 用途：tools/sync-converge.mjs 据此组装"哪份 live 配置变了"的清单 —— 目标清单的单一源就在这里，
 * 不在 converge 里再抄一份路径表（抄一份就会漂）。存在性判定与下面的写入循环同规则。 */
const targetsJson = process.argv.includes('--targets-json');

/* ---- 机器标识：与 sync/_load.ps1 同源 ---- */
const machine = (() => {
  if (process.env.DSH_MACHINE) return process.env.DSH_MACHINE;
  const lm = join(AI, 'sync', 'local.machine');
  if (existsSync(lm)) return readFileSync(lm, 'utf8').trim();
  return hostname().toLowerCase();
})();

/* ---- vault 路径：取该机 machines/<machine>.json 里 id=vault 的 path ----
 * 2026-09-17 TR6（照文档在全新机器上走）实测：把"没有 vault 条目"当硬错误，会让**不用 vault 的用户**
 * 在第一条命令就失败。vault 只是第四个**可选**目标 ⇒ 没配置就显式跳过（打印 [--]），
 * 而"配了却解析不了"仍是硬错误（exit 2）。两者必须区分，否则不是假绿就是假红。 */
const machineCfg = join(AI, 'sync', 'machines', `${machine}.json`);
let vaultPath = null;
let vaultNote = '';
if (existsSync(machineCfg)) {
  try {
    const s = JSON.parse(readFileSync(machineCfg, 'utf8')).mu1?.find((x) => x.id === 'vault');
    if (s?.path) vaultPath = s.path.startsWith('~/') ? join(HOME, s.path.slice(2)) : s.path;
    else vaultNote = `${machineCfg} 无 mu1[id=vault] → 跳过 vault 目标（vault 是可选项）`;
  } catch (e) {
    console.error(`[FAIL] 机器配置解析失败 ${machineCfg}: ${e.message}`);
    process.exit(2);
  }
} else {
  vaultNote = `缺机器配置 ${machineCfg} → 跳过 vault 目标（新机/单机模式的正常情形）`;
}

// 契约（2026-09-17 TR6 实测）：源不存在时原先 exit 1 且无输出 ⇒ tick 变 rc=2、converge 报"输出不是 JSON"。
// ⇒ `--targets-json` 必须**任何时候**都输出合法 JSON（缺源 = 空清单），渲染路径打印 [--] 后正常退出。
if (!existsSync(SRC)) {
  if (targetsJson) {
    console.log(JSON.stringify({ renderer: 'agentFiles', targets: [] }));
    process.exit(0);
  }
  console.log(`[--] 无 ${SRC}（实例还没写注入块源）→ 跳过渲染`);
  process.exit(0);
}
const block = readFileSync(SRC, 'utf8').trimEnd() + '\n';

/* 两种渲染模式：
 *   local   —— 机器本地文件（~/.dsh、~/.config/opencode、~/.workbuddy）：写具体机器名与路径
 *   neutral —— 共享文件（<vault>/AGENTS.md，进 git）：**不得含任何机器专属值**，
 *              否则两台机器各自渲染 → 互相改写 → 无限 ping-pong、仓库永远 dirty
 *              （2026-09-16 实测踩到：<机器> 渲染后推送，<机器> 渲染即产生 diff）
 */
const substitute = (text, isNeutral) =>
  isNeutral
    ? text
        .replace(/\$\{MACHINE\}/g, '<machine>')
        .replace(/\$\{VAULT_PATH\}/g, '<vault>')
    : text
        .replace(/\$\{MACHINE\}/g, machine)
        .replace(/\$\{VAULT_PATH\}/g, vaultPath);

const blockLocal = substitute(block, false);
const blockNeutral = substitute(block, true);

/* 旧手工块标题（迁移用；命中即整段替换） */
const LEGACY_HEADINGS = [
  '## 双机协作（<机器> / <机器>）',
  '## Machine Dimension（双机协作）',
  '## 双机协作',
];

const TARGETS = [
  { name: 'dsh AGENTS.md', path: join(HOME, '.dsh', 'AGENTS.md'), owner: 'dsh', family: 'agentFiles' },
  { name: 'opencode MEMORY-POINTER.md', path: join(HOME, '.config', 'opencode', 'MEMORY-POINTER.md'), owner: 'opencode', family: 'agentFiles' },
  { name: 'WorkBuddy USER.md', path: join(HOME, '.workbuddy', 'USER.md'), owner: 'workbuddy', family: 'agentFiles' },
  // vault 目标只在真的配了 vault 时才存在（见上面 vaultNote）
  ...(vaultPath ? [{ name: 'vault AGENTS.md', path: join(vaultPath, 'AGENTS.md'), neutral: true, owner: 'vault', family: 'agentFiles' }] : []),
];
if (!vaultPath) console.log(`[--] ${vaultNote}`);

if (targetsJson) {
  console.log(JSON.stringify({
    renderer: 'agentFiles',
    targets: TARGETS.filter((t) => existsSync(t.path)).map((t) => ({ path: t.path, owner: t.owner, family: t.family })),
  }));
  process.exit(0);
}

function renderInto(text, block) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b !== -1 && e !== -1) {
    const rest = text.slice(e + END.length);
    // 标记块位于文件末尾时，剩余部分只有空白 → 丢弃（否则每次渲染都会多补一个换行，破坏幂等）
    const next = rest.trim() === '' ? text.slice(0, b) + block : text.slice(0, b) + block + rest.replace(/^\n*/, '\n');
    return { next, action: 'replace-marked' };
  }
  for (const h of LEGACY_HEADINGS) {
    const i = text.indexOf(h);
    if (i === -1) continue;
    const rest = text.slice(i + h.length);
    const m = rest.match(/\n## /);           // 到下一个二级标题
    const tail = m ? rest.slice(m.index) : '';
    return { next: text.slice(0, i) + block + (tail ? tail.replace(/^\n*/, '\n') : ''), action: `migrate-legacy(${h})` };
  }
  return { next: text.trimEnd() + '\n\n' + block, action: 'append' };
}

let changed = 0;
for (const t of TARGETS) {
  if (!existsSync(t.path)) {
    console.log(`[MISS] ${t.name} -> ${t.path}（文件不存在，跳过）`);
    continue;
  }
  const text = readFileSync(t.path, 'utf8');
  const { next, action } = renderInto(text, t.neutral ? blockNeutral : blockLocal);
  const isSame = next === text;
  if (!isSame) changed++;
  console.log(`[${isSame ? 'OK' : audit ? 'DRIFT' : 'WRITTEN'}] ${t.name}${verbose || !isSame ? ` (${action})` : ''} -> ${t.path}`);
  if (!audit && !isSame) {
    mkdirSync(dirname(t.path), { recursive: true });
    writeFileSync(t.path, next, 'utf8');
  }
}
console.log(`machine=${machine} vault=${vaultPath}`);
console.log(audit ? `audit done: ${changed} target(s) drifted` : `render done: ${changed} target(s) written`);
process.exit(0);
