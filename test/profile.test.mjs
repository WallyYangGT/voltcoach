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
  parseStoredProfile,
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

test('NaN/Infinity/字符串与 null patch：非法值报错，null/undefined patch 原样返回', () => {
  for (const bad of [Number.NaN, Infinity, '90']) {
    assert.throws(
      () => normalizeProfilePatch(emptyProfile(), { session_max_min: bad }),
      /session_max_min 需为 10–600 的整数/,
    );
  }
  const current = normalizeProfilePatch(emptyProfile(), { identity: '上班族' });
  assert.deepEqual(normalizeProfilePatch(current, null), current);
  assert.deepEqual(normalizeProfilePatch(current, undefined), current);
});

test('合并结果只含六个业务字段（不泄漏 configured 派生值到 settings JSON）', () => {
  // 生产路径的 current 是 db 的 RiderProfile（带 configured）；展开会把派生值写进备份
  const merged = normalizeProfilePatch(
    { ...emptyProfile(), identity: '上班族', configured: true },
    { coach_mode: 'amateur' },
  );
  assert.deepEqual(Object.keys(merged).sort(), [
    'available_days',
    'coach_mode',
    'goal',
    'identity',
    'session_max_min',
    'weekly_hours',
  ]);
});

test('容错解析旧行/损坏行/未知值：缺字段按空、非法枚举归 null、可用日过滤排序', () => {
  // 旧版本只有 identity/goal
  assert.deepEqual(parseStoredProfile({ identity: '上班族', goal: '200km' }), {
    ...emptyProfile(),
    identity: '上班族',
    goal: '200km',
  });
  // 损坏行/非对象
  assert.deepEqual(parseStoredProfile(null), emptyProfile());
  assert.deepEqual(parseStoredProfile('broken'), emptyProfile());
  // 未知枚举/越界值归 null；可用日过滤非法项并去重升序
  const parsed = parseStoredProfile({
    coach_mode: 'pro',
    weekly_hours: '2h',
    session_max_min: 900,
    available_days: [5, 2, 2, 9, 0, '3'],
  });
  assert.equal(parsed.coach_mode, null);
  assert.equal(parsed.weekly_hours, null);
  assert.equal(parsed.session_max_min, null);
  assert.deepEqual(parsed.available_days, [2, 5]);
  // 未来未知字段不影响已知字段
  assert.equal(parseStoredProfile({ coach_mode: 'amateur', future_field: 1 }).coach_mode, 'amateur');
});
