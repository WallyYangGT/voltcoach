/**
 * onelap.ts — 顽鹿运动（Onelap）云直拉客户端（MIGRATION_PLAN §10.4）
 *
 * 接口与流程逆向自社区验证的 OnelapSyncStrava（Go，MIT）internal/onelap，移植口径
 * 逐字对齐其实现（2026-03 官方第三方通道关停后的可行方案）。三个动作：
 *   login(account, password) → listSince(session, since) → downloadFit(session, id)
 *
 * 依赖注入（RN 与 node:test 共用本模块，不 import 任何 RN/Expo）：
 *  - fetchImpl：App 侧由服务层传 expo/fetch（与 src/ai/http.ts 同口径），测试传全局 fetch
 *  - md5Hex / randomBytes / now：App 侧 expo-crypto 实现，测试传 node:crypto 实现
 *  - baseUrlOverrides：模拟器端到端指向本地 mock（scripts/mock-onelap-server.mjs）
 *
 * ⚠️ 签名串陷阱（勿"顺手修正"）：登录签名串的 timestamp 段写作 `×tamp=`，其中 × 是
 * 字面乘号 U+00D7——OnelapSyncStrava 的 Go 实现即如此（HTML 实体 &times 的复制事故）
 * 且经社区长期验证可用，服务端按此校验。改回 `&timestamp=` 签名必失败。
 */

import { safeName } from '../core/records.ts';

/** 登录/列表/下载的基础地址（override 仅限测试与模拟器 mock 使用） */
export const ONELAP_LOGIN_URL = 'https://www.onelap.cn/api/login';
export const ONELAP_RIDE_RECORD_BASE = 'https://otm.onelap.cn/api/otm/ride_record';
/** 登录签名密钥（OnelapSyncStrava 内置常量，服务端约定值） */
export const ONELAP_SECRET = 'fe9f8382418fcdeb136461cac6acae7b';

/** fetch 形状（expo/fetch 与 globalThis.fetch 皆可） */
export type FetchLike = typeof globalThis.fetch;

/** 登录后的会话（token 走 Authorization 头，uid 走 Cookie ouid） */
export interface OnelapSession {
  token: string;
  uid: string;
}

/** 云端活动列表项（同步流程只用 id 与起骑时间） */
export interface OnelapActivity {
  id: string;
  /** "YYYY-MM-DD HH:mm:ss"（顽鹿服务端本地时区） */
  start_riding_time: string;
  distance_km?: number | null;
  time_seconds?: number | null;
}

/** 客户端错误的稳定类别（服务层映射 i18n；原始信息随 message 透出） */
export type OnelapErrorCode = 'network' | 'auth' | 'api' | 'no_file';

export class OnelapError extends Error {
  readonly code: OnelapErrorCode;

  constructor(code: OnelapErrorCode, message: string) {
    super(message);
    this.name = 'OnelapError';
    this.code = code;
  }
}

/** 环境注入项（全部可选，缺省值即生产形态） */
export interface OnelapDeps {
  fetchImpl?: FetchLike;
  /** MD5 hex 小写（登录密码摘要与签名共用） */
  md5Hex?: (value: string) => string | Promise<string>;
  /** 随机字节（登录 nonce 用） */
  randomBytes?: (length: number) => Uint8Array;
  /** unix 秒（登录 timestamp 用） */
  now?: () => number;
  baseUrlOverrides?: { login?: string; rideRecord?: string };
}

export interface OnelapClient {
  login(account: string, password: string): Promise<OnelapSession>;
  /**
   * 按 since 增量拉活动列表（新→旧翻页，遇早于 since 的记录停止）。
   * since=null 全量拉取（首推），上限 maxPages 防失控（顽鹿接口无服务端时间过滤）。
   */
  listSince(session: OnelapSession, since: Date | null, maxPages?: number): Promise<OnelapActivity[]>;
  /** 下载活动原始 FIT 字节 + 规范化文件名（upsert 去重键） */
  downloadFit(session: OnelapSession, activityId: string): Promise<{ bytes: Uint8Array; fileName: string }>;
  /**
   * 查活动云端文件 key（fileKey，.st 日志类为 fitUrl）。同步编排先用它算文件名、
   * 与本地集合比对跳过已知活动，再对未知活动 downloadByKey——省掉无谓下载。
   */
  getFitKey(session: OnelapSession, activityId: string): Promise<string>;
  /** 按 getFitKey 拿到的 key 直接下载（跳过 analysis 往返） */
  downloadByKey(session: OnelapSession, key: string, activityId: string): Promise<{ bytes: Uint8Array; fileName: string }>;
}

// ---------------- 纯函数（node:test 直接覆盖） ----------------

