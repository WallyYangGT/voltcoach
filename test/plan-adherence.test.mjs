/**
 * plan-adherence.test.mjs — 计划执行情况纯函数测试（node:test，U1 收尾②）
 *
 * 覆盖：三态判定（完成/降强完成/未做）与 done_ratio 边界、未来与「今天未练」不评
 * （pending）、「今天已练」按实际判、无课/显式 rest 日不评（status=null）、计划 TSS
 * 缺失经 resolvePlanTss 回填再比、实际多日归并（同日多骑 TSS 相加）。
 * 阈值断言相对 PLAN_ADHERENCE 现算（时区无关）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAdherence } from '../src/core/plan-adherence.ts';
import { PLAN_ADHERENCE } from '../src/core/settings.ts';

const TODAY = '2026-10-13'; // 周二

const session = (date, type = 'endurance', duration_min = 60, tss = null, extra = {}) => ({
  date,
  type,
  duration_min,
  intensity: null,
  tss,
  note: null,
  ...extra,
});

const actual = (date, tss, durationSec = 3600) => ({ date, tss, durationSec });

test('三态判定：完成 / 降强完成 / 未做', () => {
  const sessions = [
    session('2026-10-12', 'threshold', 60, 80), // 周一：完成
    session('2026-10-11', 'endurance', 60, 60), // 周日：降强
    session('2026-10-10', 'sweet_spot', 60, 70), // 周六：未做
  ];
  const rows = computeAdherence(
    sessions,
    [actual('2026-10-12', 80), actual('2026-10-11', 30)],
    TODAY,
  );
  const byDate = Object.fromEntries(rows.map((r) => [r.date, r]));
  assert.equal(byDate['2026-10-12'].status, 'done'); // 80 ≥ 80×0.8
  assert.equal(byDate['2026-10-11'].status, 'partial'); // 30 > 0 但 < 60×0.8
  assert.equal(byDate['2026-10-10'].status, 'missed'); // 已过且 0
});

test('done_ratio 边界：恰在系数上为完成，其下为降强', () => {
  const sessions = [session('2026-10-12', 'threshold', 60, 100)];
  const edge = computeAdherence(sessions, [actual('2026-10-12', 100 * PLAN_ADHERENCE.done_ratio)], TODAY);
  assert.equal(edge[0].status, 'done');
  const below = computeAdherence(sessions, [actual('2026-10-12', 100 * PLAN_ADHERENCE.done_ratio - 1)], TODAY);
  assert.equal(below[0].status, 'partial');
});

test('未来与今天未练不评（pending）；今天练了按实际判', () => {
  const sessions = [
    session('2026-10-14', 'threshold', 60, 80), // 明天
    session('2026-10-13', 'endurance', 60, 60), // 今天
  ];
  const pending = computeAdherence(sessions, [], TODAY);
  const byDate = Object.fromEntries(pending.map((r) => [r.date, r]));
  assert.equal(byDate['2026-10-14'].status, 'pending');
  assert.equal(byDate['2026-10-13'].status, 'pending'); // 今天还没练

  const doneToday = computeAdherence(sessions, [actual('2026-10-13', 50)], TODAY);
  assert.equal(doneToday.find((r) => r.date === TODAY).status, 'done');
});

test('无课日不进结果；显式 rest 日进结果但不评（status=null）', () => {
  const sessions = [
    session('2026-10-12', 'threshold', 60, 80),
    session('2026-10-13', 'rest', null, 0), // 显式休息
  ];
  const rows = computeAdherence(sessions, [], TODAY);
  assert.equal(rows.length, 2); // 只展开有课的日期（无课日不进）
  const rest = rows.find((r) => r.date === TODAY);
  assert.equal(rest.status, null);
  assert.equal(rest.plannedTss, 0);
  assert.equal(rest.plannedMin, null);
});

test('计划 TSS 缺失经 resolvePlanTss 回填后再比（时长×IF² 估算）', () => {
  // endurance 60min → 60×60×0.68²/36 ≈ 46.2
  const rows = computeAdherence([session('2026-10-12', 'endurance', 60, null)], [actual('2026-10-12', 20)], TODAY);
  assert.equal(rows[0].plannedTss, 46.2);
  assert.equal(rows[0].status, 'partial');
});

test('同日多骑归并后合计判定（调用方归并，本层只收合计）', () => {
  const rows = computeAdherence(
    [session('2026-10-12', 'endurance', 120, 92)],
    [actual('2026-10-12', 50, 1800), actual('2026-10-12', 45, 3600)],
    TODAY,
  );
  assert.equal(rows[0].actualTss, 95);
  assert.equal(rows[0].actualMin, 90);
  assert.equal(rows[0].status, 'done');
});

test('实际时长取整展示（秒 → 分钟）', () => {
  const rows = computeAdherence([session('2026-10-12', 'endurance', 60, 46)], [actual('2026-10-12', 40, 3725)], TODAY);
  assert.equal(rows[0].actualMin, 62);
});
