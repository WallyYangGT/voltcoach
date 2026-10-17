/**
 * profile.test.mjs — 骑手档案纯校验/合并层（src/core/profile）。
 *
 * 档案存 settings 表 profile JSON 行（无 schema 迁移）；写入路径有设置页与 AI 工具
 * 两条，本层是两者共用的单一校验口径。重点钉住：局部更新不清空其他字段、非法值
 * 双语报错、可用日去重升序、空档案判定（db 层据此删行）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  emptyProfile,
  isProfileEmpty,
  normalizeProfilePatch,
} = await import('../src/core/profile.ts');

test('空档案：全空判定 + 首次局部更新', () => {
  const empty = emptyProfile();
  assert.equal(isProfileEmpty(empty), true);
  const p = normalizeProfilePatch(empty, { coach_mode: 'amateur' });
  assert.equal(p.coach_mode, 'amateur');
  assert.equal(isProfileEmpty(p), false);
  // 入参不被修改
  assert.equal(empty.coach_mode, null);
});

test('局部更新：未提供的字段保持原值（设置页保存身份不冲掉模式/时间预算）', () => {
  const current = normalizeProfilePatch(emptyProfile(), {
    identity: '上班族',
    coach_mode: 'amateur',
    weekly_hours: '3to5',
    available_days: [1, 3, 5],
    session_max_min: 90,
  });
  const next = normalizeProfilePatch(current, { goal: '保持健康' });
  assert.equal(next.identity, '上班族');
  assert.equal(next.goal, '保持健康');
  assert.equal(next.coach_mode, 'amateur');
  assert.equal(next.weekly_hours, '3to5');
  assert.deepEqual(next.available_days, [1, 3, 5]);
  assert.equal(next.session_max_min, 90);
});

test('清空字段：null 清模式/时长档/单次上限，空数组清可用日', () => {
  const current = normalizeProfilePatch(emptyProfile(), {
    coach_mode: 'standard',
    weekly_hours: 'gt8',
    available_days: [2, 4],
    session_max_min: 120,
  });
  const next = normalizeProfilePatch(current, {
    coach_mode: null,
    weekly_hours: null,
    available_days: [],
    session_max_min: null,
  });
  assert.equal(next.coach_mode, null);
  assert.equal(next.weekly_hours, null);
  assert.deepEqual(next.available_days, []);
  assert.equal(next.session_max_min, null);
  assert.equal(isProfileEmpty(next), true);
});

test('可用日：去重、升序、1–7 边界；字符串/越界/非整数报错', () => {
  const p = normalizeProfilePatch(emptyProfile(), { available_days: [7, 1, 3, 3] });
  assert.deepEqual(p.available_days, [1, 3, 7]);
  for (const bad of [[0], [8], ['3'], [1.5]]) {
    assert.throws(
      () => normalizeProfilePatch(emptyProfile(), { available_days: bad }),
      /available_days/,
    );
  }
  assert.throws(
    () => normalizeProfilePatch(emptyProfile(), { available_days: '1,3' }),
    /available_days/,
  );
});

test('枚举与范围：模式/时长档非法报错，单次上限 10–600 整数', () => {
  assert.throws(
    () => normalizeProfilePatch(emptyProfile(), { coach_mode: 'pro' }),
    /coach_mode 取值非法/,
  );
  assert.throws(
    () => normalizeProfilePatch(emptyProfile(), { weekly_hours: '2h' }),
    /weekly_hours 取值非法/,
  );
  for (const bad of [9, 601, 90.5]) {
    assert.throws(
      () => normalizeProfilePatch(emptyProfile(), { session_max_min: bad }),
      /session_max_min 需为 10–600 的整数/,
    );
  }
  assert.equal(normalizeProfilePatch(emptyProfile(), { session_max_min: 10 }).session_max_min, 10);
  assert.equal(
    normalizeProfilePatch(emptyProfile(), { session_max_min: 600 }).session_max_min,
    600,
  );
});

test('身份/目标：trim、长度上限、类型校验（双语消息）', () => {
  assert.equal(normalizeProfilePatch(emptyProfile(), { identity: '  上班族  ' }).identity, '上班族');
  assert.throws(
    () => normalizeProfilePatch(emptyProfile(), { identity: 'x'.repeat(101) }),
    /identity 过长（上限 100 字）/,
  );
  assert.throws(
    () => normalizeProfilePatch(emptyProfile(), { goal: 'x'.repeat(501) }),
    /goal 过长（上限 500 字）/,
  );
  assert.throws(
    () => normalizeProfilePatch(emptyProfile(), { identity: 42 }),
    /identity 需为字符串/,
  );
  assert.throws(
    () => normalizeProfilePatch(emptyProfile(), { session_max_min: 700 }, 'en'),
    /session_max_min must be an integer from 10–600/,
  );
});
