'use strict';

/* 多设备事件对时工具前端逻辑：收集设备配置 → 调 /api/sync → 渲染统一时间线 */

const devicesEl = document.getElementById('devices');
const tpl = document.getElementById('tpl-device');
const statusEl = document.getElementById('status');
const resultPanel = document.getElementById('result-panel');
const summaryEl = document.getElementById('summary');
const errorsEl = document.getElementById('errors');
const tbody = document.getElementById('timeline-body');
const chkHideExtrapolated = document.getElementById('chk-hide-extrapolated');
const chkCompact = document.getElementById('chk-compact');

let lastResult = null;

function addDevice(data) {
  const node = tpl.content.cloneNode(true);
  const root = node.querySelector('.device');
  root.querySelector('.btn-remove').addEventListener('click', () => root.remove());
  if (data) {
    root.querySelector('.device-name').value = data.name || '';
    root.querySelector('.device-timefield').value = data.timeField || '';
    root.querySelector('.device-anchors').value = data.anchors || '';
    root.querySelector('.device-events').value = data.events || '';
  }
  devicesEl.appendChild(node);
  return root;
}

function setStatus(msg, cls) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

/** 解析锚点文本：每行 "本地时间, 基准时间"（也支持 -> 或 Tab 分隔，# 开头为注释）。 */
function parseAnchorLines(text) {
  const anchors = [];
  const errors = [];
  text.split(/\r?\n/).forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/\s*(?:,|->|\t)\s*/);
    if (parts.length !== 2) {
      errors.push({ line: idx + 1, message: '格式应为：本地时间, 基准时间' });
      return;
    }
    anchors.push({ local: parts[0], ref: parts[1] });
  });
  return { anchors, errors };
}

function collectDevices() {
  const devices = [];
  const problems = [];
  document.querySelectorAll('.device').forEach((el, i) => {
    const name = el.querySelector('.device-name').value.trim() || `设备 ${i + 1}`;
    const timeField = el.querySelector('.device-timefield').value.trim();
    const { anchors, errors } = parseAnchorLines(el.querySelector('.device-anchors').value);
    for (const e of errors) {
      problems.push(`[${name}] 锚点第 ${e.line} 行：${e.message}`);
    }
    devices.push({
      name,
      timeField,
      anchors,
      eventsText: el.querySelector('.device-events').value,
    });
  });
  return { devices, problems };
}

async function doSync() {
  const { devices, problems } = collectDevices();
  if (devices.length === 0) {
    setStatus('请先添加至少 1 台设备', 'error');
    return;
  }
  if (problems.length > 0) {
    setStatus(problems.join('；'), 'error');
    return;
  }
  setStatus('校时中…');
  try {
    const resp = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ devices }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      setStatus(data.error || `请求失败（HTTP ${resp.status}）`, 'error');
      return;
    }
    lastResult = data;
    renderResult(data);
    setStatus(`完成：${data.eventCount} 条事件已合并`, 'ok');
  } catch (err) {
    setStatus(`请求出错：${err.message}`, 'error');
  }
}

function fmtIso(ms) {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
}

