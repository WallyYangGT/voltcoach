/**
 * pedal-time.test.mjs — 踩踏时间分解测试（node:test）
 *
 * 覆盖：三桶划分（踩踏/滑行/静止）、速度阈值边界（=阈值判滑行）、速度缺失判静止、
 * 无功率秒不计入分母、全程无功率返回 null、指标格装配（占比舍入 + 时长钟面）。
 * 口径见 src/core/pedalTime.ts（展示层，不进 summary 不喂 AI）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pedalTimeBreakdown } from '../src/core/pedalTime.ts';
import { buildPedalTimeMetrics } from '../src/core/metrics.ts';
import { DATA_QUALITY } from '../src/core/settings.ts';

/** 逐秒记录夹具（只带分解用到的字段） */
const sec = (power, speed) => ({ timestamp: '2026-10-11T00:00:00Z', power, speed });

test('三桶划分：踩踏 P>0 / 滑行 P=0 且移动 / 静止 P=0 且速度低于暂停阈值', () => {
  const b = pedalTimeBreakdown([
    sec(250, 30), // 踩踏
    sec(0, 25), // 滑行（0W 下坡）
    sec(0, 0.5), // 静止（计时未停）
    sec(120, 5), // 踩踏
  ]);
  assert.deepEqual(b, { sample_sec: 4, pedaling_sec: 2, coasting_sec: 1, stationary_sec: 1 });
});

test('速度阈值边界：speed 恰等于阈值判滑行（≥ 阈值即移动）', () => {
  const kmh = DATA_QUALITY.pause_resume_speed_kmh;
  const b = pedalTimeBreakdown([sec(0, kmh), sec(0, kmh - 0.1)]);
  assert.equal(b.coasting_sec, 1);
  assert.equal(b.stationary_sec, 1);
});

test('P=0 且速度缺失判静止（无速度可证仍在移动，向提示侧保守）', () => {
  const b = pedalTimeBreakdown([sec(0, null), sec(0, null), sec(100, null)]);
  assert.deepEqual(b, { sample_sec: 3, pedaling_sec: 1, coasting_sec: 0, stationary_sec: 2 });
});

test('无功率数据的秒不计入分母（保守口径，同踏频均值剔 0）', () => {
  const b = pedalTimeBreakdown([sec(null, 30), sec(200, 30), sec(null, 0), sec(0, 0.5)]);
  assert.deepEqual(b, { sample_sec: 2, pedaling_sec: 1, coasting_sec: 0, stationary_sec: 1 });
});

test('全程无功率数据返回 null（卡片隐藏，跑步/游泳场景）', () => {
  assert.equal(pedalTimeBreakdown([sec(null, 10), sec(null, 12)]), null);
  assert.equal(pedalTimeBreakdown([]), null);
});

test('buildPedalTimeMetrics：值=占比四舍五入，小字=时长钟面格式', () => {
  const b = { sample_sec: 3, pedaling_sec: 2, coasting_sec: 1, stationary_sec: 0 };
  const items = buildPedalTimeMetrics(b, (key) => key);
  assert.deepEqual(
    items.map((i) => i.value),
    ['67%', '33%', '0%'],
  );
  assert.deepEqual(
    items.map((i) => i.sub),
    ['0:02', '0:01', '0:00'],
  );
});
