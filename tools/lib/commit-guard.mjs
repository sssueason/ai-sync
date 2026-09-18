#!/usr/bin/env node
/**
 * commit-guard — 提交前的**唯一**守卫实现（审计条目 EN-8 / EN-16 / PR-4 / X-2 / X-5）
 *
 * 背景（2026-09-18 审计）：三处自动提交（sync-tick.mjs / sync.ps1 / mac-sync.sh）都在
 * `git add -A` 之前不检查工作区状态，于是
 *   · 未合并（autostash 回填撞冲突的残留）→ 冲突标记被提交（vault 真实事故 d404365）
 *   · rebase 停在半途                        → 提交进 detached HEAD
 *   · 机器本地文件（tick-cmd.txt 一类）      → 本机路径推给对端 → 计划任务跑别人的路径（永久乒乓）
 * 本模块把这三类判据收成**一处实现**：
 *   · 判据只看**内容与状态**，不看退出码（git pull --rebase --autostash 撞冲突会返回 0）
 *   · 规则清单 = 纯文本 `sync/commit-guard.rules`（PS / bash 用同一份文件，避免三份清单漂移）
 *
 * 退出码：0 = 可以提交；3 = 拒绝提交（未合并 / rebase 中 / 发现冲突标记）；2 = 用法错误
 * 用法：
 *   node tools/lib/commit-guard.mjs --repo <dir> [--rules <file>] [--apply] [--json]
 *   node tools/lib/commit-guard.mjs --selftest
 */
import { readFileSync, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

/* ---------------------------------------------------------------- 规则（机器本地路径） */

/** 内置兜底规则：实例仓库没有 rules 文件时也要能挡住已知的事故形态 */
export const BUILTIN_RULES = [
  { glob: 'sync/logs/**', why: '同步日志：每轮都变，机器本地' },
  { glob: 'sync/reports/**', why: '同步报告：每轮都变，机器本地' },
  { glob: 'sync/manifests/**', why: '清单基线：绝对路径，机器专属' },
  { glob: 'dist/**', why: '构建/暂存产物：可由源重新生成' },
  { glob: 'node_modules/**', why: '依赖目录：体量巨大且平台相关' },
  { glob: 'sync/local.machine', why: '本机标识：各端不同' },
  { glob: 'sync/state/*-cmd.txt', why: '命令文件：内含本机绝对路径（曾被提交 → 对端计划任务跑别人的路径）' },
  { glob: 'sync/state/.engine-fetch-stamp', why: '远端比对节流戳：每次 fetch 必变' },
  { glob: 'sync/state/.sync.lock', why: '跨平台 tick 的文件锁' },
  { glob: 'sync/state/.last-state-*.json', why: '本机上次状态' },
  { glob: 'sync/state/.last-state-*', why: '本机上次状态（push 戳）' },
  { glob: 'sync/state/.console.pid', why: '控制台 pid：机器本地' },
  { glob: 'sync/state/.console-status.json', why: '控制台快照：机器本地' },
  { glob: 'sync/state/local-*.json', why: 'converge 本机明细' },
  { glob: 'sync/state/hygiene-*.json', why: '每机卫生状态：会被各端反复改写' },
  { glob: 'sync/state/migrations-*.json', why: '每机迁移状态' },
  { glob: 'sync/state/apply-*.json', why: '每机 apply 状态' },
  { glob: 'sync/state/triage-*.json', why: '每机分诊状态（含诊断事实）' },
  { glob: 'sync/state/ops-bundle-*.json', why: '每机诊断包状态' },
  { glob: 'sync/state/watched-*.json', why: '每机监视状态' },
  // 例外（**刻意提交**，见 sync/state/README.md 的契约）：tick-<machine>.json 与 README.md
  { glob: '*.local-*-*.md', why: '冲突侧车：只应存在于工作区' },
  { glob: 'settings.yaml', why: '工具自写的 live 配置：各端各写会 ping-pong' },
  { glob: 'opencode.jsonc', why: '工具自写的 live 配置' },
  { glob: 'cordis.patch.yml', why: '工具自写的 live 配置（**仅限实例仓**；插件源码仓不受此约束）' },
];

export function loadRules(file) {
  if (!file || !existsSync(file)) return { rules: BUILTIN_RULES, source: 'builtin' };
  const out = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [glob, ...rest] = line.split('#');
    const g = glob.trim();
    if (!g) continue;
    out.push({ glob: g, why: rest.join('#').trim() || '机器本地/产物类路径' });
  }
  return out.length ? { rules: out, source: file } : { rules: BUILTIN_RULES, source: 'builtin(空文件)' };
}

