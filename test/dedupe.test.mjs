/**
 * dedupe.test.mjs — 同趟骑行内容指纹判定测试（node:test）
 *
 * 覆盖：日期不等/时长超容差/距离超容差不判重、容差边界（含闭区间）、距离或时长
 * 缺失时保守不判重、室内骑行（无有效距离 → 起骑时刻 ±60s）、并查集链式分组、
 * 非重复行不进入分组结果。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicateGroups,
  findDuplicateOf,
  hasPositiveDistance,
  isSameRide,
  RIDE_DISTANCE_TOLERANCE_KM,
  RIDE_DURATION_TOLERANCE_SEC,
  RIDE_START_TOLERANCE_SEC,
} from '../src/core/dedupe.ts';

/** 骑行键夹具（默认：2026-09-20 的一趟 1 小时 / 30km 骑行） */
const ride = (overrides = {}) => ({
  date: '2026-09-20',
  duration_sec: 3600,
  distance_km: 30,
  ...overrides,
});

test('isSameRide: 内容完全一致判为同一趟骑行', () => {
  assert.equal(isSameRide(ride(), ride()), true);
});

test('isSameRide: 日期不同即使时长距离一致也不判重', () => {
  assert.equal(isSameRide(ride(), ride({ date: '2026-09-21' })), false);
});

test('isSameRide: 时长容差为闭区间（±2s 内判重，超出不判）', () => {
  assert.equal(isSameRide(ride(), ride({ duration_sec: 3600 + RIDE_DURATION_TOLERANCE_SEC })), true);
  assert.equal(isSameRide(ride(), ride({ duration_sec: 3600 - RIDE_DURATION_TOLERANCE_SEC })), true);
  assert.equal(isSameRide(ride(), ride({ duration_sec: 3600 + RIDE_DURATION_TOLERANCE_SEC + 1 })), false);
  assert.equal(isSameRide(ride(), ride({ duration_sec: 3599 })), true); // 服务端转码的末秒差异
  assert.equal(isSameRide(ride(), ride({ duration_sec: 3000 })), false);
});

test('isSameRide: 距离容差为闭区间（±0.05km 内判重，超出不判）', () => {
  assert.equal(isSameRide(ride(), ride({ distance_km: 30 + RIDE_DISTANCE_TOLERANCE_KM })), true);
  assert.equal(isSameRide(ride(), ride({ distance_km: 30.06 })), false);
  assert.equal(isSameRide(ride(), ride({ distance_km: 30.01 })), true);
});

test('isSameRide: 时长缺失/无起骑时刻的无距离记录不判重（宁可漏合也不误合）', () => {
  // 两侧都无有效距离但都没有起骑时刻 → 室内指纹不完整，保守不判重
  assert.equal(isSameRide(ride({ distance_km: null }), ride({ distance_km: null })), false);
  assert.equal(isSameRide(ride({ distance_km: null }), ride({ distance_km: null, start_at: '2026-09-20T10:00:00Z' })), false);
  assert.equal(isSameRide(ride({ distance_km: null }), ride()), false); // 一侧有距离
  assert.equal(isSameRide(ride({ duration_sec: null }), ride({ duration_sec: null })), false);
  assert.equal(isSameRide(ride({ duration_sec: null }), ride()), false);
});

test('hasPositiveDistance：null/0/负数一律视为无有效距离', () => {
  assert.equal(hasPositiveDistance(null), false);
  assert.equal(hasPositiveDistance(undefined), false);
  assert.equal(hasPositiveDistance(0), false);
  assert.equal(hasPositiveDistance(-1), false);
  assert.equal(hasPositiveDistance(0.01), true);
  assert.equal(hasPositiveDistance(30), true);
});

// ---------------- 室内骑行（无有效距离）判重：起骑时刻 ±60s ----------------

