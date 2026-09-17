#!/usr/bin/env node
/**
 * tests/inject/run-fi.mjs — 收敛器（tools/sync-converge.mjs）的故障注入套件
 *
 * 纪律（conventions §3「假绿防线」）：**每条断言都必须先证明它能失败**。
 * 所以这里的每个用例都是"故意造一个坏环境，断言它被察觉"：
 *   FI1  无变更连跑两次        → 第二次 changed=0，且**没有任何 POST**
 *   FI2  hot 类变更            → classify=hot-*，不登记重启
 *   FI3  restart:true 的变更   → 恰好 1 次 POST /restart/request，force=false
 *   FI4  guard 在监听但报 500  → rc=3（真问题），不是"良性跳过"
 *   FI4b 服务根本没起          → rc=0 + 记 pending（良性），**不是** rc=3
 *   FI5  producer 起不来       → rc=3
 *   FI6  owner 声明冲突        → rc=3（同一文件被两个 owner 声明 = 建模错误）
 *
 * 全程在临时目录里跑（自建临时引擎 + 临时实例 + 桩 guard 服务），**不碰真机配置**。
 *
 * 用法：node tests/inject/run-fi.mjs [--keep]
 * 退出码：0 = 全过；非 0 = 失败用例数。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const CONVERGE = join(REPO, 'tools', 'sync-converge.mjs');
const KEEP = process.argv.includes('--keep');

const results = [];
const ok = (name, detail = '') => results.push({ name, pass: true, detail });
const bad = (name, detail = '') => results.push({ name, pass: false, detail });

/* ---------------------------------------------------------------- 临时工作区 */

const root = mkdtempSync(join(tmpdir(), 'sync-fi-'));
const engine = join(root, 'engine');
const instance = join(root, 'instance');
const data = join(instance, 'data');
for (const d of [join(engine, 'adapters', 'producers'), join(engine, 'adapters', 'owners'), join(instance, 'sync', 'state'), data]) {
  mkdirSync(d, { recursive: true });
}
writeFileSync(join(data, 'a.txt'), 'A0\n', 'utf8');
writeFileSync(join(data, 'b.txt'), 'B0\n', 'utf8');
writeFileSync(join(instance, 'sync', 'local.machine'), 'fi-machine\n', 'utf8');

/* 桩 producer：目标清单从 engine/targets.json 读，供各用例改写 */
writeFileSync(
  join(engine, 'produce.mjs'),
  `import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
console.log(readFileSync(join(here, 'targets.json'), 'utf8').trim());
`,
  'utf8',
);
const setTargets = (list) =>
  writeFileSync(join(engine, 'targets.json'), JSON.stringify({ renderer: 'fi', targets: list }), 'utf8');
const producer = (cmd) => writeFileSync(join(engine, 'adapters', 'producers', 'p1.json'), JSON.stringify({ id: 'fi', cmd }), 'utf8');
const owner = (id, body) => writeFileSync(join(engine, 'adapters', 'owners', `${id}.json`), JSON.stringify({ id, ...body }), 'utf8');

/* ---------------------------------------------------------------- 桩 guard 服务 */

function stubServer(handler) {
  return new Promise((done) => {
    const hits = [];
    const srv = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      handler(req, res);
    });
    srv.listen(0, '127.0.0.1', () => done({ srv, hits, port: srv.address().port, close: () => new Promise((d) => srv.close(d)) }));
  });
}
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
};

/* ---------------------------------------------------------------- 跑一次收敛 */

/** 必须**异步**跑子进程：桩 guard 服务就在本进程里，`spawnSync` 会阻塞事件循环
 *  ⇒ 桩服务无法应答 ⇒ 请求超时（2026-09-17 实测：那会让 FI2/FI3 假失败、FI4 假通过）。 */
