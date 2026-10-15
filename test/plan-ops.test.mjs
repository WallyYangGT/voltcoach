/**
 * plan-ops.test.mjs — 训练计划课次级操作原语测试（node:test，U1 收尾：局部调整）
 *
 * 覆盖：六操作原语快乐路径（move/swap/set_type/set_duration/remove/insert）、
 * 逐操作边界（目标占用提示 swap/remove+insert、源日无课、历史日期拒、越窗拒、
 * rest 改训练课缺时长拒、对 rest 改时长拒）、原子性（任一失败整批拒且不返半改
 * 状态）、set_type/set_duration 后 TSS 置空由 resolvePlanTss 重估、全计划合理性
 * 复检（质量课间隔违规硬拒且锚定两课日期）、ops 数量上限与未知操作名。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPlanSessionOps, PLAN_OPS_MAX } from '../src/core/plan-ops.ts';

const TODAY = '2026-10-13'; // 周二

const s = (date, type, duration_min, tss = null, note = null) => ({
  date,
  type,
  duration_min,
  intensity: type === 'rest' ? null : '区间',
  tss,
  note,
});

/** 夹具计划：**进行中计划**（valid_from = today-10，code-review P1-1 的逃逸场景——
 *  旧夹具 valid_from=today-1「刚生成的窗」结构性绕过了 valid_from 回看墙）；窗
 *  10-03 ~ 10-25，10-12（已过去）endurance / 10-13 today threshold / 10-14 rest /
 *  10-15 endurance / 10-17 rest / 10-19 sweet_spot / 10-21 rest（质量课间隔 6 天） */
const plan = () => ({
  valid_from: '2026-10-03',
  valid_to: '2026-10-25',
  goal: '基础期',
  sessions: [
    s('2026-10-12', 'endurance', 75, 48),
    s('2026-10-13', 'threshold', 75, 85),
    s('2026-10-14', 'rest', null, 0),
    s('2026-10-15', 'endurance', 90, 62),
    s('2026-10-17', 'rest', null, 0),
    s('2026-10-19', 'sweet_spot', 60, 55),
    s('2026-10-21', 'rest', null, 0),
  ],
});

test('move：移动到空闲日，课次内容（含 TSS）随行', () => {
  const r = applyPlanSessionOps(plan(), [{ op: 'move', from: '2026-10-15', to: '2026-10-16' }], TODAY);
  assert.equal(r.ok, true);
  assert.deepEqual(r.applied, [{ op: 'move', from: '2026-10-15', to: '2026-10-16' }]);
  const moved = r.plan.sessions.find((x) => x.date === '2026-10-16');
  assert.equal(moved.type, 'endurance');
  assert.equal(moved.tss, 62); // 原值随行
  assert.equal(r.plan.sessions.some((x) => x.date === '2026-10-15'), false);
});

test('move：目标日已有课 → 拒并提示 swap 或 remove+insert', () => {
  const r = applyPlanSessionOps(plan(), [{ op: 'move', from: '2026-10-15', to: '2026-10-19' }], TODAY);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /swap/);
  assert.equal(r.plan, null);
});

test('move：源日无课 / 历史日期 / 越窗 三类拒绝', () => {
  const noSession = applyPlanSessionOps(plan(), [{ op: 'move', from: '2026-10-16', to: '2026-10-18' }], TODAY);
  assert.match(noSession.errors[0], /没有课/);

  const past = applyPlanSessionOps(plan(), [{ op: 'move', from: '2026-10-12', to: '2026-10-16' }], TODAY);
  assert.match(past.errors[0], /过去/); // 10-12 早于今天

  const outOfWindow = applyPlanSessionOps(plan(), [{ op: 'move', from: '2026-10-15', to: '2026-10-26' }], TODAY);
  assert.match(outOfWindow.errors[0], /超出计划有效期/);
});

test('swap：互换两天课次（含 rest 课与训练课互换）', () => {
  const r = applyPlanSessionOps(plan(), [{ op: 'swap', a: '2026-10-14', b: '2026-10-15' }], TODAY);
  assert.equal(r.ok, true);
  const byDate = Object.fromEntries(r.plan.sessions.map((x) => [x.date, x]));
  assert.equal(byDate['2026-10-14'].type, 'endurance');
  assert.equal(byDate['2026-10-15'].type, 'rest');
  assert.equal(byDate['2026-10-15'].duration_min, null);
});

test('swap：任一侧无课拒绝', () => {
  const r = applyPlanSessionOps(plan(), [{ op: 'swap', a: '2026-10-15', b: '2026-10-16' }], TODAY);
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /没有课/);
});

test('set_type：训练课改课型后 TSS 置空按新课型重估', () => {
  const r = applyPlanSessionOps(plan(), [{ op: 'set_type', date: '2026-10-15', type: 'threshold', duration_min: 60 }], TODAY);
  assert.equal(r.ok, true);
  const changed = r.plan.sessions.find((x) => x.date === '2026-10-15');
  assert.equal(changed.type, 'threshold');
  assert.equal(changed.duration_min, 60);
  assert.equal(changed.tss, 100); // 60min × 60 × 1.0² / 36
});

test('set_type：改成 rest 清空时长与强度、TSS 归 0', () => {
  const r = applyPlanSessionOps(plan(), [{ op: 'set_type', date: '2026-10-15', type: 'rest' }], TODAY);
  assert.equal(r.ok, true);
  const changed = r.plan.sessions.find((x) => x.date === '2026-10-15');
  assert.equal(changed.type, 'rest');
  assert.equal(changed.duration_min, null);
  assert.equal(changed.tss, 0);
});

