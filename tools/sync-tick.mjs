#!/usr/bin/env node
/**
 * sync-tick — 跨平台 tick（node 单实现）：拉取 → 渲染 → 收敛 → 推送 → 写状态 → 调度自愈
 *
 * 为什么再写一个 tick：原来 Windows 是 `sync-lite.ps1`、macOS 是 `mac-sync.sh tick`，
 * 语义靠"两边手动对齐"（锁就是这样只在一边先落地、渲染器清单在三处各抄一份）。
 * 引擎要能独立部署（用户只装引擎 + 一份实例配置），就不该要求他同时拥有 PowerShell 与 bash 两套实现。
 * 本文件只用 node 内置模块 + git 可执行文件 ⇒ Windows / macOS / Linux 同一份代码。
 *
 * 与既有脚本的关系：**语义逐条对齐**（不是重新发明）：
 *   · 先提交 → 落后则 pull --rebase 整合 → 再 push（提交在前 ⇒ 工作区干净 ⇒ 不需要 autostash）
 *   · 撞真冲突：`rebase --abort` 完整复原 + 明确 SKIP + 计入 rc（绝不留半成品）
 *   · 渲染器清单来自适配器（adapters/producers/*.json 的 renderCmd）—— 不再在脚本里抄一份
 *   · 并发锁：文件锁（跨平台；PS 侧保留它自己的互斥体，两边同时存在时会互相让路）
 *   · 假绿防线：任何跳过/降级都计入 issues 或写进日志行
 *
 * 用法：
 *   node tools/sync-tick.mjs [--instance <dir>] [--engine <dir>] [--dry-run] [--no-jitter] [--quiet] [--json]
 * 退出码：0 = 无问题；1 = 有 issues（与既有 tick 一致，便于计划任务/launchd 直接反映）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, hostname } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { assessWorktree, loadRules, loadProtected } from './lib/commit-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const ENGINE = resolve(val('--engine') || process.env.AI_SYNC_ENGINE || join(HERE, '..'));
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);
const DRY = has('--dry-run');
const QUIET = has('--quiet');
const JSON_OUT = has('--json');
const NO_JITTER = has('--no-jitter');

const say = (m) => {
  if (!QUIET && !JSON_OUT) console.log('   ' + m);
};
const stamp = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;

/* ---------------------------------------------------------------- 配置 */

const loadJson = (p, dflt = null) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return dflt;
  }
};
const cfg = loadJson(join(INSTANCE, 'sync', 'instance.json'), {}) || {};
const tickCfg = { intervalMinutes: 5, jitterSeconds: 45, statePushMinutes: 15, ...(cfg.tick || {}) };
const machine =
  process.env.AI_SYNC_MACHINE ||
  process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim() : hostname().toLowerCase());
