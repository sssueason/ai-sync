#!/usr/bin/env node
/**
 * sync-ops-bundle — 生成**自包含诊断包**（出事有档案，而不是"只活在瞬时 stdout 里"）
 *
 * 为什么需要：本项目多次出现"看得到红、说不清为什么"的情况 —— 一次性信号（打印前就被覆盖）、
 * `log=0B` 这类误导数字、托盘静默退出（应用日志无痕）。诊断包把**判定所依据的全部事实**落到一个
 * 可离线阅读的文件里：sync-status 全文、三项门禁/迁移/应用的状态与明细、最近的 tick 日志尾、
 * 两仓 git 状态与冲突判据、调度报告、镜像最新报告、以及"下一步看哪里"的固定映射。
 *
 * 设计约束：
 *   · **只读**：只跑只读命令 + 读文件；不改系统状态、不 commit（唯一写入物 = 报告文件本身）
 *   · **条件触发**：无触发条件时**不生成**（避免每 20 分钟堆一个包）；同指纹不重复生成
 *   · **自包含**：不依赖网络、不依赖 agent；人工（或会话内的 agent）拿到就能判断
 *   · 报告落在 `sync/reports/`（已 gitignore，由 sync-prune 按保留策略清理）
 *
 * 触发条件（满足任一条即生成）：
 *   hygiene.fails > 0 · migrate 有 failed/blocked · apply 有 failed/blocked · 本次 tick 有 issues
 *
 * 用法：
 *   node tools/sync-ops-bundle.mjs [--instance <dir>] [--machine <id>] [--reason <text>] [--force] [--json]
 *     --force  跳过条件与去重，强制生成（人工排查时用）
 * 退出码：0 = 已生成或无需生成；2 = 生成过程中出现致命问题；3 = 用法错误
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, dirname, basename } from 'node:path'
import { homedir, hostname } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
// 引擎根 = 含 install/install.mjs 的那一层（本工具会同时存在于实例副本与已装引擎两处）
const ENGINE = (() => {
  const cands = [process.env.AI_SYNC_ENGINE, resolve(join(HERE, '..')), join(homedir(), '.ai-sync', 'engine')].filter(Boolean)
  for (const c of cands) if (existsSync(join(c, 'install', 'install.mjs'))) return resolve(c)
  return resolve(join(HERE, '..'))
})()
const argv = process.argv.slice(2)
const val = (f, d = null) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d }
const INSTANCE = resolve(val('--instance') || process.env.AI_SYNC_INSTANCE || ENGINE)
const FORCE = argv.includes('--force')
const AS_JSON = argv.includes('--json')
const REASON = val('--reason', '')
const machine =
  val('--machine') ||
  process.env.AI_SYNC_MACHINE ||
  process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine'))
    ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim()
    : hostname().toLowerCase())

const STATE_DIR = join(INSTANCE, 'sync', 'state')
const REPORTS = join(INSTANCE, 'sync', 'reports')
const SIG_FILE = join(STATE_DIR, `ops-bundle-${machine}.json`)
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const stamp = () => new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)   // 20260918094429（去掉毫秒前的点，否则文件名出现双点）
const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120 * 1000, maxBuffer: 32 * 1024 * 1024 })
  return { rc: r.status, out: ((r.stdout || '') + (r.stderr || '')).trim() }
}

/* ---- 1. 收集事实（全部只读） ---- */
const hygiene = readJSON(join(STATE_DIR, `hygiene-${machine}.json`))
const migrate = readJSON(join(STATE_DIR, `migrations-${machine}.json`))
const apply = readJSON(join(STATE_DIR, `apply-${machine}.json`))
const tickJson = (() => {
  const r = sh(process.execPath, [join(ENGINE, 'tools', 'sync-status.mjs'), '--instance', INSTANCE, '--json'], ENGINE)
  try { return JSON.parse(r.out) } catch { return { broken: true, raw: r.out.slice(0, 4000) } }
})()
const statusText = (() => {
  const r = sh(process.execPath, [join(ENGINE, 'tools', 'sync-status.mjs'), '--instance', INSTANCE], ENGINE)
  return r.out
})()
const tickLog = (() => {
  const p = join(INSTANCE, 'sync', 'logs', `tick-${machine}.log`)
  if (!existsSync(p)) return '(没有 tick 日志)'
  const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean)
  return lines.slice(-40).join('\n')
})()