function renderResult(data) {
  resultPanel.classList.remove('hidden');

  summaryEl.innerHTML = '';
  const items = [
    ['设备数', data.deviceCount],
    ['事件总数', data.eventCount],
    ['外推事件', data.extrapolatedCount],
    ['生成时间', new Date(data.generatedAt).toLocaleString()],
  ];
  for (const [label, value] of items) {
    const span = document.createElement('span');
    const isWarn = label === '外推事件' && value > 0;
    span.innerHTML = `${label}：<strong class="${isWarn ? 'warn' : ''}">${value}</strong>`;
    summaryEl.appendChild(span);
  }

  const allErrors = []
    .concat((data.errors || []).map((e) => `[${e.device}] 事件 ${e.index + 1}：${e.message}`))
    .concat((data.parseErrors || []).map((e) => `[${e.device}] JSONL 第 ${e.line} 行：${e.message}`));
  if (allErrors.length > 0) {
    errorsEl.classList.remove('hidden');
    errorsEl.innerHTML = allErrors.map((e) => `<div>⚠ ${escapeHtml(e)}</div>`).join('');
  } else {
    errorsEl.classList.add('hidden');
    errorsEl.innerHTML = '';
  }

  renderTable();
  resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderTable() {
  if (!lastResult) return;
  const hideExtrapolated = chkHideExtrapolated.checked;
  tbody.innerHTML = '';
  let visible = 0;
  lastResult.timeline.forEach((entry) => {
    if (hideExtrapolated && entry.extrapolated) return;
    visible++;
    const tr = document.createElement('tr');
    if (entry.extrapolated) tr.className = 'extrapolated';

    const badge = entry.extrapolated
      ? `<span class="badge badge-warn">${entry.extrapolated === 'before' ? '区间前' : '区间后'}</span>`
      : '<span class="badge badge-ok">内插</span>';

    tr.innerHTML =
      `<td class="mono">${visible}</td>` +
      `<td>${escapeHtml(entry.device)}</td>` +
      `<td class="mono col-raw">${escapeHtml(fmtIso(entry.rawTime))}</td>` +
      `<td class="mono">${escapeHtml(fmtIso(entry.correctedTime))}</td>` +
      `<td>${badge}</td>` +
      `<td class="event-cell">${escapeHtml(JSON.stringify(entry.event))}</td>`;
    tbody.appendChild(tr);
  });
}

function exportJsonl() {
  if (!lastResult || !lastResult.jsonl) return;
  const blob = new Blob([lastResult.jsonl + '\n'], { type: 'application/x-ndjson' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  a.href = url;
  a.download = `merged-timeline-${stamp}.jsonl`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadSample() {
  devicesEl.innerHTML = '';
  addDevice({
    name: 'switch-A',
    timeField: 'ts',
    anchors: [
      '# 本地时间, 基准时间',
      '2026-09-21T10:00:00.000Z, 2026-09-21T10:00:02.500Z',
      '2026-09-21T10:10:00.000Z, 2026-09-21T10:10:02.000Z',
    ].join('\n'),
    events: [
      '{"ts":"2026-09-21T09:59:50.000Z","level":"INFO","msg":"boot"}',
      '{"ts":"2026-09-21T10:00:01.000Z","level":"ERROR","msg":"port 3 link down"}',
      '{"ts":"2026-09-21T10:05:00.000Z","level":"WARN","msg":"crc errors rising"}',
      '{"ts":"2026-09-21T10:10:05.000Z","level":"INFO","msg":"snmp poll ok"}',
    ].join('\n'),
  });
  addDevice({
    name: 'server-B',
    timeField: '',
    anchors: [
      '2026-09-21T10:00:10.000Z, 2026-09-21T10:00:05.000Z',
      '2026-09-21T10:10:10.000Z, 2026-09-21T10:10:04.500Z',
    ].join('\n'),
    events: [
      '{"time":"2026-09-21T10:00:12.000Z","level":"INFO","msg":"nic flap detected"}',
      '{"time":"2026-09-21T10:05:10.000Z","level":"ERROR","msg":"retransmit timeout"}',
      '{"time":"2026-09-21T10:10:20.000Z","level":"INFO","msg":"backup finished"}',
    ].join('\n'),
  });
  setStatus('已载入示例，可直接点击“校时并合并”', 'ok');
}

document.getElementById('btn-add-device').addEventListener('click', () => addDevice());
document.getElementById('btn-sample').addEventListener('click', loadSample);
document.getElementById('btn-sync').addEventListener('click', doSync);
document.getElementById('btn-export').addEventListener('click', exportJsonl);
chkHideExtrapolated.addEventListener('change', renderTable);
chkCompact.addEventListener('change', () => {
  document.body.classList.toggle('compact', chkCompact.checked);
});

// 初始给一台空设备
addDevice();
