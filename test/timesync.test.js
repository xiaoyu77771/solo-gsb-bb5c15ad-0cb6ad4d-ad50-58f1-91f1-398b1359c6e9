'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTime,
  normalizeAnchors,
  correctTime,
  mergeTimeline,
  parseJsonl,
  toJsonl,
} = require('../lib/timesync');

const A = (iso) => Date.parse(iso);

test('parseTime 支持 epoch 毫秒与 ISO 字符串', () => {
  assert.equal(parseTime(1000), 1000);
  assert.equal(parseTime('1000'), 1000);
  assert.equal(parseTime('1970-01-01T00:00:01.000Z'), 1000);
  assert.ok(Number.isNaN(parseTime('not-a-time')));
  assert.ok(Number.isNaN(parseTime('')));
});

test('normalizeAnchors 拒绝本地时间倒序或重复', () => {
  assert.throws(
    () => normalizeAnchors([
      { local: 2000, ref: 2000 },
      { local: 1000, ref: 3000 },
    ]),
    /本地时间倒序/
  );
  assert.throws(
    () => normalizeAnchors([
      { local: 1000, ref: 1000 },
      { local: 1000, ref: 2000 },
    ]),
    /本地时间倒序/
  );
});

test('normalizeAnchors 拒绝基准时间倒序或重复', () => {
  assert.throws(
    () => normalizeAnchors([
      { local: 1000, ref: 5000 },
      { local: 2000, ref: 4000 },
    ]),
    /基准时间倒序/
  );
  assert.throws(
    () => normalizeAnchors([
      { local: 1000, ref: 5000 },
      { local: 2000, ref: 5000 },
    ]),
    /基准时间倒序/
  );
});

test('normalizeAnchors 拒绝空锚点与无法解析的时间', () => {
  assert.throws(() => normalizeAnchors([]), /至少需要 1 个/);
  assert.throws(() => normalizeAnchors([{ local: 'x', ref: 1 }]), /无法解析/);
});

test('分段线性校时：区间内插值', () => {
  const anchors = normalizeAnchors([
    { local: A('2026-09-21T10:00:00Z'), ref: A('2026-09-21T10:00:02Z') },
    { local: A('2026-09-21T10:10:00Z'), ref: A('2026-09-21T10:10:01Z') },
  ]);
  // 中点：本地 +5min -> 基准 10:05:01.5
  const mid = correctTime(A('2026-09-21T10:05:00Z'), anchors);
  assert.equal(mid.corrected, A('2026-09-21T10:05:01.500Z'));
  assert.equal(mid.extrapolated, null);
  // 锚点本身
  const onAnchor = correctTime(A('2026-09-21T10:00:00Z'), anchors);
  assert.equal(onAnchor.corrected, A('2026-09-21T10:00:02Z'));
  assert.equal(onAnchor.extrapolated, null);
});

test('分段线性校时：区间外按最近段斜率外推并标记', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 1000 },
    { local: 10000, ref: 11000 }, // 斜率 1，偏移 +1000
  ]);
  const before = correctTime(-5000, anchors);
  assert.equal(before.corrected, -4000);
  assert.equal(before.extrapolated, 'before');

  const after = correctTime(20000, anchors);
  assert.equal(after.corrected, 21000);
  assert.equal(after.extrapolated, 'after');
});

test('单锚点做平移，非锚点位置标记为外推', () => {
  const anchors = normalizeAnchors([{ local: 1000, ref: 5000 }]);
  assert.deepEqual(correctTime(1000, anchors), { corrected: 5000, extrapolated: null });
  assert.deepEqual(correctTime(2000, anchors), { corrected: 6000, extrapolated: 'after' });
  assert.deepEqual(correctTime(0, anchors), { corrected: 4000, extrapolated: 'before' });
});

test('多段锚点使用各自区间的斜率', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 0 },
    { local: 10000, ref: 10000 }, // 第一段斜率 1
    { local: 20000, ref: 30000 }, // 第二段斜率 2
  ]);
  assert.equal(correctTime(5000, anchors).corrected, 5000);
  assert.equal(correctTime(15000, anchors).corrected, 20000);
  // 尾部外推沿用第二段斜率 2
  const after = correctTime(25000, anchors);
  assert.equal(after.corrected, 40000);
  assert.equal(after.extrapolated, 'after');
});

test('mergeTimeline 合并多设备并按校正时间排序', () => {
  const merged = mergeTimeline([
    {
      name: 'dev-A',
      anchors: [{ local: 0, ref: 0 }, { local: 10000, ref: 10000 }],
      events: [{ ts: 5000, msg: 'a1' }, { ts: 20000, msg: 'a2-extrapolated' }],
    },
    {
      name: 'dev-B',
      anchors: [{ local: 0, ref: 1000 }, { local: 10000, ref: 11000 }],
      events: [{ ts: 1000, msg: 'b1' }],
    },
  ]);
  assert.equal(merged.eventCount, 3);
  assert.equal(merged.extrapolatedCount, 1);
  assert.deepEqual(
    merged.timeline.map((e) => e.correctedTime),
    [2000, 5000, 20000]
  );
  assert.equal(merged.timeline[2].extrapolated, 'after');
});

test('mergeTimeline 中任一设备锚点非法则整体抛错', () => {
  assert.throws(
    () => mergeTimeline([
      { name: 'ok', anchors: [{ local: 0, ref: 0 }], events: [] },
      { name: 'bad', anchors: [{ local: 5, ref: 5 }, { local: 1, ref: 6 }], events: [] },
    ]),
    /倒序/
  );
});

test('时间字段自动探测与指定字段', () => {
  const merged = mergeTimeline([
    {
      name: 'auto',
      anchors: [{ local: 0, ref: 0 }],
      events: [{ time: 1000 }, { timestamp: 2000 }],
    },
    {
      name: 'custom',
      timeField: 'localTime',
      anchors: [{ local: 0, ref: 0 }],
      events: [{ localTime: 3000 }],
    },
  ]);
  assert.equal(merged.eventCount, 3);
  assert.equal(merged.errors.length, 0);
});

test('缺少时间字段的事件记入 errors，不进入时间线', () => {
  const merged = mergeTimeline([
    { name: 'dev', anchors: [{ local: 0, ref: 0 }], events: [{ msg: 'no time' }] },
  ]);
  assert.equal(merged.eventCount, 0);
  assert.equal(merged.errors.length, 1);
});

test('parseJsonl 跳过空行并报告坏行', () => {
  const { events, errors } = parseJsonl('{"a":1}\n\nnot-json\n[1,2]\n{"b":2}');
  assert.equal(events.length, 2);
  assert.equal(errors.length, 2);
  assert.equal(errors[0].line, 3);
});

test('toJsonl 输出每行一个可解析的 JSON', () => {
  const merged = mergeTimeline([
    { name: 'dev', anchors: [{ local: 0, ref: 0 }], events: [{ ts: 0, msg: 'x' }] },
  ]);
  const lines = toJsonl(merged).split('\n');
  assert.equal(lines.length, 1);
  const obj = JSON.parse(lines[0]);
  assert.equal(obj.device, 'dev');
  assert.equal(obj.correctedTimeMs, 0);
  assert.equal(obj.extrapolated, null);
  assert.deepEqual(obj.event, { ts: 0, msg: 'x' });
});