/* ---- 2. 触发条件 ---- */
const reasons = []
const hFails = hygiene && typeof hygiene.fails === 'number' ? hygiene.fails : 0
if (hFails > 0) reasons.push(`文本卫生门禁 FAIL=${hFails}`)
const migFailed = (migrate && Object.values(migrate.blocked || {}).length) || 0
if (migFailed) reasons.push(`迁移熔断 ${migFailed} 条`)
const appBlocked = (apply && Object.values(apply.blocked || {}).length) || 0
const appBad = apply && Object.values(apply.units || {}).filter((u) => u && u.ok === false).length
if (appBlocked) reasons.push(`应用熔断 ${appBlocked} 条`)
if (appBad) reasons.push(`应用未生效 ${appBad} 条`)
if (REASON) reasons.push(`人工指定：${REASON}`)

if (!reasons.length && !FORCE) {
  if (AS_JSON) console.log(JSON.stringify({ machine, generated: false, why: '无条件命中', at: new Date().toISOString() }, null, 2))
  else console.log('OPS-BUNDLE: 无条件命中，未生成（要强制生成加 --force）')
  process.exit(0)
}

const fingerprint = createHash('sha256')
  .update(JSON.stringify({ reasons, hFails, migFailed, appBlocked: appBlocked || 0, appBad: appBad || 0,
    engine: sh('git', ['-C', ENGINE, 'rev-parse', '--short', 'HEAD']).out }))
  .digest('hex').slice(0, 12)
const prevSig = readJSON(SIG_FILE)
if (!FORCE && prevSig && prevSig.fingerprint === fingerprint) {
  if (AS_JSON) console.log(JSON.stringify({ machine, generated: false, why: '同指纹已生成过', fingerprint, last: prevSig.at }, null, 2))
  else console.log(`OPS-BUNDLE: 同指纹（${fingerprint}）已于 ${prevSig.at} 生成过，不重复生成（要强制加 --force）`)
  process.exit(0)
}

/* ---- 3. 组装 ---- */
const gitState = {}
for (const repo of [INSTANCE, ENGINE]) {
  const name = basename(repo)
  gitState[name] = {
    head: sh('git', ['-C', repo, 'log', '--oneline', '-1']).out,
    status: sh('git', ['-C', repo, 'status', '--porcelain']).out || '(干净)',
    aheadBehind: sh('git', ['-C', repo, 'rev-list', '--left-right', '--count', 'HEAD...@{u}']).out || '(无上游)',
    conflicts: sh('git', ['-C', repo, 'ls-files', '-u']).out || '(无)',
  }
}
const lockDir = STATE_DIR
const locks = existsSync(lockDir) ? readdirSync(lockDir).filter((f) => f.endsWith('.lock')) : []
const sched = sh(process.execPath, [join(ENGINE, 'install', 'install.mjs'), '--instance', INSTANCE], ENGINE)
const latestTreeSync = (() => {
  try {
    const fs = readdirSync(REPORTS).filter((f) => /^tree-sync-.*\.md$/.test(f)).map((f) => ({ f, m: statSync(join(REPORTS, f)).mtimeMs })).sort((a, b) => b.m - a.m)
    return fs.length ? `${fs[0].f}（${new Date(fs[0].m).toISOString()}）` : '(无)'
  } catch { return '(读不到 reports 目录)' }
})()
const engineRev = sh('git', ['-C', ENGINE, 'log', '--oneline', '-1']).out
const nextSteps = []
if (hFails > 0) nextSteps.push('文本卫生：按 `sync/state/hygiene-<machine>.json` 的 top[] 逐条修（BOM 用 UTF-8 带 BOM 重写；EOL 用 git 重新检出；冲突标记手工合并；状态文件加入 .gitignore）')
if (migFailed) nextSteps.push('迁移熔断：`node tools/sync-migrate.mjs --list` 看是哪条，修好后 `--only <id>` 重跑')
if (appBlocked || appBad) nextSteps.push('应用未生效：`node tools/sync-apply.mjs --list` 看是哪条；`--only <id> --dry-run` 看它打算做什么')
if (!reasons.filter((r) => r.startsWith('人工')).length && !hFails && !migFailed && !appBlocked && !appBad) nextSteps.push('本次为强制生成（人工排查）：先看下面的 sync-status 全文与 tick 日志尾')

