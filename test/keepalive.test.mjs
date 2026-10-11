/**
 * keepalive.test.mjs — src/ai/keepalive.ts 引用计数壳回归测试（node:test，impl 注入）。
 *
 * 守住口径：首个 acquire 才 start / 并发 acquire 只 start 一次 / 最后一个 release
 * 才 stop / impl 缺失或 start/stop 抛错时整体降级不抛 / start 未落定就 release 时
 * 串行化等待（防 Android 上「stopService 抢在 startForeground 前」的崩溃面）/
 * refs 归零后重复 release 是 no-op。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  acquireGenerationKeepAlive,
  releaseGenerationKeepAlive,
  resetKeepAliveForTests,
} = await import('../src/ai/keepalive.ts');

const TEXT = { title: 'AI 生成进行中', body: '切后台也继续', channel: 'AI 生成' };

/** spy impl：记录调用次数与参数，可按需让 start/stop 抛错或挂起 */
function makeSpyImpl({ failStart = false, failStop = false } = {}) {
  const calls = { start: 0, stop: 0, perm: 0, args: [] };
  return {
    calls,
    start: async (title, body, channel) => {
      calls.start += 1;
      calls.args.push({ title, body, channel });
      if (failStart) throw new Error('start boom');
      return true;
    },
    stop: async () => {
      calls.stop += 1;
      if (failStop) throw new Error('stop boom');
      return true;
    },
    ensureNotificationPermission: async () => {
      calls.perm += 1;
    },
  };
}

test('首次 acquire 启动一次；并发 acquire 不重复 start；最后一次 release 才 stop', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  await acquireGenerationKeepAlive(TEXT);
  await acquireGenerationKeepAlive(TEXT);
  await acquireGenerationKeepAlive(TEXT);
  assert.equal(spy.calls.start, 1);
  assert.deepEqual(spy.calls.args[0], TEXT);

  await releaseGenerationKeepAlive();
  assert.equal(spy.calls.stop, 0); // 还有 2 个持有者
  await releaseGenerationKeepAlive();
  assert.equal(spy.calls.stop, 0); // 还有 1 个持有者
  await releaseGenerationKeepAlive();
  assert.equal(spy.calls.stop, 1); // 最后一个
});

test('refs 归零后再 release 是 no-op（防御 fast-fail 路径的 finally 误停）', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  await releaseGenerationKeepAlive();
  await acquireGenerationKeepAlive(TEXT);
  await releaseGenerationKeepAlive();
  await releaseGenerationKeepAlive();
  await releaseGenerationKeepAlive();
  assert.equal(spy.calls.start, 1);
  assert.equal(spy.calls.stop, 1);
});

test('impl 缺失（iOS/node 环境）时整体 no-op 且不抛错', async () => {
  resetKeepAliveForTests(null);
  await acquireGenerationKeepAlive(TEXT);
  await releaseGenerationKeepAlive();
});

test('start 抛错不冒泡（退回前台等待行为），release 仍正常走 stop', async () => {
  const spy = makeSpyImpl({ failStart: true });
  resetKeepAliveForTests(spy);

  await acquireGenerationKeepAlive(TEXT); // 不抛
  await releaseGenerationKeepAlive();
  assert.equal(spy.calls.start, 1);
  assert.equal(spy.calls.stop, 1);
});

test('stop 抛错不冒泡（通知可能残留，属可接受降级）', async () => {
  const spy = makeSpyImpl({ failStop: true });
  resetKeepAliveForTests(spy);

  await acquireGenerationKeepAlive(TEXT);
  await releaseGenerationKeepAlive(); // 不抛
  assert.equal(spy.calls.stop, 1);
});

test('start 未落定就 release：等 start 完成后才 stop（串行化口径）', async () => {
  let resolveStart;
  const spy = {
    calls: { start: 0, stop: 0, order: [] },
    start: () =>
      new Promise((resolve) => {
        resolveStart = () => {
          spy.calls.order.push('start');
          spy.calls.start += 1;
          resolve(true);
        };
      }),
    stop: async () => {
      spy.calls.order.push('stop');
      spy.calls.stop += 1;
      return true;
    },
  };
  resetKeepAliveForTests(spy);

  const acquireP = acquireGenerationKeepAlive(TEXT); // 不 await：start 挂起中
  const releaseP = releaseGenerationKeepAlive();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(spy.calls.stop, 0); // start 未落定，stop 必须等待

  resolveStart();
  await acquireP;
  await releaseP;
  assert.equal(spy.calls.start, 1);
  assert.equal(spy.calls.stop, 1);
  assert.deepEqual(spy.calls.order, ['start', 'stop']); // 严格先后
});

test('并发交错：A/B 先后 acquire，A 先退场不触发 stop，B 退场才停', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  const a = acquireGenerationKeepAlive(TEXT).then(() => releaseGenerationKeepAlive());
  const b = acquireGenerationKeepAlive(TEXT);
  await Promise.all([a, b]);
  assert.equal(spy.calls.start, 1);
  assert.equal(spy.calls.stop, 0); // B 还持有着

  await releaseGenerationKeepAlive();
  assert.equal(spy.calls.stop, 1);
});

test('首个 acquire 触发通知权限申请（fire-and-forget）', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  await acquireGenerationKeepAlive(TEXT);
  assert.equal(spy.calls.perm, 1);
});

test('真实装载路径在 node 环境失败 → 整体 no-op 且不抛错（loadImpl 兜底分支）', async () => {
  // loaderUnresolved：不注入 impl，让下一次 acquire 走真实动态 import——
  // node:test 里 modules/generation-keepalive（依赖 react-native/expo 原生）必然失败
  resetKeepAliveForTests(null, { loaderUnresolved: true });
  await acquireGenerationKeepAlive(TEXT);
  await releaseGenerationKeepAlive();
});

test('电池白名单查询/申请透传 impl；impl 缺失或抛错一律 false', async () => {
  const { isIgnoringBatteryOptimizations, requestIgnoreBatteryOptimizations } =
    await import('../src/ai/keepalive.ts');

  resetKeepAliveForTests(null);
  assert.equal(await isIgnoringBatteryOptimizations(), false);
  assert.equal(await requestIgnoreBatteryOptimizations(), false);

  resetKeepAliveForTests({
    start: async () => true,
    stop: async () => true,
    isIgnoringBatteryOptimizations: () => true,
    requestIgnoreBatteryOptimizations: async () => true,
  });
  assert.equal(await isIgnoringBatteryOptimizations(), true);
  assert.equal(await requestIgnoreBatteryOptimizations(), true);

  resetKeepAliveForTests({
    start: async () => true,
    stop: async () => true,
    isIgnoringBatteryOptimizations: () => {
      throw new Error('boom');
    },
    requestIgnoreBatteryOptimizations: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(await isIgnoringBatteryOptimizations(), false);
  assert.equal(await requestIgnoreBatteryOptimizations(), false);
});
