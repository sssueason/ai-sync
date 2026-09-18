#!/usr/bin/env node
/**
 * sync-triage — 用**免费模型做只读分诊**（默认关闭；开了也只出建议，绝不执行任何写操作）
 *
 * 定位（本项目立场，见 docs/ops-playbook.md §8）：**脚本优先，agent 只做诊断**。
 * 本工具把"诊断包里的事实"交给一个免费模型，让它**在固定枚举里选一个类别 + 从一个固定清单里选一条建议**，
 * 输出严格 JSON。它**不产生命令、不执行命令、没有写权限** —— 最坏情况是"没建议"，基线行为（诊断包）不变。
 *
 * 为什么是这个形态（2026-09-18 实测）：
 *   · 免费模型实测可用且无需登录（`opencode/mimo-v2.5-free`：10–46s、8 次调用无 429）；
 *     而 `muse-spark-*` 被判 `not available in your country`（地域封锁）⇒ 单一默认 + 不可用时降级。
 *   · **事实走附件**（`-f`）、格式走指令：把整段提示词内联进命令行会被引号/竖线咬，
 *     而要求模型"复述某个 JSON 模板"会被它当成提示注入拒绝（实测）。
 *   · 调用方式：直接 spawn **原生 exe**（npm shim 是 .cmd，Node 以 EINVAL 拒绝 spawn .cmd）。
 *
 * 硬约束：
 *   · 只读：唯一写入物 = `sync/state/triage-<machine>.json` 与 `sync/logs/agent-ops-*.log`
 *   · 频控：默认 ≥60 分钟一次；同事实指纹不重复调用（`--force` 可绕过）
 *   · 超时/不可用/解析失败 ⇒ 记下来、**不改 tick 的 rc**（诊断失败不是同步故障）
 *
 * 用法：
 *   node tools/sync-triage.mjs [--instance <dir>] [--machine <id>] [--bundle <file>]
 *                              [--input <file>] [--model <id>] [--force] [--dry-run] [--json]
 *     --input  直接用给定文件作为"指令+事实"（金标集评分用；跳过诊断包提取）
 * 退出码：0 = 已分诊或按策略跳过；3 = 用法错误（模型不可用/解析失败**不**算 3）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, hostname, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const HERE = dirname(fileURLToPath(import.meta.url))
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
const FORCE = argv.includes('--force')
const INPUT = val('--input', null)
const machine = val('--machine') || process.env.AI_SYNC_MACHINE || process.env.DSH_MACHINE ||
  (existsSync(join(INSTANCE, 'sync', 'local.machine')) ? readFileSync(join(INSTANCE, 'sync', 'local.machine'), 'utf8').trim() : hostname().toLowerCase())
const STATE_DIR = join(INSTANCE, 'sync', 'state')
const LOG_DIR = join(INSTANCE, 'sync', 'logs')
const SIG = join(STATE_DIR, `triage-${machine}.json`)
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const cfg = readJSON(join(INSTANCE, 'sync', 'instance.json')) || {}
const TRI = cfg.triage || {}
if (TRI.enabled === false && !FORCE && !INPUT) {
  console.log(AS_JSON ? JSON.stringify({ ok: false, skipped: true, why: 'sync/instance.json 里 triage.enabled=false' }) : 'TRIAGE: 已关闭（triage.enabled=false），跳过')
  process.exit(0)
}
const MODEL = val('--model', TRI.model || 'opencode/mimo-v2.5-free')
const MIN_INTERVAL_MIN = Number(TRI.minIntervalMinutes || 60)

/* --- 互斥枚举与固定建议清单（**改动这两个清单 = 改动评分基准**，金标集在 sync/triage-goldset.json） --- */
const CLASSES = [
  ['text-hygiene', '文本/编码/行尾/冲突标记/BOM/机器本地文件被提交一类'],
  ['git-divergence', '两仓 git 状态问题（ahead/behind、未合并冲突 `ls-files -u` 非空、推送失败）'],
  ['schedule-drift', '平台调度与配置不一致（tick 未注册/间隔不符/超过应有间隔没跑）'],
  ['engine-behind', '引擎代码落后远端'],
  ['migration-blocked', '一次性迁移熔断，或迁移执行后仍不生效'],
  ['apply-not-effective', '应用 unit 未生效或熔断（与具体是哪个 unit 无关）'],
  ['mirror-drift', 'µ2 镜像（云盘同步空间）与**本地树**不一致 —— `tree-sync`/`seed` 报告里的「待推 / 待拉 / 冲突 / 一致」字样属于这一类（**注意：这是镜像的推拉，不是 git 的推送**）'],
  ['client-artifact', '云盘客户端噪音（`_冲突文件_` / `.baiduyun.*` / `desktop.ini`）'],
  ['unknown', '以上都不匹配'],
]
const REMEDIES = [
  'run-text-hygiene-fix', 'check-git-divergence', 're-register-schedule', 'update-engine',
  'inspect-migration', 'inspect-apply', 'run-tree-sync-apply', 'renew-prune-conflict-copies', 'open-playbook',
]

