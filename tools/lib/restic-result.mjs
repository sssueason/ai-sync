#!/usr/bin/env node
/**
 * lib/restic-result.mjs —— 把 restic 的一次运行结果**分级**（纯函数，可单测）
 *
 * 为什么要单独抽出来：restic 的退出码语义与"备份成功/失败"不是一回事 ——
 *   rc=0 正常；**rc=3 = "至少一个源文件读不到"，快照其实已经建好了**；其余非 0 才是失败。
 * 2026-09-19 首备实测：把 rc=3 当硬失败 ⇒ 全量清单与误删审计都没跑、状态停在旧值、每夜假红。
 * 而这条分支**在本机无法用真实文件稳定复现**（restic 会启用备份特权，连独占占用的文件都读得到），
 * 所以改为：把判定抽成纯函数 + 用夹具把每种输入钉死（sync/tests/backup-classify-selftest.mjs）。
 */
export function classifyResticRun({ code, stdout = '', stderr = '', prevUnreadable = [] }) {
  // restic --json 的错误明细：每条 {"message_type":"error", item, error.message}
  const errors = [];
  for (const line of String(stdout).split(/\r?\n/)) {
    if (!line.trim().startsWith('{')) continue;
    try {
      const j = JSON.parse(line);
      if (j.message_type === 'error') errors.push({ item: j.item || '', message: (j.error && (j.error.message || j.error)) || '' });
    } catch { /* 进度/半行 JSON */ }
  }
  // summary 是最后一条可解析的 JSON
  let summary = null;
  const lines = String(stdout).split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try { summary = JSON.parse(lines[i]); break; } catch { /* 继续往前找 */ }
  }
  if (!summary || summary.message_type !== 'summary') {
    return { level: 'failed', summary: null, errors, warnings: [`restic 未给出 summary（rc=${code}）：${(stderr || stdout || '').trim().slice(-300)}`], flags: [] };
  }
  if (code === 0 && !errors.length) return { level: 'ok', summary, errors, warnings: [], flags: [] };

  if (code === 3 || (errors.length && code !== 0)) {
    const items = errors.map((e) => e.item).filter(Boolean);
    const warnings = [`有 ${errors.length} 个文件读不到（rc=${code}）：${items.slice(0, 5).join('、') || '(未给出路径)'} —— 快照本身有效，但这些文件没进快照`];
    const flags = [];
    const prev = prevUnreadable.map((x) => x.item).filter(Boolean).slice().sort();
    // ★ 只有当"读不到的文件清单变了"才升级为要人看一眼：稳定的一小撮不值得每夜打扰
    if (JSON.stringify(prev) !== JSON.stringify(items.slice().sort())) {
      flags.push('unreadable-changed');
      warnings.push('读不到的文件清单与上次不同 ⇒ 值得看一眼（ACL 变了？杀软锁住了？文件被删了？）');
    }
    return { level: 'partial', summary, errors, warnings, flags };
  }
  return { level: 'failed', summary, errors, warnings: [`restic backup 失败（rc=${code}）：${(stderr || stdout || '').trim().slice(-300)}`], flags: [] };
}
