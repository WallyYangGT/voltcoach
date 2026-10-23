/**
 * sync.ts — 云同步编排（多平台，2026-10-16 由 syncOnelap.ts 泛化；同步说明见
 * README「云同步说明」）
 *
 * 流程：读 settings 同步状态取**当前生效平台** → 该平台凭据（未绑定即 fast-fail）
 * → 建执行器并取会话（缓存的 token 优先，无缓存或失效才登录/刷新）→ 云端列表
 * （窗口化增量：`syncWindowStart` = 上次同步时间前移 24h 与「最近 90 天」取较晚者，
 * 首次同步 90 天窗口）→ 逐活动取文件引用算文件名，本地已有的跳过（按文件名的幂等
 * 去重：下载前的省流量预检）→ 未知活动下载 FIT 字节走 importFitBytes 入库（其内部
 * 再按内容指纹判一次「异名同趟骑行」，命中计 duplicates）→ 回写**该平台槽位**的
 * 水位线与结果。活动之间随机间隔（`jitterDelayMs`）摊平请求突发。
 *
 * 平台差异全部收敛在 src/services/syncProviders.ts 的 SyncProvider 适配器里：本文件
 * 只依赖 SyncRunner 的五个动作（start/listSince/getFileRef/download/recover），不认识
 * 任何具体平台的协议与会话形状。换平台不产生重复导入：文件名预检 + 内容指纹
 * （core/dedupe 的日期±0/时长±2s/距离±0.05km）本就是为跨源场景设计的。
 *
 * 自动同步：前台 AppState 触发（国内 ROM 后台限制多，打开时拉最可靠），模块级 1h
 * 节流；失败仅警告不中断应用。并发防双跑：进行中的同步共享同一 Promise。
 * 保活：同步期间复用 AI 生成的 dataSync 前台服务壳（src/ai/keepalive 引用计数，
 * 2026-10-13 接入顽鹿、2026-10-16 泛化到多平台）——首次全量同步是分钟级任务，
 * 退后台/锁屏不被进程冻结打断。
 */

import {
  acquireGenerationKeepAlive,
  type KeepAliveHandle,
} from '@/ai/keepalive';
import { t } from '@/core/i18n';
import {
  getLang,
  getSyncState,
  listActivityFileNames,
  setSyncState,
} from '@/db';
import { jitterDelayMs, SyncError, syncWindowStart } from '@/sync/common';
import {
  providerState,
  withProviderState,
  type ProviderSyncState,
} from '@/sync/state';
import { importFitBytes } from './importFit';
import { providerById, type SyncProvider, type SyncRunner } from './syncProviders';

/** 同步节流用的等待（活动之间随机间隔，降低请求突发） */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 前台自动同步的最小间隔（手动「立即同步」不受限） */
const AUTO_THROTTLE_MS = 60 * 60 * 1000;

/**
 * 单轮同步的**对外**错误码（UI 按它映射 i18n；与 common.ts 的 SyncErrorCode 五值（网络/鉴权/
 * 需重授权/接口/无文件）不同层——那个是客户端抛错用的，这个只分「用户的处置方式」）。
 */
export type SyncOutcomeCode = 'no_account' | 'auth' | 'reauth' | 'other';

export interface SyncOutcome {
  imported: number;
  /** 文件名命中（云端文件算出的文件名本地已有）——下载前即跳过，省流量 */
  skipped: number;
  /** 内容指纹命中（文件名不同但库里已有同一趟骑行，多为先前手动导入过的）——下载解析后跳过 */
  duplicates: number;
  failed: number;
  /** null = 正常跑完；code 供 UI 双语化，message 为原始技术信息（存库并透出） */
  error: { code: SyncOutcomeCode; message: string } | null;
  /**
   * 最旧一条失败活动的起骑时间（ISO）。水位线推进锚点：failed>0 时推进到此时间
   * （而非当前时刻）——下次窗口仍覆盖失败活动重试，成功项按文件名幂等跳过；
   * 也不被永久性脏活动钉死水位线。
   */
  failureFloor: string | null;
}

/** SyncError → 稳定码（auth/reauth 单列供双语化，其余归 other 透出原始信息） */
function toError(e: unknown): { code: SyncOutcomeCode; message: string } {
  if (e instanceof SyncError) {
    if (e.code === 'auth') return { code: 'auth', message: e.message };
    if (e.code === 'reauth') return { code: 'reauth', message: e.message };
    return { code: 'other', message: e.message };
  }
  return { code: 'other', message: e instanceof Error ? e.message : String(e) };
}

const NO_ACCOUNT = { code: 'no_account', message: '' } as const;

/** 空计数（早退路径共用） */
function noCounts(): Pick<SyncOutcome, 'imported' | 'skipped' | 'duplicates' | 'failed'> {
  return { imported: 0, skipped: 0, duplicates: 0, failed: 0 };
}

