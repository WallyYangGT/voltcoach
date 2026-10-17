/**
 * dossier.test.mjs — 个人训练档案聚合与记忆分层规则的纯函数测试
 *
 * 覆盖：空库、单骑全段、90 天窗边界（锚日 -89 含 / -90 不含）、PB 跨骑取最大
 * 与并列取最早、功率不可信骑行的排除口径（峰功率/分区/爬坡/踏频/周 TSS 排除，
 * 心率漂移与时长采信）、周负荷聚合、中位数偶数均值、FTP 非法时强度分位退化、
 * 月度强度类型透传；短期记忆过期的时长/训练数边界与 legacy 保守口径。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  addDaysStr,
  buildDossier,
  DOSSIER_WINDOW_DAYS,
} from '../src/core/dossier.ts';
import { isShortMemoryExpired } from '../src/core/memory.ts';

// ---------------- 夹具 ----------------

/** 一次完整骑行的输入（按需覆盖字段） */
function ride(over = {}) {
  return {
    file_name: 'a.fit',
    date: '2026-10-01',
    sport: 'cycling',
    power_flagged: false,
    duration_sec: 3600,
    tss: 60,
    summary: {
      power: {
        peak_curve: { '5s': 900, '1min': 500, '5min': 350, '20min': 280 },
        zone_distribution_pct: { Z1: 40, Z2: 30, Z3: 20, Z4: 10 },
      },
      heart_rate: { hr_drift_pct: 3.5 },
      climbs: [
        {
          name: 'c1', start: '2026-10-01T00:10:00Z', duration_sec: 600,
          distance_m: 3000, elevation_gain_m: 150, avg_grade_pct: 5,
          avg_power: 260, avg_hr: 150,
        },
      ],
      cadence_power: {
        sample_sec: 30, avg_cadence: 85, pct_low_cadence: 20, pct_high_cadence: 30,
        cadence_power_corr: 0.5, style: 'normal',
      },
    },
    ...over,
  };
}

const NOW = new Date('2026-10-12T00:00:00Z');

// ---------------- buildDossier ----------------

test('空输入与非骑行输入返回 null（不出档案）', () => {
  assert.equal(buildDossier([], 200, [], NOW), null);
  assert.equal(
    buildDossier([ride({ sport: 'running', summary: null })], 200, [], NOW),
    null,
  );
});

test('单骑：各段齐全，PB=近90天，加权分区等于原占比', () => {
  const d = buildDossier([ride()], 250, [{ month: '2026-09', type: 'pyramidal' }], NOW);
  assert.equal(d.anchor_date, '2026-10-01');
  assert.equal(d.cycling.considered, 1);
  assert.equal(d.cycling.with_power, 1);
  assert.equal(d.cycling.flagged_excluded, 0);
  assert.deepEqual(d.peak_power.all_time.map((e) => e.value_w), [900, 500, 350, 280]);
  assert.deepEqual(d.peak_power.all_time, d.peak_power.last_90d);
  assert.equal(d.peak_power.all_time[0].file_name, 'a.fit');
  assert.equal(d.climb_profile.climbs_analyzed, 1);
  assert.equal(d.climb_profile.median_grade_pct, 5);
  assert.equal(d.climb_profile.median_pct_ftp, Math.round((260 / 250) * 1000) / 10);
  assert.equal(d.climb_profile.median_avg_hr, 150);
  assert.deepEqual(d.cadence_profile.style_counts, { low: 0, normal: 1, high: 0 });
  assert.deepEqual(d.intensity_structure.zone_pct, { Z1: 40, Z2: 30, Z3: 20, Z4: 10 });
  assert.deepEqual(d.intensity_structure.intensity_types, [
    { month: '2026-09', type: 'pyramidal' },
  ]);
  const lastWeek = d.load_shape.weeks.at(-1);
  assert.equal(lastWeek.rides, 1);
  assert.equal(lastWeek.tss, 60);
  assert.equal(lastWeek.duration_sec, 3600);
  assert.equal(lastWeek.end, '2026-10-01');
  assert.equal(d.load_shape.hr_drift.median_pct, 3.5);
});

