#!/usr/bin/env node
/**
 * ai-sync-mcp — 把引擎能力暴露成 MCP 工具（stdio），让**任意 agent**（dsh / Claude / opencode…）都能：
 *   · 读全队同步状态与待办（sync_status / sync_pending）
 *   · 触发一次同步（sync_trigger）
 *   · 跑收敛（sync_converge，默认 dry-run）
 *   · 看初始化对齐计划（sync_align_plan）
 *
 * 为什么要有它：agent 想知道"我这台机器跟别的机器对齐了吗 / 有没有需要我提醒用户的事"时，
 * 不该去 shell 里猜命令。MCP 是各 agent 都认的接口，接一次到处能用。
 *
 * 传输：stdio，**JSON-RPC 2.0 按行分隔**（MCP stdio 传输规范，不是 LSP 的 Content-Length 帧）。
 * 依赖：零第三方（node 内置）。
 *
 * 用法（agent 侧配置）：
 *   { "command": "node", "args": ["<引擎根>/tools/ai-sync-mcp.mjs", "--instance", "<实例根>"] }
 * 自检：
 *   node tools/ai-sync-mcp.mjs --selftest      # 不依赖 agent，自己跑一遍握手 + tools/list + 一次 sync_status
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(process.env.AI_SYNC_ENGINE || join(HERE, '..'));
const argv = process.argv.slice(2);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);

/** 跑一个引擎工具，返回 {code, stdout, stderr} */
function run(script, args = [], timeout = 10 * 60 * 1000) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(ENGINE, 'tools', script), '--instance', INSTANCE, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (c) => (out += c));
    p.stderr.on('data', (c) => (err += c));
    p.on('close', (code) => {
      clearTimeout(t);
      done({ code, stdout: out, stderr: err });
    });
  });
}