let running: Promise<SyncOutcome> | null = null;

/** 进行中的同步直接复用同一 Promise（前台自动与手动点击撞车时防双跑） */
export function runSync(): Promise<SyncOutcome> {
  if (!running) {
    running = runSyncOnce().finally(() => {
      running = null;
    });
  }
  return running;
}

async function runSyncOnce(): Promise<SyncOutcome> {
  const state = await getSyncState();
  let provider: SyncProvider;
  try {
    provider = providerById(state.provider);
  } catch (e) {
    // 状态行里的平台没有实现（手改库/降级安装）：当错误报出，不静默
    return { ...noCounts(), error: toError(e), failureFloor: null };
  }
  const creds = await provider.loadCredentials();
  if (!creds) {
    return { ...noCounts(), error: { ...NO_ACCOUNT }, failureFloor: null };
  }

  // 同步保活（decisions §15 壳复用）：首次 90 天全量是分钟级任务（逐活动 2 个请求 +
  // 300–800ms jitter），期间 dataSync 前台服务使进程不被 Cached Apps Freezer 冻结，
  // 退后台/锁屏同步照常推进。与 AI 生成共用同一 FGS/引用计数：并发时只发一次 start、
  // 共用一条通知（文案以先到者为准，release 只删自己的令牌不会误停对方）。
  // 15 分钟 wake lock 硬上限只影响 CPU 保活，FGS 本身无时限（Android 15 dataSync
  // 6h/天额度远够），超长同步仍受冻结保护。放在账号校验之后——fast-fail 不闪通知。
  let keepAlive: KeepAliveHandle | null = null;
  try {
    const lang = await getLang();
    keepAlive = await acquireGenerationKeepAlive({
      title: t(lang, 'sync.keepalive_title'),
      body: t(lang, 'sync.keepalive_body'),
      channel: t(lang, 'sync.keepalive_channel'),
    });

    const prev = providerState(state, state.provider);
    const { outcome, listed } = await pullActivities(provider, prev);
    const err = outcome.error;
    // 水位线推进锚点：正常→当前时刻；有失败活动→最旧失败活动时间（下次窗口重试，
    // 成功项按文件名幂等跳过）；本轮出错（未拉到列表）→不动。
    // ⚠️ 云端列表为空（listed === 0）且已有水位线时**冻结不推进**（2026-10 顽鹿增量
    // 失效事故）：列表异常被客户端静默当空时，照常推进会把 24h 缓冲外的记录永久藏住
    // （现象即「同步时间在走、永远 0 新增 0 跳过」）。冻结的代价只是空窗轮次下轮多扫
    // 一点——窗口有「不早于 now−90 天」下限兜底，扫到的旧活动按文件名幂等跳过。
    const ranAt = new Date().toISOString();
    const nextSyncAt = err
      ? prev.last_sync_at
      : outcome.failureFloor ??
        (listed === 0 && prev.last_sync_at ? prev.last_sync_at : ranAt);
    // ⚠️ 收尾必须**重读状态行再只写目标平台槽位**：首次 90 天全量是分钟级，用户在同步
    // 途中切平台/关自动开关都会被开头那份快照整行覆盖写回（界面随后 load() 又把用户
    // 改动读回来，看起来像「切了没生效」）——provider/auto 以库内现值为准（评审 P2-1）
    const latest = await getSyncState();
    await setSyncState(
      withProviderState(latest, state.provider, {
        last_sync_at: nextSyncAt,
        // 上次**实际跑过**的时刻（展示用）：水位线被冻结/失败保位时，卡片上的
        // 「上次同步」仍如实反映最近一轮尝试（错误轮也更新）
        last_run_at: ranAt,
        last_result: err ? 'error' : 'ok',
        last_error: err?.message || null,
        last_counts: err
          ? prev.last_counts
          : {
              imported: outcome.imported,
              skipped: outcome.skipped,
              duplicates: outcome.duplicates,
              failed: outcome.failed,
            },
      }),
    );
    return outcome;
  } finally {
    await keepAlive?.release();
  }
}

/**
 * 取会话 → 拉取 → 入库；逐活动失败仅计数不中断（口径），鉴权失败终止本轮。
 * 会话：优先复用缓存令牌，401 时清缓存重登一次并重试原请求（只重试一次）。
 * 返回 listed = 云端列表实际给出的窗口内活动数（0 = 空窗轮，水位线冻结的判据）。
 */
