#!/usr/bin/env node
/**
 * sync-console — 本地控制台（零依赖 node:http）：首次向导 / 全队仪表盘 / 设置 / 日志
 *
 * 为什么是"本地网页"而不是两个原生 GUI：三端各写一套窗口代价太大，而**凡是能开浏览器的地方都能用它**；
 * 引擎侧只多一个 node 进程（默认只绑 127.0.0.1）。原生部分只保留"托盘/菜单栏图标"（那个必须常驻）。
 *
 * 安全（默认拒绝）：
 *   · 默认 bind 127.0.0.1；要局域网访问必须显式改 bind **并**设 token（否则每次启动都警告）。
 *   · 目录浏览接口有路径穿越防护（realpath 后必须仍在允许根内）。
 *   · 所有外部命令都用 execFile + 参数数组（不经 shell，避免注入）。
 *
 * 用法：
 *   node apps/sync-console/server.mjs [--instance <dir>] [--port 7788] [--bind 127.0.0.1] [--stop]
 *   （托盘/菜单栏的「打开控制台」就是拉起它并打开浏览器）
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync } from 'node:fs';
import { join, dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = resolve(process.env.AI_SYNC_ENGINE || join(HERE, '..', '..'));
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => {
  const i = argv.indexOf(f);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : d;
};
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE);
const PUBLIC = join(HERE, 'public');
const cfgFile = join(INSTANCE, 'sync', 'instance.json');

function loadCfg() {
  try {
    return JSON.parse(readFileSync(cfgFile, 'utf8'));
  } catch {
    return {};
  }
}
const cfg = loadCfg();
const PORT = Number(val('--port', String(cfg.console?.port ?? 7788)));
const BIND = val('--bind', cfg.console?.bind ?? '127.0.0.1');
const TOKEN = val('--token', cfg.console?.token ?? '');
const LAN = BIND !== '127.0.0.1' && BIND !== 'localhost';
const expandHome = (p) => (!p ? p : p === '~' ? homedir() : String(p).startsWith('~/') ? join(homedir(), String(p).slice(2)) : p);

if (has('--stop')) {
  // 停止：读 pid 文件（由本进程写入），SIGTERM 掉
  const pf = join(INSTANCE, 'sync', 'state', '.console.pid');
  if (existsSync(pf)) {
    const pid = Number(readFileSync(pf, 'utf8').trim());
    try {
      process.kill(pid);
      console.log(`   [OK] 已停止控制台（pid ${pid}）`);
    } catch (e) {
      console.log(`   [WARN] 停止失败：${e.message}`);
    }
  } else console.log('   [WARN] 没有 pid 文件（控制台没在跑？）');
  process.exit(0);
}

/* ---------------------------------------------------------------- 子进程封装（不经 shell） */

