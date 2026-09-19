#!/usr/bin/env node
/**
 * lib/syncthing-api.mjs —— 访问本机 Syncthing 的**单一源**（生成器与健康检查共用）
 *
 * 为什么抽出来：REST 访问的细节（配置在哪儿、API key 怎么读、GUI 地址可能是 `dynamic` 要兜底）
 * 一旦有两份实现，就会像本轮的"实例副本 vs 运行时副本"那样悄悄漂移。
 *
 * 凭据原则：**不新建凭据副本** —— API key 就地读 Syncthing 自己的 `config.xml`。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Syncthing 的配置/数据目录（各平台默认位置；可用 ST_HOME 覆盖） */
export function syncthingHome() {
  if (process.env.ST_HOME) return process.env.ST_HOME;
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || homedir(), 'Syncthing')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Syncthing')
      : join(homedir(), '.local', 'state', 'syncthing');
}

/** 读 config.xml → { key, base, home, cfg }；找不到配置返回 null */
export function syncthingApi() {
  const home = syncthingHome();
  const cfg = join(home, 'config.xml');
  if (!existsSync(cfg)) return null;
  const x = readFileSync(cfg, 'utf8');
  const key = (x.match(/<apikey>([^<]+)<\/apikey>/) || [])[1];
  if (!key) return null;
  const guiBlock = (x.match(/<gui[\s\S]*?<\/gui>/) || [''])[0];
  let addr = (guiBlock.match(/<address>([^<]+)<\/address>/) || [])[1] || '127.0.0.1:8384';
  // v2 里 GUI 地址可能是 `dynamic`（或空）⇒ 用默认本机地址兜底，否则 fetch 会直接炸
  if (!/^\d/.test(addr) || addr === 'dynamic') addr = '127.0.0.1:8384';
  return { key, base: `http://${addr}`, home, cfg };
}

/** 调 REST；返回 { status, json, text }（json 解析失败时为 null，不抛） */
export async function stApi(api, path, init = {}) {
  const r = await fetch(api.base + path, {
    headers: { 'X-API-Key': api.key, 'Content-Type': 'application/json' },
    ...init
  });
  const t = await r.text();
  let json = null;
  try { json = JSON.parse(t); } catch { /* 非 JSON 响应（空体/HTML 错误页） */ }
  return { status: r.status, json, text: t };
}

/** folder 的版本化参数：**180 天** staggered（与误删防线 L1 的约定一致） */
export const VERSIONING_180D = {
  type: 'staggered',
  params: { cleanupIntervalS: '3600', maxAge: String(180 * 86400), fsPath: '.stversions' }
};
