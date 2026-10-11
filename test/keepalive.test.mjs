/**
 * keepalive.test.mjs — src/ai/keepalive.ts 保活壳回归测试（node:test，impl 注入）。
 *
 * 守住口径：首个 acquire 才 start（并发共用一次启动）/ 只有全部句柄 release 后才
 * stop / 句柄制防偷引用（重复 release、未配对 release 都是 no-op）/ 操作队列串行化
 * （start 未落定就 release 会等待；release 窗口内的新 acquire 由自己的 start 兜住，
 * 不会被旧 release 的 stop 误杀——code-review P1-3）/ impl 缺失或 start/stop 抛错
 * 整体降级不抛 / 装载 promise 缓存（并发装载共享同一结果——code-review P2-1）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  acquireGenerationKeepAlive,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  areNotificationsEnabled,
  resetKeepAliveForTests,
} = await import('../src/ai/keepalive.ts');

const TEXT = { title: 'AI 生成进行中', body: '切后台也继续', channel: 'AI 生成' };

/** spy impl：记录调用次数与参数，可按需让 start/stop 抛错或挂起 */
function makeSpyImpl({ failStart = false, failStop = false } = {}) {
  const calls = { start: 0, stop: 0, perm: 0, args: [], order: [] };
  return {
    calls,
    start: async (title, body, channel) => {
      calls.start += 1;
      calls.order.push('start');
      calls.args.push({ title, body, channel });
      if (failStart) throw new Error('start boom');
      return true;
    },
    stop: async () => {
      calls.stop += 1;
      calls.order.push('stop');
      if (failStop) throw new Error('stop boom');
      return true;
    },
    ensureNotificationPermission: async () => {
      calls.perm += 1;
    },
  };
}

test('首次 acquire 启动一次；并发 acquire 共用；全部 release 后才 stop', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  const a = await acquireGenerationKeepAlive(TEXT);
  const b = await acquireGenerationKeepAlive(TEXT);
  const c = await acquireGenerationKeepAlive(TEXT);
  assert.equal(spy.calls.start, 1);
  assert.deepEqual(spy.calls.args[0], TEXT);

  await a.release();
  assert.equal(spy.calls.stop, 0); // 还有 2 个持有者
  await b.release();
  assert.equal(spy.calls.stop, 0); // 还有 1 个持有者
  await c.release();
  assert.equal(spy.calls.stop, 1); // 最后一个
});

test('同一句柄重复 release 是 no-op（不偷引用）', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  const a = await acquireGenerationKeepAlive(TEXT);
  const b = await acquireGenerationKeepAlive(TEXT);
  await a.release();
  await a.release(); // 重复释放
  await a.release();
  assert.equal(spy.calls.stop, 0); // b 还持有着，不得被 a 的重复 release 误停

  await b.release();
  assert.equal(spy.calls.stop, 1);
});

test('impl 缺失（iOS/node 环境）时整体 no-op 且不抛错', async () => {
  resetKeepAliveForTests(null);
  const a = await acquireGenerationKeepAlive(TEXT);
  await a.release();
});

test('start 抛错不冒泡（退回前台等待行为），release 仍正常走 stop', async () => {
  const spy = makeSpyImpl({ failStart: true });
  resetKeepAliveForTests(spy);

  const a = await acquireGenerationKeepAlive(TEXT); // 不抛
  await a.release();
  assert.equal(spy.calls.start, 1);
  assert.equal(spy.calls.stop, 1);
});

test('stop 抛错不冒泡（通知可能残留，属可接受降级）', async () => {
  const spy = makeSpyImpl({ failStop: true });
  resetKeepAliveForTests(spy);

  const a = await acquireGenerationKeepAlive(TEXT);
  await a.release(); // 不抛
  assert.equal(spy.calls.stop, 1);
});

test('stop 挂起窗口内的新 acquire：队列串行化保证 start,stop,start 次序', async () => {
  // 句柄制下「release 早于自己的 acquire resolve」不可达（调用方必须先拿到句柄），
  // 串行化的可达验证场景是：stop 挂起时新 acquire 入队——它的 start 必须排在
  // stop 之后（旧 stop 不会吃掉新 acquire 的保活，code-review P1-3 的队列解法）。
  let resolveStop;
  const spy = {
    calls: { order: [] },
    start: async () => {
      spy.calls.order.push('start');
      return true;
    },
    // 只有第一次 stop 挂起（由测试手动放行）；后续 stop 立即返回——否则末尾的
    // c.release() 会等一个无人 resolve 的新 promise（用例自身的 spy 缺陷）
    stop: () => {
      if (resolveStop) {
        spy.calls.order.push('stop');
        return Promise.resolve(true);
      }
      return new Promise((r) => {
        resolveStop = () => {
          spy.calls.order.push('stop');
          r(true);
        };
      });
    },
  };
  resetKeepAliveForTests(spy);

  const a = await acquireGenerationKeepAlive(TEXT);
  const releaseP = a.release(); // stop 挂起中
  const cP = acquireGenerationKeepAlive(TEXT); // 入队，排在该 stop 之后
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(spy.calls.order, ['start']); // stop 未落定，C 的 start 必须等待

  resolveStop();
  await releaseP;
  const c = await cP;
  assert.deepEqual(spy.calls.order, ['start', 'stop', 'start']); // C 的 start 兜在其后
  await c.release();
  assert.deepEqual(spy.calls.order, ['start', 'stop', 'start', 'stop']);
});