function run(cmd, args, { timeout = 10 * 60 * 1000 } = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      done({ code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}
const node = (script, args = []) => run(process.execPath, [join(ENGINE, 'tools', script), '--instance', INSTANCE, ...args]);
const pwshExe = process.platform === 'win32' ? 'pwsh' : 'pwsh';

/* ---------------------------------------------------------------- 工具：目录浏览（有防护） */

// 可浏览的根：**默认只允许家目录**（安全默认）。要给盘符/卷/别的目录，必须在 instance.json 里显式列出
// `console.browseRoots: ["D:/", "/Volumes"]` —— 不默认放开整块磁盘。
const ALLOWED_ROOTS = (Array.isArray(cfg.console?.browseRoots) && cfg.console.browseRoots.length ? cfg.console.browseRoots : [homedir()]).map((p) => resolve(expandHome(p)));

async function listDirs(p) {
  const target = resolve(p.startsWith('~') ? join(homedir(), p.slice(1)) : p);
  let real;
  try {
    real = realpathSync(target);
  } catch {
    return { ok: false, error: `目录不存在：${target}` };
  }
  const allowed = ALLOWED_ROOTS.some((r) => {
    try {
      return real.toLowerCase().startsWith(realpathSync(r).toLowerCase());
    } catch {
      return false;
    }
  });
  if (!allowed) return { ok: false, error: `不在允许浏览的根内（${ALLOWED_ROOTS.join(', ')}）` };
  let entries = [];
  try {
    entries = readdirSync(real, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .slice(0, 500)
      .map((e) => e.name);
  } catch (e) {
    return { ok: false, error: `读目录失败：${e.message}` };
  }
  const checks = {
    isGitRepo: existsSync(join(real, '.git')),
    writable: (() => {
      try {
        const probe = join(real, '.ai-sync-write-probe');
        writeFileSync(probe, '');
        statSync(probe);
        return true;
      } catch {
        return false;
      } finally {
        try {
          const probe = join(real, '.ai-sync-write-probe');
          if (existsSync(probe)) writeFileSync(probe, ''), require('node:fs').unlinkSync(probe);
        } catch {}
      }
    })(),
    // 网盘同步根：名字里带常见客户端标记（baidu/百度/坚果/onedrive/dropbox…）
    looksCloudRoot: /baidu|百度|nutstore|坚果|onedrive|dropbox|icloud|syncdisk|同步空间/i.test(basename(real)),
  };
  return { ok: true, path: real, parent: dirname(real), entries, checks };
}

/* ---------------------------------------------------------------- 路由 */

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
};
const sendJson = (res, code, obj) => send(res, code, JSON.stringify(obj, null, 2));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const p = url.pathname;
  if (LAN && TOKEN && url.searchParams.get('token') !== TOKEN && req.headers['x-ai-sync-token'] !== TOKEN) {
    return sendJson(res, 401, { error: 'token 不对' });
  }
  try {
    if (p === '/' || p === '/index.html') {
      return send(res, 200, readFileSync(join(PUBLIC, 'index.html'), 'utf8'), MIME['.html']);
    }
    if (p === '/app.js' || p === '/style.css') {
      const f = join(PUBLIC, basename(p));
      if (!existsSync(f)) return send(res, 404, 'not found', 'text/plain');
      return send(res, 200, readFileSync(f, 'utf8'), MIME[extname(f)]);
    }

    if (p === '/api/status') {
      const out = join(INSTANCE, 'sync', 'state', '.console-status.json');
      const r = await node('sync-status.mjs', ['--out', out, '--quiet']);
      if (!existsSync(out)) return sendJson(res, 500, { error: `sync-status 未产出（exit ${r.code}）`, stderr: r.stderr.slice(-500) });
      return send(res, 200, readFileSync(out, 'utf8'));
    }

    if (p === '/api/instance') {
      if (req.method === 'GET') return sendJson(res, 200, { instance: INSTANCE, config: cfg });
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const next = { ...cfg, ...body, tick: { ...(cfg.tick || {}), ...(body.tick || {}) }, console: { ...(cfg.console || {}), ...(body.console || {}) }, owners: { ...(cfg.owners || {}), ...(body.owners || {}) }, producers: { ...(cfg.producers || {}), ...(body.producers || {}) } };
        writeFileSync(cfgFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
        const sched = await node('sync-schedule.mjs', ['--reconcile', '--json']);
        return sendJson(res, 200, { ok: true, saved: cfgFile, schedule: safeJson(sched.stdout) });
      }
    }

    if (p === '/api/adapters') {
      const load = (dir) => {
        const d = join(ENGINE, 'adapters', dir);
        if (!existsSync(d)) return [];
        return readdirSync(d)
          .filter((f) => f.endsWith('.json'))
          .map((f) => {
            try {
              return JSON.parse(readFileSync(join(d, f), 'utf8'));
            } catch {
              return { id: f, error: '解析失败' };
            }
          });
      };
      return sendJson(res, 200, { producers: load('producers'), owners: load('owners'), enabled: { producers: cfg.producers || {}, owners: cfg.owners || {} } });
    }

    if (p === '/api/fs') {
      return sendJson(res, 200, await listDirs(url.searchParams.get('path') || homedir()));
    }

    if (p === '/api/align') {
      const apply = url.searchParams.get('apply') === '1';
      const r = await node('sync-align.mjs', apply ? ['--apply'] : []);
      return sendJson(res, 200, { apply, code: r.code, stdout: r.stdout, stderr: r.stderr });
    }

    if (p === '/api/tick') {
      const tick = join(INSTANCE, 'sync', 'sync-lite.ps1');
      if (!existsSync(tick)) return sendJson(res, 500, { error: `缺 ${tick}` });
      const r = await run(pwshExe, ['-NoProfile', '-File', tick, '-NoJitter'], { timeout: 15 * 60 * 1000 });
      return sendJson(res, 200, { code: r.code, stdout: r.stdout, stderr: r.stderr });
    }

    if (p === '/api/logs') {
      const name = url.searchParams.get('name') || 'tick';
      const dir = join(INSTANCE, 'sync', 'logs');
      const cands = existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(name) && f.endsWith('.log')).sort() : [];
      if (!cands.length) return sendJson(res, 200, { files: [], tail: '(没有日志)' });
      const f = join(dir, cands[cands.length - 1]);
      const lines = readFileSync(f, 'utf8').trim().split(/\r?\n/);
      return sendJson(res, 200, { files: cands, file: f, tail: lines.slice(-120).join('\n') });
    }

    return sendJson(res, 404, { error: `没有这个接口：${p}` });
  } catch (e) {
    return sendJson(res, 500, { error: String(e?.message || e) });
  }
});

function readBody(req) {
  return new Promise((done) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => done(s));
  });
}
const safeJson = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return { raw: String(s).slice(0, 400) };
  }
};

server.listen(PORT, BIND, () => {
  const stateDir = join(INSTANCE, 'sync', 'state');
  try {
    if (!existsSync(stateDir)) require('node:fs').mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, '.console.pid'), String(process.pid), 'utf8');
  } catch {}
  console.log(`   [OK] ai-sync 控制台 http://${BIND}:${PORT}/`);
  if (LAN) {
    console.log(`   [WARN] 绑在 ${BIND}（非本机回环）—— 局域网可访问。${TOKEN ? '已启用 token。' : '**没有设 token，建议设 console.token**'}`);
  }
  if (cfg.console?.enabled === false) console.log('   [注] instance.json 里 console.enabled=false，但本次是手动启动（手动启动优先）');
});