test('90 天窗边界：锚日 -89 天含、-90 天不含（PB 不受窗影响）', () => {
  const anchor = '2026-10-01';
  const inWin = addDaysStr(anchor, -(DOSSIER_WINDOW_DAYS - 1));
  const outWin = addDaysStr(inWin, -1);
  assert.equal(anchor >= inWin, true);
  const d = buildDossier(
    [
      ride({ file_name: 'old.fit', date: outWin, tss: 10 }), // 窗外
      ride({ file_name: 'edge.fit', date: inWin, tss: 20 }),
      ride({ file_name: 'new.fit', date: anchor, tss: 30 }),
    ],
    250,
    [],
    NOW,
  );
  assert.equal(d.cycling.considered, 2); // edge + new
  // 窗外骑行仍计入历史 PB：5s 950 > 窗内 900
  const d2 = buildDossier(
    [
      ride({
        file_name: 'old.fit',
        date: outWin,
        summary: {
          ...ride().summary,
          power: { ...ride().summary.power, peak_curve: { ...ride().summary.power.peak_curve, '5s': 950 } },
        },
      }),
      ride({ file_name: 'new.fit', date: anchor }),
    ],
    250,
    [],
    NOW,
  );
  assert.equal(d2.peak_power.all_time.find((e) => e.window === '5s').value_w, 950);
  assert.equal(d2.peak_power.last_90d.find((e) => e.window === '5s').value_w, 900);
  assert.equal(d2.peak_power.last_90d.find((e) => e.window === '5s').file_name, 'new.fit');
});

test('PB 跨骑取最大、并列取最早；各窗口独立', () => {
  const d = buildDossier(
    [
      ride({ file_name: 'a.fit', date: '2026-09-01', summary: {
        ...ride().summary,
        power: { ...ride().summary.power, peak_curve: { '5s': 800, '20min': 300 } },
      } }),
      ride({ file_name: 'b.fit', date: '2026-09-20', summary: {
        ...ride().summary,
        power: { ...ride().summary.power, peak_curve: { '5s': 800, '1min': 480, '20min': 290 } },
      } }),
      ride({ file_name: 'c.fit', date: '2026-09-25', summary: null }), // 无 summary 不参与功率基线
    ],
    250,
    [],
    NOW,
  );
  const p5 = d.peak_power.all_time.find((e) => e.window === '5s');
  assert.equal(p5.value_w, 800);
  assert.equal(p5.file_name, 'a.fit'); // 并列取最早
  const p20 = d.peak_power.all_time.find((e) => e.window === '20min');
  assert.equal(p20.value_w, 300);
  assert.equal(p20.file_name, 'a.fit');
  assert.equal(d.peak_power.all_time.find((e) => e.window === '1min').value_w, 480);
});

test('功率不可信骑行：功率基线全排除，心率漂移与时长采信，计数披露', () => {
  const flagged = ride({
    file_name: 'bad.fit',
    date: '2026-09-28', // 落在锚日（10-01）所在周（09-25..10-01）
    power_flagged: true,
    tss: 999,
    duration_sec: 7200,
    summary: {
      ...ride().summary,
      power: { ...ride().summary.power, peak_curve: { '5s': 2000, '20min': 800 } },
    },
  });
  const d = buildDossier([flagged, ride()], 250, [], NOW);
  assert.equal(d.cycling.considered, 1);
  assert.equal(d.cycling.flagged_excluded, 1);
  assert.equal(d.cycling.total_flagged, 1);
  // 2000W 的 5s 未进 PB
  assert.equal(d.peak_power.all_time.find((e) => e.window === '5s').value_w, 900);
  // 爬坡画像只来自未标记骑行
  assert.equal(d.climb_profile.climbs_analyzed, 1);
  assert.equal(d.cadence_profile.rides_analyzed, 1);
  // 周负荷：时长累加（7200+3600），TSS 只算未标记（60，999 被剔）
  const lastWeek = d.load_shape.weeks.at(-1);
  assert.equal(lastWeek.rides, 2);
  assert.equal(lastWeek.tss, 60);
  assert.equal(lastWeek.duration_sec, 10800);
  // 心率漂移含被标记骑行（两样本取中位均值）
  assert.equal(d.load_shape.hr_drift.rides, 2);
  assert.equal(d.load_shape.hr_drift.median_pct, 3.5); // 3.5 与 3.5 的中位
});

