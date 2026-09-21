'use strict';

/**
 * 多设备事件对时核心逻辑。
 *
 * 每台设备提供一组同步锚点 { local, ref, uncertaintyMs? }（本地时间 -> 基准时间，均为 epoch 毫秒），
 * 相邻锚点之间做分段线性映射；锚点区间之外的事件按最近一段的斜率外推，并打上标记。
 *
 * 可选的 uncertaintyMs 表示该锚点基准时间的 ±误差（毫秒，非负数，缺省按 0）。
 * 校时时按区间算术传播误差，得到每条事件校正时间的最早/最晚边界：
 *   - 插值区间内按两端锚点的误差区间做线性组合（凸组合，误差线性过渡）；
 *   - 外推时同样取外推所用两锚点误差的线性组合（可能放大）；
 *   - 单锚点平移时误差恒定。
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
 * 解析锚点的 ±误差毫秒（第三列）。接受数字或数字字符串，允许前缀 "+" / "-" / "±"、
 * 空白及 "ms"/"毫秒" 后缀；空值按 0 处理。负数、非数字返回 NaN，由调用方定位到锚点行拒绝。
 */
function parseUncertaintyMs(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : NaN;
  if (typeof value !== 'string') return NaN;
  let s = value.trim();
  if (s === '') return 0;
  const negative = s.startsWith('-');
  s = s
    .replace(/^[±+\-\s]+/, '')
    .replace(/\s*(?:ms|毫秒)\s*$/i, '')
    .trim();
  const num = Number(s);
  if (!Number.isFinite(num) || num < 0 || negative) return NaN;
  return num;
}

/**
 * 校验并规范化锚点列表。
 * 锚点必须按本地时间严格递增，且基准时间也严格递增（否则说明设备时钟回拨或锚点填错）。
 * 可选的 uncertaintyMs（±误差毫秒）必须是非负有限数，缺省按 0；负数/非数字直接拒绝。
 * 返回按 local 升序排列的 [{ local, ref, uncertaintyMs }]，校验失败抛出带中文说明的 Error。
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
    const uncertaintyMs = parseUncertaintyMs(a && a.uncertaintyMs);
    if (!Number.isFinite(uncertaintyMs)) {
      throw new Error(
        `第 ${i + 1} 个锚点的 ±误差毫秒无效（uncertaintyMs=${JSON.stringify(a && a.uncertaintyMs)}）：必须是不小于 0 的数字，已拒绝`
      );
    }
    return { local, ref, uncertaintyMs };
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
 * 用分段线性映射把本地时间校正为基准时间，并按区间算术传播锚点误差。
 * 返回 { corrected, earliest, latest, extrapolated }：
 *   corrected   为中心值（与历史版本一致）；
 *   earliest/latest 为考虑各锚点 ±uncertaintyMs 后的最早/最晚校正时间；
 *   extrapolated 为 null（区间内插值）、'before'（首锚点之前外推）或 'after'（末锚点之后外推）。
 */
function correctTime(localMs, anchors) {
  const n = anchors.length;
  if (n === 1) {
    // 单锚点只做平移；除锚点本身外都算外推，误差恒定
    const only = anchors[0];
    const corrected = only.ref + (localMs - only.local);
    return {
      corrected,
      earliest: corrected - only.uncertaintyMs,
      latest: corrected + only.uncertaintyMs,
      extrapolated: localMs === only.local ? null : (localMs < only.local ? 'before' : 'after'),
    };
  }

  const first = anchors[0];
  const last = anchors[n - 1];

  if (localMs < first.local) {
    return withRange(lerpSegment(first, anchors[1], localMs), 'before');
  }
  if (localMs > last.local) {
    return withRange(lerpSegment(anchors[n - 2], last, localMs), 'after');
  }
  // 区间内：找到 localMs 所在的相邻锚点对
  for (let i = 0; i < n - 1; i++) {
    const a = anchors[i];
    const b = anchors[i + 1];
    if (localMs >= a.local && localMs <= b.local) {
      return withRange(lerpSegment(a, b, localMs), null);
    }
  }
  // 理论上不可达
  return withRange(lerpSegment(anchors[n - 2], last, localMs), 'after');
}

