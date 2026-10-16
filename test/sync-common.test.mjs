/**
 * sync-common.test.mjs — 云同步平台无关层测试（node:test）
 *
 * 覆盖 src/sync/common.ts：同步窗口计算（5 例）、请求节流抖动、连接探测三态、
 * base64/base64url/hex 字节辅助（与 Node 参照实现对拍）、endpointOrigins 去重。
 * 这些函数 2026-10-16 多平台化时从 onelap.ts 抽出（断言随实现一起搬迁，口径不变）。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base64Encode,
  base64UrlEncode,
  endpointOrigins,
  hexToBytes,
  jitterDelayMs,
  PACE_MAX_MS,
  PACE_MIN_MS,
  probeEndpoint,
  SYNC_WINDOW_DAYS,
  syncWindowStart,
} from '../src/sync/common.ts';

test('base64Encode: 与 Node Buffer 参照实现对拍（含中文与填充边界）', () => {
  for (const s of ['geo/20260527/mock-ride-77001.fit', '中文 key with spaces/?', 'a', 'ab', 'abc']) {
    assert.equal(base64Encode(new TextEncoder().encode(s)), Buffer.from(s, 'utf8').toString('base64'));
  }
});

test('base64UrlEncode: +/ 换 -_ 且去填充（PKCE 口径）', () => {
  // 0xfb 0xff 0xbf → 标准 base64 "+/+/" 类字节，url 变体换字符表
  const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x00, 0x01]);
  const std = Buffer.from(bytes).toString('base64');
  const url = base64UrlEncode(bytes);
  assert.ok(!/[+/=]/.test(url), 'base64url 不含 + / =');
  assert.equal(url, std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
});

test('hexToBytes: expo-crypto 的 hex 摘要还原为原始字节（SHA-256 32 字节）', () => {
  const hex = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const bytes = hexToBytes(hex);
  assert.equal(bytes.length, 32);
  assert.equal(Buffer.from(bytes).toString('hex'), hex);
});

test('syncWindowStart: 首次同步（无水位线）→ 最近 SYNC_WINDOW_DAYS 天（不回溯全部历史）', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  const start = syncWindowStart(null, now);
  assert.equal(start.toISOString(), '2026-06-24T12:00:00.000Z');
  assert.equal((now.getTime() - start.getTime()) / 86400000, SYNC_WINDOW_DAYS);
});

test('syncWindowStart: 近期水位线 → 前移 24h 缓冲（取较晚者，窗口内正常增量）', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  const last = '2026-09-21T12:00:00.000Z'; // 昨天
  const start = syncWindowStart(last, now);
  assert.equal(start.toISOString(), '2026-09-20T12:00:00.000Z'); // 水位线 −24h，晚于窗口下界
});

test('syncWindowStart: 长期未同步 → 截到窗口下界（不一次拉几百天）', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  const last = '2025-01-01T00:00:00.000Z'; // 一年半前
  assert.equal(syncWindowStart(last, now).toISOString(), '2026-06-24T12:00:00.000Z');
});

test('syncWindowStart: 水位线脏数据（时钟回拨/非法串）→ 回落窗口下界', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  assert.equal(syncWindowStart('not-a-date', now).toISOString(), '2026-06-24T12:00:00.000Z');
});

test('syncWindowStart: 窗口天数可注入（测试/未来做成可配）', () => {
  const now = new Date('2026-09-22T12:00:00Z');
  assert.equal(syncWindowStart(null, now, 30).toISOString(), '2026-08-23T12:00:00.000Z');
});

test('jitterDelayMs: 落在 [PACE_MIN_MS, PACE_MAX_MS] 闭区间且随随机数变化', () => {
  assert.equal(jitterDelayMs(() => 0), PACE_MIN_MS);
  assert.equal(jitterDelayMs(() => 0.9999999), PACE_MAX_MS);
  const mid = jitterDelayMs(() => 0.5);
  assert.ok(mid >= PACE_MIN_MS && mid <= PACE_MAX_MS);
  // 抽样 200 次：全部在区间内且不止一个取值（确实是抖动而非定值）
  const samples = new Set(Array.from({ length: 200 }, () => jitterDelayMs()));
  for (const v of samples) assert.ok(v >= PACE_MIN_MS && v <= PACE_MAX_MS);
  assert.ok(samples.size > 1);
});

test('jitterDelayMs: 非法/越界随机数 → 回落下界（防御）', () => {
  assert.equal(jitterDelayMs(() => Number.NaN), PACE_MIN_MS);
  assert.equal(jitterDelayMs(() => -1), PACE_MIN_MS);
  assert.equal(jitterDelayMs(() => 2), PACE_MAX_MS); // 越上界钳到 max
});

test('endpointOrigins: 逐项取 origin 并按出现顺序去重；空值/非法 URL 跳过', () => {
  assert.deepEqual(
    endpointOrigins(['https://www.onelap.cn/api/login', 'https://otm.onelap.cn/api/otm/ride_record']),
    ['https://www.onelap.cn', 'https://otm.onelap.cn'],
  );
  // 同源（mock 覆盖时登录域与数据域同址）→ 只探一次
  assert.deepEqual(
    endpointOrigins(['http://10.0.2.2:8791/api/login', 'http://10.0.2.2:8791/api/otm/ride_record']),
    ['http://10.0.2.2:8791'],
  );
  assert.deepEqual(endpointOrigins(['not-a-url', undefined, null, 'https://ok.test/x']), ['https://ok.test']);
  assert.deepEqual(endpointOrigins([]), []);
});

test('probeEndpoint: 拿到任何 HTTP 响应即算链路可达（404/500 也证明连得上）', async () => {
  const ok = await probeEndpoint('https://example.test', {
    fetchImpl: async () => new Response('ok', { status: 200 }),
    now: (() => { let t = 1000; return () => (t += 120); })(),
  });
  assert.equal(ok.reachable, true);
  assert.equal(ok.status, 200);
  assert.equal(ok.ms, 120);
  assert.equal(ok.detail, null);

  const err = await probeEndpoint('https://example.test', {
    fetchImpl: async () => new Response('boom', { status: 500 }),
  });
  assert.equal(err.reachable, true, 'HTTP 500 仍算可达（服务器在应答）');
  assert.equal(err.status, 500);
});

test('probeEndpoint: 连接失败透出原始原因（DNS/拒绝连接等）', async () => {
  const r = await probeEndpoint('https://example.test', {
    fetchImpl: async () => {
      throw new Error('Network request failed');
    },
  });
  assert.equal(r.reachable, false);
  assert.equal(r.status, null);
  assert.match(r.detail, /Network request failed/);
});

test('probeEndpoint: 超时（含 expo/fetch 的 canceled 措辞）→ 明确的连接超时提示', async () => {
  // 模拟 expo/fetch 在 signal abort 时的报错文案（不含 abort 字样）
  const hanging = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('Fetch request has been canceled')));
    });
  const r = await probeEndpoint('https://example.test', { fetchImpl: hanging, timeoutMs: 30 });
  assert.equal(r.reachable, false);
  assert.match(r.detail, /连接超时/);
});
