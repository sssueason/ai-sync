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
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve, extname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

// 校验器：与 sync-doctor **共用一份实现**（规则不再两处漂）。动态 import，兼容两种布局：
//   原地：<仓根>/apps/sync-console/ → <仓根>/tools/sync-doctor.mjs
//   拆分：<引擎根>/apps/sync-console/ → <引擎根>/tools/sync-doctor.mjs
const doctorPath = join(HERE, '..', '..', 'tools', 'sync-doctor.mjs');
const doctorMod = existsSync(doctorPath) ? await import(pathToFileURL(doctorPath).href) : null;

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

// 审计 EN-5：原判据是 `if (LAN && TOKEN && ...)` —— 当**非本机绑定且没设 token** 时整个条件短路为假，
// 于是鉴权整体失效（远程可无鉴权访问 /api/status、/api/tick 等）。docs/OPERATIONS.md:64 本来就写着
// "必须设 token"，所以这里改为 **fail-closed**：配置矛盾时拒绝启动，而不是静默放行。
if (LAN && !TOKEN) {
  console.error(`[FAIL] 绑定 ${BIND} 且未设 token → 拒绝启动（否则远程可无鉴权调用 /api/* 与 /api/tick）。`);
  console.error('       修：instance.json 的 console.token 设一个随机串；或把 console.bind 改回 127.0.0.1。');
  process.exit(2);
}

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
      const root = realpathSync(r).replace(/[\\/]+$/, '').toLowerCase();
      const t = real.toLowerCase();
      // 审计修复：原写法是 `t.startsWith(root)` —— **缺分隔符**，于是允许根 <家目录>
      // 会连 <家目录>-evil（同前缀的兄弟目录）一起放行。
      // 必须要求"相等"或"以 root+分隔符开头"（此处刻意不写具体盘符路径：那会被发布门禁判成个人串）。
      return t === root || t.startsWith(root + '\\') || t.startsWith(root + '/');
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
      const probeName = '.ai-sync-write-probe';
      const probe = join(real, probeName);
      try {
        writeFileSync(probe, '');
        return true;
      } catch {
        return false;
      } finally {
        // 审计修复：原实现用 `require('node:fs').unlinkSync(probe)` 删除探针，而本文件是 ESM
        // ⇒ `require` 未定义 ⇒ 抛错被 catch 吞掉 ⇒ **探针文件永久留在被浏览的目录里**。
        // 那个目录若在某个仓库内，下一轮 `add -A` 就会把它推给所有机器。
        try {
          if (existsSync(probe)) unlinkSync(probe);
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
  // 审计 EN-6（CSRF）：状态变更型路由此前是**裸 GET**（`/api/tick`、`/api/align?apply=1`）
  // ⇒ 任意网页用一个 <img>/表单/sendBeacon 就能让本机跑一轮同步或执行对齐。
  // 判据（三层，缺一不可）：① Host 必须本机形态（防 DNS rebinding）
  //   ② 必须带自定义头 `X-AI-Sync-Console: 1`（跨站**无法**设置自定义头而不触发预检 ⇒ 挡住 CSRF）
  //   ③ `Sec-Fetch-Site` 不得是 cross-site（现代浏览器会带，缺失时按放行处理：老浏览器没有这个头）
  {
    const isWrite =
      req.method !== 'GET' ||
      p === '/api/tick' ||
      (p === '/api/align' && url.searchParams.get('apply') === '1');
    if (isWrite) {
      const hostOk = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(String(req.headers.host || ''));
      const hdrOk = req.headers['x-ai-sync-console'] === '1';
      const siteOk = String(req.headers['sec-fetch-site'] || '').toLowerCase() !== 'cross-site';
      if (!hostOk || !hdrOk || !siteOk) {
        return sendJson(res, 403, { error: '写操作需要本机 Host + 自定义头 X-AI-Sync-Console: 1（防 CSRF）' });
      }
    }
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
      // GET 每次重新读盘：POST 保存后如果返回启动时缓存的 cfg，用户看到的就是**过期预览**
      // （2026-09-17 实测：切了适配器开关，提示成功但页面配置没变 ⇒ 以为没生效）。
      if (req.method === 'GET') return sendJson(res, 200, { instance: INSTANCE, config: loadCfg() });
      if (req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const next = { ...cfg, ...body, tick: { ...(cfg.tick || {}), ...(body.tick || {}) }, console: { ...(cfg.console || {}), ...(body.console || {}) }, owners: { ...(cfg.owners || {}), ...(body.owners || {}) }, producers: { ...(cfg.producers || {}), ...(body.producers || {}) } };
        writeFileSync(cfgFile, JSON.stringify(next, null, 2) + '\n', 'utf8');
        Object.assign(cfg, next); // 内存里的也要跟上：/api/machine、/api/adapters 等读的是 cfg
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

    /* ---------------- 机器配置（同步空间 + 文件夹范围）----------------
     * 这是"部署后可以选本地同步空间 / 选同步文件夹范围"的落地点：直接编辑
     * <实例根>/sync/machines/<机器>.json 的 mu2 段，**写前逐项校验、校验不过不落盘**（避免半成品配置）。 */
    if (p === '/api/machine') {
      const mid =
        process.env.AI_SYNC_MACHINE ||
        process.env.DSH_MACHINE ||
        (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim() : hostname().toLowerCase());
      const mfile = join(INSTANCE, 'sync', 'machines', `${mid}.json`);
      const read = () => {
        try {
          return JSON.parse(readFileSync(mfile, 'utf8'));
        } catch {
          return {};
        }
      };
      if (req.method === 'GET') return sendJson(res, 200, { machine: mid, file: mfile, config: read() });

      if (req.method === 'POST') {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch (e) {
          return sendJson(res, 400, { errors: [`请求体不是 JSON：${e.message}`] });
        }
        const cur = read();
        const mu2in = body.mu2 || {};
        const candidate = { ...cur };
        if (mu2in.enabled === false) delete candidate.mu2;
        else {
          candidate.mu2 = {
            ...(cur.mu2 || {}),
            dest: String(mu2in.dest ?? cur.mu2?.dest ?? ''),
            autoSeed: mu2in.autoSeed !== false,
            sets: Array.isArray(mu2in.sets) ? mu2in.sets : cur.mu2?.sets || [],
          };
        }
        // **校验只此一份**：与 sync-doctor 共用 validateMachineConfig（2026-09-17 起；先前这里内联了一份会漂）。
        // 它同时给出**归一化**结果（~ 展开、target 去反斜杠），保存的就是归一化后的那份。
        if (!doctorMod?.validateMachineConfig) {
          return sendJson(res, 500, { errors: [`校验器不可用：找不到 tools/sync-doctor.mjs（找过 ${doctorPath || '(无候选)'}）`] });
        }
        const v = doctorMod.validateMachineConfig(candidate);
        if (v.errors.length) {
          return sendJson(res, 400, { errors: v.errors, warnings: v.warnings, hint: '校验不过不会落盘（宁可让你重填，也不写半成品配置）' });
        }
        const next = { ...cur };
        if (candidate.mu2) next.mu2 = v.normalized;
        else delete next.mu2;
        try {
          writeFileSync(mfile, JSON.stringify(next, null, 2) + '\n', 'utf8');
        } catch (e) {
          return sendJson(res, 500, { errors: [`写 ${mfile} 失败：${e.message}`] });
        }
        return sendJson(res, 200, {
          ok: true,
          file: mfile,
          config: next,
          dest: v.dest,
          warnings: v.warnings,
          looksCloudRoot: v.dest ? /baidu|百度|nutstore|坚果|onedrive|dropbox|icloud|syncdisk|同步空间/i.test(basename(v.dest)) : false,
        });
      }
    }

    // 范围预估：给"我到底要镜像多少东西"一个数（有上限，避免在大树上卡住）
    if (p === '/api/sets/estimate') {
      const src = expandHome(url.searchParams.get('path') || '');
      if (!src || !existsSync(src) || !statSync(src).isDirectory()) return sendJson(res, 200, { ok: false, error: '目录不存在或不是目录' });
      const cap = Number(url.searchParams.get('limit') || 30000);
      let files = 0;
      let bytes = 0;
      let truncated = false;
      const JUNK = /^(~\$|\.~lock\.|Thumbs\.db$|\.DS_Store$|desktop\.ini$)|\.(baiduyun)\./i;
      const stack = [src];
      const t0 = Date.now();
      while (stack.length) {
        const d = stack.pop();
        let ents = [];
        try {
          ents = readdirSync(d, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of ents) {
          const full = join(d, e.name);
          if (e.isDirectory()) {
            if (e.name === '.git' || e.name === 'node_modules') continue;
            stack.push(full);
          } else if (e.isFile()) {
            if (JUNK.test(e.name)) continue;
            files++;
            try {
              bytes += statSync(full).size;
            } catch {}
          }
          if (files > cap || Date.now() - t0 > 15000) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      return sendJson(res, 200, { ok: true, path: src, files, bytes, mb: Math.round((bytes / 1048576) * 10) / 10, truncated, cap });
    }

    if (p === '/api/align') {
      const apply = url.searchParams.get('apply') === '1';
      const wantJson = url.searchParams.get('json') === '1';
      const args = apply ? ['--apply'] : [];
      if (wantJson) args.push('--json');
      const r = await node('sync-align.mjs', args);
      // --json 时 stdout 就是一份完整 JSON（已实测可整体 parse）；解析失败不算错误，前端会退回看原始输出
      let plan = null;
      if (wantJson) {
        try {
          plan = JSON.parse(r.stdout.trim());
        } catch {}
      }
      return sendJson(res, 200, { apply, code: r.code, stdout: r.stdout, stderr: r.stderr, plan });
    }

    if (p === '/api/tick') {
      // 引擎的 node tick 优先：与托盘「立即同步」走同一条实现（跨平台单实现）。
      // 旧实例里的 sync-lite.ps1 只作回退 —— 同一动作两套实现会各自漂。
      const nodeTick = join(ENGINE, 'tools', 'sync-tick.mjs');
      if (existsSync(nodeTick)) {
        const r = await node('sync-tick.mjs', ['--no-jitter', '--trigger=console'], { timeout: 15 * 60 * 1000 });
        return sendJson(res, 200, { code: r.code, stdout: r.stdout, stderr: r.stderr, via: 'tools/sync-tick.mjs' });
      }
      const tick = join(INSTANCE, 'sync', 'sync-lite.ps1');
      if (!existsSync(tick)) return sendJson(res, 500, { error: `找不到 tick：${nodeTick} 与 ${tick} 都不存在` });
      const r = await run(pwshExe, ['-NoProfile', '-File', tick, '-NoJitter'], { timeout: 15 * 60 * 1000 });
      return sendJson(res, 200, { code: r.code, stdout: r.stdout, stderr: r.stderr, via: 'sync/sync-lite.ps1（回退）' });
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
