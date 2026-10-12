/**
 * migrations.test.mjs — 训练库 schema 迁移步骤表纯函数测试（node:test）
 *
 * 覆盖：v1→2 的步进语句内容与顺序、已是最新返回空表、方向/越界/非整数防御。
 * 迁移在设备侧由 db 层 migrateSchema 执行（SQLCipher 库无法在 node 内开），
 * 本文件钉住步骤表的纯函数口径。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { migrationsFor, SCHEMA_VERSION } from '../src/db/migrations.ts';

test('当前 schema 版本为 2', () => {
  assert.equal(SCHEMA_VERSION, 2);
});

test('v1→2：两条 ALTER（记忆 scope + 功率标记），顺序稳定', () => {
  const steps = migrationsFor(1, 2);
  assert.equal(steps.length, 2);
  assert.match(steps[0], /ALTER TABLE ai_memories ADD COLUMN scope/);
  assert.match(steps[1], /ALTER TABLE activities ADD COLUMN power_flagged/);
});

test('from === to：返回空表（已是最新）', () => {
  assert.deepEqual(migrationsFor(2, 2), []);
  assert.deepEqual(migrationsFor(1, 1), []);
});

test('非法输入防御：非整数/无表版本/方向逆转/超出支持', () => {
  assert.throws(() => migrationsFor(1.5, 2), /整数/);
  assert.throws(() => migrationsFor(0, 2), /建库脚本/);
  assert.throws(() => migrationsFor(3, 2), /不可逆/);
  assert.throws(() => migrationsFor(2, 3), /超出/);
});
