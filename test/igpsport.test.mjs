/**
 * igpsport.test.mjs — 迹驰云客户端测试（node:test）
 *
 * 纯函数：时间多格式解析（国内点分日期 vs 国际全格式，见客户端文件头 ②）、列表 URL
 * 组装（国内才有 sortType）、文件名规范化、响应载荷解包与错误码、FIT 直链三种形态。
 * e2e：对本仓库 mock-igpsport-server（临时端口）跑 登录→分页列表→两条取地址路径
 * →OSS 直链下载→无文件活动跳过→错密码/坏 token 全流程——mock 按真实服务端行为
 * （业务码 code:0、每页固定 20 条、直链不校验鉴权）实现，任一偏差当场失败。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockIgpsportServer } from '../scripts/mock-igpsport-server.mjs';
import { analyzeFile } from '../src/core/analyze.ts';
import { findDuplicateGroups } from '../src/core/dedupe.ts';
import {
  buildActivityListUrl,
  createIgpsportClient,
  extractIgpsportFileName,
  IGPSPORT_REGIONS,
  parseIgpsportTime,
  pickFitUrl,
  toDayParam,
  unwrapPayload,
} from '../src/sync/igpsport.ts';

test('parseIgpsportTime: 四种实证格式（国内点分日期 / 国际全格式 / 纯日期）都解析为本地时区', () => {
  const expect1 = new Date(2026, 8, 15, 8, 30, 5).getTime();
  assert.equal(parseIgpsportTime('2026-09-15 08:30:05').getTime(), expect1);
  assert.equal(parseIgpsportTime('2026.09.15 08:30:05').getTime(), expect1);
  assert.equal(parseIgpsportTime('2026.09.15').getTime(), new Date(2026, 8, 15).getTime());
  assert.equal(parseIgpsportTime('2026-09-15').getTime(), new Date(2026, 8, 15).getTime());
  assert.equal(parseIgpsportTime(' 2026.09.15 ').getTime(), new Date(2026, 8, 15).getTime(), '两端空白容忍');
  // 非法输入一律 null（调用方按「时间未知」处理，不猜）
  for (const bad of ['', 'garbage', '2026-09-15T08:30:05Z', '20260915', '26.09.15']) {
    assert.equal(parseIgpsportTime(bad), null, `应拒绝: ${bad}`);
  }
});

test('toDayParam: 本地日历日 → YYYY-MM-DD（列表 beginTime/endTime 口径）', () => {
  assert.equal(toDayParam(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
  assert.equal(toDayParam(new Date(2026, 11, 31)), '2026-12-31');
});

test('buildActivityListUrl: 分页/排序参数齐全；国内带 sortType、国际不带；since 转日期区间', () => {
  const cn = new URL(buildActivityListUrl(IGPSPORT_REGIONS.cn, 2, null));
  assert.equal(cn.pathname, '/service/web-gateway/web-analyze/activity/queryMyActivity');
  assert.equal(cn.searchParams.get('pageNo'), '2');
  assert.equal(cn.searchParams.get('pageSize'), '20');
  assert.equal(cn.searchParams.get('reqType'), '0');
  assert.equal(cn.searchParams.get('sort'), '1');
  assert.equal(cn.searchParams.get('sortType'), '1');
  assert.equal(cn.searchParams.get('beginTime'), null, '无窗口起点时不带日期过滤');

  const intl = new URL(buildActivityListUrl(IGPSPORT_REGIONS.intl, 1, null));
  assert.equal(intl.searchParams.get('sortType'), null, '国际区不带 sortType');
  assert.equal(intl.origin, 'https://prod.en.igpsport.com');

  const since = new Date(2026, 5, 1);
  const win = new URL(buildActivityListUrl(IGPSPORT_REGIONS.cn, 1, since, new Date(2026, 8, 22)));
  assert.equal(win.searchParams.get('beginTime'), '2026-06-01');
  assert.equal(win.searchParams.get('endTime'), '2026-09-22');
});

test('extractIgpsportFileName: 取 URL basename + 强制 .fit；取不到名字回退 rideId', () => {
  assert.equal(
    extractIgpsportFileName('https://oss-cn-hangzhou.aliyuncs.com/act/20260527/iGPSPORT_2026-05-27-163236.fit?x=1', '88001'),
    'iGPSPORT_2026-05-27-163236.fit',
  );
  assert.equal(extractIgpsportFileName('https://oss.aliyuncs.com/a/b/ride.fit', '88002'), 'ride.fit');
  assert.equal(extractIgpsportFileName('not-a-url', '88003'), 'not-a-url.fit');
  assert.equal(extractIgpsportFileName('', '88004'), 'igpsport-88004.fit');
  assert.equal(extractIgpsportFileName('https://oss.aliyuncs.com/', '88005'), 'igpsport-88005.fit');
});

test('unwrapPayload: code 0/200/缺失视为成功；其余业务码抛 api 错误并带服务端文案', () => {
  assert.deepEqual(unwrapPayload({ code: 0, data: { a: 1 } }, 'x'), { a: 1 });
  assert.deepEqual(unwrapPayload({ code: 200, data: { a: 1 } }, 'x'), { a: 1 });
  assert.equal(unwrapPayload({ code: 0, data: 'https://oss/x.fit' }, 'x'), 'https://oss/x.fit', 'data 为字符串照样透出');
  assert.equal(unwrapPayload({}, 'x'), null);
  assert.throws(
    () => unwrapPayload({ code: 1001, message: '账号或密码错误' }, '登录'),
    (e) => e.code === 'api' && /账号或密码错误/.test(e.message),
  );
  // 非数字业务码（脏响应）不当作失败，交给字段检查兜底
  assert.deepEqual(unwrapPayload({ code: 'weird', data: { ok: 1 } }, 'x'), { ok: 1 });
});

test('pickFitUrl: 三种形态（fitUrl 字段 / url 字段 / 直接字符串）都认，空值返回 null', () => {
  assert.equal(pickFitUrl({ fitUrl: ' https://oss/a.fit ' }), 'https://oss/a.fit');
  assert.equal(pickFitUrl({ url: 'https://oss/b.fit' }), 'https://oss/b.fit');
  assert.equal(pickFitUrl('https://oss/c.fit'), 'https://oss/c.fit');
  assert.equal(pickFitUrl({ fitUrl: '  ' }), null);
  assert.equal(pickFitUrl({}), null);
  assert.equal(pickFitUrl(null), null);
  assert.equal(pickFitUrl(123), null);
});

/** 起临时 mock（端口 0）并返回客户端工厂参数 */
async function withMock(options, fn) {
  const server = createMockIgpsportServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn({
      port,
      region: 'cn',
      baseUrlOverrides: { api: `http://127.0.0.1:${port}` },
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('e2e: 登录 → 分页列表（含时间格式双形态）→ 两条取地址路径 → OSS 直链下载', async () => {
  await withMock({ activityCount: 5, acceptPassword: 'hunter2' }, async (env) => {
    const client = createIgpsportClient({ region: env.region, fetchImpl: fetch, baseUrlOverrides: env.baseUrlOverrides });

    // ① 登录：业务码 code:0 + data.access_token
    const session = await client.login('rider@example.com', 'hunter2');
    assert.equal(session.token, 'mock-igpsport-token');

    // ② 列表：5 条近 5 天（各页 20 条上限，一页拿完），startAt 已解析
    const all = await client.listSince(session, null);
    assert.equal(all.length, 5);
    for (const a of all) assert.ok(a.startAt instanceof Date, `活动 ${a.id} 的起骑时间应已解析`);

    // ③ 窗口过滤：since 卡在 2.5 天前 → 只剩 2 条
    const since = new Date(Date.now() - 2.5 * 24 * 3600 * 1000);
    const recent = await client.listSince(session, since);
    assert.equal(recent.length, 2);

    // ④ 无文件的活动：云端两条路径都拿不到地址 → null（编排层计跳过而非失败）
    const noFile = all.find((a) => a.id === '88004');
    assert.ok(noFile, '夹具最旧一条应为无文件活动');
    assert.equal(await client.getFileRef(session, noFile), null);

    // ⑤ 有文件的活动：detail 与 getDownloadUrl 两条路径各一半，都要拿到直链并下载出 FIT
    for (const id of ['88000', '88001']) {
      const act = all.find((a) => a.id === id);
      const ref = await client.getFileRef(session, act);
      assert.ok(ref, `活动 ${id} 应取到文件引用`);
      assert.match(ref.fileName, /^iGPSPORT_2026-\d{2}-\d{2}-\d+\.fit$/);
      const bytes = await client.download(session, ref);
      assert.ok(bytes.length > 14, 'FIT 字节非空');
      assert.equal(bytes[0], 0x0e); // FIT 头长度字节（make_test_fit 生成 14 字节头）
      assert.equal(String.fromCharCode(...bytes.slice(8, 12)), '.FIT');
    }

    // ⑥ 错误路径：错密码 → auth
    await assert.rejects(
      () => client.login('rider@example.com', 'wrong'),
      (e) => e.code === 'auth',
    );

    // ⑦ 错误路径：坏 token → 鉴权闸 401 → auth
    await assert.rejects(
      () => client.listSince({ token: 'bad' }, null),
      (e) => e.code === 'auth',
    );
  });
});

test('e2e: 国际区客户端同样跑通（域名不同，行为一致）', async () => {
  await withMock({ activityCount: 2 }, async (env) => {
    const client = createIgpsportClient({ region: 'intl', fetchImpl: fetch, baseUrlOverrides: env.baseUrlOverrides });
    const session = await client.login('rider@example.com', 'any');
    const list = await client.listSince(session, null);
    assert.equal(list.length, 2);
  });
});

test('e2e: 下载到非 FIT 内容 → 明确报错（防把错误页当骑行数据入库）', async () => {
  // 用一个只回 HTML 的假 OSS：把 baseUrlOverrides 指向一个自建 server 之外的最小桩
  const http = await import('node:http');
  const stub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>error</html>');
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const port = stub.address().port;
  try {
    const client = createIgpsportClient({ region: 'cn', fetchImpl: fetch });
    await assert.rejects(
      () => client.download({ token: 't' }, { key: `http://127.0.0.1:${port}/broken.fit`, fileName: 'broken.fit' }),
      (e) => e.code === 'api' && /不是 FIT/.test(e.message),
    );
  } finally {
    await new Promise((resolve) => stub.close(resolve));
  }
});

/** mock 夹具回归：各活动的 FIT 起骑时刻必须互不相同（否则内容指纹会把多条并成一趟） */
test('mock 夹具: 各活动的 FIT 内容互不为同一趟骑行（内容指纹不误判）', async () => {
  await withMock({ activityCount: 3 }, async (env) => {
    const client = createIgpsportClient({ region: 'cn', fetchImpl: fetch, baseUrlOverrides: env.baseUrlOverrides });
    const session = await client.login('rider@example.com', 'any');
    const list = await client.listSince(session, null);
    assert.equal(list.length, 3);

    const keys = [];
    for (const act of list) {
      const ref = await client.getFileRef(session, act);
      if (!ref) continue; // 最旧一条无文件（夹具刻意留的跳过分支）
      const bytes = await client.download(session, ref);
      const { summary } = await analyzeFile({ bytes, fileName: ref.fileName });
      keys.push({
        file_name: ref.fileName,
        date: summary.activity.date,
        duration_sec: summary.activity.duration_sec,
        distance_km: summary.activity.distance_km,
      });
    }
    assert.equal(new Set(keys.map((k) => k.date)).size, keys.length, '每条活动的骑行日期应各不相同');
    assert.deepEqual(findDuplicateGroups(keys), [], '不应被判为重复组');
  });
});
