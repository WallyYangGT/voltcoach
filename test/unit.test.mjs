/**
 * unit.test.mjs — 指标算法纯函数单元测试（node:test，Node ≥ 23.6 原生跑 TS）
 *
 * 断言搬运自 reference/test/unit.test.mjs（analyze 系；ftp/planning/prompts 的
 * 断言随对应模块在 M3 搬运时再迁入），另覆盖本仓库新增的分支：
 * 依赖注入参数、records CSV 序列化/抽稀、form 递推、数据层本地化。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizedPower,
  peakAvg,
  fillShortGaps,
  zoneDistribution,
  elevationGain,
  findPowerGaps,
  findMissingSpans,
  detectPauseSpans,
  estimateFtp,
  detectIntervals,
  hrDriftPct,
  collectDeveloperFields,
  recordsToCsv,
} from '../src/core/analyze.ts';
import { gzip } from 'pako';
import { parseRecordsCsv, thinRecords, safeName, firstTimestampFromCsvHead, firstRecordTimestampFromGz } from '../src/core/records.ts';
import { fillDailyTss, formSeriesDaily, formSnapshotAtEnd } from '../src/core/form.ts';
import { formNote, formatAnomaly } from '../src/core/i18n.ts';
import { estimateFtpFromHistory } from '../src/core/ftp.ts';
import { monthlySummaryFromRows } from '../src/core/monthly.ts';
import {
  buildActivityMetrics,
  buildCadenceMetrics,
  formatNum,
  formatDuration,
  formatDurationClock,
  formatPace,
  metricColumns,
} from '../src/core/metrics.ts';
import { ATHLETE } from '../src/core/settings.ts';

// 构造逐秒记录对象的辅助函数
const rec = (i, fields = {}) => ({
  timestamp: new Date(1700000000000 + i * 1000).toISOString(),
  power: null,
  heart_rate: null,
  cadence: null,
  altitude: null,
  speed: null,
  distance: null,
  ...fields,
});

test('normalizedPower: 恒定功率时 NP 等于该功率', () => {
  assert.equal(normalizedPower(Array(300).fill(200)), 200);
});

test('normalizedPower: 缺口窗口不参与计算', () => {
  // 中间一个 null：覆盖该秒的 30s 窗口被跳过，其余窗口仍为 200
  const arr = Array(300).fill(200);
  arr[150] = null;
  assert.equal(normalizedPower(arr), 200);
});

test('normalizedPower: 数据不足 30 秒返回 null', () => {
  assert.equal(normalizedPower(Array(29).fill(200)), null);
});

test('peakAvg: 递增序列取窗口最大值，要求窗口连续', () => {
  const arr = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  assert.equal(peakAvg(arr, 10), 96); // avg(91..100) = 95.5 → 96
  // 峰值窗口含 null 则该窗口被跳过：孤立尖峰被两个 null 夹住，
  // 任何覆盖尖峰的窗口都因不连续而被排除
  const withGap = Array(100).fill(100);
  withGap[45] = null;
  withGap[50] = 500;
  withGap[55] = null;
  assert.equal(peakAvg(withGap, 10), 100);
});

test('fillShortGaps: 短缺口按左右邻居线性插值', () => {
  const arr = [100, null, null, null, 160];
  assert.deepEqual(fillShortGaps(arr, 3), [100, 115, 130, 145, 160]);
  // 不改原数组
  assert.deepEqual(arr, [100, null, null, null, 160]);
});

test('fillShortGaps: 超长缺口与两端无邻居的 null 保持原样', () => {
  const longGap = [100, null, null, null, null, 200];
  assert.deepEqual(fillShortGaps(longGap, 3), longGap); // 4s 缺口 > 上限 3s
  const edges = [null, null, 100, 200, null];
  assert.deepEqual(fillShortGaps(edges, 10), edges); // 两端无邻居不补
});

test('fillShortGaps + peakAvg: 掉秒不再让 20min 峰功率整体作废', () => {
  // 1300 秒恒定 200W，中间掉 3 秒：原始序列无连续 20min 窗口，补齐后恢复
  const arr = Array(1300).fill(200);
  arr[600] = arr[601] = arr[602] = null;
  assert.equal(peakAvg(arr, 1200), null);
  assert.equal(peakAvg(fillShortGaps(arr, 10), 1200), 200);
});

test('zoneDistribution: 按基数比例分区并输出百分比', () => {
  const zones = [
    { name: 'L', min: 0, max: 0.5 },
    { name: 'H', min: 0.5, max: Infinity },
  ];
  assert.deepEqual(zoneDistribution([40, 60, null], zones, 100), {
    L: 50,
    H: 50,
  });
  assert.equal(zoneDistribution([null, null], zones, 100), null);
});

test('elevationGain: 1m 阈值去抖，小抖动不计爬升', () => {
  assert.equal(elevationGain([0, 0.4, 0.8, 1.2]), 1); // 累计 1.2m → 计 1.2 → 取整 1
  assert.equal(elevationGain([0, 0.3, 0, 0.3, 0]), 0); // 抖动被压掉
  // 100→110 计 10m，下降到 105 后 105→120 再计 15m，合计 25m
  assert.equal(elevationGain([null, 100, 110, 105, 120]), 25);
});

test('elevationGain: 滞回去抖按相邻增量累计，连续小步爬升不双计数', () => {
  // 5 步 × 0.2m = 1.0m 爬升：旧算法相对陈旧基线重复累计会虚报到 2.0m
  assert.equal(elevationGain([0, 0.2, 0.4, 0.6, 0.8, 1.0]), 1);
  // 长缓坡 50 步 × 0.2m = 10m：每满 1m 确认一次，合计恰为 10m
  const ramp = Array.from({ length: 51 }, (_, i) => 100 + i * 0.2);
  assert.equal(elevationGain(ramp), 10);
  // 平地上亚米级噪声（±0.2m 反复 600 秒）不产生爬升
  const flat = Array.from({ length: 600 }, (_, i) => (i % 2 ? 0.2 : -0.2));
  assert.equal(elevationGain(flat), 0);
});

test('detectPauseSpans: 静止恢复的间隙判为暂停，骑行中恢复仍为数据缺失', () => {
  // 200s：50-80s 全空（恢复后静止）→ 暂停；120-140s 全空（恢复时已在移动）→ 非暂停
  const records = [];
  for (let i = 0; i < 200; i++) {
    const empty = (i >= 50 && i < 80) || (i >= 120 && i < 140);
    records.push(
      rec(
        i,
        empty
          ? {}
          : { power: 200, heart_rate: 120, speed: i >= 80 && i < 140 ? 0 : 6 },
      ),
    );
  }
  const spans = detectPauseSpans(records, []);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].duration_sec, 30);
  assert.equal(spans[0].start, records[50].timestamp);
});

test('detectPauseSpans: 距离冻结判为暂停（恢复即起步），距离跳变仍为数据缺失', () => {
  // 30-60s 全空且恢复后立即起步（速度 8），但设备累计距离在两侧几乎不动 → 暂停；
  // 90-100s 全空且距离按骑行速度跳变 80m → 数据缺失
  const records = [];
  for (let i = 0; i < 120; i++) {
    if ((i >= 30 && i < 60) || (i >= 90 && i < 100)) {
      records.push(rec(i));
      continue;
    }
    const dist = i < 30 ? i * 8 : i < 90 ? 240 + (i - 60) * 2 : 378 + (i - 100) * 8;
    records.push(rec(i, { power: 200, heart_rate: 120, speed: 8, distance: dist }));
  }
  const spans = detectPauseSpans(records, []);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, records[30].timestamp);
  assert.equal(spans[0].duration_sec, 30);
});

test('detectPauseSpans: FIT timer 事件 stop_all→start 区间判为暂停', () => {
  // 100s 记录，30-60s 全空且恢复时已在移动；但事件表明 28s 停表、62s 恢复计时
  const t0 = 1700000000000;
  const records = Array.from({ length: 100 }, (_, i) =>
    rec(i, i >= 30 && i < 60 ? {} : { power: 200, heart_rate: 120, speed: 6 }),
  );
  const events = [
    { event: 'timer', event_type: 'stop_all', timestamp: new Date(t0 + 28000) },
    { event: 'timer', event_type: 'start', timestamp: new Date(t0 + 62000) },
  ];
  const spans = detectPauseSpans(records, events);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].duration_sec, 30);
  // 无事件时同一段恢复侧在移动 → 不判暂停
  assert.equal(detectPauseSpans(records, []).length, 0);
});

test('findPowerGaps: 只报告连续缺失超过阈值的片段', () => {
  const records = Array.from({ length: 200 }, (_, i) =>
    rec(i, { power: i >= 50 && i < 120 ? null : 200 }),
  );
  const gaps = findPowerGaps(records); // 默认 60s 阈值
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].duration_sec, 70);
  assert.equal(findPowerGaps(records, 80).length, 0);
});

test('findMissingSpans: 整条记录（全字段 null）缺失检测', () => {
  const records = Array.from({ length: 100 }, (_, i) =>
    i >= 30 && i < 45 ? rec(i) : rec(i, { power: 100, heart_rate: 120 }),
  );
  const spans = findMissingSpans(records, 10);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].duration_sec, 15);
  // 阈值大于缺失时长则不报告
  assert.equal(findMissingSpans(records, 20).length, 0);
});

test('estimateFtp: 20 分钟峰功率 × 0.95，并给出更新建议', () => {
  const est = estimateFtp(Array(1200).fill(200));
  assert.equal(est.peak_20min_w, 200);
  assert.equal(est.estimated_ftp_w, 190);
  assert.equal(est.current_ftp_w, ATHLETE.ftp_watts);
  assert.equal(est.suggestion, 'consider_update'); // 190 明显高于当前 106
  // 不足 20 分钟 → null
  assert.equal(estimateFtp(Array(1199).fill(200)), null);
  // 明显偏低 → 不建议直接下调
  assert.equal(estimateFtp(Array(1200).fill(60)).suggestion, 'consider_recheck');
});

test('estimateFtp: 依赖注入骑手参数——current_ftp_w 与建议随参数变化（App 层生效值口径）', () => {
  const est = estimateFtp(Array(1200).fill(200), { ftp_watts: 190, max_hr: 195, weight_kg: 60 });
  assert.equal(est.current_ftp_w, 190);
  assert.equal(est.suggestion, 'keep'); // |190-190| ≤ 3 → 保持
});

test('detectIntervals: 识别重复过阈工作段并给出组统计', () => {
  // 3×(120s @ 150W) 间歇，夹 120s @ 80W 恢复，前后各 60s 热身/放松
  const thr = ATHLETE.ftp_watts * 1.05;
  const records = [];
  const push = (n, power) => {
    for (let k = 0; k < n; k++)
      records.push(rec(records.length, { power, heart_rate: 140, cadence: 90 }));
  };
  push(60, 80);
  for (let s = 0; s < 3; s++) {
    push(120, 150);
    push(120, 80);
  }
  assert.ok(150 >= thr);
  const r = detectIntervals(records);
  assert.equal(r.intervals.length, 3);
  assert.equal(r.intervals[0].duration_sec, 120);
  assert.equal(r.intervals[0].avg_power, 150);
  assert.equal(r.interval_set.count, 3);
  // 全程低于阈值 → null
  const easy = Array.from({ length: 300 }, (_, i) => rec(i, { power: 80 }));
  assert.equal(detectIntervals(easy), null);
});

test('detectIntervals: 依赖注入骑手参数——阈值随 FTP 换档', () => {
  // FTP 200W → 阈值 210W，150W 段不再算间歇
  const records = Array.from({ length: 400 }, (_, i) => rec(i, { power: 150 }));
  assert.equal(detectIntervals(records, { ftp_watts: 200, max_hr: 195, weight_kg: 60 }), null);
});

test('hrDriftPct: 心率上升而输出不变时漂移为正（功率口径）', () => {
  const records = Array.from({ length: 600 }, (_, i) =>
    rec(i, { power: 200, heart_rate: i < 300 ? 130 : 140 }),
  );
  // ef1 = 200/130, ef2 = 200/140 → drift = 1 − 130/140 ≈ 7.1%
  assert.equal(hrDriftPct(records, 'power'), 7.1);
});

test('hrDriftPct: 支持速度口径（跑步无功率计）', () => {
  const records = Array.from({ length: 600 }, (_, i) =>
    rec(i, { speed: 12, heart_rate: i < 300 ? 140 : 150 }),
  );
  // drift = 1 − 140/150 ≈ 6.7%
  assert.equal(hrDriftPct(records, 'speed'), 6.7);
});

test('collectDeveloperFields: 只统计白名单外的数值字段', () => {
  const raw = [
    { timestamp: new Date(), power: 200, core_temperature: 38.5, note: 'x' },
    { timestamp: new Date(), power: 210, core_temperature: 39.5 },
    { timestamp: new Date(), power: 220 },
  ];
  const dev = collectDeveloperFields(raw);
  assert.deepEqual(dev, {
    core_temperature: { samples: 2, avg: 39, min: 38.5, max: 39.5 },
  });
  assert.equal(collectDeveloperFields([{ timestamp: new Date(), power: 1 }]), null);
});

// ---------------- 本仓库新增：records 序列化与抽稀 ----------------

test('recordsToCsv/parseRecordsCsv: 逐秒记录 ↔ CSV 文本往返一致（列序与旧版逐字一致）', () => {
  const records = [
    rec(0, { power: 200, heart_rate: 120, cadence: 90, altitude: 10.5, speed: 25.5, distance: 100, temperature: 25 }),
    rec(1, {}), // 全空秒
  ];
  const csv = recordsToCsv(records);
  const lines = csv.split('\n');
  assert.equal(
    lines[0],
    'timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature',
  );
  assert.equal(lines[1].split(',')[1], '200');
  assert.equal(lines[2].split(',').slice(1).join(','), ',,,,,,'); // 缺数据留空（7 空列 6 逗号）
  const back = parseRecordsCsv(csv);
  assert.deepEqual(back, [
    records[0],
    // rec() 辅助函数不含 temperature 字段，CSV 往返后空值归一为 null
    { ...records[1], temperature: null },
  ]);
});

test('thinRecords: 抽稀口径 ceil(rows/maxPoints)，从 0 号点按 stride 取点', () => {
  const records = Array.from({ length: 5000 }, (_, i) => rec(i, { power: i }));
  const r = thinRecords(records, { maxPoints: 1400 });
  assert.equal(r.stride, 4); // ceil(5000/1400) = 4
  assert.equal(r.total_seconds, 5000);
  assert.equal(r.points.length, 1250);
  assert.equal(r.points[0].power, 0);
  assert.equal(r.points[1].power, 4);
  assert.equal(r.points.at(-1).power, 4996); // 4996 = 4×1249
  // ≤ maxPoints 时 stride = 1、全量返回
  const small = thinRecords(records.slice(0, 100), { maxPoints: 1400 });
  assert.equal(small.stride, 1);
  assert.equal(small.points.length, 100);
});

test('thinRecords: 时间窗先截取再抽稀（相对训练开始的秒数）', () => {
  const records = Array.from({ length: 1000 }, (_, i) => rec(i, { power: i }));
  const r = thinRecords(records, { startSec: 100, endSec: 300 });
  assert.equal(r.total_seconds, 201); // [100, 300] 闭区间
  assert.equal(r.points[0].power, 100);
  // 空序列 → null（与旧版 loadRecords 文件不存在/无行的 null 语义一致）
  assert.equal(thinRecords(records, { startSec: 5000 }), null);
});

test('safeName: 只取 basename，路径穿越拒绝', () => {
  assert.equal(safeName('a.fit'), 'a.fit');
  assert.equal(safeName('../evil.fit'), null);
  assert.equal(safeName('dir\\a.fit'), null); // 含分隔符（Windows 反斜杠）拒绝
  assert.equal(safeName(''), null);
  assert.equal(safeName(null), null);
});

test('firstTimestampFromCsvHead: 取表头后首行的时间戳，形状不完整返回 null', () => {
  const header = 'timestamp,power,heart_rate,cadence,altitude,speed,distance_m,temperature';
  assert.equal(
    firstTimestampFromCsvHead(`${header}\n2026-09-20T00:15:30.000Z,200,140,90,100,10.5,100,25\n`),
    '2026-09-20T00:15:30.000Z',
  );
  // 末行缺换行（文件未以 \n 收尾）仍可取
  assert.equal(firstTimestampFromCsvHead(`${header}\n2026-09-20T00:15:30.000Z,,,,,,,`), '2026-09-20T00:15:30.000Z');
  assert.equal(firstTimestampFromCsvHead(header), null); // 只有表头
  assert.equal(firstTimestampFromCsvHead(`${header}\n2026-09-20T00:1`), null); // 截断的半行
  assert.equal(firstTimestampFromCsvHead(`${header}\n,200,140`), null); // 空时间戳
  assert.equal(firstTimestampFromCsvHead(''), null);
});

test('firstRecordTimestampFromGz: gzip 往返取首帧时间戳，坏数据返回 null', () => {
  const records = [rec(0, { power: 200 }), rec(1, { power: 201 })];
  const gzipped = (text) => gzip(new TextEncoder().encode(text));
  assert.equal(firstRecordTimestampFromGz(gzipped(recordsToCsv(records))), records[0].timestamp);
  // 长记录（万行）同路径：只扫头部两行，结果不受篇幅影响
  const longCsv = recordsToCsv(Array.from({ length: 10000 }, (_, i) => rec(i, { power: i })));
  assert.equal(firstRecordTimestampFromGz(gzipped(longCsv)), records[0].timestamp);
  assert.equal(firstRecordTimestampFromGz(new Uint8Array(0)), null); // 空文件
  assert.equal(firstRecordTimestampFromGz(new Uint8Array([1, 2, 3, 4])), null); // 非 gzip 字节
  assert.equal(firstRecordTimestampFromGz(gzipped('not a records csv')), null); // 非 records CSV
});

// ---------------- 本仓库新增：form 递推（CTL/ATL/TSB） ----------------

test('fillDailyTss: 补齐缺天（TSS=0 参与衰减），UTC 口径逐日', () => {
  const series = fillDailyTss([{ date: '2026-01-01', tss: 100 }], '2026-01-04');
  assert.deepEqual(series, [
    { date: '2026-01-01', tss: 100 },
    { date: '2026-01-02', tss: 0 },
    { date: '2026-01-03', tss: 0 },
    { date: '2026-01-04', tss: 0 },
  ]);
  assert.deepEqual(fillDailyTss([], '2026-01-01'), []); // 空库 → 空序列
});

test('formSeriesDaily/formSnapshotAtEnd: 指数加权口径与 TrainingPeaks 一致', () => {
  // 单日 TSS=100：CTL = 100/42 ≈ 2.4，ATL = 100/7 ≈ 14.3，TSB = −11.9
  const daily = formSeriesDaily([{ date: '2026-01-01', tss: 100 }]);
  assert.equal(daily[0].ctl, 2.4);
  assert.equal(daily[0].atl, 14.3);
  assert.equal(daily[0].tsb, -11.9);
  // 状态枚举边界：TSB ≥ 15 fresh / ≥5 good / ≥−10 balanced / ≥−20 fatigued / 其余 overtrained
  assert.equal(formSnapshotAtEnd([{ date: '2026-01-01', tss: 100 }]).form_state, 'fatigued');
  assert.equal(formSnapshotAtEnd([]), null);
  // 连续 43 天 TSS=100：CTL = 100×(1−(41/42)^43) ≈ 64.5（42 天时间常数，43 天收敛约 2/3）
  const long = formSeriesDaily(Array.from({ length: 43 }, (_, i) => ({ date: `2026-02-${i + 1}`, tss: 100 })));
  assert.equal(long[42].ctl, 64.5);
});

test('formNote/formatAnomaly: zh/en 双语渲染（zh 文案与旧版逐字一致）', () => {
  assert.equal(formNote(16, 'zh'), '状态很新鲜，适合比赛或高强度测试');
  assert.equal(formNote(-25, 'en'), 'Overtraining risk — consider a recovery week');
  const a = { type: 'power_gap', duration_sec: 60, at: '2026-01-01T00:00:00.000Z' };
  assert.equal(formatAnomaly(a, 'zh'), '功率缺失 60s，起始 2026-01-01T00:00:00.000Z');
  assert.equal(formatAnomaly(a, 'en'), 'Power missing 60s, starting 2026-01-01T00:00:00.000Z');
  // 旧库字符串 anomalies 原样透传
  assert.equal(formatAnomaly('旧格式标注', 'en'), '旧格式标注');
  assert.equal(
    formatAnomaly({ type: 'hr_jump', from: 100, to: 140, at: 'x' }, 'zh'),
    '心率跳变 100→140，位于 x',
  );
});

// ---------------- FTP 历史估算（M2 搬运：ftp.ts，断言同源自 reference/test/unit.test.mjs） ----------------

// 构造一次合成骑行（FTP 估算输入：db 层 cyclingSummariesSince 的元素形状）
const mkRide = (
  name,
  date,
  { p5 = 150, p20 = 130, hrMax = 180, pz = { Z5: 5 }, hz = { Z4: 5 }, drift = 2, dur = 3600 } = {},
) => ({
  file_name: name,
  date,
  duration_sec: dur,
  summary: {
    power: {
      peak_curve: {
        ...(p5 != null ? { '5min': p5 } : {}),
        ...(p20 != null ? { '20min': p20 } : {}),
      },
      zone_distribution_pct: pz,
    },
    heart_rate: { max: hrMax, zone_distribution_pct: hz, hr_drift_pct: drift },
    data_quality: { power_coverage_pct: 100, hr_coverage_pct: 100 },
  },
});
const FTP_ATHLETE = { ftp_watts: 118, max_hr: 195 };
const threeRides = (opts) => [
  mkRide('a.fit', '2026-07-01', opts),
  mkRide('b.fit', '2026-07-03', opts),
  mkRide('c.fit', '2026-07-05', opts),
];

test('estimateFtpFromHistory: 双方法一致且心率验证通过 → 高置信', () => {
  const r = estimateFtpFromHistory(threeRides(), FTP_ATHLETE);
  assert.equal(r.status, 'ok');
  // CP = (130×1200 − 150×300) / 900 = 123.3 → 123；W′ = (150−123.3)×300 = 8kJ
  assert.equal(r.estimate.methods.cp_model.ftp_w, 123);
  assert.equal(r.estimate.methods.cp_model.w_prime_kj, 8);
  // Coggan = 130 × 0.95 = 123.5 → 124；两法均值 123.5 → 124
  assert.equal(r.estimate.methods.coggan_20min.ftp_w, 124);
  assert.equal(r.estimate.ftp_w, 124);
  assert.equal(r.estimate.confidence, 'high');
  assert.equal(r.estimate.methods.hr_check.maximal_effort, true);
  assert.equal(r.estimate.diff_w, 124 - FTP_ATHLETE.ftp_watts);
});

test('estimateFtpFromHistory: 无 20min 峰功率 → 数据不足并给出收集清单', () => {
  const r = estimateFtpFromHistory(threeRides({ p20: null }), FTP_ATHLETE);
  assert.equal(r.status, 'insufficient');
  assert.equal(r.estimate, null);
  assert.ok(r.data_needs.length > 0);
  assert.match(r.data_needs.join('\n'), /20 分钟/);
});

test('estimateFtpFromHistory: 样本次数不足 → 低置信并提示补充数据', () => {
  const r = estimateFtpFromHistory([mkRide('a.fit', '2026-07-01')], FTP_ATHLETE);
  assert.equal(r.status, 'ok');
  assert.equal(r.estimate.confidence, 'low');
  assert.match(r.data_needs.join('\n'), /更多佩戴功率计的骑行/);
});

test('estimateFtpFromHistory: 锚点骑行心率未达全力阈值 → 降置信并建议全力测试', () => {
  // 全力阈值 = round(195×0.9) = 176bpm，心率峰值 150 未达
  const r = estimateFtpFromHistory(threeRides({ hrMax: 150 }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.maximal_effort, false);
  assert.equal(r.estimate.confidence, 'medium');
  assert.match(r.data_needs.join('\n'), /全力测试/);
});

test('estimateFtpFromHistory: 功率强度显著高于心率响应 → 判定系统性偏移', () => {
  const r = estimateFtpFromHistory(
    threeRides({ pz: { Z5: 30 }, hz: { Z4: 5 } }),
    FTP_ATHLETE,
  );
  const zm = r.estimate.methods.hr_check.zone_mismatch;
  assert.equal(zm.direction, 'power_above_hr');
  assert.match(r.notes.join('\n'), /低估/);
});

test('estimateFtpFromHistory: 心率漂移超阈值 → 数据漂移提示', () => {
  const r = estimateFtpFromHistory(threeRides({ drift: 8 }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.hr_check.median_hr_drift_pct, 8);
  assert.match(r.notes.join('\n'), /有氧解耦/);
});

test('estimateFtpFromHistory: 缺 5min 峰功率时 CP 模型退化，仅用 Coggan 法', () => {
  const r = estimateFtpFromHistory(threeRides({ p5: null }), FTP_ATHLETE);
  assert.equal(r.estimate.methods.cp_model, null);
  assert.equal(r.estimate.ftp_w, r.estimate.methods.coggan_20min.ftp_w);
  assert.match(r.notes.join('\n'), /CP 模型不可用/);
});

// ---------------- 月度汇总（M2 搬运：monthly.ts，归并口径同源自 reference/src/db.js monthlySummary） ----------------

// 强度分布 summary_json 构造辅助
const zoneJson = (z) => JSON.stringify({ power: { zone_distribution_pct: z } });
const monthRow = (date, dur, dist, tss, summary_json = '{}') => ({
  date,
  duration_sec: dur,
  distance_km: dist,
  tss,
  summary_json,
});

test('monthlySummaryFromRows: 按自然月归并 TSS/时长/距离/次数，月份倒序、n 截断', () => {
  const rows = [
    monthRow('2026-09-05', 3600, 40, 100),
    monthRow('2026-09-01', 1800, 20, 50), // summary_json 无 power 段 → 该月无强度数据
    monthRow('2026-08-20', 7200, 90, 180, 'corrupted{'), // 损坏 JSON 只丢强度分布
  ];
  const r = monthlySummaryFromRows(rows);
  assert.equal(r.length, 2);
  assert.equal(r[0].month, '2026-09');
  assert.equal(r[0].tss, 150);
  assert.equal(r[0].hours, 1.5);
  assert.equal(r[0].distance_km, 60);
  assert.equal(r[0].sessions, 2);
  assert.equal(r[0].intensity_pct, null); // 9 月两行均无有效强度数据
  assert.equal(r[0].intensity_type, null);
  assert.equal(r[1].month, '2026-08');
  assert.equal(r[1].tss, 180);
  // n 截断：只取最近 1 个月
  assert.equal(monthlySummaryFromRows(rows, 1).length, 1);
});

test('monthlySummaryFromRows: 强度按时长加权，类型判定 极化/金字塔/甜区', () => {
  // 极化：低强度(Z1-Z2) ≥75% 且 高>中
  const pol = monthlySummaryFromRows([
    monthRow('2026-09-01', 3600, 40, 100, zoneJson({ Z1: 60, Z2: 20, Z5: 20 })),
  ]);
  assert.deepEqual(pol[0].intensity_pct, { low: 80, mid: 0, high: 20 });
  assert.equal(pol[0].intensity_type, 'polarized');
  // 金字塔：低>中>高（60/40/0）
  const pyr = monthlySummaryFromRows([
    monthRow('2026-09-01', 3600, 40, 100, zoneJson({ Z2: 60, Z3: 30, Z4: 10 })),
  ]);
  assert.deepEqual(pyr[0].intensity_pct, { low: 60, mid: 40, high: 0 });
  assert.equal(pyr[0].intensity_type, 'pyramidal');
  // 甜区：其余取向（中 100%）
  const sw = monthlySummaryFromRows([
    monthRow('2026-09-01', 3600, 40, 100, zoneJson({ Z3: 60, Z4: 40 })),
  ]);
  assert.equal(sw[0].intensity_type, 'sweet_spot');
  // 加权口径：两次骑行时长不同，按时长加权累计（1800s / 1800s / 1800s → 各 33.3%）
  const w = monthlySummaryFromRows([
    monthRow('2026-09-01', 3600, 40, 100, zoneJson({ Z1: 50, Z5: 50 })),
    monthRow('2026-09-02', 1800, 20, 50, zoneJson({ Z3: 100 })),
  ]);
  assert.deepEqual(w[0].intensity_pct, { low: 33.3, mid: 33.3, high: 33.3 });
  assert.equal(w[0].intensity_type, 'sweet_spot');
});

// ---------------- 训练详情指标网格（core/metrics，M2 补充：内容对齐 Web 版 metrics 列表） ----------------

// 取词桩：返回 key 与插值变量，便于断言「出哪一格、注释是什么」
const tStub = (key, vars) =>
  vars && Object.keys(vars).length ? `${key}(${JSON.stringify(vars)})` : String(key);

/** 构造 summary 骨架（只填测试关心的段，其余按 analyze 产物形状占位；patch 分段深合并） */
const summaryOf = (patch = {}) => ({
  ...patch,
  activity: {
    date: '2026-09-04',
    sport: 'cycling',
    duration_sec: 3600,
    distance_km: 30.5,
    elevation_gain_m: 120,
    ...patch.activity,
  },
  athlete_context: { ftp_watts: 200, max_hr: 180, weight_kg: 70, ...patch.athlete_context },
  heart_rate: { avg: 140, max: 165, zone_distribution_pct: null, hr_drift_pct: 3.2, ...patch.heart_rate },
  cadence: { avg: 85, ...patch.cadence },
  data_quality: { record_count: 3600, power_coverage_pct: 100, hr_coverage_pct: 100 },
});

