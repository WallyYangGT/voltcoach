/**
 * onelap.test.mjs — 顽鹿云客户端测试（node:test）
 *
 * 纯函数：签名串逐字节断言（⚠️ ×tamp 的 U+00D7 是接口契约，改即全断）、nonce
 * 拒绝采样、起骑时间解析、文件名规范化、base64 与 Node 参照实现对拍。
 * e2e：对本仓库 mock-onelap-server（同端口起临时实例）跑 登录→增量列表→下载 FIT
 * 全流程——服务端按同一签名算法校验，签名/鉴权头/下载 URL 任一偏差当场失败。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMockOnelapServer } from '../scripts/mock-onelap-server.mjs';
import {
  base64Encode,
  buildFitContentUrl,
  buildSignStr,
  createOnelapClient,
  endpointOrigins,
  extractFitFileName,
  isBeforeSince,
  jitterDelayMs,
  nonceFromBytes,
  ONELAP_RIDE_RECORD_BASE,
  ONELAP_SECRET,
  parseRideTime,
  PACE_MAX_MS,
  PACE_MIN_MS,
  probeEndpoint,
  SYNC_WINDOW_DAYS,
  syncWindowStart,
} from '../src/sync/onelap.ts';

/** node:crypto 实现的环境注入（对齐 App 侧 expo-crypto 形状） */
const nodeDeps = {
  md5Hex: (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex'),
  randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
  now: () => 1760000000,
};

test('buildSignStr: 逐字节复刻 Go 实现（× 为字面 U+00D7，勿修正！）', () => {
  const s = buildSignStr('user@mail.com', 'abcdefghijklmnop', '0123456789abcdef0123456789abcdef', '1760000000');
  assert.equal(
    s,
    `account=user@mail.com&nonce=abcdefghijklmnop&password=0123456789abcdef0123456789abcdef\u00d7tamp=1760000000&key=${ONELAP_SECRET}`,
  );
  // U+00D7 而非 '&'（0x26）：签名契约的核心断言
  assert.ok(s.includes('\u00d7tamp='));
  assert.ok(!s.includes('&timestamp='));
});

test('nonceFromBytes: 16 位 [0-9A-Za-z]，拒绝采样偏置可忽略', () => {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 37 + 11) % 256;
  const nonce = nonceFromBytes(bytes);
  assert.equal(nonce.length, 16);
  assert.match(nonce, /^[0-9A-Za-z]{16}$/);
});

test('nonceFromBytes: 可用字节耗尽抛错（不产出非法字符）', () => {
  assert.throws(() => nonceFromBytes(new Uint8Array(8).fill(250)));
});

test('parseRideTime: 顽鹿本地时区格式解析；非法输入返回 null', () => {
  const d = parseRideTime('2026-09-15 08:30:05');
  assert.ok(d);
  assert.equal(new Date(2026, 8, 15, 8, 30, 5).getTime(), d.getTime());
  assert.equal(parseRideTime('2026-09-15T08:30:05Z'), null); // 不是顽鹿格式
  assert.equal(parseRideTime('garbage'), null);
  assert.equal(parseRideTime(''), null);
});

test('isBeforeSince: 起骑时间早于水位线判定（增量翻页停止条件）', () => {
  const since = new Date(2026, 8, 10);
  assert.ok(isBeforeSince('2026-09-09 23:00:00', since));
  assert.ok(!isBeforeSince('2026-09-10 00:00:01', since));
  assert.ok(!isBeforeSince('bad-time', since)); // 解析失败不停翻
});

test('extractFitFileName: basename + 强制 .fit 后缀 + 回退 id 名', () => {
  assert.equal(extractFitFileName('geo/20260527/Magene_C706_2026-05-27-163236_.fit', '77001'),
    'Magene_C706_2026-05-27-163236_.fit');
  assert.equal(extractFitFileName('MATCH_-2026-06-01-16-28-32-log.st', '77002'),
    'MATCH_-2026-06-01-16-28-32-log.fit'); // .st 日志 → 服务端转码 FIT，落盘名统一
  assert.equal(extractFitFileName('', '77003'), 'onelap-77003.fit');
  assert.equal(extractFitFileName('geo/坏名字/../', '77004'), 'onelap-77004.fit'); // safeName 拒绝即回退
});