/** 代码面清单（保护路径，见 sync/protected-paths.rules）。与 loadRules 的关键区别：
 *  **缺失时返回空**（= 不启用该门）—— "代码提交权归 home" 是实例策略；公开引擎用户没有 home 概念，
 *  不该被误启用（缺失即静默跳过，但调用方会记 NOTE）。 */
export function loadProtected(file) {
  if (!file || !existsSync(file)) return { rules: [], source: 'none' };
  const out = [];
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [glob, ...rest] = line.split('#');
    const g = glob.trim();
    if (g) out.push({ glob: g, why: rest.join('#').trim() || '代码面（需 home 审核）' });
  }
  return { rules: out, source: file };
}

const globToRe = (g) => {
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$', 'i');
};

export function makeMatcher(rules) {
  const compiled = rules.map((r) => ({ ...r, re: globToRe(r.glob) }));
  return (rel) => {
    const p = String(rel || '').replace(/\\/g, '/');
    for (const r of compiled) if (r.re.test(p)) return r;
    return null;
  };
}

/* ---------------------------------------------------------------- git 只读探测 */

function git(repo, args) {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out || '').trim() };
  } catch (e) {
    return { ok: false, out: String((e && (e.stdout || e.message)) || '').trim() };
  }
}

/** 不做 trim 的 git：`status --porcelain -z` 的行首是**有意义的空格**（暂存列），
 *  trim 会把 ` M path` 变成 `M path`，随后 slice(3) 切出错位路径 —— 2026-09-18 自检实测踩到。 */
function gitRaw(repo, args) {
  try {
    const out = execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, out: String(out || '') };
  } catch (e) {
    return { ok: false, out: String((e && (e.stdout || '')) || '') };
  }
}

const MARKER = /^(<{7} |>{7} |<{7}$|>{7}$|\|{7} )/;

/** 扫描"将被提交的文件"里是否有冲突标记 */
function scanMarkers(repo, rels) {
  const hits = [];
  for (const rel of rels) {
    const abs = join(repo, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size === 0 || st.size > 4 * 1024 * 1024) continue;
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue; // 二进制
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('<<<<<<< ') || l.startsWith('>>>>>>> ') || l === '<<<<<<<' || l === '>>>>>>>' || l.startsWith('||||||| ')) {
        hits.push({ rel, line: i + 1, text: l.slice(0, 40) });
        break;
      }
    }
  }
  return hits;
}

/**
 * 评估一个仓库是否可以提交。
 * @returns {{ok:boolean,repo:string,refuse:Array,unstaged:Array,staged:Array,markers:Array,notes:Array}}
 */