/**
 * 登录签名输入串。⚠️ `×tamp` 为字面 U+00D7（见文件头注释），逐字节复刻 Go 实现：
 * account=<账>&nonce=<随>&password=<md5>&key 前的 timestamp 段写作 ×tamp。
 */
export function buildSignStr(
  account: string,
  nonce: string,
  passwordMd5: string,
  timestamp: string,
  secret: string = ONELAP_SECRET,
): string {
  return `account=${account}&nonce=${nonce}&password=${passwordMd5}\u00d7tamp=${timestamp}&key=${secret}`;
}

/** nonce 字节 → [0-9A-Za-z] 字符（拒绝采样对齐 Go 实现，避免取模偏置） */
const NONCE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function nonceFromBytes(bytes: Uint8Array, length = 16): string {
  let out = '';
  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    // 256 = 62*4 + 8：只接受 < 248 的字节，均摊无偏
    if (bytes[i] < 248) out += NONCE_ALPHABET[bytes[i] % 62];
  }
  if (out.length < length) throw new Error(`随机字节不足：需要 ${length * 2} 字节`);
  return out;
}

/**
 * "YYYY-MM-DD HH:mm:ss" → 本地时区 Date（顽鹿服务端口径 = Go time.Local）。
 * 手工解析不用 new Date(string)——非 ISO 格式在 Hermes/JSC 上返回 Invalid Date。
 */
