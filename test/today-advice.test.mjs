/**
 * today-advice.test.mjs — 今日训练建议纯函数测试（node:test，U1 收尾①）
 *
 * 覆盖：TSB 三档分档（阈值取 FORM_SIMULATION 出厂值 -20/-30 的边界两侧）、
 * 「今天已练」免扰档优先级、计划课型交叉（质量课深负 → downgrade、计划休息日/
 * 无课不出课表、无计划降级纯状态建议但保留自由骑车表出口）、课型 → target 映射
 * （long 按 endurance 口径）、TSB 取整与正负号展示值。
 * 阈值断言全部相对 FORM_SIMULATION 现算（时区无关，CI=UTC 与本机=UTC+8 都绿）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeTodayAdvice } from '../src/core/today-advice.ts';
import { FORM_SIMULATION } from '../src/core/settings.ts';

const REC = FORM_SIMULATION.tsb_recovery; // -20：generateWorkout 自动降级线
const LOW = FORM_SIMULATION.tsb_low; // -30：深度疲劳线

const advise = (overrides = {}) =>
  computeTodayAdvice({
    tsb: 0,
    trainedToday: false,
    session: null,
    planState: null,
    ...overrides,
  });

test('状态三档：阈值边界两侧分档正确', () => {
  assert.equal(advise({ tsb: REC }).level, 'train'); // 恰在降级线上按能练（generateWorkout 同口径：不小于不降）
  assert.equal(advise({ tsb: REC - 0.1 }).level, 'easy');
  assert.equal(advise({ tsb: LOW }).level, 'easy'); // 恰在深度疲劳线上按轻松练
  assert.equal(advise({ tsb: LOW - 0.1 }).level, 'rest');
  assert.equal(advise({ tsb: 25 }).level, 'train');
});

test('「今天已练」免扰档优先于一切状态档', () => {
  const r = advise({
    tsb: LOW - 5, // 深度疲劳区间
    trainedToday: true,
    session: { type: 'threshold' },
    planState: 'valid',
  });
  assert.equal(r.level, 'done');
  assert.equal(r.workoutTarget, null); // 免扰：不再劝练
  assert.equal(r.deepFatigue, true); // 依据仍如实
});

test('计划交叉：质量课 + 非能练档 → 提示降级/顺延', () => {
  const r = advise({ tsb: REC - 5, session: { type: 'threshold' }, planState: 'valid' });
  assert.equal(r.level, 'easy');
  assert.equal(r.downgrade, true);
  assert.equal(r.planType, 'threshold');
  assert.equal(r.workoutTarget, 'recovery'); // easy 档统一轻松骑
});

test('计划交叉：质量课 + 能练档 → 按计划出对应课表', () => {
  const r = advise({ tsb: 5, session: { type: 'threshold' }, planState: 'valid' });
  assert.equal(r.level, 'train');
  assert.equal(r.downgrade, false);
  assert.equal(r.workoutTarget, 'threshold');
  assert.equal(advise({ tsb: 5, session: { type: 'vo2max' }, planState: 'valid' }).workoutTarget, 'vo2max');
  assert.equal(advise({ tsb: 5, session: { type: 'sweet_spot' }, planState: 'valid' }).workoutTarget, 'sweet_spot');
  assert.equal(advise({ tsb: 5, session: { type: 'long' }, planState: 'valid' }).workoutTarget, 'endurance'); // long 无模板按 endurance
  assert.equal(advise({ tsb: 5, session: { type: 'endurance' }, planState: 'valid' }).workoutTarget, 'endurance');
});

test('计划休息日 / 整日无课：rest 档但不出课表', () => {
  const rest = advise({ tsb: 10, session: { type: 'rest' }, planState: 'valid' });
  assert.equal(rest.level, 'rest');
  assert.equal(rest.planned, true);
  assert.equal(rest.planType, 'rest');
  assert.equal(rest.restDay, true);
  assert.equal(rest.workoutTarget, null);

  const emptyDay = advise({ tsb: 10, session: null, planState: 'valid' });
  assert.equal(emptyDay.level, 'rest');
  assert.equal(emptyDay.planned, false);
  assert.equal(emptyDay.restDay, true); // 整日无课按计划内休息日（校验 R2 同口径）
  assert.equal(emptyDay.workoutTarget, null);
});

test('无生效计划：降级纯状态建议，能练档仍保留自由骑车表出口', () => {
  for (const planState of [null, 'upcoming', 'expired']) {
    const ok = advise({ tsb: 10, planState });
    assert.equal(ok.hasPlan, false);
    assert.equal(ok.level, 'train');
    assert.equal(ok.workoutTarget, 'endurance'); // 自由骑
    assert.equal(ok.downgrade, false);

    const tired = advise({ tsb: REC - 5, planState });
    assert.equal(tired.level, 'easy');
    assert.equal(tired.workoutTarget, 'recovery');
    assert.equal(tired.downgrade, false); // 无计划无所谓「计划质量课降级」

    const deep = advise({ tsb: LOW - 5, planState });
    assert.equal(deep.level, 'rest');
    assert.equal(deep.workoutTarget, null);
  }
});

test('深度疲劳 + 计划质量课：rest 档仍给降级提示且不出课表', () => {
  const r = advise({ tsb: LOW - 5, session: { type: 'threshold' }, planState: 'valid' });
  assert.equal(r.level, 'rest');
  assert.equal(r.downgrade, true);
  assert.equal(r.workoutTarget, null);
});

test('TSB 展示值取整；正数带 + 号由组件拼，本层只出数值', () => {
  assert.equal(advise({ tsb: -15.4 }).tsb, -15);
  assert.equal(advise({ tsb: -15.6 }).tsb, -16);
  assert.equal(advise({ tsb: 3.2 }).tsb, 3);
});