export function assessWorktree(repo, { rules = BUILTIN_RULES, apply = false, protected: protectedRules = [], machine = '', homeMachine = '' } = {}) {
  const isLocal = makeMatcher(rules);
  const refuse = [];
  const notes = [];

  if (!existsSync(join(repo, '.git'))) {
    return { ok: false, repo, refuse: [{ code: 'not-a-repo', detail: '不是 git 仓库' }], unstaged: [], staged: [], markers: [], notes };
  }

  // 判据 1：未合并路径（git pull --rebase --autostash 在 autostash 回填撞冲突时**返回 0**，
  // 所以必须看 ls-files -u，不能看退出码）
  const un = git(repo, ['ls-files', '-u']);
  const unmerged = un.ok ? un.out.split(/\r?\n/).filter(Boolean) : [];
  if (unmerged.length) refuse.push({ code: 'unmerged', detail: `${unmerged.length} 条未合并路径（冲突标记可能正在工作区里）`, paths: [...new Set(unmerged.map((l) => l.split('\t').pop()))].slice(0, 10) });

  // 判据 2：rebase 停在半途
  const rebasing = existsSync(join(repo, '.git', 'rebase-merge')) || existsSync(join(repo, '.git', 'rebase-apply'));
  if (rebasing) refuse.push({ code: 'rebasing', detail: 'rebase 停在半途（detached HEAD + 未解冲突）→ 必须先人工处理' });

  // 变更清单（含未跟踪）——用于标记扫描与机器本地判定。
  // 注意：必须用 gitRaw（不 trim）——porcelain 行首可能是空格（暂存列为空），trim 会错位切片。
  const st = gitRaw(repo, ['status', '--porcelain', '-z']);
  let rels = [];
  if (st.ok && st.out) {
    rels = st.out.split('\u0000').filter(Boolean)
      .map((chunk) => chunk.length > 3 ? chunk.slice(3) : '')
      .filter(Boolean)
      .filter((p) => !p.startsWith('.git/'));
  }

  // 判据 3：将被提交的文件里有冲突标记
  const markers = scanMarkers(repo, rels);
  const unstagedOnRefuse = [];
  if (markers.length) {
    refuse.push({
      code: 'conflict-markers',
      detail: `${markers.length} 个文件含行首冲突标记（提交即把标记写进版本库，vault d404365 事故形态）`,
      paths: markers.map((m) => `${m.rel}:${m.line}`).slice(0, 10),
      restore: '还原用 `git checkout HEAD -- <file>` —— `git checkout -- <file>` 会从**索引**取到含标记的版本（mac 侧 2026-09-18 实测踩到）',
    });
    // F2（mac 侧反馈）：拒绝时若把带标记的文件留在**暂存区**，人工用 `git checkout -- <file>` 还原会
    // 从索引取回含标记的版本 ⇒ 看着还原了其实没有。这里把它们移出暂存区（等于回到 add -A 之前）。
    // 只在**没有未合并条目**时做：unmerged 状态下 `git reset -- <path>` 会把冲突决议成 HEAD，是破坏性的。
    if (apply && unmerged.length === 0) {
      for (const m of markers) { if (git(repo, ['reset', '-q', '--', m.rel]).ok) unstagedOnRefuse.push(m.rel); }
    }
  }

  // 判据 5（治理，用户裁决 2026-09-18 → 审计 EN-1）：**代码面提交权归 home**。
  // 非 home 机器提交时把代码路径**移出暂存区**（其余文件照常提交 ⇒ 不阻塞日常同步），并回报 `[REVIEW]`；
  // home 提交则只记 NOTE（可审计）。真正的强制在平台侧（对端只读凭据），这里是第二道。
  let codeReviewPaths = [];
  if (protectedRules.length) {
    const stagedList = git(repo, ['diff', '--cached', '--name-only']);
    const stagedPaths = stagedList.ok ? stagedList.out.split(/\r?\n/).filter(Boolean) : [];
    if (!machine || !homeMachine) {
      // 机器标识或 home 未配 ⇒ **不启用该门**（公开引擎用户没有 home 概念；硬编码真机名会被发布门禁拦）。
      // 注意：宁可不启用也不能"把 home 当对端"——那会让 home 自己也提交不了代码，等于自锁。
      notes.push('[REVIEW] 未启用代码路径审核门（缺 machine 或 homeMachine；由 instance.json 的 governance.homeMachine 提供）');
    } else if (machine !== homeMachine) {
      const isProtected = makeMatcher(protectedRules);
      codeReviewPaths = stagedPaths.filter((p) => isProtected(p));
      if (codeReviewPaths.length) {
        if (apply) for (const p of codeReviewPaths) git(repo, ['reset', '-q', '--', p]);
        notes.push(`[REVIEW] 代码路径已移出暂存区（本机 ${machine} 无提交权，需 ${homeMachine} 审核后落）：${codeReviewPaths.slice(0, 8).join(', ')}${codeReviewPaths.length > 8 ? ' …' : ''}`);
      }
    } else {
      const isProtected = makeMatcher(protectedRules);
      const hits = stagedPaths.filter((p) => isProtected(p));
      if (hits.length) notes.push(`[REVIEW] home 正在提交代码路径 ${hits.length} 个（可审计）：${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ' …' : ''}`);
    }
  }

  // 判据 4：机器本地文件 —— 不拒绝提交，但**移出暂存区**（否则本机路径推给对端）。
  // 额外区分 inHead：**已进入 HEAD 的机器本地文件**（如 mirror-spec.json）是另一类问题——
  // 只 unstage 治不了本（下一轮 install --register 改写它 → 又出现），必须 `git rm --cached` + 进 .gitignore。
  const localHits = rels.filter((p) => isLocal(p));
  const machineLocal = [];
  const needsGitRm = [];
  if (localHits.length) {
    for (const p of localHits) {
      const inHead = git(repo, ['cat-file', '-e', `HEAD:${p}`]).ok;
      const entry = { path: p, why: isLocal(p)?.why || '', inHead };
      if (apply) entry.unstaged = git(repo, ['reset', '-q', '--', p]).ok;
      machineLocal.push(entry);
      if (inHead) needsGitRm.push(p);
    }
    notes.push(`机器本地文件 ${localHits.length} 个已移出暂存区：${localHits.slice(0, 6).join(', ')}${localHits.length > 6 ? ' …' : ''}`);
    if (needsGitRm.length) {
      notes.push(`[TRACKED] 这些机器本地文件**已在版本库里**（只 unstage 治不了本，下一轮还会出现）：${needsGitRm.slice(0, 6).join(', ')} → 应 \`git rm --cached\` 并写入 .gitignore 与 sync/commit-guard.rules`);
    }
  }

  return { ok: refuse.length === 0, repo, refuse, machineLocal, needsGitRm, markers, notes, unstagedOnRefuse, codeReviewPaths, localHits: localHits.length };
}

