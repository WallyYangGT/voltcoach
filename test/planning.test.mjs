/**
 * planning.test.mjs — src/planning 未来负荷推演与课表生成回归测试。
 * 自 fit-reader Web 版 src/planning.js 口径同源搬运：递推公式与训练库 CTL/ATL 同口径、
 * 风险标注阈值、课表拼装与 TSS 估算（时长秒 × IF² / 36）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { simulateForm, generateWorkout } = await import('../src/planning/planning.ts');
const { FORM_SIMULATION, WORKOUT_TEMPLATES } = await import('../src/core/settings.ts');

test('simulateForm：递推口径与训练库一致（ctl 42 天 / atl 7 天指数加权）', () => {
  // 从 0 起步，连续 7 天每天 100 TSS，手工推演第 1 天与第 7 天
  const plan = Array.from({ length: 7 }, (_, i) => ({ date: `2026-03-0${i + 1}`, tss: 100 }));
  const r = simulateForm({ startCtl: 0, startAtl: 0, plan, cfg: FORM_SIMULATION });
  let ctl = 0, atl = 0;
  const expect = [];
  for (const d of plan) {
    ctl += (100 - ctl) / 42;
    atl += (100 - atl) / 7;
    expect.push([d.date, Math.round(ctl * 10) / 10, Math.round(atl * 10) / 10, Math.round((ctl - atl) * 10) / 10]);
  }
  assert.deepEqual(r.projection, expect);
  assert.equal(r.projection[6][2] > r.projection[6][1], true); // 短期疲劳(ATL)涨得比体能(CTL)快
  assert.deepEqual(r.end_form, { ctl: r.projection[6][1], atl: r.projection[6][2], tsb: r.projection[6][3] });
  assert.equal(r.risk_flags.length, 0); // 7 天 100 TSS 不触发风险
});

test('simulateForm：TSB 持续低于阈值达天数即警示（找连续段）', () => {
  const cfg = { ...FORM_SIMULATION, tsb_low: -30, tsb_low_days: 7, ctl_ramp_pct: 1000 };
  // 高强度连拉 10 天 → TSB 一路下探并持续低于 -30
  const plan = Array.from({ length: 10 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, tss: 250 }));
  const r = simulateForm({ startCtl: 60, startAtl: 50, plan, cfg });
  const flags = r.risk_flags.filter((f) => f.type === 'tsb_low_sustained');
  assert.equal(flags.length, 1);
  assert.ok(flags[0].days >= 7);
  assert.match(flags[0].message, /TSB 连续 \d+ 天低于 -30/);
  assert.ok(flags[0].start && flags[0].end);
});

test('simulateForm：CTL 周增幅超阈警示（起点 CTL > 0 才判定）', () => {
  const cfg = { ...FORM_SIMULATION, tsb_low: -300, ctl_ramp_pct: 10 };
  // 每天 200 TSS、连续 15 天：CTL 一周增幅远超 10%
  const plan = Array.from({ length: 15 }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, tss: 200 }));
  const r = simulateForm({ startCtl: 30, startAtl: 30, plan, cfg });
  const flags = r.risk_flags.filter((f) => f.type === 'ctl_ramp_high');
  assert.ok(flags.length >= 1);
  assert.match(flags[0].message, /CTL 周增幅 [\d.]+% 超过 10%/);
  assert.equal(flags[0].ramp_pct > 10, true);
});

test('generateWorkout：稳态课（恢复骑/有氧耐力）全程一个强度', () => {
  const w = generateWorkout({ target: 'endurance', durationMinutes: 90, ftpWatts: 200, tsb: null, templates: WORKOUT_TEMPLATES, tsbRecovery: FORM_SIMULATION.tsb_recovery });
  assert.equal(w.target, 'endurance');
  assert.equal(w.label, '有氧耐力');
  assert.deepEqual(w.steady, { minutes: 90, power_watts: [112, 150] }); // 56–75% × 200W
  // TSS = 90min × 0.68² → 90×60×0.4624/36 = 69.4
  assert.equal(w.estimated_tss, 69.4);
  assert.deepEqual(w.notes, []);
});

test('generateWorkout：间歇课组数夹在模板范围内、剩余时长并入冷身', () => {
  const w = generateWorkout({ target: 'threshold', durationMinutes: 75, ftpWatts: 200, tsb: null, templates: WORKOUT_TEMPLATES, tsbRecovery: FORM_SIMULATION.tsb_recovery });
  // avail = 75-15-10 = 50；reps=3: (50-2×5)/3=13.3→13 ≥10 ✓
  assert.equal(w.main_sets.reps, 3);
  assert.equal(w.main_sets.set_minutes, 13);
  assert.equal(w.main_sets.rest_minutes, 5);
  // 冷身吸收剩余：75-15-(3×13+2×5)=75-15-49=11
  assert.equal(w.cooldown.minutes, 11);
  // 各段合计 = 总时长
  assert.equal(w.warmup.minutes + w.main_sets.reps * w.main_sets.set_minutes + (w.main_sets.reps - 1) * w.main_sets.rest_minutes + w.cooldown.minutes, 75);
  // 主组功率 = 95–105% × 200W
  assert.deepEqual(w.main_sets.power_watts, [190, 210]);
  assert.equal(w.estimated_tss > 0, true);
});

test('generateWorkout：VO2max 组间休息与单组等时（rest_min=null）', () => {
  const w = generateWorkout({ target: 'vo2max', durationMinutes: 60, ftpWatts: 250, tsb: null, templates: WORKOUT_TEMPLATES, tsbRecovery: FORM_SIMULATION.tsb_recovery });
  // avail = 60-15-10 = 35；组数从上限 6 起试：35/(2×6-1)=3 ≥3 且 ≤5 ✓
  assert.equal(w.main_sets.reps, 6);
  assert.equal(w.main_sets.set_minutes, 3);
  assert.equal(w.main_sets.rest_minutes, 3); // 等时休息
});

test('generateWorkout：TSB 过低自动降级为恢复课并写 notes', () => {
  const w = generateWorkout({ target: 'vo2max', durationMinutes: 60, ftpWatts: 200, tsb: -25, templates: WORKOUT_TEMPLATES, tsbRecovery: FORM_SIMULATION.tsb_recovery });
  assert.equal(w.target, 'recovery');
  assert.equal(w.label, '恢复骑');
  assert.equal(w.notes.length, 1);
  assert.match(w.notes[0], /当前 TSB -25 低于 -20，身体未恢复，自动降级为恢复骑/);
  // 已是恢复课不再重复降级
  const w2 = generateWorkout({ target: 'recovery', durationMinutes: 40, ftpWatts: 200, tsb: -25, templates: WORKOUT_TEMPLATES, tsbRecovery: FORM_SIMULATION.tsb_recovery });
  assert.deepEqual(w2.notes, []);
});

test('generateWorkout：未知类型与时长不足返回 error（不抛异常）', () => {
  const bad = generateWorkout({ target: 'sprint', durationMinutes: 60, ftpWatts: 200, tsb: null, templates: WORKOUT_TEMPLATES, tsbRecovery: FORM_SIMULATION.tsb_recovery });
  assert.match(bad.error, /未知课表类型: sprint（可选: recovery\/endurance\/sweet_spot\/threshold\/vo2max）/);
  const short = generateWorkout({ target: 'threshold', durationMinutes: 30, ftpWatts: 200, tsb: null, templates: WORKOUT_TEMPLATES, tsbRecovery: FORM_SIMULATION.tsb_recovery });
  // avail = 30-25 = 5，连 2×10 都装不下
  assert.match(short.error, /30 分钟装不下 阈值 课表（热身 15 \+ 至少 2×10 分钟主组 \+ 冷身 10）/);
});