test('buildActivityMetrics: 完整 summary 的出格顺序与 Web 版 metrics 列表一致', () => {
  const s = summaryOf({
    activity: { avg_speed_kmh: 30.5, total_calories: 700 },
    power: {
      avg: 150.4,
      normalized_power: 165,
      max: 500,
      variability_index: 1.05,
      intensity_factor: 0.83,
      tss: 93,
      w_per_kg_avg: 2.15,
      peak_curve: {},
      zone_distribution_pct: null,
    },
    temperature: { avg: 24.5, min: 20, max: 31 },
    athlete_context: { ctl: 42.1, atl: 47.1, tsb: -5 },
  });
  const out = buildActivityMetrics(s, tStub);
  assert.deepEqual(out.map((m) => m.label), [
    'm.duration', 'm.distance', 'm.avg_speed', 'm.gain', 'm.calories',
    'NP', 'm.avg_power', 'm.max_power', 'TSS',
    'm.avg_hr', 'm.hr_drift', 'm.cadence', 'm.temp',
    'm.ctl', 'm.atl', 'm.tsb',
  ]);
  const byLabel = Object.fromEntries(out.map((m) => [m.label, m]));
  assert.deepEqual(byLabel['m.duration'], { label: 'm.duration', value: '1h00' });
  assert.deepEqual(byLabel['m.distance'], { label: 'm.distance', value: '30.50', unit: 'km' });
  assert.equal(byLabel.NP.sub, 'm.np_sub({"if":"0.83"})'); // 小字注释：IF
  assert.deepEqual(byLabel.TSS, { label: 'TSS', value: '93', sub: 'm.tss_sub({"vi":"1.05"})' });
  assert.equal(byLabel['m.avg_power'].sub, '2.15 W/kg');
  assert.equal(byLabel['m.avg_hr'].sub, 'm.max_hr_sub({"max":165})');
  assert.equal(byLabel['m.hr_drift'].sub, 'm.drift_good'); // |3.2| < 5
  assert.deepEqual(byLabel['m.temp'], { label: 'm.temp', value: '24.5', unit: '°C', sub: 'm.temp_max({"t":31})' });
  assert.deepEqual(byLabel['m.ctl'], { label: 'm.ctl', value: '42.1', sub: 'm.ctl_sub' });
  // TSB 简评走 core 词典（form.note.*，zh 与 Web 版逐字一致）
  assert.deepEqual(byLabel['m.tsb'], { label: 'm.tsb', value: '-5', sub: '负荷与恢复平衡，可持续训练' });
});

