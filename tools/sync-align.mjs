#!/usr/bin/env node
/**
 * sync-align.mjs — 初始化对齐：**先看后做**（plan → 人确认 → apply）
 *
 * 为什么单列一个工具：首次接入一台机器（或大改动之后）需要"让两边收敛"，而这涉及三类动作：
 *   µ1：git 两仓的 pull/push（幂等，风险低）
 *   µ2 出：本机权威树 → 云端镜像（seed）
 *   µ2 入：云端镜像 → 本机权威树（tree-sync，**三方合并；冲突按 mtime 胜 + 败者落侧车**）
 * 其中只有 µ2 入会改动本地文件，所以**默认只报告**；`--apply` 才动手，且动手前把计划原样打印出来。
 * 复用的是既有、已实测的脚本（tree-sync.ps1 / seed-mu2.ps1），本工具不重写合并逻辑。
 *
 * 用法：
 *   node tools/sync-align.mjs [--instance <dir>] [--plan|--apply] [--set <id>] [--json] [--quiet]
 *   默认 = --plan。退出码：0=无待处理；2=有待拉/冲突（plan 模式）；3=apply 出错。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(process.env.AI_SYNC_ENGINE || join(HERE, '..'));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);
const APPLY = has('--apply');
const JSON_OUT = has('--json');
const QUIET = has('--quiet');
const SET = val('--set');
const say = (m) => {
  if (!QUIET && !JSON_OUT) console.log('   ' + m);
};

const machine =
  process.env.AI_SYNC_MACHINE ||
  process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim() : hostname().toLowerCase());

let cfg = {};
try {
  cfg = JSON.parse(readFileSync(join(INSTANCE, 'sync', 'instance.json'), 'utf8'));
} catch {}
let mc = {};
try {
  mc = JSON.parse(readFileSync(join(INSTANCE, 'sync', 'machines', `${machine}.json`), 'utf8'));
} catch {}

const expand = (p) => (!p ? p : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);
const pwsh =
  process.platform === 'win32'
    ? spawnSync('where', ['pwsh'], { encoding: 'utf8' }).status === 0
      ? 'pwsh'
      : 'powershell'
    : 'pwsh';

const plan = { machine, phase: APPLY ? 'apply' : 'plan', repos: [], mirror: null, notes: [], failures: [] };

/* ---------------- µ1：两仓 ahead/behind ---------------- */