/**
 * 区间仿射运算：R = (1-r)*R_a + r*R_b（R_a ∈ a.ref±u_a，R_b ∈ b.ref±u_b）。
 * 插值时 r∈[0,1] 系数均非负，误差线性过渡；外推时 r 越界、系数出现负号，误差按绝对值放大。
 */
function lerpSegment(a, b, localMs) {
  const ratio = (localMs - a.local) / (b.local - a.local);
  const corrected = a.ref + ratio * (b.ref - a.ref);
  const uncertainty = Math.abs(1 - ratio) * a.uncertaintyMs + Math.abs(ratio) * b.uncertaintyMs;
  return { corrected, earliest: corrected - uncertainty, latest: corrected + uncertainty };
}

function withRange(seg, extrapolated) {
  return { corrected: seg.corrected, earliest: seg.earliest, latest: seg.latest, extrapolated };
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
    const r = correctTime(localMs, anchors);
    entries.push({
      device: name,
      rawTime: localMs,
      correctedTime: round3(r.corrected),
      earliestTime: round3(r.earliest),
      latestTime: round3(r.latest),
      uncertaintyMs: round3((r.latest - r.earliest) / 2),
      extrapolated: r.extrapolated,
      orderUncertain: false,
      event,
    });
  });

  return { device: name, anchors, entries, errors };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
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

  // 统一时间线按中心值排序后，相邻事件的校正区间相交（端点相切也算）时，
  // 两者先后顺序无法确定，两侧事件都打上 orderUncertain 标记。
  for (let i = 1; i < allEntries.length; i++) {
    const prev = allEntries[i - 1];
    const cur = allEntries[i];
    if (prev.latestTime >= cur.earliestTime) {
      prev.orderUncertain = true;
      cur.orderUncertain = true;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    deviceCount: devices.length,
    eventCount: allEntries.length,
    extrapolatedCount: allEntries.filter((e) => e.extrapolated).length,
    orderUncertainCount: allEntries.filter((e) => e.orderUncertain).length,
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
        earliestTime: new Date(e.earliestTime).toISOString(),
        earliestTimeMs: e.earliestTime,
        latestTime: new Date(e.latestTime).toISOString(),
        latestTimeMs: e.latestTime,
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

/**
 * 解析锚点文本（每行 "本地时间, 基准时间[, ±误差毫秒]"，支持 -> 或 Tab 分隔，# 注释）。
 * 时间列保持原始字符串交由核心库二次解析；第三列即时校验：缺失/空白按 0，
 * 负数或非数字记入 errors 并定位到行号。返回 { anchors, errors }。
 */
function parseAnchorText(text) {
  const anchors = [];
  const errors = [];
  String(text || '')
    .split(/\r?\n/)
    .forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) return;
      const parts = trimmed.split(/\s*(?:,|->|\t)\s*/);
      if (parts.length < 2 || parts.length > 3) {
        errors.push({ line: idx + 1, message: '格式应为：本地时间, 基准时间[, ±误差毫秒]' });
        return;
      }
      const [local, ref, uncertaintyRaw] = parts;
      const uncertaintyMs = parseUncertaintyMs(uncertaintyRaw);
      if (!Number.isFinite(uncertaintyMs)) {
        errors.push({ line: idx + 1, message: `±误差毫秒无效（${JSON.stringify(uncertaintyRaw)}）：必须是不小于 0 的数字` });
        return;
      }
      anchors.push({ local, ref, uncertaintyMs });
    });
  return { anchors, errors };
}

function fmt(ms) {
  return `${new Date(ms).toISOString()} (${ms})`;
}

module.exports = {
  parseTime,
  parseUncertaintyMs,
  parseAnchorText,
  normalizeAnchors,
  correctTime,
  correctDevice,
  mergeTimeline,
  parseJsonl,
  toJsonl,
  AUTO_TIME_FIELDS,
};
