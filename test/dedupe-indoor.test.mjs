/**
 * dedupe-indoor.test.mjs — 室内骑行判重的全链路回归（合成 FIT → analyzeFile → 指纹）
 *
 * 真实室内 FIT 常没有距离字段（record.distance / session.total_distance 缺失）。
 * 这里用 make_test_fit 造「cycling + 无距离」文件，走 analyzeFile 全链路验证：
 * records 首帧起骑时刻进入指纹后，同趟骑行判重、不同场次不误合、0 距离与 null
 * 距离互判。核心纯函数断言见 dedupe.test.mjs；本文件钉住「解析产物 → 指纹」的接线。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFile } from '../src/core/analyze.ts';
import { isSameRide } from '../src/core/dedupe.ts';
import { buildRideFit } from './make_test_fit.mjs';

const ATHLETE = { ftp_watts: 200, max_hr: 190, weight_kg: 70 };
const START = Date.UTC(2026, 4, 20, 10, 0, 0);

/** 合成室内骑行 → 解析 → 判重键（start_at 取 records 首帧，与 importFit 同口径） */
async function indoorKey(opts = {}) {
  const bytes = buildRideFit({
    startMs: START,
    durationSec: 1800,
    speedMS: () => null, // record/session/lap 都不写距离（典型室内骑行）
    ...opts,
  });
  const { records, summary } = await analyzeFile({ bytes, fileName: 'indoor.fit', athlete: ATHLETE });
  return {
    summary,
    key: {
      date: summary.activity.date,
      duration_sec: summary.activity.duration_sec,
      distance_km: summary.activity.distance_km,
      sport: summary.activity.sport,
      start_at: records[0]?.timestamp ?? null,
    },
  };
}

test('室内 FIT 解析出 null 距离与首帧起骑时刻', async () => {
  const { summary, key } = await indoorKey();
  assert.equal(summary.activity.distance_km, null);
  assert.equal(key.distance_km, null);
  assert.equal(key.sport, 'cycling');
  assert.equal(key.start_at, new Date(START).toISOString());
});

test('同一室内课的两个异名文件判重（起骑时刻一致）', async () => {
  const a = await indoorKey();
  const b = await indoorKey();
  assert.equal(isSameRide(a.key, b.key), true);
});

test('同一天另一场室内课（起骑时刻不同）不判重', async () => {
  const a = await indoorKey();
  const b = await indoorKey({ startMs: START + 3 * 3600_000 });
  assert.equal(isSameRide(a.key, b.key), false);
});

test('0 距离与 null 距离视为同一类（同起骑时刻判重）', async () => {
  const nullDist = await indoorKey();
  const zeroDist = await indoorKey({ speedMS: () => 0 });
  assert.equal(zeroDist.summary.activity.distance_km, 0);
  assert.equal(isSameRide(nullDist.key, zeroDist.key), true);
});

test('起骑时刻跨源转码按分钟舍入（±60s）仍判重', async () => {
  const a = await indoorKey();
  const rounded = { ...a.key, start_at: new Date(START + 45_000).toISOString() };
  assert.equal(isSameRide(a.key, rounded), true);
  const tooFar = { ...a.key, start_at: new Date(START + 61_000).toISOString() };
  assert.equal(isSameRide(a.key, tooFar), false);
});