/* --- 提取事实（默认从最新诊断包；**有界**，因为模型上下文小） --- */
function factsFromBundle() {
  let newest = null
  try {
    for (const f of readdirSync(join(INSTANCE, 'sync', 'reports'))) {
      if (!/^ops-bundle-.*\.md$/.test(f)) continue
      const p = join(INSTANCE, 'sync', 'reports', f)
      const m = statSync(p).mtimeMs
      if (!newest || m > newest.m) newest = { p, f, m }
    }
  } catch { /* 没有 reports 目录 */ }
  if (!newest) return null
  const txt = readFileSync(newest.p, 'utf8')
  const lines = txt.split(/\r?\n/)
  const out = []
  let section = ''
  let tickLines = 0
  for (const l of lines) {
    if (/^## /.test(l)) { section = l.slice(0, 12); continue }
    if (section.startsWith('## 1.')) { if (/\[FAIL\]|\[WARN\]|判定/.test(l)) out.push(`[status] ${l.trim()}`) }
    else if (section.startsWith('## 2.')) { if (/^- (文本卫生|迁移|应用)/.test(l)) out.push(`[state] ${l.trim()}`) }
    else if (section.startsWith('## 3.')) { if (l.trim() && tickLines < 15) { out.push(`[tick] ${l.trim()}`); tickLines++ } }
    else if (section.startsWith('## 4.')) { if (/^- HEAD|^- ahead\/behind|^- 未合并/.test(l)) out.push(`[git] ${l.trim()}`) }
  }
  return { file: newest.f, text: out.join('\n').slice(0, 6000) }
}

const facts = INPUT
  ? { file: INPUT, text: readFileSync(INPUT, 'utf8') }
  : factsFromBundle()
if (!facts) {
  console.log(AS_JSON ? JSON.stringify({ ok: false, skipped: true, why: '没有诊断包可读（先跑 tools/sync-ops-bundle.mjs）' }) : 'TRIAGE: 没有诊断包可读，跳过')
  process.exit(0)
}

const fingerprint = createHash('sha256').update(facts.text).digest('hex').slice(0, 12)
const prev = readJSON(SIG)
if (!FORCE && !INPUT && prev && prev.fingerprint === fingerprint) {
  console.log(AS_JSON ? JSON.stringify({ ok: false, skipped: true, why: '同事实指纹已分诊过', fingerprint, last: prev.at, verdict: prev.verdict }) : `TRIAGE: 同事实指纹（${fingerprint}）已于 ${prev.at} 分诊过，跳过`)
  process.exit(0)
}
if (!FORCE && !INPUT && prev && prev.at) {
  const ageMin = (Date.now() - Date.parse(prev.at)) / 60000
  if (Number.isFinite(ageMin) && ageMin < MIN_INTERVAL_MIN) {
    console.log(AS_JSON ? JSON.stringify({ ok: false, skipped: true, why: `距上次 ${Math.round(ageMin)} 分钟 < ${MIN_INTERVAL_MIN}`, last: prev.at }) : `TRIAGE: 距上次分诊 ${Math.round(ageMin)} 分钟 < ${MIN_INTERVAL_MIN} 分钟，跳过（--force 可绕过）`)
    process.exit(0)
  }
}

/* --- 找到 opencode 可执行文件（**原生 exe**：Node 不能 spawn .cmd，会 EINVAL） --- */
function findOpencode() {
  const cands = []
  if (process.env.OPENCODE_BIN) cands.push(process.env.OPENCODE_BIN)
  if (process.platform === 'win32') {
    cands.push(join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
    cands.push(join(process.env.LOCALAPPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'))
  } else {
    cands.push(join(homedir(), '.local', 'bin', 'opencode'))
    cands.push('/usr/local/bin/opencode')
    cands.push('/opt/homebrew/bin/opencode')
  }
  for (const c of cands) if (c && existsSync(c)) return c
  // 兜底：交给 PATH（POSIX 上可执行；Windows 上若无 .exe 路径命中则会失败，如实记录）
  return process.platform === 'win32' ? null : 'opencode'
}
const BIN = findOpencode()

/* --- 组装"指令 + 事实"（事实走附件；格式走指令 —— 内联模板会被模型当成提示注入拒绝） --- */
const promptText = [
  '你是同步系统的**分诊器**。下面给你一份诊断包的事实摘要；请判断它最符合哪一类问题，并给出建议。',
  '',
  '严格只输出一个 JSON 对象（不要解释、不要 markdown 围栏）：',
  '{"class":"<枚举值>","remedy":"<建议id>","confidence":<0~1>,"human_reason":"<=40字"}',
  '',
  'class **互斥枚举**（只能选一个，按最具体的选）：',
  ...CLASSES.map(([k, v]) => `- ${k}：${v}`),
  '',
  'remedy 只能从这个清单里选一个：',
  `- ${REMEDIES.join(' | ')}`,
  '',
  '判读要点：',
  '- 涉及"某个 apply unit 未生效/熔断" ⇒ apply-not-effective（不要选 schedule-drift，除非事实明确说"调度与配置不一致/未注册"）',
  '- 涉及"某条迁移熔断或执行后仍不生效" ⇒ migration-blocked',
  '- 云盘客户端产生的副本/临时件 ⇒ client-artifact；镜像与本地树的待推/待拉/冲突 ⇒ mirror-drift',
  '- **词面区分**：出现 `tree-sync` / `seed` / 镜像 / 云盘 / 待推 / 待拉 ⇒ mirror-drift；',
  '  出现 `git push` / `pull` / `ahead` / `behind` / `non-fast-forward` / `ls-files -u` ⇒ git-divergence。',
  '  两者都会出现"推/拉"字样 —— 看**主体**是镜像还是 git 仓。',
  '- 事实不足以下判断时选 unknown + open-playbook，**不要猜**',
  '',
  '=== 事实摘要 ===',
  facts.text || '(空)',
  '',
].join('\n')

const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)
const promptPath = join(tmpdir(), `sync-triage-${machine}-${stamp}.md`)
writeFileSync(promptPath, promptText, 'utf8')
const MSG = '读附件里的"分诊要求与事实摘要"，按其规定的 JSON 格式给出你的判定。'

if (DRY) {
  console.log(`TRIAGE(dry-run): 模型=${MODEL} 事实来源=${facts.file} 指纹=${fingerprint} 提示词=${promptPath}（${promptText.length} 字节）`)
  process.exit(0)
}
if (!BIN) {
  record({ ok: false, why: '找不到 opencode 可执行文件（设 OPENCODE_BIN 或安装 opencode）', model: MODEL, fingerprint, factsFile: facts.file })
  process.exit(0)
}

const t0 = Date.now()
const r = spawnSync(BIN, ['run', MSG, '--model', MODEL, '--dir', tmpdir(), '-f', promptPath],
  { encoding: 'utf8', windowsHide: true, timeout: 240 * 1000, maxBuffer: 16 * 1024 * 1024 })
const elapsedSec = Math.round((Date.now() - t0) / 1000)
try { rmSync(promptPath, { force: true }) } catch { /* 临时文件清理失败无所谓 */ }

const stdout = String(r.stdout || '')
const stderr = String(r.stderr || '')
const m = stdout.match(/\{[\s\S]*?\}/)
let verdict = null
let parse = 'ok'
if (!m) parse = 'no-json'
else {
  try {
    const j = JSON.parse(m[0])
    if (!CLASSES.some(([k]) => k === j.class)) parse = 'bad-class'
    else if (!REMEDIES.includes(j.remedy)) parse = 'bad-remedy'
    else verdict = { class: j.class, remedy: j.remedy, confidence: Number(j.confidence), human_reason: String(j.human_reason || '').slice(0, 80) }
  } catch { parse = 'bad-json' }
}
const ok = parse === 'ok' && !!verdict
const tail = (stdout + stderr).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' / ').slice(0, 300)

record({ ok, parse, model: MODEL, fingerprint, factsFile: facts.file, elapsedSec, rc: r.status, verdict, tail })

function record(payload) {
  const rec = { machine, at: new Date().toISOString(), ...payload }
  // 一次失败（模型不可用/解析失败）**不该抹掉上一次的有效判定**：保留 lastGood 供人回看
  if (!INPUT) {
    try {
      const prevSig = JSON.parse(readFileSync(SIG, 'utf8'))
      rec.lastGood = rec.verdict ? rec.verdict : (prevSig.lastGood || prevSig.verdict || null)
      if (rec.lastGood && !rec.verdict) rec.lastGoodFrom = prevSig.lastGoodFrom || prevSig.at || null
    } catch { rec.lastGood = rec.verdict || null }
    try {
      mkdirSync(STATE_DIR, { recursive: true })
      writeFileSync(SIG, JSON.stringify(rec, null, 2) + '\n', 'utf8')
    } catch { /* 状态写不进不该让分诊本身失败 */ }
  }
  try {
    mkdirSync(LOG_DIR, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    appendFileSync(join(LOG_DIR, `agent-ops-${day}.log`), [
      `--- ${rec.at} · ${machine}${INPUT ? ' · [金标集评分]' : ''} · 模型 ${payload.model || '(未调用)'} ---`,
      `事实来源：${payload.factsFile || '-'}   指纹：${payload.fingerprint || '-'}   用时：${payload.elapsedSec ?? '-'}s   rc：${payload.rc ?? '-'}`,
      payload.verdict ? `判定：${payload.verdict.class} → ${payload.verdict.remedy}（置信 ${payload.verdict.confidence}）${payload.verdict.human_reason}` : `未得到可用判定：${payload.parse || payload.why || ''}`,
      payload.tail ? `原始输出尾：${payload.tail}` : '',
      '',
    ].filter(Boolean).join('\n'), 'utf8')
  } catch { /* 日志写不进同理 */ }
  if (AS_JSON) console.log(JSON.stringify(rec, null, 2))
  else if (ok) console.log(`TRIAGE: ${rec.verdict.class} → ${rec.verdict.remedy}（置信 ${rec.verdict.confidence}）${rec.verdict.human_reason}  [${elapsedSec}s, ${MODEL}]`)
  else console.log(`TRIAGE: 未得到可用判定（${parse}${payload.why ? `：${payload.why}` : ''}）—— 基线行为不变（诊断包仍在 sync/reports/）`)
}
process.exit(0)
