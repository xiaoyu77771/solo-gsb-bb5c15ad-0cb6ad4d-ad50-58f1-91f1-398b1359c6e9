'use strict';

/**
 * 多设备事件对时核心逻辑。
 *
 * 每台设备提供一组同步锚点 { local, ref }（本地时间 -> 基准时间，均为 epoch 毫秒），
 * 相邻锚点之间做分段线性映射；锚点区间之外的事件按最近一段的斜率外推，并打上标记。
 */

const AUTO_TIME_FIELDS = ['ts', 'time', 'timestamp'];

/** 把数字（epoch ms）或可解析的时间字符串转成 epoch 毫秒；失败返回 NaN。 */
function parseTime(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return NaN;
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  return NaN;
}

/**
 * 校验并规范化锚点列表。
 * 锚点必须按本地时间严格递增，且基准时间也严格递增（否则说明设备时钟回拨或锚点填错）。
 * 返回按 local 升序排列的 [{ local, ref }]，校验失败抛出带中文说明的 Error。
 */
function normalizeAnchors(rawAnchors) {
  if (!Array.isArray(rawAnchors) || rawAnchors.length === 0) {
    throw new Error('每台设备至少需要 1 个同步锚点');
  }
  const anchors = rawAnchors.map((a, i) => {
    const local = parseTime(a && a.local);
    const ref = parseTime(a && a.ref);
    if (!Number.isFinite(local) || !Number.isFinite(ref)) {
      throw new Error(`第 ${i + 1} 个锚点的时间无法解析（local=${JSON.stringify(a && a.local)}, ref=${JSON.stringify(a && a.ref)}）`);
    }
    return { local, ref };
  });

  // 按输入顺序严格校验：本地时间与基准时间都必须严格递增，倒序或重复直接拒绝
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i].local <= anchors[i - 1].local) {
      throw new Error(
        `锚点本地时间倒序或重复：第 ${i} 个为 ${fmt(anchors[i - 1].local)}，第 ${i + 1} 个为 ${fmt(anchors[i].local)}，已拒绝`
      );
    }
    if (anchors[i].ref <= anchors[i - 1].ref) {
      throw new Error(
        `锚点基准时间倒序或重复：第 ${i + 1} 个锚点（本地 ${fmt(anchors[i].local)}）的基准时间 ${fmt(anchors[i].ref)} 不晚于前一锚点的 ${fmt(anchors[i - 1].ref)}，已拒绝`
      );
    }
  }
  return anchors;
}

/**
 * 用分段线性映射把本地时间校正为基准时间。
 * 返回 { corrected, extrapolated }：
 *   extrapolated 为 null（区间内插值）、'before'（首锚点之前外推）或 'after'（末锚点之后外推）。
 */
function correctTime(localMs, anchors) {
  const n = anchors.length;
  if (n === 1) {
    // 单锚点只做平移；除锚点本身外都算外推
    const only = anchors[0];
    return {
      corrected: only.ref + (localMs - only.local),
      extrapolated: localMs === only.local ? null : (localMs < only.local ? 'before' : 'after'),
    };
  }

  const first = anchors[0];
  const last = anchors[n - 1];

  if (localMs < first.local) {
    return { corrected: lerp(first, anchors[1], localMs), extrapolated: 'before' };
  }
  if (localMs > last.local) {
    return { corrected: lerp(anchors[n - 2], last, localMs), extrapolated: 'after' };
  }
  // 区间内：找到 localMs 所在的相邻锚点对
  for (let i = 0; i < n - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (localMs >= a.local && localMs <= b.local) {
      return { corrected: lerp(a, b, localMs), extrapolated: null };
    }
  }
  // 理论上不可达
  return { corrected: lerp(anchors[n - 2], last, localMs), extrapolated: 'after' };
}

function lerp(a, b, localMs) {
  const ratio = (localMs - a.local) / (b.local - a.local);
  return a.ref + ratio * (b.ref - a.ref);
}