test('buildActivityMetrics: 缺数据逐项跳过（无功率/心率/温度/负荷快照不崩）', () => {
  const s = summaryOf({ athlete_context: { ftp_watts: 200, max_hr: 180, weight_kg: 70 } });
  const out = buildActivityMetrics(s, tStub);
  assert.deepEqual(out.map((m) => m.label), ['m.duration', 'm.distance', 'm.gain', 'm.avg_hr', 'm.hr_drift', 'm.cadence']);
  // 距离缺失 → "-"（Web 版 num 口径）；爬升为 0 → 该项不显示（Web 版 if (a.elevation_gain_m)）
  const s2 = summaryOf({ activity: { elevation_gain_m: 0, distance_km: null } });
  const labels2 = buildActivityMetrics(s2, tStub).map((m) => m.label);
  assert.ok(!labels2.includes('m.gain'));
  assert.equal(buildActivityMetrics(s2, tStub)[1].value, '-');
});

test('buildActivityMetrics: 心率漂移 ≥5% 判读为「漂移偏大」，TSB 正数补 + 号', () => {
  const s = summaryOf({
    heart_rate: { avg: 140, max: 165, hr_drift_pct: -7.5, zone_distribution_pct: null },
    athlete_context: { ctl: 42, atl: 30, tsb: 12 },
  });
  const out = buildActivityMetrics(s, tStub);
  const drift = out.find((m) => m.label === 'm.hr_drift');
  assert.deepEqual(drift, { label: 'm.hr_drift', value: '-7.5', unit: '%', sub: 'm.drift_high' });
  const tsb = out.find((m) => m.label === 'm.tsb');
  assert.equal(tsb.value, '+12');
  assert.equal(tsb.sub, '状态良好，恢复充分'); // 12 → form.note.1
});

