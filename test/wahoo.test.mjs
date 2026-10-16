/**
 * wahoo.test.mjs — Wahoo 云客户端测试（node:test，官方 OAuth2 + PKCE 通道）
 *
 * 纯函数：form-urlencoded 编码（不用 URLSearchParams 的理由见实现）、授权 URL 组装
 * （scope 必须 %20 编码）、令牌响应解析与到期判定（刷新余量）、回调解析三形态
 * （自定义 scheme / https 中转 / 裸授权码）与 state 校验、文件 URL 提取、文件名口径。
 * e2e：对本仓库 mock-wahoo-server 跑完整授权链路——**mock 按 code_challenge 反验
 * code_verifier**，客户端的随机数/base64url/SHA-256 任一步偏差都会 invalid_grant；
 * 之后是 列表（滤掉未来计划）→ summary（403 活动计跳过）→ CDN 直链 → 刷新轮换 → 撤销。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMockWahooServer } from '../scripts/mock-wahoo-server.mjs';
import { isFitBytes } from '../src/sync/common.ts';
import { analyzeFile } from '../src/core/analyze.ts';
import { findDuplicateGroups } from '../src/core/dedupe.ts';
import {
  buildAuthorizeUrl,
  buildWahooFileName,
  createWahooClient,
  extractWorkoutFileUrl,
  formEncode,
  isAccessTokenExpired,
  parseTokenResponse,
  parseWahooCallback,
  parseWorkoutStarts,
  WAHOO_API_BASE,
  WAHOO_REFRESH_MARGIN_MS,
  WAHOO_SCOPES,
} from '../src/sync/wahoo.ts';

/** node:crypto 实现的环境注入（对齐 App 侧 expo-crypto 形状） */
const nodeDeps = {
  sha256Hex: (s) => Promise.resolve(crypto.createHash('sha256').update(s, 'utf8').digest('hex')),
  randomBytes: (n) => new Uint8Array(crypto.randomBytes(n)),
};

const PKCE = { verifier: 'v'.repeat(43), challenge: 'challenge-x', state: 'state-y' };

test('formEncode: 空格与保留字符按 x-www-form-urlencoded 编码', () => {
  assert.equal(formEncode({ a: '1', b: 'x y' }), 'a=1&b=x%20y');
  assert.equal(formEncode({ redirect_uri: 'voltcoach://wahoo' }), 'redirect_uri=voltcoach%3A%2F%2Fwahoo');
  assert.equal(formEncode({}), '');
});

test('buildAuthorizeUrl: 参数齐全、scope 空格编码为 %20、含 PKCE S256', () => {
  const url = new URL(
    buildAuthorizeUrl({ apiBase: WAHOO_API_BASE, clientId: 'cid', redirectUri: 'voltcoach://wahoo', pkce: PKCE }),
  );
  assert.equal(url.origin, 'https://api.wahooligan.com');
  assert.equal(url.pathname, '/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.equal(url.searchParams.get('redirect_uri'), 'voltcoach://wahoo');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('code_challenge'), 'challenge-x');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), 'state-y');
  assert.equal(url.searchParams.get('scope'), WAHOO_SCOPES);
  assert.ok(url.search.includes('scope=user_read%20workouts_read%20offline_data'), '空格要编码成 %20');
});

test('parseTokenResponse: 正常响应算到期时刻；缺关键字段按授权失败抛 auth', () => {
  const tokens = parseTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 7200 }, 1_000_000);
  assert.deepEqual(tokens, { accessToken: 'a', refreshToken: 'r', expiresAt: 1_000_000 + 7200_000 });

  // expires_in 缺失 → 按官方口径的 2 小时兜底
  assert.equal(parseTokenResponse({ access_token: 'a', refresh_token: 'r' }, 0).expiresAt, 7200_000);

  assert.throws(
    () => parseTokenResponse({ error: 'invalid_grant', error_description: 'bad code' }, 0),
    (e) => e.code === 'auth' && /bad code/.test(e.message),
  );
  assert.throws(() => parseTokenResponse({ access_token: 'a' }, 0), (e) => e.code === 'auth');
  assert.throws(() => parseTokenResponse(null, 0), (e) => e.code === 'auth');
});

test('isAccessTokenExpired: 到期前 5 分钟即视为过期（提前刷新）', () => {
  const now = 1_000_000;
  const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: now + 10 * 60 * 1000 };
  assert.equal(isAccessTokenExpired(tokens, now), false);
  assert.equal(isAccessTokenExpired(tokens, now + 6 * 60 * 1000), true, '余量内应刷新');
  assert.equal(isAccessTokenExpired({ ...tokens, expiresAt: now + WAHOO_REFRESH_MARGIN_MS }, now), true, '余量边界');
  assert.equal(isAccessTokenExpired({ ...tokens, expiresAt: Number.NaN }, now), true, '脏数据按过期处理');
});

