/**
 * wahoo.ts — Wahoo 云直拉客户端（**官方 API**，2026-10 多平台化）
 *
 * 与顽鹿/迹驰不同，Wahoo 走官方通道：OAuth2 授权码 + PKCE（公开客户端，无 client_secret）。
 * 但官方开发者门户的 client_id 要**每个用户自己**注册一个 sandbox 应用（沙盒对自己账号
 * 免审批、即时可用）——本项目没有服务端、也不该代持第三方应用凭据，故取 BYOK 形态：
 * 设置页填 Client ID → 浏览器授权 → 令牌只存本机 Keystore。
 *
 * 链路（口径来自 cloud-api.wahooligan.com 与多个生产实现交叉验证）：
 *   authorize GET  {api}/oauth/authorize?client_id&redirect_uri&response_type=code&scope
 *             &state&code_challenge&code_challenge_method=S256
 *   token     POST {api}/oauth/token（**form-urlencoded**，文档里写 json 是错的）
 *             authorization_code 与 refresh_token 两种 grant；PKCE 客户端**都不带 client_secret**，
 *             且刷新时同样要带 code_verifier（官方文档明示，故 verifier 必须随凭据一起保存）
 *   workouts  GET  {api}/v1/workouts?page&per_page=100——恒按 starts 降序、列表里
 *             workout_summary 恒为 null，文件必须逐个活动查详情
 *   summary   GET  {api}/v1/workouts/{id}/workout_summary → file.url
 *   download  直链裸 GET：**不需要鉴权头、不计限流**，但有效期只有几小时（拿到即下载）
 *   revoke    DELETE {api}/v1/permissions——解绑时调用，释放「每用户最多 10 个未吊销 token」配额
 *
 * 既定边界（社区实测记录，不是猜测）：
 *  - access token 2 小时有效、refresh token **单次轮换**（刷新后旧的一对在「用新 access
 *    成功调一次 API」后失效）——本模块到期前 5 分钟自动刷新，刷新即接着拉数据，天然满足；
 *  - 手动录入（manual:true）与第三方 App 来源的骑行拿不到 summary（403/404）→ getFileRef
 *    返回 null（计跳过而非失败：重试多少次都不会有文件）；
 *  - 沙盒限流 25 次/5 分钟、100/小时、250/天（FIT 下载不计入）——列表 per_page 取 100
 *    并把「未来的计划训练」提前滤掉，都是为了少花配额。
 *
 * 依赖注入（同 onelap.ts 口径：不 import 任何 RN/Expo，node:test 直测）。
 */

import {
  base64UrlEncode,
  DOWNLOAD_TIMEOUT_MS,
  fetchWithTimeout,
  hexToBytes,
  REQUEST_TIMEOUT_MS,
  SyncError,
  type FetchLike,
  type FileRef,
  type RemoteActivity,
  type SyncClient,
} from './common.ts';

export const WAHOO_API_BASE = 'https://api.wahooligan.com';
/** 授权范围：user_read 必需（否则 403）；offline_data 是拿 refresh token 的前提 */
export const WAHOO_SCOPES = 'user_read workouts_read offline_data';
/**
 * 默认回调地址（门户是否接受自定义 scheme 需实测，被拒时用卡片里的「手动粘贴回调链接」兜底）。
 * ⚠️ 三斜杠是**路径形式**（host 为空、path=/wahoo-callback）：两斜杠会被 expo-router 当成
 * host 去匹配路由，落进 Unmatched Route 错误页（2026-10-16 模拟器冒烟实测）；路径形式能
 * 稳定命中 app/wahoo-callback.tsx 这个收尾路由。用户登记到门户的值必须与这里逐字一致。
 */
export const WAHOO_DEFAULT_REDIRECT = 'voltcoach:///wahoo-callback';
/** 到期前提前刷新的余量（access token 2 小时有效） */
export const WAHOO_REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** 列表每页条数（官方上限 100） */
const WORKOUTS_PER_PAGE = 100;

/** 授权结果（刷新是单次轮换，每次都整体替换） */
export interface WahooTokens {
  accessToken: string;
  refreshToken: string;
  /** access token 到期时刻（epoch 毫秒） */
  expiresAt: number;
}

export interface WahooDeps {
  fetchImpl?: FetchLike;
  /** 联调覆盖（mock 服务端） */
  baseUrlOverrides?: { api?: string };
  /** SHA-256 hex（PKCE code_challenge 用；App 侧 expo-crypto，测试传 node:crypto） */
  sha256Hex?: (value: string) => Promise<string>;
  /** 随机字节（PKCE verifier 与 state 用） */
  randomBytes?: (length: number) => Uint8Array;
  now?: () => number;
  timeouts?: { requestMs?: number; downloadMs?: number };
}

