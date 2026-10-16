/**
 * igpsport.ts — 迹驰（iGPSPORT）云直拉客户端（同步说明见 README「云同步说明」）
 *
 * 接口逆向自社区多个仍在维护的项目（2026-10 逐项交叉验证：intervalssync 2026-09、
 * kvnZero 2026-09、Liki4 2026-09、igpsport-mcp 2026-06、hmqgg 2026-03、NenoSann 2026-03、
 * fooooxxxx 2025-11），三个动作：
 *   login(account, password) → listSince(session, since) → getFileRef → download
 *
 * - 登录 POST {api}/service/auth/account/login  JSON `{appId:'igpsport-web', username, password}`
 *   → `data.access_token`（JWT）。国内/国际共用同一路径，仅域名不同（见 IGPSPORT_REGIONS）。
 * - 列表 GET  {api}/service/web-gateway/web-analyze/activity/queryMyActivity
 *   ?pageNo&pageSize=20&reqType=0&sort=1[&sortType=1]（国内带 sortType），可带
 *   `beginTime/endTime`（YYYY-MM-DD，服务端按日期过滤）；响应 `data.rows` + `data.totalPage`。
 *   ⚠️ 服务端把 pageSize 截断为 20（多项目实证），分页靠 totalPage/空行判断。
 * - 文件 GET  .../queryActivityDetail/{rideId} → `data.fitUrl`；回退
 *   .../getDownloadUrl/{rideId} → `data` 为 URL 字符串（2025-11 接口变更后的唯一路径）。
 * - 下载 拿到的 OSS 直链**裸 GET**：多项目实证无需任何鉴权头（带 Bearer 也不报错，
 *   但直链属 OSS 域名、与 API 无关，故不带）。
 *
 * ⚠️ 非官方接口（README 已声明免责）。已知两点需真实账号复核：
 *  ① 国内区前端另有一层 `x-signature`（前端 WASM 生成）——社区里 8/9 个项目**不带它**
 *     也可用（含 2026-09 的 CN 实证），故本实现走无签名路径。**刻意不发 x-access-key/
 *     x-platform**：多数网关是「带了 AK 才要求签名」的形态，不发反而更安全。将来若确证
 *     必需，签名只需接在 request() 一处。
 *  ② startTime 格式不固定：国内账号常见 `YYYY.MM.DD`（点分日期），国际区/部分返回是
 *     `YYYY-MM-DD HH:mm:ss`——解析必须多格式兜底（intervalssync 同样做法）。
 *
 * 依赖注入（同 onelap.ts 口径：不 import 任何 RN/Expo，node:test 直测）。
 */

import { safeName } from '../core/records.ts';
import {
  DOWNLOAD_TIMEOUT_MS,
  fetchWithTimeout,
  REQUEST_TIMEOUT_MS,
  SyncError,
  type FetchLike,
  type FileRef,
  type RemoteActivity,
  type SyncClient,
} from './common.ts';

/** 服务端请求头（社区实证只需 UA/Accept；不发 x-access-key 见文件头 ①） */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/152.0';

const PATH_LOGIN = '/service/auth/account/login';
const PATH_ACTIVITY = '/service/web-gateway/web-analyze/activity';
const PATH_DETAIL = `${PATH_ACTIVITY}/queryActivityDetail`;
const PATH_DOWNLOAD_URL = `${PATH_ACTIVITY}/getDownloadUrl`;
/** 列表每页条数：服务端硬性截断为 20（传更大值无效，项目注释实证） */
const LIST_PAGE_SIZE = 20;

/** 国内 / 国际两区（账号体系独立，token 不可跨区；除域名外只有 sortType 差异） */
export type IgpsportRegionKey = 'cn' | 'intl';

export interface IgpsportRegion {
  id: 'igpsport-cn' | 'igpsport-intl';
  /** 网关基址 */
  apiBase: string;
  /** 列表查询是否带 sortType=1（国内 web 端才带） */
  sortType: boolean;
}

export const IGPSPORT_REGIONS: Record<IgpsportRegionKey, IgpsportRegion> = {
  cn: { id: 'igpsport-cn', apiBase: 'https://prod.zh.igpsport.com', sortType: true },
  intl: { id: 'igpsport-intl', apiBase: 'https://prod.en.igpsport.com', sortType: false },
};

/** 登录后的会话（access_token 走 Authorization: Bearer） */
export interface IgpsportSession {
  token: string;
}

export interface IgpsportDeps {
  region: IgpsportRegionKey;
  fetchImpl?: FetchLike;
  /** 联调覆盖（只覆盖 API 域，mock 自行生成 OSS 直链） */
  baseUrlOverrides?: { api?: string };
  /** 超时覆盖（单测把 30s/120s 压到几十毫秒） */
  timeouts?: { requestMs?: number; downloadMs?: number };
}

export interface IgpsportClient extends SyncClient<IgpsportSession> {
  login(account: string, password: string): Promise<IgpsportSession>;
}

// ---------------- 纯函数（node:test 直接覆盖） ----------------

