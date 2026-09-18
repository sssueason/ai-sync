#!/usr/bin/env node
/**
 * sync-apply — 幂等**应用器**：把"拉下来的新版本"变成"真的生效"（只做 tick 不做的那几件事）
 *
 * 为什么需要它：`git pull` 只改文件，不重编、不重注册、不动本机状态。以前每次都要人挨台机器手做，
 * 于是"补丁已发布"≠"已生效"，且没人能一眼看出哪端没跟上。
 *
 * 与既有机制的分工（**不造第二套**）：
 *   · tick 每轮已经在做：pull/commit/push、三个渲染器、日志裁剪、卫生门禁、一次性迁移
 *     ⇒ 这些**不进** apply-spec（重复机制比不做更糟）。
 *   · apply 只负责**tick 不做、且有可靠判据**的动作：平台调度对账、需要重编的产物（如 macOS 托盘）。
 *
 * 判定模型（借 DSC 的 Test/Set 分离 + chezmoi 的 run_onchange 思路）：
 *   1. `when.files` 的内容哈希没变 **且** 上次是 ok ⇒ 跳过（省掉反复调用）
 *   2. 否则先跑 **verify（Test）**：通过 ⇒ 记 ok（**verify 才是真值，哈希只是触发器**）
 *   3. 不通过 ⇒ 跑 **run（Set）**，再 verify 一次；仍不通过 ⇒ 记失败（连续 3 次 → blocked 停手）
 *   ⇒ 判据永远是"当前是否真的生效"，不是"我们以前跑过没有"。
 *
 * 安全约定：
 *   · 每个 unit 的 `run` 必须是**非破坏、可重入**的（删数据/跨端/云端动作一律走迁移的 manual 类）
 *   · 平台不匹配 ⇒ 跳过（不算失败）
 *   · 缺文件/缺工具 ⇒ 如实报失败（不许假装通过）
 *   · `--dry-run` 不写状态、不执行 run
 *
 * 用法：
 *   node tools/sync-apply.mjs [--instance <dir>] [--machine <id>] [--dry-run] [--json] [--quiet]
 *                             [--only <id>] [--force] [--list]
 * 退出码：0 = 全部生效/跳过；2 = 有 unit 失败或 blocked；3 = 用法/规格错误
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, relative } from 'node:path'
import { homedir, hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
/**
 * 引擎根 = **真正含有 install/install.mjs 的那一层**（与 install.mjs 自己"找含 tools/sync-tick.mjs 的那层"同一思路）。
 * 为什么要判：本脚本会同时存在于**实例副本**（<实例>/tools/）与**已装引擎**（<引擎>/tools/）两处，
 * 而"实例根"没有 install/install.mjs —— 直接取 `..` 会让 unit 里的 `{engine}` 指错地方（实测踩到）。
 */
const ENGINE = (() => {
  const cands = [process.env.AI_SYNC_ENGINE, resolve(join(HERE, '..')), join(homedir(), '.ai-sync', 'engine')].filter(Boolean)
  for (const c of cands) if (existsSync(join(c, 'install', 'install.mjs'))) return resolve(c)
  return resolve(join(HERE, '..'))
})()
const argv = process.argv.slice(2)
const val = (f, d = null) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d }
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE)
const DRY = argv.includes('--dry-run')
const AS_JSON = argv.includes('--json')
const QUIET = argv.includes('--quiet')
const FORCE = argv.includes('--force')
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

const SPEC = join(INSTANCE, 'sync', 'apply-spec.json')
const STATE_DIR = join(INSTANCE, 'sync', 'state')
const STATE_FILE = join(STATE_DIR, `apply-${machine}.json`)
const say = (m) => { if (!QUIET && !AS_JSON) console.log(m) }
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const expand = (s) => String(s).replaceAll('{engine}', ENGINE).replaceAll('{instance}', INSTANCE).replaceAll('{node}', process.execPath)

if (!existsSync(SPEC)) {
  console.error(`[FAIL] 找不到应用规格：${SPEC}`)
  process.exit(3)
}
const spec = readJSON(SPEC)
if (!spec || !Array.isArray(spec.units)) {
  console.error(`[FAIL] 应用规格格式不对（需要 { "units": [...] }）：${SPEC}`)
  process.exit(3)
}
const state = readJSON(STATE_FILE) || { machine, units: {}, blocked: {} }
state.machine = machine
state.units = state.units || {}
state.blocked = state.blocked || {}

if (LIST) {
  for (const u of spec.units) {
    const s = state.units[u.id]
    say(`  ${u.id}  [${(u.platforms || []).join('/') || 'any'}]  ${s && s.ok ? '已生效' : '未生效'}  ${u.reason || ''}`)
  }
  process.exit(0)
}

/** when.files 的内容哈希（含"匹配不到"这一事实，避免"文件消失"被当成"没变化"）。 */
function hashInputs(globs) {
  const h = createHash('sha256')
  const list = []
  for (const g of globs || []) {
    const base = join(INSTANCE, g.split('*')[0].replace(/[\\/][^\\/]*$/, ''))
    // 支持两种写法：具体文件路径，或 `dir/**`（递归取该目录下全部文件）
    if (g.includes('*')) {
      const root = join(INSTANCE, g.slice(0, g.indexOf('*')).replace(/[\\/]+$/, ''))
      const walk = (d) => {
        let es = []
        try { es = readdirSync(d, { withFileTypes: true }) } catch { return [] }
        const out = []
        for (const e of es) {
          if (['node_modules', '.git', 'dist'].includes(e.name)) continue
          const p = join(d, e.name)
          if (e.isDirectory()) out.push(...walk(p))
          else if (e.isFile()) out.push(p)
        }
        return out
      }
      const files = walk(root).sort()
      if (!files.length) h.update(`MISSING:${g}\n`)
      for (const f of files) { h.update(relative(INSTANCE, f) + '\n'); h.update(readFileSync(f)) }
      list.push(...files.map((f) => relative(INSTANCE, f)))
    } else {
      const p = join(INSTANCE, g)
      if (!existsSync(p)) { h.update(`MISSING:${g}\n`); list.push(g); continue }
      h.update(g + '\n'); h.update(readFileSync(p)); list.push(g)
    }
    void base
  }
  return { hash: h.digest('hex').slice(0, 16), inputs: list }
}

