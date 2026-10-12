/**
 * reanalyze.test.mjs — rebuildSummaryFromRecords 回归测试（FTP/心率参数变更后的重建口径）。
 *
 * 核心断言（黄金对比）：records 经 CSV 无损往返后按新骑手参数重建的 summary，
 * 与 analyzeFile 直接用同参数分析同一份 FIT 的结果**整体 deepEqual**——重算字段
 * （IF/TSS/区间分布/ftp_estimate/w/kg/心率区间/间歇/踏频-功率）与原管线同源同值，
 * 继承字段（activity/峰曲线/爬升/异常等）本就参数无关。另覆盖幂等性与无功率运动分支。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { analyzeFile, recordsToCsv } = await import('../src/core/analyze.ts');
const { parseRecordsCsv } = await import('../src/core/records.ts');
const { rebuildSummaryFromRecords } = await import('../src/core/reanalyze.ts');
const { buildRideFit, buildRunFit } = await import('./make_test_fit.mjs');

const ATHLETE_A = { ftp_watts: 200, max_hr: 190, weight_kg: 60 };
const ATHLETE_B = { ftp_watts: 250, max_hr: 200, weight_kg: 70 };

// 30min 骑行：10min 热身 150W + 2×5min @ 280W（对 A 是 140% FTP、对 B 是 112%，均过
// 1.05×FTP 阈值）+ 5min 恢复，间歇识别随 FTP 变化仍存在但 pct_ftp/组统计不同
const intervalPower = (sec) => {
  if (sec < 600) return 150;
  if (sec < 900 || (sec >= 1200 && sec < 1500)) return 280;
  return 150;
};
const rideBytes = () => buildRideFit({ power: intervalPower, heartRate: (i) => 130 + Math.round(i / 60) });

test('rebuildSummaryFromRecords: 按新参数重建 == analyzeFile 同参数直算（整体黄金对比）', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  const { summary: expected } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_B });

  // 前置：这份 FIT 对两个参数都识别出间歇（否则断言失去针对性）
  assert.ok(prev.interval_set && expected.interval_set);
  assert.notEqual(prev.power.tss, expected.power.tss); // FTP 变了 TSS 必变

  // CSV 无损往返（与设备侧 loadStoredRecords 同口径）
  const roundTripped = parseRecordsCsv(recordsToCsv(records));
  const rebuilt = rebuildSummaryFromRecords(roundTripped, prev, ATHLETE_B);

  assert.deepEqual(rebuilt, expected);
  // 关键字段抽查（整体对比的语义说明）
  assert.equal(rebuilt.power.tss, expected.power.tss);
  assert.equal(rebuilt.power.intensity_factor, expected.power.intensity_factor);
  assert.deepEqual(rebuilt.power.zone_distribution_pct, expected.power.zone_distribution_pct);
  assert.deepEqual(rebuilt.power.ftp_estimate, expected.power.ftp_estimate);
  assert.equal(rebuilt.power.w_per_kg_avg, expected.power.w_per_kg_avg);
  assert.deepEqual(rebuilt.heart_rate.zone_distribution_pct, expected.heart_rate.zone_distribution_pct);
  assert.deepEqual(rebuilt.interval_set, expected.interval_set);
  assert.deepEqual(rebuilt.cadence_power, expected.cadence_power);
});

test('rebuildSummaryFromRecords: 间歇 pct_ftp 与组统计确实随 FTP 变化', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  const rebuilt = rebuildSummaryFromRecords(parseRecordsCsv(recordsToCsv(records)), prev, ATHLETE_B);

  // lap 段保留在前（继承），间歇段跟随
  const intervals = rebuilt.segments.filter((s) => 'pct_ftp' in s);
  assert.equal(intervals.length, prev.segments.filter((s) => 'pct_ftp' in s).length);
  // 280W / 新 FTP 250 = 112%
  assert.equal(intervals[0].pct_ftp, 112);
  assert.equal(rebuilt.interval_set.avg_pct_ftp, 112);
});

test('rebuildSummaryFromRecords: 参数不变时幂等（重建 == 原 summary）', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  const rebuilt = rebuildSummaryFromRecords(parseRecordsCsv(recordsToCsv(records)), prev, ATHLETE_A);
  assert.deepEqual(rebuilt, prev);
});

test('rebuildSummaryFromRecords: 无功率运动（跑步）只重心率区间，不生成功率块', async () => {
  const bytes = buildRunFit({ heartRate: (i) => (i < 600 ? 140 : 165) });
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'run.fit', athlete: ATHLETE_A });
  assert.equal(prev.power, undefined); // 前置：跑步无功率段
  const { summary: expected } = await analyzeFile({ bytes, fileName: 'run.fit', athlete: ATHLETE_B });

  const rebuilt = rebuildSummaryFromRecords(parseRecordsCsv(recordsToCsv(records)), prev, ATHLETE_B);
  assert.deepEqual(rebuilt, expected);
  assert.equal(rebuilt.power, undefined);
  assert.deepEqual(rebuilt.heart_rate.zone_distribution_pct, expected.heart_rate.zone_distribution_pct);
});

test('rebuildSummaryFromRecords: prev 带 form/category/note 时保留并覆盖三参数', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  // 模拟 db 层 getActivitySummary 的合并形态（form 注入 + 分类/备注合并）
  const stored = JSON.parse(JSON.stringify(prev));
  Object.assign(stored.athlete_context, { ctl: 41.3, atl: 55.2, tsb: -13.9, form_state: 'fatigued', form_note: 'x' });
  stored.activity.category = 'training';
  stored.activity.note = '体感不错';

  const rebuilt = rebuildSummaryFromRecords(parseRecordsCsv(recordsToCsv(records)), stored, ATHLETE_B);
  assert.equal(rebuilt.athlete_context.ftp_watts, 250);
  assert.equal(rebuilt.athlete_context.max_hr, 200);
  assert.equal(rebuilt.athlete_context.weight_kg, 70);
  // form 字段随 prev 带入（服务层入库后会两段式重注为新 TSS 口径）
  assert.equal(rebuilt.athlete_context.tsb, -13.9);
  assert.equal(rebuilt.activity.category, 'training');
  assert.equal(rebuilt.activity.note, '体感不错');
});

test('rebuildSummaryFromRecords: 0W 披露字段回填——存量 summary 缺 pedal_time/stationary 时按 records 补算且幂等', async () => {
  // 1200s 骑行含 90s 计时未停静止段（0W/速度 0）
  const bytes = buildRideFit({
    durationSec: 1200,
    altitude: 100,
    power: (i) => (i >= 900 && i < 990 ? 0 : 220),
    speedMS: (i) => (i >= 900 && i < 990 ? 0 : 10),
  });
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'legacy.fit', athlete: ATHLETE_A });
  assert.ok(prev.pedal_time); // 前置：新代码产出的 summary 自带披露字段

  // 模拟存量行（升级前入库）：剥掉 pedal_time 与 stationary 条目
  const legacy = JSON.parse(JSON.stringify(prev));
  delete legacy.pedal_time;
  legacy.anomalies = (legacy.anomalies ?? []).filter((a) => a.type !== 'stationary');

  const roundTripped = parseRecordsCsv(recordsToCsv(records));
  const rebuilt = rebuildSummaryFromRecords(roundTripped, legacy, ATHLETE_A);
  assert.deepEqual(rebuilt.pedal_time, {
    sample_sec: 1200,
    pedaling_sec: 1110,
    coasting_sec: 0,
    stationary_sec: 90,
  });
  assert.deepEqual(
    (rebuilt.anomalies ?? []).filter((a) => a.type === 'stationary'),
    [{ type: 'stationary', duration_sec: 90, at: '2024-01-15T10:15:00.000Z' }],
  );
  // 重复触发幂等（对已回填的 summary 再重建不产生重复条目）
  const again = rebuildSummaryFromRecords(roundTripped, rebuilt, ATHLETE_A);
  assert.deepEqual(
    (again.anomalies ?? []).filter((a) => a.type === 'stationary'),
    (rebuilt.anomalies ?? []).filter((a) => a.type === 'stationary'),
  );
  assert.deepEqual(again.pedal_time, rebuilt.pedal_time);
});

// ---------------- 功率缩放（校准口径） ----------------

// 1.5 在 IEEE754 精确表示，150/280 × 1.5 均为整数——缩放记录与直跑 FIT 逐字节同源
const SCALE = 1.5;

test('rebuildSummaryFromRecords: powerScale 黄金对比——缩放重建 == analyzeFile 直跑 s×功率 FIT', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  const scaledBytes = buildRideFit({ power: (i) => intervalPower(i) * SCALE, heartRate: (i) => 130 + Math.round(i / 60) });
  const { summary: expected } = await analyzeFile({ bytes: scaledBytes, fileName: 'ride.fit', athlete: ATHLETE_A });

  const rebuilt = rebuildSummaryFromRecords(
    parseRecordsCsv(recordsToCsv(records)),
    prev,
    ATHLETE_A,
    { powerScale: SCALE },
  );
  // 缩放重建与"同参数直跑放大后的 FIT"整体一致（NP/avg/max/VI/峰曲线/IF/TSS/区间/间歇/踏频-功率全在重算集）
  assert.deepEqual(rebuilt, expected);
});

test('rebuildSummaryFromRecords: powerScale 数学性质——NP 线性、TSS 平方、峰曲线线性', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  const rebuilt = rebuildSummaryFromRecords(
    parseRecordsCsv(recordsToCsv(records)),
    prev,
    ATHLETE_A,
    { powerScale: SCALE },
  );
  // NP/峰功率对 scale 线性（两侧各有一次取整，容差 ±1W）
  assert.ok(Math.abs(rebuilt.power.normalized_power - prev.power.normalized_power * SCALE) <= 1);
  assert.ok(Math.abs(rebuilt.power.avg - prev.power.avg * SCALE) <= 1);
  assert.ok(Math.abs(rebuilt.power.peak_curve['20min'] - prev.power.peak_curve['20min'] * SCALE) <= 1);
  // TSS ∝ scale²（IF 与 NP 同步线性 → IF² 即平方关系，容差 ±2）
  assert.ok(Math.abs(rebuilt.power.tss - prev.power.tss * SCALE * SCALE) <= 2);
  // VI 不变（NP 与 avg 同比例缩放）
  assert.equal(rebuilt.power.variability_index, prev.power.variability_index);
});

test('rebuildSummaryFromRecords: 非法 powerScale（0/负数/NaN/1）按未缩放处理', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  const rt = parseRecordsCsv(recordsToCsv(records));
  for (const bad of [0, -1.2, NaN, Infinity, 1]) {
    const rebuilt = rebuildSummaryFromRecords(rt, prev, ATHLETE_A, { powerScale: bad });
    assert.deepEqual(rebuilt, prev, `powerScale=${bad} 应等价于不缩放`);
  }
});

test('rebuildSummaryFromRecords: powerScale 爬坡段 avg_power 线性换算、段边界不变', async () => {
  const bytes = rideBytes();
  const { records, summary: prev } = await analyzeFile({ bytes, fileName: 'ride.fit', athlete: ATHLETE_A });
  const withClimb = {
    ...JSON.parse(JSON.stringify(prev)),
    climbs: [{
      name: '测试坡', start: '2024-01-15T10:10:00.000Z', duration_sec: 600,
      distance_m: 3000, elevation_gain_m: 120, avg_grade_pct: 4,
      avg_power: 200, avg_hr: 150,
    }],
  };
  const rebuilt = rebuildSummaryFromRecords(
    parseRecordsCsv(recordsToCsv(records)),
    withClimb,
    ATHLETE_A,
    { powerScale: 0.5 },
  );
  assert.equal(rebuilt.climbs[0].avg_power, 100);
  assert.equal(rebuilt.climbs[0].avg_grade_pct, 4); // 边界/坡度字段不动
  assert.equal(rebuilt.climbs[0].elevation_gain_m, 120);
});