test('parseWahooCallback: 自定义 scheme / https 中转 / 裸授权码三形态都认', () => {
  assert.deepEqual(parseWahooCallback('voltcoach://wahoo?code=abc&state=st', 'st'), { code: 'abc' });
  assert.deepEqual(
    parseWahooCallback('https://example.com/wahoo/callback?code=abc%2F1&state=st#frag', 'st'),
    { code: 'abc/1' },
  );
  // 裸码（用户只复制了 code；无 URL 结构）
  assert.deepEqual(parseWahooCallback('  rawcode123  ', 'st'), { code: 'rawcode123' });
  // state 缺省（裸码/精简链接）时不强校验
  assert.deepEqual(parseWahooCallback('voltcoach://wahoo?code=abc', 'st'), { code: 'abc' });
});

test('parseWahooCallback: 拒绝 / state 不匹配 / 空输入都给 auth 错误', () => {
  assert.throws(
    () => parseWahooCallback('voltcoach://wahoo?error=access_denied&error_description=user said no', 'st'),
    (e) => e.code === 'auth' && /user said no/.test(e.message),
  );
  assert.throws(
    () => parseWahooCallback('voltcoach://wahoo?code=abc&state=OTHER', 'st'),
    (e) => e.code === 'auth' && /state/.test(e.message),
  );
  assert.throws(() => parseWahooCallback('', 'st'), (e) => e.code === 'auth');
  assert.throws(() => parseWahooCallback('voltcoach://wahoo', 'st'), (e) => e.code === 'auth');
});

test('parseWorkoutStarts / extractWorkoutFileUrl / buildWahooFileName', () => {
  const d = parseWorkoutStarts('2015-08-12T09:00:00.000Z');
  assert.equal(d.toISOString(), '2015-08-12T09:00:00.000Z');
  assert.equal(parseWorkoutStarts('garbage'), null);
  assert.equal(parseWorkoutStarts(''), null);

  assert.equal(extractWorkoutFileUrl({ file: { url: ' https://cdn/x.fit ' } }), 'https://cdn/x.fit');
  assert.equal(extractWorkoutFileUrl({ file: {} }), null);
  assert.equal(extractWorkoutFileUrl({ manual: true }), null);
  assert.equal(extractWorkoutFileUrl(null), null);

  // 文件名刻意用云端 id（不用直链 basename：Wahoo 的文件名常是训练名，重名会漏活动）
  assert.equal(buildWahooFileName('56519'), 'wahoo-56519.fit');

  assert.equal(isFitBytes(new Uint8Array([0x0e, 0, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54])), true);
  assert.equal(isFitBytes(new Uint8Array([1, 2, 3])), false);
});

/** 最小客户端（e2e 用；region/base 由各用例给） */
function client(env) {
  return createWahooClient({
    ...nodeDeps,
    fetchImpl: fetch,
    baseUrlOverrides: { api: `http://127.0.0.1:${env.port}` },
    now: env.now,
  });
}

/** 起临时 mock（端口 0）并按授权页 HTML 里的跳转链接「模拟浏览器回跳」取 code */
async function withMock(options, fn) {
  const server = createMockWahooServer(options);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn({ port });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/** 走一遍授权页：请求 HTML → 取出自动跳转的 URL（等价于浏览器完成授权并回跳 App） */
async function authorizeThrough(pageUrl, redirectUri) {
  const res = await fetch(pageUrl);
  assert.equal(res.status, 200, '授权页应正常返回');
  const html = await res.text();
  const m = /href="([^"]+)"/.exec(html);
  assert.ok(m, '授权页应含回跳链接');
  const back = m[1].replace(/&amp;/g, '&');
  assert.ok(back.startsWith(redirectUri), '回跳地址应以 redirect_uri 开头');
  return back;
}

