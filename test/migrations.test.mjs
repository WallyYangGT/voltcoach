/**
 * migrations.test.mjs — schema 迁移步骤表纯函数测试（node:test）
 *
 * 覆盖：当前版本、v1→2 的 ALTER 顺序、v2→3 的表重建步骤、v3→4 的记忆清除列、
 * 已是最新返回空表、方向/越界/非整数防御。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrationsFor, SCHEMA_VERSION } from '../src/db/migrations.ts';

test('当前 schema 版本为 4', () => {
  assert.equal(SCHEMA_VERSION, 4);
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

test('v3→4：加列 superseded_at + 存量被取代行回填', () => {
  const steps = migrationsFor(3, 4);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].kind, 'sql');
  assert.match(steps[0].sql, /ALTER TABLE ai_memories ADD COLUMN superseded_at/);
  assert.equal(steps[1].kind, 'sql');
  // 回填口径：正常行取取代者 created_at，悬空指针回填迁移时刻
  assert.match(steps[1].sql, /COALESCE\(\s*\(SELECT m2\.created_at/);
  assert.match(steps[1].sql, /WHERE superseded_by IS NOT NULL AND superseded_at IS NULL/);
});

test('v1→4：v1→2 两条 ALTER + v3 重建 + v4 两条 sql，顺序稳定', () => {
  const steps = migrationsFor(1, 4);
  assert.equal(steps.length, 5);
  assert.equal(steps[0].kind, 'sql');
  assert.equal(steps[1].kind, 'sql');
  assert.equal(steps[2].kind, 'rebuild-v3');
  assert.equal(steps[3].kind, 'sql');
  assert.equal(steps[4].kind, 'sql');
});

test('from === to：返回空表（已是最新）', () => {
  assert.deepEqual(migrationsFor(4, 4), []);
  assert.deepEqual(migrationsFor(3, 3), []);
  assert.deepEqual(migrationsFor(2, 2), []);
  assert.deepEqual(migrationsFor(1, 1), []);
});

test('非法输入防御：非整数/无表版本/方向逆转/超出支持', () => {
  assert.throws(() => migrationsFor(1.5, 4), /整数/);
  assert.throws(() => migrationsFor(0, 4), /建库脚本/);
  assert.throws(() => migrationsFor(5, 4), /不可逆/);
  assert.throws(() => migrationsFor(2, 5), /超出/);
});