/* ---------------------------------------------------------------- CLI */

function main() {
  const argv = process.argv.slice(2);
  const has = (f) => argv.includes(f);
  const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

  if (has('--selftest')) return selftest();

  const repo = resolve(val('--repo') || '.');
  const rulesFile = val('--rules', null);
  const protFile = val('--protected', null);
  const machine = val('--machine', process.env.DSH_MACHINE || '');
  const homeMachine = val('--home-machine', '');
  const { rules, source } = loadRules(rulesFile);
  const { rules: protRules, source: protSource } = loadProtected(protFile);
  const r = assessWorktree(repo, { rules, apply: has('--apply'), protected: protRules, machine, homeMachine });
  if (has('--json')) {
    console.log(JSON.stringify({ ...r, rulesSource: source, rulesCount: rules.length, protectedSource: protSource, protectedCount: protRules.length, machine, homeMachine }, null, 2));
  } else {
    if (!r.ok) for (const f of r.refuse) {
      console.log(`[REFUSE] ${f.code}: ${f.detail}${f.paths ? ' :: ' + f.paths.join(', ') : ''}`);
      if (f.restore) console.log(`         ${f.restore}`);
    }
    for (const p of r.unstagedOnRefuse || []) console.log(`[UNSTAGED] ${p}（已移出暂存区；工作区文件保持不变 = 回到 add -A 之前）`);
    for (const n of r.notes) console.log(`[NOTE] ${n}`);
    if (r.ok) console.log('[OK] 工作区可提交');
  }
  process.exitCode = r.ok ? 0 : 3;
}

/* ---------------------------------------------------------------- 注入型自检 */

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}
function scratch() {
  const d = mkdtempSync(join(tmpdir(), 'commit-guard-'));
  sh(d, ['init', '-q', '.']);
  // F1（mac 侧反馈 2026-09-18）：初始分支名取决于全局 `init.defaultBranch`（mac 上是 main）
  // ⇒ 自检里写死的 `git checkout master` 会失败 ⇒ 场景根本没建起来却报 FAIL（**假红**）。
  // 用 symbolic-ref 显式钉住分支名，与全局配置无关（symbolic-ref 比 `init -b` 兼容面更宽）。
  try { sh(d, ['symbolic-ref', 'HEAD', 'refs/heads/master']); } catch {}
  sh(d, ['config', 'user.email', 't@t']);
  sh(d, ['config', 'user.name', 't']);
  return d;
}
function commitAll(d, msg) {
  sh(d, ['add', '-A']);
  sh(d, ['commit', '-q', '-m', msg]);
}