test('e2e: PKCE 授权（mock 反验 challenge）→ 列表滤未来计划 → summary → CDN 下载 → 403 跳过', async () => {
  await withMock({ workoutCount: 5, futureWorkoutCount: 1, oldWorkoutCount: 2 }, async (env) => {
    const c = client(env);
    const redirectUri = 'voltcoach://wahoo';

    // ① PKCE 三件套（43 字符 verifier + S256 challenge + state）
    const pkce = await c.newPkce();
    assert.equal(pkce.verifier.length, 43);
    assert.match(pkce.verifier, /^[A-Za-z0-9_-]+$/);
    assert.equal(pkce.challenge, crypto.createHash('sha256').update(pkce.verifier, 'utf8').digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    assert.ok(pkce.state.length >= 16);

    // ② 浏览器授权（mock 校验 scope 含 user_read/workouts_read 与 S256）
    const pageUrl = c.authorizeUrl({ clientId: 'mock-client', redirectUri, pkce });
    const backUrl = await authorizeThrough(pageUrl, redirectUri);
    const { code } = parseWahooCallback(backUrl, pkce.state);

    // ③ 换令牌：mock 用 code_challenge 反验 code_verifier —— PKCE 实现错了这里必炸
    const tokens = await c.exchangeCode({ clientId: 'mock-client', code, codeVerifier: pkce.verifier, redirectUri });
    assert.match(tokens.accessToken, /^mock-wahoo-access-/);
    assert.match(tokens.refreshToken, /^mock-wahoo-refresh-/);
    assert.ok(tokens.expiresAt > Date.now());

    // ④ 列表：未来计划训练被滤掉；窗口内 5 条（2 条窗口外老活动由 since 滤掉）
    const all = await c.listSince(tokens, null);
    // 未设窗口 → 8 条夹具里只去掉 1 条未来计划（5 近 + 2 老都应出现）
    assert.equal(all.length, 7, '未来计划应被滤掉');
    assert.ok(all.every((a) => a.startAt instanceof Date));
    const recent = await c.listSince(tokens, new Date(Date.now() - 2.5 * 24 * 3600 * 1000));
    assert.equal(recent.length, 2);

    // ⑤ summary → CDN 直链（裸 GET）→ FIT 字节
    const ref = await c.getFileRef(tokens, all[0]);
    assert.equal(ref.fileName, `wahoo-${all[0].id}.fit`);
    assert.match(ref.key, /\/cdn\/wahoo-\d+\.fit$/);
    const bytes = await c.download(tokens, ref);
    assert.equal(bytes[0], 0x0e);
    assert.equal(isFitBytes(bytes), true);

    // ⑥ 403 的活动（手动录入/第三方来源形态）→ null（编排层计跳过，不是失败）
    const forbidden = all[all.length - 1];
    assert.equal(await c.getFileRef(tokens, forbidden), null);

    // ⑦ 刷新轮换：换完旧 refresh 立刻作废（官方语义）
    const refreshed = await c.refreshTokens({
      clientId: 'mock-client',
      refreshToken: tokens.refreshToken,
      codeVerifier: pkce.verifier,
    });
    assert.notEqual(refreshed.accessToken, tokens.accessToken);
    await assert.rejects(
      () =>
        c.refreshTokens({
          clientId: 'mock-client',
          refreshToken: tokens.refreshToken, // 旧的
          codeVerifier: pkce.verifier,
        }),
      (e) => e.code === 'auth',
    );
    // 新 access token 可用，旧 access token 已随轮换作废
    assert.ok((await c.listSince(refreshed, null)).length >= 1);
    await assert.rejects(() => c.listSince(tokens, null), (e) => e.code === 'auth');

    // ⑧ 解绑：撤销授权后令牌全废
    await c.revoke(refreshed.accessToken);
    await assert.rejects(() => c.listSince(refreshed, null), (e) => e.code === 'auth');
  });
});

test('e2e: PKCE 参数被篡改（verifier 与 challenge 不配对）→ 授权码被拒', async () => {
  await withMock({ workoutCount: 1 }, async (env) => {
    const c = client(env);
    const redirectUri = 'voltcoach://wahoo';
    const pkce = await c.newPkce();
    const backUrl = await authorizeThrough(c.authorizeUrl({ clientId: 'cid', redirectUri, pkce }), redirectUri);
    const { code } = parseWahooCallback(backUrl, pkce.state);
    await assert.rejects(
      () =>
        c.exchangeCode({
          clientId: 'cid',
          code,
          codeVerifier: 'X'.repeat(43), // 与 challenge 不配对
          redirectUri,
        }),
      // 令牌端点的 400 归 auth（给用户的处置是重新授权），但必须带出服务端原因
      (e) => e.code === 'auth' && /PKCE/.test(e.message),
    );
  });
});

test('e2e: 未授权访问 → 401 归一为 auth（编排层据此走刷新/重授权）', async () => {
  await withMock({ workoutCount: 1 }, async (env) => {
    const c = client(env);
    await assert.rejects(
      () => c.listSince({ accessToken: 'not-a-token', refreshToken: 'r', expiresAt: Date.now() + 1e6 }, null),
      (e) => e.code === 'auth',
    );
  });
});

/** mock 夹具回归：各活动的 FIT 起骑时刻必须互不相同（否则内容指纹会把多条并成一趟） */
test('mock 夹具: 各活动的 FIT 内容互不为同一趟骑行（内容指纹不误判）', async () => {
  await withMock({ workoutCount: 3, futureWorkoutCount: 0 }, async (env) => {
    const c = client(env);
    const redirectUri = 'voltcoach://wahoo';
    const pkce = await c.newPkce();
    const backUrl = await authorizeThrough(c.authorizeUrl({ clientId: 'cid', redirectUri, pkce }), redirectUri);
    const { code } = parseWahooCallback(backUrl, pkce.state);
    const tokens = await c.exchangeCode({ clientId: 'cid', code, codeVerifier: pkce.verifier, redirectUri });

    const list = await c.listSince(tokens, null);
    assert.equal(list.length, 3);
    const keys = [];
    for (const act of list) {
      const ref = await c.getFileRef(tokens, act);
      if (!ref) continue; // 夹具里最后一条 summary 回 403（跳过分支）
      const bytes = await c.download(tokens, ref);
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
