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
 * 起骑时间串 → Date。宽容变体：前后空白、日期时间分隔符 'T'、可选小数秒（".0"）、
 * 可选时区后缀（Z 或 ±hh:mm / ±hhmm，2026-10 增量失效事故的防御之一：服务端时间
 * 格式漂移不应让记录被静默丢弃）。语义：无时区 = 顽鹿服务端墙钟（Go time.Local
 * 口径，按设备本地时区解释）；带时区 = 精确 instant，按 offset 归一到 UTC——
 * 不得把带时区的墙钟再按本地解释一遍。格式完全不可解析返回 null（调用方保旧语义
 * 处理：条目仍入列表，只是失败重试锚点缺失）。
 */
export function parseRideTime(value: string): Date | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?\s*$/.exec(
    value ?? '',
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, tz] = m;
  if (tz === undefined) {
    const local = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return Number.isNaN(local.getTime()) ? null : local;
  }
  const utcMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const sign = tz === 'Z' || tz[0] === '+' ? 1 : -1;
  const hh = tz === 'Z' ? 0 : Number(tz.slice(1, 3));
  const mm = tz === 'Z' ? 0 : Number(tz.slice(-2));
  const instant = new Date(utcMs - sign * (hh * 60 + mm) * 60_000);
  return Number.isNaN(instant.getTime()) ? null : instant;
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
      // 诊断与守卫计数（2026-10 顽鹿增量失效事故，decisions §37）：「空结果」只有在
      // 扫到过「可解析且早于 since」的窗口边界（sawOldParsed）时才可信；不可信的空态
      // 一律显式报错交编排层按失败处理（水位线不动），绝不静默回空——编排层把空列表
      // 当「没有新记录」并推进水位线，会把缺口永久藏住（症状：0 新增 0 跳过且时间在走）。
      let seen = 0;
      let unusable = 0;
      let unusableBeforeOld = 0; // 尚未见窗口边界时的不可解析条目（降序里它们位于边界新侧=疑似窗口内）
      let parsed = 0;
      let sawOldParsed = false;
      let ascending = false; // 时间升序=旧→新序：遇旧条目只跳过，不再提前停
      let lastParsedMs: number | null = null;
      let stopReason: 'boundary' | 'end' | 'truncated' | 'nomore' | null = null;
      for (let page = 1; page <= maxPages; page += 1) {
        const json = (await postJson(`${rideBase}/list`, authHeaders(session), {
          page,
          limit: 20,
        })) as {
          code?: number;
          message?: string;
          data?: {
            list?: { id?: number | string; start_riding_time?: string }[] | null;
            pagination?: { has_more?: boolean };
          };
        };
        const data = json?.data;
        if (json?.code !== 200 || !data) {
          throw new SyncError('api', `活动列表失败: ${json?.message ?? JSON.stringify(json).slice(0, 200)}`);
        }
        if (data.list === undefined) {
          // 合规响应恒有 list 键（上游 Go 结构与 mock 同源）；缺失 = 形状变更
          throw new SyncError(
            'api',
            `活动列表响应缺少 list 字段（响应形状疑似变更）: ${JSON.stringify(json).slice(0, 200)}`,
          );
        }
        // Go(nil slice) 序列化为 null：按空页处理，不算形状变更
        const list = Array.isArray(data.list) ? data.list : [];
        let pageHadOld = false;
        for (const item of list) {
          seen += 1;
          if (!item?.id || !item?.start_riding_time) {
            // id/时间字段缺失（旧实现即静默跳过的形态）：只计诊断
            unusable += 1;
            if (!sawOldParsed) unusableBeforeOld += 1;
            continue;
          }
          const startAt = parseRideTime(item.start_riding_time);
          if (!startAt) {
            // 时间字段在但解析失败：保旧实现语义——条目仍入列表（startAt 仅失败重试
            // 锚点用，null 不影响下载导入），只计诊断。格式漂移不升级成丢记录。
            unusable += 1;
            if (!sawOldParsed) unusableBeforeOld += 1;
            out.push({ id: String(item.id), startAt: null });
            continue;
          }
          parsed += 1;
          const startAtMs = startAt.getTime();
          if (lastParsedMs !== null && startAtMs > lastParsedMs) ascending = true;
          lastParsedMs = startAtMs;
          if (since && startAtMs < since.getTime()) {
            pageHadOld = true;
            sawOldParsed = true;
            continue;
          }
          out.push({ id: String(item.id), startAt });
        }
        if (!data.pagination?.has_more) {
          stopReason = 'end';
          break;
        }
        if (page >= maxPages) {
          stopReason = 'truncated'; // 服务端还有下一页但翻页上限用尽：本轮不完整，不可信
          break;
        }
        // 翻页停止判据放**页边界**而非条目中途：页内可能还混着窗口内条目（方向异常或
        // 单条旧条目跨页时，条目中途停会把同页/后续页的窗口内记录漏掉）。降序（未见
        // 升序）且本页见过旧条目、样本足够断序（parsed ≥ 2，首条旧条目无法判定方向）
        // ⇒ 后面只可能更旧，到此为止，不为全量历史买单。
        if (since && !ascending && pageHadOld && parsed >= 2) {
          stopReason = 'boundary';
          break;
        }
      }
      if (stopReason === 'truncated') {
        throw new SyncError('api', `活动列表超过翻页上限（${maxPages} 页）仍未到头，已中止本轮以防漏同步`);
      }
      if (out.length === 0 && seen > 0 && !sawOldParsed) {
        throw new SyncError(
          'api',
          `活动列表返回 ${seen} 条但 ${unusable} 条缺少可解析的 id/起骑时间，无法确认窗口为空（响应形状疑似变更，已中止本轮以防漏同步）`,
        );
      }
      if (out.length === 0 && unusableBeforeOld > 0 && !ascending) {
        // 降序/方向未知时，边界前（=新侧）的不可解析条目可能是未同步的新记录：
        // 空结果不可信，显式报错（升序时它们位于窗口之外，放行）
        throw new SyncError(
          'api',
          `活动列表窗口边界前有 ${unusableBeforeOld} 条缺少可解析的 id/起骑时间，无法确认窗口为空（响应形状疑似变更，已中止本轮以防漏同步）`,
        );
      }
      console.log(
        `onelap 列表：窗口 ${since ? since.toISOString() : '全量'} 收到 ${out.length} 条` +
          `（扫描 ${seen} 条，不可解析 ${unusable} 条，停止=${stopReason ?? 'empty'}${ascending ? '，旧→新序' : ''}）`,
      );
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
