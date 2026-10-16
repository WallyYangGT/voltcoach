/**
 * mock-wahoo-server.mjs — Wahoo 云 API 本地 mock（2026-10 多平台化）
 *
 * 复刻官方通道的完整链路，并可**在模拟器里真跑一遍浏览器授权**：
 *   - `GET  /oauth/authorize` 校验 PKCE 参数齐全后，回一个自动跳转的 HTML 页
 *     （`<redirect_uri>?code=..&state=..`）——设备侧用 Custom Tab 打开时，Android 会把
 *     自定义 scheme 的跳转交回 App，等于把真实授权流程走通（含 scheme 回跳这一步）；
 *   - `POST /oauth/token` **按 code_challenge 反验 code_verifier**（sha256 → base64url），
 *     客户端的 PKCE 实现有半点偏差这里当场 invalid_grant——是防回归的哨兵；
 *   - `GET  /v1/workouts` 分页（per_page 上限 100）、恒按 starts 降序、含**未来计划训练**
 *     （客户端应滤掉）；
 *   - `GET  /v1/workouts/{id}/workout_summary` 回 `file.url`（pre-signed 直链形态）；
 *     指定活动回 403「You are not authorized to view this workout summary」= 手动录入/
 *     第三方来源，客户端应计跳过而非失败；
 *   - `GET  /cdn/<name>.fit` 直链**不校验鉴权头**（真实 CDN 口径）；
 *   - `DELETE /v1/permissions` 撤销授权（解绑路径）。
 * 令牌按官方语义**单次轮换**：刷新后旧 access/refresh 立刻作废。
 * FIT 字节由 test/make_test_fit.mjs 生成，起骑时刻跟活动元数据一致（防内容指纹误判）。
 *
 * 两种用法：
 *   node scripts/mock-wahoo-server.mjs        # 前台跑服务（默认 :8793，env MOCK_WAHOO_PORT）
 *   import { createMockWahooServer } from ...  # node:test 里起临时实例（端口 0）
 *
 * 模拟器内经 http://10.0.2.2:8793 访问宿主（Windows adb reverse 不可靠，见 docs/MAINTENANCE.md）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { buildRideFit } from '../test/make_test_fit.mjs';

/** 每页条数上限（官方口径 100） */
const MAX_PER_PAGE = 100;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json;charset=utf-8' });
  res.end(body);
}

