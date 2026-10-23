/**
 * common.ts — 云同步平台无关层（2026-10-16 多平台化，从 onelap.ts 抽出）
 *
 * 只放与具体平台协议无关的东西：错误类型 / 带超时的 fetch / 连接探测 / 同步窗口
 * 与请求节流 / base64 与 UTF-8 字节辅助 / 平台客户端接口（SyncClient）。各平台客户端
 * （onelap.ts / igpsport.ts / wahoo.ts）沿用同一口径：**不 import 任何 RN/Expo**，
 * 全部环境注入，故 node:test 可直接覆盖（原 onelap.ts 的注入范式对全部平台适用）。
 *
 * 平台客户端的职责边界：三动作 = listSince（列表）→ getFileRef（文件引用 + 文件名）
 * → download（原始 FIT 字节）。账号/会话管理不在这里，由服务层按 provider 编排
 * （src/services/syncProviders.ts）。
 */

/** fetch 形状（expo/fetch 与 globalThis.fetch 皆可） */
export type FetchLike = typeof globalThis.fetch;

/** 客户端错误的稳定类别（服务层映射 i18n；原始信息随 message 透出） */
export type SyncErrorCode = 'network' | 'auth' | 'reauth' | 'api' | 'no_file';

/**
 * 云同步请求错误。'auth' = 凭据被拒（账号密码型：密码错/会话过期）；
 * 'reauth' = 需人工重新授权（OAuth 型：refresh token 失效，只能回授权页）——
 * 两者对用户的处置完全不同，故分开。
 */
export class SyncError extends Error {
  readonly code: SyncErrorCode;

  constructor(code: SyncErrorCode, message: string) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
  }
}

// ---------------- 平台客户端接口 ----------------

/** 云端活动（平台无关的最小形状：只需要 id 与起骑时刻） */
export interface RemoteActivity {
  /** 云端活动 id（字符串归一化，便于拼 URL 与日志） */
  id: string;
  /** 起骑时刻（本地时区 Date）；平台时间串解析失败为 null（仅影响失败重试锚点） */
  startAt: Date | null;
}

/**
 * 云端文件引用：key 供下载用（各平台语义不同：顽鹿是 fileKey、迹驰是 OSS 直链、
 * Wahoo 是 pre-signed URL），fileName 是来源文件名（同步预检用；v3 起不再是唯一身份）。
 */
export interface FileRef {
  key: string;
  fileName: string;
}

/**
 * 平台客户端三动作。会话类型 S 由各平台自定（顽鹿/迹驰是 token+uid，Wahoo 是
 * access token），服务层的适配器负责建会话与失效自愈。
 */
export interface SyncClient<S> {
  /**
   * 按 since 增量拉窗口内活动列表。生产路径恒传窗口起点，上限 maxPages 防失控
   * （部分平台无服务端时间过滤，过滤在客户端做）。实现须保证：窗口内活动**无论列表
   * 顺序（新→旧或旧→新）都能收齐**；「扫不到窗口边界」的空结果宁可显式报错也不得
   * 静默返回空数组——空列表会被编排层当成「没有新记录」并推进水位线（2026-10 顽鹿
   * 增量失效事故的教训，见 src/sync/onelap.ts listSince）。
   */
  listSince(session: S, since: Date | null, maxPages?: number): Promise<RemoteActivity[]>;
  /**
   * 活动 → 云端文件引用。返回 null 表示该活动云端没有原始文件（Wahoo 的手动
   * 录入/第三方来源、迹驰的未上传记录等）——编排层按「跳过」处理，不计失败：
   * 这不是错误，是服务端本来就没文件。
   */
  getFileRef(session: S, activity: RemoteActivity): Promise<FileRef | null>;
  /** 下载原始 FIT 字节（fileName 由 getFileRef 给出，下载结果不再改名） */
  download(session: S, ref: FileRef): Promise<Uint8Array>;
}

// ---------------- 超时与请求辅助 ----------------

/** 请求超时口径（对齐 AI 层思路：自管超时，不依赖运行时隐藏行为）。下载给大余量 */
export const REQUEST_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 120_000;
/** 连接探测（「测试连接」按钮）用短超时——探测要快速给结论，不能让人等 30s */
export const PROBE_TIMEOUT_MS = 10_000;

/** fetch 失败信息是否表示「被我们自己的超时掐断」。
 *  expo/fetch 的文案是 "Fetch request has been canceled"（无 abort 字样），
 *  标准实现给 AbortError——两种都要认，否则超时会被显示成一条看不懂的英文原文。 */
export function isAbortLike(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes('abort') || m.includes('cancel');
}

/**
 * 带超时的 fetch：AbortController 手工实现（Hermes 不保证有 AbortSignal.timeout）。
 * 返回 done()：signal 同时保护 body 读取（服务端"发头即挂住 body"同样会挂死
 * 调用方），调用方读完 body 后必须调 done() 清计时器——推荐 try/finally 包裹。
 */
export async function fetchWithTimeout(
  doFetch: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response; done: () => void }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { ...init, signal: controller.signal });
    return { res, done: () => clearTimeout(timer) };
  } catch (e) {
    clearTimeout(timer);
    const msg = String(e);
    if (isAbortLike(msg)) {
      throw new SyncError(
        'network',
        `请求超时（${Math.round(timeoutMs / 1000)}s 无响应，请检查网络或接口地址）: ${url}`,
      );
    }
    throw e;
  }
}