test('base64Encode: 与 Node Buffer 参照实现对拍（含中文与填充边界）', () => {
  for (const s of ['geo/20260527/mock-ride-77001.fit', '中文 key with spaces/?', 'a', 'ab', 'abc']) {
    assert.equal(base64Encode(new TextEncoder().encode(s)), Buffer.from(s, 'utf8').toString('base64'));
  }
});

test('buildFitContentUrl: fit_content 路径 = base64(UTF-8(fileKey))', () => {
  const key = 'geo/20260527/mock-ride-77001.fit';
  assert.equal(
    buildFitContentUrl(ONELAP_RIDE_RECORD_BASE, key),
    `${ONELAP_RIDE_RECORD_BASE}/analysis/fit_content/${Buffer.from(key, 'utf8').toString('base64')}`,
  );
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

test('endpointOrigins: 默认取登录域与数据域两个源；同源去重', () => {
  assert.deepEqual(endpointOrigins(), ['https://www.onelap.cn', 'https://otm.onelap.cn']);
  // mock 覆盖时两个端点同源 → 只探一次
  assert.deepEqual(
    endpointOrigins({ login: 'http://10.0.2.2:8791/api/login', rideRecord: 'http://10.0.2.2:8791/api/otm/ride_record' }),
    ['http://10.0.2.2:8791'],
  );
  assert.deepEqual(endpointOrigins({ login: 'not-a-url', rideRecord: ONELAP_RIDE_RECORD_BASE }), ['https://otm.onelap.cn']);
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

test('createOnelapClient: 请求超时（含 canceled 措辞）归一为 network 且提示「请求超时」', async () => {
  const hanging = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('Fetch request has been canceled')));
    });
  const client = createOnelapClient({
    ...nodeDeps,
    fetchImpl: hanging,
    timeouts: { requestMs: 30, downloadMs: 30 },
  });
  await assert.rejects(
    () => client.login('rider@example.com', 'pw'),
    (e) => e.code === 'network' && /请求超时/.test(e.message) && !/canceled/i.test(e.message),
  );
});

test('e2e: 登录（服务端校验签名）→ 增量列表 → 下载 FIT 全流程对 mock server', async () => {
  const server = createMockOnelapServer({ activityCount: 5, acceptPassword: 'hunter2' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: { login: `http://127.0.0.1:${port}/api/login`, rideRecord: `http://127.0.0.1:${port}/api/otm/ride_record` },
    });

    // ① 登录：mock 按同算法验签，签名串含 U+00D7 才放行；uid 大整数保真
    const session = await client.login('rider@example.com', 'hunter2');
    assert.equal(session.token, 'mock-token-0123456789abcdef');
    assert.equal(session.uid, '11122233344455566677');

    // ② 增量列表：since 卡在第 3 新的活动 → 只回前 2 条（新→旧停止）
    const since = new Date(Date.now() - 2.5 * 24 * 3600 * 1000);
    const list = await client.listSince(session, since);
    assert.equal(list.length, 2);
    assert.ok(list[0].start_riding_time >= list[1].start_riding_time);

    // ③ 全量列表：5 条 + 分页翻完（limit 20 一页拿完，has_more=false 停）
    const all = await client.listSince(session, null);
    assert.equal(all.length, 5);

    // ④ 下载 FIT：analysis → fileKey → fit_content(base64) → 字节与文件名
    const { bytes, fileName } = await client.downloadFit(session, String(all[0].id));
    assert.ok(bytes.length > 14, 'FIT 字节非空');
    assert.equal(bytes[0], 0x0e); // FIT 文件头长度字节（make_test_fit 生成 14 字节头）
    assert.match(fileName, /^mock-ride-\d+\.fit$/);

    // ⑤ 错误路径：错密码 → 服务端验签失败 401 → auth 错误
    await assert.rejects(
      () => client.login('rider@example.com', 'wrong'),
      (e) => e.code === 'auth',
    );

    // ⑥ 错误路径：无 token 会话 → 鉴权闸 401
    await assert.rejects(
      () => client.listSince({ token: 'bad', uid: '1' }, null),
      (e) => e.code === 'auth',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
