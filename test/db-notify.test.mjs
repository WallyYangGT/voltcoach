/**
 * db-notify.test.mjs — 数据失效事件总线（纯函数，node:test 直测）
 *
 * 钉四条口径：① 同一 tick 多次写合并成一轮通知（批量导入不通知 N 次）；
 * ② 域与 uuid 去重且 payload 完整；③ 退订后不再收到；④ listener 抛错不影响
 * 其他订阅方（一个页面重取失败不能拖垮写路径与别的订阅）。
 *
 * 微任务合并靠 queueMicrotask：node:test 里用 `await tick()`（一个宏任务）冲刷。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EMPTY_DB_INVALIDATION,
  invalidateAllDb,
  invalidateDb,
  resetDbInvalidationForTesting,
  subscribeDbInvalidation,
} from '../src/db/notify.ts';

/** 等微任务冲刷完成（flush 在微任务里跑；多让两轮确保链尾也落地） */
const tick = () => new Promise((r) => setTimeout(r, 0));

test('同行级写合并为一轮通知（域去重、uuid 累积）', async () => {
  resetDbInvalidationForTesting();
  const seen = [];
  const off = subscribeDbInvalidation((ev) => seen.push(ev));

  invalidateDb('activities', 'a1');
  invalidateDb('activities', 'a2');
  invalidateDb('activities', 'a1'); // 重复 uuid 去重
  invalidateDb('memories');
  assert.equal(seen.length, 0, '同一 tick 内不立即通知（合并待发）');

  await tick();
  assert.equal(seen.length, 1, '四次写只交付一次');
  assert.deepEqual([...seen[0].domains].sort(), ['activities', 'memories']);
  assert.deepEqual([...seen[0].activityUuids].sort(), ['a1', 'a2']);
  off();
});

test('跨 tick 的写各自成轮（不跨轮聚合丢失时效）', async () => {
  resetDbInvalidationForTesting();
  const seen = [];
  const off = subscribeDbInvalidation((ev) => seen.push(ev));
  invalidateDb('reports');
  await tick();
  invalidateDb('chats');
  await tick();
  assert.equal(seen.length, 2);
  assert.deepEqual([...seen[0].domains], ['reports']);
  assert.deepEqual([...seen[1].domains], ['chats']);
  off();
});

test('退订后不再收到；其他订阅方不受影响', async () => {
  resetDbInvalidationForTesting();
  const a = [];
  const b = [];
  const offA = subscribeDbInvalidation((ev) => a.push(ev));
  const offB = subscribeDbInvalidation((ev) => b.push(ev));

  invalidateDb('plans');
  await tick();
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);

  offA();
  invalidateDb('plans');
  await tick();
  assert.equal(a.length, 1, '已退订不增收');
  assert.equal(b.length, 2);
  offB();
});

test('listener 抛错被隔离：不影响后续订阅方，也不冒泡到写入方', async () => {
  resetDbInvalidationForTesting();
  const good = [];
  const origWarn = console.warn;
  const warns = [];
  console.warn = (...args) => warns.push(args.join(' '));
  const offBad = subscribeDbInvalidation(() => {
    throw new Error('boom');
  });
  const offGood = subscribeDbInvalidation((ev) => good.push(ev));
  try {
    assert.doesNotThrow(() => invalidateDb('dossier'));
    await tick();
    assert.equal(good.length, 1, '坏 listener 之后的订阅方照常收到');
    assert.ok(warns.some((w) => w.includes('db 失效订阅回调失败')));
  } finally {
    console.warn = origWarn;
    offBad();
    offGood();
  }
});

test('invalidateAllDb 覆盖全部域且不带 uuid（整库替换语义）', async () => {
  resetDbInvalidationForTesting();
  const seen = [];
  const off = subscribeDbInvalidation((ev) => seen.push(ev));
  invalidateAllDb();
  await tick();
  assert.equal(seen.length, 1);
  assert.deepEqual([...seen[0].domains].sort(), [
    'activities',
    'aiconfig',
    'athlete',
    'chats',
    'dossier',
    'memories',
    'plans',
    'prefs',
    'profile',
    'reports',
  ]);
  assert.deepEqual(seen[0].activityUuids, []);
  off();
});

test('整库失效与行级写同批合并时压掉 uuid（防订阅方误判为行级事件）', async () => {
  resetDbInvalidationForTesting();
  const seen = [];
  const off = subscribeDbInvalidation((ev) => seen.push(ev));
  // 备份导入换库（全域）与并发行级写落在同一 tick：uuid 必须清空，
  // 否则详情页会因「当前 uuid 不在列表」跳过重取、aiTitle 只清部分起骑时刻缓存
  invalidateAllDb();
  invalidateDb('activities', 'uuid-from-row-write');
  await tick();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].activityUuids, []);
  // 反向顺序同样压掉
  invalidateDb('activities', 'uuid-x');
  invalidateAllDb();
  await tick();
  assert.deepEqual(seen[1].activityUuids, []);
  // 整库失效之后的新一轮行级写恢复正常语义（pendingAll 已复位）
  invalidateDb('activities', 'uuid-y');
  await tick();
  assert.deepEqual(seen[2].activityUuids, ['uuid-y']);
  off();
});

test('无订阅方时写不报错（后台写入早于任何页面挂载）', async () => {
  resetDbInvalidationForTesting();
  assert.doesNotThrow(() => invalidateDb('activities', 'x'));
  await tick();
});

test('EMPTY_DB_INVALIDATION 是空集合（订阅方安全默认值）', () => {
  assert.equal(EMPTY_DB_INVALIDATION.domains.size, 0);
  assert.deepEqual(EMPTY_DB_INVALIDATION.activityUuids, []);
});
