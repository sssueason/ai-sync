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
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 120000 }).trim();
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
      // 显式带身份：新机器上常常没配 user.name/user.email ⇒ 默认提交会以
      // `fatal: unable to auto-detect email address` 失败（2026-09-17 TR6 实测：机器生成的提交不该依赖用户先配 git 身份）。
      const c = git(path, ['-c', `user.name=${machine}`, '-c', `user.email=${machine}@local`, 'commit', '-q', '-m', `sync: ${machine} ${stamp()}`]);
      if (typeof c === 'object') {
        issues.push(`${r.id}: commit 失败`);
        say(`[FAIL] ${r.id}: commit 失败`);
      } else {
        stats.committed++;
        say(`[OK] ${r.id}: commit（${dirty.split('\n').filter(Boolean).length} 个文件）`);
      }
    }
    git(path, ['fetch', '-q', 'origin']);
    const br = git(path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (typeof br !== 'string') {
      issues.push(`${r.id}: 取分支名失败`);
      continue;
    }
    const behind = Number(git(path, ['rev-list', '--count', `HEAD..origin/${br}`]) || 0);
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
  if (existsSync(schedTool) && !DRY) {
    const r = spawnSync(process.execPath, [schedTool, '--instance', INSTANCE, '--reconcile', '--quiet'], { encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000 });
    stats.schedNote = String(r.stdout || '').trim();
  }

  /* 5. 日志（格式与既有 tick 一致：一行摘要 + 渲染器末行 + 可选 conv 摘要） */
  const elapsed = Math.round((Date.now() - t0) / 1000);
  const notes3 = stats.rendered.length ? stats.rendered.join(' | ') : '(未渲染)';
  let line = `tick ${machine} ${stamp()} pull=${stats.pulled} commit=${stats.committed} push=${stats.pushed} skip=${stats.skipped} elapsed=${elapsed}s rc=${issues.length} | ${notes3}`;
  if (stats.convNote) line += ` | conv: ${stats.convNote}`;
  if (!DRY) {
    try {
      const dir = join(INSTANCE, 'sync', 'logs');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `tick-${machine}.log`), line + '\n', { flag: 'a' });
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
