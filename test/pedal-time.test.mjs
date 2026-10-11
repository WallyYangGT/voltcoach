/**
 * pedal-time.test.mjs — 踩踏时间分解测试（node:test）
 *
 * 覆盖：三桶划分（踩踏/滑行/静止）、速度阈值边界（=阈值判滑行）、速度缺失判静止、
 * 无功率秒不计入分母、全程无功率返回 null、指标格装配（占比舍入 + 时长钟面）、
 * 静止段识别（30s 起标/断段/速度缺失）、formatAnomaly stationary 双语渲染。
 * 口径见 src/core/pedalTime.ts（0W 根治：pedal_time 进 summary 喂 AI + 静止段异常，
 * 数值口径不变只做披露）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pedalTimeBreakdown, detectStationarySpans } from '../src/core/pedalTime.ts';
import { buildPedalTimeMetrics } from '../src/core/metrics.ts';
import { formatAnomaly } from '../src/core/i18n.ts';
import { DATA_QUALITY } from '../src/core/settings.ts';

/** 逐秒记录夹具（只带分解用到的字段） */
const sec = (power, speed, i = 0) => ({
  timestamp: `2026-10-11T00:00:${String(i % 60).padStart(2, '0')}Z`,
  power,
  speed,
});

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

// ---------------- 静止段识别与异常渲染（0W 根治：stationary 进 anomalies） ----------------

test('detectStationarySpans: 30s 起标、29s 不标（stationary_min_sec 边界）', () => {
  const short = Array.from({ length: 29 }, (_, i) => sec(0, 0.5, i));
  const long = Array.from({ length: 30 }, (_, i) => sec(0, 0.5, i));
  assert.deepEqual(detectStationarySpans(short), []);
  assert.deepEqual(detectStationarySpans(long), [
    { type: 'stationary', duration_sec: 30, at: '2026-10-11T00:00:00Z' },
  ]);
});

test('detectStationarySpans: 踩踏/滑行秒断开静止段；速度缺失计入静止；正常骑行不标', () => {
  const recs = [
    ...Array.from({ length: 30 }, (_, i) => sec(0, 0.5, i)), // 静止 30s → 标
    sec(200, 25, 30), // 踩踏断开
    ...Array.from({ length: 29 }, (_, i) => sec(0, 0.2, 31 + i)), // 静止 29s → 不标
    sec(0, 25, 60), // 滑行断开
    ...Array.from({ length: 31 }, (_, i) => sec(0, null, 61 + i)), // 静止（速度缺失）31s → 标
  ];
  const spans = detectStationarySpans(recs);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].duration_sec, 30);
  assert.equal(spans[1].duration_sec, 31);
  // 夹具 timestamp 按 60s 取模回绕：i=61 → :01
  assert.equal(spans[1].at, '2026-10-11T00:00:01Z');
  // 全程正常骑行：无标注
  assert.deepEqual(
    detectStationarySpans(Array.from({ length: 120 }, (_, i) => sec(i % 40 ? 200 : 0, 25, i))),
    [],
  );
});

test('formatAnomaly: stationary 按语言渲染（zh/en），旧字符串透传不受影响', () => {
  const a = { type: 'stationary', duration_sec: 90, at: '2026-10-11T00:05:00Z' };
  assert.equal(formatAnomaly(a, 'zh'), '计时未停的静止 90s，起始 2026-10-11T00:05:00Z');
  assert.equal(formatAnomaly(a, 'en'), 'Stationary with the timer running 90s, at 2026-10-11T00:05:00Z');
  assert.equal(formatAnomaly('旧格式字符串', 'zh'), '旧格式字符串');
});