test('buildActivityMetrics: 跑步用步频/spm，游泳与配速各有独立格', () => {
  const s = summaryOf({
    activity: { sport: 'running', elevation_gain_m: 30 },
    swim: { lengths_count: 40, pool_length_m: 25, avg_length_time_sec: 31.4, total_strokes: null, avg_swolf: 45.2 },
    pace: { avg_pace_min_per_km: 5.5, best_1min_pace_min_per_km: 3.998 },
  });
  const out = buildActivityMetrics(s, tStub);
  const byLabel = Object.fromEntries(out.map((m) => [m.label, m]));
  assert.deepEqual(byLabel['m.stride'], { label: 'm.stride', value: '85', unit: 'spm' });
  assert.equal(byLabel['m.cadence'], undefined);
  assert.deepEqual(byLabel['m.pace'], { label: 'm.pace', value: '5:30', unit: '/km' });
  assert.equal(byLabel['m.pace_best'].value, '4:00'); // 3.998min → 59.88s 四舍五入 60 → 进位
  assert.deepEqual(byLabel['m.swim_lengths'], { label: 'm.swim_lengths', value: '40' });
  assert.deepEqual(byLabel['m.swolf'], { label: 'm.swolf', value: '45.2' });
  assert.deepEqual(byLabel['m.swim_avg'], { label: 'm.swim_avg', value: '31.4', unit: 's' });
});