/** 从事件对象中取出本地时间字段：优先指定字段，否则按常见字段名自动探测。 */
function extractLocalTime(event, timeField) {
  if (timeField) return parseTime(event[timeField]);
  for (const f of AUTO_TIME_FIELDS) {
    if (event[f] !== undefined) {
      const v = parseTime(event[f]);
      if (Number.isFinite(v)) return v;
    }
  }
  return NaN;
}

/**
 * 解析 JSONL 文本为事件数组。空行跳过；每行必须是 JSON 对象。
 * 返回 { events, errors }，errors 为 [{ line, message }]。
 */
function parseJsonl(text) {
  const events = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    try {
      const obj = JSON.parse(trimmed);
      if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
        errors.push({ line: idx + 1, message: '该行不是 JSON 对象' });
        return;
      }
      events.push(obj);
    } catch (e) {
      errors.push({ line: idx + 1, message: `JSON 解析失败：${e.message}` });
    }
  });
  return { events, errors };
}

/**
 * 对一台设备做校时。
 * device: { name, timeField?, anchors: [{local, ref}], events: [object] }
 * 返回 { device, entries, errors }；锚点非法时抛错。
 */
function correctDevice(device) {
  const name = (device.name || '').trim() || '未命名设备';
  const anchors = normalizeAnchors(device.anchors);
  const entries = [];
  const errors = [];

  (device.events || []).forEach((event, idx) => {
    const localMs = extractLocalTime(event, device.timeField);
    if (!Number.isFinite(localMs)) {
      errors.push({ index: idx, message: `第 ${idx + 1} 条事件缺少可解析的时间字段（${device.timeField || AUTO_TIME_FIELDS.join('/')}）` });
      return;
    }
    const { corrected, extrapolated } = correctTime(localMs, anchors);
    entries.push({
      device: name,
      rawTime: localMs,
      correctedTime: Math.round(corrected * 1000) / 1000,
      extrapolated,
      event,
    });
  });

  return { device: name, anchors, entries, errors };
}

/**
 * 合并多台设备的校正结果，按校正后时间升序输出统一时间线。
 * devices 中任一设备锚点非法时，整体抛错（由调用方决定如何呈现）。
 */
function mergeTimeline(devices) {
  const perDevice = [];
  const allEntries = [];
  const allErrors = [];

  for (const device of devices) {
    const result = correctDevice(device);
    perDevice.push({ device: result.device, anchors: result.anchors, errors: result.errors });
    for (const e of result.entries) allEntries.push(e);
    for (const err of result.errors) allErrors.push({ device: result.device, ...err });
  }

  allEntries.sort((a, b) => a.correctedTime - b.correctedTime || a.device.localeCompare(b.device));

  return {
    generatedAt: new Date().toISOString(),
    deviceCount: devices.length,
    eventCount: allEntries.length,
    extrapolatedCount: allEntries.filter((e) => e.extrapolated).length,
    devices: perDevice,
    errors: allErrors,
    timeline: allEntries,
  };
}

/** 把合并结果序列化为 JSONL（每行一条校正后的事件）。 */
function toJsonl(merged) {
  return merged.timeline
    .map((e) =>
      JSON.stringify({
        correctedTime: new Date(e.correctedTime).toISOString(),
        correctedTimeMs: e.correctedTime,
        device: e.device,
        rawTime: new Date(e.rawTime).toISOString(),
        rawTimeMs: e.rawTime,
        extrapolated: e.extrapolated,
        event: e.event,
      })
    )
    .join('\n');
}

function fmt(ms) {
  return `${new Date(ms).toISOString()} (${ms})`;
}

module.exports = {
  parseTime,
  normalizeAnchors,
  correctTime,
  correctDevice,
  mergeTimeline,
  parseJsonl,
  toJsonl,
  AUTO_TIME_FIELDS,
};
