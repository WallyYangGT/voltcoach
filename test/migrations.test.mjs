/**
 * migrations.test.mjs — schema 迁移步骤表纯函数测试（node:test）
 *
 * 覆盖：当前版本、v1→2 的 ALTER 顺序、v2→3 的表重建步骤、已是最新返回空表、
 * 方向/越界/非整数防御。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrationsFor, SCHEMA_VERSION } from '../src/db/migrations.ts';

test('当前 schema 版本为 3', () => {
  assert.equal(SCHEMA_VERSION, 3);
});

test('v1→2：两条 ALTER（记忆 scope + 功率标记），顺序稳定', () => {
  const steps = migrationsFor(1, 2);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, 'sql');
  assert.match(steps[0].sql, /ALTER TABLE ai_memories ADD COLUMN scope/);
  assert.equal(steps[1].kind, 'sql');
  assert.match(steps[1].sql, /ALTER TABLE activities ADD COLUMN power_flagged/);
});

test('v2→3：一个表重建步骤（uuid/外键/指纹）', () => {
  const steps = migrationsFor(2, 3);
  assert.deepEqual(steps, [{ kind: 'rebuild-v3' }]);
});

test('v1→3：v1→2 两条 ALTER + v3 重建，顺序稳定', () => {
  const steps = migrationsFor(1, 3);
  assert.equal(steps.length, 3);
  assert.equal(steps[0].kind, 'sql');
  assert.equal(steps[1].kind, 'sql');
  assert.equal(steps[2].kind, 'rebuild-v3');
});

test('from === to：返回空表（已是最新）', () => {
  assert.deepEqual(migrationsFor(3, 3), []);
  assert.deepEqual(migrationsFor(2, 2), []);
  assert.deepEqual(migrationsFor(1, 1), []);
});

test('非法输入防御：非整数/无表版本/方向逆转/超出支持', () => {
  assert.throws(() => migrationsFor(1.5, 3), /整数/);
  assert.throws(() => migrationsFor(0, 3), /建库脚本/);
  assert.throws(() => migrationsFor(4, 3), /不可逆/);
  assert.throws(() => migrationsFor(2, 4), /超出/);
});
