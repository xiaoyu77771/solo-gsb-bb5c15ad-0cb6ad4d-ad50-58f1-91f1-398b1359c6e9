'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseTime,
  parseUncertaintyMs,
  parseAnchorText,
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
  assert.deepEqual(correctTime(1000, anchors), {
    corrected: 5000, earliest: 5000, latest: 5000, extrapolated: null,
  });
  assert.deepEqual(correctTime(2000, anchors), {
    corrected: 6000, earliest: 6000, latest: 6000, extrapolated: 'after',
  });
  assert.deepEqual(correctTime(0, anchors), {
    corrected: 4000, earliest: 4000, latest: 4000, extrapolated: 'before',
  });
});

test('单锚点误差恒定平移，区间为 corrected±uncertainty', () => {
  const anchors = normalizeAnchors([{ local: 1000, ref: 5000, uncertaintyMs: 20 }]);
  const r = correctTime(2000, anchors);
  assert.equal(r.corrected, 6000);
  assert.equal(r.earliest, 5980);
  assert.equal(r.latest, 6020);
});

test('未填写误差按 0 处理，区间退化为点', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 0 },
    { local: 10000, ref: 10000 },
  ]);
  const r = correctTime(5000, anchors);
  assert.equal(r.earliest, r.corrected);
  assert.equal(r.latest, r.corrected);
});

test('负数或非数字误差定位到锚点序号并拒绝', () => {
  assert.throws(
    () => normalizeAnchors([{ local: 0, ref: 0, uncertaintyMs: -1 }]),
    /第 1 个锚点的 ±误差毫秒无效/
  );
  assert.throws(
    () => normalizeAnchors([
      { local: 0, ref: 0, uncertaintyMs: 5 },
      { local: 1000, ref: 1000, uncertaintyMs: 'abc' },
    ]),
    /第 2 个锚点的 ±误差毫秒无效/
  );
  assert.throws(
    () => normalizeAnchors([{ local: 0, ref: 0, uncertaintyMs: '-10' }]),
    /±误差毫秒无效/
  );
});

test('parseUncertaintyMs：空值为 0，接受 ± 前缀/ms 后缀，拒绝负数与非数字', () => {
  assert.equal(parseUncertaintyMs(undefined), 0);
  assert.equal(parseUncertaintyMs(''), 0);
  assert.equal(parseUncertaintyMs('   '), 0);
  assert.equal(parseUncertaintyMs(25.5), 25.5);
  assert.equal(parseUncertaintyMs('100'), 100);
  assert.equal(parseUncertaintyMs('± 50 ms'), 50);
  assert.ok(Number.isNaN(parseUncertaintyMs(-5)));
  assert.ok(Number.isNaN(parseUncertaintyMs('abc')));
  assert.ok(Number.isNaN(parseUncertaintyMs('-10')));
});

test('插值区间按区间算术在线性过渡两端误差', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 0, uncertaintyMs: 100 },
    { local: 10000, ref: 10000, uncertaintyMs: 300 },
  ]);
  // 中点：中心 5000，误差 (100+300)/2 = 200
  const mid = correctTime(5000, anchors);
  assert.equal(mid.corrected, 5000);
  assert.equal(mid.earliest, 4800);
  assert.equal(mid.latest, 5200);
  // 四分之一点：误差 0.75*100 + 0.25*300 = 150
  const q1 = correctTime(2500, anchors);
  assert.equal(q1.earliest, 2350);
  assert.equal(q1.latest, 2650);
  // 锚点本身：只取该锚点自己的误差
  assert.deepEqual(
    [correctTime(0, anchors).earliest, correctTime(0, anchors).latest],
    [-100, 100]
  );
});

