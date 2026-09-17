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
    } catch (e) {
      out.note = `fetch ${branch} 失败（离线或无该分支？）：${String(e.message || e).split('\n')[0]}`;
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
  for (let attempt = 1; attempt <= 3; attempt++) {
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
        const args = ['commit-tree', tree, '-m', message || `state: ${machine}`];
        if (parent) args.push('-p', parent);
        const commit = git(args, instance).trim();
        git(['push', '-q', 'origin', `${commit}:refs/heads/${branch}`], instance);
        return { ok: true, commit, branch };
      } finally {
        rmSync(idx, { force: true });
      }
    } catch (e) {
      lastError = String(e.message || e).split('\n').filter(Boolean).slice(-3).join(' | ');
      // 并发 push 撞非快进 ⇒ 下一轮重新 fetch 后再试
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
