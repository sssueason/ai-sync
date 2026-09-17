// app.js — 控制台前端（原生 JS，无构建、无依赖）
// 设计：页面只做"显示 + 转发"，所有动作都调引擎既有 CLI（/api/* 之后仍是 sync-status / sync-align / sync-lite），
// 不在前端重实现任何同步逻辑（否则就是第二套真相）。
const $ = (s) => document.querySelector(s);
const api = async (p, opt) => {
  const r = await fetch(p, opt);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { raw: t }; }
};

// ---------- 标签页 ----------
for (const b of document.querySelectorAll('.tab')) {
  b.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + b.dataset.tab));
    if (b.dataset.tab === 'logs') loadLog();
    if (b.dataset.tab === 'settings') loadAdapters();
  };
}

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
async function loadLog() {
  const r = await api('/api/logs?name=' + encodeURIComponent($('#logName').value || 'tick'));
  $('#logOut').textContent = r.tail || '(空)';
}
$('#loadLog').onclick = loadLog;
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
loadStatus();
setInterval(loadStatus, 60000);