test('外推区间按系数绝对值放大误差', () => {
  const anchors = normalizeAnchors([
    { local: 0, ref: 1000, uncertaintyMs: 100 },
    { local: 10000, ref: 11000, uncertaintyMs: 100 },
  ]);
  // localMs=20000：ratio=2，中心 21000，误差 |1-2|*100 + 2*100 = 300
  const after = correctTime(20000, anchors);
  assert.equal(after.corrected, 21000);
  assert.equal(after.earliest, 20700);
  assert.equal(after.latest, 21300);
  assert.equal(after.extrapolated, 'after');
  // localMs=-5000：ratio=-0.5，中心 -4000，误差 1.5*100 + 0.5*100 = 200
  const before = correctTime(-5000, anchors);
  assert.equal(before.earliest, -4200);
  assert.equal(before.latest, -3800);
  assert.equal(before.extrapolated, 'before');
});

test('parseAnchorText 第三列可选：空白按 0，坏值定位到行', () => {
  const text = [
    '# 注释行',
    '0, 1000',
    '10000, 11000, 50',
    '20000, 21000, ',
    '30000, 31000, -5',
    '40000, 41000, nope',
    '50000, 51000, 9, 9',
  ].join('\n');
  const { anchors, errors } = parseAnchorText(text);
  assert.equal(anchors.length, 3);
  assert.deepEqual(
    anchors.map((a) => a.uncertaintyMs),
    [0, 50, 0]
  );
  assert.deepEqual(
    errors.map((e) => e.line),
    [5, 6, 7]
  );
});

test('mergeTimeline 标记相邻区间相交事件为顺序不确定', () => {
  const merged = mergeTimeline([
    {
      name: 'dev-A',
      anchors: [{ local: 0, ref: 0, uncertaintyMs: 100 }],
      events: [{ ts: 1000, msg: 'a1' }, { ts: 5000, msg: 'a2' }],
    },
    {
      name: 'dev-B',
      anchors: [{ local: 0, ref: 1050, uncertaintyMs: 100 }],
      events: [{ ts: 0, msg: 'b1' }],
    },
  ]);
  // 中心序：a1=1000, b1=1050（区间 [950,1150] 相交），a2=5000
  assert.equal(merged.orderUncertainCount, 2);
  assert.equal(merged.timeline[0].orderUncertain, true);
  assert.equal(merged.timeline[1].orderUncertain, true);
  assert.equal(merged.timeline[2].orderUncertain, false);
});

test('区间仅端点相切也算顺序不确定；误差为 0 且不重合则确定', () => {
  // a1 零误差区间退化为点 1000；b1 区间 [1000,1200]，在端点 1000 相切
  const merged = mergeTimeline([
    {
      name: 'dev-A',
      anchors: [{ local: 0, ref: 0 }],
      events: [{ ts: 1000, msg: 'a1' }],
    },
    {
      name: 'dev-B',
      anchors: [{ local: 0, ref: 1100, uncertaintyMs: 100 }],
      events: [{ ts: 0, msg: 'b1' }],
    },
  ]);
  assert.equal(merged.orderUncertainCount, 2);

  // 零误差、中心不同 => 顺序确定
  const exact = mergeTimeline([
    { name: 'a', anchors: [{ local: 0, ref: 0 }], events: [{ ts: 1000 }] },
    { name: 'b', anchors: [{ local: 0, ref: 2000 }], events: [{ ts: 0 }] },
  ]);
  assert.equal(exact.orderUncertainCount, 0);
});

test('toJsonl 包含校正区间与顺序不确定标记', () => {
  const merged = mergeTimeline([
    {
      name: 'dev',
      anchors: [{ local: 0, ref: 0, uncertaintyMs: 10 }],
      events: [{ ts: 0, msg: 'x' }],
    },
  ]);
  const obj = JSON.parse(toJsonl(merged).split('\n')[0]);
  assert.equal(obj.earliestTimeMs, -10);
  assert.equal(obj.latestTimeMs, 10);
  assert.equal(obj.uncertaintyMs, 10);
  assert.equal(obj.orderUncertain, false);
  assert.equal(obj.earliestTime, new Date(-10).toISOString());
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
