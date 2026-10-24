/**
 * onelap.test.mjs — 顽鹿云客户端测试（node:test）
 *
 * 纯函数：签名串逐字节断言（⚠️ ×tamp 的 U+00D7 是接口契约，改即全断）、nonce
 * 拒绝采样、起骑时间解析、文件名规范化;平台无关部分（base64/窗口/探测）已随实现
 * 抽到 sync-common.test.mjs。
 * e2e：对本仓库 mock-onelap-server（同端口起临时实例）跑 登录→增量列表→下载 FIT
 * 全流程——服务端按同一签名算法校验，签名/鉴权头/下载 URL 任一偏差当场失败。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMockOnelapServer } from '../scripts/mock-onelap-server.mjs';
import { analyzeFile } from '../src/core/analyze.ts';
import { findDuplicateGroups } from '../src/core/dedupe.ts';
import {
  buildFitContentUrl,
  buildSignStr,
  createOnelapClient,
  extractActivityStartAt,
  extractFitFileName,
  localDateKey,
  nonceFromBytes,
  ONELAP_RIDE_RECORD_BASE,
  ONELAP_SECRET,
  parseCalendarRecords,
  parseRideTime,
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
  // 无时区的 T 分隔变体 = 同一墙钟
  assert.deepEqual(parseRideTime('2026-09-15T08:30:05'), d);
  assert.equal(parseRideTime('garbage'), null);
  assert.equal(parseRideTime(''), null);
});

test('parseRideTime: 带时区后缀按 offset 归一为精确 instant（不按本地墙钟解释）', () => {
  assert.equal(
    parseRideTime('2026-09-15T08:30:05Z')?.getTime(),
    Date.UTC(2026, 8, 15, 8, 30, 5),
  );
  assert.equal(
    parseRideTime('2026-09-15 08:30:05+08:00')?.getTime(),
    Date.UTC(2026, 8, 15, 0, 30, 5),
  );
  assert.equal(
    parseRideTime('2026-09-15 08:30:05.123-0500')?.getTime(),
    Date.UTC(2026, 8, 15, 13, 30, 5),
  );
});

test('extractFitFileName: basename + 强制 .fit 后缀 + 回退 id 名', () => {
  assert.equal(extractFitFileName('geo/20260527/Magene_C706_2026-05-27-163236_.fit', '77001'),
    'Magene_C706_2026-05-27-163236_.fit');
  assert.equal(extractFitFileName('MATCH_-2026-06-01-16-28-32-log.st', '77002'),
    'MATCH_-2026-06-01-16-28-32-log.fit'); // .st 日志 → 服务端转码 FIT，落盘名统一
  assert.equal(extractFitFileName('', '77003'), 'onelap-77003.fit');
  assert.equal(extractFitFileName('geo/坏名字/../', '77004'), 'onelap-77004.fit'); // safeName 拒绝即回退
});

test('buildFitContentUrl: fit_content 路径 = base64(UTF-8(fileKey))', () => {
  const key = 'geo/20260527/mock-ride-77001.fit';
  assert.equal(
    buildFitContentUrl(ONELAP_RIDE_RECORD_BASE, key),
    `${ONELAP_RIDE_RECORD_BASE}/analysis/fit_content/${Buffer.from(key, 'utf8').toString('base64')}`,
  );
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
      baseUrlOverrides: { login: `http://127.0.0.1:${port}/api/login`, rideRecord: `http://127.0.0.1:${port}/api/otm/ride_record`, calendar: `http://127.0.0.1:${port}/api/otm/calendar/calendar/records` },
    });

    // ① 登录：mock 按同算法验签，签名串含 U+00D7 才放行；uid 大整数保真
    const session = await client.login('rider@example.com', 'hunter2');
    assert.equal(session.token, 'mock-token-0123456789abcdef');
    assert.equal(session.uid, '11122233344455566677');

    // ② 增量列表：since 卡在第 3 新的活动 → 旧路回前 2 条（新→旧停止）。取 2.02d
    // 而非 2.5d：活动以 24h 间隔铺开，2.5d 会因测试运行时刻跨日界而使日历补充量抖动
    const since = new Date(Date.now() - 2.02 * 24 * 3600 * 1000);
    const list = await client.listSince(session, since);
    assert.equal(list.length, 2);
    assert.ok(list[0].startAt instanceof Date, '起骑时刻已解析为 Date（编排层失败锚点用）');
    assert.ok(list[0].startAt.getTime() >= list[1].startAt.getTime());

    // ③ 全量列表：5 条 + 分页翻完（limit 20 一页拿完，has_more=false 停）
    const all = await client.listSince(session, null);
    assert.equal(all.length, 5);

    // ④ 文件引用 → 下载 FIT：analysis → fileKey → fit_content(base64) → 字节与文件名
    const ref = await client.getFileRef(session, all[0]);
    assert.match(ref.fileName, /^mock-ride-\d+\.fit$/);
    const bytes = await client.download(session, ref);
    assert.ok(bytes.length > 14, 'FIT 字节非空');
    assert.equal(bytes[0], 0x0e); // FIT 文件头长度字节（make_test_fit 生成 14 字节头）

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

/**
 * mock 夹具回归（M5）：每条活动的 FIT 起骑时刻必须各不相同。
 * 此前夹具把所有活动的 FIT 起始时间写成同一常量（2024-01-15 10:00），于是 5 条活动的
 * 日期/时长/距离全同——内容指纹去重会把它们误判成同一趟骑行（模拟器同步只能导入 1 条）。
 */