const INDOOR_START = '2026-09-20T10:00:00.000Z';
const indoor = (overrides = {}) => ({
  date: '2026-09-20',
  duration_sec: 3600,
  distance_km: null,
  sport: 'cycling',
  start_at: INDOOR_START,
  ...overrides,
});

test('室内指纹：null/null、0/0、null/0 在起骑时刻 ±60s 内判重', () => {
  assert.equal(isSameRide(indoor(), indoor()), true);
  assert.equal(isSameRide(indoor({ distance_km: 0 }), indoor({ distance_km: 0 })), true);
  assert.equal(isSameRide(indoor({ distance_km: null }), indoor({ distance_km: 0 })), true);
});

test('室内指纹：起骑时刻容差为闭区间 ±60s，超出不判', () => {
  const shifted = (sec) => new Date(Date.parse(INDOOR_START) + sec * 1000).toISOString();
  assert.equal(isSameRide(indoor(), indoor({ start_at: shifted(RIDE_START_TOLERANCE_SEC) })), true);
  assert.equal(isSameRide(indoor(), indoor({ start_at: shifted(-RIDE_START_TOLERANCE_SEC) })), true);
  assert.equal(isSameRide(indoor(), indoor({ start_at: shifted(RIDE_START_TOLERANCE_SEC + 1) })), false);
  assert.equal(isSameRide(indoor(), indoor({ start_at: shifted(-RIDE_START_TOLERANCE_SEC - 1) })), false);
});

test('室内指纹：同日期同时长但起骑时刻不同的两场课不误合（0 距离旧隐患修正）', () => {
  const later = '2026-09-20T18:00:00.000Z';
  assert.equal(isSameRide(indoor({ distance_km: 0 }), indoor({ distance_km: 0, start_at: later })), false);
  assert.equal(isSameRide(indoor(), indoor({ start_at: later })), false);
});

test('室内指纹：sport 已知且不同不判重；unknown/缺失不阻断', () => {
  assert.equal(isSameRide(indoor(), indoor({ sport: 'running' })), false);
  assert.equal(isSameRide(indoor(), indoor({ sport: 'unknown' })), true);
  assert.equal(isSameRide(indoor({ sport: null }), indoor({ sport: 'cycling' })), true);
});

test('室内指纹：时长超容差不判；一侧有距离一侧无也不判', () => {
  assert.equal(isSameRide(indoor(), indoor({ duration_sec: 3603 })), false);
  assert.equal(isSameRide(indoor(), indoor({ distance_km: 30 })), false);
  assert.equal(isSameRide(indoor({ distance_km: 0 }), indoor({ distance_km: 30 })), false);
});

test('室内指纹：非法起骑时刻不判重', () => {
  assert.equal(isSameRide(indoor({ start_at: 'not-a-date' }), indoor()), false);
});

test('findDuplicateGroups：室内重复组按起骑时刻归组', () => {
  const rows = [
    { file_name: 'a.fit', ...indoor() },
    { file_name: 'b.fit', ...indoor({ start_at: '2026-09-20T10:00:30.000Z' }) },
    { file_name: 'c.fit', ...indoor({ start_at: '2026-09-20T18:00:00.000Z' }) }, // 同日另一场
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((r) => r.file_name), ['a.fit', 'b.fit']);
});

test('findDuplicateOf：室内异名同起骑时刻让路，同名仍走 upsert', () => {
  const rows = [{ file_name: 'lib.fit', ...indoor() }];
  assert.equal(findDuplicateOf({ file_name: 'new.fit', ...indoor({ start_at: '2026-09-20T10:00:20Z' }) }, rows), 'lib.fit');
  assert.equal(findDuplicateOf({ file_name: 'lib.fit', ...indoor({ start_at: '2026-09-20T18:00:00Z' }) }, rows), null);
});

test('isSameRide: 空日期（未解析出行车时间）不判重', () => {
  assert.equal(isSameRide(ride({ date: '' }), ride({ date: '' })), false);
});