export function selftest() {
  const results = [];
  const t = (name, fn) => {
    let dir = null;
    try {
      dir = fn();
      results.push({ name, pass: true, dir });
    } catch (e) {
      results.push({ name, pass: false, why: e.message });
    }
  };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  // 1) 干净仓库 → 可提交
  t('clean-repo-allows', () => {
    const d = scratch();
    writeFileSync(join(d, 'a.md'), 'hello\n');
    sh(d, ['add', '-A']);
    const r = assessWorktree(d, { apply: true });
    assert(r.ok === true, '干净仓库被判拒绝: ' + JSON.stringify(r.refuse));
    return d;
  });

  // 2) 未合并（三方冲突）→ 拒绝
  t('unmerged-refuses', () => {
    const d = scratch();
    writeFileSync(join(d, 'a.md'), 'line1\nline2\n');
    commitAll(d, 'base');
    sh(d, ['checkout', '-q', '-b', 'side']);
    writeFileSync(join(d, 'a.md'), 'line1\nSIDE\n');
    commitAll(d, 'side');
    sh(d, ['checkout', '-q', 'master']);
    writeFileSync(join(d, 'a.md'), 'line1\nMAIN\n');
    commitAll(d, 'main');
    try { sh(d, ['merge', 'side']); } catch { /* 冲突 */ }
    const r = assessWorktree(d, { apply: true });
    assert(r.ok === false, '未合并却允许提交');
    assert(r.refuse.some((f) => f.code === 'unmerged'), '缺 unmerged 判据: ' + JSON.stringify(r.refuse));
    assert(r.refuse.some((f) => f.code === 'conflict-markers'), '缺冲突标记判据: ' + JSON.stringify(r.refuse));
    return d;
  });

  // 3) 仅冲突标记（未合并已解、标记残留）→ 拒绝
  t('leftover-markers-refuse', () => {
    const d = scratch();
    writeFileSync(join(d, 'log.md'), 'a\n');
    commitAll(d, 'base');
    writeFileSync(join(d, 'log.md'), 'a\n<<<<<<< Updated upstream\nX\n=======\nY\n>>>>>>> Stashed changes\n');
    const r = assessWorktree(d, { apply: true });
    assert(r.ok === false, '带残留标记却允许提交');
    assert(r.markers.length === 1 && r.markers[0].line === 2, '标记定位错误: ' + JSON.stringify(r.markers));
    return d;
  });

  // 4) 机器本地文件 → 移出暂存区、但不拒绝提交（模拟 tick 的真实顺序：先 add -A，再守卫）
  t('machine-local-unstaged', () => {
    const d = scratch();
    writeFileSync(join(d, 'keep.md'), 'k\n');
    writeFileSync(join(d, 'tick-cmd.txt'), 'C:\\Users\\x\\.ai-sync\\engine\n');
    sh(d, ['add', '-A']); // tick 会先 add -A，守卫再把它移出去
    const rules = [{ glob: '*-cmd.txt', why: '命令文件' }];
    const r = assessWorktree(d, { rules, apply: true });
    assert(r.ok === true, '机器本地文件不应导致拒绝提交');
    assert(r.machineLocal.length === 1 && r.machineLocal[0].path === 'tick-cmd.txt', '未识别机器本地文件: ' + JSON.stringify(r.machineLocal));
    assert(r.machineLocal[0].unstaged === true, '未把机器本地文件移出暂存区');
    assert(r.machineLocal[0].inHead === false, '新文件不该被判为 inHead');
    assert(r.needsGitRm.length === 0, '新文件不该进 needsGitRm');
    const cached = sh(d, ['diff', '--cached', '--name-only']).trim();
    assert(cached === 'keep.md', '暂存区应只剩 keep.md，实际: ' + cached);
    return d;
  });

  // 5) 已跟踪的机器本地文件（改一次就出现）→ 同样移出暂存区
  t('tracked-machine-local-unstaged', () => {
    const d = scratch();
    writeFileSync(join(d, 'mirror-spec.json'), '{\n  "a": 1\n}\n');
    commitAll(d, 'base');
    writeFileSync(join(d, 'mirror-spec.json'), '{\n  "a": 2\n}\n');
    sh(d, ['add', '-A']);
    const rules = [{ glob: 'mirror-spec.json', why: '每机状态' }];
    const r = assessWorktree(d, { rules, apply: true });
    assert(r.ok === true, '不应拒绝提交');
    assert(r.machineLocal.length === 1 && r.machineLocal[0].inHead === true, '未识别已跟踪的机器本地文件: ' + JSON.stringify(r.machineLocal));
    assert(r.needsGitRm.length === 1 && r.needsGitRm[0] === 'mirror-spec.json', '未提示 git rm --cached: ' + JSON.stringify(r.needsGitRm));
    const cached = sh(d, ['diff', '--cached', '--name-only']).trim();
    assert(cached === '', '暂存区应为空，实际: ' + cached);
    return d;
  });

  // 6) 内置规则必须覆盖已知事故形态（**刻意用中性占位机器名**：本文件随公开引擎发布，
  //    写真实机器名会被发布门禁的"个人串"规则命中 —— 2026-09-18 实测被拦过一次）
  t('builtin-rules-cover-incidents', () => {
    const m = makeMatcher(BUILTIN_RULES);
    assert(!!m('sync/state/tick-cmd.txt'), 'tick-cmd.txt 未被覆盖（3c5343a 事故）');
    assert(!!m('sync/state/mirror-cmd.txt'), 'mirror-cmd.txt 未被覆盖');
    assert(!!m('sync/state/hygiene-example.json'), 'hygiene-*.json 未被覆盖');
    assert(!!m('sync/state/triage-example.json'), 'triage-*.json 未被覆盖');
    assert(!m('sync/state/tick-example.json'), 'tick-<machine>.json 是**刻意提交**的，不应被拦（见 state/README.md）');
    assert(!m('sync/state/README.md'), 'state/README.md 是刻意提交的，不应被拦');
    assert(!m('tools/sync-tick.mjs'), '正常源码被误拦');
    return null;
  });

  // 7) 治理门（用户裁决 2026-09-18 / 审计 EN-1）：非 home 机器不能提交代码面；home 可以
  t('protected-code-path-gate', () => {
    const d = scratch();
    mkdirSync(join(d, 'tools'), { recursive: true });
    mkdirSync(join(d, 'wiki'), { recursive: true });
    writeFileSync(join(d, 'tools', 'x.mjs'), 'x\n');
    writeFileSync(join(d, 'wiki', 'note.md'), 'n\n');
    sh(d, ['add', '-A']);
    const prot = [{ glob: 'tools/**', why: '代码面' }, { glob: 'sync/**', why: '代码面' }];
    const asPeer = assessWorktree(d, { rules: BUILTIN_RULES, protected: prot, machine: 'peer-box', homeMachine: 'home-box', apply: true });
    assert(asPeer.ok === true, '非 home 提交代码**不应阻塞**其余文件（应只移出代码路径）');
    assert(asPeer.codeReviewPaths.includes('tools/x.mjs'), '未识别代码路径：' + JSON.stringify(asPeer.codeReviewPaths));
    const staged = sh(d, ['diff', '--cached', '--name-only']).trim().split(/\r?\n/).filter(Boolean);
    assert(staged.includes('wiki/note.md'), '共享文件应仍在暂存区：' + staged.join(','));
    assert(!staged.includes('tools/x.mjs'), '代码路径未移出暂存区：' + staged.join(','));
    const asHome = assessWorktree(d, { rules: BUILTIN_RULES, protected: prot, machine: 'home-box', homeMachine: 'home-box' });
    assert(asHome.ok === true, 'home 提交代码被误拦');
    assert((asHome.codeReviewPaths || []).length === 0, 'home 不该被判为需审核');
    return d;
  });

  const pass = results.filter((r) => r.pass).length;
  for (const r of results) console.log(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.pass ? '' : ' :: ' + r.why}`);
  for (const r of results) if (r.dir) { try { rmSync(r.dir, { recursive: true, force: true }); } catch {} }
  console.log(`SELFTEST: ${pass}/${results.length} 通过`);
  process.exitCode = pass === results.length ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
