#!/usr/bin/env node
/**
 * lib/maintenance.mjs —— 跨端维护登记的**单一源**（心跳告警与传输健康共用）
 *
 * 规则只有一条：**登记期内（未过期）的机器不产生告警**；过期即自动恢复判活。
 * 为什么必须单一源：心跳工具与健康检查都要用这条规则，各写一份迟早漂移 ——
 * 2026-09-19 实测就踩过：campus 按用户指令暂停后被心跳降级了，却仍被健康检查判 FAIL（同一件事两套判据）。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** 读 sync/maintenance.json → { <machine>: {reason, since, until, by} } */
export function readMaintenance(instance) {
  try {
    const p = join(instance, 'sync', 'maintenance.json');
    if (!existsSync(p)) return {};
    const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
    return j && j.machines && typeof j.machines === 'object' ? j.machines : {};
  } catch { return {}; }
}

/** 取某台机器的维护状态：{entry, until, expired} 或 null */
export function maintenanceOf(instance, machine) {
  const e = readMaintenance(instance)[machine];
  if (!e || typeof e !== 'object') return null;
  const until = e.until ? String(e.until) : null;
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return { entry: e, until, expired: until ? today > until : false };
}

/** 人话描述（告警/INFO 里统一用它，避免两处措辞不一） */
export function maintText(m) {
  return `登记维护中（${m.entry.since || '?'} → ${m.until || '未定期'}）${m.entry.reason ? '：' + m.entry.reason : ''}`;
}