test('findDuplicateGroups: 只返回重复组，单条记录不出现', () => {
  const rows = [
    { file_name: 'a.fit', ...ride() },
    { file_name: 'b.fit', ...ride({ duration_sec: 3601, distance_km: 30.02 }) },
    { file_name: 'c.fit', ...ride({ date: '2026-09-18' }) },
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((r) => r.file_name), ['a.fit', 'b.fit']);
});

test('findDuplicateGroups: 链式相等归为同一组（并查集）', () => {
  // A≈B（时长差 2s）、B≈C（距离差 0.04）成立，但 A 与 C 直接比会超出距离容差
  const rows = [
    { file_name: 'a.fit', ...ride({ distance_km: 30.0 }) },
    { file_name: 'b.fit', ...ride({ duration_sec: 3598, distance_km: 30.04 }) },
    { file_name: 'c.fit', ...ride({ duration_sec: 3596, distance_km: 30.08 }) },
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((r) => r.file_name).sort(), ['a.fit', 'b.fit', 'c.fit']);
});

test('findDuplicateGroups: 无重复时返回空表', () => {
  const rows = [
    { file_name: 'a.fit', ...ride() },
    { file_name: 'b.fit', ...ride({ date: '2026-09-19' }) },
    { file_name: 'c.fit', ...ride({ duration_sec: 1800 }) },
  ];
  assert.deepEqual(findDuplicateGroups(rows), []);
  assert.deepEqual(findDuplicateGroups([]), []);
});

test('findDuplicateGroups: 多组重复分别成组且保持入参顺序', () => {
  const rows = [
    { file_name: 'd1.fit', ...ride({ date: '2026-09-10' }) },
    { file_name: 'x.fit', ...ride({ date: '2026-09-11' }) },
    { file_name: 'd2.fit', ...ride({ date: '2026-09-10' }) },
    { file_name: 'd3.fit', ...ride({ date: '2026-09-10' }) },
    { file_name: 'e1.fit', ...ride({ date: '2026-09-12', duration_sec: 7200, distance_km: 60 }) },
    { file_name: 'e2.fit', ...ride({ date: '2026-09-12', duration_sec: 7200, distance_km: 60.01 }) },
  ];
  const groups = findDuplicateGroups(rows);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((r) => r.file_name), ['d1.fit', 'd2.fit', 'd3.fit']);
  assert.deepEqual(groups[1].map((r) => r.file_name), ['e1.fit', 'e2.fit']);
});

test('findDuplicateOf: 异名同指纹命中，返回库内已有的文件名', () => {
  const rows = [{ file_name: '云端名.fit', ...ride() }];
  assert.equal(findDuplicateOf({ file_name: '本地名.fit', ...ride() }, rows), '云端名.fit');
  // 不同趟骑行（日期/时长/距离不在容差内）不拦
  assert.equal(findDuplicateOf({ file_name: '新.fit', ...ride({ date: '2026-09-19' }) }, rows), null);
  assert.equal(findDuplicateOf({ file_name: '新.fit', ...ride({ duration_sec: 1800 }) }, rows), null);
  assert.equal(findDuplicateOf({ file_name: '新.fit', ...ride() }, []), null);
});

test('findDuplicateOf: 同名优先走 upsert 覆盖，不被异名副本顶掉', () => {
  // 库里同时有手动导入的同名行与云同步副本（本 feature 要解决的并存态）
  const rows = [
    { file_name: 'ride.fit', ...ride() },
    { file_name: 'mock-ride.fit', ...ride({ duration_sec: 3599 }) },
  ];
  // 再次导入 ride.fit：必须返回 null（走 upsert 更新），而不是指向 mock-ride.fit 被跳过
  assert.equal(findDuplicateOf({ file_name: 'ride.fit', ...ride() }, rows), null);
  // 导入第三个异名副本：仍按重复拦下（让用户去数据管理页合并，而不是越积越多）
  assert.equal(findDuplicateOf({ file_name: 'third.fit', ...ride() }, rows), 'ride.fit');
});