test('mock 夹具: 各活动的 FIT 内容互不为同一趟骑行（内容指纹不误判）', async () => {
  const server = createMockOnelapServer({ activityCount: 3 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: `http://127.0.0.1:${port}/api/login`,
        rideRecord: `http://127.0.0.1:${port}/api/otm/ride_record`,
calendar: `http://127.0.0.1:${port}/api/otm/calendar/calendar/records`,
      },
    });
    const session = await client.login('rider@example.com', 'any');
    const list = await client.listSince(session, null);
    assert.equal(list.length, 3);

    const keys = [];
    for (const act of list) {
      const ref = await client.getFileRef(session, act);
      const bytes = await client.download(session, ref);
      const { summary } = await analyzeFile({ bytes, fileName: `mock-${act.id}.fit` });
      keys.push({
        file_name: `mock-${act.id}.fit`,
        date: summary.activity.date,
        duration_sec: summary.activity.duration_sec,
        distance_km: summary.activity.distance_km,
      });
    }
    assert.equal(new Set(keys.map((k) => k.date)).size, 3, '每条活动的骑行日期应各不相同');
    assert.deepEqual(findDuplicateGroups(keys), [], '不应被判为重复组');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------- listSince 列表异常防御（2026-10 顽鹿增量失效事故，decisions §37） ----------------
//
// 事故形态：云端列表出现「排序翻转 / 条目缺 id·时间」任一异常时，旧实现静默返回空列表，
// 编排层照常推进水位线，缺口被 24h 缓冲永久藏住（症状：同步时间在走、永远 0 新增 0 跳过）。
// 以下用例用假 fetch 直接构造异常响应，钉住三类防御行为。

/** 本地时区 "YYYY-MM-DD HH:mm:ss"（顽鹿口径） */
function rideTime(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 构造 /list 的假 fetch：pages[i] 为第 i+1 页的 { list, hasMore }；calls 记录每次请求。
 *  calendar 路径（listSince 编排会打）默认回空数组且不计数，不干扰旧路断言；
 *  calendarFails=true 时回 403——用于钉住「旧路守卫在无回落可用时依然生效」 */
function fakeListFetch(pages, { calendarFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('/calendar/')) {
      if (calendarFails) return new Response(JSON.stringify({ code: 403, error: 'calendar down' }), { status: 403 });
      return new Response(JSON.stringify({ code: 200, message: 'success', data: [] }), { status: 200 });
    }
    const page = Number(JSON.parse(init?.body ?? '{}').page) || 1;
    calls.push(page);
    const spec = pages[Math.min(page, pages.length) - 1];
    const payload =
      spec.raw ??
      JSON.stringify({
        code: 200,
        message: '',
        data: { list: spec.list, pagination: { has_more: spec.hasMore ?? false } },
      });
    return new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { fetchImpl, calls };
}

function listClient(fetchImpl) {
  return createOnelapClient({ ...nodeDeps, fetchImpl });
}

test('listSince: 旧→新排序（时间升序）也能收齐窗口内活动——事故防御主 case', async () => {
  const { fetchImpl, calls } = fakeListFetch([
    { list: [{ id: 3, start_riding_time: rideTime(40) }, { id: 2, start_riding_time: rideTime(30) }, { id: 1, start_riding_time: rideTime(3) }], hasMore: true },
    { list: [{ id: 4, start_riding_time: rideTime(2) }, { id: 5, start_riding_time: rideTime(1) }] },
  ]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000));
  assert.deepEqual(
    list.map((a) => a.id),
    ['1', '4', '5'],
    '排在前面的窗口外旧条目不得让扫描提前停止',
  );
  assert.equal(calls.length, 2, '两页都应翻完');
});

test('listSince: 新→旧排序保持遇旧即停（翻页成本不回退）', async () => {
  const { fetchImpl, calls } = fakeListFetch([
    { list: [{ id: 1, start_riding_time: rideTime(1) }, { id: 2, start_riding_time: rideTime(40) }], hasMore: true },
    { list: [{ id: 3, start_riding_time: rideTime(41) }] },
  ]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000));
  assert.deepEqual(list.map((a) => a.id), ['1']);
  assert.equal(calls.length, 1, '新→旧序遇旧条目即停，不翻后续页');
});

