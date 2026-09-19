#!/usr/bin/env node
/**
 * sync-hygiene — 文本卫生门禁（**只报不改**，可被 tick / 发布前 / 人工调用）
 *
 * 为什么需要（三类真实事故，都有现场证据）：
 *   ① BOM：含非 ASCII 的 PowerShell / VBS 脚本若缺 UTF-8 BOM，Windows PowerShell **5.1** 会按
 *      本地代码页（GBK）解码 ⇒ 解析报错或中文乱码。实测某启动器因此被解析出 5 处语法错误；
 *      而这一隐患在 PowerShell 7 下**完全不可见**（7 默认 UTF-8）⇒ 必须静态检查，不能靠跑一遍。
 *      反向陷阱：非 PowerShell 的编辑器/补丁工具改文件会**吃掉 BOM**，改完必须复查首三字节。
 *   ② EOL：`*.sh` 带 CRLF 时 bash 报 `\r: command not found`；`*.cmd`/`*.bat` 需要 CRLF。
 *   ③ 冲突标记 / 机器本地文件被提交：`pull --rebase --autostash` 在回填冲突时**返回 0 却留下
 *      冲突树**，随后被顺手 `git add -A` 提交；机器本地状态（命令文件、节流戳、日志、报告、
 *      构建产物）被误提交后会在各端来回改写 ⇒ 反复冲突、永久噪声。
 *
 * 规则（默认只读）：
 *   R1 BOM    含非 ASCII 的 .ps1/.psm1/.vbs/.cmd/.bat 必须以 EF BB BF 开头     → FAIL
 *   R2 EOL    *.sh 必须 LF；*.cmd/*.bat 必须 CRLF                             → FAIL
 *             其它文件按仓库 .gitattributes 声明的 eol 不符                    → WARN（噪声，不致命）
 *   R3 冲突   跟踪文件出现行首 `<<<<<<< ` / `>>>>>>> `（7 字符标记）             → FAIL
 *   R4 本地   机器本地 / 产物类路径被跟踪（清单见 R4_RULES，逐条附事故理由）      → FAIL
 *   R5 个人串 由调用方传入规则集（--personal-patterns）——**规则单一源留给发布器** → FAIL
 *
 * 设计约束（重要）：
 *   · 只检查 **git 跟踪的文件**（`git ls-files`）——未跟踪的临时文件不在此工具职责内；
 *   · 仓库专属豁免写在各仓根目录的 `.sync-hygiene-ignore`（一行一个 glob，# 注释），
 *     因此本工具**不含任何具体仓库/机器/路径知识**，可原样发布；
 *   · 只报不改：修 BOM/EOL/冲突标记是"改文件"的动作，应作为显式的一次性迁移执行。
 *
 * 用法：
 *   node tools/sync-hygiene.mjs --repo <dir> [--repo <dir> ...] [--json]
 *                              [--personal-patterns <rules.json>] [--max-detail N]
 * 退出码：0 = 无 FAIL；2 = 有 FAIL；3 = 用法错误
 */
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

const argv = process.argv.slice(2)
const val = (f, d = null) => { const i = argv.indexOf(f); return i !== -1 && argv[i + 1] ? argv[i + 1] : d }
const all = (f) => argv.reduce((acc, a, i) => (a === f && argv[i + 1] ? (acc.push(argv[i + 1]), acc) : acc), [])

const REPOS = all('--repo').map((p) => resolve(p))
const AS_JSON = argv.includes('--json')
const MAX_DETAIL = Number(val('--max-detail', '8'))
const PATTERN_FILE = val('--personal-patterns', null)
if (!REPOS.length) {
  console.error('usage: node tools/sync-hygiene.mjs --repo <dir> [--repo <dir> ...] [--json] [--personal-patterns <rules.json>]')
  process.exit(3)
}