export function parseRideTime(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 起骑时间早于水位线（增量停止条件；时间解析失败视为不停） */
export function isBeforeSince(startRidingTime: string, since: Date): boolean {
  const d = parseRideTime(startRidingTime);
  return d !== null && d.getTime() < since.getTime();
}

/**
 * fileKey/fitUrl → 规范化活动文件名（upsert 去重键）：取 basename、去原扩展名、
 * 强制 .fit 后缀（.st 日志由顽鹿服务端转码为 FIT，落盘名也统一）；无法取名的
 * 回退 onelap-<id>.fit。
 */
export function extractFitFileName(fileKey: string, activityId: string): string {
  const base = (fileKey ?? '').split(/[\\/]/).pop() ?? '';
  const stem = safeName(base.replace(/\.[^.]+$/, ''));
  if (!stem) return `onelap-${activityId}.fit`;
  return `${stem}.fit`;
}

/** 下载 URL：base64(UTF-8(key)) 拼进 fit_content 路径（对齐 Go base64.StdEncoding） */
export function buildFitContentUrl(baseUrl: string, key: string): string {
  return `${baseUrl}/analysis/fit_content/${base64Encode(utf8ToBytesLocal(key))}`;
}

// ---------------- 客户端 ----------------

/** 请求超时口径（对齐 AI 层思路：自管超时，不依赖运行时隐藏行为）。下载给大余量 */
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

/** 带超时的 fetch：AbortController 手工实现（Hermes 不保证有 AbortSignal.timeout） */
async function fetchWithTimeout(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await doFetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    // AbortError → 统一按网络类超时报错（调用方映射 OnelapError('network')）
    const msg = String(e);
    if (msg.includes('abort') || msg.includes('Abort')) {
      throw new OnelapError('network', `请求超时（${Math.round(timeoutMs / 1000)}s）: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export function createOnelapClient(deps: OnelapDeps = {}): OnelapClient {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const md5Hex = deps.md5Hex ?? (async (s: string) => s);
  const randomBytes = deps.randomBytes ?? (() => new Uint8Array(32));
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const loginUrl = deps.baseUrlOverrides?.login ?? ONELAP_LOGIN_URL;
  const rideBase = deps.baseUrlOverrides?.rideRecord ?? ONELAP_RIDE_RECORD_BASE;

  async function postRaw(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetchWithTimeout(doFetch, url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof OnelapError) throw e;
      throw new OnelapError('network', `网络请求失败: ${String(e)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OnelapError('auth', `鉴权被拒（HTTP ${res.status}）`);
    }
    if (!res.ok) {
      throw new OnelapError('api', `接口异常（HTTP ${res.status}）: ${url}`);
    }
    return res;
  }

  async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    return (await postRaw(url, headers, body)).json();
  }

  async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchWithTimeout(doFetch, url, { method: 'GET', headers }, REQUEST_TIMEOUT_MS);
    } catch (e) {
      if (e instanceof OnelapError) throw e;
      throw new OnelapError('network', `网络请求失败: ${String(e)}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new OnelapError('auth', `鉴权被拒（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new OnelapError('api', `接口异常（HTTP ${res.status}）: ${url}`);
    return res.json();
  }

  function authHeaders(session: OnelapSession): Record<string, string> {
    return {
      Authorization: session.token,
      Cookie: `ouid=${session.uid}`,
      'Content-Type': 'application/json;charset=utf-8',
    };
  }

  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/152.0';

  return {
    async login(account, password) {
      const nonce = nonceFromBytes(randomBytes(64));
      const timestamp = String(now());
      const passwordMd5 = await md5Hex(password);
      const sign = await md5Hex(buildSignStr(account, nonce, passwordMd5, timestamp));
      // 头与 Referer/Origin 对齐网页端登录（Go 实现逐项复刻）
      const res = await postRaw(loginUrl, {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=utf-8',
        Origin: 'https://www.onelap.cn',
        Referer: 'https://www.onelap.cn/login.html',
        nonce,
        timestamp,
        sign,
      }, { account, password: passwordMd5 });
      const text = await res.text();
      let json: {
        data?: { token?: string; refresh_token?: string; userinfo?: { uid?: number | string } }[];
      };
      try {
        json = JSON.parse(text);
      } catch {
        throw new OnelapError('api', `登录响应非 JSON: ${text.slice(0, 200)}`);
      }
      const info = json?.data?.[0];
      if (!info?.token) throw new OnelapError('auth', '登录失败：账号或密码错误（响应无 token）');
      // uid 为大整数：JSON.parse 可能丢精度，从原文按数字串提取保真（取不到回落解析值）
      return { token: info.token, uid: String(extractUid(text) ?? info.userinfo?.uid ?? '') };
    },

    async listSince(session, since, maxPages = 500) {
      const out: OnelapActivity[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const json = (await postJson(`${rideBase}/list`, authHeaders(session), {
          page,
          limit: 20,
        })) as {
          code?: number;
          message?: string;
          data?: {
            list?: { id?: number | string; start_riding_time?: string; distance_km?: number | null; time_seconds?: number | null }[];
            pagination?: { has_more?: boolean };
          };
        };
        const data = json?.data;
        if (json?.code !== 200 || !data) {
          throw new OnelapError('api', `活动列表失败: ${json?.message ?? JSON.stringify(json).slice(0, 200)}`);
        }
        for (const item of data.list ?? []) {
          if (!item?.id || !item?.start_riding_time) continue;
          if (since && isBeforeSince(item.start_riding_time, since)) return out; // 新→旧，到头即停
          out.push({
            id: String(item.id),
            start_riding_time: item.start_riding_time,
            distance_km: item.distance_km ?? null,
            time_seconds: item.time_seconds ?? null,
          });
        }
        if (!data.pagination?.has_more) break;
      }
      return out;
    },

    async downloadFit(session, activityId) {
      const key = await this.getFitKey(session, activityId);
      return this.downloadByKey(session, key, activityId);
    },

    async getFitKey(session, activityId) {
      const analysis = (await getJson(`${rideBase}/analysis/${activityId}`, authHeaders(session))) as {
        code?: number;
        message?: string;
        data?: { ridingRecord?: { fileKey?: string; fitUrl?: string } };
      };
      if (analysis?.code !== 200) {
        throw new OnelapError('api', `活动详情失败: ${analysis?.message ?? ''}`);
      }
      const rec = analysis.data?.ridingRecord;
      const key = rec?.fileKey || rec?.fitUrl || '';
      if (!key) throw new OnelapError('no_file', `活动 ${activityId} 云端无原始文件`);
      return key;
    },

    async downloadByKey(session, key, activityId) {
      // 下载 FIT 字节（fit_content 路径 = base64(key)）
      let res: Response;
      try {
        res = await fetchWithTimeout(
          doFetch,
          buildFitContentUrl(rideBase, key),
          { headers: authHeaders(session) },
          DOWNLOAD_TIMEOUT_MS,
        );
      } catch (e) {
        if (e instanceof OnelapError) throw e;
        throw new OnelapError('network', `FIT 下载失败: ${String(e)}`);
      }
      if (res.status === 401 || res.status === 403) throw new OnelapError('auth', '下载被拒（会话过期）');
      if (!res.ok) throw new OnelapError('api', `FIT 下载异常（HTTP ${res.status}）`);
      return { bytes: new Uint8Array(await res.arrayBuffer()), fileName: extractFitFileName(key, activityId) };
    },
  };
}

/** 从登录响应原文提取 uid 数字串（JSON.parse 大整数会丢精度，此处保真） */
function extractUid(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw : '';
  if (!text) return null;
  const m = /"userinfo"\s*:\s*\{[^}]*"uid"\s*:\s*(\d+)/.exec(text);
  return m ? m[1] : null;
}

// ---------------- 字节辅助（不依赖 TextEncoder/Buffer，Hermes 与 node 通用） ----------------

/** UTF-8 编码（孤立代理替换 U+FFFD；与 src/backup/archive 同口径的独立副本，避免跨层耦合） */
function utf8ToBytesLocal(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.codePointAt(i) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    else if (cp >= 0x10000) i += 1;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

/** base64 标准编码（字母表对齐 base64.StdEncoding，含 = 填充） */
const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : '=';
  }
  return out;
}