test('listSince: 新→旧序且窗口内无记录——首页即停、返回空（不误报形状异常）', async () => {
  const { fetchImpl, calls } = fakeListFetch([
    { list: [{ id: 1, start_riding_time: rideTime(40) }, { id: 2, start_riding_time: rideTime(41) }], hasMore: true },
  ]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000));
  assert.deepEqual(list, []);
  assert.equal(calls.length, 1);
});

test('listSince: 单条旧条目跨页（样本不足不断序）——下一页的窗口内记录不丢', async () => {
  const { fetchImpl } = fakeListFetch([
    { list: [{ id: 1, start_riding_time: rideTime(40) }], hasMore: true },
    { list: [{ id: 2, start_riding_time: rideTime(30) }, { id: 3, start_riding_time: rideTime(1) }] },
  ]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000));
  assert.deepEqual(list.map((a) => a.id), ['3'], '首条旧条目无法判定列表方向，不得提前停止');
});

test('listSince: 条目全部缺 id/时间——显式 api 错误，不再静默当空列表', async () => {
  const { fetchImpl } = fakeListFetch([
    { list: [{ start_riding_time: rideTime(1) }, { id: 9 }, {}] },
  ], { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    (e) => e.code === 'api' && /无法确认是否为未同步的新记录/.test(e.message),
  );
});

test('listSince: 窗口边界前（新侧）的不可解析条目——空结果不可信，显式报错', async () => {
  // 降序里排在旧条目之前的不可解析条目疑似窗口内的新记录，静默跳过会复刻本次事故
  const { fetchImpl } = fakeListFetch([
    { list: [{ start_riding_time: rideTime(1) }, { id: 2, start_riding_time: rideTime(40) }, { id: 3, start_riding_time: rideTime(41) }] },
  ], { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    (e) => e.code === 'api' && /无法确认是否为未同步的新记录/.test(e.message),
  );
});

test('listSince: 非空但新侧有丢弃条目——结果不完整，同样显式报错（回审探针①）', async () => {
  // 降序 [缺 id 的新记录, 窗口内旧记录, 边界]：可解析子集存在，但缺 id 的新记录被丢了，
  // 旧实现会照常推进水位线把缺口藏住——必须报错而非返回部分结果
  const { fetchImpl } = fakeListFetch([
    { list: [{ start_riding_time: rideTime(1) }, { id: 5, start_riding_time: rideTime(2) }, { id: 4, start_riding_time: rideTime(40) }], hasMore: true },
  ], { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    (e) => e.code === 'api' && /无法确认是否为未同步的新记录/.test(e.message),
  );
});

test('listSince: 升序且边界后有丢弃条目——同样显式报错（回审探针②）', async () => {
  const { fetchImpl } = fakeListFetch([
    { list: [{ id: 4, start_riding_time: rideTime(40) }, { start_riding_time: rideTime(1) }, { id: 5, start_riding_time: rideTime(2) }] },
  ], { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    (e) => e.code === 'api' && /无法确认是否为未同步的新记录/.test(e.message),
  );
});

test('listSince: 升序单样本方向未知 + 边界后全丢弃——保守取和，显式报错（回审探针③）', async () => {
  const { fetchImpl } = fakeListFetch([
    { list: [{ id: 4, start_riding_time: rideTime(40) }, { start_riding_time: rideTime(1) }, { start_riding_time: rideTime(2) }] },
  ], { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    (e) => e.code === 'api' && /无法确认是否为未同步的新记录/.test(e.message),
  );
});

test('listSince: 不可解析条目在窗口边界之后——按空窗口放行（不误报）', async () => {
  const { fetchImpl } = fakeListFetch([
    { list: [{ id: 1, start_riding_time: rideTime(40) }, { id: 2, start_riding_time: rideTime(41) }, {}] },
  ]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000));
  assert.deepEqual(list, []);
});

test('listSince: list 字段缺失（形状变更）——显式 api 错误', async () => {
  const { fetchImpl } = fakeListFetch([{ raw: JSON.stringify({ code: 200, message: '', data: { rows: [] } }) }], { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    (e) => e.code === 'api' && /缺少 list/.test(e.message),
  );
});

test('listSince: list 为非数组非 null（形状变更）——显式 api 错误', async () => {
  const { fetchImpl } = fakeListFetch([{ raw: JSON.stringify({ code: 200, message: '', data: { list: {}, pagination: { has_more: false } } }) }], { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000)),
    (e) => e.code === 'api' && /类型异常/.test(e.message),
  );
});

test('listSince: list 为 null（Go nil slice）——按空页放行', async () => {
  const { fetchImpl } = fakeListFetch([{ raw: JSON.stringify({ code: 200, message: '', data: { list: null, pagination: { has_more: false } } }) }]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000));
  assert.deepEqual(list, []);
});

test('listSince: 边界恰在页数用尽页且 has_more——按窗口扫完放行（boundary 先于 truncated）', async () => {
  const { fetchImpl, calls } = fakeListFetch([
    { list: [{ id: 1, start_riding_time: rideTime(40) }, { id: 2, start_riding_time: rideTime(41) }], hasMore: true },
  ]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000), 1);
  assert.deepEqual(list, [], '窗口已扫完不应报翻页上限错');
  assert.equal(calls.length, 1);
});

test('listSince: 时间字段存在但格式不可解析——条目仍入列表（startAt=null），不丢记录', async () => {
  const { fetchImpl } = fakeListFetch([
    { list: [{ id: 9, start_riding_time: '2026/10/20 19:00' }, { id: 10, start_riding_time: rideTime(1) }] },
  ]);
  const list = await listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000));
  assert.deepEqual(
    list.map((a) => [a.id, a.startAt]),
    [['9', null], ['10', list[1].startAt]],
    '时间格式漂移不应升级成丢记录（startAt 只用于失败重试锚点）',
  );
});

