#!/usr/bin/env node
/**
 * sync-migrate — 一次性迁移的**执行器**（幂等、可重入、可打印计划）
 *
 * 为什么需要它（本轮痛点）：拉下来的改动里，总有一部分"不是改文件就完事"，而是要在**每一端**
 * 各跑一次（改本机 live 配置、重编托盘、重注册调度、跑一次清理…）。以前这些都靠人挨个机器手做，
 * 于是"补丁已发布"≠"已生效"，而没人能一眼看出哪端没跟上。
 *
 * 分工（重要）：
 *   · **迁移定义**放**实例** `sync/migrations/`（随实例仓 git 分发到所有机器）
 *   · **执行器**放**引擎** `tools/`（随引擎分发；用 node 跨平台，不写第二套 ps1/sh）
 *   · 每次执行的结果落 `sync/state/migrations-<machine>.json`（机器本地，永不入 git）
 *
 * 迁移模块契约（`sync/migrations/<file>.mjs`）：
 *   export const meta = { id, danger: 'safe'|'manual', platforms: ['win32','darwin','linux'], reason, ref }
 *   export function check(ctx)  -> { ok: boolean, detail?: string }   // 幂等判据：已生效则 ok=true
 *   export function apply(ctx)  -> { changed?: boolean, detail?: string } // 只在 check 不通过时调用；必须可重入
 *   ctx = { instance, machine, dryRun, log(msg), home }
 *
 * 安全约定：
 *   · `danger: 'manual'` 的条目**永不执行**，只登记为"待人工"（删数据、跨端/云端删除、改机器清单一类）
 *   · 同一 id 连续失败 3 次后标记 `blocked` 并停止重试（否则每轮 tick 都在撞同一堵墙）
 *   · `check()` 每轮都跑（便宜）⇒ **能发现"被改回去了"**，不是"跑过就不再管"
 *   · --dry-run 只打印计划，不写状态、不动文件
 *
 * 用法：
 *   node tools/sync-migrate.mjs [--instance <dir>] [--machine <id>] [--dry-run] [--json] [--quiet] [--only <id>] [--list]
 * 退出码：0 = 无失败（可含待人工）；2 = 有 safe 迁移失败/blocked；3 = 用法或清单错误
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, hostname } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const val = (f, d = null) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d }
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || join(HERE, '..'))
const DRY = argv.includes('--dry-run')
const AS_JSON = argv.includes('--json')
const QUIET = argv.includes('--quiet')
const ONLY = val('--only', null)
const LIST = argv.includes('--list')
const MAX_TRIES = 3
const machine =
  val('--machine') ||
  process.env.AI_SYNC_MACHINE ||
  process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine'))
    ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim()
    : hostname().toLowerCase())

const MIG_DIR = join(INSTANCE, 'sync', 'migrations')
const MANIFEST = join(MIG_DIR, 'MANIFEST.json')
const STATE_DIR = join(INSTANCE, 'sync', 'state')
const STATE_FILE = join(STATE_DIR, `migrations-${machine}.json`)

const say = (m) => { if (!QUIET && !AS_JSON) console.log(m) }
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }

if (!existsSync(MANIFEST)) {
  console.error(`[FAIL] 找不到迁移清单：${MANIFEST}`)
  process.exit(3)
}
const manifest = readJSON(MANIFEST)
if (!manifest || !Array.isArray(manifest.migrations)) {
  console.error(`[FAIL] 迁移清单格式不对（需要 { "migrations": [...] }）：${MANIFEST}`)
  process.exit(3)
}

const state = readJSON(STATE_FILE) || { machine, applied: {}, blocked: {}, pendingManual: [] }
state.machine = machine
state.applied = state.applied || {}
state.blocked = state.blocked || {}

if (LIST) {
  for (const m of manifest.migrations) {
    const a = state.applied[m.id]
    say(`  ${m.danger === 'manual' ? '[manual]' : '[safe]  '} ${m.id}  ${a && a.ok ? '已生效' : '未生效'}  ${m.reason || ''}`)
  }
  process.exit(0)
}

const results = { applied: [], skipped: [], failed: [], manual: [], mismatched: [] }
const pendingManual = []

for (const m of manifest.migrations) {
  if (ONLY && m.id !== ONLY) continue
  if (Array.isArray(m.platforms) && m.platforms.length && !m.platforms.includes(process.platform)) {
    results.skipped.push({ id: m.id, why: `平台不适用（${process.platform}）` })
    continue
  }
  // manual-only：**永不执行**，只登记（含可直接复制的命令/说明，方便人工放行）
  if (m.danger === 'manual') {
    const done = state.applied[m.id] && state.applied[m.id].ok === true
    pendingManual.push({ id: m.id, reason: m.reason || '', ref: m.ref || '', done })
    if (!done) results.manual.push({ id: m.id, reason: m.reason || '' })
    continue
  }
  const file = join(MIG_DIR, m.file || `${m.id}.mjs`)
  if (!existsSync(file)) {
    results.failed.push({ id: m.id, why: `迁移文件不存在：${file}` })
    continue
  }
  let mod
  try {
    mod = await import(pathToFileURL(file).href)
  } catch (e) {
    results.failed.push({ id: m.id, why: `import 失败：${e.message}` })
    continue
  }
  if (!mod.meta || mod.meta.id !== m.id) {
    // 清单与模块必须一致，否则"清单说 A、执行的是 B"——这一类错必须当失败，不能容忍
    results.mismatched.push({ id: m.id, why: `模块 meta.id=${mod.meta && mod.meta.id} 与清单不一致` })
    continue
  }
  const ctx = { instance: INSTANCE, machine, home: homedir(), dryRun: DRY, log: (x) => say(`      ${x}`) }
  let chk = null
  try {
    chk = await mod.check(ctx)
  } catch (e) {
    results.failed.push({ id: m.id, why: `check 抛错：${e.message}` })
    continue
  }
  if (chk && chk.ok) {
    results.skipped.push({ id: m.id, why: `已生效（${chk.detail || ''}）` })
    if (!DRY) state.applied[m.id] = { ok: true, at: new Date().toISOString(), detail: chk.detail || '', tries: (state.applied[m.id]?.tries || 0) }
    delete state.blocked[m.id]
    continue
  }
  // skip = 本机不适用（例如没装对应工具）⇒ 记跳过、不算失败、不重试报错。
  // check() 每轮都会重跑 ⇒ 工具后来装上了，下一轮自然就会应用（不需要"回头再手动跑一次"）。
  if (chk && chk.skip) {
    results.skipped.push({ id: m.id, why: `本机不适用：${chk.detail || ''}` })
    if (!DRY) state.applied[m.id] = { ok: true, skipped: true, at: new Date().toISOString(), detail: chk.detail || '' }
    delete state.blocked[m.id]
    continue
  }
  const tries = (state.applied[m.id]?.tries || 0) + (state.applied[m.id]?.ok ? 0 : 1)
  if (state.blocked[m.id] && (state.blocked[m.id].tries || 0) >= MAX_TRIES) {
    results.failed.push({ id: m.id, why: `已连续失败 ${state.blocked[m.id].tries} 次 → blocked（先人工排查，改好后跑 --only ${m.id}）` })
    continue
  }
  if (DRY) {
    say(`  [DRY] 将执行 ${m.id}（当前：${chk && chk.detail ? chk.detail : '未生效'}）`)
    continue
  }
  say(`  [..] 执行迁移 ${m.id} …`)
  try {
    const r = await mod.apply(ctx)
    const after = await mod.check(ctx)
    if (after && after.ok) {
      state.applied[m.id] = { ok: true, at: new Date().toISOString(), detail: after.detail || (r && r.detail) || '', tries }
      delete state.blocked[m.id]
      results.applied.push({ id: m.id, detail: after.detail || '' })
      say(`  [OK] ${m.id} 已生效（${after.detail || ''}）`)
    } else {
      state.applied[m.id] = { ok: false, at: new Date().toISOString(), detail: after && after.detail, tries }
      state.blocked[m.id] = { tries, at: new Date().toISOString() }
      results.failed.push({ id: m.id, why: `apply 后 check 仍不通过（${after && after.detail}）` })
      say(`  [FAIL] ${m.id} apply 后仍未生效`)
    }
  } catch (e) {
    state.applied[m.id] = { ok: false, at: new Date().toISOString(), detail: `异常：${e.message}`, tries }
    state.blocked[m.id] = { tries, at: new Date().toISOString() }
    results.failed.push({ id: m.id, why: `apply 抛错：${e.message}` })
    say(`  [FAIL] ${m.id} 执行异常：${e.message}`)
  }
}

state.pendingManual = pendingManual
state.at = new Date().toISOString()

if (!DRY) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf8')
  } catch (e) {
    console.error(`[FAIL] 写状态失败：${e.message}`)
    process.exit(2)
  }
}

const bad = results.failed.length + results.mismatched.length
if (AS_JSON) {
  console.log(JSON.stringify({ machine, at: state.at, dryRun: DRY, manifestVersion: manifest.version || null, ...results, pendingManual: pendingManual.filter((p) => !p.done) }, null, 2))
} else {
  for (const x of results.mismatched) say(`  [FAIL] 清单/模块不一致：${x.id} — ${x.why}`)
  for (const x of results.failed) say(`  [FAIL] ${x.id} — ${x.why}`)
  if (pendingManual.filter((p) => !p.done).length) {
    say('  --- 待人工（脚本不代劳：删数据/跨端/改机器清单一类）---')
    for (const p of pendingManual.filter((x) => !x.done)) say(`  [manual] ${p.id} — ${p.reason}${p.ref ? `（${p.ref}）` : ''}`)
  }
  say(`MIGRATE: applied=${results.applied.length} ok=${results.skipped.length} failed=${bad} manual=${pendingManual.filter((p) => !p.done).length}${DRY ? ' (dry-run)' : ''}`)
}
process.exit(bad ? 2 : 0)