test('set_type：rest 改训练课缺时长拒绝；未知课型拒绝', () => {
  const needDuration = applyPlanSessionOps(plan(), [{ op: 'set_type', date: '2026-10-14', type: 'endurance' }], TODAY);
  assert.match(needDuration.errors[0], /duration_min/);

  const badType = applyPlanSessionOps(plan(), [{ op: 'set_type', date: '2026-10-15', type: 'sprint' }], TODAY);
  assert.match(badType.errors[0], /sprint/);
});

test('set_duration：改时长后 TSS 按新时长重估；对 rest 改时长拒绝', () => {
  const r = applyPlanSessionOps(plan(), [{ op: 'set_duration', date: '2026-10-15', duration_min: 120 }], TODAY);
  assert.equal(r.ok, true);
  const changed = r.plan.sessions.find((x) => x.date === '2026-10-15');
  assert.equal(changed.duration_min, 120);
  assert.equal(changed.tss, 92.5); // 120×60×0.68²/36

  const onRest = applyPlanSessionOps(plan(), [{ op: 'set_duration', date: '2026-10-14', duration_min: 60 }], TODAY);
  assert.match(onRest.errors[0], /休息日/);
});

test('remove / insert：删课与插课（插课 TSS 由课型×时长回填）', () => {
  const removed = applyPlanSessionOps(plan(), [{ op: 'remove', date: '2026-10-15' }], TODAY);
  assert.equal(removed.ok, true);
  assert.equal(removed.plan.sessions.some((x) => x.date === '2026-10-15'), false);

  const inserted = applyPlanSessionOps(
    plan(),
    [{ op: 'insert', date: '2026-10-16', type: 'endurance', duration_min: 45, note: '加练有氧' }],
    TODAY,
  );
  assert.equal(inserted.ok, true);
  const added = inserted.plan.sessions.find((x) => x.date === '2026-10-16');
  assert.equal(added.tss, 34.7); // 45×60×0.68²/36
  assert.equal(added.note, '加练有氧');

  const occupied = applyPlanSessionOps(plan(), [{ op: 'insert', date: '2026-10-15', type: 'endurance', duration_min: 45 }], TODAY);
  assert.match(occupied.errors[0], /已有课/);

  const removeEmpty = applyPlanSessionOps(plan(), [{ op: 'remove', date: '2026-10-16' }], TODAY);
  assert.match(removeEmpty.errors[0], /没有课/);
});

test('原子性：合法操作 + 非法操作 → 整批拒绝，不返回半改状态', () => {
  const r = applyPlanSessionOps(
    plan(),
    [
      { op: 'move', from: '2026-10-15', to: '2026-10-16' }, // 合法
      { op: 'remove', date: '2026-10-15' }, // 此时 10-15 已空 → 失败
    ],
    TODAY,
  );
  assert.equal(r.ok, false);
  assert.equal(r.plan, null);
  assert.equal(r.applied.length, 0);
});

test('全计划合理性复检：改出质量课间隔 <2 天 → violations 硬拒并锚定两课', () => {
  // 10-14（rest）改成 threshold → 与 10-13 的 threshold 仅隔 1 天
  const r = applyPlanSessionOps(
    plan(),
    [{ op: 'set_type', date: '2026-10-14', type: 'threshold', duration_min: 60 }],
    TODAY,
  );
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 0);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].code, 'quality_gap');
  assert.equal(r.violations[0].vars.a, '2026-10-13');
  assert.equal(r.violations[0].vars.b, '2026-10-14');
});

test('顺序语义：后续操作看到前面操作的结果（先 move 腾位再 insert 原位）', () => {
  const r = applyPlanSessionOps(
    plan(),
    [
      { op: 'move', from: '2026-10-15', to: '2026-10-16' },
      { op: 'insert', date: '2026-10-15', type: 'recovery', duration_min: 30 },
    ],
    TODAY,
  );
  assert.equal(r.ok, true);
  assert.equal(r.plan.sessions.find((x) => x.date === '2026-10-15').type, 'recovery');
  assert.equal(r.plan.sessions.find((x) => x.date === '2026-10-16').type, 'endurance');
  assert.equal(r.applied.length, 2);
});

test('P1-1 回归：进行中计划（valid_from 早于 7 天墙）局部调整不受 valid_from 回看墙拒绝', () => {
  // adjust 档对同一窗会报 from_past 硬错；ops 档豁免（valid_from 是 App 存量值非模型输入）
  const r = applyPlanSessionOps(plan(), [{ op: 'move', from: '2026-10-15', to: '2026-10-16' }], TODAY);
  assert.equal(r.ok, true);
  assert.equal(applyPlanSessionOps(plan(), [{ op: 'remove', date: '2026-10-15' }], TODAY).ok, true);
});

test('P2-2：move/swap 源与目标同日 → 拒绝（防零效果操作落新版本谎报已调整）', () => {
  const mv = applyPlanSessionOps(plan(), [{ op: 'move', from: '2026-10-15', to: '2026-10-15' }], TODAY);
  assert.equal(mv.ok, false);
  assert.match(mv.errors[0], /相同/);
  const sw = applyPlanSessionOps(plan(), [{ op: 'swap', a: '2026-10-15', b: '2026-10-15' }], TODAY);
  assert.equal(sw.ok, false);
  assert.match(sw.errors[0], /相同/);
});

test('ops 空 / 超上限 / 未知操作名', () => {
  assert.match(applyPlanSessionOps(plan(), [], TODAY).errors[0], /非空/);
  const tooMany = applyPlanSessionOps(plan(), Array.from({ length: PLAN_OPS_MAX + 1 }, () => ({ op: 'remove', date: '2026-10-15' })), TODAY);
  assert.match(tooMany.errors[0], /最多/);
  const badOp = applyPlanSessionOps(plan(), [{ op: 'shuffle' }], TODAY);
  assert.match(badOp.errors[0], /结构不完整/);
});
