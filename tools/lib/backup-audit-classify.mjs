/**
 * 误删审计的删除分类（batch 22，2026-10-20）。
 *
 * 为什么需要它：`本机实例仓库的 .git` **不能**从备份集里排除 —— 恢复流程
 * （备份恢复手册）明确要靠它还原仓库历史，排掉等于自断灾备。
 * 但 git 的 repack/gc 会成批增删 objects，实测 2026-10-15 22:00 那次
 * 48 个删除样本 20/20 全是 `.git/objects/**`（共 0.01 MB），照样触发
 * 「删除 > 20 个」的红。
 *
 * 所以正确的修法是**分类而不是排除**：git 内部 churn 记进 `gitInternal`
 * 留痕（不静默），判红只看 `reviewable`（人真正该看的删除）。
 */

/** 路径是否属于版本库内部（`.git/` 下的任何内容，任意层级）。 */
export const GIT_INTERNAL_RE = /(^|[\\/])\.git[\\/]/;

const isGitInternal = (p) => GIT_INTERNAL_RE.test(String(p || ''));

/**
 * @param {Array<{path: string, size?: number}>} removed
 * @returns {{git: Array, reviewable: Array, gitBytes: number, reviewBytes: number, totalBytes: number}}
 */
export function classifyRemovals(removed) {
  const list = Array.isArray(removed) ? removed : [];
  const git = []; const reviewable = [];
  let gitBytes = 0; let totalBytes = 0;
  for (const r of list) {
    const size = Number(r?.size) || 0;
    totalBytes += size;
    if (isGitInternal(r?.path)) { git.push(r); gitBytes += size; } else { reviewable.push(r); }
  }
  return { git, reviewable, gitBytes, reviewBytes: totalBytes - gitBytes, totalBytes };
}

/** 是否判红：只用 reviewable（git 内部 churn 不参与）。 */
export function shouldTrip(classified, limits = {}) {
  const limitF = limits.files ?? 20;
  const limitB = limits.bytes ?? 209715200;
  const c = classified || { reviewable: [], reviewBytes: 0 };
  return c.reviewable.length > limitF || c.reviewBytes > limitB;
}