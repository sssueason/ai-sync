#!/usr/bin/env node
/**
 * lib/mu2-config-edit.mjs —— 对 machines/<machine>.json 做**外科式**编辑（只动目标那一段）
 *
 * 为什么不用 JSON.parse + JSON.stringify 整file重写：机器配置是手写格式（CRLF、2 空格、
 * 中文注释），重新序列化会把整个文件变成一次大 diff —— 三端 review 起来全是噪音，而且
 * `--revert` 时更容易冲突。这里只做**最小替换**，并交给调用方做"深相等 + 可解析"的双保险校验。
 *
 * ★ 定位元素用 **JSON.parse 后比对 id**，不用正则在原文里找：注释里出现同形文本
 *   （例如 `_comment` 里写了 `"id": "xxx"`）会让正则命中错误元素，把别的集合删掉。本模块自测里
 *   专门放了这种陷阱（sync/tests/migrate-selftest.mjs ④）。
 */

/** 从 startIdx（'{' 或 '['）起做括号配平，返回该 JSON 值的 [start,end)；字符串内的括号不计数 */
export function spanOf(text, startIdx) {
  let depth = 0, inStr = false, esc = false;
  for (let i = startIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return { start: startIdx, end: i + 1 }; }
  }
  return null;
}

/** 在 `"sets": [...]` 区域内，找到 id 等于 setId 的那个顶层元素的 span */
export function findSetSpan(text, setId) {
  const m = text.match(/"sets"\s*:\s*\[/);
  if (!m) return null;
  const arrStart = m.index + m[0].length;
  const spans = [];
  let i = arrStart, depth = 1, inStr = false, esc = false;
  for (; i < text.length && depth > 0; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') {
      if (c === '{' && depth === 1) { const s = spanOf(text, i); if (s) { spans.push(s); i = s.end - 1; } continue; }
      depth++;
    } else if (c === '}' || c === ']') depth--;
  }
  for (const s of spans) {
    const body = text.slice(s.start, s.end);
    try { if (JSON.parse(body).id === setId) return s; } catch { /* 片段不是完整 JSON：跳过 */ }
  }
  return null;
}

/** 生成"删掉该元素"的新文本（连逗号一起处理，不留悬空逗号）；失败返回 {ok:false,error} */
export function removeSetText(text, setId) {
  const s = findSetSpan(text, setId);
  if (!s) return { ok: false, error: `找不到集合 ${setId}` };
  let start = s.start, end = s.end;
  let j = end;
  while (j < text.length && /\s/.test(text[j])) j++;
  if (text[j] === ',') { end = j + 1; while (end < text.length && /[ \t]/.test(text[end])) end++; }
  else {
    let k = start - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (text[k] === ',') { let e = k - 1; while (e >= 0 && /[ \t]/.test(text[e])) e--; start = e + 1; }
  }
  return { ok: true, text: text.slice(0, start) + text.slice(end), removed: text.slice(s.start, s.end) };
}

/** 找到某个**顶层**键的值区间与键起点（用于删整段，如退役时机器配置里的 mu2 段） */
function findTopLevelKey(text, key) {
  const rootStart = text.indexOf('{');
  if (rootStart < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = rootStart; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') {
      if (depth === 1) {
        const keyEnd = text.indexOf('"', i + 1);
        let j = keyEnd + 1;
        while (j < text.length && /\s/.test(text[j])) j++;
        let isKey = false;
        try { isKey = text[j] === ':' && JSON.parse(text.slice(i, keyEnd + 1)) === key; } catch { isKey = false; }
        if (isKey) {
          let v = j + 1;
          while (v < text.length && /\s/.test(text[v])) v++;
          let valueEnd;
          if (text[v] === '{' || text[v] === '[') { const s = spanOf(text, v); if (!s) return null; valueEnd = s.end; }
          else if (text[v] === '"') { const e = text.indexOf('"', v + 1); if (e < 0) return null; valueEnd = e + 1; }
          else { let e = v; while (e < text.length && !/[,}\]\s]/.test(text[e])) e++; valueEnd = e; }
          return { keyStart: i, valueEnd };
        }
        i = keyEnd;
        continue;
      }
      inStr = true;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return null;
}

/** 生成"删掉该顶层键"的新文本；调用方仍须做 parse + 深相等校验（与 removeSetText 同规矩） */
export function removeTopLevelKey(text, key) {
  const found = findTopLevelKey(text, key);
  if (!found) return { ok: false, error: `找不到顶层键 ${key}` };
  let start = found.keyStart, end = found.valueEnd;
  let j = end;
  while (j < text.length && /[ \t]/.test(text[j])) j++;
  if (text[j] === ',') { end = j + 1; while (end < text.length && /[ \t]/.test(text[end])) end++; }
  else {
    let k = start - 1;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (text[k] === ',') { let e = k - 1; while (e >= 0 && /[ \t]/.test(text[e])) e--; start = e + 1; }
  }
  return { ok: true, text: text.slice(0, start) + text.slice(end), removed: text.slice(found.keyStart, found.valueEnd) };
}