const TOOLS = [
  {
    name: 'sync_status',
    description:
      '读取本机 + 全队的同步状态（最后同步时间、各仓 ahead/behind、断言表 PASS/WARN/FAIL、待办事项）。跨机器信息来自实例仓的 sync-state 分支。',
    inputSchema: { type: 'object', properties: { full: { type: 'boolean', description: 'true=返回完整 JSON；默认只返回摘要（更省 token）' } } },
  },
  {
    name: 'sync_pending',
    description: '只读"待办事项"：本机与各端需要人处理的事（例如某应用配置已更新需重启）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sync_trigger',
    description: '立刻跑一轮同步 tick（拉取→渲染→收敛→推送→写状态）。可能耗时 5–60 秒。返回日志末行与退出码。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sync_converge',
    description: '跑一次收敛：判断哪些 live 配置变了、谁该重载/重启。默认 dry-run（只看不登记重启）。',
    inputSchema: { type: 'object', properties: { dry_run: { type: 'boolean', description: '默认 true；false 才会真的登记重启请求' } } },
  },
  {
    name: 'sync_align_plan',
    description: '初始化对齐的**计划**（只报告，不改任何文件）：git ahead/behind + 镜像待推/待拉/冲突。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args = {}) {
  if (name === 'sync_status') {
    const r = await run('sync-status.mjs', ['--json'], 60_000);
    if (!r.stdout) return `sync-status 无输出（exit ${r.code}）：${r.stderr.slice(-300)}`;
    if (args.full) return r.stdout;
    const j = JSON.parse(r.stdout);
    const lines = [
      `state=${j.state}  machine=${j.machine}  最后同步=${j.lastSyncAt}（${j.lastSyncAgoMin} 分钟前）  间隔=${j.intervalMinutes} 分钟`,
      `FAIL: ${j.problems.length ? j.problems.join(' / ') : '无'}`,
      `WARN: ${j.warnings.length ? j.warnings.join(' / ') : '无'}`,
      `待办: ${j.actions.length ? j.actions.map((a) => `[${a.source}] ${a.text}`).join(' / ') : '无'}`,
      `全队: ${j.machines.map((m) => `${m.machine}(${m.at}, rc=${m.rc}, 待办${(m.actions || []).length})`).join(' / ') || '仅本机'}`,
      `断言表:`,
      ...j.checks.map((c) => `  [${c.level}] ${c.name} ← 期望 ${c.expected} / 实际 ${c.actual}`),
    ];
    return lines.join('\n');
  }
  if (name === 'sync_pending') {
    const r = await run('sync-status.mjs', ['--json'], 60_000);
    if (!r.stdout) return `sync-status 无输出（exit ${r.code}）`;
    const j = JSON.parse(r.stdout);
    if (!j.actions.length && !j.problems.length) return '无待办、无 FAIL。';
    const out = [];
    for (const a of j.actions) out.push(`[待办 · ${a.source}] ${a.text}`);
    for (const p of j.problems) out.push(`[FAIL] ${p}`);
    return out.join('\n');
  }
  if (name === 'sync_trigger') {
    const r = await run('sync-status.mjs', ['--json'], 60_000); // 先确认工具在
    if (r.code !== 0 || !r.stdout) return `读状态失败（exit ${r.code}）：${r.stderr.slice(-300)}`;
    const tick = join(INSTANCE, 'sync', 'sync-lite.ps1');
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'pwsh' : 'bash';
    const cmdArgs = isWin ? ['-NoProfile', '-File', tick, '-NoJitter'] : [join(INSTANCE, 'sync', 'mac', 'mac-sync.sh'), 'tick'];
    const res = await new Promise((done) => {
      const p = spawn(cmd, cmdArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (c) => (out += c));
      p.stderr.on('data', (c) => (err += c));
      p.on('close', (code) => done({ code, out, err }));
    });
    const lastLine = (res.out.trim().split(/\r?\n/).filter(Boolean).pop() || '').trim();
    return `tick 退出码 ${res.code}\n${lastLine || '(无输出)'}${res.err ? `\n[stderr] ${res.err.slice(-200)}` : ''}`;
  }
  if (name === 'sync_converge') {
    const dry = args.dry_run !== false;
    const r = await run('sync-converge.mjs', driedArgs(dry), 5 * 60 * 1000);
    return `converge 退出码 ${r.code}${dry ? '（dry-run）' : ''}\n${(r.stdout || r.stderr).trim().split(/\r?\n/).slice(-12).join('\n')}`;
  }
  if (name === 'sync_align_plan') {
    const r = await run('sync-align.mjs', [], 30 * 60 * 1000);
    return `align 退出码 ${r.code}\n${(r.stdout || r.stderr).trim().split(/\r?\n/).slice(-16).join('\n')}`;
  }
  throw new Error(`未知工具：${name}`);
}
const driedArgs = (dry) => (dry ? ['--dry-run'] : []);

/* ---------------------------------------------------------------- JSON-RPC（按行） */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'ai-sync', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    try {
      const text = await callTool(name, params?.arguments || {});
      return ok(id, { content: [{ type: 'text', text }] });
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: `工具 ${name} 失败：${e.message}` }], isError: true });
    }
  }
  if (method === 'ping') return ok(id, {});
  return fail(id, -32601, `未实现的方法：${method}`);
}

if (argv.includes('--selftest')) {
  const probe = await callTool('sync_status', {});
  console.log('=== ai-sync-mcp 自检 ===');
  console.log(`engine=${ENGINE}`);
  console.log(`instance=${INSTANCE}`);
  console.log(`tools=${TOOLS.map((t) => t.name).join(', ')}`);
  console.log('--- sync_status 摘要 ---');
  console.log(probe.split('\n').slice(0, 6).join('\n'));
  process.exit(0);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return fail(null, -32700, 'JSON 解析失败');
  }
  handle(msg).catch((e) => fail(msg.id ?? null, -32603, String(e?.message || e)));
});
rl.on('close', () => process.exit(0));
