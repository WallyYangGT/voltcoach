/**
 * onelap.ts — 顽鹿运动（Onelap）云直拉客户端（同步说明见 README「云同步说明」）
 *
 * 接口与流程逆向自社区验证的 OnelapSyncStrava（Go，MIT，Copyright (c) 2026
 * kermit-r-wood）internal/onelap，移植口径逐字对齐其实现（2026-03 官方第三方
 * 通道关停后的可行方案）——本文件属其 MIT 声明覆盖的实质性移植，版权声明保留于
 * README「许可证」节。三个动作：
 *   login(account, password) → listSince(session, since) → getFileRef → download
 *
 * 依赖注入（RN 与 node:test 共用本模块，不 import 任何 RN/Expo）：
 *  - fetchImpl：App 侧由服务层传 expo/fetch（与 src/ai/http.ts 同口径），测试传全局 fetch
 *  - md5Hex / randomBytes / now：App 侧 expo-crypto 实现，测试传 node:crypto 实现
 *  - baseUrlOverrides：模拟器端到端指向本地 mock（scripts/mock-onelap-server.mjs）
 *
 * 平台无关部分（错误类型 / 超时 fetch / 探测 / 窗口节流 / 字节辅助 / 客户端接口）在
 * common.ts——2026-10-16 多平台化时抽出，本文件只留顽鹿协议本身。
 *
 * ⚠️ 签名串陷阱（勿"顺手修正"）：登录签名串的 timestamp 段写作 `×tamp=`，其中 × 是
 * 字面乘号 U+00D7——OnelapSyncStrava 的 Go 实现即如此（HTML 实体 &times 的复制事故）
 * 且经社区长期验证可用，服务端按此校验。改回 `&timestamp=` 签名必失败。
 */

import { safeName } from '../core/records.ts';
import {
  base64Encode,
  DOWNLOAD_TIMEOUT_MS,
  fetchWithTimeout,
  REQUEST_TIMEOUT_MS,
  utf8ToBytes,
  SyncError,
  type FetchLike,
  type FileRef,
  type RemoteActivity,
  type SyncClient,
} from './common.ts';

/** 登录/列表/下载的基础地址（override 仅限测试与模拟器 mock 使用） */
export const ONELAP_LOGIN_URL = 'https://www.onelap.cn/api/login';
export const ONELAP_RIDE_RECORD_BASE = 'https://otm.onelap.cn/api/otm/ride_record';
/** 登录签名密钥（OnelapSyncStrava 内置常量，服务端约定值） */
export const ONELAP_SECRET = 'fe9f8382418fcdeb136461cac6acae7b';

/** 登录后的会话（token 走 Authorization 头，uid 走 Cookie ouid） */
export interface OnelapSession {
  token: string;
  uid: string;
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
  /** 超时覆盖（单测把 30s/120s 压到几十毫秒；不传即生产口径） */
  timeouts?: { requestMs?: number; downloadMs?: number };
}

export interface OnelapClient extends SyncClient<OnelapSession> {
  login(account: string, password: string): Promise<OnelapSession>;
  /**
   * 查活动云端文件 key（fileKey，.st 日志类为 fitUrl）。同步编排先用它算文件名、
   * 与本地集合比对跳过已知活动，再对未知活动下载——省掉无谓下载。
   * 云端确实没有原始文件时抛 `no_file`（编排层计失败并锚定水位线重试：顽鹿的文件
   * 可能是转码未完成的暂时缺档，重试比放弃更符合预期）。
   */
  getFitKey(session: OnelapSession, activityId: string): Promise<string>;
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
  return `${baseUrl}/analysis/fit_content/${base64Encode(utf8ToBytes(key))}`;
}

// ---------------- 客户端 ----------------