/** PKCE 参数（verifier 必须与令牌一起持久化：刷新时还要用） */
export interface WahooPkce {
  verifier: string;
  challenge: string;
  state: string;
}

export interface WahooClient extends SyncClient<WahooTokens> {
  /** 生成 PKCE 三件套 */
  newPkce(): Promise<WahooPkce>;
  /** 拼授权页 URL（交设备侧用浏览器打开） */
  authorizeUrl(p: { clientId: string; redirectUri: string; pkce: WahooPkce }): string;
  /** 授权码换令牌 */
  exchangeCode(p: { clientId: string; code: string; codeVerifier: string; redirectUri: string }): Promise<WahooTokens>;
  /** 刷新令牌（单次轮换；刷新后请立即用新 access 发一次请求） */
  refreshTokens(p: { clientId: string; refreshToken: string; codeVerifier: string }): Promise<WahooTokens>;
  /** 撤销应用权限（解绑时尽力而为） */
  revoke(accessToken: string): Promise<void>;
}

// ---------------- 纯函数（node:test 直接覆盖） ----------------

/** form-urlencoded 编码（不用 URLSearchParams：RN 的 polyfill 实现不完整，手拼最稳） */
export function formEncode(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** 授权页 URL（query 手拼 encodeURIComponent：scope 里的空格必须编码成 %20） */
export function buildAuthorizeUrl(p: {
  apiBase: string;
  clientId: string;
  redirectUri: string;
  pkce: WahooPkce;
  scopes?: string;
}): string {
  const query = formEncode({
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: p.scopes ?? WAHOO_SCOPES,
    state: p.pkce.state,
    code_challenge: p.pkce.challenge,
    code_challenge_method: 'S256',
  });
  return `${p.apiBase}/oauth/authorize?${query}`;
}

/** token 端点响应 → 令牌（`expires_in` 缺失按 2 小时兜底；缺 access/refresh 即报错） */
export function parseTokenResponse(json: unknown, nowMs: number): WahooTokens {
  const obj = (json ?? {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  };
  const accessToken = typeof obj.access_token === 'string' ? obj.access_token : '';
  const refreshToken = typeof obj.refresh_token === 'string' ? obj.refresh_token : '';
  if (!accessToken || !refreshToken) {
    const detail = obj.error_description ?? obj.error ?? JSON.stringify(json).slice(0, 200);
    throw new SyncError('auth', `授权失败：${String(detail)}`);
  }
  const expiresIn = Number(obj.expires_in);
  const ttlMs = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn * 1000 : 2 * 3600 * 1000;
  return { accessToken, refreshToken, expiresAt: nowMs + ttlMs };
}

/** 是否需要刷新（到期前 WAHOO_REFRESH_MARGIN_MS 内即视为过期） */
export function isAccessTokenExpired(tokens: WahooTokens, nowMs: number): boolean {
  return !Number.isFinite(tokens.expiresAt) || nowMs >= tokens.expiresAt - WAHOO_REFRESH_MARGIN_MS;
}

/**
 * 解析授权回调。三种输入都支持：
 *  - 完整回调 URL（`voltcoach://wahoo?code=..&state=..`，浏览器自动跳回时拿到）；
 *  - 完整 https 中转链接（门户若只收 https，用户从地址栏复制过来的那种）；
 *  - 直接粘贴的授权码（裸码）。
 * state 不匹配或带 error（用户点了拒绝）都抛 auth 错误。
 */
export function parseWahooCallback(raw: string, expectedState: string | null): { code: string } {
  const text = (raw ?? '').trim();
  if (!text) throw new SyncError('auth', '回调链接为空');
  const queryStart = text.indexOf('?');
  const query = queryStart >= 0 ? text.slice(queryStart + 1).split('#')[0] : '';
  let params: Record<string, string> = {};
  if (query) {
    for (const pair of query.split('&')) {
      const [k, v = ''] = pair.split('=');
      if (k) params[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
    }
  } else if (!/[?&#=:/\\\s]/.test(text)) {
    // 裸授权码：无任何 URL 结构（无 scheme/路径/参数）时，按「粘贴的就是授权码」处理
    // （手动兜底路径）；有 URL 形状却带不出 code，说明拿错了链接，见下面的报错分支
    return { code: text };
  } else {
    throw new SyncError('auth', `回调链接无法解析: ${text.slice(0, 120)}`);
  }
  if (params.error) {
    throw new SyncError('auth', `授权被拒：${params.error_description ?? params.error}`);
  }
  if (expectedState && params.state && params.state !== expectedState) {
    throw new SyncError('auth', '授权回调的 state 不匹配（可能是过期的授权页，请重新发起）');
  }
  if (!params.code) throw new SyncError('auth', '回调链接里没有授权码');
  return { code: params.code };
}

/** ISO 起骑时刻 → Date（Wahoo 给的是带毫秒的 UTC ISO） */
export function parseWorkoutStarts(value: string): Date | null {
  const t = Date.parse((value ?? '').trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

/**
 * workout_summary → FIT 直链。`file.url` 是 pre-signed S3 地址（小时级有效）。
 * 手动录入/第三方来源的 summary 里没有 file，返回 null（调用方按「无文件」处理）。
 */
export function extractWorkoutFileUrl(summary: unknown): string | null {
  const obj = (summary ?? {}) as { file?: { url?: unknown } | null };
  const url = obj.file?.url;
  return typeof url === 'string' && url.trim() ? url.trim() : null;
}

/**
 * 活动 → 入库文件名。**刻意不看文件的 URL 名**：Wahoo 的直链名往往就是训练名
 * （「4_Mile_Segment_.fit」这类，重名概率高），而「文件名预检命中即跳过」会把重名的
 * 新活动静默漏掉——用云端活动 id 生成唯一且跨轮稳定的名字，宁可名字朴素也不丢活动。
 */
export function buildWahooFileName(workoutId: string): string {
  return `wahoo-${workoutId}.fit`;
}

/** FIT 魔数校验（字节 8–11 == ".FIT"），与迹驰同口径 */
export function isFitBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === '.FIT';
}

// ---------------- 客户端 ----------------

export function createWahooClient(deps: WahooDeps = {}): WahooClient {
  const apiBase = deps.baseUrlOverrides?.api ?? WAHOO_API_BASE;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const sha256Hex = deps.sha256Hex ?? (async () => '');
  const randomBytes = deps.randomBytes ?? ((n: number) => new Uint8Array(n));
  const nowMs = deps.now ?? (() => Date.now());
  const requestTimeoutMs = deps.timeouts?.requestMs ?? REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = deps.timeouts?.downloadMs ?? DOWNLOAD_TIMEOUT_MS;

  /** 统一请求出口：超时、鉴权头、状态码归一 */
  async function call(
    url: string,
    init: RequestInit,
    opts: { token?: string; timeoutMs?: number; allowStatuses?: number[] } = {},
  ): Promise<Response> {
    let res: Response;
    let done: () => void;
    try {
      ({ res, done } = await fetchWithTimeout(
        doFetch,
        url,
        {
          ...init,
          headers: {
            Accept: 'application/json',
            ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
            ...(init.headers ?? {}),
          },
        },
        opts.timeoutMs ?? requestTimeoutMs,
      ));
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError('network', `网络请求失败: ${String(e)}`);
    }
    try {
      if (res.status === 401) throw new SyncError('auth', '鉴权被拒（HTTP 401，令牌过期或已吊销）');
      if (!res.ok && !(opts.allowStatuses ?? []).includes(res.status)) {
        throw new SyncError('api', `接口异常（HTTP ${res.status}）: ${url}`);
      }
      return res;
    } finally {
      done();
    }
  }

  async function postToken(body: Record<string, string>): Promise<WahooTokens> {
    // 400 交给 parseTokenResponse 读 error_description：令牌端点的失败原因是给用户看的
    // 关键信息（invalid_grant 分「授权码过期」与「PKCE 不匹配」两种），不能吞成 HTTP 码
    const res = await call(
      `${apiBase}/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formEncode(body),
      },
      { allowStatuses: [400] },
    );
    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      throw new SyncError('api', `令牌响应非 JSON: ${String(e)}`);
    }
    return parseTokenResponse(json, nowMs());
  }

  /** 拉某页活动（含 starts 解析与未来活动过滤） */
  async function listPage(token: string, page: number): Promise<{ items: RemoteActivity[]; exhausted: boolean }> {
    const res = await call(`${apiBase}/v1/workouts?page=${page}&per_page=${WORKOUTS_PER_PAGE}`, { method: 'GET' }, { token });
    let json: { workouts?: unknown; total?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch (e) {
      throw new SyncError('api', `活动列表响应非 JSON: ${String(e)}`);
    }
    const raw = Array.isArray(json?.workouts) ? json.workouts : [];
    const items: RemoteActivity[] = [];
    const cutoff = nowMs();
    for (const w of raw as Record<string, unknown>[]) {
      const id = w?.id;
      if (id === undefined || id === null) continue;
      const starts = parseWorkoutStarts(String(w?.starts ?? ''));
      // 列表里既有已完成的训练也有计划训练：未来的计划拿不到 summary（要白发一个请求），
      // 沙盒配额只有 250/天，这里先滤掉
      if (starts && starts.getTime() > cutoff) continue;
      items.push({ id: String(id), startAt: starts });
    }
    const total = Number(json?.total);
    return {
      items,
      exhausted: raw.length === 0 || (Number.isFinite(total) && page * WORKOUTS_PER_PAGE >= total),
    };
  }

  return {
    async newPkce() {
      const verifier = base64UrlEncode(randomBytes(32)); // 43 字符，合法字符集
      const digestHex = await sha256Hex(verifier);
      return {
        verifier,
        challenge: base64UrlEncode(hexToBytes(digestHex)),
        state: base64UrlEncode(randomBytes(16)),
      };
    },

    authorizeUrl(p) {
      return buildAuthorizeUrl({
        apiBase,
        clientId: p.clientId,
        redirectUri: p.redirectUri,
        pkce: p.pkce,
      });
    },

    exchangeCode(p) {
      return postToken({
        grant_type: 'authorization_code',
        code: p.code,
        redirect_uri: p.redirectUri,
        client_id: p.clientId,
        code_verifier: p.codeVerifier,
      });
    },

    refreshTokens(p) {
      return postToken({
        grant_type: 'refresh_token',
        refresh_token: p.refreshToken,
        client_id: p.clientId,
        code_verifier: p.codeVerifier,
      });
    },

    async revoke(accessToken) {
      await call(`${apiBase}/v1/permissions`, { method: 'DELETE' }, { token: accessToken });
    },

    async listSince(session, since, maxPages = 10) {
      const out: RemoteActivity[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const { items, exhausted } = await listPage(session.accessToken, page);
        let allOlder = items.length > 0;
        for (const item of items) {
          if (since && item.startAt && item.startAt.getTime() < since.getTime()) continue;
          allOlder = false;
          out.push(item);
        }
        // 列表恒按 starts 降序（官方口径）：整页都在窗口内之外即说明后面更老，可停
        if (exhausted || (since && allOlder)) break;
      }
      return out;
    },

    async getFileRef(session, activity) {
      const res = await call(
        `${apiBase}/v1/workouts/${encodeURIComponent(activity.id)}/workout_summary`,
        { method: 'GET' },
        { token: session.accessToken, allowStatuses: [403, 404] },
      );
      if (res.status === 403 || res.status === 404) {
        // 手动录入 / 第三方 App 来源的骑行拿不到 summary；个别 workout 也会对某些令牌
        // 直接拒绝。这些都是「这个活动没有文件」，不是本轮同步失败——计跳过。
        // 注：若真是 mid-sync 令牌过期（2 小时 TTL 且开跑前刚校验过），列表请求会先暴露，
        // 这里不再把 401 当令牌问题（避免误判成整轮鉴权失败）。
        console.warn(`Wahoo 活动 ${activity.id}：summary 被拒（HTTP ${res.status}，跳过）`);
        return null;
      }
      let json: unknown;
      try {
        json = await res.json();
      } catch (e) {
        throw new SyncError('api', `活动详情响应非 JSON: ${String(e)}`);
      }
      const url = extractWorkoutFileUrl(json);
      if (!url) return null; // manual: true 等：没有 FIT 文件
      return { key: url, fileName: buildWahooFileName(activity.id) };
    },

    async download(_session, ref: FileRef) {
      // pre-signed 直链：不带鉴权头、不计限流、小时级过期；拿到即下载（不缓存 URL）
      const res = await call(
        ref.key,
        { method: 'GET', headers: { Accept: 'application/octet-stream' } },
        { timeoutMs: downloadTimeoutMs, allowStatuses: [403] },
      );
      if (res.status === 403) {
        // pre-signed 地址签名过期（有效期小时级）：下次同步会重新取地址，不是数据问题
        throw new SyncError('api', 'FIT 直链已过期（签名有效期小时级），下次同步会自动重新取地址');
      }
      let bytes: ArrayBuffer;
      try {
        bytes = await res.arrayBuffer();
      } catch (e) {
        throw new SyncError('network', `FIT 下载失败: ${String(e)}`);
      }
      const buf = new Uint8Array(bytes);
      if (!isFitBytes(buf)) throw new SyncError('api', '下载内容不是 FIT 文件（可能收到错误页）');
      return buf;
    },
  };
}