test('周负荷跨周聚合与周区间（锚日所在周为最后一周）', () => {
  const d = buildDossier(
    [
      ride({ date: '2026-10-01', tss: 10, duration_sec: 1000 }),
      ride({ date: '2026-09-20', tss: 20, duration_sec: 2000 }),
      ride({ date: '2026-08-01', tss: 40, duration_sec: 4000 }), // 8 周窗外
    ],
    250,
    [],
    NOW,
  );
  const weeks = d.load_shape.weeks;
  assert.equal(weeks.length, 8);
  assert.equal(weeks.at(-1).tss, 10); // 锚日周
  assert.equal(weeks.at(-2).tss, 20); // 前一周（9-20 落在其中）
  assert.equal(weeks.at(0).tss, 0); // 8-01 早于窗口起点
  for (let i = 1; i < weeks.length; i++) {
    assert.equal(addDaysStr(weeks[i - 1].end, 1), weeks[i].start); // 周与周首尾相接
    assert.equal(addDaysStr(weeks[i].start, 6), weeks[i].end); // 每周恰 7 天
  }
});

test('中位数偶数取均值；缺失字段不参与对应分位', () => {
  const mk = (name, grade, hr) => ({
    ...ride(),
    file_name: name,
    summary: {
      ...ride().summary,
      climbs: [{
        name: 'x', start: 's', duration_sec: 100, distance_m: 500,
        elevation_gain_m: 20, avg_grade_pct: grade, avg_power: 250, avg_hr: hr,
      }],
    },
  });
  const d = buildDossier(
    [mk('a', 4, 140), mk('b', 6, null), mk('c', 8, 160)],
    250,
    [],
    NOW,
  );
  assert.equal(d.climb_profile.climbs_analyzed, 3);
  assert.equal(d.climb_profile.median_grade_pct, 6);
  assert.equal(d.climb_profile.median_avg_hr, 150); // [140,160] 均值
});

test('FTP ≤ 0 时强度分位为 null，其余字段不受影响', () => {
  const d = buildDossier([ride()], 0, [], NOW);
  assert.equal(d.climb_profile.median_pct_ftp, null);
  assert.equal(d.climb_profile.median_grade_pct, 5);
});

test('月度强度类型透传：null 剔除、最多 6 条', () => {
  const monthly = Array.from({ length: 9 }, (_, i) => ({
    month: `2026-0${i + 1}`,
    type: i % 2 ? null : 'polarized',
  }));
  const d = buildDossier([ride()], 250, monthly, NOW);
  assert.equal(d.intensity_structure.intensity_types.length, 5);
  assert.ok(d.intensity_structure.intensity_types.every((m) => m.type === 'polarized'));
});

test('单锚点降级：功率不可用骑行按心率五区聚合（功率可用骑行不进 HR 口径）', () => {
  const noPower = ride({
    file_name: 'np.fit',
    duration_sec: 3600,
    summary: {
      power: null,
      heart_rate: { zone_distribution_pct: { Z1: 50, Z2: 30, Z3: 10, Z4: 5, Z5: 5 } },
    },
  });
  // 功率可用骑行：只进功率结构，不进 HR 结构（避免双计）
  const withPower = ride({ file_name: 'wp.fit', duration_sec: 3600 });
  // 功率被标记不可信：功率作废、心率仍可信 → 进 HR 口径
  const flagged = ride({
    file_name: 'fl.fit',
    duration_sec: 1800,
    power_flagged: true,
    summary: {
      power: { peak_curve: { '5s': 900 }, zone_distribution_pct: { Z1: 100 } },
      heart_rate: { zone_distribution_pct: { Z1: 10, Z2: 20, Z3: 30, Z4: 20, Z5: 20 } },
    },
  });
  const d = buildDossier([noPower, withPower, flagged], 200, [], NOW);
  // 权重 = 3600 + 1800 = 5400s
  assert.deepEqual(d.intensity_structure.hr_zone_pct, {
    Z1: 36.7,
    Z2: 26.7,
    Z3: 16.7,
    Z4: 10,
    Z5: 10,
  });
  // 无功率不可用骑行时 HR 结构为 null（不产生空对象）
  const onlyPower = buildDossier([withPower], 200, [], NOW);
  assert.equal(onlyPower.intensity_structure.hr_zone_pct, null);
});

