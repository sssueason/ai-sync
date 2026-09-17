// app.js — 控制台前端（原生 JS，无构建、无依赖）
// 设计：页面只做"显示 + 转发"，所有动作都调引擎既有 CLI（/api/* 之后仍是 sync-status / sync-align / sync-lite），
// 不在前端重实现任何同步逻辑（否则就是第二套真相）。
const $ = (s) => document.querySelector(s);
const api = async (p, opt) => {
  const r = await fetch(p, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

// ---------- 标签页（支持 #status / #wizard / #settings / #align / #logs 直达，供托盘菜单唤起） ----------
function activateTab(name) {
  const b = document.querySelector(`.tab[data-tab="${name}"]`);
  if (!b) return;
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  if (name === 'logs') loadLog();
  if (name === 'settings') loadAdapters();
}
for (const b of document.querySelectorAll('.tab')) {
  b.onclick = () => {
    activateTab(b.dataset.tab);
    history.replaceState(null, '', '#' + b.dataset.tab);
  };
}
window.addEventListener('hashchange', () => activateTab(location.hash.slice(1)));

// ---------- 状态 ----------
function renderStatus(s) {
  const v = $('#verdict');
  v.className = 'pill ' + (s.state || 'fail');
  v.textContent = { ok: '正常', warn: '有提醒', fail: '有失败' }[s.state] || s.state;
  $('#glyph').textContent = '⟳';
  const cards = [
    ['最后同步', s.lastSyncAt || '未知', s.lastSyncAgoMin != null ? s.lastSyncAgoMin + ' 分钟前' : ''],
    ['本机', s.machine, (s.intervalMinutes || '?') + ' 分钟一轮'],
    ['已知机器', String((s.machines || []).length), '来自 sync-state 分支'],
    ['待办', String((s.actions || []).length), (s.problems || []).length ? '有 ' + s.problems.length + ' 个 FAIL' : '无 FAIL'],
  ];
  $('#cards').innerHTML = cards.map(([k, val, sub]) => `<div class="card"><div class="k">${k}</div><div class="v">${val}</div><div class="k">${sub}</div></div>`).join('');
  $('#checks tbody').innerHTML = (s.checks || []).map((c) =>
    `<tr><td class="lv ${c.level}">${c.level}</td><td>${c.name}</td><td class="hint">期望 ${c.expected}</td><td class="hint">实际 ${c.actual}</td></tr>`).join('');
  $('#fleet tbody').innerHTML = (s.machines || []).map((m) =>
    `<tr><td><b>${m.machine}</b></td><td>${m.at}</td><td class="hint">${m.ageMin != null ? m.ageMin + ' 分钟前' : ''}</td><td>rc=${m.rc}</td><td>待办 ${(m.actions || []).length}</td></tr>`).join('')
    || '<tr><td class="hint">还没有其他机器的状态（首台推送到 sync-state 分支后出现）</td></tr>';
  $('#actions').innerHTML = (s.actions || []).map((a) => `<li><b>[${a.source}]</b> ${a.text}</li>`).join('') || '<li class="hint">无待办</li>';
}

// ---------- 向导：目录浏览 + 校验 ----------
let browsePath = '';
async function browse(p) {
  const r = await api('/api/fs?path=' + encodeURIComponent(p || browsePath || '~'));
  if (!r.ok) { $('#mirrorCheck').innerHTML = '<span class="fail-t">' + r.error + '</span>'; return; }
  browsePath = r.path;
  const c = r.checks || {};
  $('#mirrorCheck').innerHTML = [
    c.isGitRepo ? '<span class="fail-t">这是 git 仓 —— 同步空间不应是 git 仓（会被 seed 与云盘双重管理）</span>' : '<span class="ok-t">不是 git 仓 ✓</span>',
    c.writable ? '<span class="ok-t">可写 ✓</span>' : '<span class="fail-t">不可写 ✗</span>',
    c.looksCloudRoot ? '<span class="ok-t">目录名像网盘同步根 ✓</span>' : '<span class="warn-t">目录名不像常见网盘同步根（继续也可以，但要确认它真是客户端的同步文件夹）</span>',
  ].join(' · ');
  $('#browser').classList.remove('hidden');
  $('#browser').innerHTML = `<div class="up" data-p="${r.parent}">↑ 上级</div>` +
    r.entries.map((e) => `<div data-p="${r.path.replace(/[\\/]$/, '')}/${e}">${e}</div>`).join('');
  for (const el of $('#browser').children) el.onclick = () => { const p2 = el.dataset.p; $('#mirrorPath').value = p2; browse(p2); };
}
$('#browseMirror').onclick = () => browse($('#mirrorPath').value || '~');
$('#checkMirror').onclick = () => browse($('#mirrorPath').value || '~');

// ---------- 向导 / 设置：读写 instance.json ----------
async function loadInstance() {
  const r = await api('/api/instance');
  const c = r.config || {};
  $('#interval').value = c.tick?.intervalMinutes ?? 5;
  $('#statePush').value = c.tick?.statePushMinutes ?? 15;
  $('#mirrorAt').value = (c.cloudMirror?.schedule?.times || ['22:00'])[0];
  $('#dshAuto').checked = !!c.apps?.dsh?.autostart;
  $('#consoleAuto').checked = c.console?.autostart !== false;
  $('#cfgJson').textContent = JSON.stringify(c, null, 2);
  return c;
}
$('#saveCfg').onclick = async () => {
  $('#saveMsg').textContent = '保存中…';
  const body = {
    tick: { intervalMinutes: Number($('#interval').value) || 5, statePushMinutes: Number($('#statePush').value) || 15 },
    cloudMirror: { schedule: { mode: 'dailyAt', times: [$('#mirrorAt').value || '22:00'] } },
    apps: { dsh: { autostart: $('#dshAuto').checked } },
    console: { autostart: $('#consoleAuto').checked },
  };
  const r = await api('/api/instance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  $('#saveMsg').innerHTML = r.ok ? '<span class="ok-t">已保存；调度自愈结果：' + JSON.stringify(r.schedule) + '</span>' : '<span class="fail-t">保存失败</span>';
  loadInstance();
};

// ---------- 向导②：同步空间 + 文件夹范围（真正可编辑） ----------
// 设计：编辑的是 <实例根>/sync/machines/<机器>.json 的 mu2 段；**校验在服务端做**（不通过不落盘），
// 前端只负责把错误原样显示出来 —— 绝不在前端"猜"能不能写。
let machineCfg = null;
let browseTarget = 'dest'; // 'dest' | { rowIndex }
const $setRows = () => Array.from(document.querySelectorAll('#setsTable tbody tr'));

async function loadMachine() {
  const r = await api('/api/machine');
  machineCfg = r;
  const mu2 = r.config?.mu2 || {};
  $('#mu2Enabled').checked = !!mu2.dest;
  $('#mu2Dest').value = mu2.dest || '';
  const tb = document.querySelector('#setsTable tbody');
  tb.innerHTML = '';
  for (const s of mu2.sets || []) addSetRow(s);
  if (!(mu2.sets || []).length) addSetRow({});
  return r;
}

function addSetRow(s = {}) {
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input class="setId" size="10" value="${s.id || ''}" placeholder="docs"></td>
    <td><input class="setSrc" size="46" value="${s.source || ''}" placeholder="~/Documents/papers">
        <button class="ghost browseSrc" type="button">浏览…</button></td>
    <td><input class="setTgt" size="16" value="${s.target || ''}" placeholder="papers"></td>
    <td class="est hint">—</td>
    <td><button class="ghost estBtn" type="button">预估</button> <button class="ghost delBtn" type="button">删</button></td>`;
  document.querySelector('#setsTable tbody').appendChild(tr);
  tr.querySelector('.browseSrc').onclick = () => {
    browseTarget = tr;
    browse(tr.querySelector('.setSrc').value || '~');
  };
  tr.querySelector('.delBtn').onclick = () => tr.remove();
  tr.querySelector('.estBtn').onclick = async () => {
    const p = tr.querySelector('.setSrc').value;
    const cell = tr.querySelector('.est');
    cell.textContent = '统计中…';
    const e = await api('/api/sets/estimate?path=' + encodeURIComponent(p));
    cell.textContent = e.ok ? `${e.files} 个文件 / ${e.mb} MB${e.truncated ? '（到上限，实际更多）' : ''}` : (e.error || '失败');
  };
}

$('#addSet').onclick = () => addSetRow({});
$('#browseDest').onclick = () => {
  browseTarget = 'dest';
  browse($('#mu2Dest').value || '~');
};

$('#saveMachine').onclick = async () => {
  const sets = $setRows()
    .map((tr) => ({ id: tr.querySelector('.setId').value.trim(), source: tr.querySelector('.setSrc').value.trim(), target: tr.querySelector('.setTgt').value.trim() }))
    .filter((s) => s.id || s.source || s.target);
  const body = { mu2: { enabled: $('#mu2Enabled').checked, dest: $('#mu2Dest').value.trim(), sets } };
  $('#machineMsg').textContent = '保存中…';
  const r = await api('/api/machine', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (r.errors) {
    $('#machineMsg').innerHTML = '<span class="fail-t">未保存（校验不过）：</span><br>' + r.errors.map((x) => '· ' + x).join('<br>');
  } else {
    $('#machineMsg').innerHTML = `<span class="ok-t">已保存 ${r.file}${r.looksCloudRoot === false ? '（注意：目录名不像常见网盘同步根，确认它真是客户端的同步文件夹）' : ''}</span>`;
    loadMachine();
  }
};

// ---------- 适配器 ----------
async function loadAdapters() {
  const r = await api('/api/adapters');
  const rows = [];
  for (const o of r.owners || []) {
    const on = (r.enabled.owners || {})[o.id] ?? o.enabled !== false;
    rows.push(`<tr><td><b>${o.id}</b></td><td>owner</td><td>${o.reload?.mode || 'none'}</td><td class="hint">${o.reload?.hint || ''}</td><td>${on ? '启用' : '<span class="hint">关闭</span>'}</td></tr>`);
  }
  for (const p of r.producers || []) {
    const on = (r.enabled.producers || {})[p.id] ?? p.enabled !== false;
    rows.push(`<tr><td><b>${p.id}</b></td><td>producer</td><td class="hint" colspan="2">${(p.cmd || []).join(' ')}</td><td>${on ? '启用' : '<span class="hint">关闭</span>'}</td></tr>`);
  }
  $('#adapters tbody').innerHTML = rows.join('');
}

// ---------- 对齐 ----------
async function runAlign(apply) {
  const btn = apply ? $('#alignApply') : $('#alignPlan');
  btn.disabled = true;
  $('#alignOut').textContent = apply ? '执行中…（可能几分钟）' : '读取计划…';
  const r = await api('/api/align' + (apply ? '?apply=1' : ''));
  $('#alignOut').textContent = (r.stdout || '') + (r.stderr ? '\n[stderr]\n' + r.stderr : '') + `\n[exit ${r.code}]`;
  btn.disabled = false;
  loadStatus();
}
$('#alignPlan').onclick = () => runAlign(false);
$('#alignApply').onclick = () => { if (confirm('执行对齐会改动本地文件（镜像侧冲突不丢数据，败者会另存侧车）。继续？')) runAlign(true); };

// ---------- 日志 / 立即同步 ----------
// ---------- 日志（解析成可读表格，而不是倒原文） ----------
// 理由（2026-09-17 用户反馈"日志可读性太差"）：tick 日志每行是一条紧凑摘要，原文倒出来没人看得下去。
// 这里把它拆成「时间 / 结果 / 变更 / 备注」四列，并把键值对翻成人话；原文仍可一键展开。
const KEYMAP = {
  pull: '拉取', commit: '提交', push: '推送', skip: '让路', elapsed: '耗时',
};
function parseTickLine(line) {
  // 兼容两种写法：老 `pull=1 commit=0 …` 与新 `拉取=1 提交=0 …`（都在同一行的固定位置）
  const m = /^tick\s+(\S+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*?)\brc=(-?\d+)\s*\|\s*(.*)$/.exec(line.trim());
  if (!m) return null;
  const [, machine, time, body, rc, note] = m;
  const kv = {};
  for (const pair of body.trim().split(/\s+/)) {
    const mm = /^([^\s=]+)=(\S+)$/.exec(pair);
    if (mm) kv[mm[1]] = mm[2];
  }
  const changes = Object.entries(kv)
    .filter(([k]) => ['pull', 'commit', 'push', 'skip', '拉取', '提交', '推送', '让路'].includes(k))
    .filter(([, v]) => Number(v) !== 0)
    .map(([k, v]) => `${KEYMAP[k] || k} ${v}`)
    .join(' · ') || '无变更';
  const elapsed = kv.elapsed || kv['耗时'] || '';
  return { machine, time, rc: Number(rc), changes, elapsed, note: note.trim() };
}

async function loadLog() {
  const r = await api('/api/logs?name=' + encodeURIComponent($('#logName').value || 'tick'));
  const lines = (r.tail || '').split(/\r?\n/).filter((x) => x.trim());
  const rows = [];
  const plain = [];
  for (const line of lines) {
    const p = parseTickLine(line);
    if (p) rows.push({ ...p, raw: line });
    else plain.push(line);
  }
  const html = [];
  if (rows.length) {
    html.push('<table><thead><tr><th>时间</th><th>结果</th><th>变更</th><th>耗时</th><th>备注</th></tr></thead><tbody>');
    for (const r2 of rows.reverse()) {
      const lv = r2.rc === 0 ? 'PASS' : 'FAIL';
      const label = r2.rc === 0 ? '正常' : `rc=${r2.rc} 有问题`;
      html.push(`<tr><td>${r2.time.slice(5)}</td><td class="lv ${lv}">${label}</td><td>${r2.changes}</td><td class="hint">${r2.elapsed}</td><td class="hint">${r2.note || '—'}</td></tr>`);
    }
    html.push('</tbody></table>');
  }
  if (plain.length) {
    html.push('<h3>其它输出</h3><pre class="out">' + plain.slice(-40).join('\n') + '</pre>');
  }
  $('#logOut').innerHTML = html.join('') || '(没有日志)';
  $('#logRaw').textContent = (r.tail || '').trim() || '(空)';
  if (!$('#logRawToggle').checked) $('#logRaw').classList.add('hidden');
  else $('#logRaw').classList.remove('hidden');
}
$('#loadLog').onclick = loadLog;
$('#logRawToggle').onchange = loadLog;
$('#logName').onchange = loadLog;
$('#btnTick').onclick = async () => {
  $('#btnTick').disabled = true;
  $('#btnTick').textContent = '同步中…';
  const r = await api('/api/tick');
  $('#btnTick').disabled = false;
  $('#btnTick').textContent = '立即同步';
  if (r.code !== 0) alert('tick 退出码 ' + r.code + '\n' + (r.stdout || r.stderr || '').slice(-800));
  loadStatus();
  if (document.querySelector('#tab-logs').classList.contains('active')) loadLog();
};

// ---------- 启动 ----------
async function loadStatus() { renderStatus(await api('/api/status')); }
loadInstance();
loadMachine();   // 向导②：同步空间 + 文件夹范围（可编辑，校验在服务端）
loadStatus();
activateTab(location.hash.slice(1) || 'status');   // 托盘菜单可直接唤起某页（#logs / #settings …）
setInterval(loadStatus, 60000);