export function createOnelapClient(deps: OnelapDeps = {}): OnelapClient {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const md5Hex = deps.md5Hex ?? (async (s: string) => s);
  const randomBytes = deps.randomBytes ?? (() => new Uint8Array(32));
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const loginUrl = deps.baseUrlOverrides?.login ?? ONELAP_LOGIN_URL;
  const rideBase = deps.baseUrlOverrides?.rideRecord ?? ONELAP_RIDE_RECORD_BASE;
  const requestTimeoutMs = deps.timeouts?.requestMs ?? REQUEST_TIMEOUT_MS;
  const downloadTimeoutMs = deps.timeouts?.downloadMs ?? DOWNLOAD_TIMEOUT_MS;

  async function postRaw(
    url: string,
    headers: Record<string, string>,
    body: unknown,
  ): Promise<{ res: Response; done: () => void }> {
    try {
      return await fetchWithTimeout(
        doFetch,
        url,
        { method: 'POST', headers, body: JSON.stringify(body) },
        requestTimeoutMs,
      );
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError('network', `网络请求失败: ${String(e)}`);
    }
  }

  function checkStatus(url: string, res: Response): void {
    if (res.status === 401 || res.status === 403) {
      throw new SyncError('auth', `鉴权被拒（HTTP ${res.status}）`);
    }
    if (!res.ok) throw new SyncError('api', `接口异常（HTTP ${res.status}）: ${url}`);
  }

  async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
    const { res, done } = await postRaw(url, headers, body);
    try {
      checkStatus(url, res);
      return await res.json();
    } finally {
      done();
    }
  }

  async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
    let done: () => void = () => {}; // fetch 本身抛错时（未拿到计时器）finally 也要安全
    try {
      const { res, done: clear } = await fetchWithTimeout(
        doFetch,
        url,
        { method: 'GET', headers },
        requestTimeoutMs,
      );
      done = clear;
      checkStatus(url, res);
      return await res.json();
    } catch (e) {
      if (e instanceof SyncError) throw e;
      throw new SyncError('network', `网络请求失败: ${String(e)}`);
    } finally {
      done();
    }
  }

  function authHeaders(session: OnelapSession): Record<string, string> {
    return {
      Authorization: session.token,
      Cookie: `ouid=${session.uid}`,
      'Content-Type': 'application/json;charset=utf-8',
    };
  }

  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/152.0';

  async function getFitKey(session: OnelapSession, activityId: string): Promise<string> {
    const analysis = (await getJson(`${rideBase}/analysis/${activityId}`, authHeaders(session))) as {
      code?: number;
      message?: string;
      data?: { ridingRecord?: { fileKey?: string; fitUrl?: string } };
    };
    if (analysis?.code !== 200) {
      throw new SyncError('api', `活动详情失败: ${analysis?.message ?? ''}`);
    }
    const rec = analysis.data?.ridingRecord;
    const key = rec?.fileKey || rec?.fitUrl || '';
    if (!key) throw new SyncError('no_file', `活动 ${activityId} 云端无原始文件`);
    return key;
  }

  return {
    async login(account, password) {
      const nonce = nonceFromBytes(randomBytes(64));
      const timestamp = String(now());
      const passwordMd5 = await md5Hex(password);
      const sign = await md5Hex(buildSignStr(account, nonce, passwordMd5, timestamp));
      // 头与 Referer/Origin 对齐网页端登录（Go 实现逐项复刻）
      const { res, done } = await postRaw(loginUrl, {
        'User-Agent': DESKTOP_UA,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json;charset=utf-8',
        Origin: 'https://www.onelap.cn',
        Referer: 'https://www.onelap.cn/login.html',
        nonce,
        timestamp,
        sign,
      }, { account, password: passwordMd5 });
      let text: string;
      try {
        checkStatus(loginUrl, res);
        text = await res.text();
      } finally {
        done();
      }
      let json: {
        data?: { token?: string; refresh_token?: string; userinfo?: { uid?: number | string } }[];
      };
      try {
        json = JSON.parse(text);
      } catch {
        throw new SyncError('api', `登录响应非 JSON: ${text.slice(0, 200)}`);
      }
      const info = json?.data?.[0];
      if (!info?.token) throw new SyncError('auth', '登录失败：账号或密码错误（响应无 token）');
      // uid 为大整数：JSON.parse 可能丢精度，从原文按数字串提取保真（取不到回落解析值）
      return { token: info.token, uid: String(extractUid(text) ?? info.userinfo?.uid ?? '') };
    },

    async listSince(session, since, maxPages = 500) {
      const out: RemoteActivity[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const json = (await postJson(`${rideBase}/list`, authHeaders(session), {
          page,
          limit: 20,
        })) as {
          code?: number;
          message?: string;
          data?: {
            list?: { id?: number | string; start_riding_time?: string }[];
            pagination?: { has_more?: boolean };
          };
        };
        const data = json?.data;
        if (json?.code !== 200 || !data) {
          throw new SyncError('api', `活动列表失败: ${json?.message ?? JSON.stringify(json).slice(0, 200)}`);
        }
        for (const item of data.list ?? []) {
          if (!item?.id || !item?.start_riding_time) continue;
          if (since && isBeforeSince(item.start_riding_time, since)) return out; // 新→旧，到头即停
          out.push({ id: String(item.id), startAt: parseRideTime(item.start_riding_time) });
        }
        if (!data.pagination?.has_more) break;
      }
      return out;
    },

    getFitKey,

    async getFileRef(session, activity) {
      const key = await getFitKey(session, activity.id);
      return { key, fileName: extractFitFileName(key, activity.id) };
    },

    async download(session, ref: FileRef) {
      // 下载 FIT 字节（fit_content 路径 = base64(key)），body 读取同样在超时信号保护内
      const { res, done } = await fetchWithTimeout(
        doFetch,
        buildFitContentUrl(rideBase, ref.key),
        { headers: authHeaders(session) },
        downloadTimeoutMs,
      );
      let bytes: ArrayBuffer;
      try {
        if (res.status === 401 || res.status === 403) throw new SyncError('auth', '下载被拒（会话过期）');
        if (!res.ok) throw new SyncError('api', `FIT 下载异常（HTTP ${res.status}）`);
        bytes = await res.arrayBuffer();
      } catch (e) {
        // body 阶段超时/网络中断同样归一为 network（而非裸 AbortError 逃逸）
        if (e instanceof SyncError) throw e;
        throw new SyncError('network', `FIT 下载失败: ${String(e)}`);
      } finally {
        done();
      }
      return new Uint8Array(bytes);
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
