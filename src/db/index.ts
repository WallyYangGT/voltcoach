/**
 * db/index.ts — 训练库（expo-sqlite + SQLCipher 加密）
 *
 * 移植自 fit-reader Web 版 src/db.js：建表/查询 SQL 原样平移，驱动从 node:sqlite
 * （同步 API）换 expo-sqlite（异步 API）。差异：
 *  - SQLCipher 已拍板启用：db key 首次随机生成（expo-crypto）
 *    存 expo-secure-store（Android Keystore），密钥不落盘；
 *  - 从零建库按最新 schema 整体创建（src/db/schema.ts），存量库由
 *    src/db/migrate.ts 按 PRAGMA user_version 走编号迁移链（v3 = 活动 uuid 身份、
 *    AI 报告/对话外键与指纹，decisions §34）；
 *  - 骑手参数不再用"全局可变对象原地合并"（旧版 syncAthleteFromDb 模式），
 *    改 getEffectiveAthlete() 显式返回合并值，由调用方（导入服务）注入 analyzeFile；
 *  - CTL/ATL/TSB 递推在 src/core/form.ts（纯函数），本层只做查询。
 *
 * M3 追加（自 fit-reader Web 版 src/db.js AI 段平移）：ai_reports / ai_chats / ai_chat_messages /
 * ai_memories 四表 CRUD 与 get/setAiConfig。差异：api_key 不入库（旧版明文存 settings 行），
 * 改存 expo-secure-store（Android Keystore，AI_KEY_STORE），get 时合并、set 时分流；
 * 其余校验口径（base_url 正则、temperature 0–2、记忆 500 字/白名单分类）与旧版逐字一致。
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { Summary } from '@/core/analyze';
import {
  CHAT_SUMMARY_SHAPE,
  parseChatSummary,
  type ChatSummaryRecord,
} from '@/core/chat-summary';
import { buildDossier, type AthleteDossier } from '@/core/dossier';
import { fillDailyTss, formSeriesDaily, formSnapshotAtEnd } from '@/core/form';
import type { CyclingRideInput } from '@/core/ftp';
import { isFtpCalibratedFrom } from '@/core/ftp';
import { t, type Lang } from '@/core/i18n';
import { isShortMemoryExpired, type MemoryScope } from '@/core/memory';
import { localDay } from '@/core/local-day';
import { monthlySummaryFromRows, type MonthlyItem, type MonthlyRow } from '@/core/monthly';
import {
  emptyProfile,
  isProfileEmpty,
  normalizeProfilePatch,
  parseStoredProfile,
  type RiderProfileData,
  type RiderProfilePatch,
} from '@/core/profile';
import {
  ATHLETE,
  AI_CONFIG,
  FTP_ESTIMATION,
  PLAN_VALIDATION,
  type AiConfig,
  type AthleteParams,
} from '@/core/settings';
import type { PlanIssue, TrainingPlan } from '@/core/training-plan';
import {
  DEFAULT_SYNC_STATE,
  normalizeSyncState,
  type ProviderSyncState,
  type SyncCounts,
  type SyncProviderId,
  type SyncState,
} from '@/sync/state';
import { SCHEMA_VERSION } from './migrations';
import { migrateSchema } from './migrate';
import { ensureRecordFileLayout } from '@/records-store';
import { isActivityUuid } from '@/core/identity';

// 供编排层/设置页引用的配置类型（db 层是 AiConfig 的存取入口，re-export 同源导出）
export type { AiConfig };
// schema 版本单源在 ./migrations（迁移步骤与版本同文件防漂移），此处转发旧出口
export { SCHEMA_VERSION };

const DB_NAME = 'fitness.db';
const DB_KEY_STORE = 'voltcoach.dbkey'; // SecureStore 键名（随 2026-09-19 更名用新前缀）

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** 首启随机生成 32 字节 hex 密钥存 Keystore；已有则原样返回（SQLCipher 建库/开库用）。
 *  M4 导出给备份层：无口令导出时该 key 随包写入 manifest（口径） */
export async function getDbKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DB_KEY_STORE);
  if (existing) return existing;
  const key = Crypto.getRandomBytes(32).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  await SecureStore.setItemAsync(DB_KEY_STORE, key);
  return key;
}


/**
 * 懒打开数据库：SQLCipher 密钥就绪后开库（db 落在 expo-sqlite 默认的
 * documentDirectory/SQLite/ 目录，备份导出时从该路径取整库文件）、schema 就位。
 * SQLCipher 由 app.json 插件（expo-sqlite useSQLCipher: true）在原生层启用；
 * 开库后第一条语句必须是 `PRAGMA key`（hex 密钥无引号转义问题）。
 * schema 演进自 v2 起走编号步进迁移（见 ./migrations 与 migrateSchema）。
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    const opening = (async () => {
      const key = await getDbKey();
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(`PRAGMA key = "${key}";`);
      await migrateSchema(db);
      // v3 外键（ON DELETE SET NULL / CASCADE）必须在每个连接上显式开启；
      // 迁移期间由 runMigrations 临时关闭，迁移完成后恢复。
      await db.execAsync('PRAGMA foreign_keys = ON;');
      // v2 → v3：records 文件从 <file_name> 基名迁移到 <uuid>（幂等，标记后跳过）
      await ensureRecordFileLayout(db);
      return db;
    })();
    dbPromise = opening;
    // 开库/迁移失败不缓存 rejected promise（否则一次迁移故障把数据库访问永久打死，
    // 只能杀进程恢复）：失败时复位单例，下次 getDb 重新尝试
    opening.catch(() => {
      if (dbPromise === opening) dbPromise = null;
    });
  }
  return dbPromise;
}

/**
 * 关库并复位懒加载单例（备份导入的原子替换流程用：换文件前必须先关掉旧连接，
 * 否则新文件改名后被旧句柄的 inode 占住）。从未开过库是幂等 no-op；
 * 关闭失败也照常复位单例（下次 getDb 重新开库）。
 */
export async function closeDb(): Promise<void> {
  if (!dbPromise) return;
  const opening = dbPromise;
  dbPromise = null;
  try {
    const db = await opening;
    await db.closeAsync();
  } catch (e) {
    console.warn('db 关闭失败（单例已复位，忽略）:', e);
  }
}

/** 活动总数（备份 manifest counts 与导入结果展示用） */
export async function countActivities(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ c: number }>('SELECT COUNT(*) AS c FROM activities;');
  return row?.c ?? 0;
}

// ---------------- 骑手参数（存 settings 表，「我的」设置页维护，M2 接 UI） ----------------

/** 生效骑手参数：训练库 athlete 行覆盖出厂默认值（无行/行损坏回落默认） */
export async function getEffectiveAthlete(): Promise<AthleteParams> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  const merged: AthleteParams = { ...ATHLETE };
  if (row) {
    try {
      Object.assign(merged, JSON.parse(row.value));
    } catch {
      // 行内容损坏时忽略，保持默认值
    }
  }
  return merged;
}

/** 当前骑手参数状态：生效值 + 是否已在库中配置（首开引导用） */
export async function getAthleteState(): Promise<{ athlete: AthleteParams; configured: boolean }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  const athlete = await getEffectiveAthlete();
  return { athlete, configured: !!row };
}

// 骑手参数合法范围（FTP 上下限复用 FTP_ESTIMATION 的采纳写回口径，与旧版一致）
const ATHLETE_LIMITS = {
  ftp_watts: [FTP_ESTIMATION.apply_min_w, FTP_ESTIMATION.apply_max_w] as const,
  max_hr: [120, 230] as const,
  weight_kg: [30, 200] as const,
};

/** FTP 更新来源（溯源戳随 athlete JSON 落库；UI「我的」页手动保存为缺省 manual） */
export type FtpSource = 'manual' | 'estimate' | 'ai_coach';

/** FTP 溯源戳：最近一次 FTP 值实际变更的时间与来源（值未变不刷新时间戳） */
export interface FtpMeta {
  updated_at: string | null;
  source: FtpSource | null;
}

/** 读 FTP 溯源戳（athlete 行 JSON 的扩展字段；无行/损坏/旧数据返回全 null） */
export async function getFtpMeta(): Promise<FtpMeta> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  if (!row) return { updated_at: null, source: null };
  try {
    const p = JSON.parse(row.value);
    return {
      updated_at:
        typeof p.ftp_updated_at === 'string' && p.ftp_updated_at.length > 0
          ? p.ftp_updated_at
          : null,
      source: (p.ftp_source ?? null) as FtpSource | null,
    };
  } catch {
    return { updated_at: null, source: null };
  }
}

/**
 * FTP 是否已校准（2026-10-20 判据收紧，decisions §35）：健康瓦片 IF 采信与
 * AI 侧 athlete_configured 的统一口径（纯判据见 core/ftp.isFtpCalibratedFrom）。
 *
 * `getAthleteState().configured` 是「有 athlete 行」（用户可能只改过体重/最大心率，
 * FTP 仍是出厂默认 106W），不能作为「FTP 已校准」使用。单次读取 athlete 行
 * （含溯源戳与 AI 快照标记），读时归一化旧版撤销留下的 manual 假戳。
 */
export async function isFtpCalibrated(): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  let ftpWatts = ATHLETE.ftp_watts;
  let updatedAt: string | null = null;
  let source: FtpSource | null = null;
  let hasAiUpdate = false;
  if (row) {
    try {
      const p = JSON.parse(row.value);
      if (Number.isFinite(Number(p.ftp_watts))) ftpWatts = Number(p.ftp_watts);
      updatedAt = typeof p.ftp_updated_at === 'string' ? p.ftp_updated_at : null;
      source = (p.ftp_source ?? null) as FtpSource | null;
      hasAiUpdate = !!p.ai_ftp_update && typeof p.ai_ftp_update === 'object';
    } catch {
      // 行损坏：按出厂默认 + 无戳处理（保守判未校准）
    }
  }
  return isFtpCalibratedFrom(ftpWatts, updatedAt, ATHLETE.ftp_watts, {
    source,
    hasAiUpdate,
  });
}