test('formatNum/formatDuration/formatPace: 数值口径与边界（同 Web 版 common.js）', () => {
  assert.equal(formatNum(null), '-');
  assert.equal(formatNum(2.0, 2), '2'); // 全零小数位去掉
  assert.equal(formatNum(1.5, 2), '1.50'); // 非零小数位保留两位
  assert.equal(formatNum(30.456, 2), '30.46');
  assert.equal(formatNum(-7.56, 1), '-7.6');
  assert.equal(formatDuration(null), '—');
  assert.equal(formatDuration(2700), '45m');
  assert.equal(formatDuration(3599), '1h00'); // 进位防 "60m"
  assert.equal(formatDuration(3900), '1h05');
  assert.equal(formatDuration(7200, '-'), '2h00');
  assert.equal(formatPace(null), '-');
  assert.equal(formatPace(5.5), '5:30');
  assert.equal(formatPace(4.999), '5:00'); // 秒位进位
  assert.equal(metricColumns(360), 2); // 窄屏两列（同 Web 版窄屏）
  assert.equal(metricColumns(720), 4);
  assert.equal(metricColumns(1280), 4); // 上限 4 列
});

test('formatDurationClock: Web fmtDur 同口径（秒先四舍五入，≥1h → h:mm:ss）', () => {
  assert.equal(formatDurationClock(null), '-');
  assert.equal(formatDurationClock(0), '0:00');
  assert.equal(formatDurationClock(59.4), '0:59'); // 秒先四舍五入
  assert.equal(formatDurationClock(59.6), '1:00');
  assert.equal(formatDurationClock(3599.49), '59:59');
  assert.equal(formatDurationClock(3600), '1:00:00'); // 恰 1 小时进位
  assert.equal(formatDurationClock(3661), '1:01:01');
});

test('buildCadenceMetrics: 五格顺序与取值对齐 Web cadencePowerHtml（corr 缺失兜底 "-"）', () => {
  const t = (key) => key; // 取词桩：只验证 key 透传与数值格式化
  const items = buildCadenceMetrics(
    { sample_sec: 3661, avg_cadence: 88, pct_low_cadence: 30, pct_high_cadence: 45.5, cadence_power_corr: 0.5 },
    t,
  );
  assert.deepEqual(items, [
    { label: 'cad.effort', value: '1:01:01', sub: 'cad.effort_sub' },
    { label: 'cad.avg', value: '88', unit: 'rpm' },
    { label: 'cad.low', value: '30', unit: '%', sub: 'cad.low_sub' },
    { label: 'cad.high', value: '45.5', unit: '%', sub: 'cad.high_sub' },
    { label: 'cad.corr', value: '0.5' },
  ]);
  const missingCorr = buildCadenceMetrics(
    { sample_sec: 120, avg_cadence: 90.2, pct_low_cadence: 10, pct_high_cadence: 20, cadence_power_corr: null },
    t,
  );
  assert.equal(missingCorr[4].value, '-'); // 相关系数分母为 0 时 analyze 产出 null
});
