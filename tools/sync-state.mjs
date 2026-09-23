#!/usr/bin/env node
/**
 * sync-state.mjs — 跨端状态传输（每机一份紧凑状态，落在实例仓的**独立分支**上）
 *
 * 为什么走独立分支而不是 master（2026-09-17 决策）：
 *   跨端互见要求"最后同步时间"足够新鲜（分钟级）。若把状态文件写在 master 上，每台机器每
 *   statePushMinutes 就会产生一个提交 —— 三台机器一天近 300 个纯状态提交，会把 `git log` 淹掉，
 *   也让真正的内容改动淹没在噪声里。⇒ 用 orphan 分支 `sync-state`：**只装 state/<machine>.json**，
 *   读侧走 `git show`（不污染工作区、不校验工作树），写侧走 plumbing（hash-object/read-tree/
 *   update-index/write-tree/commit-tree/push），不碰 index、不碰 HEAD、不需要 checkout。
 *
 * 健壮性：
 *   - 分支不存在 → 第一次 push 自动创建（父提交为空）。
 *   - 并发 push（两台同时推）→ 非快进失败 → 重新 fetch 后重做提交，最多 3 次。
 *   - 离线 / 没权限 → 返回 {ok:false}，**不抛**：状态是派生数据，丢了不丢内容；调用方把它记进本地
 *     状态（statePush.ok=false）并在 status 里显示 WARN，下一轮重试。
 *
 * CLI（调试用）：
 *   node tools/sync-state.mjs read [--instance <dir>] [--no-fetch] [--json]
 *   node tools/sync-state.mjs show <machine> [--instance <dir>]
 */
import { existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** 空树（git 的常量）：分支首次创建时用不到父 tree，用它做 read-tree 的起点 */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function git(args, cwd, input, env) {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    // 网络类 git 操作必须有超时（2026-09-17 TR6 实测：实例仓的远端若不可达，状态推送会把整轮 tick
    // 挂住 5 分钟）。超时后抛错 → 调用方按"推送失败"记 WARN，正常继续。
    timeout: 60000,
    // stderr 必须**捕获**而不是让它直接喷到调用者的终端（2026-09-17 TR6 实测）：
    // 全新实例上还没有 `sync-state` 分支时，git 会打印 `fatal: couldn't find remote ref`，
    // 对用户来说是"吓人的红字但其实正常"。这里收起来，由调用方写进 note/状态里解释。
    stdio: ['pipe', 'pipe', 'pipe'],
    env: env ? { ...process.env, ...env } : process.env,
  });
}

/** 实例目录是不是 git 仓（不是 ⇒ 单机本地模式：状态只落本地文件，不跨端） */
export function isGitRepo(instance) {
  return existsSync(join(instance, '.git'));
}

/** 读全队状态。返回 {ok, branch, machines:{<id>: stateObj}, note}；永不抛。 */
export function readFleet(instance, { branch = 'sync-state', fetch = true } = {}) {
  const out = { ok: true, branch, machines: {}, note: '' };
  if (!isGitRepo(instance)) {
    out.ok = false;
    out.note = '实例目录不是 git 仓 → 单机本地模式（无跨端视图）';
    return out;
  }
  if (fetch) {
    try {
      git(['fetch', '-q', 'origin', branch], instance);
    } catch {
      // 不把 git 的原始报错直接抖给用户（全新实例上 `fatal: couldn't find remote ref sync-state` 很正常）
      out.note = `远端还没有 ${branch} 分支（首台机器推上去后才有）或离线`;
    }
  }
  let entries = [];
  try {
    entries = git(['ls-tree', '--name-only', `origin/${branch}`, 'state/'], instance)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    if (!out.note) out.note = `远端还没有 ${branch} 分支（首台机器推上去后才有）`;
    return out;
  }
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    const id = f.replace(/^state\//, '').replace(/\.json$/, '');
    try {
      out.machines[id] = JSON.parse(git(['show', `origin/${branch}:${f}`], instance));
    } catch (e) {
      out.note = (out.note ? out.note + ' | ' : '') + `读 ${f} 失败：${String(e.message || e).split('\n')[0]}`;
    }
  }
  return out;
}