function converge(extra = []) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CONVERGE, '--engine', engine, '--instance', instance, '--json', ...extra], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      let out = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        /* 解析失败由调用方按 rc 判定 */
      }
      done({ rc: code, out, stdout, stderr });
    });
  });
}
const stateFile = () => join(instance, 'sync', 'state', 'local-fi-machine.json');
const resetState = () => {
  if (existsSync(stateFile())) rmSync(stateFile());
};

/* ================================================================ FI1 */

{
  const list = [{ path: join(data, 'a.txt'), owner: 'hotowner' }];
  setTargets(list);
  producer(['node', '{engine}/produce.mjs']);
  owner('hotowner', { probe: { any: [join(data, 'a.txt')] }, reload: { mode: 'hot', hint: 'stub hot' } });
  resetState();
  const first = await converge();
  const second = await converge();
  const changed2 = second.out?.last?.changed?.length ?? -1;
  if (first.rc === 0 && second.rc === 0 && changed2 === 0) ok('FI1 无变更连跑：第二次 changed=0', `rc=${second.rc}`);
  else bad('FI1 无变更连跑：第二次 changed=0', `rc1=${first.rc} rc2=${second.rc} changed2=${changed2}`);
}

/* ================================================================ FI2 / FI3 / FI4（桩 guard） */

{
  const list = [{ path: join(data, 'a.txt'), owner: 'httpowner' }];
  setTargets(list);
  resetState();
  writeFileSync(join(data, 'a.txt'), 'A1\n', 'utf8'); // 制造变更

  // FI2：classify 说不需要重启
  const s2 = await stubServer((req, res) => {
    if (req.url.startsWith('/restart/classify')) return json(res, 200, { restart: false, kind: 'hot-patch', hint: 'stub' });
    json(res, 404, {});
  });
  owner('httpowner', {
    probe: { any: [join(data, 'a.txt')] },
    reload: { mode: 'http', guardBase: `http://127.0.0.1:${s2.port}`, classify: '/restart/classify?path={path}', request: '/restart/request' },
  });
  const r2 = await converge();
  const kinds = (r2.out?.last?.classify || []).map((c) => c.kind).join(',');
  const posted2 = s2.hits.filter((h) => h.startsWith('POST')).length;
  if (r2.rc === 0 && kinds.includes('hot-patch') && posted2 === 0) ok('FI2 hot 类变更：不登记重启', `classify=${kinds}`);
  else bad('FI2 hot 类变更：不登记重启', `rc=${r2.rc} classify=${kinds} POST=${posted2}`);
  await s2.close();

  // FI3：classify 说需要重启 → 恰好 1 次 POST，且 force=false
  resetState();
  writeFileSync(join(data, 'a.txt'), 'A2\n', 'utf8');
  let body3 = null;
  const s3 = await stubServer((req, res) => {
    if (req.url.startsWith('/restart/classify')) return json(res, 200, { restart: true, kind: 'plugin-set', hint: 'stub' });
    if (req.url === '/restart/request') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      return req.on('end', () => {
        body3 = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        json(res, 200, { id: 'req-1' });
      });
    }
    json(res, 404, {});
  });
  owner('httpowner', {
    probe: { any: [join(data, 'a.txt')] },
    reload: { mode: 'http', guardBase: `http://127.0.0.1:${s3.port}`, classify: '/restart/classify?path={path}', request: '/restart/request', kind: 'fi-kind' },
  });
  const r3 = await converge();
  const posted3 = s3.hits.filter((h) => h.startsWith('POST')).length;
  if (r3.rc === 0 && posted3 === 1 && body3?.force === false && body3?.kind === 'fi-kind') {
    ok('FI3 需重启：恰好 1 次 POST，force=false', `kind=${body3?.kind}`);
  } else {
    bad('FI3 需重启：恰好 1 次 POST，force=false', `rc=${r3.rc} POST=${posted3} body=${JSON.stringify(body3)}`);
  }
  await s3.close();

  // FI4：服务在监听但报 500 → 必须 rc=3（真问题，不能当"良性跳过"）
  resetState();
  writeFileSync(join(data, 'a.txt'), 'A3\n', 'utf8');
  const s4 = await stubServer((req, res) => json(res, 500, { error: 'boom' }));
  owner('httpowner', {
    probe: { any: [join(data, 'a.txt')] },
    reload: { mode: 'http', guardBase: `http://127.0.0.1:${s4.port}`, classify: '/restart/classify?path={path}', request: '/restart/request' },
  });
  const r4 = await converge();
  if (r4.rc === 3) ok('FI4 监听但 500 → rc=3（真问题）', `${(r4.out?.last?.failures || [])[0] || ''}`);
  else bad('FI4 监听但 500 → rc=3（真问题）', `rc=${r4.rc}`);
  await s4.close();

  // FI4b：端口没人听 → 良性（rc=0 + 记 pending），**不是** rc=3
  resetState();
  writeFileSync(join(data, 'a.txt'), 'A4\n', 'utf8');
  owner('httpowner', {
    probe: { any: [join(data, 'a.txt')] },
    reload: { mode: 'http', guardBase: 'http://127.0.0.1:1', classify: '/restart/classify?path={path}', request: '/restart/request' },
  });
  const r4b = await converge();
  const pend = (r4b.out?.last?.skipped || []).some((s) => s.includes('服务未运行'));
  if (r4b.rc === 0 && pend) ok('FI4b 服务没起 → rc=0 + 记 pending（良性）', '');
  else bad('FI4b 服务没起 → rc=0 + 记 pending（良性）', `rc=${r4b.rc} skipped=${JSON.stringify(r4b.out?.last?.skipped)}`);
}