function runVerify(u) {
  const v = u.verify
  if (!v) return { ok: false, detail: '规格里没有 verify（无法判定是否生效 ⇒ 拒绝当成功）' }
  if (v.kind === 'artifact-newer') {
    const art = join(INSTANCE, v.artifact)
    if (!existsSync(art)) return { ok: false, detail: `产物不存在：${v.artifact}` }
    const at = statSync(art).mtimeMs
    for (const s of v.sources || []) {
      const sp = join(INSTANCE, s)
      if (existsSync(sp) && statSync(sp).mtimeMs > at) return { ok: false, detail: `源码比产物新：${s}` }
    }
    return { ok: true, detail: `产物比源码新：${v.artifact}` }
  }
  const a = (v.argv || []).map(expand)
  if (!a.length) return { ok: false, detail: 'verify.argv 为空' }
  const r = spawnSync(a[0], a.slice(1), { encoding: 'utf8', windowsHide: true, timeout: (u.timeoutSec || 180) * 1000, maxBuffer: 16 * 1024 * 1024 })
  const okExit = v.okExit || [0]
  const ok = okExit.includes(r.status)
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-1)[0] || ''
  return { ok, detail: ok ? (tail || 'verify 通过') : `verify 退出码 ${r.status}${tail ? `：${tail.slice(0, 120)}` : ''}` }
}

const results = { run: [], ok: [], skipped: [], failed: [] }

for (const u of spec.units) {
  if (ONLY && u.id !== ONLY) continue
  if (Array.isArray(u.platforms) && u.platforms.length && !u.platforms.includes(process.platform)) {
    results.skipped.push({ id: u.id, why: `平台不适用（${process.platform}）` })
    continue
  }
  if (state.blocked[u.id] && (state.blocked[u.id].tries || 0) >= MAX_TRIES && !FORCE) {
    results.failed.push({ id: u.id, why: `已连续失败 ${state.blocked[u.id].tries} 次 → blocked（修好后 --only ${u.id} --force）` })
    continue
  }
  const { hash, inputs } = hashInputs(u.when && u.when.files)
  const prev = state.units[u.id]
  if (!FORCE && prev && prev.ok && prev.hash === hash) {
    results.skipped.push({ id: u.id, why: '输入未变且上次已生效' })
    continue
  }
  const v1 = runVerify(u)
  if (v1.ok) {
    if (!DRY) { state.units[u.id] = { ok: true, hash, at: new Date().toISOString(), detail: v1.detail, inputs: inputs.length }; delete state.blocked[u.id] }
    results.ok.push({ id: u.id, detail: `verify 已通过（无需执行）：${v1.detail}` })
    say(`  [OK] ${u.id} 已生效（${v1.detail}）`)
    continue
  }
  if (DRY) {
    say(`  [DRY] 将执行 ${u.id}（verify 未通过：${v1.detail}）`)
    continue
  }
  const a = (u.run && u.run.argv || []).map(expand)
  if (!a.length) {
    results.failed.push({ id: u.id, why: 'run.argv 为空' })
    continue
  }
  say(`  [..] 执行 ${u.id} …`)
  const r = spawnSync(a[0], a.slice(1), { encoding: 'utf8', windowsHide: true, timeout: (u.timeoutSec || 180) * 1000, maxBuffer: 16 * 1024 * 1024 })
  const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').filter(Boolean).slice(-1)[0] || ''
  const v2 = runVerify(u)
  if (v2.ok) {
    state.units[u.id] = { ok: true, hash, at: new Date().toISOString(), detail: v2.detail, inputs: inputs.length }
    delete state.blocked[u.id]
    results.run.push({ id: u.id, detail: v2.detail, rc: r.status })
    say(`  [OK] ${u.id} 已执行并验证通过（${v2.detail}）`)
  } else {
    const tries = (state.blocked[u.id]?.tries || 0) + 1
    state.units[u.id] = { ok: false, hash, at: new Date().toISOString(), detail: `${v2.detail}${tail ? `（run 末行：${tail.slice(0, 100)}）` : ''}` }
    state.blocked[u.id] = { tries, at: new Date().toISOString() }
    results.failed.push({ id: u.id, why: `run 退出码 ${r.status}，之后 verify 仍不通过：${v2.detail}` })
    say(`  [FAIL] ${u.id} 执行后仍未生效（第 ${tries} 次）`)
  }
}

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
const bad = results.failed.length
if (AS_JSON) console.log(JSON.stringify({ machine, at: state.at, dryRun: DRY, ...results }, null, 2))
else {
  for (const x of results.failed) say(`  [FAIL] ${x.id} — ${x.why}`)
  say(`APPLY: run=${results.run.length} ok=${results.ok.length} skipped=${results.skipped.length} failed=${bad}${DRY ? ' (dry-run)' : ''}`)
}
process.exit(bad ? 2 : 0)