test('addDaysStr 跨月/跨年正确', () => {
  assert.equal(addDaysStr('2026-10-01', -1), '2026-09-30');
  assert.equal(addDaysStr('2026-01-01', -1), '2025-12-31');
  assert.equal(addDaysStr('2026-02-28', 1), '2026-03-01');
  assert.equal(addDaysStr('2026-03-01', -89), '2025-12-02');
});

// ---------------- isShortMemoryExpired ----------------

const day = 86400000;
// SQLite datetime('now') 口径：UTC "YYYY-MM-DD HH:MM:SS"
// memAt 距 nowMs 恰好 14 天（短期记忆时长上限，2026-10-13 拍板由 7 天放宽）
const memAt = '2026-09-28 08:00:00';
const nowMs = Date.UTC(2026, 9, 12, 8, 0, 0);

test('长期与 legacy 记忆永不过期', () => {
  const acts = ['2026-10-01 00:00:00', '2026-10-02 00:00:00', '2026-10-03 00:00:00'];
  assert.equal(isShortMemoryExpired({ scope: 'long', created_at: '2020-01-01 00:00:00' }, nowMs, acts), false);
  assert.equal(isShortMemoryExpired({ scope: null, created_at: '2020-01-01 00:00:00' }, nowMs, acts), false);
  assert.equal(isShortMemoryExpired({ scope: undefined, created_at: undefined }, nowMs, acts), false);
});

test('短期：时长边界（严格大于 14 天才过期；缺 created_at 保守不过期）', () => {
  const acts = [];
  // memAt 距 nowMs 恰好 14 天：不过期（严格大于）；14 天 + 1 秒：过期
  assert.equal(isShortMemoryExpired({ scope: 'short', created_at: memAt }, nowMs, acts), false);
  assert.equal(isShortMemoryExpired({ scope: 'short', created_at: memAt }, nowMs + 1000, acts), true);
  // 未满 14 天不过期
  assert.equal(isShortMemoryExpired({ scope: 'short', created_at: memAt }, nowMs - day, acts), false);
  assert.equal(isShortMemoryExpired({ scope: 'short', created_at: null }, nowMs, acts), false);
});

test('短期：新增活动数边界（≥5 过期，4 不过）', () => {
  const four = [
    '2026-10-06 00:00:00',
    '2026-10-07 00:00:00',
    '2026-10-08 00:00:00',
    '2026-10-09 00:00:00',
  ];
  const five = [...four, '2026-10-10 00:00:00'];
  assert.equal(isShortMemoryExpired({ scope: 'short', created_at: memAt }, nowMs, four), false);
  assert.equal(isShortMemoryExpired({ scope: 'short', created_at: memAt }, nowMs, five), true);
  // 记忆写入之前的活动不计入
  const older = ['2026-09-01 00:00:00', '2026-09-02 00:00:00', '2026-09-03 00:00:00'];
  assert.equal(isShortMemoryExpired({ scope: 'short', created_at: memAt }, nowMs, older), false);
});

test('短期：时长与训练数任一先到即过期', () => {
  // 未满 14 天但已 5 次训练 → 过期（训练数先到）
  const fresh = { scope: 'short', created_at: '2026-10-10 00:00:00' };
  const acts = [
    '2026-10-10 01:00:00',
    '2026-10-11 01:00:00',
    '2026-10-12 01:00:00',
    '2026-10-12 02:00:00',
    '2026-10-12 03:00:00',
  ];
  assert.equal(isShortMemoryExpired(fresh, nowMs + day, acts), true);
});