for (const r of mc.mu1 || []) {
  if (!r.repo) continue;
  const path = expand(r.path);
  const rec = { id: r.id, path, exists: existsSync(join(path, '.git')), ahead: null, behind: null, dirty: null };
  if (rec.exists) {
    const g = (args) => {
      try {
        return spawnSync('git', ['-C', path, ...args], { encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
      } catch {
        return '';
      }
    };
    g(['fetch', '-q', 'origin']);
    const br = g(['rev-parse', '--abbrev-ref', 'HEAD']);
    const ab = g(['rev-list', '--left-right', '--count', `origin/${br}...HEAD`]).split(/\s+/).map(Number);
    rec.behind = ab[0];
    rec.ahead = ab[1];
    rec.dirty = g(['status', '--porcelain']).split('\n').filter(Boolean).length;
  } else {
    plan.notes.push(`仓库 ${r.id} 尚不是 git 仓（${path}）`);
  }
  plan.repos.push(rec);
}

/* ---------------- µ2：镜像（plan 用 tree-sync 报告模式；apply 才动手） ---------------- */

const mu2On = !!(mc.mu2 && mc.mu2.autoSeed !== false);
if (!mu2On) {
  plan.notes.push('本机未启用 µ2 镜像（machines/<machine>.json 的 mu2）→ 只做 git 对齐');
} else {
  const treeSync = join(INSTANCE, 'sync', 'tree-sync.ps1');
  const seed = join(INSTANCE, 'sync', 'seed-mu2.ps1');
  const runTreeSync = (apply) => {
    const args = ['-NoProfile', '-File', treeSync];
    if (SET) args.push('-Set', SET);
    if (apply) args.push('-Apply');
    const r = spawnSync(pwsh, args, { encoding: 'utf8', windowsHide: true, timeout: 30 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
    const out = (r.stdout || '') + (r.stderr || '');
    const m = /RESULT: push=(\d+) pull=(\d+) conflict=(\d+) same=(\d+) apply=(\w+) rc=(\d+)/.exec(out);
    return {
      rc: r.status,
      push: m ? Number(m[1]) : null,
      pull: m ? Number(m[2]) : null,
      conflict: m ? Number(m[3]) : null,
      same: m ? Number(m[4]) : null,
      tail: out.trim().split(/\r?\n/).slice(-6),
    };
  };

  const before = runTreeSync(false);
  plan.mirror = { phase: 'plan', ...before };
  if (before.push === null) {
    plan.failures.push(`tree-sync 未产出 RESULT 行（退出码 ${before.rc}）→ 无法判定镜像状态`);
  } else {
    say(`镜像（计划）：待推 ${before.push} · 待拉 ${before.pull} · 冲突 ${before.conflict} · 一致 ${before.same}`);
  }

  if (APPLY) {
    // 顺序与 daily.ps1 一致：先入（tree-sync -Apply）再出（seed）
    const applied = runTreeSync(true);
    plan.mirror = { plan: before, apply: applied };
    if (applied.conflict > 0) {
      plan.notes.push(`镜像合并有 ${applied.conflict} 处冲突：败者已另存为 <名>.local-${machine}-<日期>（**不删不覆盖**），需要人工看一眼`);
    }
    if (process.platform === 'win32') {
      if (existsSync(seed)) {
        const s = spawnSync(pwsh, ['-NoProfile', '-File', seed], { encoding: 'utf8', windowsHide: true, timeout: 60 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 });
        plan.seed = { rc: s.status, tail: ((s.stdout || '') + (s.stderr || '')).trim().split(/\r?\n/).slice(-4) };
        if (s.status !== 0) plan.failures.push(`seed-mu2 退出码 ${s.status}（本机权威树 → 镜像 未完成）`);
      } else {
        plan.failures.push(`缺 ${seed}`);
      }
    } else {
      // 假绿防线：跳过必须留痕（且说清原因），不能静默
      plan.notes.push('seed 未执行：robocopy 分支只实现于 Windows（macOS 需要 rsync 版，见 docs/mac-setup-guide.md §0）');
    }
  }
}

/* ---------------- 报告 ---------------- */

const pending = (plan.mirror?.pull ?? 0) + (plan.mirror?.conflict ?? 0) + plan.repos.reduce((a, r) => a + (r.behind ?? 0), 0);
const rc = plan.failures.length ? 3 : !APPLY && pending > 0 ? 2 : 0;

if (JSON_OUT) {
  console.log(JSON.stringify({ ...plan, pending, rc }, null, 2));
} else if (!QUIET) {
  console.log(`=== 初始化对齐（${plan.phase === 'apply' ? '执行' : '仅计划'}）· ${machine} ===`);
  for (const r of plan.repos) {
    console.log(`  仓库 ${r.id}: exists=${r.exists} dirty=${r.dirty} behind=${r.behind} ahead=${r.ahead}`);
  }
  if (plan.mirror) {
    const m = plan.mirror.phase === 'plan' ? plan.mirror : plan.mirror.plan;
    console.log(`  镜像计划: 待推=${m.push} 待拉=${m.pull} 冲突=${m.conflict} 一致=${m.same}`);
    if (plan.mirror.apply) console.log(`  镜像执行: 待推=${plan.mirror.apply.push} 待拉=${plan.mirror.apply.pull} 冲突=${plan.mirror.apply.conflict} 一致=${plan.mirror.apply.same}`);
  }
  if (plan.seed) console.log(`  seed: rc=${plan.seed.rc}`);
  for (const n of plan.notes) console.log(`  [注] ${n}`);
  for (const f of plan.failures) console.log(`  [FAIL] ${f}`);
  if (!APPLY && pending === 0) console.log('  待处理 0 项 → 已经对齐（要动手也不需要）');
  else if (!APPLY) console.log(`  待处理 ${pending} 项 → 确认后跑：node tools/sync-align.mjs --apply`);
}

process.exitCode = rc;
