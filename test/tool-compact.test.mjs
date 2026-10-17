/**
 * tool-compact.test.mjs — 工具结果结构化降级测试（E1）
 *
 * 覆盖：未超限原样返回、超长字符串/数组降级后恒为合法 JSON、首尾保留与省略哨兵、
 * _truncated 元信息、极端超限的兜底骨架、超长扁平数组（get_activity_records 现场）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { compactJsonToLimit } from '../src/tools/compact.ts';

const NOTE = '（结果已压缩，可缩小查询范围重取）';

test('未超限：原样序列化、不带 _truncated', () => {
  const value = { a: 1, b: '文本' };
  const out = compactJsonToLimit(value, { maxChars: 16000, note: NOTE });
  assert.equal(out, JSON.stringify(value));
  assert.ok(!out.includes('_truncated'));
});

test('超长字符串值被截短且 JSON 可解析', () => {
  const value = { blob: 'x'.repeat(20000) };
  const out = compactJsonToLimit(value, { maxChars: 16000, note: NOTE });
  const parsed = JSON.parse(out); // 能 parse 即合法
  assert.ok(parsed.blob.length < 20000);
  assert.ok(parsed.blob.startsWith('x'));
  assert.equal(parsed._truncated.note, NOTE);
  assert.equal(parsed._truncated.original_chars, JSON.stringify(value).length);
});

test('超长数组：均匀抽样、保留首尾、哨兵交代省略数', () => {
  const points = Array.from({ length: 1000 }, (_, i) => ({ t: i, p: 200 }));
  const out = compactJsonToLimit({ points }, { maxChars: 16000, note: NOTE });
  const parsed = JSON.parse(out);
  const sampled = parsed.points;
  assert.equal(sampled[0].t, 0);
  assert.equal(sampled[sampled.length - 1].t, 999);
  const sentinel = sampled.find((x) => x.__omitted__ != null);
  assert.ok(sentinel);
  assert.equal(sentinel.__omitted__, 1000 - 20 - 20);
});

test('极端超限：逐级降级后仍超则兜底骨架（恒合法 JSON）', () => {
  const value = {
    deeply: Array.from({ length: 50 }, () => ({
      nested: { deep: { deeper: { text: 'q'.repeat(2000) } } },
    })),
  };
  const out = compactJsonToLimit(value, { maxChars: 1000, note: NOTE });
  const parsed = JSON.parse(out);
  assert.equal(parsed._compacted, true);
  assert.equal(parsed.original_chars, JSON.stringify(value).length);
  assert.ok(parsed.note === NOTE);
  assert.ok(parsed.top_keys.includes('deeply'));
  assert.ok(out.length < 3000);
});

test('中等超限：深度裁剪即可达标（不进兜底）', () => {
  const value = {
    a: { b: { c: { d: { e: { f: { g: 'w'.repeat(3000) } } } } } },
  };
  const out = compactJsonToLimit(value, { maxChars: 2000, note: NOTE });
  const parsed = JSON.parse(out);
  assert.ok(!parsed._compacted); // 未进兜底
  assert.ok(out.length <= 2100);
});

test('get_activity_records 现场：600 点时序压缩到 16k 内且可解析', () => {
  const points = Array.from({ length: 600 }, (_, i) => ({
    t: `2026-03-25T03:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
    power: 180 + (i % 40),
    heart_rate: 140,
    cadence: 90,
    altitude: 100.2,
    speed: 8.3,
    distance_m: i * 8.3,
    temperature: 25,
  }));
  const out = compactJsonToLimit({ points, total_seconds: 600, stride: 1 }, { maxChars: 16000, note: NOTE });
  assert.ok(out.length <= 16000 + 200, `len=${out.length}`); // 16k + 截断说明余量
  const parsed = JSON.parse(out);
  assert.equal(parsed.total_seconds, 600);
  assert.ok(Array.isArray(parsed.points));
  assert.ok(parsed.points.length < 600);
  assert.equal(parsed.points[0].t, points[0].t);
  assert.equal(parsed.points[parsed.points.length - 1].t, points[599].t);
});