/** AI 教练更新 FTP 的快照（athlete JSON 扩展字段 ai_ftp_update；首页披露条与撤销入口用，S3） */
export interface AiFtpUpdateSnapshot {
  old_ftp_w: number;
  new_ftp_w: number;
  updated_at: string;
  /** 模型自选的原值（2026-10-20 起；缺省=按估算均值更新，旧快照无此字段） */
  requested_w?: number;
  /** 自选所依据的估算区间（披露条展示「在区间内自选」） */
  range_low_w?: number;
  range_high_w?: number;
  /**
   * AI 更新前的溯源戳（撤销恢复用，2026-10-20 code-review P1）：撤销把 FTP 恢复成
   * 默认 106W 时，setAthlete 会因值变化重新盖戳 → 校准判据误判为已校准；撤销据此
   * 把溯源戳恢复到 AI 更新前的状态（旧快照无此字段按「无戳」处理，保守判未校准）。
   */
  old_ftp_updated_at?: string | null;
  old_ftp_source?: FtpSource | null;
}

/** 读 AI 更新快照（无行/损坏/字段不全返回 null） */
export async function getAiFtpUpdate(): Promise<AiFtpUpdateSnapshot | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'athlete'`,
  );
  if (!row) return null;
  try {
    const s = JSON.parse(row.value)?.ai_ftp_update;
    if (
      s &&
      typeof s === 'object' &&
      typeof s.old_ftp_w === 'number' &&
      typeof s.new_ftp_w === 'number' &&
      typeof s.updated_at === 'string'
    )
      return s as AiFtpUpdateSnapshot;
    return null;
  } catch {
    return null;
  }
}

/**
 * 写/清 AI 更新快照（null 清除）。沿用 athlete 行整写先例：基于 getEffectiveAthlete
 * 的合并结果写回（Object.assign 天然保活 ftp_updated_at 等其它扩展字段，不加列、
 * 不动 SCHEMA_VERSION）。与 setAthlete 分开——快照不是骑手参数，不走其校验与溯源戳。
 */
export async function setAiFtpUpdate(snapshot: AiFtpUpdateSnapshot | null): Promise<void> {
  // getEffectiveAthlete 经 Object.assign 合并行 JSON，返回对象已含全部扩展字段，整写回即保活
  const merged = { ...(await getEffectiveAthlete()) } as Record<string, unknown>;
  if (snapshot) merged.ai_ftp_update = snapshot;
  else delete merged.ai_ftp_update;
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('athlete', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(merged),
  );
}

/**
 * 更新骑手参数（允许只给部分字段）：校验 → 合并当前值写库。
 * 非法值抛 Error（message 按 lang 双语，界面直接透传展示）。
 * opts.source：FTP 值实际变更时在 athlete JSON 上盖溯源戳（ftp_updated_at/ftp_source），
 * 供「AI 已代为更新」的追溯与后续展示； athlete JSON 的扩展字段经 getEffectiveAthlete
 * 的 Object.assign 天然保活（不加列、不动 SCHEMA_VERSION）。
 * opts.stamps：显式覆盖溯源戳（仅撤销路径用）——恢复撤销前的戳或清除（null），
 * 避免「撤销回默认值」被 setAthlete 的自动盖戳误判为已校准。
 */
export async function setAthlete(
  partial: Partial<AthleteParams>,
  lang: Lang = 'zh',
  opts?: {
    source?: FtpSource;
    stamps?: { updated_at: string | null; source: FtpSource | null };
  },
): Promise<AthleteParams> {
  const updates: Record<string, number> = {};
  for (const key of Object.keys(ATHLETE_LIMITS) as (keyof typeof ATHLETE_LIMITS)[]) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    const [lo, hi] = ATHLETE_LIMITS[key];
    if (!Number.isFinite(v) || v < lo || v > hi)
      throw new Error(t(lang, 'athlete.range', { key, lo, hi }));
    updates[key] = v;
  }
  if (!Object.keys(updates).length) throw new Error(t(lang, 'athlete.none'));
  const current = await getEffectiveAthlete();
  const merged: AthleteParams & { ftp_updated_at?: string; ftp_source?: FtpSource } = {
    ...current,
    ...updates,
  };
  if (opts?.stamps) {
    // 撤销路径：显式恢复（null = 清除该字段，回到「从未变更」状态）
    if (opts.stamps.updated_at) merged.ftp_updated_at = opts.stamps.updated_at;
    else delete merged.ftp_updated_at;
    if (opts.stamps.source) merged.ftp_source = opts.stamps.source;
    else delete merged.ftp_source;
  } else if (updates.ftp_watts != null && updates.ftp_watts !== current.ftp_watts) {
    merged.ftp_updated_at = new Date().toISOString();
    merged.ftp_source = opts?.source ?? 'manual';
  }
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('athlete', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(merged),
  );
  return merged;
}

// ---------------- 用户背景与训练目标（存 settings 表 profile 行，「我的」设置页维护） ----------------

/**
 * 骑手档案：身份/目标 + 教练模式与时间预算（业余教练模式，2026-10-17，decisions §30）。
 * 所有字段存 settings 表 profile JSON 行——**不加列、不动 SCHEMA_VERSION**（沿
 * ai_ftp_update 快照先例；备份包随 settings 行整体迁移）。
 */
export interface RiderProfile extends RiderProfileData {
  /** 任一字段非空即视为已配置 */
  configured: boolean;
}

/** 当前骑手档案；未配置时各字段为空值（行内容损坏时按未配置返回） */
export async function getProfile(): Promise<RiderProfile> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'profile'`,
  );
  let data = emptyProfile();
  if (row) {
    try {
      data = parseStoredProfile(JSON.parse(row.value));
    } catch {
      // 行内容损坏时按未配置返回
    }
  }
  return { ...data, configured: !isProfileEmpty(data) };
}

/**
 * 更新骑手档案（允许只给部分字段）：校验 → 合并写库（校验/合并规则在 core/profile
 * 纯函数层，设置页与 AI 工具共用同一口径）。所有字段都为空时删除 profile 行。
 * 非法值抛 Error（message 按 lang 双语）。
 */
export async function setProfile(
  partial: RiderProfilePatch,
  lang: Lang = 'zh',
): Promise<RiderProfile> {
  const current = await getProfile();
  const merged = normalizeProfilePatch(current, partial, lang);
  const db = await getDb();
  if (isProfileEmpty(merged)) {
    await db.runAsync(`DELETE FROM settings WHERE key = 'profile'`);
  } else {
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES ('profile', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(merged),
    );
  }
  return { ...merged, configured: !isProfileEmpty(merged) };
}

// ---------------- 训练记录（v3：uuid 对外身份，file_name 为来源元数据） ----------------

/** 活动对外身份：32 位小写 hex（形状校验单源在 core/identity） */
export { isActivityUuid };

/** 生成新活动 uuid（RFC 4122 randomUUID 去连字符 → 32 hex） */
export function newActivityUuid(): string {
  return Crypto.randomUUID().replace(/-/g, '').toLowerCase();
}

/** summary → activities 列值（插入/更新共用，口径与旧 upsert 一致） */
function activityRowValues(summary: Summary) {
  const a = summary.activity;
  // 无功率数据的运动（跑步/游泳）没有 power 段；类型上以 Partial 放宽（旧版同款运行时口径）
  const p = (summary.power ?? {}) as Partial<NonNullable<Summary['power']>>;
  return {
    date: a.date,
    sport: a.sport ?? null,
    duration_sec: a.duration_sec ?? null,
    distance_km: a.distance_km ?? null,
    elevation_gain_m: a.elevation_gain_m ?? null,
    tss: p.tss ?? null,
    np: p.normalized_power ?? null,
    avg_power: p.avg ?? null,
    intensity_factor: p.intensity_factor ?? null,
    summary_json: JSON.stringify(summary),
  };
}