/**
 * startTime → 本地时区 Date。支持社区实证出现过的四种形态：
 * `YYYY-MM-DD HH:mm:ss`（国际区）/ `YYYY-MM-DD` / `YYYY.MM.DD HH:mm:ss` / `YYYY.MM.DD`（国内点分日期）。
 * 手工解析不用 new Date(string)——非 ISO 格式在 Hermes/JSC 上返回 Invalid Date。
 */
export function parseIgpsportTime(value: string): Date | null {
  const m = /^(\d{4})[-.](\d{2})[-.](\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec((value ?? '').trim());
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] ?? 0),
    Number(m[5] ?? 0),
    Number(m[6] ?? 0),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 本地日历日 → `YYYY-MM-DD`（列表的 beginTime/endTime 参数口径） */
export function toDayParam(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 活动列表 URL（since 有值时带 beginTime/endTime 让服务端先过滤，客户端仍按 startAt 复核） */
export function buildActivityListUrl(
  region: IgpsportRegion,
  pageNo: number,
  since: Date | null,
  now: Date = new Date(),
): string {
  const params = [`pageNo=${pageNo}`, `pageSize=${LIST_PAGE_SIZE}`, 'reqType=0', 'sort=1'];
  if (region.sortType) params.push('sortType=1');
  if (since) {
    params.push(`beginTime=${toDayParam(since)}`, `endTime=${toDayParam(now)}`);
  }
  return `${region.apiBase}${PATH_ACTIVITY}/queryMyActivity?${params.join('&')}`;
}

/**
 * OSS 直链 → 规范化活动文件名（入库去重键）：取 basename、去原扩展名、强制 .fit；
 * 取不到名字回退 igpsport-<rideId>.fit。文件名里通常带设备与时间戳（多项目样例一致），
 * 跨趟重名概率极低；真撞名时靠内容指纹兜底（同名会 upsert，故宁可回退到唯一 id 名）。
 */
export function extractIgpsportFileName(url: string, rideId: string): string {
  let base = '';
  try {
    base = new URL(url).pathname;
  } catch {
    base = url ?? '';
  }
  const tail = base.split(/[\\/]/).pop() ?? '';
  const stem = safeName(tail.replace(/\.[^.]+$/, ''));
  if (!stem) return `igpsport-${rideId}.fit`;
  return `${stem}.fit`;
}

/**
 * 取业务载荷：`code` 为 0/200（或缺失/非数字）视为成功，其余按接口异常抛。
 * 返回类型是 unknown——`data` 既可能是对象（详情/列表），也可能是字符串（下载地址端点）。
 */
export function unwrapPayload(json: unknown, what: string): unknown {
  const obj = (json ?? {}) as { code?: unknown; message?: unknown; msg?: unknown; data?: unknown };
  const code = obj.code;
  if (code !== undefined && code !== null) {
    const n = Number(code);
    if (!Number.isNaN(n) && n !== 0 && n !== 200) {
      const detail = obj.message ?? obj.msg ?? JSON.stringify(json).slice(0, 200);
      throw new SyncError('api', `${what}失败: ${String(detail)}`);
    }
  }
  return obj.data ?? null;
}

/** 活动详情/下载地址响应 → FIT 直链（`fitUrl` 字段 / `data` 本身是字符串 / `{url}` 三种形态都认） */
export function pickFitUrl(source: unknown): string | null {
  if (typeof source === 'string') return source.trim() || null;
  if (source && typeof source === 'object') {
    const obj = source as { fitUrl?: unknown; url?: unknown };
    for (const v of [obj.fitUrl, obj.url]) {
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
  }
  return null;
}

// ---------------- 客户端 ----------------

export function createIgpsportClient(deps: IgpsportDeps): IgpsportClient {
  const region = IGPSPORT_REGIONS[deps.region];
  const apiBase = deps.baseUrlOverrides?.api ?? region.apiBase;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const requestTimeoutMs = deps.timeouts?.requestMs ?? REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = deps.timeouts?.downloadMs ?? DOWNLOAD_TIMEOUT_MS;

  function headers(token?: string): Record<string, string> {
    return {
      'User-Agent': DESKTOP_UA,
      Accept: 'application/json, text/plain, */*',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  /** 统一请求出口（将来若需接 x-signature，只改这里） */
  async function request(
    url: string,
    init: RequestInit,
    timeoutMs = requestTimeoutMs,
  ): Promise<Response> {
    let res: Response;
    let done: () => void;
    try {
      ({ res, done } = await fetchWithTimeout(doFetch, url, init, timeoutMs));
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError('network', `网络请求失败: ${String(e)}`);
    }
    try {
      if (res.status === 401 || res.status === 403) throw new SyncError('auth', `鉴权被拒（HTTP ${res.status}）`);
      if (!res.ok) throw new SyncError('api', `接口异常（HTTP ${res.status}）: ${url}`);
      return res;
    } finally {
      done();
    }
  }

  async function getJson(url: string, token?: string): Promise<unknown> {
    const res = await request(url, { method: 'GET', headers: headers(token) });
    try {
      return await res.json();
    } catch (e) {
      throw new SyncError('api', `响应非 JSON: ${String(e)}`);
    }
  }

  async function listPage(token: string, pageNo: number, since: Date | null): Promise<{ rows: RemoteActivity[]; totalPage: number }> {
    const json = await getJson(buildActivityListUrl({ ...region, apiBase }, pageNo, since), token);
    const payload = unwrapPayload(json, '活动列表');
    if (!payload || typeof payload !== 'object') throw new SyncError('api', '活动列表响应缺少 data');
    const data = payload as Record<string, unknown>;
    // rows/list 两种字段名（不同代接口）都认；无 id 的行直接丢弃
    const raw = (Array.isArray(data.rows) ? data.rows : Array.isArray(data.list) ? data.list : []) as Record<
      string,
      unknown
    >[];
    const rows: RemoteActivity[] = [];
    for (const item of raw) {
      const id = item?.rideId ?? item?.id;
      if (id === undefined || id === null) continue;
      rows.push({ id: String(id), startAt: parseIgpsportTime(String(item?.startTime ?? '')) });
    }
    const totalPage = Number(data.totalPage);
    return { rows, totalPage: Number.isFinite(totalPage) && totalPage > 0 ? totalPage : 1 };
  }

  return {
    async login(account, password) {
      const json = await (async () => {
        const res = await request(`${apiBase}${PATH_LOGIN}`, {
          method: 'POST',
          headers: { ...headers(), 'Content-Type': 'application/json;charset=utf-8' },
          body: JSON.stringify({ appId: 'igpsport-web', username: account, password }),
        });
        try {
          return await res.json();
        } catch (e) {
          throw new SyncError('api', `登录响应非 JSON: ${String(e)}`);
        }
      })();
      let payload: unknown;
      try {
        payload = unwrapPayload(json, '登录');
      } catch (e) {
        // 登录端点的业务码失败（错密码/账号异常）归 auth：给用户的处置是「核对账号密码」，
        // 与网络/接口异常区分开（后两者保持原类别，界面提示不同）
        throw new SyncError('auth', e instanceof Error ? e.message : String(e));
      }
      const token = (payload as { access_token?: unknown } | null)?.access_token;
      if (typeof token !== 'string' || !token) {
        // 账号密码错误通常也走 0 之外的业务码；到这里说明结构变了或凭据被拒
        throw new SyncError('auth', '登录失败：账号或密码错误（响应无 access_token）');
      }
      return { token };
    },

    async listSince(session, since, maxPages = 50) {
      const out: RemoteActivity[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const { rows, totalPage } = await listPage(session.token, page, since);
        if (rows.length === 0) break;
        for (const row of rows) {
          // 服务端 beginTime 只到「日」粒度，边界当日的更早活动由这里复核剔除
          if (since && row.startAt && row.startAt.getTime() < since.getTime()) continue;
          out.push(row);
        }
        if (page >= totalPage) break;
      }
      return out;
    },

    async getFileRef(session, activity) {
      // 首选活动详情（新版接口把 fitUrl 放这里，多项目一致）
      const detail = await getJson(`${apiBase}${PATH_DETAIL}/${encodeURIComponent(activity.id)}`, session.token);
      let url = pickFitUrl(unwrapPayload(detail, '活动详情'));

      if (!url) {
        // 回退：专用下载地址端点（2025-11 起的必需路径，data 是字符串 URL）
        const dl = await getJson(
          `${apiBase}${PATH_DOWNLOAD_URL}/${encodeURIComponent(activity.id)}`,
          session.token,
        );
        url = pickFitUrl(unwrapPayload(dl, '下载地址'));
      }
      // 两条路都没给地址 = 该活动云端确实没有原始文件（未上传 FIT / 仅轨迹）：按跳过处理
      if (!url) return null;
      return { key: url, fileName: extractIgpsportFileName(url, activity.id) };
    },

    async download(_session, ref: FileRef) {
      // OSS 直链裸 GET（不带鉴权头，见文件头）；body 读取同样在超时信号保护内
      const res = await request(ref.key, { method: 'GET', headers: { 'User-Agent': DESKTOP_UA } }, downloadTimeoutMs);
      let bytes: ArrayBuffer;
      try {
        bytes = await res.arrayBuffer();
      } catch (e) {
        throw new SyncError('network', `FIT 下载失败: ${String(e)}`);
      }
      const buf = new Uint8Array(bytes);
      // FIT 魔数（字节 8–11 == ".FIT"）：下载到错误页/空文件时给一句能看懂的话，
      // 而不是把垃圾字节丢给解析器报一句看不懂的错
      if (buf.length < 12 || String.fromCharCode(...buf.slice(8, 12)) !== '.FIT') {
        throw new SyncError('api', '下载内容不是 FIT 文件（接口可能返回了错误页或占位内容）');
      }
      return buf;
    },
  };
}
