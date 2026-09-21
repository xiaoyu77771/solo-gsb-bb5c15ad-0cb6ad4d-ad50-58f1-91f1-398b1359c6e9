'use strict';

/**
 * 多设备事件对时核心逻辑。
 *
 * 每台设备提供一组同步锚点 { local, ref, err? }（本地时间 -> 基准时间，均为 epoch 毫秒；
 * err 为可选的 ±误差毫秒，缺省 0）。相邻锚点之间做分段线性映射；锚点区间之外的事件
 * 按最近一段的斜率外推，并打上标记。
 *
 * 校时按区间算术进行：锚点基准时间视为区间 [ref−err, ref+err]，沿当前分段线性
 * 插值/外推得到每条事件的校正区间 [最早, 最晚]；统一时间线仍按中心值排序，
 * 相邻事件区间相交时两者都标记为“顺序不确定”。
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
 * 解析锚点的可选 ±误差（毫秒）。缺省（undefined/null/空串）按 0 处理；
 * 负数或非数字抛出带锚点序号的 Error，便于定位到具体锚点行。
 */
function parseUncertainty(value, index) {
  if (value === undefined || value === null || value === '') return 0;
  let num = value;
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/^[±+]\s*/, '');
    if (!/^\d+(\.\d+)?$/.test(cleaned)) {
      throw new Error(`第 ${index + 1} 个锚点的误差无效（${JSON.stringify(value)}），须为非负毫秒数`);
    }
    num = Number(cleaned);
  }
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) {
    throw new Error(`第 ${index + 1} 个锚点的误差无效（${JSON.stringify(value)}），须为非负毫秒数`);
  }
  return num;
}

/**
 * 校验并规范化锚点列表。
 * 锚点必须按本地时间严格递增，且基准时间也严格递增（否则说明设备时钟回拨或锚点填错）。
 * 可选的 err（±误差毫秒）缺省为 0，负数或非数字会被拒绝并指出锚点序号。
 * 返回按 local 升序排列的 [{ local, ref, err }]，校验失败抛出带中文说明的 Error。
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
    return { local, ref, err: parseUncertainty(a && a.err, i) };
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
 * 用分段线性映射把本地时间校正为基准时间（区间算术）。
 * 返回 { corrected, uncertainty, extrapolated }：
 *   corrected    校正时间中心值（epoch ms）；
 *   uncertainty  校正时间的不确定半宽（±毫秒），由锚点误差沿当前分段做区间算术得到，
 *                即校正区间为 [corrected − uncertainty, corrected + uncertainty]；
 *   extrapolated 为 null（区间内插值）、'before'（首锚点之前外推）或 'after'（末锚点之后外推）。
 */
function correctTime(localMs, anchors) {
  const n = anchors.length;
  if (n === 1) {
    // 单锚点只做平移，不确定度保持不变；除锚点本身外都算外推
    const only = anchors[0];
    return {
      corrected: only.ref + (localMs - only.local),
      uncertainty: only.err,
      extrapolated: localMs === only.local ? null : (localMs < only.local ? 'before' : 'after'),
    };
  }

  const first = anchors[0];
  const last = anchors[n - 1];

  if (localMs < first.local) {
    return segmentCorrect(first, anchors[1], localMs, 'before');
  }
  if (localMs > last.local) {
    return segmentCorrect(anchors[n - 2], last, localMs, 'after');
  }
  // 区间内：找到 localMs 所在的相邻锚点对
  for (let i = 0; i < n - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (localMs >= a.local && localMs <= b.local) {
      return segmentCorrect(a, b, localMs, null);
    }
  }
  // 理论上不可达
  return segmentCorrect(anchors[n - 2], last, localMs, 'after');
}

/**
 * 沿锚点对 (a, b) 所在分段做线性插值/外推。
 * 中心值 R = (1−r)·Ra + r·Rb；把每个锚点基准时间视为区间 [R−err, R+err] 后，
 * 该区间的精确半宽为 |1−r|·Ea + |r|·Eb（内插时退化为误差的线性插值，
 * 外推时不确定度随 |r| 增大而放大）。
 */
function segmentCorrect(a, b, localMs, extrapolated) {
  const ratio = (localMs - a.local) / (b.local - a.local);
  return {
    corrected: a.ref + ratio * (b.ref - a.ref),
    uncertainty: Math.abs(1 - ratio) * a.err + Math.abs(ratio) * b.err,
    extrapolated,
  };
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
 * device: { name, timeField?, anchors: [{local, ref, err?}], events: [object] }
 * 每条 entry 携带校正区间 [correctedEarliest, correctedLatest]（中心值 ± 不确定半宽）。
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
    const { corrected, uncertainty, extrapolated } = correctTime(localMs, anchors);
    entries.push({
      device: name,
      rawTime: localMs,
      correctedTime: Math.round(corrected * 1000) / 1000,
      uncertaintyMs: Math.round(uncertainty * 1000) / 1000,
      correctedEarliest: Math.round((corrected - uncertainty) * 1000) / 1000,
      correctedLatest: Math.round((corrected + uncertainty) * 1000) / 1000,
      orderUncertain: false,
      extrapolated,
      event,
    });
  });

  return { device: name, anchors, entries, errors };
}

/**
 * 合并多台设备的校正结果，按校正后时间（中心值）升序输出统一时间线。
 * 排序后扫描相邻事件：若前一条的校正区间最晚值 >= 后一条的最早值（两区间相交），
 * 说明这一对事件的先后无法凭现有校时精度断定，两侧都打上 orderUncertain 标记。
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

  // 相邻事件校正区间相交 -> 这一对两侧事件顺序不确定
  let orderUncertainCount = 0;
  for (let i = 0; i < allEntries.length - 1; i++) {
    const a = allEntries[i];
    const b = allEntries[i + 1];
    if (a.correctedLatest >= b.correctedEarliest) {
      if (!a.orderUncertain) { a.orderUncertain = true; orderUncertainCount++; }
      if (!b.orderUncertain) { b.orderUncertain = true; orderUncertainCount++; }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    deviceCount: devices.length,
    eventCount: allEntries.length,
    extrapolatedCount: allEntries.filter((e) => e.extrapolated).length,
    orderUncertainCount,
    devices: perDevice,
    errors: allErrors,
    timeline: allEntries,
  };
}

/** 把合并结果序列化为 JSONL（每行一条校正后的事件，含校正区间与顺序不确定标记）。 */
function toJsonl(merged) {
  return merged.timeline
    .map((e) =>
      JSON.stringify({
        correctedTime: new Date(e.correctedTime).toISOString(),
        correctedTimeMs: e.correctedTime,
        correctedEarliest: new Date(e.correctedEarliest).toISOString(),
        correctedEarliestMs: e.correctedEarliest,
        correctedLatest: new Date(e.correctedLatest).toISOString(),
        correctedLatestMs: e.correctedLatest,
        uncertaintyMs: e.uncertaintyMs,
        orderUncertain: e.orderUncertain,
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