/** 新活动入库（身份由本层生成，返回 uuid；同名不再覆盖——导入决策见 core/dedupe） */
export async function insertActivity(input: {
  fileName: string;
  fingerprint: string;
  source?: string | null;
  summary: Summary;
}): Promise<string> {
  const db = await getDb();
  const uuid = newActivityUuid();
  const v = activityRowValues(input.summary);
  await db.runAsync(
    `INSERT INTO activities
       (uuid, file_name, source, fingerprint, date, sport, duration_sec, distance_km,
        elevation_gain_m, tss, np, avg_power, intensity_factor, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uuid,
    input.fileName,
    input.source ?? null,
    input.fingerprint,
    v.date,
    v.sport,
    v.duration_sec,
    v.distance_km,
    v.elevation_gain_m,
    v.tss,
    v.np,
    v.avg_power,
    v.intensity_factor,
    v.summary_json,
  );
  return uuid;
}

/**
 * 更新已有活动的分析结果（重导入/重算/功率校准共用）：保留 uuid、created_at、
 * 分类/备注/功率标记；fingerprint 仅在显式提供时更新（重算不改变骑行身份）。
 */
export async function updateActivitySummary(
  uuid: string,
  summary: Summary,
  opts?: { fingerprint?: string; lang?: Lang },
): Promise<void> {
  const db = await getDb();
  const v = activityRowValues(summary);
  const info = await db.runAsync(
    `UPDATE activities SET
       date = ?, sport = ?, duration_sec = ?, distance_km = ?, elevation_gain_m = ?,
       tss = ?, np = ?, avg_power = ?, intensity_factor = ?, summary_json = ?,
       fingerprint = COALESCE(?, fingerprint)
     WHERE uuid = ?`,
    v.date,
    v.sport,
    v.duration_sec,
    v.distance_km,
    v.elevation_gain_m,
    v.tss,
    v.np,
    v.avg_power,
    v.intensity_factor,
    v.summary_json,
    opts?.fingerprint ?? null,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(opts?.lang ?? 'zh', 'activity.not_found'));
}

/**
 * 路由/深链标识 → 活动 uuid：uuid 形状直接校验存在；否则按 file_name 回退
 * （兼容 v2 时代的 `/activity/<file_name>` 旧链接）。不存在返回 null。
 */
export async function resolveActivityUuid(identifier: string): Promise<string | null> {
  const db = await getDb();
  if (isActivityUuid(identifier)) {
    const row = await db.getFirstAsync<{ uuid: string }>(
      `SELECT uuid FROM activities WHERE uuid = ?`,
      identifier,
    );
    return row?.uuid ?? null;
  }
  const row = await db.getFirstAsync<{ uuid: string }>(
    `SELECT uuid FROM activities WHERE file_name = ? ORDER BY id DESC LIMIT 1`,
    identifier,
  );
  return row?.uuid ?? null;
}

/** 按 uuid 取来源文件名（服务层向用户/模型转述时用；不存在返回 null） */
export async function getActivityFileName(uuid: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ file_name: string }>(
    `SELECT file_name FROM activities WHERE uuid = ?`,
    uuid,
  );
  return row?.file_name ?? null;
}

/** 训练清单（含 uuid/file_name/运动类型/分类，界面列表展示，按日期倒序） */
export interface ActivityListItem {
  /** 对外稳定身份（路由、列表 key、AI 工具句柄） */
  uuid: string;
  file_name: string;
  date: string;
  sport: string;
  category: string;
  duration_sec: number | null;
  distance_km: number | null;
  elevation_gain_m: number | null;
  tss: number | null;
  np: number | null;
  avg_power: number | null;
  intensity_factor: number | null;
  /** 功率被标记不可信（from list 查询；旧调用方缺省视为 false） */
  power_flagged?: boolean;
}

/** 列表查询上限单源（listActivities 默认值与记录页触顶提示共用，防两处漂移） */
export const ACTIVITY_LIST_LIMIT = 200;

export async function listActivities(n: number = ACTIVITY_LIST_LIMIT): Promise<ActivityListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    sport: string | null;
    category: string | null;
    duration_sec: number | null;
    distance_km: number | null;
    elevation_gain_m: number | null;
    tss: number | null;
    np: number | null;
    avg_power: number | null;
    intensity_factor: number | null;
    power_flagged: number | null;
  }>(
    `SELECT uuid, file_name, date, sport, category, duration_sec, distance_km, elevation_gain_m,
            tss, np, avg_power, intensity_factor, power_flagged
     FROM activities ORDER BY date DESC LIMIT ?`,
    n,
  );
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
    uuid: r.uuid,
    file_name: r.file_name,
    date: r.date,
    sport: r.sport ?? 'unknown',
    category: r.category ?? 'training',
    duration_sec: r.duration_sec,
    distance_km: r1(r.distance_km),
    elevation_gain_m: r.elevation_gain_m == null ? null : Math.round(r.elevation_gain_m),
    tss: r.tss == null ? null : Math.round(r.tss),
    np: r.np == null ? null : Math.round(r.np),
    avg_power: r.avg_power == null ? null : Math.round(r.avg_power),
    // IF 保留库内 2 位精度：健康活动量等判定依赖 0.9/0.55 阈值，取整到 1 位会把
    // 0.85–0.89 误判为高强度（code-review P1-1）
    intensity_factor: r.intensity_factor,
    power_flagged: !!r.power_flagged,
  }));
}

/**
 * 按存储 UTC 日期范围取训练清单（计划执行视图 U1② 用）：fromDay/toDay 为 YYYY-MM-DD
 * UTC 日串（闭区间）。调用方传入本地周界 ±1 天的缓冲（跨时区起骑时刻可能落在相邻
 * UTC 日），行级本地日归并由调用方经 resolveRideDateLabels 完成。
 */
export async function listActivitiesInRange(fromDay: string, toDay: string): Promise<ActivityListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    sport: string | null;
    category: string | null;
    duration_sec: number | null;
    distance_km: number | null;
    elevation_gain_m: number | null;
    tss: number | null;
    np: number | null;
    avg_power: number | null;
    intensity_factor: number | null;
    power_flagged: number | null;
  }>(
    `SELECT uuid, file_name, date, sport, category, duration_sec, distance_km, elevation_gain_m,
            tss, np, avg_power, intensity_factor, power_flagged
     FROM activities WHERE date >= ? AND date <= ? ORDER BY date DESC`,
    fromDay,
    toDay,
  );
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
    uuid: r.uuid,
    file_name: r.file_name,
    date: r.date,
    sport: r.sport ?? 'unknown',
    category: r.category ?? 'training',
    duration_sec: r.duration_sec,
    distance_km: r1(r.distance_km),
    elevation_gain_m: r.elevation_gain_m == null ? null : Math.round(r.elevation_gain_m),
    tss: r.tss == null ? null : Math.round(r.tss),
    np: r.np == null ? null : Math.round(r.np),
    avg_power: r.avg_power == null ? null : Math.round(r.avg_power),
    intensity_factor: r.intensity_factor, // 保留 2 位精度（健康活动量阈值判定用）
    power_flagged: !!r.power_flagged,
  }));
}

/** 按 uuid 取单条训练的完整 summary（详情页用），并把 category 与 note 合并进 activity；不存在返回 null */
export async function getActivitySummary(uuid: string): Promise<Summary | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ summary_json: string; category: string | null; note: string | null }>(
    `SELECT summary_json, category, note FROM activities WHERE uuid = ?`,
    uuid,
  );
  if (!row) return null;
  try {
    const summary = JSON.parse(row.summary_json) as Summary;
    if (summary?.activity && row.category) {
      summary.activity.category = row.category;
    }
    if (summary?.activity && row.note) {
      summary.activity.note = row.note; // 用户备注（体感/路况等），AI 复盘时纳入考量
    }
    return summary;
  } catch {
    return null;
  }
}

const VALID_CATEGORIES = new Set(['training', 'race', 'recovery', 'leisure']);

/** 分类枚举（有序，供详情页分类 chips 等界面遍历；与 VALID_CATEGORIES 同源） */
export const CATEGORY_KEYS = [...VALID_CATEGORIES] as const;

/** 校验训练分类是否合法 */
export function isValidCategory(category: unknown): boolean {
  return VALID_CATEGORIES.has(category as string);
}

/** 更新训练分类（训练/比赛/恢复/休闲），非法值或训练不存在抛 Error */
export async function setActivityCategory(uuid: string, category: string, lang: Lang = 'zh'): Promise<void> {
  if (!isValidCategory(category)) throw new Error(t(lang, 'category.invalid'));
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET category = ? WHERE uuid = ?`,
    category,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
}

// 备注长度上限（自由文本：体感/路况等），防止误贴大段内容撑爆训练库与提示词
const NOTE_MAX_LEN = 2000;

/** 更新训练备注（空串/纯空白清除）；训练不存在抛 Error */
export async function setActivityNote(uuid: string, note: string, lang: Lang = 'zh'): Promise<void> {
  const text = String(note ?? '').trim();
  if (text.length > NOTE_MAX_LEN)
    throw new Error(t(lang, 'note.too_long', { n: NOTE_MAX_LEN }));
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET note = ? WHERE uuid = ?`,
    text || null,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
}

// ---------------- 功率可信度标记（v2：activities.power_flagged） ----------------

/**
 * 标记/取消某骑行的「功率不可信」（用户在详情页或 AI 经 set_power_flag 触发）。
 * 语义是"功率失真"而非"整趟作废"：档案聚合层据此把该骑行从功率派生基线
 * （峰功率/分区/爬坡/踏频风格/周 TSS）排除，心率漂移与时长仍采信。
 * 训练不存在抛 Error；调用方负责随后触发 rebuildDossierQuietly。
 */
export async function setActivityPowerFlag(
  uuid: string,
  flagged: boolean,
  lang: Lang = 'zh',
): Promise<void> {
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET power_flagged = ? WHERE uuid = ?`,
    flagged ? 1 : 0,
    uuid,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
}

/** 该骑行是否被标记功率不可信（详情页横幅展示用；不存在返回 false） */
export async function getActivityPowerFlag(uuid: string): Promise<boolean> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ power_flagged: number }>(
    `SELECT power_flagged FROM activities WHERE uuid = ?`,
    uuid,
  );
  return !!row?.power_flagged;
}

// ---------------- 训练记录的去重 / 删除 / 合并（M5，v3 改 uuid） ----------------

/**
 * 全表骑行键（含用户数据列）：导入查重（core/dedupe.decideImport）、数据管理页的
 * 重复检查、AI 报告标题取骑行信息共用。表规模为个人训练量（数百行），一次全量
 * 取回后在内存里比对，比在 SQL 里表达带容差的指纹简洁得多。
 * id 仅作「最早入库」排序；uuid 是对外身份；fingerprint 供精确重挂。
 */
export interface ActivityRideKey {
  id: number;
  uuid: string;
  file_name: string;
  fingerprint: string;
  date: string;
  sport: string;
  duration_sec: number | null;
  distance_km: number | null;
  category: string;
  note: string | null;
}

