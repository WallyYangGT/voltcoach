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
import { parseRecordsCsv, thinRecords, safeName } from '../src/core/records.ts';
import { fillDailyTss, formSeriesDaily, formSnapshotAtEnd } from '../src/core/form.ts';
import { formNote, formatAnomaly } from '../src/core/i18n.ts';
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
