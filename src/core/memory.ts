/**
 * memory.ts — AI 记忆分层规则（纯函数层，无 IO、无 RN/Expo 依赖）
 *
 * 记忆分两层：
 *  - 长期（long，默认）：除非被 supersedes 取代或用户删除，不过期；
 *  - 短期（short）：近期上下文，**过 MEMORY_SHORT_MAX_AGE_DAYS 天或新增
 *    MEMORY_SHORT_MAX_NEW_ACTIVITIES 次训练，先到即失效**——注入过滤 + 管理
 *    页灰显，并进入 MEMORY_PURGE_GRACE_DAYS 天宽限期。
 *
 * 失效/被取代的记忆不再永久保留：**失效（过期或被取代，先到者）满
 * MEMORY_PURGE_GRACE_DAYS 天后物理删除**（db 层 purgeInvalidatedMemories 调
 * shouldPurgeMemory 判定），宽限期内管理页保留灰标供追溯并显示清除倒计时。
 *
 * 失效与清除判定只在本文件实现（单一事实源）：db 层 listMemories 的注入过滤、
 * 管理页的 expired 标注与物理删除都调这里，不各自复制规则。"5 次训练"按
 * activities 行的 created_at（入库时刻，UTC "YYYY-MM-DD HH:MM:SS"）晚于记忆
 * created_at 的条数计——不用 id 差值，删除活动会虚耗 id 导致误判。
 */

/** 短期记忆的时长上限（天）：created_at 距今超过该天数即失效（严格大于） */
export const MEMORY_SHORT_MAX_AGE_DAYS = 14;
/** 短期记忆的新训练数上限：记忆写入后新增 ≥ 该数条活动即失效 */
export const MEMORY_SHORT_MAX_NEW_ACTIVITIES = 5;
/** 失效/被取代后的保留宽限期（天）：失效满该天数即物理删除（严格大于） */
export const MEMORY_PURGE_GRACE_DAYS = 5;

export type MemoryScope = 'short' | 'long';

/** 失效判定所需的最小记忆形状（db 行 / 提示词行均可） */
export interface MemoryExpiryInput {
  scope?: string | null;
  created_at?: string | null;
}

/** 清除判定所需的记忆形状：在失效判定基础上多一个被取代时刻（v4 起落库） */
export interface MemoryPurgeInput extends MemoryExpiryInput {
  superseded_at?: string | null;
}

/** SQLite datetime('now') 文本 → UTC ms；非该格式返回 null */
export function parseSqliteUtc(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

/**
 * 短期记忆是否已失效。长期/legacy（scope 非 'short'）恒 false；
 * 缺 created_at 时按未失效保守处理（宁可多注入一条也不静默丢上下文）。
 *
 * @param mem                 记忆行（至少 scope + created_at）
 * @param nowMs               当前时刻（UTC ms；由调用方注入保证可测）
 * @param activityCreatedAts  全部活动的入库时刻列表（SQLite UTC 文本）
 */
export function isShortMemoryExpired(
  mem: MemoryExpiryInput,
  nowMs: number,
  activityCreatedAts: string[],
): boolean {
  if (mem?.scope !== 'short') return false;
  const createdAt = typeof mem.created_at === 'string' ? mem.created_at : null;
  if (!createdAt) return false;
  const createdMs = parseSqliteUtc(createdAt);
  if (createdMs == null) return false;
  if (nowMs - createdMs > MEMORY_SHORT_MAX_AGE_DAYS * 86400000) return true;
  const newerCount = activityCreatedAts.filter((t) => t > createdAt).length;
  return newerCount >= MEMORY_SHORT_MAX_NEW_ACTIVITIES;
}

/**
 * 记忆的失效时刻（UTC ms）：注入过滤与物理删除共用的时间锚点。
 *  - 被取代：superseded_at（取代即退出注入集合，与 scope 无关）；
 *  - 短期过期：14 天线（created_at + 14 天）与「第 5 条更晚入库活动」的
 *    created_at，先到即失效——取两者更早者；
 *  - 两种状态并存（short 且被取代）取全部候选中最早者。
 * 无法确定失效时刻（superseded_at 缺失/格式异常、缺 created_at 等）返回 null，
 * 调用方按保守处理：不过滤、不删除。
 *
 * @param mem                 记忆行（至少 scope + created_at；被取代行带 superseded_at）
 * @param activityCreatedAts  全部活动的入库时刻列表（SQLite UTC 文本）
 */
export function memoryInvalidatedAtMs(
  mem: MemoryPurgeInput,
  activityCreatedAts: string[],
): number | null {
  const candidates: number[] = [];
  const supersededAt =
    typeof mem?.superseded_at === 'string' ? parseSqliteUtc(mem.superseded_at) : null;
  if (supersededAt != null) candidates.push(supersededAt);
  const createdAt = typeof mem?.created_at === 'string' ? mem.created_at : null;
  if (mem?.scope === 'short' && createdAt) {
    const createdMs = parseSqliteUtc(createdAt);
    if (createdMs != null) {
      // 14 天线：nowMs - createdMs 严格大于 14 天即失效 → 失效时刻 = created + 14 天
      candidates.push(createdMs + MEMORY_SHORT_MAX_AGE_DAYS * 86400000);
      // 训练数分支：第 5 条更晚入库活动的入库时刻即失效时刻（口径同 isShortMemoryExpired）
      const fifth = activityCreatedAts
        .filter((t) => t > createdAt)
        .sort()[MEMORY_SHORT_MAX_NEW_ACTIVITIES - 1];
      const fifthMs = fifth != null ? parseSqliteUtc(fifth) : null;
      if (fifthMs != null) candidates.push(fifthMs);
    }
  }
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * 失效记忆是否应物理删除：失效满 MEMORY_PURGE_GRACE_DAYS 天（严格大于，与
 * isShortMemoryExpired 的天数口径同款）即清除。宽限期内保留供追溯（管理页
 * 灰标 + 清除倒计时），过期后被清除。
 */
export function shouldPurgeMemory(
  mem: MemoryPurgeInput,
  nowMs: number,
  activityCreatedAts: string[],
): boolean {
  const invalidatedAt = memoryInvalidatedAtMs(mem, activityCreatedAts);
  return invalidatedAt != null && nowMs - invalidatedAt > MEMORY_PURGE_GRACE_DAYS * 86400000;
}