/** 全部训练的骑行键（按 id 升序 = 入库先后，合并重复时以最先入库者为保留项） */
export async function listActivityRideKeys(): Promise<ActivityRideKey[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    uuid: string;
    file_name: string;
    fingerprint: string;
    date: string;
    sport: string | null;
    duration_sec: number | null;
    distance_km: number | null;
    category: string | null;
    note: string | null;
  }>(
    `SELECT id, uuid, file_name, fingerprint, date, sport, duration_sec, distance_km, category, note
     FROM activities ORDER BY id ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    uuid: r.uuid,
    file_name: r.file_name,
    fingerprint: r.fingerprint,
    date: r.date,
    sport: r.sport ?? 'unknown',
    duration_sec: r.duration_sec,
    distance_km: r.distance_km,
    category: r.category ?? 'training',
    note: r.note,
  }));
}

/**
 * 删除单条训练（行 + 分类/备注随之消失），返回删除条数（0 = 不存在）。
 * 删除前把活动指纹覆盖到报告/对话引用上——外键 ON DELETE SET NULL
 * 会把 uuid 清空，但指纹留下，重新导入同一趟骑行时才能自动重挂（v3）。
 * 逐秒 records 文件不在本层处理（调用方按 uuid 删）。
 */
export async function deleteActivity(uuid: string): Promise<number> {
  const db = await getDb();
  let changes = 0;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ fingerprint: string }>(
      `SELECT fingerprint FROM activities WHERE uuid = ?`,
      uuid,
    );
    if (!row) return;
    await db.runAsync(
      `UPDATE ai_reports SET activity_fingerprint = ? WHERE activity_uuid = ?`,
      row.fingerprint,
      uuid,
    );
    await db.runAsync(
      `UPDATE ai_reports SET compare_fingerprint = ? WHERE compare_uuid = ?`,
      row.fingerprint,
      uuid,
    );
    await db.runAsync(
      `UPDATE ai_chats SET activity_fingerprint = ? WHERE activity_uuid = ?`,
      row.fingerprint,
      uuid,
    );
    const info = await db.runAsync(`DELETE FROM activities WHERE uuid = ?`, uuid);
    changes = info.changes;
  });
  return changes;
}

/**
 * 孤儿报告/对话自动重挂：活动删除后引用变 NULL 但指纹留下；同一趟骑行重新导入
 * （新 uuid）后，按精确指纹把悬空引用挂回新活动。返回重挂的引用条数。
 */
export async function reattachOrphanRefs(fingerprint: string, uuid: string): Promise<number> {
  if (!fingerprint) return 0;
  const db = await getDb();
  let total = 0;
  await db.withTransactionAsync(async () => {
    for (const sql of [
      `UPDATE ai_reports SET activity_uuid = ?
       WHERE activity_uuid IS NULL AND activity_fingerprint = ?`,
      `UPDATE ai_reports SET compare_uuid = ?
       WHERE compare_uuid IS NULL AND compare_fingerprint = ?`,
      `UPDATE ai_chats SET activity_uuid = ?
       WHERE activity_uuid IS NULL AND activity_fingerprint = ?`,
    ]) {
      const info = await db.runAsync(sql, uuid, fingerprint);
      total += info.changes;
    }
  });
  return total;
}

/**
 * 合并重复的 DB 侧原子操作（extras → 引用重挂 → 删副本，一个事务）：
 * 任一步失败整体回滚，避免「引用已改、行未删」的中间态。records 文件由调用方在
 * 事务前后用 uuid 处理（复制在前、删除在后）。
 * 返回被重挂的报告数。
 */
export async function mergeActivityRows(keepUuid: string, dropUuid: string): Promise<number> {
  const db = await getDb();
  let reports = 0;
  await db.withTransactionAsync(async () => {
    const drop = await db.getFirstAsync<{ fingerprint: string; category: string | null; note: string | null; power_flagged: number }>(
      `SELECT fingerprint, category, note, power_flagged FROM activities WHERE uuid = ?`,
      dropUuid,
    );
    if (!drop) return;
    await db.runAsync(
      `UPDATE activities SET
         category = CASE WHEN ? <> 'training' AND category = 'training' THEN ? ELSE category END,
         note     = CASE WHEN ? IS NOT NULL AND (note IS NULL OR note = '') THEN ? ELSE note END,
         power_flagged = CASE WHEN ? = 1 THEN 1 ELSE power_flagged END
       WHERE uuid = ?`,
      drop.category ?? 'training',
      drop.category ?? 'training',
      drop.note,
      drop.note,
      drop.power_flagged,
      keepUuid,
    );
    const keepFp = await db.getFirstAsync<{ fingerprint: string }>(
      `SELECT fingerprint FROM activities WHERE uuid = ?`,
      keepUuid,
    );
    if (!keepFp) throw new Error(t('zh', 'activity.not_found'));
    const moved = await db.runAsync(
      `UPDATE ai_reports SET activity_uuid = ?, activity_fingerprint = ?
       WHERE activity_uuid = ?`,
      keepUuid,
      keepFp.fingerprint,
      dropUuid,
    );
    reports = moved.changes;
    await db.runAsync(
      `UPDATE ai_reports SET compare_uuid = ?, compare_fingerprint = ?
       WHERE compare_uuid = ?`,
      keepUuid,
      keepFp.fingerprint,
      dropUuid,
    );
    await db.runAsync(
      `UPDATE ai_chats SET activity_uuid = ?, activity_fingerprint = ?
       WHERE activity_uuid = ?`,
      keepUuid,
      keepFp.fingerprint,
      dropUuid,
    );
    await db.runAsync(`DELETE FROM activities WHERE uuid = ?`, dropUuid);
  });
  return reports;
}


// ---------------- CTL/ATL/TSB（递推在 core/form，本层查询注入） ----------------

/** [起始, endDate] 范围内逐日 TSS（按天聚合，缺天补 0）→ 连续逐日序列 */
async function dailyTssSeries(endDate: string) {
  const db = await getDb();
  const rows = await db.getAllAsync<{ date: string; tss: number }>(
    `SELECT date, SUM(COALESCE(tss, 0)) AS tss
     FROM activities WHERE date <= ? GROUP BY date ORDER BY date`,
    endDate,
  );
  return fillDailyTss(rows, endDate);
}

/** 到 date（含）当天的 CTL/ATL/TSB 快照（口径与旧版 computeForm 一致）；训练库为空返回 null */
export async function computeForm(date: string, lang: Lang = 'zh') {
  const series = await dailyTssSeries(date);
  return formSnapshotAtEnd(series, lang);
}

/**
 * 最近 N 天逐日负荷序列 [{ date, tss, ctl, atl, tsb }]（口径与旧版 recentFormDaily 一致）。
 * 递推用 core/form 的 formSeriesDaily；序列末端延伸到今天（无训练日 TSS=0 照常参与
 * 衰减），趋势图与「当前体能指数」反映今天而不是停在最后一次训练的日期。
 * 默认 90 天为仪表盘趋势图口径（Web 版 dashboard 同款）。
 * 今天锚取本地日历日（双口径统一，2026-10）：末端=本地今天，清晨骑行计入今日负荷；
 * 内部日行标签仍沿 activities.date 的 UTC 日口径（聚合桶，段落/图轴只到月粒度）。
 */
export async function recentFormDaily(days = 90): Promise<{ date: string; tss: number; ctl: number; atl: number; tsb: number }[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ d: string | null }>(`SELECT MAX(date) AS d FROM activities`);
  if (!row?.d) return [];
  const today = localDay();
  const series = await dailyTssSeries(row.d < today ? today : row.d);
  return formSeriesDaily(series).slice(-days);
}

// ---------------- 月度汇总（归并计算在 core/monthly，本层只查询） ----------------

/** 最近 n 个月汇总（月 TSS/时长/距离/次数 + 强度占比与类型，口径与旧版 monthlySummary 一致） */
export async function monthlySummary(n = 6): Promise<MonthlyItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<MonthlyRow>(
    `SELECT date, duration_sec, distance_km, tss, summary_json
     FROM activities ORDER BY date DESC`,
  );
  return monthlySummaryFromRows(rows, n);
}

// ---------------- FTP 历史估算取数（估算算法在 core/ftp，本层只查询） ----------------

/** 最近 N 天内的骑行训练完整 summary（FTP 估算输入，按日期倒序；口径与旧版 cyclingSummariesSince 一致） */
export async function cyclingSummariesSince(days = 42): Promise<CyclingRideInput[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ d: string | null }>(`SELECT MAX(date) AS d FROM activities`);
  if (!row?.d) return [];
  const since = new Date(row.d + 'T00:00:00Z');
  since.setUTCDate(since.getUTCDate() - days);
  const sinceStr = since.toISOString().slice(0, 10);
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    duration_sec: number | null;
    power_flagged: number;
    summary_json: string;
  }>(
    `SELECT uuid, file_name, date, duration_sec, power_flagged, summary_json
     FROM activities
     WHERE sport = 'cycling' AND date >= ?
     ORDER BY date DESC`,
    sinceStr,
  );
  const out: CyclingRideInput[] = [];
  for (const r of rows) {
    try {
      out.push({
        uuid: r.uuid,
        file_name: r.file_name,
        date: r.date,
        duration_sec: r.duration_sec,
        power_flagged: !!r.power_flagged,
        summary: JSON.parse(r.summary_json),
      });
    } catch {
      // 存档 JSON 损坏时跳过该条
    }
  }
  return out;
}

// ---------------- 界面语言（settings 表 lang 键，AI 提示词缺省取此值） ----------------

/** 当前界面语言（zh/en；无配置回落 zh）。前端 AsyncStorage 为先，库值供 AI 提示词缺省 */
export async function getLang(): Promise<Lang> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'lang'`,
  );
  return row ? (row.value === 'en' ? 'en' : 'zh') : 'zh';
}

/** 保存界面语言（仅认 zh/en，非法值抛 Error） */
export async function setLang(lang: Lang): Promise<Lang> {
  // 开发者向 invariant：lang 本身无效时词典不可用，只能用非本地化文案（勿改走 i18n）
  if (lang !== 'zh' && lang !== 'en') throw new Error(`Unsupported lang: ${lang} (zh/en only)`);
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('lang', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    lang,
  );
  return lang;
}

// ---------------- 云同步状态（settings 表 sync 键，M4；2026-10-16 多平台化） ----------------
// 账号密码/令牌不进库（与 AI Key 同级敏感），存 SecureStore，由服务层管理。
// 行形状（当前生效平台 + 各平台分槽的水位线/计数）与旧行兼容归一化都在
// src/sync/state.ts——M4 的单平台扁平行会被自动读成顽鹿的槽位，老用户水位线不丢。

/** 单平台同步进度 / 最近计数 / 平台标识（形状与归一化定义在 src/sync/state.ts，此处转发出口） */
export type { ProviderSyncState, SyncCounts, SyncState, SyncProviderId };
export { DEFAULT_SYNC_STATE };

/** 当前同步状态（无行/行损坏回落默认值；旧版扁平行自动归一化） */
export async function getSyncState(): Promise<SyncState> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'sync'`,
  );
  if (!row) return { ...DEFAULT_SYNC_STATE };
  try {
    return normalizeSyncState(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_SYNC_STATE };
  }
}

/** 保存同步状态（调用方整行覆盖写） */
export async function setSyncState(state: SyncState): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('sync', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(state),
  );
}

/** 全部活动文件名（同步按文件名幂等去重的本地集合） */
export async function listActivityFileNames(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ file_name: string }>('SELECT file_name FROM activities');
  return rows.map((r) => r.file_name);
}

/** 全部活动 uuid（备份导出按它过滤 records 孤儿文件） */
export async function listActivityUuids(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ uuid: string }>('SELECT uuid FROM activities');
  return rows.map((r) => r.uuid);
}

// ---------------- AI 服务配置（settings 表 ai 行 + SecureStore 存密钥，M3） ----------------

// AI 密钥不进训练库（旧版明文入库）：存 SecureStore（Android Keystore），
// 默认不进系统备份；db 的 ai 行只保存其余配置字段。
const AI_KEY_STORE = 'voltcoach.aikey';

/**
 * 当前 AI 配置：出厂默认 ← settings 表 ai 行覆盖 ← api_key 从 SecureStore 读出。
 * 库行内容损坏时忽略该行（按默认值），返回 configured = 是否已配置密钥。
 */
export async function getAiConfig(): Promise<{ config: AiConfig; configured: boolean }> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'ai'`,
  );
  const config: AiConfig = { ...AI_CONFIG };
  if (row) {
    try {
      const saved = JSON.parse(row.value) as Partial<AiConfig>;
      // api_key 永远以 SecureStore 为准，忽略库行里的历史残留
      delete saved.api_key;
      Object.assign(config, saved);
    } catch {
      // 行内容损坏时按默认值返回
    }
  }
  const key = await SecureStore.getItemAsync(AI_KEY_STORE);
  config.api_key = key || null;
  return { config, configured: Boolean(config.api_key) };
}