/** R4：机器本地 / 产物类路径（被跟踪即 FAIL）。逐条附"为什么会这样"。 */
const R4_RULES = [
  { re: /^sync\/logs\//i, why: '同步日志：每轮都变，机器本地' },
  { re: /^sync\/reports\//i, why: '同步报告：每轮都变，机器本地' },
  { re: /^dist\//i, why: '构建/暂存产物：可由源重新生成' },
  { re: /^node_modules\//i, why: '依赖目录：体量巨大且平台相关' },
  { re: /(^|\/)[^\/]*-cmd\.txt$/i, why: '命令文件：内含本机绝对路径' },
  { re: /(^|\/)\.engine-fetch-stamp$/i, why: '远端比对节流戳：每次 fetch 必变，曾致 4 轮连续冲突' },
  { re: /(^|\/)local\.machine$/i, why: '本机标识文件：各端不同' },
  // 2026-09-18 实测：新增的「每机状态文件」自己就成了新的「机器本地文件」类别（tick 一提交就把它们带进 git）
  // ⇒ 每加一类 state 文件，必须**同时**进 .gitignore 与本规则，否则门禁永远追不上。
  { re: /^sync\/state\/(hygiene|migrations|apply|triage|ops-bundle)-[^\/]+\.json$/i, why: '每机状态文件（本机才有意义）：会被各端反复改写 ⇒ 不入 git' },
  { re: /^sync\/state\/\.heartbeat-alert-[^\/]+\.json$/i, why: '每机心跳告警去重状态（2026-09-18 新增）：机器本地，随 R4 三处登记纪律一并加入' },
  // 2026-09-19：备份层（误删防线）引入的两类新状态 + 一类凭据。凭据类尤其不能入库。
  { re: /^sync\/state\/backup-[^\/]+\.json(\.tmp)?$/i, why: '每机备份状态（2026-09-19 新增）：含本机绝对路径、快照 ID、删除审计样本 ⇒ 机器本地' },
  { re: /^sync\/state\/\.backup-[^\/]+\.env$/i, why: '每机 restic 仓库密码（2026-09-19 新增）：★凭据★，入库即等于把备份钥匙交给所有能读仓的人' },
  { re: /^sync\/state\/transport-[^\/]+\.json$/i, why: '每机传输器健康快照（2026-09-19 预留）：Syncthing REST 抓的本机状态，机器本地' },
  { re: /^(settings\.yaml|opencode\.jsonc|cordis\.patch\.yml)$/i, why: '工具自写的 live 配置：各端各写，会 ping-pong（插件源码里的同名文件不受此规则约束）' },
  { re: /\.local-[A-Za-z0-9_.-]+-\d{8}\./i, why: '冲突侧车文件：只应存在于工作区，不应入库' },
]
const R5 = (() => {
  if (!PATTERN_FILE) return []
  if (!existsSync(PATTERN_FILE)) { console.error(`[WARN] --personal-patterns 不存在：${PATTERN_FILE}`); return [] }
  try {
    const raw = JSON.parse(readFileSync(PATTERN_FILE, 'utf8'))
    return (Array.isArray(raw) ? raw : raw.patterns || []).map((r) => {
      if (Array.isArray(r)) return { re: new RegExp(r[0], 'i'), why: r[1] || '个人串' }
      return { re: new RegExp(r.pattern, r.flags || 'i'), why: r.why || '个人串' }
    })
  } catch (e) { console.error(`[WARN] --personal-patterns 解析失败：${e.message}`); return [] }
})()

function globToRe(g) {
  let re = '^'
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(re + '$', 'i')
}
function loadIgnore(repo) {
  const p = join(repo, '.sync-hygiene-ignore')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((g) => ({ glob: g, re: globToRe(g) }))
}
function isIgnored(ignore, rel) { return ignore.some((i) => i.re.test(rel)) }
function loadGitattributes(repo) {
  const p = join(repo, '.gitattributes')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const parts = l.split(/\s+/)
      const m = parts.find((x) => /^eol=(lf|crlf)$/i.test(x))
      // gitattributes 语义：**不含斜杠**的模式匹配任意层级（像 .gitignore）——
      // 少了这一步，`*.ps1 text eol=crlf` 对 `install/bootstrap.ps1` 不生效（实测踩到：整仓声明被判"未声明"）
      return m ? { re: globToRe(parts[0].includes('/') ? parts[0] : '**/' + parts[0]), eol: m.split('=')[1].toLowerCase() } : null
    }).filter(Boolean)
}
function trackedFiles(repo) {
  // 有 .git ⇒ 跟踪文件 **∪ 未跟踪但未被 ignore 的文件**（`--others --exclude-standard`）。
  // 为什么必须带 `--others`（2026-09-18 实测踩到）：staging 目录（上次发布留下的 `.git`）里
  // 只用 `ls-files` 会返回**上一个提交**的文件清单，**看不见刚拷进去的新文件** ⇒ 发布闸门形同虚设。
  // 无 .git（全新 staging / 临时目录）⇒ 直接走目录树。
  if (!existsSync(join(repo, '.git'))) return walkFiles(repo)
  const r = spawnSync('git', ['-C', repo, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) return null
  return r.stdout.toString('utf8').split('\0').filter(Boolean)
}
/** 无 git 时的兜底：递归列目录（跳过 .git/node_modules/dist —— 与发布器的 SKIP_NAMES 一致）。 */
function walkFiles(root, prefix = '') {
  const out = []
  let entries = []
  try { entries = readdirSync(join(root, prefix), { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (['.git', 'node_modules', 'dist'].includes(e.name)) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...walkFiles(root, rel))
    else if (e.isFile()) out.push(rel)
  }
  return out
}
/**
 * 规范 EOL 取自 **git 索引**，不是工作区。
 * 为什么（2026-09-18 实测踩到）：`core.autocrlf=true` 的 Windows 检出里，文本文件的**工作区就是 CRLF**
 * （`i/lf w/crlf attr/-text`，而 `git status` 干净）—— 拿工作区判 EOL 会给每个文件制造**平台级假红**。
 * 索引里的形态才是跨机一致的"提交内容"，也是别的机器 checkout 后的依据。
 */
function indexEol(repo) {
  const r = spawnSync('git', ['-C', repo, 'ls-files', '--eol', '-z'], { encoding: 'buffer', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  const map = new Map()
  if (r.status !== 0) return map
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    if (tab < 0) continue
    const meta = rec.slice(0, tab)
    const rel = rec.slice(tab + 1)
    const i = (meta.match(/i\/(\w+)/) || [, ''])[1]
    const a = (meta.match(/attr\/(\S+)/) || [, ''])[1]
    map.set(rel, { i, attr: a })
  }
  return map
}
const findings = []
const add = (sev, rule, repo, rel, detail) => findings.push({ sev, rule, repo, rel, detail })
const SCRIPT_EXT = /\.(ps1|psm1|vbs|cmd|bat)$/i

for (const repo of REPOS) {
  const name = basename(repo)
  const files = trackedFiles(repo)
  if (!files) { add('FAIL', 'R0', name, '(repo)', 'git ls-files 失败 —— 不是 git 仓库或 git 不可用'); continue }
  const ignore = loadIgnore(repo)
  const undeclared = new Set()
  const attrs = loadGitattributes(repo)
  const idx = indexEol(repo)
  // 无 git 索引（全新 staging / 临时目录）时无法判定"提交形态"，如实说明并跳过 R2 —— 不假装检查过
  if (idx.size === 0) findings.push({ sev: 'INFO', rule: 'R2', repo: name, rel: '', detail: '无 git 索引：跳过 EOL 判定（仍查 BOM / 冲突标记 / 机器本地文件）' })
  let checked = 0, skipped = 0
  for (const rel of files) {
    if (isIgnored(ignore, rel)) { skipped++; continue }
    const full = join(repo, rel)
    let st
    try { st = statSync(full) } catch { skipped++; continue }
    if (!st.isFile()) { skipped++; continue }
    checked++
    // R4：机器本地 / 产物
    for (const r of R4_RULES) if (r.re.test(rel)) add('FAIL', 'R4', name, rel, r.why)
    // 文本内容检查（大文件跳过）
    if (st.size > 4 * 1024 * 1024) { skipped++; continue }
    let buf
    try { buf = readFileSync(full) } catch { skipped++; continue }
    const txt = buf.toString('utf8')
    for (const r of R5) {
      const m = txt.match(r.re)
      if (m) add('FAIL', 'R5', name, rel, `${r.why}：命中 ${JSON.stringify(m[0].slice(0, 40))}`)
    }
    // R3：冲突标记（只认 7 字符标记，`=======` 在 setext 标题/第三方 readme 里合法）
    txt.split(/\r?\n/).forEach((line, i) => {
      if (line.startsWith('<<<<<<< ') || line.startsWith('>>>>>>> ')) add('FAIL', 'R3', name, rel, `第 ${i + 1} 行：${line.slice(0, 40)}`)
    })
    // R1：BOM（仅脚本类；只看是否含非 ASCII）
    if (SCRIPT_EXT.test(rel)) {
      let nonAscii = 0
      for (const b of buf) if (b > 127) { nonAscii++; break }
      const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
      if (nonAscii && !hasBom) add('FAIL', 'R1', name, rel, '含非 ASCII 但缺 UTF-8 BOM ⇒ PowerShell 5.1 会按本地代码页解码（解析/中文出错；PS7 下不可见）')
    }
    // R2：EOL —— 只看 **git 索引里的规范形态**（跨机一致），不看工作区（Windows/autocrlf 下工作区本就是 CRLF）
    //   · *.sh 索引里是 crlf/mixed ⇒ 别的机器 checkout 后会拿到 CRLF ⇒ bash 必然报错 ⇒ FAIL
    //   · 仓库声明了 `eol=lf` 的文件，索引里却不是 lf ⇒ 与声明矛盾 ⇒ FAIL
    //     （声明 `eol=crlf` 时索引存 LF 是**正常**的，checkout 时才转 CRLF，故不检查）
    //   · 索引 mixed ⇒ WARN（提交噪声）
    //   · 未声明 eol 的扩展名 ⇒ 跳过 + 记 INFO（不替仓库单方面加政策）
    const eolInfo = idx.get(rel) || { i: '', attr: '' }
    const attr = attrs.find((a) => a.re.test(rel))
    const ext = (rel.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase()
    const declaredLf = attr && attr.eol === 'lf'
    if (/\.sh$/i.test(rel)) {
      if (eolInfo.i === 'crlf' || eolInfo.i === 'mixed') add('FAIL', 'R2', name, rel, `索引里是 ${eolInfo.i}，应 lf —— 别的机器 checkout 后会拿到 CRLF，bash 会把 \\r 当命令的一部分（必然报错）`)
    } else if (declaredLf) {
      if (eolInfo.i && eolInfo.i !== 'lf' && eolInfo.i !== 'none') add('FAIL', 'R2', name, rel, `索引里是 ${eolInfo.i}，.gitattributes 声明 eol=lf（与声明矛盾）`)
    } else if (eolInfo.i === 'mixed') {
      add('WARN', 'R2', name, rel, '索引里 LF/CRLF 混排（提交噪声）')
    } else if (ext && !attr) {
      undeclared.add(ext)
    }
  }
  const un = [...undeclared].filter((e) => /^\.(cmd|bat|ps1|psm1|vbs|mjs|js|json|md|swift)$/i.test(e)).sort()
  if (un.length) findings.push({ sev: 'INFO', rule: 'R2', repo: name, rel: '', detail: `未声明 eol（已跳过 EOL 检查）：${un.join(' ')}；如需强制，请在 .gitattributes 里声明后本工具自动生效` })
  findings.push({ sev: 'INFO', rule: 'SUM', repo: name, rel: '', detail: `跟踪文件 ${files.length}，检查 ${checked}，豁免/跳过 ${skipped}，豁免规则 ${ignore.length} 条` })
}

const fails = findings.filter((f) => f.sev === 'FAIL')
const warns = findings.filter((f) => f.sev === 'WARN')
if (AS_JSON) {
  console.log(JSON.stringify({ findings, fails: fails.length, warns: warns.length }, null, 2))
} else {
  const line = (f) => console.log(`  [${f.sev}] ${f.rule} ${f.repo}/${f.rel}${f.rel ? ' — ' : ''}${f.detail}`)
  for (const f of findings) if (f.sev === 'INFO') console.log(`  [INFO] ${f.repo}：${f.detail}`)
  const showF = fails.slice(0, MAX_DETAIL); showF.forEach(line)
  if (fails.length > showF.length) console.log(`  … 其余 ${fails.length - showF.length} 条 FAIL 已省略（--max-detail 调整）`)
  const showW = warns.slice(0, MAX_DETAIL); showW.forEach(line)
  if (warns.length > showW.length) console.log(`  … 其余 ${warns.length - showW.length} 条 WARN 已省略`)
  console.log(`HYGIENE: FAIL=${fails.length} WARN=${warns.length}`)
  console.log(fails.length ? '  ⇒ 文本卫生门禁未通过（只报不改：请按规则修复，或把仓库专属豁免写进 .sync-hygiene-ignore）'
    : '  ⇒ 文本卫生门禁通过')
}
process.exit(fails.length ? 2 : 0)