/** 写本机状态到分支。返回 {ok, commit?, error?}；永不抛。 */
export function writeMachine(instance, machine, stateObj, { branch = 'sync-state', message } = {}) {
  if (!isGitRepo(instance)) return { ok: false, error: '实例目录不是 git 仓（单机本地模式，跳过跨端状态）' };
  const content = JSON.stringify(stateObj, null, 2) + '\n';
  let lastError = null;
  /* 2026-09-23（batch 19）：重试 3 → 6 次并加**抖动**退避 —— 实测两次撞上 non-fast-forward 且三次重试全败
     （三端都在推状态，其中一台曾 71 秒内推过两次）⇒ 3 次不够；固定退避会让两端同步退避后再次同刻相撞。 */
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      let parent = null;
      let parentTree = EMPTY_TREE;
      try {
        git(['fetch', '-q', 'origin', branch], instance);
        parent = git(['rev-parse', `origin/${branch}`], instance).trim();
        parentTree = git(['rev-parse', `${parent}^{tree}`], instance).trim();
      } catch {
        /* 分支还不存在：父提交留空，第一次 push 会创建它 */
      }
      const blob = git(['hash-object', '-w', '--stdin'], instance, content).trim();
      const idx = join(tmpdir(), `ai-sync-idx-${process.pid}-${attempt}`);
      try {
        rmSync(idx, { force: true });
      } catch {}
      const env = { GIT_INDEX_FILE: idx };
      try {
        git(['read-tree', parentTree], instance, undefined, env);
        git(['update-index', '--add', '--cacheinfo', `100644,${blob},state/${machine}.json`], instance, undefined, env);
        const tree = git(['write-tree'], instance, undefined, env).trim();
        // commit-tree 同样需要身份：新机器上 `fatal: unable to auto-detect email address` 会让状态推不上去（TR6 实测）。
        // 机器生成的状态提交显式署名，不要求用户先配 git 身份。
        const args = ['-c', `user.name=${machine}`, '-c', `user.email=${machine}@local`, 'commit-tree', tree, '-m', message || `state: ${machine}`];
        if (parent) args.push('-p', parent);
        const commit = git(args, instance).trim();
        git(['push', '-q', 'origin', `${commit}:refs/heads/${branch}`], instance);
        return { ok: true, commit, branch };
      } finally {
        rmSync(idx, { force: true });
      }
    } catch (e) {
      lastError = String(e.message || e).split('\n').filter(Boolean).slice(-3).join(' | ');
      // **只为"非快进"重试**（并发 push 的语义问题）。权限不足 / 离线 / 超时这类失败**立刻返回**：
      // 2026-09-17 TR6 实测，原先对所有错误重试 3 次 × 60s 超时，把整轮 tick 拖到 3 分钟
      // （而实例仓不可写是很容易发生的：克隆自只读来源、令牌过期…）。失败会被记成 statePush.ok=false 的 WARN。
      if (!/non-fast-forward|fetch first|rejected|cannot lock/i.test(lastError)) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150 * attempt + Math.floor(Math.random() * 250)); } catch { /* 环境不支持就跳过等待 */ }
    }
  }
  return { ok: false, error: lastError || '未知错误' };
}

/* ---------------------------------------------------------------- CLI */

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const val = (f, d = null) => {
    const i = argv.indexOf(f);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
  };
  const instance = val('--instance') || process.env.AI_SYNC_INSTANCE || process.cwd();
  const branch = val('--branch', 'sync-state');
  const cmd = argv[0] || 'read';
  if (cmd === 'read') {
    const r = readFleet(instance, { branch, fetch: !argv.includes('--no-fetch') });
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`branch=${branch} machines=${Object.keys(r.machines).length}${r.note ? ` note: ${r.note}` : ''}`);
      for (const [id, s] of Object.entries(r.machines)) console.log(`  ${id}: at=${s.at} rc=${s.tick?.rc} pending=${(s.actions || []).length}`);
    }
  } else if (cmd === 'show') {
    const id = argv[1];
    const r = readFleet(instance, { branch, fetch: false });
    console.log(JSON.stringify(r.machines[id] ?? null, null, 2));
  } else {
    console.error('usage: sync-state.mjs read|show <machine> [--instance <dir>] [--branch <name>] [--no-fetch] [--json]');
    process.exitCode = 2;
  }
}