const mc = loadJson(join(INSTANCE, 'sync', 'machines', `${machine}.json`), {}) || {};
const expand = (p) => (!p ? p : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

/* 提交前守卫的规则清单 —— **单一源**：node（本文件）/ PowerShell（sync/_load.ps1）/ bash
 * （sync/mac/mac-sync.sh）三方读同一份 `sync/commit-guard.rules`；文件缺失时用内置兜底规则。
 * 审计 PR-4 / X-5：原先这份"机器本地文件"清单在 .gitignore、R4 正则、各脚本里各写一份，必然漂移。 */
const guardRulesFile = join(INSTANCE, 'sync', 'commit-guard.rules');
const { rules: guardRules, source: guardRulesSource } = loadRules(guardRulesFile);

/* 代码面清单（治理门，用户裁决 2026-09-18 / 审计 EN-1）：**只有 home 机器能提交代码**，
 * 其余机器只允许落地共享文件修改。命中路径会被**移出暂存区**（不阻塞其余文件），并打 `[REVIEW]`。
 * home 机器名从**实例配置**读（`sync/instance.json` 的 `governance.homeMachine`）——
 * **绝不硬编码**：本文件会随公开引擎发布，硬编码真实机器名会被发布门禁的"个人串"规则命中（实测被拦过）。
 * 未配置 ⇒ **不启用**该门（公开引擎用户没有 home 概念），并记一条 NOTE。 */
const guardProtectedFile = join(INSTANCE, 'sync', 'protected-paths.rules');
const { rules: guardProtected } = loadProtected(guardProtectedFile);
const HOME_MACHINE = (() => {
  try { return String(JSON.parse(readFileSync(join(INSTANCE, 'sync', 'instance.json'), 'utf8'))?.governance?.homeMachine || ''); } catch { return ''; }
})();

const issues = [];
const notes = [];
const stats = { pulled: 0, committed: 0, pushed: 0, skipped: 0, rendered: [], convNote: '', stateNote: '', schedNote: '' };

/* ---------------------------------------------------------------- 并发锁（文件锁，跨平台） */

const lockFile = join(INSTANCE, 'sync', 'state', '.sync.lock');
function acquireLock() {
  if (DRY) return { ok: true, dry: true };
  try {
    mkdirSync(dirname(lockFile), { recursive: true });
  } catch {}
  const write = () => {
    const fd = openSync(lockFile, 'wx');           // O_EXCL：原子创建
    writeFileSync(fd, JSON.stringify({ pid: process.pid, machine, at: stamp() }));
    closeSync(fd);
  };
  try {
    write();
    return { ok: true };
  } catch {
    // 陈旧锁判定：pid 不在了，或超过 15 分钟
    let old = null;
    try {
      old = JSON.parse(readFileSync(lockFile, 'utf8'));
    } catch {}
    const ageMin = old?.at ? (Date.now() - new Date(old.at.replace(' ', 'T')).getTime()) / 60000 : 999;
    let alive = false;
    try {
      process.kill(old?.pid ?? -1, 0);
      alive = true;
    } catch {}
    if (!alive || ageMin > 15) {
      notes.push(`抢占陈旧锁（pid=${old?.pid} alive=${alive} age=${Math.round(ageMin)}min）`);
      try {
        rmSync(lockFile, { force: true });
        write();
        return { ok: true };
      } catch {}
    }
    return { ok: false, holder: old };
  }
}
function releaseLock() {
  try {
    rmSync(lockFile, { force: true });
  } catch {}
}

const lock = acquireLock();
if (!lock.ok) {
  const line = `tick ${machine} ${stamp()} pull=0 commit=0 push=0 skip=1 elapsed=0s rc=0 | lock=busy（另一同步进程持锁 pid=${lock.holder?.pid}，本轮让路）`;
  if (!DRY) {
    const dir = join(INSTANCE, 'sync', 'logs');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `tick-${machine}.log`), line + '\n', { flag: 'a' });
  }
  say(line);
  process.exitCode = 0;
} else {
  await main();
  releaseLock();
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const t0 = Date.now();
  if (!NO_JITTER && !DRY && tickCfg.jitterSeconds > 0) {
    const j = Math.floor(Math.random() * (tickCfg.jitterSeconds + 1));
    if (j > 0) {
      say(`抖动 sleep ${j}s（多机错峰，避免同秒抢推）`);
      await new Promise((r) => setTimeout(r, j * 1000));
    }
  }

  const git = (cwd, args) => {
    try {
      // timeout：网络类操作（fetch/pull/push）在远端不可达时不能把整轮 tick 挂住（TR6 实测过 5 分钟挂死）。
      // GIT_TERMINAL_PROMPT=0 + GCM_INTERACTIVE=Never：tick 现在由**隐藏窗口**跑（install/run-hidden.vbs），
      // 万一 git 或凭据管理器想弹交互提示，那个框永远不会有人看见 ⇒ 隐形挂死到超时。必须让它快速失败。
      return execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        timeout: 120000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
      }).trim();
    } catch (e) {
      return { error: String(e.message || e).split('\n')[0] };
    }
  };

  /* 1. µ1：每个 git 仓 —— 提交 → 整合 → 推送 */
  for (const r of mc.mu1 || []) {
    if (!r.repo) continue;
    const path = expand(r.path);
    if (!existsSync(join(path, '.git'))) {
      notes.push(`仓库 ${r.id} 不是 git 仓（${path}）→ 跳过`);
      continue;
    }
    if (DRY) {
      say(`[DRY] ${r.id}: fetch → 落后则 pull → 有改动则 commit → push`);
      continue;
    }
    const dirty = git(path, ['status', '--porcelain']);
    if (typeof dirty === 'string' && dirty) {
      git(path, ['add', '-A']);
      // ---- 提交前守卫（审计 EN-8 / EN-16 / PR-4 / X-2）：判据只看**内容与状态**，不看退出码 ----
      // 顺序：先 add -A（守卫才能把机器本地文件移出暂存区）→ 守卫 → 暂存区非空才提交。
      // 拦的是三类真事故：① 未合并（autostash 回填撞冲突时 git 返回 0！）② rebase 停在半途
      // ③ 工作区残留冲突标记（vault d404365：标记被 add -A 提交，13 小时后才人工清除）。
      const g = assessWorktree(path, {
        rules: guardRules,
        protected: HOME_MACHINE ? guardProtected : [],
        machine,
        homeMachine: HOME_MACHINE,
        apply: true,
      });
      for (const n of g.notes) say(`[GUARD] ${r.id}: ${n}`);
      if (g.needsGitRm.length) {
        issues.push(`${r.id}: 机器本地文件已被跟踪（只 unstage 治不了本，下一轮还会出现）→ 应 git rm --cached + 写 .gitignore：${g.needsGitRm.join(', ')}`);
      }
      if (!g.ok) {
        for (const f of g.refuse) {
          say(`[REFUSE] ${r.id}: ${f.code} — ${f.detail}${f.paths && f.paths.length ? ' :: ' + f.paths.join(', ') : ''}`);
          issues.push(`${r.id}: 拒绝提交（${f.code}）`);
        }
        say(`[SKIP] ${r.id}: 工作区需要人工处理（未合并 / rebase 中 / 冲突标记）→ 本轮不动该仓 git`);
        continue;
      }
      const stagedFiles = git(path, ['diff', '--cached', '--name-only']);
      if (typeof stagedFiles === 'string' && stagedFiles.trim()) {
        // 显式带身份：新机器上常常没配 user.name/user.email ⇒ 默认提交会以
        // `fatal: unable to auto-detect email address` 失败（2026-09-17 TR6 实测：机器生成的提交不该依赖用户先配 git 身份）。
        const c = git(path, ['-c', `user.name=${machine}`, '-c', `user.email=${machine}@local`, 'commit', '-q', '-m', `sync: ${machine} ${stamp()}`]);
        if (typeof c === 'object') {
          issues.push(`${r.id}: commit 失败`);
          say(`[FAIL] ${r.id}: commit 失败`);
        } else {
          stats.committed++;
          stats.stagedFiles = (stats.stagedFiles || 0) + stagedFiles.trim().split('\n').filter(Boolean).length;
          say(`[OK] ${r.id}: commit（${stagedFiles.trim().split('\n').filter(Boolean).length} 个文件）`);
        }
      } else {
        say(`[--] ${r.id}: 暂存区为空（只剩机器本地文件，已移出）→ 不提交`);
      }
    }
    git(path, ['fetch', '-q', 'origin']);
    const br = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (typeof br !== 'string') {
      issues.push(`${r.id}: 取分支名失败`);
      continue;
    }
    // 审计 EN-10：detached HEAD 时 br 是字符串 'HEAD'，`HEAD..origin/HEAD` 多半不存在。
    if (br === 'HEAD') {
      issues.push(`${r.id}: detached HEAD（rebase 停在半途？）→ 不整合、不 push，需人工处理`);
      say(`[SKIP] ${r.id}: detached HEAD → 本轮不动该仓 git`);
      continue;
    }
    // 审计 EN-10：git() 失败返回**对象**，`Number(对象)` = NaN，而 `NaN > 0` 恒假
    // ⇒ 旧代码会静默跳过整合、直接去 push，然后非快进失败（原因埋在最后两行输出里）。
    const behindNum = Number(git(path, ['rev-list', '--count', `HEAD..origin/${br}`]));
    if (!Number.isFinite(behindNum)) {
      issues.push(`${r.id}: 无法判定落后提交数（rev-list 失败：${br} vs origin/${br}）`);
      say(`[FAIL] ${r.id}: 无法判定落后提交数 → 跳过本轮 push（不盲推）`);
      continue;
    }
    const behind = behindNum;
    if (behind > 0) {
      say(`[INT] ${r.id}: 远端已有 ${behind} 个新提交 → 自动 pull --rebase 整合`);
      const pull = git(path, ['pull', '--rebase']);
      if (typeof pull === 'object') {
        const inRebase = existsSync(join(path, '.git', 'rebase-merge')) || existsSync(join(path, '.git', 'rebase-apply'));
        issues.push(`${r.id}: 整合失败`);
        stats.skipped++;
        if (inRebase) {
          git(path, ['rebase', '--abort']);
          say(`[SKIP] ${r.id}: 整合撞真冲突 → 已 abort 复原（本地提交保留、未 push）→ 需人工处理`);
        } else {
          say(`[FAIL] ${r.id}: 整合失败且非冲突（网络/权限？）→ 保持现状，下轮重试`);
        }
        continue;
      }
      stats.pulled += behind;
      say(`[OK] ${r.id}: 整合 +${behind}`);
    }
    const ahead = Number(git(path, ['rev-list', '--count', `origin/${br}..HEAD`]) || 0);
    if (ahead === 0) {
      say(`[--] ${r.id}: 无待推`);
      continue;
    }
    // 「只读机器」策略（2026-09-17）：instance.json 的 machines.<id>.write === false ⇒ 允许提交到本地，
    // 但**不推送**（用于只读客户端/临时机）。跳过必须留痕：写进日志行与 notes，不静默。
    if (cfg.machines && cfg.machines[machine] && cfg.machines[machine].write === false) {
      stats.readOnly = true;
      notes.push(`${r.id}: 本机被标记为只读（machines.${machine}.write=false）→ 已本地提交但不推送`);
      say(`[SKIP] ${r.id}: 只读机器 → 不推送（本地提交保留）`);
      continue;
    }
    const push = git(path, ['push', '-q']);
    if (typeof push === 'object') {
      issues.push(`${r.id}: push 失败`);
      say(`[FAIL] ${r.id}: push 失败`);
    } else {
      stats.pushed++;
      say(`[OK] ${r.id}: push ${ahead}`);
    }
  }

  /* 2. 渲染：清单来自适配器（producers 的 renderCmd）—— 脚本里不再抄第二份渲染器名单 */
  const producersDir = join(ENGINE, 'adapters', 'producers');
  if (existsSync(producersDir)) {
    for (const f of readdirSync(producersDir).filter((x) => x.endsWith('.json')).sort()) {
      const d = loadJson(join(producersDir, f));
      if (!d) {
        issues.push(`producer ${f} 解析失败`);
        continue;
      }
      const enabled = cfg.producers?.[d.id] ?? d.enabled !== false;
      if (!enabled) continue;
      const cmd = (d.renderCmd || []).map((x) => String(x).replace('{engine}', ENGINE));
      if (!cmd.length) {
        // 只有 targets 声明、没有 renderCmd 的 producer：说明它不负责写盘（例如纯清单型）—— 记一笔，不算失败
        notes.push(`producer ${d.id} 没有 renderCmd → 不参与渲染`);
        continue;
      }
      if (DRY) {
        say(`[DRY] render ${d.id}: ${cmd.join(' ')}`);
        continue;
      }
      const r = spawnSync(cmd[0], cmd.slice(1), { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000, env: { ...process.env, AI_SYNC_INSTANCE: INSTANCE, AI_SYNC_ENGINE: ENGINE } });
      const last = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      if (r.status !== 0) {
        issues.push(`render ${d.id} 退出码 ${r.status}`);
        say(`[FAIL] render ${d.id} 退出码 ${r.status}（末行输出：${last}）`);
      }
      stats.rendered.push(last || `${d.id}: (无输出)`);
    }
  } else {
    issues.push('找不到 adapters/producers → 无法渲染');
  }

  /* 3. 收敛（变更 → 重载/重启） */
  const converge = join(ENGINE, 'tools', 'sync-converge.mjs');
  if (existsSync(converge) && !DRY) {
    const r = spawnSync(process.execPath, [converge, '--instance', INSTANCE], { encoding: 'utf8', windowsHide: true, timeout: 10 * 60 * 1000 });
    const last = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (r.status !== 0) {
      issues.push(`converge 退出码 ${r.status}`);
      say(`[FAIL] converge 退出码 ${r.status}（末行输出：${last}）`);
    }
    const changed = /changed=(\d+)/.exec(last);
    stats.convNote = changed && changed[1] !== '0' ? last.replace(/^converge done: /, '').replace(/\s*→\s*\S+$/, '') : '';
    if (stats.convNote) say(`converge: ${stats.convNote}`);
  }

  /* 4. 跨端状态 + 调度自愈 */
  const statusTool = join(ENGINE, 'tools', 'sync-status.mjs');

  const schedTool = join(ENGINE, 'tools', 'sync-schedule.mjs');
  if (existsSync(statusTool) && !DRY) {
    const r = spawnSync(process.execPath, [statusTool, '--instance', INSTANCE, '--write-state', '--rc', String(issues.length), '--tick-at', stamp(), '--quiet'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5 * 60 * 1000,
    });
    stats.stateNote = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  }
  /* 2026-09-18 实测踩到的坑：临时实例（fixture）跑 tick 时，这一步会把**本机的真实计划任务**改成
     对齐那个临时实例的 tick.intervalMinutes —— 注入测试因此把生产任务从 20 分钟改成了 5 分钟。
     调度对账属于"机器级副作用"，测非生产实例时必须能显式关掉（AI_SYNC_NO_SCHEDULE=1）。 */
  if (existsSync(schedTool) && !DRY && process.env.AI_SYNC_NO_SCHEDULE !== '1') {
    const r = spawnSync(process.execPath, [schedTool, '--instance', INSTANCE, '--reconcile', '--quiet'], { encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000 });
    stats.schedNote = String(r.stdout || '').trim();
  } else if (process.env.AI_SYNC_NO_SCHEDULE === '1') {
    stats.schedNote = 'AI_SYNC_NO_SCHEDULE=1 → 跳过调度对账（测试模式）';
  }

  /* 5. 保留策略：日志与报告不无限堆积（每轮跑一次，代价只是一次目录列举） */
  let pruned = null;
  const pruneTool = join(ENGINE, 'tools', 'sync-prune.mjs');
  if (!DRY) {
    if (existsSync(pruneTool)) {
      const r = spawnSync(process.execPath, [pruneTool, '--instance', INSTANCE, '--quiet', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 60 * 1000 });
      try {
        pruned = JSON.parse(String(r.stdout || '').trim());
      } catch {
        pruned = { broken: true }; // 工具在但拿不到结果 ⇒ 也要留痕，不能当成"无需清理"
      }
    } else {
      // 缺工具 = 必须看得见的降级：否则新装机器上报告会悄悄堆起来（假绿防线 §3）
      pruned = { missing: true };
    }
  }

  /* 5b. 文本卫生门禁（只报不改）：BOM / EOL（**索引口径**）/ 冲突标记 / 机器本地文件被提交。
     结果落 sync/state/hygiene-<machine>.json 供 sync-status 断言与人工查看。
     **故意不改 tick 的 rc**：卫生问题是"仓库内容有缺陷"，不是"这轮同步没跑成"；混进 rc 会让
     每轮 tick 都报红 —— 而假红的代价比没信号更大（本轮实测教训：假红一多，人就开始忽略所有红）。 */
  let hygiene = null;
  if (!DRY) {
    const hygieneTool = join(ENGINE, 'tools', 'sync-hygiene.mjs');
    const repoPaths = [...(mc.mu1 || []).filter((r) => r.repo).map((r) => expand(r.path)), ENGINE]
      .filter((p, i, a) => p && existsSync(join(p, '.git')) && a.indexOf(p) === i);
    if (existsSync(hygieneTool) && repoPaths.length) {
      // 凭据模式属**实例策略**（与 sync/commit-guard.rules 同类），故从 INSTANCE 读、不从 ENGINE 读
      //（ENGINE 是公开引擎的克隆，刻意不含模式字面量 —— 否则会被发布门禁的"疑似凭据"规则命中）。
      const personalPatterns = join(INSTANCE, 'tools', 'secret-patterns.json');
      const args = [hygieneTool, '--json', '--max-detail', '20'];
      // 审计 XD-2：R5（个人串/凭据）此前只在发布公开仓那一刻跑过一次，**两个私有仓从没被扫过**。
      if (existsSync(personalPatterns)) args.push('--personal-patterns', personalPatterns);
      else notes.push('缺少 instance/tools/secret-patterns.json ⇒ 本轮不做个人串/凭据扫描');
      for (const p of repoPaths) args.push('--repo', p);
      const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 120 * 1000, maxBuffer: 32 * 1024 * 1024 });
      try {
        const j = JSON.parse(String(r.stdout || '').trim());
        hygiene = { fails: j.fails, warns: j.warns, top: (j.findings || []).filter((f) => f.sev !== 'INFO').slice(0, 20) };
      } catch {
        hygiene = { broken: true };   // 工具在但拿不到结果 ⇒ 留痕，不当成"没问题"
      }
    } else {
      hygiene = { missing: true };    // 缺工具 = 必须看得见的降级（否则新装机器上永远没这一项）
    }
    if (hygiene) {
      try {
        mkdirSync(join(INSTANCE, 'sync', 'state'), { recursive: true });
        writeFileSync(join(INSTANCE, 'sync', 'state', `hygiene-${machine}.json`),
          JSON.stringify({ at: stamp(), rc: hygiene.broken ? 99 : hygiene.missing ? 98 : (hygiene.fails ? 2 : 0), ...hygiene }, null, 2) + '\n', 'utf8');
      } catch (e) { issues.push(`写卫生状态失败：${e.message}`); }
    }
  }

  /* 5b2. 传输层健康快照（2026-09-19 补）：控制台与 `sync-status` 的「传输层健康快照 ≤40 分钟」判据，
      原先**只有渲染器会刷新**它，而没有任何东西定期跑渲染器 ⇒ 那条断言恒 WARN（实测曾达 187 分钟，
      也就是说：这条观测一旦没人记得手动跑，就等于不存在）。
      放这里是因为 **tick 是唯一每轮都跑的东西**，而它只是一次本地 REST 查询（代价可忽略）。
      **不改 tick 的 rc**：同卫生/迁移/应用 —— 它是观测，不是同步动作；失败由 sync-status 的
      「传输层 REST 可达 / 无问题项」断言暴露。 */
  let transportHealth = null;
  if (!DRY) {
    const hTool = join(ENGINE, 'tools', 'syncthing-health.mjs');
    const hasTransport = !!(mc.transport && (mc.transport.autostart || (mc.transport.folders || []).length || mc.transport.exe));
    if (!hasTransport) transportHealth = { skipped: true, why: '本机未配置传输层' };
    else if (!existsSync(hTool)) transportHealth = { missing: true };
    else {
      const r = spawnSync(process.execPath, [hTool, '--instance', INSTANCE, '--json'],
        { encoding: 'utf8', windowsHide: true, timeout: 60 * 1000, maxBuffer: 16 * 1024 * 1024 });
      try {
        const j = JSON.parse(String(r.stdout || '').trim());
        transportHealth = { ok: j.ok !== false, reachable: !!j.reachable, problems: (j.problems || []).length };
      } catch { transportHealth = { broken: true, rc: r.status }; }
    }
  }

  /* 5c. 一次性迁移（引擎 tools/sync-migrate.mjs）：只跑 danger=safe 的；manual-only 只登记待人工。
     与卫生门禁同理 —— **不改 tick 的 rc**：迁移失败是"某台机器没跟上"，不是"这轮同步没跑成"；
     它由 sync-status 的「迁移」断言暴露（失败 ⇒ FAIL，待人工 ⇒ WARN）。 */
  let migrate = null;
  if (!DRY) {
    const migTool = join(ENGINE, 'tools', 'sync-migrate.mjs');
    if (existsSync(migTool)) {
      const r = spawnSync(process.execPath, [migTool, '--instance', INSTANCE, '--json'],
        { encoding: 'utf8', windowsHide: true, timeout: 300 * 1000, maxBuffer: 32 * 1024 * 1024 });
      try {
        const j = JSON.parse(String(r.stdout || '').trim());
        migrate = {
          applied: (j.applied || []).length,
          ok: (j.skipped || []).length,
          failed: (j.failed || []).length + (j.mismatched || []).length,
          manual: (j.pendingManual || []).length,
          ids: (j.applied || []).map((x) => x.id),
        };
      } catch { migrate = { broken: true }; }   // 运行器在但拿不到结果 ⇒ 留痕，不当成"没有迁移"
    } else {
      migrate = { missing: true };
    }
  }

  /* 5d. 幂等应用（引擎 tools/sync-apply.mjs）：把"拉下来"变成"真的生效" —— 只做 tick 不做的那几件
     （平台调度对账、需要重编的产物）。判据是 **verify**（当前是否真的生效），内容哈希只用来省掉
     反复调用；tick 已经在做的 pull/渲染/裁剪**不重复登记**（第二套机制比不做更糟）。
     同前：**不改 tick 的 rc**，失败由 sync-status 的「应用一致性」断言暴露。 */
  let applied = null;
  if (!DRY) {
    const applyTool = join(ENGINE, 'tools', 'sync-apply.mjs');
    if (existsSync(applyTool)) {
      const r = spawnSync(process.execPath, [applyTool, '--instance', INSTANCE, '--json'],
        { encoding: 'utf8', windowsHide: true, timeout: 600 * 1000, maxBuffer: 32 * 1024 * 1024 });
      try {
        const j = JSON.parse(String(r.stdout || '').trim());
        applied = {
          run: (j.run || []).length,
          ok: (j.ok || []).length,
          skipped: (j.skipped || []).length,
          failed: (j.failed || []).length,
          ids: (j.run || []).map((x) => x.id),
        };
      } catch { applied = { broken: true }; }
    } else {
      applied = { missing: true };
    }
  }

  /* 5e. 诊断包（**条件命中才生成**）：把"看得到红、说不清为什么"变成"出事有档案"。
     触发 = 本轮卫生/迁移/应用任一有失败，或本轮 tick 有 issues；生成器自己按指纹去重
     （同一状况不重复堆积）。只读采集，唯一写入物是报告文件。 */
  let bundle = null;
  if (!DRY) {
    const bundleTool = join(ENGINE, 'tools', 'sync-ops-bundle.mjs');
    const why = [
      hygiene && hygiene.fails ? `卫生 FAIL=${hygiene.fails}` : null,
      migrate && migrate.failed ? `迁移失败=${migrate.failed}` : null,
      applied && applied.failed ? `应用失败=${applied.failed}` : null,
      issues.length ? `本轮 tick issues=${issues.length}` : null,
    ].filter(Boolean);
    if (existsSync(bundleTool) && why.length) {
      const r = spawnSync(process.execPath, [bundleTool, '--instance', INSTANCE, '--json', '--reason', why.join(' · ')],
        { encoding: 'utf8', windowsHide: true, timeout: 300 * 1000, maxBuffer: 32 * 1024 * 1024 });
      try {
        const j = JSON.parse(String(r.stdout || '').trim());
        if (j.generated) bundle = { out: j.out, reasons: j.reasons || why, fingerprint: j.fingerprint };
      } catch { bundle = { broken: true }; }
    }
  }

  /* 5f. 免费模型只读分诊（默认开，`sync/instance.json` 的 triage.enabled=false 即关闭）。
     它是**建议器**：只在固定枚举里选类别、在固定清单里选一条建议 —— 不产生命令、不执行任何东西。
     条件命中才调用（与诊断包同一组条件）；频控与同事实去重由工具自己管；不可用/超时/解析失败一律
     降级成"没建议"，**不改 rc**（分诊失败不是同步故障）。 */
  let triage = null;
  if (!DRY) {
    let triCfg = null
    try { triCfg = JSON.parse(readFileSync(join(INSTANCE, 'sync', 'instance.json'), 'utf8')).triage || {} } catch { triCfg = {} }
    const conds = !!(bundle?.out || (hygiene && hygiene.fails) || (migrate && migrate.failed) || (applied && applied.failed))
    if (triCfg.enabled === true && conds) {
      const tri = join(ENGINE, 'tools', 'sync-triage.mjs')
      if (existsSync(tri)) {
        const r = spawnSync(process.execPath, [tri, '--instance', INSTANCE, '--json'],
          { encoding: 'utf8', windowsHide: true, timeout: 300 * 1000, maxBuffer: 16 * 1024 * 1024 })
        try { triage = JSON.parse(String(r.stdout || '').trim()) } catch { triage = { ok: false, parse: 'runner-broken' } }
      } else {
        triage = { ok: false, why: '缺少 tools/sync-triage.mjs' }
      }
    }
  }

  /* 6. 日志（格式与既有 tick 一致：一行摘要 + 渲染器末行 + 可选 conv 摘要） */
  const elapsed = Math.round((Date.now() - t0) / 1000);
  // 日志行可读性（2026-09-17 用户反馈"日志可读性太差"）：三个渲染器各吐一句 `render done: 0 target(s) written`
  // 纯属噪声 ⇒ 全部成功时压缩成一句；**只要有失败就保留原样**（诊断不能被压缩掉）。
  const notes3 = (() => {
    const parts = stats.rendered.map((x) => String(x).trim()).filter(Boolean);
    if (!parts.length) return '(未渲染)';
    if (parts.some((p) => /FAIL|错误|exit\s*[1-9]|退出码\s*[1-9]/i.test(p))) return parts.join(' | ');
    const nums = parts.map((p) => /(\d+)\s*target\(s\)\s*(written|drifted)/.exec(p)).map((m) => (m ? Number(m[1]) : null));
    if (nums.every((n) => n !== null)) {
      const total = nums.reduce((a, n) => a + n, 0);
      return total === 0 ? `渲染器 ${parts.length}/${parts.length} OK（无改动）` : `渲染器 ${parts.length}/${parts.length} OK（写入 ${total} 个目标）`;
    }
    return parts.join(' | ');
  })();
  let line = `tick ${machine} ${stamp()} 拉取=${stats.pulled} 提交=${stats.committed} 推送=${stats.pushed} 整合失败=${stats.skipped} 耗时=${elapsed}s ${issues.length ? `rc=${issues.length}` : 'rc=0'} | ${notes3}`;
  // 「只读机器」的跳过必须进**日志行**（2026-09-17 实测发现：它原先只打印在 stdout，而 stdout 是瞬时的、日志才是持久证据）
  if (stats.readOnly) line += ' | read-only（本机标记为只读：已本地提交，未推送）';
  if (stats.convNote) line += ` | 收敛：${String(stats.convNote).replace(/^converge done: /, '')}`;
  // 清理动作也要进日志行：删文件是"动作"，只在 stdout 说一句就没了（stdout 是瞬时的）。
  // 缺工具/工具坏了同样要写进来 —— 否则"没清理"和"无需清理"在日志里长得一模一样。
  if (pruned?.missing) line += ' | 清理：缺少 tools/sync-prune.mjs（本轮未清理）';
  else if (pruned?.broken) line += ' | 清理：prune 未返回结果（本轮未清理）';
  else if (pruned && ((pruned.deleted || []).length || pruned.truncated)) {
    const bits = [];
    if ((pruned.deleted || []).length) bits.push(`旧报告 ${pruned.deleted.length}`);
    if (pruned.truncated) bits.push(`日志截断 ${pruned.truncated}`);
    line += ` | 清理：${bits.join(' + ')}（-${pruned.freed || pruned.freedKB + ' KB'}）`;
  }
  // 卫生门禁的结果也必须进日志行（否则"没检查"和"检查通过"在日志里长得一模一样）
  if (hygiene?.broken) line += ' | 卫生：门禁未返回结果（本轮未检查）';
  else if (hygiene?.missing) line += ' | 卫生：缺少 tools/sync-hygiene.mjs（本轮未检查）';
  else if (hygiene && hygiene.fails) line += ` | 卫生：FAIL=${hygiene.fails} WARN=${hygiene.warns}（明细见 sync/state/hygiene-${machine}.json）`;
  else if (hygiene) line += ` | 卫生：通过${hygiene.warns ? `（WARN=${hygiene.warns}）` : ''}`;
  // 传输层健康快照：刷新失败/跳过必须留痕（否则"没刷"和"不需要刷"在日志里长得一模一样）
  if (transportHealth?.broken) line += ` | 传输层：健康快照刷新失败（rc=${transportHealth.rc}）`;
  else if (transportHealth?.missing) line += ' | 传输层：缺少 tools/syncthing-health.mjs（未刷新快照）';
  else if (transportHealth?.skipped) line += ` | 传输层：${transportHealth.why}（未刷新快照）`;
  else if (transportHealth) line += ` | 传输层：快照 OK（${transportHealth.reachable ? 'REST 可达' : 'REST 不可达'}${transportHealth.problems ? ` · 问题 ${transportHealth.problems}` : ''}）`;
  // 迁移同理：跑了什么、有没有待人工，都要在持久日志里留痕
  if (migrate?.broken) line += ' | 迁移：运行器未返回结果（本轮未检查）';
  else if (migrate?.missing) line += ' | 迁移：缺少 tools/sync-migrate.mjs（本轮未检查）';
  else if (migrate && migrate.applied) line += ` | 迁移：应用 ${migrate.applied} 条（${migrate.ids.join(', ')}）${migrate.manual ? `待人工 ${migrate.manual}` : ''}${migrate.failed ? ` FAIL=${migrate.failed}` : ''}`;
  else if (migrate) line += ` | 迁移：无需应用${migrate.failed ? ` FAIL=${migrate.failed}` : ''}${migrate.manual ? `（待人工 ${migrate.manual}）` : ''}`;
  // 应用同理：执行了什么、跳过了多少，都要在持久日志里留痕
  if (applied?.broken) line += ' | 应用：执行器未返回结果（本轮未应用）';
  else if (applied?.missing) line += ' | 应用：缺少 tools/sync-apply.mjs（本轮未应用）';
  else if (applied && (applied.run || applied.failed)) line += ` | 应用：执行 ${applied.run} 条${applied.ids.length ? `（${applied.ids.join(', ')}）` : ''}${applied.failed ? ` FAIL=${applied.failed}` : ''}`;
  else if (applied) line += ` | 应用：无需执行（跳过 ${applied.skipped}）`;
  // 诊断包：生成了就要在持久日志里留痕（否则"有没有档案"事后无从判断）
  if (bundle?.broken) line += ' | 诊断包：生成器未返回结果';
  else if (bundle?.out) line += ` | 诊断包：已生成 ${String(bundle.out).split(/[\\/]/).pop()}（${bundle.reasons.join(' · ')}）`;
  // 分诊结果进日志行（它是建议，但"有没有建议、是不是刚判的"必须可事后追）
  // 注意判断顺序：**跳过路径也带 verdict 字段**（沿用上次判定），先看 verdict 会把"没调用"写成"刚判定"（实测踩到）
  if (triage?.skipped && triage.verdict) line += ` | 分诊：沿用 ${triage.verdict.class} → ${triage.verdict.remedy}（未重复调用：${triage.why}）`;
  else if (triage?.skipped) line += ` | 分诊：跳过（${triage.why}）`;
  else if (triage?.verdict) line += ` | 分诊：${triage.verdict.class} → ${triage.verdict.remedy}（${triage.verdict.confidence}）`;
  else if (triage && triage.ok === false) line += ` | 分诊：不可用（${triage.why || triage.parse || '未知'}）`;

  /* 5g. 跨机心跳告警（审计 XD-5）。Windows 侧原先**没有任何告警通道**（mac 侧只有一条 osascript）；
     本机用**本地 tick 日志**判活（每轮都新），对端用**已提交快照**，并把三态分开：
     ① tick 真停了 ② 该机 daily 没跑（快照过期，不敢下结论）③ 重活未跑。
     阈值从 instance.json 的 tick.intervalMinutes 推导（4×），不硬编码。
     通知按状态去重、最多 6h 重弹 ⇒ 不刷屏；**不计入 tick 的 rc**（心跳告警不是"这轮同步没跑成"，
     混进去就是每 20 分钟一次假红 —— 要进 rc 的场景是 daily，那边加 --rc）。 */
  let hb = null;
  {
    const hbTool = join(ENGINE, 'tools', 'sync-heartbeat-alert.mjs');
    if (existsSync(hbTool)) {
      const hbArgs = [hbTool, '--instance', INSTANCE, '--json', '--quiet'];
      if (DRY) hbArgs.push('--dry-run'); // dry-run 时不要写去重状态、也不要弹通知
      const r = spawnSync(process.execPath, hbArgs, { encoding: 'utf8', windowsHide: true, timeout: 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
      try { hb = JSON.parse(String(r.stdout || '').trim()); } catch { hb = { broken: true }; }
      if (hb?.broken) line += ' | 心跳：检查器未返回结果';
      else if (hb?.alerts?.length) line += ` | 心跳告警 ${hb.alerts.length} 条：${hb.alerts.map((a) => a.key).join(', ')}`;
      else line += ' | 心跳：正常';
    } else {
      notes.push('缺少 tools/sync-heartbeat-alert.mjs ⇒ 本轮跳过心跳告警检查');
    }
  }

  if (!DRY) {
    try {
      const dir = join(INSTANCE, 'sync', 'logs');
      mkdirSync(dir, { recursive: true });
      /* 2026-09-18：**失败明细必须进持久日志**。原先只写摘要行（rc=${issues.length}），
         而 `[FAIL] <repo>: 整合失败` 这类明细只走 stdout —— 计划任务用 run-hidden.vbs 把 stdout 藏掉，
         于是事后翻日志只有 "rc=1"、毫无线索（2026-09-18 实测：两次 rc=1 只能靠当事人回忆才解释得清）。
         notes 同理（"抢占陈旧锁"这类状态变化也要留痕，否则它只活在瞬时 stdout 里）。 */
      const tail = [
        ...notes.map((n) => `[注] ${n}`),
        ...issues.map((i) => `[FAIL] ${i}`),
      ];
      writeFileSync(join(dir, `tick-${machine}.log`), [line, ...tail].join('\n') + '\n', { flag: 'a' });
    } catch (e) {
      issues.push(`写日志失败：${e.message}`);
    }
  }
  say(line);
  for (const n of notes) say(`[注] ${n}`);
  for (const i of issues) say(`[FAIL] ${i}`);

  if (JSON_OUT) {
    console.log(JSON.stringify({ machine, at: stamp(), elapsed, issues, notes, stats, line }, null, 2));
  }
  process.exitCode = issues.length ? 1 : 0;
}