/* ================================================================ FI5 producer 起不来 */

{
  producer(['definitely-not-a-real-binary-xyz', '--targets-json']);
  resetState();
  const r5 = await converge();
  if (r5.rc === 3) ok('FI5 producer 起不来 → rc=3', `${(r5.out?.last?.failures || [])[0] || ''}`);
  else bad('FI5 producer 起不来 → rc=3', `rc=${r5.rc}`);
}

/* ================================================================ FI6 owner 冲突 */

{
  producer(['node', '{engine}/produce.mjs']);
  setTargets([{ path: join(data, 'b.txt'), owner: 'ownerX' }]);
  owner('ownerX', { probe: { any: [join(data, 'b.txt')] }, reload: { mode: 'hot' } });
  writeFileSync(
    join(engine, 'adapters', 'producers', 'p2.json'),
    JSON.stringify({ id: 'fi2', cmd: ['node', '{engine}/produce2.mjs'] }),
    'utf8',
  );
  writeFileSync(
    join(engine, 'produce2.mjs'),
    `console.log(JSON.stringify({ renderer:'fi2', targets:[{ path: ${JSON.stringify(join(data, 'b.txt'))}, owner: 'ownerY' }] }));\n`,
    'utf8',
  );
  owner('ownerY', { probe: { any: [join(data, 'b.txt')] }, reload: { mode: 'hot' } });
  resetState();
  const r6 = await converge();
  if (r6.rc === 3) ok('FI6 同一文件被两个 owner 声明 → rc=3', `${(r6.out?.last?.failures || [])[0] || ''}`);
  else bad('FI6 同一文件被两个 owner 声明 → rc=3', `rc=${r6.rc}`);
}

/* ---------------------------------------------------------------- 报告 */

const failed = results.filter((r) => !r.pass);
console.log(`\n=== FI 套件（${results.length} 例，临时目录 ${root}）===`);
for (const r of results) console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.detail ? `\n         ${r.detail}` : ''}`);
console.log(`=== ${results.length - failed.length}/${results.length} 通过 ===`);
if (!KEEP && failed.length === 0) rmSync(root, { recursive: true, force: true });
else console.log(`  （保留临时目录：${root}）`);
process.exitCode = failed.length;