test('listSince: 超过翻页上限仍未到头——显式报错（截断的列表不可信）', async () => {
  const pages = Array.from({ length: 3 }, (_, i) => ({
    list: [{ id: i + 1, start_riding_time: rideTime(1 + i) }],
    hasMore: true,
  }));
  const { fetchImpl } = fakeListFetch(pages, { calendarFails: true });
  await assert.rejects(
    () => listClient(fetchImpl).listSince({ token: 't', uid: '1' }, new Date(Date.now() - 5 * 24 * 3600 * 1000), 2),
    (e) => e.code === 'api' && /翻页上限/.test(e.message),
  );
});

// ---------------- 2026-10 中服务端变更适配（OTM 日历 + 新字段形态，decisions §38） ----------------

test('extractActivityStartAt: 时间字段三兜底（start_riding_time → start_time → created_at epoch 秒）', () => {
  const wall = extractActivityStartAt({ start_riding_time: '2026-10-20 19:00:00' });
  assert.ok(wall);
  assert.deepEqual(extractActivityStartAt({ start_time: '2026-10-20 19:00:00' }), wall);
  // created_at 为 epoch 秒（number 或数字串）→ UTC instant
  const epoch = Math.floor(new Date(2026, 9, 20, 19, 0, 0).getTime() / 1000);
  assert.equal(
    extractActivityStartAt({ created_at: epoch })?.getTime(),
    epoch * 1000,
  );
  assert.equal(extractActivityStartAt({ created_at: String(epoch) })?.getTime(), epoch * 1000);
  // 全缺/脏值 → null
  assert.equal(extractActivityStartAt({}), null);
  assert.equal(extractActivityStartAt({ created_at: 0 }), null);
  assert.equal(extractActivityStartAt({ created_at: 'x' }), null);
  // 优先级：start_riding_time 在则不看 start_time
  assert.deepEqual(
    extractActivityStartAt({ start_riding_time: '2026-01-01 08:00:00', start_time: '2026-02-02 08:00:00' }),
    parseRideTime('2026-01-01 08:00:00'),
  );
});