/**
 * 更新 AI 服务配置（允许只给部分字段）：校验 → api_key 写 SecureStore、其余合并写库。
 * 校验口径与旧版 setAiConfig 逐字平移（非法值抛双语 Error，界面直接透传）；
 * api_key 传空字符串表示清除密钥（退化为复制提示词模式）。
 */
export async function setAiConfig(
  partial: Partial<Omit<AiConfig, 'api_key'>> & { api_key?: string | null },
  lang: Lang = 'zh',
): Promise<AiConfig> {
  const updates: Partial<AiConfig> = {};
  let keyUpdate: string | null | undefined; // undefined = 未涉及密钥
  if (partial?.api_key !== undefined && partial.api_key !== null) {
    if (typeof partial.api_key !== 'string') throw new Error(t(lang, 'ai.key_type'));
    keyUpdate = partial.api_key.trim() || null;
  }
  if (partial?.base_url != null) {
    const u = String(partial.base_url).trim().replace(/\/+$/, '');
    if (!/^https?:\/\/.+/.test(u)) throw new Error(t(lang, 'ai.base_url'));
    updates.base_url = u;
  }
  if (partial?.model != null) {
    const m = String(partial.model).trim();
    if (!m) throw new Error(t(lang, 'ai.model'));
    updates.model = m;
  }
  if (partial?.temperature !== undefined) {
    if (partial.temperature === null || (partial.temperature as unknown) === '') {
      updates.temperature = null; // 不传 temperature，用 API 默认
    } else {
      const v = Number(partial.temperature);
      if (!Number.isFinite(v) || v < 0 || v > 2)
        throw new Error(t(lang, 'ai.temperature'));
      updates.temperature = v;
    }
  }
  for (const key of ['timeout_ms', 'stall_ms'] as const) {
    if (partial?.[key] == null) continue;
    const v = Number(partial[key]);
    if (!Number.isFinite(v) || v < 1000)
      throw new Error(t(lang, 'ai.ms', { key }));
    updates[key] = Math.round(v);
  }
  if (partial?.stream != null) updates.stream = Boolean(partial.stream);
  if (partial?.agentic != null) updates.agentic = Boolean(partial.agentic);
  if (!Object.keys(updates).length && keyUpdate === undefined)
    throw new Error(t(lang, 'ai.none'));

  // 合并顺序：出厂默认 ← 库中现有值 ← 本次更新（与旧版 { ...AI_CONFIG, ...updates } 等价）
  const { config: current } = await getAiConfig();
  const merged: AiConfig = { ...current, ...updates };
  if (keyUpdate !== undefined) {
    if (keyUpdate) {
      await SecureStore.setItemAsync(AI_KEY_STORE, keyUpdate);
    } else {
      await SecureStore.deleteItemAsync(AI_KEY_STORE);
    }
  }
  merged.api_key = keyUpdate !== undefined ? keyUpdate : current.api_key;
  // db 行剔除 api_key（密钥只存 SecureStore）
  const { api_key: _omit, ...dbPart } = merged;
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('ai', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(dbPart),
  );
  return merged;
}

// ---------------- AI 报告（ai_reports，M3 自 fit-reader Web 版 src/db.js 平移） ----------------

export type AiReportMode = 'review' | 'plan' | 'taper' | 'compare';

/** 报告上下文（场景参数）：review 带活动 uuid、taper 带比赛日期、compare 带对比活动 uuid */
export interface AiReportContext {
  activity_uuid?: string | null;
  race_date?: string | null;
  compare_uuid?: string | null;
}

/** 报告列表项（不含 prompt/markdown 正文，列表页用） */
export interface AiReportListItem {
  id: number;
  mode: AiReportMode;
  activity_uuid: string | null;
  race_date: string | null;
  compare_uuid: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

/** 完整报告行（含 prompt + markdown + 重挂指纹） */
export interface AiReportRow extends AiReportListItem {
  activity_fingerprint: string | null;
  compare_fingerprint: string | null;
  prompt: string;
  markdown: string;
}

/** 保存完成的 AI 报告；每个 mode 仅保留最近 30 条（id DESC，不受 created_at 秒级精度影响） */
export async function saveAiReport(
  mode: AiReportMode,
  context: AiReportContext | null,
  prompt: string,
  markdown: string,
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_reports
       (mode, activity_uuid, race_date, compare_uuid,
        activity_fingerprint, compare_fingerprint, prompt, markdown, status)
     VALUES (?, ?, ?, ?,
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             ?, ?, 'completed')`,
    mode,
    context?.activity_uuid ?? null,
    context?.race_date ?? null,
    context?.compare_uuid ?? null,
    context?.activity_uuid ?? null,
    context?.compare_uuid ?? null,
    prompt ?? '',
    markdown ?? '',
  );
  const id = Number(info.lastInsertRowId);
  await trimAiReports(db, mode);
  return id;
}

/** 创建 status = pending 的报告占位记录（生成中前端可见进度），返回 id；同样受 30 条滚动限制 */
export async function createPendingAiReport(
  mode: AiReportMode,
  context: AiReportContext | null,
  prompt: string,
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_reports
       (mode, activity_uuid, race_date, compare_uuid,
        activity_fingerprint, compare_fingerprint, prompt, markdown, status)
     VALUES (?, ?, ?, ?,
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             (SELECT fingerprint FROM activities WHERE uuid = ?),
             ?, '', 'pending')`,
    mode,
    context?.activity_uuid ?? null,
    context?.race_date ?? null,
    context?.compare_uuid ?? null,
    context?.activity_uuid ?? null,
    context?.compare_uuid ?? null,
    prompt ?? '',
  );
  const id = Number(info.lastInsertRowId);
  await trimAiReports(db, mode);
  return id;
}

/** 每个 mode 滚动保留最近 30 条报告（pending 占位也参与计数） */
async function trimAiReports(db: SQLite.SQLiteDatabase, mode: AiReportMode): Promise<void> {
  await db.runAsync(
    `DELETE FROM ai_reports
     WHERE id NOT IN (
       SELECT id FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT 30
     ) AND mode = ?`,
    mode,
    mode,
  );
}

/** 更新报告（后台生成成功/失败时回填；COALESCE 语义与旧版一致，null 字段不覆盖） */
export async function updateAiReport(
  id: number,
  patch: { markdown?: string; status?: string; error?: string | null },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE ai_reports
     SET markdown = COALESCE(?, markdown),
         status = COALESCE(?, status),
         error = COALESCE(?, error)
     WHERE id = ?`,
    patch.markdown ?? null,
    patch.status ?? null,
    patch.error ?? null,
    id,
  );
}

/**
 * 用户取消报告生成（2026-10 取消按钮）：只把仍处 pending 的占位行置为 cancelled。
 * WHERE 守卫防覆盖——「触发生成」与「取消」存在竞态（fire 在 cancel 落库后才真正
 * 开跑），有守卫时后到的生成任务不会把用户刚取消的行又拉回 completed。
 * 返回是否有行被取消（编排层据此区分「已停止在跑任务」与「行本就不是 pending」）。
 */
export async function cancelPendingAiReport(id: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE ai_reports SET status = 'cancelled', error = NULL WHERE id = ? AND status = 'pending'`,
    id,
  );
  return r.changes > 0;
}

/**
 * 报告列表：mode 传具体场景时只列该 mode（旧版口径），传 'all' 时全部混排
 * （会话中心统一历史列表用，按 id 倒序跨 mode 排序）。
 */
export async function listAiReports(
  mode: AiReportMode | 'all' = 'all',
  n = 30,
): Promise<AiReportListItem[]> {
  const db = await getDb();
  const rows =
    mode === 'all'
      ? await db.getAllAsync<AiReportListItem & { prompt: string; markdown: string }>(
          `SELECT id, mode, activity_uuid, race_date, compare_uuid, status, error, created_at
           FROM ai_reports ORDER BY id DESC LIMIT ?`,
          n,
        )
      : await db.getAllAsync<AiReportListItem & { prompt: string; markdown: string }>(
          `SELECT id, mode, activity_uuid, race_date, compare_uuid, status, error, created_at
           FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT ?`,
          mode,
          n,
        );
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    activity_uuid: r.activity_uuid,
    race_date: r.race_date,
    compare_uuid: r.compare_uuid,
    status: r.status,
    error: r.error,
    created_at: r.created_at,
  }));
}

/** 按 id 取单条完整报告（含 prompt + markdown + status + error），不存在返回 null */
export async function getAiReport(id: number): Promise<AiReportRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<
    AiReportListItem & { prompt: string; markdown: string }
  >(`SELECT * FROM ai_reports WHERE id = ?`, id);
  return row ? toAiReportRow(row) : null;
}

/**
 * 某次训练的最新 review 报告（训练详情页内嵌展示用，口径同 Web 版
 * views/activities.js：按活动 uuid 过滤 review 列表取最新一条，含 pending/failed）。
 */
export async function getLatestReviewReport(activityUuid: string): Promise<AiReportRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<
    AiReportListItem & { prompt: string; markdown: string }
  >(
    `SELECT * FROM ai_reports WHERE mode = 'review' AND activity_uuid = ?
     ORDER BY id DESC LIMIT 1`,
    activityUuid,
  );
  return row ? toAiReportRow(row) : null;
}

/** ai_reports 行 → AiReportRow（SELECT * 或列裁剪结果皆可） */
function toAiReportRow(
  row: AiReportListItem & {
    prompt: string;
    markdown: string;
    activity_fingerprint?: string | null;
    compare_fingerprint?: string | null;
  },
): AiReportRow {
  return {
    id: row.id,
    mode: row.mode,
    activity_uuid: row.activity_uuid,
    race_date: row.race_date,
    compare_uuid: row.compare_uuid,
    activity_fingerprint: row.activity_fingerprint ?? null,
    compare_fingerprint: row.compare_fingerprint ?? null,
    prompt: row.prompt,
    markdown: row.markdown,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
  };
}

/**
 * 待恢复的报告占位（status=pending 的 id + created_at）。只读轻查询，供根布局
 * 回前台/冷启动时的自动续跑扫描用（进程内是否已在跑由编排层注册表判断）。
 */
export async function listPendingAiReportRefs(): Promise<
  { id: number; created_at: string }[]
> {
  const db = await getDb();
  return db.getAllAsync<{ id: number; created_at: string }>(
    `SELECT id, created_at FROM ai_reports WHERE status = 'pending' ORDER BY id`,
  );
}

// ---------------- AI 对话（ai_chats / ai_chat_messages，追问与直接对话统一，M3） ----------------