// ---------------- 连接探测（「测试连接」按钮，纯函数 + 注入 fetch/时钟） ----------------

/** 单次探测结果：reachable = 拿到了任何 HTTP 响应（含 4xx/5xx，能应答即链路通） */
export interface ProbeResult {
  url: string;
  reachable: boolean;
  /** 往返毫秒（不可达时为尝试耗时） */
  ms: number;
  /** HTTP 状态码（不可达时为 null） */
  status: number | null;
  /** 不可达原因（可达时为 null） */
  detail: string | null;
}

/** URL 列表 → 去重后的 origin 列表（非法 URL 跳过；同源自动去重） */
export function endpointOrigins(urls: (string | undefined | null)[]): string[] {
  const origins: string[] = [];
  for (const u of urls) {
    if (!u) continue;
    try {
      const o = new URL(u).origin;
      if (!origins.includes(o)) origins.push(o);
    } catch {
      // 非法 URL 跳过（配置错误由同步请求自身报错）
    }
  }
  return origins;
}

/**
 * 探测单个端点：GET 该源根路径，短超时（默认 10s）。**只为验证链路**——能拿到任何
 * HTTP 状态码即算可达（403/404 也证明 DNS/连接/TLS/HTTP 都通），全无响应才算不可达，
 * 此时把原因（连接超时/DNS 失败/连接被拒）原样透出——正是排查「真机连不上」最需要的信息。
 */
export async function probeEndpoint(
  url: string,
  opts: { fetchImpl?: FetchLike; timeoutMs?: number; now?: () => number } = {},
): Promise<ProbeResult> {
  const doFetch = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const nowMs = opts.now ?? (() => Date.now());
  const started = nowMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, { method: 'GET', signal: controller.signal });
    return { url, reachable: true, ms: Math.round(nowMs() - started), status: res.status, detail: null };
  } catch (e) {
    const msg = String(e);
    const detail = isAbortLike(msg)
      ? `连接超时（${Math.round(timeoutMs / 1000)}s 无响应）`
      : msg.replace(/^Error:\s*/, '').slice(0, 160);
    return { url, reachable: false, ms: Math.round(nowMs() - started), status: null, detail };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------- 同步窗口与请求节流 ----------------

/**
 * 同步窗口天数：只拉取最近 N 天的活动（2026-09-22 定，降低对非官方接口的抓取观感）。
 * 首次同步与「超过 N 天没同步」的间隔都截到此窗口，历史更早的数据不再回溯。
 */
export const SYNC_WINDOW_DAYS = 90;

/** 水位线前移缓冲：上次同步时间往前留 24h，吸收设备时钟/时区偏差导致的边界漏拉 */
export const SYNC_WATERMARK_BUFFER_MS = 24 * 3600 * 1000;

/**
 * 本轮同步的窗口起点（列表按起骑时间新→旧，早于该点即停止翻页）：
 *  - 首次同步（无水位线）：now − SYNC_WINDOW_DAYS；
 *  - 有水位线：上次同步时间前移 24h 缓冲，但**不早于** now − SYNC_WINDOW_DAYS
 *    （长时间未同步时截断，避免一次拉几百天的记录）。
 * 水位线字符串非法（时钟回拨/脏数据）时回落到窗口起点。
 */
export function syncWindowStart(
  lastSyncAt: string | null,
  now: Date = new Date(),
  windowDays: number = SYNC_WINDOW_DAYS,
): Date {
  const floor = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
  if (!lastSyncAt) return floor;
  const buffered = new Date(lastSyncAt).getTime() - SYNC_WATERMARK_BUFFER_MS;
  if (!Number.isFinite(buffered)) return floor;
  return new Date(Math.max(buffered, floor.getTime()));
}

/** 活动之间随机间隔的下界/上界（毫秒）：摊平同步时的请求突发 */
export const PACE_MIN_MS = 300;
export const PACE_MAX_MS = 800;

/** [min, max] 闭区间内的整数毫秒（rand 可注入以便测试；越界/非数按 min 处理） */
export function jitterDelayMs(rand: () => number = Math.random, min = PACE_MIN_MS, max = PACE_MAX_MS): number {
  const r = rand();
  if (!Number.isFinite(r) || r < 0) return min;
  return min + Math.floor(Math.min(r, 0.999_999) * (max - min + 1));
}

// ---------------- 字节辅助（不依赖 TextEncoder/Buffer，Hermes 与 node 通用） ----------------

/** UTF-8 编码（孤立代理替换 U+FFFD；与 src/backup/archive 同口径的独立副本，避免跨层耦合） */
export function utf8ToBytes(text: string): Uint8Array {
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

/** base64url 编码（RFC 4648 §5：+→-、/→_、去 = 填充）——OAuth PKCE 用 */
export function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * FIT 魔数校验（字节 8–11 == ".FIT"）：云端直链下载到的往往是错误页/占位内容/HTML，
 * 先校验能给一句能看懂的话，别把垃圾字节丢给解析器。各平台的直链下载共用。
 */
export function isFitBytes(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...bytes.slice(8, 12)) === '.FIT';
}

/** 十六进制串 → 字节（expo-crypto 的 digest 返回 hex，PKCE 需要原始字节做 base64url） */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