test('parseCalendarRecords: 用户实证形状（code/data 数组/_id+date）→ 本地日历日 0 点', () => {
  const out = parseCalendarRecords({
    code: 200,
    message: 'success',
    data: [
      { _id: '6ada0f6cfcc5a26bc202035c', date: '2026-10-22', time: 3687, totalDistance: 21812.4 },
      { _id: '6ad7647bb38aec03e7012b93', date: '2026-10-20' },
    ],
  });
  assert.equal(out.length, 2);
  assert.equal(out[0].id, '6ada0f6cfcc5a26bc202035c');
  assert.deepEqual(out[0].startAt, new Date(2026, 9, 22));
  // 错误码 / data 非数组 → 显式 api 错误
  assert.throws(() => parseCalendarRecords({ code: 403, error: 'Authorization fail!' }), (e) => e.code === 'api');
  assert.throws(() => parseCalendarRecords({ code: 200, data: {} }), (e) => e.code === 'api');
  // 坏条目跳过；全坏才报错
  const partial = parseCalendarRecords({ code: 200, data: [{ date: '2026-10-20' }, { _id: 'x', date: '2026-10-21' }] });
  assert.equal(partial.length, 1);
  assert.throws(() => parseCalendarRecords({ code: 200, data: [{}, { date: '' }] }), (e) => e.code === 'api');
});

test('localDateKey: 本地日历日键（合并去重用）', () => {
  assert.equal(localDateKey(new Date(2026, 9, 22)), '2026-10-22');
});

test('getFitKey/getFileRef: 详情顶层 unwrap（新形态无 ridingRecord 包裹）+ fit_url 蛇形 + durl 直链', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    if (String(url).endsWith('/analysis/mongo-id-1')) {
      return new Response(
        JSON.stringify({ code: 200, message: '', data: { fileKey: 'ONELAP_677767-2026-10-18-20-33-08.st' } }),
        { status: 200 },
      );
    }
    if (String(url).endsWith('/analysis/mongo-id-2')) {
      return new Response(
        JSON.stringify({ code: 200, message: '', data: { fit_url: 'https://oss.example.com/geo/2026/a.fit?sig=1' } }),
        { status: 200 },
      );
    }
    if (String(url).endsWith('/analysis/mongo-id-3')) {
      return new Response(
        JSON.stringify({ code: 200, message: '', data: { durl: 'https://oss.example.com/dl/x.fit?Expires=9' } }),
        { status: 200 },
      );
    }
    if (String(url).endsWith('/analysis/mongo-none')) {
      return new Response(JSON.stringify({ code: 200, message: '', data: { ridingRecord: {} } }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 4004, message: 'no such activity' }), { status: 200 });
  };
  const client = listClient(fetchImpl);
  const session = { token: 't', uid: '1' };

  // ① 新形态裸名 fileKey：走 fit_content 路径，文件名取裸名 stem
  const ref1 = await client.getFileRef(session, { id: 'mongo-id-1', startAt: null });
  assert.equal(ref1.key, 'ONELAP_677767-2026-10-18-20-33-08.st');
  assert.equal(ref1.fileName, 'ONELAP_677767-2026-10-18-20-33-08.fit');

  // ② 蛇形 fit_url 且是 /geo/ 开头的 URL → 剥成 fit_content 路径（query 丢弃）
  const ref2 = await client.getFileRef(session, { id: 'mongo-id-2', startAt: null });
  assert.equal(ref2.key, 'geo/2026/a.fit');
  assert.equal(ref2.fileName, 'a.fit');

  // ③ durl 签名直链：key 存完整 URL，文件名剥 query
  const ref3 = await client.getFileRef(session, { id: 'mongo-id-3', startAt: null });
  assert.equal(ref3.key, 'https://oss.example.com/dl/x.fit?Expires=9');
  assert.equal(ref3.fileName, 'x.fit');

  // 无文件 → no_file
  await assert.rejects(
    () => client.getFitKey(session, 'mongo-none'),
    (e) => e.code === 'no_file',
  );
});

