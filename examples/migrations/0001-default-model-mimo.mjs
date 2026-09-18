/**
 * 0001-default-model-mimo — 三端统一 opencode 默认模型 = `opencode/mimo-v2.5-free`
 *
 * 为什么（2026-09-18 实测）：该模型 **无需登录、无需付费**（`auth list` 0 credentials 也能跑），
 * 分诊类任务实测 4/4 正确、单次 12–46s、8 次连续调用无 429；而 `muse-spark-*` 两个候选
 * 直接被判 `not available in your country`（地域封锁）⇒ 免费池里只有它可作单一默认。
 *
 * 为什么必须做成迁移：`~/.config/opencode/opencode.jsonc` 是**机器本地 live 配置**（不入 git，
 * 见 docs/conventions.md §机器本地文件），三端各写各的 —— 只能靠"每端跑一次"的迁移统一。
 *
 * 实现约束（踩过的坑写在这里）：
 *   · JSONC 里可能有注释 ⇒ **禁止** JSON.parse + JSON.stringify 回写（会把注释和格式全吃掉）；
 *   · `"model"` 也可能出现在嵌套结构里（provider/agent 段）⇒ 只改**顶层**键，靠花括号深度判定，
 *     不用 `^\s*"model"` 这种会误伤嵌套的正则；
 *   · 保持 BOM 与行尾不变（只做定点替换）；
 *   · 改前留 `.bak-<时间戳>` 备份（回滚 = 覆盖回去）；
 *   · **不做网络探测**（`opencode run` 要 20–46s 且会受网络抖动影响）——连通性由人工抽检，
 *     迁移只负责"配置正确"，避免把网络问题变成迁移失败。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const MODEL = 'opencode/mimo-v2.5-free'

export const meta = {
  id: '0001-default-model-mimo',
  danger: 'safe',
  platforms: ['win32', 'darwin', 'linux'],
  reason: '统一 opencode 默认模型为免费模型（无需登录/无付费；免费池里唯一实测可用者）',
  ref: 'sync/migrations/README.md',
}

function cfgFile(ctx) {
  const dir = join(ctx.home, '.config', 'opencode')
  for (const name of ['opencode.jsonc', 'opencode.json']) {
    const p = join(dir, name)
    if (existsSync(p)) return { dir, path: p, name }
  }
  return { dir, path: join(dir, 'opencode.jsonc'), name: 'opencode.jsonc', missing: true }
}

/** 在 JSONC 文本里定位**顶层**键（忽略字符串与注释里的花括号）。返回 {vs, ve} 值区间（不含引号）。 */
function topLevelValueRange(txt, key) {
  let depth = 0, i = 0, inStr = false, esc = false, inLine = false, inBlock = false
  const keyTok = `"${key}"`
  while (i < txt.length) {
    const c = txt[i], n = txt[i + 1]
    if (inLine) { if (c === '\n') inLine = false; i++; continue }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue } i++; continue }
    if (inStr) {
      if (esc) { esc = false; i++; continue }
      if (c === '\\') { esc = true; i++; continue }
      if (c === '"') { inStr = false; i++; continue }
      i++; continue
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue }
    if (c === '"') {
      if (depth === 1 && txt.startsWith(keyTok, i)) {
        // 找冒号后的第一个字符串字面量
        let j = i + keyTok.length
        while (j < txt.length && /\s/.test(txt[j])) j++
        if (txt[j] === ':') {
          j++
          while (j < txt.length && /\s/.test(txt[j])) j++
          if (txt[j] === '"') {
            const vs = j + 1
            let k = vs
            while (k < txt.length && txt[k] !== '"') k++
            return { vs, ve: k }
          }
        }
      }
      inStr = true; i++; continue
    }
    if (c === '{' || c === '[') { depth++; i++; continue }
    if (c === '}' || c === ']') { depth--; i++; continue }
    i++
  }
  return null
}

export function check(ctx) {
  const f = cfgFile(ctx)
  if (f.missing || !existsSync(f.path)) {
    // 本机没装 opencode / 没有配置文件 ⇒ **不适用**，跳过而不是失败（新机器上这是正常状态）
    return { ok: false, skip: true, detail: `未发现 ${f.path}（本机未装 opencode？）` }
  }
  const txt = readFileSync(f.path, 'utf8')
  const r = topLevelValueRange(txt, 'model')
  const cur = r ? txt.slice(r.vs, r.ve) : null
  if (cur === MODEL) return { ok: true, detail: `${f.name} 顶层 model = ${MODEL}` }
  return { ok: false, detail: `${f.name} 顶层 model 现为 ${cur === null ? '(未设置)' : cur}` }
}

export function apply(ctx) {
  const f = cfgFile(ctx)
  if (f.missing || !existsSync(f.path)) {
    // 目录都没有 ⇒ 建一个最小配置（装 opencode 时它会读它）；有目录无文件 ⇒ 同样补一个
    mkdirSync(f.dir, { recursive: true })
    if (!existsSync(f.path)) {
      writeFileSync(f.path, `{\n  "model": "${MODEL}"\n}\n`, 'utf8')
      return { changed: true, detail: `新建 ${f.name}（仅含默认模型）` }
    }
  }
  const raw = readFileSync(f.path, 'utf8')
  const hasBom = raw.charCodeAt(0) === 0xfeff
  const txt = hasBom ? raw.slice(1) : raw
  const bak = `${f.path}.bak-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}`
  copyFileSync(f.path, bak)

  const r = topLevelValueRange(txt, 'model')
  let out
  if (r) {
    out = txt.slice(0, r.vs) + MODEL + txt.slice(r.ve)
  } else {
    // 顶层没有 model ⇒ 插在第一个 `{` 之后（保留注释；缩进沿用文件里第一处缩进）
    const brace = txt.indexOf('{')
    if (brace < 0) throw new Error(`${f.name} 里找不到顶层对象，拒绝改写`)
    const indent = (/\n([ \t]+)"/.exec(txt) || [, '  '])[1]
    out = txt.slice(0, brace + 1) + `\n${indent}"model": "${MODEL}",` + txt.slice(brace + 1)
  }
  writeFileSync(f.path, (hasBom ? '\ufeff' : '') + out, 'utf8')
  return { changed: true, detail: `已写入 ${f.name} 顶层 model = ${MODEL}（备份 ${bak.split(/[\\/]/).pop()}）` }
}