/** mode：follow_up 报告追问 / chat 直接对话 / plan 训练计划会话（v2，锚定当前计划而非活动，file_name/report_id 恒空） */
export type AiChatMode = 'follow_up' | 'chat' | 'plan';

// 每个 mode 滚动保留的对话数上限（沿用 ai_reports 的 id DESC LIMIT 清理模式）
const AI_CHAT_KEEP = 50;

/** 对话列表项（附消息条数与 pending 标记，供列表态显示"生成中"，不含正文） */
export interface AiChatListItem {
  id: number;
  mode: AiChatMode;
  report_id: number | null;
  /** 追问锚定的活动（v3；活动删除后置 NULL，靠 activity_fingerprint 重挂） */
  activity_uuid: string | null;
  title: string | null;
  message_count: number;
  has_pending: boolean;
  created_at: string;
  updated_at: string;
}

/** 对话消息行 */
export interface AiChatMessageRow {
  id: number;
  chat_id: number;
  role: 'user' | 'assistant';
  content: string;
  status: string;
  error: string | null;
  created_at: string;
}

/** 对话元信息 + 全部消息（按 id 升序） */
export interface AiChatRow extends Omit<AiChatListItem, 'message_count' | 'has_pending'> {
  messages: AiChatMessageRow[];
}

/**
 * 创建 AI 对话（mode: follow_up 报告追问 / chat 直接对话 / plan 计划会话），返回 id。
 * 每个 mode 仅保留最近 50 个对话，超出的旧对话连同其全部消息一起删除（级联）。
 * activity_uuid 非空时一并落活动指纹（删除后重挂用）。
 */
export async function createAiChat(
  mode: AiChatMode,
  meta: { report_id?: number | null; activity_uuid?: string | null; title?: string | null } = {},
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_chats (mode, report_id, activity_uuid, activity_fingerprint, title)
     VALUES (?, ?, ?, (SELECT fingerprint FROM activities WHERE uuid = ?), ?)`,
    mode,
    meta.report_id ?? null,
    meta.activity_uuid ?? null,
    meta.activity_uuid ?? null,
    meta.title ?? null,
  );
  const id = Number(info.lastInsertRowId);
  // 滚动清理：先删被挤出对话的消息，再删对话本身
  await db.runAsync(
    `DELETE FROM ai_chat_messages WHERE chat_id IN (
       SELECT id FROM ai_chats WHERE mode = ? AND id NOT IN (
         SELECT id FROM ai_chats WHERE mode = ? ORDER BY id DESC LIMIT ?
       )
     )`,
    mode,
    mode,
    AI_CHAT_KEEP,
  );
  await db.runAsync(
    `DELETE FROM ai_chats
     WHERE id NOT IN (
       SELECT id FROM ai_chats WHERE mode = ? ORDER BY id DESC LIMIT ?
     ) AND mode = ?`,
    mode,
    AI_CHAT_KEEP,
    mode,
  );
  await pruneOrphanChatSummaries(); // 被挤出对话的滚动摘要行一并清理
  return id;
}

/** 追加一条对话消息（assistant 可用 status='pending' 占位），返回消息 id */
export async function addAiChatMessage(
  chatId: number,
  role: AiChatMessageRow['role'],
  content: string,
  status = 'completed',
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_chat_messages (chat_id, role, content, status) VALUES (?, ?, ?, ?)`,
    chatId,
    role,
    String(content ?? ''),
    status,
  );
  return Number(info.lastInsertRowId);
}

/** 更新对话消息（后台生成成功/失败时回填，COALESCE 语义同 updateAiReport） */
export async function updateAiChatMessage(
  id: number,
  patch: { content?: string; status?: string; error?: string | null },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE ai_chat_messages
     SET content = COALESCE(?, content),
         status = COALESCE(?, status),
         error = COALESCE(?, error)
     WHERE id = ?`,
    patch.content ?? null,
    patch.status ?? null,
    patch.error ?? null,
    id,
  );
}

/** 用户取消对话消息生成（同 cancelPendingAiReport 的 pending 守卫口径），返回是否取消成功 */
export async function cancelPendingChatMessage(id: number): Promise<boolean> {
  const db = await getDb();
  const r = await db.runAsync(
    `UPDATE ai_chat_messages SET status = 'cancelled', error = NULL WHERE id = ? AND status = 'pending'`,
    id,
  );
  return r.changes > 0;
}

/** 有新消息时刷新对话的 updated_at（列表按它倒序，最近活跃的对话排前） */
export async function touchAiChat(chatId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE ai_chats SET updated_at = datetime('now') WHERE id = ?`, chatId);
}

/**
 * 待恢复的对话占位消息（status=pending 的 chat_id/message_id + created_at）。
 * 只读轻查询，供根布局回前台/冷启动时的自动续跑扫描用（同 listPendingAiReportRefs）。
 */
export async function listPendingChatMessageRefs(): Promise<
  { chat_id: number; message_id: number; created_at: string }[]
> {
  const db = await getDb();
  return db.getAllAsync<{ chat_id: number; message_id: number; created_at: string }>(
    `SELECT chat_id, id AS message_id, created_at
     FROM ai_chat_messages WHERE status = 'pending' ORDER BY id`,
  );
}

/** 某 mode 的对话列表（按 updated_at 倒序，附消息条数与 pending 标记，不含正文） */
export async function listAiChats(mode: AiChatMode, n = AI_CHAT_KEEP): Promise<AiChatListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    mode: AiChatMode;
    report_id: number | null;
    activity_uuid: string | null;
    title: string | null;
    message_count: number;
    has_pending: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT c.id, c.mode, c.report_id, c.activity_uuid, c.title, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM ai_chat_messages m WHERE m.chat_id = c.id) AS message_count,
            EXISTS(SELECT 1 FROM ai_chat_messages m
                   WHERE m.chat_id = c.id AND m.status = 'pending') AS has_pending
     FROM ai_chats c WHERE c.mode = ?
     ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    mode,
    n,
  );
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    report_id: r.report_id,
    activity_uuid: r.activity_uuid,
    title: r.title,
    message_count: r.message_count,
    has_pending: !!r.has_pending,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

/** 按 id 取对话元信息 + 全部消息（按 id 升序），不存在返回 null */
export async function getAiChat(id: number): Promise<AiChatRow | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{
    id: number;
    mode: AiChatMode;
    report_id: number | null;
    activity_uuid: string | null;
    title: string | null;
    created_at: string;
    updated_at: string;
  }>(`SELECT * FROM ai_chats WHERE id = ?`, id);
  if (!row) return null;
  const messages = await db.getAllAsync<AiChatMessageRow>(
    `SELECT id, chat_id, role, content, status, error, created_at
     FROM ai_chat_messages WHERE chat_id = ? ORDER BY id`,
    id,
  );
  return {
    id: row.id,
    mode: row.mode,
    report_id: row.report_id,
    activity_uuid: row.activity_uuid,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    messages,
  };
}

/** 该报告最新的 follow_up 对话 id（报告详情页追问"继续既有对话"用），没有返回 null */
export async function findFollowUpChat(reportId: number): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM ai_chats WHERE mode = 'follow_up' AND report_id = ?
     ORDER BY id DESC LIMIT 1`,
    reportId,
  );
  return row?.id ?? null;
}

/**
 * 最新的训练计划会话 id（计划页底部追问窗口用）：计划会话不锚定活动/报告，
 * 跨计划版本存活（调整产生新版本后同一会话继续），全局只有一条活跃线程，
 * 滚动清理按 mode 独立计数不会误删。没有返回 null。
 */
export async function findPlanChat(): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ id: number }>(
    `SELECT id FROM ai_chats WHERE mode = 'plan' ORDER BY id DESC LIMIT 1`,
  );
  return row?.id ?? null;
}

/** 删除整个对话及其全部消息，返回删除的对话数（0 = 不存在） */
export async function deleteAiChat(id: number): Promise<number> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM ai_chat_messages WHERE chat_id = ?`, id);
  const info = await db.runAsync(`DELETE FROM ai_chats WHERE id = ?`, id);
  // 滚动摘要行随对话删除（settings KV，无外键；不删会成为孤儿行）
  await db.runAsync(`DELETE FROM settings WHERE key = ?`, chatSummaryKey(id));
  return info.changes;
}

// ---------------- 对话滚动摘要（E1 上下文装配器，2026-10-17） ----------------
// 存 settings 表 `chat_summary:<chatId>` JSON 行：**不加列、不动 SCHEMA_VERSION**
// （沿 dossier/training_plan 的 settings KV 先例），备份整库拷贝透明携带。
// 生命周期与 ai_chats 绑定：deleteAiChat 删行；createAiChat 滚动清理旧对话后
// 按前缀清孤儿行（AUTOINCREMENT 不复用 id，残留行不会误配新对话，但收拾干净）。

const CHAT_SUMMARY_KEY_PREFIX = 'chat_summary:';
const chatSummaryKey = (chatId: number) => `${CHAT_SUMMARY_KEY_PREFIX}${chatId}`;

/** 读取对话滚动摘要（行损坏/形状不符返回 null，下次成功摘要自愈覆盖） */
export async function getChatSummary(chatId: number): Promise<ChatSummaryRecord | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    chatSummaryKey(chatId),
  );
  return parseChatSummary(row?.value);
}

/** 写入对话滚动摘要（up_to_message_id 为已覆盖的最后一条消息 id） */
export async function saveChatSummary(
  chatId: number,
  summary: string,
  upToMessageId: number,
): Promise<void> {
  const db = await getDb();
  const entry: ChatSummaryRecord = {
    shape: CHAT_SUMMARY_SHAPE,
    up_to_message_id: upToMessageId,
    summary,
  };
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    chatSummaryKey(chatId),
    JSON.stringify(entry),
  );
}

/** 清理已不存在的对话留下的摘要行（createAiChat 滚动删除后调用；best-effort，失败不影响新建对话） */
async function pruneOrphanChatSummaries(): Promise<void> {
  try {
    const db = await getDb();
    await db.runAsync(
      `DELETE FROM settings
       WHERE key LIKE 'chat_summary:%'
         AND CAST(substr(key, ?) AS INTEGER) NOT IN (SELECT id FROM ai_chats)`,
      CHAT_SUMMARY_KEY_PREFIX.length + 1,
    );
  } catch (e) {
    console.warn('清理孤儿对话摘要失败（不影响新建对话）:', e);
  }
}

// ---------------- AI 记忆（ai_memories，带时间戳与取代链，M3） ----------------