test('download: durl 直链分流——裸 GET 不带鉴权头；fit_content 路径仍带鉴权', async () => {
  const calls = [];
  const fitBytes = new Uint8Array(16);
  fitBytes[0] = 0x0e; // 头长度 14
  fitBytes.set([0x2e, 0x46, 0x49, 0x54], 8); // 字节 8-11 = ".FIT" 魔数
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    return new Response(fitBytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  };
  const client = listClient(fetchImpl);
  const session = { token: 'tok', uid: '1' };

  const direct = await client.download(session, { key: 'https://oss.example.com/dl/x.fit?s=1', fileName: 'x.fit' });
  assert.equal(direct[8], 0x2e);
  assert.equal(calls[0].url, 'https://oss.example.com/dl/x.fit?s=1');
  assert.equal(calls[0].auth, null, '签名直链不带鉴权头（OSS 对额外头敏感）');

  await client.download(session, { key: 'geo/2026/a.fit', fileName: 'a.fit' });
  assert.ok(calls[1].url.includes('/analysis/fit_content/'));
  assert.equal(calls[1].auth, 'tok');
});

test('download: 错误体检测——JSON/HTML 内容报 api 错误而非喂给解析器', async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ code: 4004, message: 'no such activity' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const client = listClient(fetchImpl);
  await assert.rejects(
    () => client.download({ token: 't', uid: '1' }, { key: 'geo/x.fit', fileName: 'x.fit' }),
    (e) => e.code === 'api' && /错误内容/.test(e.message),
  );
});