const md = []
md.push(`# 诊断包 · ${machine} · ${new Date().toISOString()}`)
md.push('')
md.push(`- 触发原因：${reasons.join(' · ')}`)
md.push(`- 指纹：\`${fingerprint}\`（同指纹不会重复生成）`)
md.push(`- 引擎：\`${engineRev}\``)
md.push(`- 实例：\`${INSTANCE}\``)
md.push(`- 镜像最新 tree-sync 报告：${latestTreeSync}`)
md.push(`- 锁文件：${locks.length ? locks.join(', ') : '无'}`)
md.push('')
md.push('## 0. 先看这里（固定映射，不是推测）')
for (const s of nextSteps) md.push(`- ${s}`)
md.push('')
md.push('## 1. sync-status 全文（判定所依据的每一条断言）')
md.push('```')
md.push(statusText || '(无输出)')
md.push('```')
md.push('')
md.push('## 2. 三项状态文件的摘要')
md.push(`- 文本卫生：\`${JSON.stringify({ fails: hygiene?.fails ?? null, warns: hygiene?.warns ?? null, at: hygiene?.at ?? null })}\``)
if (hygiene?.top?.length) { md.push('- 卫生明细（top）：'); for (const t of hygiene.top.slice(0, 10)) md.push(`  - [${t.sev}] ${t.rule} ${t.repo}/${t.rel} — ${t.detail}`) }
md.push(`- 迁移：\`${JSON.stringify({ applied: Object.keys(migrate?.applied || {}).length, blocked: Object.keys(migrate?.blocked || {}), pendingManual: (migrate?.pendingManual || []).map((p) => p.id), at: migrate?.at ?? null })}\``)
md.push(`- 应用：\`${JSON.stringify({ units: Object.entries(apply?.units || {}).map(([k, v]) => `${k}:${v.ok ? 'ok' : 'BAD'}`), blocked: Object.keys(apply?.blocked || {}), at: apply?.at ?? null })}\``)
md.push('')
md.push('## 3. 最近的 tick 日志（末 40 行；含 [FAIL]/[注] 明细）')
md.push('```')
md.push(tickLog)
md.push('```')
md.push('')
md.push('## 4. 两仓 git 状态（冲突判据用 `ls-files -u`，不看退出码）')
for (const [k, v] of Object.entries(gitState)) {
  md.push(`### ${k}`)
  md.push(`- HEAD：${v.head}`)
  md.push(`- ahead/behind：${v.aheadBehind}`)
  md.push('- 未提交：')
  md.push('```')
  md.push(v.status)
  md.push('```')
  md.push(`- 未合并（冲突）：${v.conflicts}`)
}
md.push('')
md.push('## 5. 平台调度报告（install.mjs 报告模式）')
md.push('```')
md.push(sched.out || '(无输出)')
md.push('```')
md.push('')
md.push('## 6. sync-status --json（给工具/agent 消费的结构化版本）')
md.push('```json')
md.push(JSON.stringify(tickJson, null, 2).slice(0, 20000))
md.push('```')
md.push('')
md.push('---')
md.push('本包由 `tools/sync-ops-bundle.mjs` 生成；**只读采集**，不含任何修改动作。保留策略由 `tools/sync-prune.mjs` 统一裁剪（`sync/reports/`）。')

mkdirSync(REPORTS, { recursive: true })
const out = join(REPORTS, `ops-bundle-${machine}-${stamp()}.md`)
writeFileSync(out, md.join('\n') + '\n', 'utf8')
try {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(SIG_FILE, JSON.stringify({ machine, fingerprint, at: new Date().toISOString(), out: basename(out), reasons }, null, 2) + '\n', 'utf8')
} catch { /* 状态写不进去不该让整件事失败：报告已经落盘了 */ }

if (AS_JSON) console.log(JSON.stringify({ machine, generated: true, out, fingerprint, reasons, bytes: md.join('\n').length }, null, 2))
else {
  console.log(`OPS-BUNDLE: 已生成 ${out}`)
  console.log(`  触发原因：${reasons.join(' · ')}`)
  console.log(`  指纹：${fingerprint}（同指纹不重复生成）`)
}
process.exit(0)