// 记忆分类白名单（非法值归入 general）；strategy = 与教练商定的训练策略（权威段，见 prompts）
const MEMORY_CATEGORIES = new Set(['general', 'injury', 'schedule', 'goal', 'preference', 'strategy']);
// 单条记忆长度上限（AI 用中文概括的完整陈述）
const MEMORY_MAX_LEN = 500;
// 库中最多保留条数：超出先删最旧的已被取代记忆，不足再删最旧有效记忆
const MEMORY_KEEP = 100;

/** 记忆行（listAll 附 active/expired 标记） */
export interface AiMemoryRow {
  id: number;
  content: string;
  category: string;
  source: string | null;
  /** 分层：short = 近期上下文（14 天或 5 次训练先到即失效，常量见 core/memory.ts），long = 长期（默认） */
  scope: string;
  created_at: string;
  superseded_by: number | null;
  active?: boolean;
  /** 仅短期记忆可能为 true：已过失效线（注入时被过滤、管理页灰显） */
  expired?: boolean;
}

/**
 * 保存一条 AI 记忆（用户个人事实：伤病/日程约束/目标变化/明确偏好/训练策略等），返回 id。
 * content 必填且 ≤500 字；category 非法归 general；scope 非法归 long；
 * supersedes_id 存在时校验目标记忆存在，并把其 superseded_by 置为新 id
 * （被取代的记忆不再注入但保留可追溯）。非法输入抛 Error（双语 message，
 * 工具层转为 {error} JSON 反馈给 AI）。
 */
export async function saveMemory(
  input: {
    content?: unknown;
    category?: unknown;
    scope?: unknown;
    source?: string | null;
    supersedes_id?: unknown;
  },
  lang: Lang = 'zh',
): Promise<number> {
  const text = String(input?.content ?? '').trim();
  if (!text) throw new Error(t(lang, 'memory.empty'));
  if (text.length > MEMORY_MAX_LEN)
    throw new Error(t(lang, 'memory.too_long', { n: MEMORY_MAX_LEN }));
  const cat = MEMORY_CATEGORIES.has(input?.category as string)
    ? (input.category as string)
    : 'general';
  const scope: MemoryScope = input?.scope === 'short' ? 'short' : 'long';
  const db = await getDb();
  let supersedeId: number | null = null;
  if (input?.supersedes_id != null) {
    supersedeId = Number(input.supersedes_id);
    const target = await db.getFirstAsync<{ id: number }>(
      `SELECT id FROM ai_memories WHERE id = ?`,
      supersedeId,
    );
    if (!target)
      throw new Error(t(lang, 'memory.supersede_not_found', { id: supersedeId }));
  }
  const info = await db.runAsync(
    `INSERT INTO ai_memories (content, category, source, scope) VALUES (?, ?, ?, ?)`,
    text,
    cat,
    input?.source ?? null,
    scope,
  );
  const id = Number(info.lastInsertRowId);
  if (supersedeId != null) {
    await db.runAsync(`UPDATE ai_memories SET superseded_by = ? WHERE id = ?`, id, supersedeId);
  }
  // 滚动清理：最多保留 100 条，先删最旧的已被取代记忆，不足再删最旧有效记忆
  const totalRow = await db.getFirstAsync<{ c: number }>(`SELECT COUNT(*) AS c FROM ai_memories`);
  let excess = (totalRow?.c ?? 0) - MEMORY_KEEP;
  if (excess > 0) {
    const del = await db.runAsync(
      `DELETE FROM ai_memories WHERE id IN (
         SELECT id FROM ai_memories WHERE superseded_by IS NOT NULL ORDER BY id LIMIT ?
       )`,
      excess,
    );
    excess -= del.changes;
    if (excess > 0) {
      await db.runAsync(
        `DELETE FROM ai_memories WHERE id IN (
           SELECT id FROM ai_memories ORDER BY id LIMIT ?
         )`,
        excess,
      );
    }
  }
  return id;
}

/**
 * 全部「可注入」记忆（未被取代，且短期记忆未过失效线），id DESC。
 * E1 起默认返回全量（≤MEMORY_KEEP=100），由编排层用 rankMemories 按相关度
 * top-k 挑选；不再在这里截最近 30 条（旧口径会让高相关旧记忆永远进不了 prompt）。
 * 失效过滤在 JS 侧调 core/memory 的单一判定源（不在 SQL 里复制失效天数/次数规则）；
 * 表受 MEMORY_KEEP=100 约束，全量取回后过滤的代价可忽略。
 */
export async function listMemories(n = MEMORY_KEEP): Promise<AiMemoryRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<AiMemoryRow>(
    `SELECT id, content, category, source, scope, created_at
     FROM ai_memories WHERE superseded_by IS NULL
     ORDER BY id DESC`,
  );
  const activityTimes = await listActivityCreatedAts();
  const nowMs = Date.now();
  return rows.filter((m) => !isShortMemoryExpired(m, nowMs, activityTimes)).slice(0, n);
}

/** 全部记忆（含已被取代与已过期的，管理界面用；id DESC，附 active/expired 标记） */
export async function listAllMemories(): Promise<AiMemoryRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<AiMemoryRow>(
    `SELECT id, content, category, source, scope, created_at, superseded_by
     FROM ai_memories ORDER BY id DESC`,
  );
  const activityTimes = await listActivityCreatedAts();
  const nowMs = Date.now();
  return rows.map((r) => ({
    ...r,
    active: r.superseded_by == null,
    expired: isShortMemoryExpired(r, nowMs, activityTimes),
  }));
}

/** 全部活动的入库时刻（短期记忆失效判定的「新增训练数」依据；≤数百行） */
async function listActivityCreatedAts(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ created_at: string }>(
    `SELECT created_at FROM activities`,
  );
  return rows.map((r) => r.created_at);
}

/** 删除指定记忆，返回删除条数（0 = 不存在） */
export async function deleteMemory(id: number): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(`DELETE FROM ai_memories WHERE id = ?`, id);
  return info.changes;
}

// ---------------- 个人训练档案（settings 表 dossier 行，v2） ----------------

/** 档案缓存行结构：dossier + 指纹（活动总数 + FTP）+ 结构版本（Dossier 字段演进时递增，旧结构直接重建，防深层取值崩掉报告生成链路——code-review P2-4）
 * v2（2026-10-17）：intensity_structure 增加 hr_zone_pct（业余单锚点降级）——旧缓存没
 * 这个字段，不升版会让新心率结构行在下次数据变更前一直缺失。 */
const DOSSIER_CACHE_SHAPE = 2;
interface DossierCacheEntry {
  shape: number;
  dossier: AthleteDossier;
  fingerprint: { rides: number; ftp: number };
}

/**
 * 当前个人训练档案（提示词注入与档案页共用入口）。
 * 缓存命中条件 = 指纹一致（活动总数与 FTP 均未变）；导入/删除/合并/改 FTP/
 * 标记功率/重算等变更点各自显式调 rebuildDossierQuietly，指纹只兜底覆盖
 * 遗漏路径（备份导入后首次读取、缓存行损坏等）——miss 时同步重建并写回。
 * 无骑行数据返回 null（提示词侧整段省略、UI 显示空态）。
 */
export async function getDossier(): Promise<AthleteDossier | null> {
  const db = await getDb();
  const [row, total, athlete] = await Promise.all([
    db.getFirstAsync<{ value: string }>(`SELECT value FROM settings WHERE key = 'dossier'`),
    countActivities(),
    getEffectiveAthlete(),
  ]);
  if (row) {
    try {
      const parsed = JSON.parse(row.value) as DossierCacheEntry;
      if (
        parsed?.dossier &&
        parsed?.shape === DOSSIER_CACHE_SHAPE &&
        parsed?.fingerprint?.rides === total &&
        parsed?.fingerprint?.ftp === athlete.ftp_watts
      ) {
        return parsed.dossier;
      }
    } catch {
      // 缓存行损坏走重建
    }
  }
  return rebuildDossier();
}

/** 全部骑行行 → 档案聚合输入（损坏 summary 行按无数据参与，计数仍准确） */
async function loadDossierRides() {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    uuid: string;
    file_name: string;
    date: string;
    sport: string | null;
    duration_sec: number | null;
    tss: number | null;
    power_flagged: number;
    summary_json: string;
  }>(
    `SELECT uuid, file_name, date, sport, duration_sec, tss, power_flagged, summary_json
     FROM activities WHERE sport = 'cycling'
     ORDER BY date ASC, id ASC`,
  );
  return rows.map((r) => {
    let summary: Summary | null = null;
    try {
      summary = JSON.parse(r.summary_json) as Summary;
    } catch {
      // 存档 JSON 损坏：该行按无 summary 参与（只进时长/计数口径）
    }
    return {
      uuid: r.uuid,
      file_name: r.file_name,
      date: r.date,
      sport: r.sport ?? 'unknown',
      power_flagged: !!r.power_flagged,
      duration_sec: r.duration_sec,
      tss: r.tss,
      summary,
    };
  });
}

/** 重建档案并写缓存（getDossier 与 rebuildDossierQuietly 的共用实现） */
async function rebuildDossier(): Promise<AthleteDossier | null> {
  const [rides, athlete, monthly, total] = await Promise.all([
    loadDossierRides(),
    getEffectiveAthlete(),
    monthlySummary(6),
    countActivities(),
  ]);
  const dossier = buildDossier(
    rides,
    athlete.ftp_watts,
    monthly.map((m) => ({ month: m.month, type: m.intensity_type })),
    new Date(),
  );
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('dossier', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify({
      shape: DOSSIER_CACHE_SHAPE,
      dossier,
      fingerprint: { rides: total, ftp: athlete.ftp_watts },
    }),
  );
  return dossier;
}

let dossierRolling = false;
let dossierRerollPending = false;

/**
 * 静默重建档案（数据变更触发点的 fire-and-forget 入口：导入成功/删除/合并/
 * FTP 变更/功率标记变更/重算/校准之后调用；失败仅警告——下次读取时指纹仍会
 * 自愈重建，不得影响主流程结果，口径同本地快照滚动）。并发合并：批量导入/
 * 顽鹿同步连发 N 次触发只在链尾多补一次，不做 N 次全库重算。
 */
export async function rebuildDossierQuietly(): Promise<void> {
  if (dossierRolling) {
    dossierRerollPending = true;
    return;
  }
  dossierRolling = true;
  try {
    do {
      dossierRerollPending = false;
      try {
        await rebuildDossier();
      } catch (e) {
        console.warn('训练档案重建失败（下次读取时自愈）:', e);
      }
    } while (dossierRerollPending);
  } finally {
    dossierRolling = false;
  }
}