async function pullActivities(
  provider: SyncProvider,
  prev: ProviderSyncState,
): Promise<{ outcome: SyncOutcome; listed: number }> {
  let runner: SyncRunner;
  try {
    runner = await provider.createRunner();
    await runner.start();
  } catch (e) {
    return { outcome: { ...noCounts(), error: toError(e), failureFloor: null }, listed: 0 };
  }

  // 窗口起点：水位线前移 24h 缓冲，但不早于「最近 SYNC_WINDOW_DAYS 天」（首次同步
  // 与长期未同步都截断——只回溯 3 个月，降低抓取观感，见 sync/common.syncWindowStart）
  const since = syncWindowStart(prev.last_sync_at);

  let cloudList: Awaited<ReturnType<SyncRunner['listSince']>>;
  try {
    cloudList = await runner.listSince(since);
  } catch (e) {
    return { outcome: { ...noCounts(), error: toError(e), failureFloor: null }, listed: 0 };
  }

  const existing = new Set(await listActivityFileNames());
  const outcome: SyncOutcome = { ...noCounts(), error: null, failureFloor: null };
  for (const [i, act] of cloudList.entries()) {
    // 活动之间随机等待 300–800ms：摊平请求突发（每个活动要发 2 个请求）
    if (i > 0) await sleep(jitterDelayMs());
    try {
      const ref = await runner.getFileRef(act);
      if (!ref) {
        // 云端本来就没有原始文件（手动录入/第三方来源的记录）：不是错误，计跳过。
        // 与「下载失败」区别对待——后者要锚定水位线重试，前者重试多少次都不会有文件。
        console.log(`${provider.id} 活动 ${act.id}：云端无原始文件，跳过`);
        outcome.skipped += 1;
        continue;
      }
      if (existing.has(ref.fileName)) {
        // 文件名预检命中即跳过（省下载）：绝大多数情况下就是本活动的历史副本。
        // 已知边界：若「本地同名的其实是另一趟骑行」（云端文件名与手动命名的碰撞，
        // 真实云端文件名自带日期时间戳故概率极低），该云活动会被静默跳过——打日志
        // 留痕。v3 起同名入库不再覆盖（会插新行），漏判只影响省下载的优化，不再有
        // 数据风险。
        console.warn(`${provider.id} 活动 ${act.id}：文件名 ${ref.fileName} 本地已存在，按重复跳过（未校验内容）`);
        outcome.skipped += 1;
        continue;
      }
      const bytes = await runner.download(ref);
      const { duplicateOfUuid } = await importFitBytes(bytes, ref.fileName, { source: provider.id });
      if (duplicateOfUuid) {
        // 内容指纹命中（多为先前手动导入过同一趟骑行）：计重复。注意 existing 是每轮从库里
        // 重建的，这里不能 add——那个名字并没有入库，add 到本轮集合只会让**同一轮里**
        // 后续算出同名文件的另一个活动被上面那条预检静默跳过（跨轮去重只能靠内容指纹，
        // 代价是该活动每次同步都重新下载 + 解析一次，换取不丢活动）
        outcome.duplicates += 1;
        continue;
      }
      existing.add(ref.fileName);
      outcome.imported += 1;
    } catch (e) {
      if (e instanceof SyncError && (e.code === 'auth' || e.code === 'reauth')) {
        return { outcome: { ...outcome, error: toError(e) }, listed: cloudList.length };
      }
      outcome.failed += 1;
      // 记录最旧失败活动时间，作为本轮水位线锚点（下次窗口覆盖重试）
      const failedAt = act.startAt;
      if (failedAt && (!outcome.failureFloor || failedAt < new Date(outcome.failureFloor))) {
        outcome.failureFloor = failedAt.toISOString();
      }
      console.warn(`${provider.id} 活动 ${act.id} 同步失败（跳过继续）:`, e);
    }
  }
  return { outcome, listed: cloudList.length };
}

let lastAutoAttempt = 0;

/**
 * 前台自动同步（根布局 AppState active 时调用）：当前生效平台 + 已绑定凭据 +
 * 开关开启 + 距上次尝试 ≥1h 才拉；一切失败静默（console.warn），不影响应用使用。
 */
export async function maybeAutoSync(): Promise<void> {
  try {
    const state = await getSyncState();
    if (!state.auto) return;
    const provider = providerById(state.provider);
    const creds = await provider.loadCredentials();
    if (!creds) return;
    const prev = providerState(state, state.provider);
    // 节流基准 = 上次实际跑过的时刻（含空窗冻结轮——水位线可能长期不动，用它会导致
    // 每次回前台都白跑一轮空同步）
    const attemptedAt = prev.last_run_at ?? prev.last_sync_at;
    if (attemptedAt && Date.now() - new Date(attemptedAt).getTime() < AUTO_THROTTLE_MS) return;
    if (Date.now() - lastAutoAttempt < AUTO_THROTTLE_MS) return;
    lastAutoAttempt = Date.now();
    await runSync();
  } catch (e) {
    console.warn('云同步自动同步失败（忽略）:', e);
  }
}