test('P1-3 竞态：A 退场窗口内新 acquire 入队，服务在仍有持有者期间不停', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  const a = await acquireGenerationKeepAlive(TEXT);
  const b = await acquireGenerationKeepAlive(TEXT);
  assert.equal(spy.calls.start, 1); // 共用一次启动

  // A 退场、紧接着 C 新 acquire 入队：队列 FIFO 下 R(A) 先于 C 执行——
  // R 删掉 A 后仍有 B 持有（size=1）→ 不停服；C 入队后 size=2 → 不重复 start
  const aRelease = a.release();
  const c = await acquireGenerationKeepAlive(TEXT);
  await aRelease;

  assert.equal(spy.calls.start, 1);
  assert.equal(spy.calls.stop, 0); // B 还持有着，A 的退场不得停服

  await b.release();
  assert.equal(spy.calls.stop, 0); // C 还持有着

  await c.release();
  assert.equal(spy.calls.stop, 1); // 全部退场后才真正停
  assert.deepEqual(spy.calls.order, ['start', 'stop']);
});

test('P1-2 竞态：fast-fail 任务（句柄为 null）不调用 release，不影响持有者', async () => {
  // aiGenerate 侧 fast-fail 时 keepAlive=null、finally 是 keepAlive?.release()——
  // 这里钉住「没有句柄就碰不到计数」的结构性质：仅有的持有者退场前 stop 不发生。
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  const a = await acquireGenerationKeepAlive(TEXT);
  // 模拟 fast-fail：没有任何额外 release 被调用
  await a.release();
  assert.equal(spy.calls.stop, 1);
  assert.deepEqual(spy.calls.order, ['start', 'stop']);
});

test('首个 acquire 触发通知权限申请（fire-and-forget）', async () => {
  const spy = makeSpyImpl();
  resetKeepAliveForTests(spy);

  await acquireGenerationKeepAlive(TEXT);
  await new Promise((r) => setTimeout(r, 5)); // fire-and-forget，让微任务落地
  assert.equal(spy.calls.perm, 1);
});

test('真实装载路径在 node 环境失败 → 整体 no-op 且不抛错（loadImpl 兜底分支）', async () => {
  // loaderUnresolved：不注入 impl，让下一次装载走真实动态 import——
  // node:test 里 modules/generation-keepalive（静态依赖 react-native）必然失败
  resetKeepAliveForTests(null, { loaderUnresolved: true });
  const a = await acquireGenerationKeepAlive(TEXT);
  await a.release();
});

test('装载 promise 缓存：并发查询共享同一装载结果（P2-1）', async () => {
  resetKeepAliveForTests(null, { loaderUnresolved: true });
  // 并发触发两次装载：promise 缓存下两条查询都拿到同一结果（false），不抛错
  const [p, q] = await Promise.all([
    isIgnoringBatteryOptimizations(),
    isIgnoringBatteryOptimizations(),
  ]);
  assert.equal(p, false);
  assert.equal(q, false);
});

test('电池白名单/通知权限查询透传 impl；impl 缺失或抛错一律 false', async () => {
  resetKeepAliveForTests(null);
  assert.equal(await isIgnoringBatteryOptimizations(), false);
  assert.equal(await requestIgnoreBatteryOptimizations(), false);
  assert.equal(await areNotificationsEnabled(), false);

  resetKeepAliveForTests({
    start: async () => true,
    stop: async () => true,
    isIgnoringBatteryOptimizations: () => true,
    requestIgnoreBatteryOptimizations: async () => true,
    areNotificationsEnabled: () => true,
  });
  assert.equal(await isIgnoringBatteryOptimizations(), true);
  assert.equal(await requestIgnoreBatteryOptimizations(), true);
  assert.equal(await areNotificationsEnabled(), true);

  resetKeepAliveForTests({
    start: async () => true,
    stop: async () => true,
    isIgnoringBatteryOptimizations: () => {
      throw new Error('boom');
    },
    requestIgnoreBatteryOptimizations: async () => {
      throw new Error('boom');
    },
    areNotificationsEnabled: () => {
      throw new Error('boom');
    },
  });
  assert.equal(await isIgnoringBatteryOptimizations(), false);
  assert.equal(await requestIgnoreBatteryOptimizations(), false);
  assert.equal(await areNotificationsEnabled(), false);
});
