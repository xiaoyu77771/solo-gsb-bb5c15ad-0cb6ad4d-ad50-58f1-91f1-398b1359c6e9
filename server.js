'use strict';

const path = require('path');
const express = require('express');
const {
  parseJsonl,
  mergeTimeline,
  toJsonl,
  AUTO_TIME_FIELDS,
} = require('./lib/timesync');

const app = express();
const PORT = Number(process.env.PORT) || 8080;

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/**
 * POST /api/sync
 * body: { devices: [{ name, timeField?, anchors: [{local, ref}], eventsText }] }
 * eventsText 为 JSONL 原文；服务端解析、校时、合并后返回统一时间线与可下载的 JSONL。
 */
app.post('/api/sync', (req, res) => {
  const body = req.body || {};
  if (!Array.isArray(body.devices) || body.devices.length === 0) {
    return res.status(400).json({ error: '至少需要 1 台设备' });
  }
  if (body.devices.length > 50) {
    return res.status(400).json({ error: '设备数量超过上限（50）' });
  }

  // 先解析各设备 JSONL，解析错误不阻断，随结果返回
  const devices = [];
  const parseErrors = [];
  for (const d of body.devices) {
    const name = (d && typeof d.name === 'string' ? d.name.trim() : '') || '未命名设备';
    const { events, errors } = parseJsonl(d && d.eventsText);
    for (const e of errors) parseErrors.push({ device: name, ...e });
    devices.push({
      name,
      timeField: typeof d.timeField === 'string' && d.timeField.trim() ? d.timeField.trim() : undefined,
      anchors: Array.isArray(d.anchors) ? d.anchors : [],
      events,
    });
  }

  let merged;
  try {
    merged = mergeTimeline(devices);
  } catch (err) {
    return res.status(422).json({ error: err.message, parseErrors });
  }

  merged.parseErrors = parseErrors;
  merged.jsonl = toJsonl(merged);
  res.json(merged);
});

/** POST /api/parse-anchors：前端实时校验锚点文本（每行 "本地时间, 基准时间"）。 */
app.post('/api/parse-anchors', (req, res) => {
  const text = (req.body && req.body.text) || '';
  const anchors = [];
  const errors = [];
  String(text)
    .split(/\r?\n/)
    .forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return;
      const parts = trimmed.split(/\s*(?:,|->|\t)\s*/);
      if (parts.length !== 2) {
        errors.push({ line: idx + 1, message: '格式应为：本地时间, 基准时间' });
        return;
      }
      anchors.push({ local: parts[0], ref: parts[1] });
    });
  res.json({ anchors, errors });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, autoTimeFields: AUTO_TIME_FIELDS }));

app.listen(PORT, () => {
  console.log(`多设备事件对时工具已启动: http://localhost:${PORT}`);
});