test('listSince 合并编排（e2e）: 旧路优先按本地日去重，日历只补缺口', async () => {
  const server = createMockOnelapServer({ activityCount: 5 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: `http://127.0.0.1:${port}/api/login`,
        rideRecord: `http://127.0.0.1:${port}/api/otm/ride_record`,
calendar: `http://127.0.0.1:${port}/api/otm/calendar/calendar/records`,
      },
    });
    const session = await client.login('rider@example.com', 'any');
    const all = await client.listSince(session, null);
    // 旧路 5 条（数字 id）覆盖了日历全部日期 → 日历全去重
    assert.equal(all.length, 5);
    assert.ok(all.every((a) => /^\d+$/.test(a.id)), '重叠日期由旧路（数字 id）优先');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('listSince 合并编排（e2e）: 旧列表失败 → OTM 日历独供（Mongo id）', async () => {
  const server = createMockOnelapServer({ activityCount: 3, failLegacyList: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: `http://127.0.0.1:${port}/api/login`,
        rideRecord: `http://127.0.0.1:${port}/api/otm/ride_record`,
calendar: `http://127.0.0.1:${port}/api/otm/calendar/calendar/records`,
      },
    });
    const session = await client.login('rider@example.com', 'any');
    const all = await client.listSince(session, null);
    assert.equal(all.length, 3);
    assert.ok(all.every((a) => a.id.startsWith('6a')), '回落后 id 来自 OTM 日历的 Mongo id');
    assert.ok(all.every((a) => a.startAt instanceof Date));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('listSince 合并编排（e2e）: 旧路优先按本地日去重，日历只补缺口', async () => {
  const server = createMockOnelapServer({ activityCount: 5 });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: 'http://127.0.0.1:' + port + '/api/login',
        rideRecord: 'http://127.0.0.1:' + port + '/api/otm/ride_record',
calendar: 'http://127.0.0.1:' + port + '/api/otm/calendar/calendar/records',
      },
    });
    const session = await client.login('rider@example.com', 'any');
    const all = await client.listSince(session, null);
    assert.equal(all.length, 5);
    assert.ok(all.every((a) => /^\d+$/.test(a.id)), '重叠日期由旧路（数字 id）优先');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test('listSince 合并编排（e2e）: 旧列表失败 → OTM 日历独供（Mongo id）', async () => {
  const server = createMockOnelapServer({ activityCount: 3, failLegacyList: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: 'http://127.0.0.1:' + port + '/api/login',
        rideRecord: 'http://127.0.0.1:' + port + '/api/otm/ride_record',
calendar: 'http://127.0.0.1:' + port + '/api/otm/calendar/calendar/records',
      },
    });
    const session = await client.login('rider@example.com', 'any');
    const all = await client.listSince(session, null);
    assert.equal(all.length, 3);
    assert.ok(all.every((a) => a.id.startsWith('6a')), '回落后 id 来自 OTM 日历的 Mongo id');
    assert.ok(all.every((a) => a.startAt instanceof Date));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test('listSince 合并编排（e2e）: 日历失败 → 旧列表兜底（旧行为回归）', async () => {
  const server = createMockOnelapServer({ activityCount: 4, failCalendar: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: 'http://127.0.0.1:' + port + '/api/login',
        rideRecord: 'http://127.0.0.1:' + port + '/api/otm/ride_record',
calendar: 'http://127.0.0.1:' + port + '/api/otm/calendar/calendar/records',
      },
    });
    const session = await client.login('rider@example.com', 'any');
    const all = await client.listSince(session, null);
    assert.equal(all.length, 4);
    assert.ok(all.every((a) => /^\d+$/.test(a.id)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('listSince 合并编排（e2e）: 双路皆败 → 显式报错（水位线由编排层冻结）', async () => {
  const server = createMockOnelapServer({ activityCount: 2, failLegacyList: true, failCalendar: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: 'http://127.0.0.1:' + port + '/api/login',
        rideRecord: 'http://127.0.0.1:' + port + '/api/otm/ride_record',
calendar: 'http://127.0.0.1:' + port + '/api/otm/calendar/calendar/records',
      },
    });
    const session = await client.login('rider@example.com', 'any');
    await assert.rejects(() => client.listSince(session, null), (e) => e.code === 'api');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
test('listSince 合并编排（e2e）: 窗口过滤按日粒度——日历老日期不进、当天不漏', async () => {
  const server = createMockOnelapServer({ activityCount: 3, failLegacyList: true });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const client = createOnelapClient({
      ...nodeDeps,
      fetchImpl: fetch,
      baseUrlOverrides: {
        login: 'http://127.0.0.1:' + port + '/api/login',
        rideRecord: 'http://127.0.0.1:' + port + '/api/otm/ride_record',
calendar: 'http://127.0.0.1:' + port + '/api/otm/calendar/calendar/records',
      },
    });
    const session = await client.login('rider@example.com', 'any');
    const since = new Date(Date.now() - 1.5 * 24 * 3600 * 1000);
    const all = await client.listSince(session, since);
    assert.ok(all.every((a) => localDateKey(a.startAt) >= localDateKey(since)), '日历条目按本地日粒度过滤');
    assert.ok(
      !all.some((a) => localDateKey(a.startAt) === localDateKey(new Date(Date.now() - 3 * 24 * 3600 * 1000))),
      '最老活动（3 天前）恒被日粒度过滤',
    );
    assert.ok(all.length >= 1 && all.length <= 2, '窗口内 1–2 条（数量随运行时刻跨日与否抖动）');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
