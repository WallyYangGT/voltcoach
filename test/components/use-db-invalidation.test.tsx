/**
 * use-db-invalidation.test.tsx — 失效订阅 hook 的行为（RNTL renderHook）
 *
 * 钉：命中关心域才回调（一次事件只回调一次，多域同时命中不重复）、不关心的域静默、
 * 卸载退订（不再回调）、回调身份每次渲染都变也不重订阅（页面可直接传内联箭头）、
 * 空域列表不订阅。
 *
 * 注意（RNTL v14）：`renderHook` / `rerender` / `unmount` 都是**异步**的（内部走
 * act 冲刷），必须 await；挂载 effect 在 await 之后才落地，之后再发事件。
 */
import { act, renderHook } from '@testing-library/react-native';

import { useDbInvalidation } from '@/components/useDbInvalidation';
import { invalidateDb, resetDbInvalidationForTesting, type DbInvalidation } from '@/db/notify';

/** 冲刷事件总线的 queueMicrotask 合并（在 act 内，避免 React 更新警告） */
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

beforeEach(() => {
  resetDbInvalidationForTesting();
});

it('命中关心域时回调一次（多域同时命中不重复）', async () => {
  const events: DbInvalidation[] = [];
  await renderHook(() => useDbInvalidation(['activities', 'athlete'], (ev) => events.push(ev)));

  invalidateDb('athlete');
  await flush();
  expect(events).toHaveLength(1);

  invalidateDb('activities', 'uuid-1');
  invalidateDb('athlete');
  await flush();
  expect(events).toHaveLength(2); // 同一批两个域命中只回调一次
  expect(events[1].activityUuids).toEqual(['uuid-1']);
});

it('不关心的域不回调', async () => {
  const events: DbInvalidation[] = [];
  await renderHook(() => useDbInvalidation(['memories'], (ev) => events.push(ev)));
  invalidateDb('plans');
  await flush();
  expect(events).toHaveLength(0);
});

it('卸载后自动退订（不再回调）', async () => {
  const events: DbInvalidation[] = [];
  const { unmount } = await renderHook(() =>
    useDbInvalidation(['reports'], (ev) => events.push(ev)),
  );
  invalidateDb('reports');
  await flush();
  expect(events).toHaveLength(1);
  await unmount();
  invalidateDb('reports');
  await flush();
  expect(events).toHaveLength(1);
});

it('回调身份每次渲染都变也不重订阅（同一事件只回调一次）', async () => {
  const events: DbInvalidation[] = [];
  const { rerender } = await renderHook(() =>
    useDbInvalidation(['chats'], (ev) => events.push(ev)),
  );
  await rerender(undefined);
  await rerender(undefined);
  invalidateDb('chats');
  await flush();
  expect(events).toHaveLength(1); // 若重订阅会累积 listener → 3
});

it('空域列表不订阅（不产生无谓回调）', async () => {
  const events: DbInvalidation[] = [];
  await renderHook(() => useDbInvalidation([], (ev) => events.push(ev)));
  invalidateDb('activities');
  await flush();
  expect(events).toHaveLength(0);
});
