/**
 * memory-rank.test.mjs — 记忆相关度挑选测试（E1 top-k）
 *
 * 覆盖：strategy 全收置顶、类别×场景亲和、短期加分、时间衰减、查询重叠、
 * topK/字符预算、排序稳定性、空输入。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { rankMemories } from '../src/prompts/memory-rank.ts';

const NOW = Date.parse('2026-10-17T08:00:00Z');
const mem = (id, content, extra = {}) => ({ id, content, category: 'general', created_at: '2026-09-01 10:00:00', ...extra });

test('strategy 全收且不受 topK 挤压', () => {
  const mems = [
    mem(1, '策略A', { category: 'strategy' }),
    mem(2, '策略B', { category: 'strategy' }),
    ...Array.from({ length: 10 }, (_, i) => mem(10 + i, `近期记忆${i}`, { created_at: '2026-10-16 10:00:00' })),
  ];
  const picked = rankMemories(mems, { mode: 'chat', topK: 3, nowMs: NOW });
  const ids = picked.map((m) => m.id);
  assert.ok(ids.includes(1) && ids.includes(2));
  assert.equal(picked.length, 3); // topK=3：strategy 2 条 + 1 条新近
});

test('场景亲和：plan 偏日程/目标，follow_up 偏伤病/偏好', () => {
  const mems = [
    mem(1, '出差一周', { category: 'schedule', created_at: '2026-08-01 10:00:00' }),
    mem(2, '左膝不适', { category: 'injury', created_at: '2026-08-01 10:00:00' }),
    mem(3, '喜欢夜骑', { category: 'preference', created_at: '2026-08-01 10:00:00' }),
    mem(4, '随便一条', { category: 'general', created_at: '2026-08-01 10:00:00' }),
  ];
  const planPicked = rankMemories(mems, { mode: 'plan', topK: 2, nowMs: NOW });
  assert.deepEqual(planPicked.map((m) => m.id), [1, 2]);
  const fuPicked = rankMemories(mems, { mode: 'follow_up', topK: 2, nowMs: NOW });
  assert.deepEqual(fuPicked.map((m) => m.id), [2, 3]);
});

test('时间衰减：更近的记忆优先（返回序保持入参序，断言按集合比较）', () => {
  const mems = [
    mem(1, '春天的事', { created_at: '2026-04-01 10:00:00' }), // >90 天不加
    mem(2, '上月的事', { created_at: '2026-09-25 10:00:00' }), // <30 天 +2
    mem(3, '上周的事', { created_at: '2026-10-12 10:00:00' }), // <7 天 +3
  ];
  const picked = rankMemories(mems, { mode: 'chat', topK: 2, nowMs: NOW });
  assert.deepEqual(picked.map((m) => m.id).sort(), [2, 3]); // 上周的与上月的入选，春天的被挤掉
});

test('查询重叠：与问题文本相关的记忆加分（中文 2-gram）', () => {
  const mems = [
    mem(1, '用户在备战环千岛湖 200km 骑游', { created_at: '2026-06-01 10:00:00' }),
    mem(2, '用户偏好清晨训练', { created_at: '2026-06-01 10:00:00' }),
  ];
  const picked = rankMemories(mems, { mode: 'chat', query: '千岛湖骑游的补给怎么安排', topK: 1, nowMs: NOW });
  assert.deepEqual(picked.map((m) => m.id), [1]);
});

test('查询重叠：英文走词命中且停用词不计', () => {
  const mems = [
    mem(1, 'The rider uses a power meter on the trainer', { created_at: '2026-06-01 10:00:00' }),
    mem(2, ' rider enjoys coffee stop', { created_at: '2026-06-01 10:00:00' }),
  ];
  const picked = rankMemories(mems, { mode: 'chat', query: 'trainer sessions', topK: 1, nowMs: NOW });
  assert.deepEqual(picked.map((m) => m.id), [1]);
});

test('字符预算：超预算的记忆跳过、后续较小的仍可入选', () => {
  const mems = [
    mem(1, '大记忆'.repeat(400) + '甲', { created_at: '2026-10-15 10:00:00' }), // 1200 字
    mem(2, '小记忆', { created_at: '2026-10-14 10:00:00' }),
    mem(3, '更小', { created_at: '2026-10-13 10:00:00' }),
  ];
  const picked = rankMemories(mems, { mode: 'chat', topK: 3, maxChars: 1000, nowMs: NOW });
  const ids = picked.map((m) => m.id);
  assert.ok(!ids.includes(1)); // 装不下被跳过
  assert.ok(ids.includes(2) && ids.includes(3));
});

test('返回顺序保持入参（id DESC 契约）、空输入返回空', () => {
  const mems = [mem(5, 'a', { created_at: '2026-10-16 10:00:00' }), mem(3, 'b', { created_at: '2026-10-15 10:00:00' })];
  const picked = rankMemories(mems, { mode: 'chat', topK: 1, nowMs: NOW });
  assert.deepEqual(picked.map((m) => m.id), [5]); // 更新的 5 胜出
  assert.equal(rankMemories([], {}).length, 0);
  assert.equal(rankMemories(null, {}).length, 0);
});

test('无 topK/预算时全量返回（退化为旧行为）', () => {
  const mems = [mem(1, 'a'), mem(2, 'b'), mem(3, 'c')];
  assert.equal(rankMemories(mems, { mode: 'chat', nowMs: NOW }).length, 3);
});
