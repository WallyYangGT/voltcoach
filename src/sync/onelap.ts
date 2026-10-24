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
  isFitBytes,
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
/**
 * OTM 日历记录列表（2026-10 中服务端变更后的新记录面，POST 无 body 一次返回全量）。
 * 用户浏览器实证：111 条覆盖 2025-08 至今（含旧 ride_record/list 已不再返回的新记录），
 * 每条 `{_id: Mongo hex, date: "YYYY-MM-DD", time, totalDistance, NP, TSS, ...}`——
 * **只有汇总数据，没有文件下载引用**（下载寻址待 OTM 详情端点，见 getFitKey 注释）。
 */
export const ONELAP_CALENDAR_URL = 'https://otm.onelap.cn/api/otm/calendar/calendar/records';
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
  baseUrlOverrides?: { login?: string; rideRecord?: string; calendar?: string };
  /** 超时覆盖（单测把 30s/120s 压到几十毫秒；不传即生产口径） */
  timeouts?: { requestMs?: number; downloadMs?: number };
}

export interface OnelapClient extends SyncClient<OnelapSession> {
  login(account: string, password: string): Promise<OnelapSession>;
  /**
   * 查活动云端文件的下载描述。返回值两种形态（2026-10 中服务端变更适配，对齐
   * WanSync 的当代实现）：
   *  - fit_content 路径（`geo/...`、`MATCH_*.st`、`ONELAP_*.st|.fit` 裸名）——download
   *    时 base64 拼进 fit_content 端点；
   *  - 完整 http(s) URL（签名直链 `durl` 等）——download 时裸 GET，不带鉴权头。
   * 云端确实没有原始文件时抛 `no_file`（编排层计失败并锚定水位线重试）。
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

/** Date → 本地日历日 "YYYY-MM-DD"（列表合并的日期去重键，§24 本地日口径） */
export function localDateKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 跨源骑行级匹配（§38 评审 P2-4）：同一天可能有多趟骑行，仅按日期去重会互吞。
 * 旧路时长（分钟档）按 **±2 分钟容差** 与日历比对——两源口径未必同义且时长有秒级
 * 抖动，硬等值会在分钟边界漏配（漏配 = 同一趟被日历再补一条）。匹配不上宁可多留
 * 一条（重合由文件名预检/内容指纹兜底）：旧路条目缺时长时该日有任何旧路记录即视为
 * 覆盖（宁重勿漏）；日历缺时长时只比对日级。
 */
function buildLegacyCoverage(
  legacy: RemoteActivity[],
): Map<string, { mins: Set<number>; anyWithout: boolean }> {
  const covered = new Map<string, { mins: Set<number>; anyWithout: boolean }>();
  for (const a of legacy) {
    if (!a.startAt) continue;
    const day = localDateKey(a.startAt);
    if (!covered.has(day)) covered.set(day, { mins: new Set(), anyWithout: false });
    const entry = covered.get(day)!;
    if (a.durationSec == null) entry.anyWithout = true;
    else entry.mins.add(Math.round(a.durationSec / 60));
  }
  return covered;
}

function isCoveredByLegacy(
  covered: Map<string, { mins: Set<number>; anyWithout: boolean }>,
  a: RemoteActivity,
): boolean {
  if (!a.startAt) return false;
  const entry = covered.get(localDateKey(a.startAt));
  if (!entry) return false;
  if (a.durationSec == null) return true; // 日历缺时长：该日有旧路条目即覆盖（宁重勿漏）
  if (entry.anyWithout) return true; // 旧路缺时长：无法比对，视为覆盖
  const mins = Math.round(a.durationSec / 60);
  for (let d = -2; d <= 2; d += 1) {
    if (entry.mins.has(mins + d)) return true;
  }
  return false;
}

/** Date → 当地当日 0 点（日期粒度比较用：多拉不少拉，宁宽勿窄） */
function dayStart(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * OTM 日历响应 → 活动列表（纯函数）。`{"code":200,"data":[{_id, date, ...}]}`：
 * `_id` 为 Mongo hex（新记录面唯一身份），`date` 为本地日历日（无时刻——窗口比较按
 * 日粒度）。坏条目跳过并计数：全量可信源没有方向性，坏条目只在「一条都解析不出」时
 * 升级为报错，其余 warn 留痕（用户实证 111 条全干净，防御性处理）。
 */
export function parseCalendarRecords(json: unknown): RemoteActivity[] {
  const payload = json as { code?: number; message?: string; data?: unknown } | null;
  if (payload?.code !== 200) {
    throw new SyncError(
      'api',
      `OTM 日历列表失败: ${payload?.message ?? JSON.stringify(payload ?? {}).slice(0, 200)}`,
    );
  }
  if (!Array.isArray(payload.data)) {
    throw new SyncError(
      'api',
      `OTM 日历列表响应缺少 data 数组（响应形状疑似变更）: ${JSON.stringify(payload).slice(0, 200)}`,
    );
  }
  const out: RemoteActivity[] = [];
  let bad = 0;
  for (const item of payload.data) {
    const rec = item as { _id?: unknown; date?: unknown; time?: unknown };
    const id = typeof rec?._id === 'string' ? rec._id.trim() : '';
    const date = typeof rec?.date === 'string' ? rec.date.trim() : '';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
      : null;
    if (!id || !d || Number.isNaN(d.getTime())) {
      bad += 1;
      continue;
    }
    const time = typeof rec?.time === 'number' ? rec.time : Number(rec?.time);
    out.push({
      id,
      startAt: d,
      durationSec: Number.isFinite(time) && time > 0 ? time : null,
    });
  }
  // 坏条目升格为报错（§38 评审 P2-3）：日历是完整性权威源、无方向性，坏条目可能正是
  // 未同步的新记录——「部分坏仍报成功」会复刻 §37 的静默缺口。取舍与 §37 已知边界①
  // 同源：服务端长期存在垃圾行时会卡整轮（显式可见），恢复后自动补回。
  if (bad > 0) {
    throw new SyncError(
      'api',
      `OTM 日历返回 ${payload.data.length} 条中有 ${bad} 条缺少可解析的 _id/date（响应形状疑似变更），已中止本轮以防漏同步`,
    );
  }
  return out;
}

/**
 * 列表条目 → 起骑时刻（多形态兜底，2026-10 中服务端变更适配）：老形态
 * `start_riding_time`（本地墙钟串）→ 新形态 `start_time` → `created_at`（epoch 秒，
 * WanSync 实证的字段次序）。全缺返回 null（调用方按丢弃计数走守卫）。
 */
export function extractActivityStartAt(item: {
  start_riding_time?: string;
  start_time?: string;
  created_at?: number | string;
}): Date | null {
  const legacy = item?.start_riding_time ? parseRideTime(item.start_riding_time) : null;
  if (legacy) return legacy;
  const modern = item?.start_time ? parseRideTime(item.start_time) : null;
  if (modern) return modern;
  const raw = item?.created_at;
  if (raw === undefined || raw === null || raw === '') return null;
  // 量级校验（§38 评审 P2-2）：毫秒值被当秒会推出 5 万年后的「未来时间」，若写进
  // failureFloor → 水位线到未来 → 窗口恒空、同步永久停摆。秒口径合理域 [1e9, 4e9]
  //（2001–2096），超域且 ≥1e11 视为毫秒折算，其余拒绝。
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(num) || num <= 0) return null;
  const sec = num >= 1e11 ? num / 1000 : num;
  if (sec < 1e9 || sec > 4e9) return null;
  const d = new Date(sec * 1000);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * fileKey/fitUrl/下载 URL → 规范化活动文件名（upsert 去重键）：取 basename、剥
 * query/hash、去原扩展名、强制 .fit 后缀（.st 日志由顽鹿服务端转码为 FIT，落盘名
 * 也统一；2026-10 新形态 `ONELAP_<id>-<日期时间>.st` 裸名同样适用）；无法取名的
 * 回退 onelap-<id>.fit。
 */
export function extractFitFileName(fileKey: string, activityId: string): string {
  let base = (fileKey ?? '').split(/[\\/]/).pop() ?? '';
  base = base.split(/[?#]/)[0] ?? '';
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
  const calendarUrl = deps.baseUrlOverrides?.calendar ?? ONELAP_CALENDAR_URL;
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

  /**
   * 下载描述归一（2026-10 中服务端变更，字段形状对齐 WanSync）：
   *  - 详情 unwrap：`data.ridingRecord` 存在用它，否则**直接用 data 顶层**（新形态
   *    不再包裹）；
   *  - 字段候选：`fileKey` → `fit_url`（蛇形）→ `fitUrl` → `durl`（签名直链）；
   *  - 值归一：http(s) URL 且 path 以 `/geo/` 开头 → 剥成 fit_content 路径；其余
   *    URL 原样返回（download 走直链）；裸名仅认三类（`geo/` 前缀、`MATCH_*.st`、
   *    `ONELAP_*.st|.fit`——防止把任意字符串 base64 后当路径打服务端）。
   * 全空/无法识别 → no_file。
   */
  function normalizeDownloadRef(raw: Record<string, unknown>): string {
    const rec = raw as {
      fileKey?: unknown;
      fit_url?: unknown;
      fitUrl?: unknown;
      durl?: unknown;
    };
    const candidates = [rec.fileKey, rec.fit_url, rec.fitUrl, rec.durl];
    for (const c of candidates) {
      const value = typeof c === 'string' ? c.trim() : '';
      if (!value) continue;
      if (/^https?:\/\//i.test(value)) {
        try {
          const u = new URL(value);
          // 仅「/geo/ 路径且无 query」才剥成 fit_content 路径：带 query 即签名直链
          //（签名对象含完整 URL），剥掉 host/签名会让每轮 404（§38 评审 P2-1）
          if (u.pathname.startsWith('/geo/') && u.search === '' && !u.hash) {
            return u.pathname.replace(/^\//, '');
          }
        } catch {
          // URL 解析失败按直链原样处理
        }
        return value;
      }
      if (value.startsWith('geo/')) return value;
      // 无分隔符的裸名（.st 日志 / .fit）：老 MATCH_ 形态与 2026-10 新 ONELAP_ 形态
      if (!/[\\/?#]/.test(value) && /\.(st|fit)$/i.test(value)) return value;
    }
    return '';
  }

  async function getFitKey(session: OnelapSession, activityId: string): Promise<string> {
    const analysis = (await getJson(`${rideBase}/analysis/${activityId}`, authHeaders(session))) as {
      code?: number;
      message?: string;
      data?: Record<string, unknown> | { ridingRecord?: Record<string, unknown> };
    };
    if (analysis?.code !== 200) {
      throw new SyncError('api', `活动详情失败: ${analysis?.message ?? ''}`);
    }
    const data = analysis.data;
    // 新形态把下载字段直接放 data 顶层，旧形态包在 ridingRecord 里（两者都试）
    const rec =
      (data as { ridingRecord?: Record<string, unknown> })?.ridingRecord &&
      typeof (data as { ridingRecord?: unknown }).ridingRecord === 'object'
        ? ((data as { ridingRecord: Record<string, unknown> }).ridingRecord)
        : (data as Record<string, unknown> | undefined);
    const ref = rec ? normalizeDownloadRef(rec) : '';
    if (!ref) throw new SyncError('no_file', `活动 ${activityId} 云端无原始文件`);
    return ref;
  }

  /**
   * 旧记录面扫描（ride_record/list 分页 + §37 全套守卫）。对已迁移账号不再返回
   * 10-13 之后的新记录，但条目仍是数字 id + 精确时刻（旧 analysis 端点的最优
   * 下载寻址），故保留为合并源；listSince 负责与 OTM 日历合并。
   */
  async function scanRideRecordList(
    session: OnelapSession,
    since: Date | null,
    maxPages: number,
  ): Promise<RemoteActivity[]> {
    const out: RemoteActivity[] = [];
    // 诊断与守卫计数（2026-10 顽鹿增量失效事故，decisions §37）：结果只有在
    // 「扫到过可解析且早于 since 的窗口边界」且「新侧没有丢弃条目」时才可信；
    // 不可信的结果一律显式报错交编排层按失败处理（水位线不动），绝不静默返回——
    // 编排层把空/缺记录的列表当「没有新记录」并推进水位线，会把缺口永久藏住
    //（症状：同步时间在走、永远 0 新增 0 跳过）。
    let seen = 0;
    let dropped = 0; // id/时间字段缺失被丢弃的条目（解析失败的条目入列表，不计入）
    let droppedBeforeOld = 0; // 未见窗口边界时的丢弃（降序里位于边界新侧=疑似窗口内）
    let droppedAfterOld = 0; // 见过窗口边界后的丢弃（升序里位于边界后=疑似窗口内）
    let recovered = 0; // 时间字段在但解析失败、仍入列表的条目（不丢记录，仅诊断）
    let parsed = 0;
    let sawOldParsed = false;
    let ascending = false; // 时间升序=旧→新序：遇旧条目只跳过，不再提前停
    let lastParsedMs: number | null = null;
    let stopReason: 'boundary' | 'end' | 'truncated' | null = null;
    // 2026-10 中服务端变更：旧 limit=20 分页路径疑似失效（beta 实测列表终止在
    // 10-13，而同期 WanSync 用 {page:1, limit:50} 单页仍拉到新记录）——列表请求
    // 对齐其形状（单页大 limit 起步，窗口没扫完继续翻页）
    const pageSize = 50;
    for (let page = 1; page <= maxPages; page += 1) {
      const json = (await postJson(`${rideBase}/list`, authHeaders(session), {
        page,
        limit: pageSize,
      })) as {
        code?: number;
        message?: string;
        data?: {
          list?: Record<string, unknown>[] | null;
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
      // null（Go nil slice）按空页放行；其余非数组形态 = 形状变更，显式报错
      if (data.list !== null && !Array.isArray(data.list)) {
        throw new SyncError(
          'api',
          `活动列表响应 list 字段类型异常（响应形状疑似变更）: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }
      const list = data.list ?? [];
      let pageHadOld = false;
      for (const item of list) {
        seen += 1;
        // id 双命名兜底（新形态可能叫 activity_id，WanSync 同款）；时间三兜底见
        // extractActivityStartAt
        const map = item as {
          id?: unknown;
          activity_id?: unknown;
          start_riding_time?: unknown;
          start_time?: unknown;
          created_at?: unknown;
          time_seconds?: unknown;
        };
        const id = map?.id ?? map?.activity_id;
        // 时长秒（跨源合并的骑行级匹配键，缺省 null）
        const durRaw = typeof map?.time_seconds === 'number' ? map.time_seconds : Number(map?.time_seconds);
        const durationSec = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : null;
        const hasAnyTimeField =
          map?.start_riding_time !== undefined ||
          map?.start_time !== undefined ||
          (map?.created_at !== undefined && map?.created_at !== null && map?.created_at !== '');
        const startAt = extractActivityStartAt(item ?? {});
        if (!id || (!hasAnyTimeField && !startAt)) {
          // id/时间字段全缺：无法定位 → 丢弃，但必须计数——「新侧」的丢弃条目会让
          // 整份结果不可信（见收尾守卫），不能无声吞掉
          dropped += 1;
          if (sawOldParsed) droppedAfterOld += 1;
          else droppedBeforeOld += 1;
          continue;
        }
        if (!startAt) {
          // 时间字段在但全部不可解析：保既定口径——条目仍入列表（startAt 仅失败
          // 重试锚点用，null 不影响下载导入），只计诊断。格式漂移不升级成丢记录。
          recovered += 1;
          out.push({ id: String(id), startAt: null, durationSec });
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
        out.push({ id: String(id), startAt, durationSec });
      }
      if (!data.pagination?.has_more) {
        stopReason = 'end';
        break;
      }
      // 翻页停止判据放**页边界**而非条目中途：页内可能还混着窗口内条目（方向异常或
      // 单条旧条目跨页时，条目中途停会把同页/后续页的窗口内记录漏掉）。降序（未见
      // 升序）且本页见过旧条目、样本足够断序（parsed ≥ 2，首条旧条目无法判定方向）
      // ⇒ 后面只可能更旧，到此为止，不为全量历史买单。先于截断判定——窗口已扫完时
      // 「页数恰好用尽」不算异常。
      if (since && !ascending && pageHadOld && parsed >= 2) {
        stopReason = 'boundary';
        break;
      }
      if (page >= maxPages) {
        stopReason = 'truncated'; // 服务端还有下一页但翻页上限用尽：本轮不完整，不可信
        break;
      }
    }
    if (stopReason === 'truncated') {
      throw new SyncError('api', `活动列表超过翻页上限（${maxPages} 页）仍未到头，已中止本轮以防漏同步`);
    }
    // 「新侧」存在丢弃条目 ⇒ 结果不完整（可能已把未同步的新记录丢掉），与 out 是否
    // 为空无关——out 非空也照样可能丢掉了同侧的新记录：升序取边界后的丢弃数、降序
    // 取边界前的丢弃数、方向未知（可解析样本不足两条）保守取两侧之和。显式报错，
    // 服务端恢复后由水位线未动自动补回。
    const suspicious =
      ascending
        ? droppedAfterOld
        : parsed >= 2
          ? droppedBeforeOld
          : droppedBeforeOld + droppedAfterOld;
    if (suspicious > 0) {
      throw new SyncError(
        'api',
        `活动列表有 ${suspicious} 条记录缺少 id/起骑时间、无法确认是否为未同步的新记录（响应形状疑似变更），已中止本轮以防漏同步`,
      );
    }
    console.log(
      `onelap 列表：窗口 ${since ? since.toISOString() : '全量'} 收到 ${out.length} 条` +
        `（扫描 ${seen} 条，时间不可解析仍导入 ${recovered} 条，丢弃 ${dropped} 条，` +
        `停止=${stopReason ?? 'end'}${ascending ? '，旧→新序' : ''}）`,
    );
    return out;
}

  const client: OnelapClient = {
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

    /**
     * 窗口内活动列表 = 旧记录面（ride_record/list）⊕ OTM 日历（calendar/records）。
     * 2026-10 中服务端变更把记录面迁到 OTM 日历管线（旧 list 对已迁移账号终止在
     * 10-13），而日历一次返回全量（Mongo _id + 本地日历日，无文件引用）。合并口径：
     * **日历是完整性权威**（覆盖新记录面，失败即抛——旧路的「成功」对已迁移账号是
     * 假象）；旧 list 条目**优先**（数字 id 可走既有 analysis 端点下载、时刻精确），
     * 日历按「本地日 + 时长 ±2 分钟」骑行级匹配补其缺失（重合由文件名预检与内容指纹
     * 兜底，宁重勿漏）；旧路失败可回落日历独供，日历失败不可用旧路顶替（水位线冻结）。
     */
    async listSince(session, since, maxPages = 500) {
      let legacy: RemoteActivity[] | null = null;
      let legacyError: SyncError | null = null;
      try {
        legacy = await scanRideRecordList(session, since, maxPages);
      } catch (e) {
        legacyError = e instanceof SyncError ? e : new SyncError('api', String(e));
        console.warn(`onelap 旧列表（ride_record/list）失败，回落 OTM 日历: ${legacyError.message}`);
      }

      let calendar: RemoteActivity[] | null = null;
      let calendarError: SyncError | null = null;
      try {
        const json = (await postJson(calendarUrl, authHeaders(session), {})) as unknown;
        const all = parseCalendarRecords(json);
        // 矛盾守卫（§38 回审 P2-3）：日历是全量源，正常永远非空（账号再新也有注册后
        // 的记录面）；回 code 200 空数组而旧路窗口内有记录 = 服务端软故障回空——§37
        // 事故同款形态移位到新权威源，按形状异常报错，绝不当作「没有新记录」
        if (all.length === 0 && legacy && legacy.length > 0) {
          throw new SyncError(
            'api',
            'OTM 日历返回空数组而旧记录面窗口内有记录（响应形状疑似变更），已中止本轮以防漏同步',
          );
        }
        // 日粒度窗口过滤：date 起点日 ≥ since 起点日（日历无时刻，宁宽勿窄）
        calendar = since
          ? all.filter((a) => a.startAt && dayStart(a.startAt) >= dayStart(since))
          : all;
      } catch (e) {
        calendarError = e instanceof SyncError ? e : new SyncError('api', String(e));
      }

      // ⚠️ 日历是完整性的权威源（全量、覆盖新记录面），它失败 ⇒ 本轮「有没有新记录」
      // 不可知——按 §37 纪律显式报错（水位线由编排层冻结），绝不静默用旧路结果推进
      // 水位线：旧路对已迁移账号不吐新记录，「成功」只是假象，缺口会被 24h 缓冲永久藏住
      //（§38 评审 P0）。旧路失败可回落（日历独供），方向相反不行。
      if (!calendar) {
        if (calendarError && legacy) {
          throw new SyncError(
            'api',
            `OTM 日历列表失败（旧记录面不可作为完整性依据，已中止本轮以防漏同步）: ${calendarError.message}`,
          );
        }
        // 双失败：旧路错误优先（守卫信息更本质，如形状异常/截断），无旧路错误才抛日历的
        throw legacyError ?? calendarError ?? new SyncError('api', '活动列表两路均失败');
      }
      if (!legacy) {
        console.log(`onelap 列表：OTM 日历独供 ${calendar.length} 条（窗口 ${since ? since.toISOString() : '全量'}）`);
        return calendar;
      }
      // 骑行级匹配（±2 分钟容差，见 buildLegacyCoverage 注释）
      const covered = buildLegacyCoverage(legacy);
      const supplementary = calendar.filter((a) => !isCoveredByLegacy(covered, a));
      console.log(
        `onelap 列表合并：旧记录面 ${legacy.length} 条 + OTM 日历补充 ${supplementary.length} 条` +
          `（日历窗口内 ${calendar.length} 条，重合 ${calendar.length - supplementary.length} 条按旧路优先去重）`,
      );
      return [...legacy, ...supplementary];
    },

    getFitKey,

    async getFileRef(session, activity) {
      const key = await getFitKey(session, activity.id);
      return { key, fileName: extractFitFileName(key, activity.id) };
    },

    async download(session, ref: FileRef) {
      // 2026-10 适配：ref.key 是完整 http(s) URL（durl 签名直链）→ 裸 GET 不带鉴权头
      //（OSS 签名对额外头敏感，对齐迹驰直链口径）；否则 base64(key) 走 fit_content 路径
      const isDirectUrl = /^https?:\/\//i.test(ref.key);
      const url = isDirectUrl ? ref.key : buildFitContentUrl(rideBase, ref.key);
      const headers = isDirectUrl ? {} : authHeaders(session);
      // 下载 FIT 字节，body 读取同样在超时信号保护内
      const { res, done } = await fetchWithTimeout(
        doFetch,
        url,
        { headers },
        downloadTimeoutMs,
      );
      let bytes: ArrayBuffer;
      try {
        // 直链（durl 签名 URL）的 401/403 归 api 而非 auth——直链与会话无关（签名过期/
        // OSS 拒绝），归 auth 会触发 withAuthRetry 的无效重登并中止整轮、水位线卡死在
        // 同一活动（§38 评审 P1-1，对齐 igpsport.ts 的直链口径）；fit_content 路径仍是
        // 会话级端点，401/403 归 auth 走重登自愈。
        if (res.status === 401 || res.status === 403) {
          throw isDirectUrl
            ? new SyncError('api', `FIT 直链被拒（HTTP ${res.status}，签名可能已过期）`)
            : new SyncError('auth', '下载被拒（会话过期）');
        }
        if (!res.ok) throw new SyncError('api', `FIT 下载异常（HTTP ${res.status}）`);
        bytes = await res.arrayBuffer();
      } catch (e) {
        // body 阶段超时/网络中断同样归一为 network（而非裸 AbortError 逃逸）
        if (e instanceof SyncError) throw e;
        throw new SyncError('network', `FIT 下载失败: ${String(e)}`);
      } finally {
        done();
      }
      const data = new Uint8Array(bytes);
      // 错误体检测（对齐 WanSync 的 _throwIfErrorBody）：下载到 JSON 错误页/HTML 时
      // 给一句能看懂的话，别把垃圾字节丢给解析器
      if (!isFitBytes(data)) {
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        const head = String.fromCharCode(...data.slice(0, 1));
        if (contentType.includes('json') || contentType.includes('html') || head === '{' || head === '<') {
          throw new SyncError('api', `FIT 下载返回了错误内容（${contentType || '未知类型'}），云端可能暂无该文件`);
        }
      }
      return data;
    },
  };
  return client;
}

/** 从登录响应原文提取 uid 数字串（JSON.parse 大整数会丢精度，此处保真） */
function extractUid(raw: unknown): string | null {
  const text = typeof raw === 'string' ? raw : '';
  if (!text) return null;
  const m = /"userinfo"\s*:\s*\{[^}]*"uid"\s*:\s*(\d+)/.exec(text);
  return m ? m[1] : null;
}
