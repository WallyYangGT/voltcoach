/**
 * records-layout.test.mjs — v2 → v3 records 文件布局迁移计划（纯函数，node:test）
 *
 * 覆盖：旧基名 → uuid 复制、共享旧基名复制多份、目标已存在跳过、旧基名最终删除、
 * 孤儿文件不动、重跑幂等、非法 uuid 防御。执行侧 IO（复制/删除）由 L3 冒烟覆盖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  isActivityRecordBase,
  planRecordLayout,
  recordBaseFromFileName,
} from '../src/core/records.ts';

const uid = (c) => c.repeat(32);

test('recordBaseFromFileName：去最后一个扩展名并保持 basename 安全口径', () => {
  assert.equal(recordBaseFromFileName('ride.fit'), 'ride');
  assert.equal(recordBaseFromFileName('ride.FIT'), 'ride');
  assert.equal(recordBaseFromFileName('dir/ride.fit'), null); // 带路径 → safeName 拒绝
  assert.equal(recordBaseFromFileName('..fit'), null);
});

test('isActivityRecordBase：只认 32 位小写 hex', () => {
  assert.equal(isActivityRecordBase(uid('a')), true);
  assert.equal(isActivityRecordBase('A'.repeat(32)), false);
  assert.equal(isActivityRecordBase('a'.repeat(31)), false);
  assert.equal(isActivityRecordBase('ride'), false);
});

test('planRecordLayout：旧基名复制到 uuid，全部复制后删旧文件', () => {
  const activities = [
    { uuid: uid('a'), file_name: 'ride.fit' },
    { uuid: uid('b'), file_name: 'ride.FIT' }, // 旧布局下与上面共享 base
  ];
  const plan = planRecordLayout(activities, ['ride']);
  assert.deepEqual(plan.copies, [
    { from: 'ride', to: uid('a') },
    { from: 'ride', to: uid('b') },
  ]);
  assert.deepEqual(plan.deletes, ['ride']);
});

test('planRecordLayout：目标已存在不再复制（幂等重跑）', () => {
  const activities = [
    { uuid: uid('a'), file_name: 'ride.fit' },
    { uuid: uid('b'), file_name: 'ride.FIT' },
  ];
  const plan = planRecordLayout(activities, [uid('a'), 'ride']);
  assert.deepEqual(plan.copies, [{ from: 'ride', to: uid('b') }]);
  assert.deepEqual(plan.deletes, ['ride']);

  const rerun = planRecordLayout(activities, [uid('a'), uid('b')]);
  assert.deepEqual(rerun, { copies: [], deletes: [] });
});

test('planRecordLayout：旧文件缺失时计划为空（删除侧自然幂等）', () => {
  const plan = planRecordLayout([{ uuid: uid('a'), file_name: 'gone.fit' }], []);
  assert.deepEqual(plan, { copies: [], deletes: [] });
});

test('planRecordLayout：不属于任何活动的孤儿文件不动', () => {
  const plan = planRecordLayout([{ uuid: uid('a'), file_name: 'ride.fit' }], [uid('a'), 'orphan']);
  assert.deepEqual(plan, { copies: [], deletes: [] });
});

test('planRecordLayout：旧基名恰是别的活动 uuid 时不删', () => {
  const other = uid('b');
  const activities = [
    { uuid: uid('a'), file_name: `${other}.fit` }, // 旧 base 撞上 b 的 uuid
    { uuid: other, file_name: 'b.fit' },
  ];
  const plan = planRecordLayout(activities, [other]);
  assert.ok(plan.copies.some((c) => c.to === uid('a')));
  assert.deepEqual(plan.deletes, []); // other 是活动 uuid 目标，不能删
});

test('planRecordLayout：非法 uuid 行不参与改名', () => {
  const plan = planRecordLayout([{ uuid: 'not-a-uuid', file_name: 'ride.fit' }], ['ride']);
  assert.deepEqual(plan, { copies: [], deletes: [] });
});
