/**
 * health-activity.test.mjs — WHO 周活动量口径（src/core/health-activity）。
 *
 * 钉住：近 7 天本地日窗口（含今天/边界外剔除）、IF 直接分档、TSS+时长反推 IF、
 * 无功率 race 兜底、轻松骑单列不计入、等效分钟 = 中等 + 2×高强度、缺时长跳过。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { summarizeWeeklyActivity, WHO_ACTIVITY_TARGET } = await import(
  '../src/core/health-activity.ts'
);

test('7 天窗口：中等/高强度/轻松分档与 WHO 2 倍折算', () => {
  const rows = [
    // 10-11（今天-6，含）中等 60
    { date: '2026-10-11', duration_sec: 3600, intensity_factor: 0.7, tss: 60, category: 'training' },
    // 10-12 高强度 60（原始分钟，折算 ×2）
    { date: '2026-10-12', duration_sec: 3600, intensity_factor: 0.95, tss: 110, category: 'training' },
    // 10-13 无 IF，TSS 60 / 60min 反推 IF≈0.775 → 中等 60
    { date: '2026-10-13', duration_sec: 3600, intensity_factor: null, tss: 60, category: 'training' },
    // 10-14 无功率比赛 → 高强度 30
    { date: '2026-10-14', duration_sec: 1800, intensity_factor: null, tss: null, category: 'race' },
    // 10-10（今天-7，窗口外）不计
    { date: '2026-10-10', duration_sec: 3600, intensity_factor: 0.7, tss: 60, category: 'training' },
    // 缺时长跳过
    { date: '2026-10-15', duration_sec: null, intensity_factor: 0.8, tss: 50, category: 'training' },
    // 10-16 轻松骑 IF<0.6 → 单列不计入
    { date: '2026-10-16', duration_sec: 1800, intensity_factor: 0.5, tss: 20, category: 'recovery' },
  ];
  const s = summarizeWeeklyActivity(rows, '2026-10-17');
  assert.equal(s.days, 7);
  assert.equal(s.moderate_min, 120);
  assert.equal(s.vigorous_min, 90);
  assert.equal(s.light_min, 30);
  assert.equal(s.equivalent_min, 300); // 120 + 2×90
  assert.equal(s.target_min, WHO_ACTIVITY_TARGET.moderate_min);
  assert.equal(s.extra_min, 300);
  assert.equal(s.power_trusted, true);
});

test('强度边界：IF 0.9 高强度、0.55 中等、0.54 轻松；无功率无 TSS 按中等', () => {
  const at = (ifv) => summarizeWeeklyActivity(
    [{ date: '2026-10-17', duration_sec: 600, intensity_factor: ifv, tss: null }],
    '2026-10-17',
    1,
  );
  assert.equal(at(0.9).vigorous_min, 10);
  assert.equal(at(0.55).moderate_min, 10);
  assert.equal(at(0.54).light_min, 10);
  // 0.85（曾被 DB 一位小数取整成 0.9 的典型值）：必须仍是中等，不能 ×2
  assert.equal(at(0.85).moderate_min, 10);
  assert.equal(at(0.85).vigorous_min, 0);
  // 无功率无 TSS 的日常骑行：宽松口径按中等计（数据不足不惩罚用户）
  const unknown = summarizeWeeklyActivity(
    [{ date: '2026-10-17', duration_sec: 1800, intensity_factor: null, tss: null, category: 'leisure' }],
    '2026-10-17',
  );
  assert.equal(unknown.moderate_min, 30);
  // 自定义窗口天数
  const oneDay = summarizeWeeklyActivity(
    [
      { date: '2026-10-17', duration_sec: 600, intensity_factor: 0.7, tss: 10 },
      { date: '2026-10-16', duration_sec: 600, intensity_factor: 0.7, tss: 10 },
    ],
    '2026-10-17',
    1,
  );
  assert.equal(oneDay.moderate_min, 10);
  assert.equal(oneDay.days, 1);
});

test('空输入/负时长返回全零；非法 days 回退 7', () => {
  const empty = summarizeWeeklyActivity([], '2026-10-17');
  assert.deepEqual(empty, {
    days: 7,
    moderate_min: 0,
    vigorous_min: 0,
    light_min: 0,
    equivalent_min: 0,
    target_min: 150,
    extra_min: 300,
    power_trusted: true,
  });
  const negative = summarizeWeeklyActivity(
    [{ date: '2026-10-17', duration_sec: -60, intensity_factor: 0.8, tss: 10 }],
    '2026-10-17',
  );
  assert.equal(negative.equivalent_min, 0);
  assert.equal(summarizeWeeklyActivity([], '2026-10-17', 0).days, 7);
});

test('功率不可信：未校准 FTP 或被标记的骑行不采信 IF（按保守口径估计）', () => {
  const rows = [
    // 未校准 FTP：即使 IF 0.95 也按中等计
    { date: '2026-10-17', duration_sec: 3600, intensity_factor: 0.95, tss: 110, category: 'training' },
    // 比赛仍按高强度
    { date: '2026-10-16', duration_sec: 1800, intensity_factor: 0.95, tss: 50, category: 'race' },
  ];
  const uncal = summarizeWeeklyActivity(rows, '2026-10-17', 7, { powerTrusted: false });
  assert.equal(uncal.moderate_min, 60);
  assert.equal(uncal.vigorous_min, 30);
  assert.equal(uncal.power_trusted, false);
  // 未校准 + 单次骑行被标记：同样按兜底口径
  const flagged = summarizeWeeklyActivity(
    [
      { date: '2026-10-17', duration_sec: 3600, intensity_factor: 0.95, tss: 110, category: 'training', power_flagged: true },
    ],
    '2026-10-17',
  );
  assert.equal(flagged.moderate_min, 60);
  assert.equal(flagged.vigorous_min, 0);
});

test('分钟取整按秒累加：两条 30 秒短途合计 1 分钟（不逐条向上取整）', () => {
  const s = summarizeWeeklyActivity(
    [
      { date: '2026-10-17', duration_sec: 30, intensity_factor: 0.8, tss: 1 },
      { date: '2026-10-17', duration_sec: 30, intensity_factor: 0.8, tss: 1 },
    ],
    '2026-10-17',
  );
  assert.equal(s.moderate_min, 1);
});

test('同日多次累加、未来日期排除、NaN IF 与无效数值不炸', () => {
  const s = summarizeWeeklyActivity(
    [
      { date: '2026-10-16', duration_sec: 1800, intensity_factor: 0.7, tss: 30 },
      { date: '2026-10-16', duration_sec: 1800, intensity_factor: 0.95, tss: 60 },
      { date: '2026-10-18', duration_sec: 3600, intensity_factor: 0.7, tss: 60 }, // 未来日
      { date: '2026-10-15', duration_sec: 1800, intensity_factor: Number.NaN, tss: null }, // NaN → 兜底中等
      { date: '2026-10-14', duration_sec: 'oops', intensity_factor: 0.8, tss: 10 }, // 时长非法
    ],
    '2026-10-17',
  );
  assert.equal(s.moderate_min, 60); // 30 + 30（NaN 兜底）
  assert.equal(s.vigorous_min, 30);
  assert.equal(s.equivalent_min, 120);
});