// ---------------- 结构化训练计划（settings 表 training_plan / training_plan_history 行，v2 训练计划载体） ----------------
//
// 存储拍板（decisions §19）：单逻辑文档 + 版本历史，无 SQL 级查询需求——settings JSON 行
// 而非新表（dossier 先例），不动 SCHEMA_VERSION；settings 是通用 KV，备份整库拷贝透明携带，
// 旧版 App 忽略未知键，新备份仍可被旧版导入（新表方案会让备份包版本闸门拒收旧版）。
// 结构演进靠 shape 递增（同 dossier 的 code-review P2-4 口径）。

const PLAN_STORE_SHAPE = 1;
const PLAN_CURRENT_KEY = 'training_plan';
const PLAN_HISTORY_KEY = 'training_plan_history';

/** 已入库的一版计划（plan 已过 validateTrainingPlan 并回填 TSS；warnings 随版存档供展示） */
export interface StoredPlan {
  plan: TrainingPlan;
  created_at: string; // 入库时刻 ISO 串（展示用）
  origin: 'generate' | 'adjust'; // 周期规划生成 / 会话调整
  source_report_id: number | null; // generate：来源 plan 报告 id（计划页「查看生成报告」跳转）
  change_note: string | null; // adjust：模型给出的变更说明
  warnings: PlanIssue[]; // 入库时的合理性提示（create 档 R1–R3；业余软约束三档都可能有）
}

/** 当前计划行（热键只放当前版本，历史走独立冷键隔离读放大） */
interface PlanCurrentEntry {
  shape: number;
  current: StoredPlan;
}

/** 历史版本行（versions[0] 最近被替换的版本，上限 PLAN_VALIDATION.history_keep） */
interface PlanHistoryEntry {
  shape: number;
  versions: StoredPlan[];
}

const parseStoredPlan = (v: unknown): StoredPlan | null => {
  const p = v as StoredPlan | null;
  return p && typeof p === 'object' && p.plan && Array.isArray(p.plan.sessions) ? p : null;
};

/**
 * 当前训练计划（首页卡 / 计划页 / get_training_plan 工具共用入口）。
 * 无计划或行损坏（shape 不符/结构缺失）返回 null——损坏按无计划处理，
 * 下一次生成/调整会覆盖写入，自愈。
 */
export async function getCurrentPlan(): Promise<StoredPlan | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    PLAN_CURRENT_KEY,
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as PlanCurrentEntry;
    if (parsed?.shape === PLAN_STORE_SHAPE) return parseStoredPlan(parsed.current);
  } catch {
    // 行损坏按无计划处理
  }
  return null;
}

/** 计划版本历史（新序在前，只含被替换的旧版本，不含当前版；无/损坏返回空数组） */
export async function getPlanHistory(): Promise<StoredPlan[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    PLAN_HISTORY_KEY,
  );
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as PlanHistoryEntry;
    if (parsed?.shape === PLAN_STORE_SHAPE && Array.isArray(parsed.versions)) {
      return parsed.versions.map(parseStoredPlan).filter((v): v is StoredPlan => v != null);
    }
  } catch {
    // 行损坏按无历史处理
  }
  return [];
}

/**
 * 落一版计划：写当前行；已有当前版则先挪入历史头部（裁剪到 PLAN_VALIDATION.history_keep）。
 * 调用方负责先过 validateTrainingPlan（generate 钩子 / update_training_plan 工具），本层不重校验。
 * 返回落地后的总版本数（当前 1 + 历史条数，UI「第 N 版」用）。
 */
export async function savePlanVersion(
  plan: TrainingPlan,
  meta: {
    origin: 'generate' | 'adjust';
    source_report_id?: number | null;
    change_note?: string | null;
    warnings?: PlanIssue[];
  },
): Promise<number> {
  const db = await getDb();
  const entry: StoredPlan = {
    plan,
    created_at: new Date().toISOString(),
    origin: meta.origin,
    source_report_id: meta.source_report_id ?? null,
    change_note: meta.change_note ?? null,
    warnings: meta.warnings ?? [],
  };
  // 事务包住「旧版挪历史 + 写当前」两步：进程中断在中途会留下当前版同时出现在
  // history[0] 的重复版本（code-review P3），事务内读写保证原子
  let versionsTotal = 1;
  await db.withTransactionAsync(async () => {
    const [current, history] = await Promise.all([getCurrentPlan(), getPlanHistory()]);
    const versions = current
      ? [current, ...history].slice(0, PLAN_VALIDATION.history_keep)
      : history;
    if (current) {
      await db.runAsync(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        PLAN_HISTORY_KEY,
        JSON.stringify({ shape: PLAN_STORE_SHAPE, versions } satisfies PlanHistoryEntry),
      );
    }
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_CURRENT_KEY,
      JSON.stringify({ shape: PLAN_STORE_SHAPE, current: entry } satisfies PlanCurrentEntry),
    );
    versionsTotal = 1 + versions.length;
  });
  return versionsTotal;
}

// ---------------- 报告 ↔ 计划结构化关联（U1 收尾③，settings 松散引用行） ----------------
// 拍板（2026-10-15）：不加列、不动 SCHEMA_VERSION 与备份包闸门——沿 ai_ftp_update 快照
// 先例走 settings JSON 行。锚 = StoredPlan.created_at（位置无关，版本被替换/挪历史后
// 仍可定位）；版本号展示按位置推导（locatePlanVersion）。上限条数防 reports 滚动保留
// 期间链接行无界增长（ai_reports 每 mode 留 30，四 mode 最多 ~120 行链接）。

const PLAN_LINKS_KEY = 'plan_report_links';
const PLAN_LINKS_CAP = 200;

/** 报告关联的计划锚（该报告生成完成时锚定的 StoredPlan.created_at；无关联返回 null） */
export async function getPlanReportLink(reportId: number): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    PLAN_LINKS_KEY,
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Record<string, string>;
    const anchor = parsed[String(reportId)];
    return typeof anchor === 'string' ? anchor : null;
  } catch {
    return null; // 行损坏按无关联处理
  }
}

/** 记一条报告→计划锚（generateReport 收尾调用；超上限剪最旧）。读改写包事务：
 *  resumeInterruptedGenerations 会并行 fire 多条 generateReport，两条报告毫秒级窗口内
 *  先后完成时非事务的读改写会丢一次更新（code-review P2-1，照 savePlanVersion 先例） */
export async function recordPlanReportLink(reportId: number, planCreatedAt: string): Promise<void> {
  const db = await getDb();
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<{ value: string }>(
      `SELECT value FROM settings WHERE key = ?`,
      PLAN_LINKS_KEY,
    );
    let links: Record<string, string> = {};
    if (row) {
      try {
        const parsed = JSON.parse(row.value);
        if (parsed && typeof parsed === 'object') links = parsed;
      } catch {
        links = {}; // 行损坏重开
      }
    }
    links[String(reportId)] = planCreatedAt;
    const keys = Object.keys(links);
    for (const k of keys.slice(0, Math.max(0, keys.length - PLAN_LINKS_CAP))) delete links[k];
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_LINKS_KEY,
      JSON.stringify(links),
    );
  });
}

/**
 * 撤销最近一次计划版本替换（U1 收尾④「披露与可逆」的撤销半边）：事务内
 * current ↔ history[0] 交换——被撤销的版本进历史头部（再点一次撤销可换回，
 * 无数据丢失）；history_keep 裁剪口径不变。无历史版本或状态异常返回 false。
 */
export async function undoLastPlanVersion(): Promise<boolean> {
  const db = await getDb();
  let undone = false;
  await db.withTransactionAsync(async () => {
    const [current, history] = await Promise.all([getCurrentPlan(), getPlanHistory()]);
    // 只有历史而没有当前版属异常状态（savePlanVersion 先有当前版才有历史），不动
    if (!current || history.length === 0) return;
    const restored = history[0];
    const versions = [current, ...history.slice(1)].slice(0, PLAN_VALIDATION.history_keep);
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_HISTORY_KEY,
      JSON.stringify({ shape: PLAN_STORE_SHAPE, versions } satisfies PlanHistoryEntry),
    );
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      PLAN_CURRENT_KEY,
      JSON.stringify({ shape: PLAN_STORE_SHAPE, current: restored } satisfies PlanCurrentEntry),
    );
    undone = true;
  });
  return undone;
}

// ---------------- AI 调整披露条已读锚（settings 松散 KV 行，一次性披露） ----------------
//
// 计划/FTP 的调整披露条带撤销入口；用户看过且未撤销后不应永久常驻。锚 = 该次调整的
// 稳定身份（计划版 StoredPlan.created_at / FTP 快照 updated_at）：新调整 → 新锚 →
// 重新披露一次；每类只保留最近一次，不随历史增长。锚只存最近一次：连续调整后撤销
// 回更早的调整版时可能再披露一次——与「撤销可换回」的既有语义一致（严格每版只披露
// 一次需存有界 seen 集合，当前不做）。沿 ai_ftp_update 快照先例走 settings JSON 行
// ——不加列、不动 SCHEMA_VERSION，备份整库拷贝透明携带。

/** 一次性披露条类型（与组件 useAdjustNoticeVisible 的 kind 对应） */
export type AdjustNoticeKind = 'plan_adjust' | 'ftp_update';

const ADJUST_NOTICE_SEEN_PREFIX = 'adjust_notice_seen:';

/** 读某类披露条的已读锚（等于当前调整身份即不再展示；无行/损坏返回 null） */
export async function getAdjustNoticeSeen(kind: AdjustNoticeKind): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = ?`,
    ADJUST_NOTICE_SEEN_PREFIX + kind,
  );
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as { identity?: unknown };
    return typeof parsed?.identity === 'string' ? parsed.identity : null;
  } catch {
    return null; // 行损坏按未读处理，下次展示后覆盖写入自愈
  }
}

/** 记某类披露条已读锚（单行 upsert，两类各一行，无读改写竞态；空锚不写） */
export async function markAdjustNoticeSeen(
  kind: AdjustNoticeKind,
  identity: string,
): Promise<void> {
  if (!identity) return; // 损坏版本的空身份不标记，避免把异常态误判成已读
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ADJUST_NOTICE_SEEN_PREFIX + kind,
    JSON.stringify({ identity, seen_at: new Date().toISOString() }),
  );
}