/** base64url(sha256(v))——与客户端同口径（RFC 4648 §5，去填充） */
function s256(verifier) {
  return crypto.createHash('sha256').update(verifier, 'utf8').digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 云端活动夹具（恒按 starts 降序）。
 * - oldCount：追加窗口外的老活动（验证同步窗口截断）；
 * - futureCount：追加未来日期的计划训练（客户端应滤掉，别去查 summary 白花配额）；
 * - summaryForbiddenId：该活动 summary 回 403（手动录入/第三方来源 → 客户端计跳过）。
 */
function makeWorkouts(count = 5, oldCount = 0, futureCount = 0) {
  const now = Date.now();
  const latest = Array.from({ length: count }, (_, i) => {
    const starts = new Date(now - (i + 1) * 24 * 3600 * 1000);
    return {
      id: 56519 + i,
      starts: starts.toISOString(),
      name: `Morning Ride ${i + 1}`,
      startMs: starts.getTime(),
    };
  });
  const old = Array.from({ length: oldCount }, (_, i) => {
    const starts = new Date(now - (120 + i * 30) * 24 * 3600 * 1000);
    return { id: 55519 + i, starts: starts.toISOString(), name: `Old Ride ${i + 1}`, startMs: starts.getTime() };
  });
  const future = Array.from({ length: futureCount }, (_, i) => {
    const starts = new Date(now + (i + 1) * 24 * 3600 * 1000);
    return { id: 57519 + i, starts: starts.toISOString(), name: `Planned ${i + 1}`, startMs: starts.getTime() };
  });
  // 新→旧：计划训练（未来）排最前，符合服务端按 starts 降序
  return [...future.sort((a, b) => b.startMs - a.startMs), ...latest, ...old];
}

export function createMockWahooServer({
  workoutCount = 5,
  oldWorkoutCount = 0,
  futureWorkoutCount = 1,
  revokeTokenOnce = false,
  fitFile = process.env.MOCK_FIT_FILE ?? null,
} = {}) {
  const workouts = makeWorkouts(workoutCount, oldWorkoutCount, futureWorkoutCount);
  /** 手动作废 summary 的活动（403）——手动录入/第三方来源的形态 */
  const forbiddenSummaryId = workouts.filter((w) => w.startMs <= Date.now()).slice(-1)[0]?.id;
  const fixedFit = fitFile ? fs.readFileSync(fitFile) : null;
  if (fixedFit) console.log(`[mock-wahoo] MOCK_FIT_FILE=${fitFile}：所有活动回同一份 FIT 字节（去重演练）`);
  const fits = new Map(
    workouts.map((w) => [
      w.id,
      fixedFit ?? buildRideFit({ startMs: w.startMs, durationSec: 60, power: 190 + (w.id % 9) * 10, heartRate: 145 }),
    ]),
  );

  // ---- 授权态（模块内可变）：pending 授权码 → challenge；valid 令牌集合；轮换序号 ----
  const pending = new Map();
  const validAccess = new Set();
  const validRefresh = new Set();
  let counter = 0;
  let revokePending = revokeTokenOnce;

  const newTokens = () => {
    counter += 1;
    const access = `mock-wahoo-access-${counter}`;
    const refresh = `mock-wahoo-refresh-${counter}`;
    validAccess.add(access);
    validRefresh.add(refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 7200, token_type: 'Bearer', scope: 'user_read workouts_read offline_data' };
  };

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const port = req.socket.localPort;
    if (!process.env.NODE_TEST_CONTEXT) {
      console.log(`[mock-wahoo] ${new Date().toISOString().slice(11, 23)} ${req.method} ${path}${url.search}`);
    }

    // ---------------- 授权页：校验 PKCE 参数齐全 → 自动跳回 redirect_uri ----------------
    if (req.method === 'GET' && path === '/oauth/authorize') {
      const clientId = url.searchParams.get('client_id') ?? '';
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const challenge = url.searchParams.get('code_challenge') ?? '';
      const method = url.searchParams.get('code_challenge_method') ?? '';
      const scope = url.searchParams.get('scope') ?? '';
      if (!clientId || !redirectUri || !state || !challenge || method !== 'S256') {
        return json(res, 400, { error: 'invalid_request', error_description: '缺少 PKCE 参数（S256 是必需的）' });
      }
      if (!scope.includes('user_read') || !scope.includes('workouts_read')) {
        return json(res, 400, { error: 'invalid_scope', error_description: 'scope 缺 user_read/workouts_read' });
      }
      const code = `mock-wahoo-code-${pending.size + 1}`;
      pending.set(code, { challenge, redirectUri, clientId });
      const back = `${redirectUri}${redirectUri.includes('?') ? '&' : '?'}code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;
      // 真实浏览器授权页与这里的差别只是「用户点同意」这一步；自动跳转足以把回跳链路跑通
      res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
      return res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Mock Wahoo 授权</title>`
          + `<meta http-equiv="refresh" content="0;url=${back.replace(/&/g, '&amp;')}"></head>`
          + `<body style="font-family:sans-serif;background:#0a0d11;color:#d7ff3f">`
          + `<p>Mock 授权通过，正在返回 App…</p><p><a style="color:#d7ff3f" href="${back.replace(/&/g, '&amp;')}">没有自动跳转？点这里</a></p>`
          + `</body></html>`,
      );
    }

    // ---------------- 令牌：authorization_code / refresh_token（都验 code_verifier） ----------------
    if (req.method === 'POST' && path === '/oauth/token') {
      const form = new URLSearchParams(await readBody(req));
      const grant = form.get('grant_type');
      const clientId = form.get('client_id') ?? '';
      const verifier = form.get('code_verifier') ?? '';
      if (!clientId) return json(res, 400, { error: 'invalid_client', error_description: 'client_id 缺失' });
      if (!verifier) return json(res, 400, { error: 'invalid_request', error_description: 'PKCE 客户端必须带 code_verifier' });
      if (form.get('client_secret')) {
        // 公开客户端不该带 secret（带了说明端上存了不该存的东西）
        return json(res, 400, { error: 'invalid_request', error_description: 'PKCE 公开客户端不应携带 client_secret' });
      }

      if (grant === 'authorization_code') {
        const code = form.get('code') ?? '';
        const redirectUri = form.get('redirect_uri') ?? '';
        const auth = pending.get(code);
        if (!auth) return json(res, 400, { error: 'invalid_grant', error_description: 'unknown code' });
        if (auth.clientId !== clientId) return json(res, 400, { error: 'invalid_grant', error_description: 'client_id 不匹配' });
        if (auth.redirectUri !== redirectUri) {
          // redirect_uri 必须与授权时逐字一致（社区踩过的坑）
          return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri 不匹配' });
        }
        if (s256(verifier) !== auth.challenge) {
          // 哨兵：客户端的 PKCE 实现（随机数/base64url/SHA-256）任一步偏差都落在这里
          return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE 校验失败（code_verifier 与 code_challenge 不匹配）' });
        }
        pending.delete(code); // 授权码一次性
        return json(res, 200, newTokens());
      }

      if (grant === 'refresh_token') {
        const refresh = form.get('refresh_token') ?? '';
        if (!validRefresh.has(refresh)) {
          return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token 已失效' });
        }
        // 单次轮换：旧的 access/refresh 立刻作废（官方语义）
        for (const a of validAccess) validAccess.delete(a);
        validRefresh.delete(refresh);
        return json(res, 200, newTokens());
      }

      return json(res, 400, { error: 'unsupported_grant_type' });
    }

    // ---------------- 撤销授权（解绑路径） ----------------
    if (req.method === 'DELETE' && path === '/v1/permissions') {
      // 撤销：清空所有有效令牌（之后的请求一律 401）
      validAccess.clear();
      validRefresh.clear();
      return json(res, 204, '');
    }

    // ---------------- CDN 直链：在鉴权闸**之前**处理（真实 CDN 不过 API 鉴权） ----------------
    const cdn = /^\/cdn\/([^/]+)$/.exec(path);
    if (req.method === 'GET' && cdn) {
      const name = decodeURIComponent(cdn[1]);
      const id = Number(/^wahoo-(\d+)\.fit$/.exec(name)?.[1]);
      const w = workouts.find((x) => x.id === id);
      if (!w) return json(res, 404, { error: 'no such object' });
      if ((req.headers.authorization ?? '') !== '') {
        console.log('[mock-wahoo] 注意：CDN 直链请求带了 Authorization 头（真实 CDN 会忽略，但没必要带）');
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(fits.get(id));
    }

    // ---------------- 鉴权闸（workouts 各端点共用） ----------------
    const token = (/^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '') ?? [])[1] ?? '';
    if (revokePending) {
      revokePending = false;
      console.log('[mock-wahoo] 已吊销 token：本次请求返回 401（预期客户端随后自动刷新）');
      return json(res, 401, { error: 'unauthorized', error_description: 'token expired (mock)' });
    }
    if (!validAccess.has(token)) {
      return json(res, 401, { error: 'unauthorized', error_description: 'invalid or expired access token' });
    }

    // ---------------- 活动列表：分页 + 恒按 starts 降序 ----------------
    if (req.method === 'GET' && path === '/v1/workouts') {
      const page = Number(url.searchParams.get('page')) || 1;
      const perPage = Math.min(Number(url.searchParams.get('per_page')) || 30, MAX_PER_PAGE);
      const slice = workouts.slice((page - 1) * perPage, page * perPage);
      return json(res, 200, {
        // 列表里 workout_summary 恒为 null（真实口径：文件必须查详情）
        workouts: slice.map((w) => ({
          id: w.id,
          starts: w.starts,
          minutes: 60,
          name: w.name,
          workout_type_id: 40,
          workout_summary: null,
        })),
        total: workouts.length,
        page,
        per_page: perPage,
        order: 'descending',
        sort: 'starts',
      });
    }

    // ---------------- 活动详情：file.url（pre-signed 直链） ----------------
    const summary = /^\/v1\/workouts\/(\d+)\/workout_summary$/.exec(path);
    if (req.method === 'GET' && summary) {
      const id = Number(summary[1]);
      const w = workouts.find((x) => x.id === id);
      if (!w) return json(res, 404, { error: 'not_found' });
      if (id === forbiddenSummaryId) {
        // 手动录入 / 第三方 App 来源：官方原文口径
        return json(res, 403, { error: 'You are not authorized to view this workout summary' });
      }
      return json(res, 200, {
        id: w.id,
        name: w.name,
        manual: false,
        duration_total_accum: 3600,
        distance_accum: 30000,
        file: { url: `http://127.0.0.1:${port}/cdn/wahoo-${w.id}.fit` },
      });
    }

    return json(res, 404, { error: 'not_found', error_description: `no mock for ${req.method} ${path}` });
  });
}

// 直接运行：前台起服务（模拟器联调入口）
const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const port = Number(process.env.MOCK_WAHOO_PORT) || 8793;
  const fitFile = process.env.MOCK_FIT_FILE ?? null;
  createMockWahooServer({
    workoutCount: fitFile ? 1 : 5,
    oldWorkoutCount: 2,
    revokeTokenOnce: process.env.MOCK_REVOKE_ONCE === '1',
  }).listen(port, () => {
    console.log(`[mock-wahoo] listening on http://0.0.0.0:${port}（模拟器内用 http://10.0.2.2:${port}）`);
    console.log('[mock-wahoo] 授权页任意 Client ID 均可通过；PKCE 按 code_challenge 反验；'
      + '5 条近 5 天（最旧一条 summary 回 403 应计跳过）+ 1 条未来计划（应被滤掉）+ 2 条 120/150 天前');
    if (process.env.MOCK_REVOKE_ONCE === '1') console.log('[mock-wahoo] 本实例首个鉴权请求将返回 401（验证令牌刷新）');
  });
}
