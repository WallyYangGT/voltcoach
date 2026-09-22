/**
 * db/index.ts — 训练库（expo-sqlite + SQLCipher 加密）
 *
 * 移植自 reference/src/db.js：建表/查询 SQL 原样平移，驱动从 node:sqlite
 * （同步 API）换 expo-sqlite（异步 API）。差异：
 *  - SQLCipher 已拍板启用（MIGRATION_PLAN §9.4）：db key 首次随机生成（expo-crypto）
 *    存 expo-secure-store（Android Keystore），密钥不落盘；
 *  - 从零建库，M1 版 schema 一次建齐（含旧版经 ALTER 迁移得到的列），
 *    PRAGMA user_version = 1 驱动未来备份导入的迁移链（§7.2）；
 *  - 骑手参数不再用"全局可变对象原地合并"（旧版 syncAthleteFromDb 模式），
 *    改 getEffectiveAthlete() 显式返回合并值，由调用方（导入服务）注入 analyzeFile；
 *  - CTL/ATL/TSB 递推在 src/core/form.ts（纯函数），本层只做查询。
 *
 * M3 追加（自 reference/src/db.js AI 段平移）：ai_reports / ai_chats / ai_chat_messages /
 * ai_memories 四表 CRUD 与 get/setAiConfig。差异：api_key 不入库（旧版明文存 settings 行），
 * 改存 expo-secure-store（Android Keystore，AI_KEY_STORE），get 时合并、set 时分流；
 * 其余校验口径（base_url 正则、temperature 0–2、记忆 500 字/白名单分类）与旧版逐字一致。
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { Summary } from '@/core/analyze';
import { fillDailyTss, formSeriesDaily, formSnapshotAtEnd } from '@/core/form';
import type { CyclingRideInput } from '@/core/ftp';
import { t, type Lang } from '@/core/i18n';
import { monthlySummaryFromRows, type MonthlyItem, type MonthlyRow } from '@/core/monthly';
import { ATHLETE, AI_CONFIG, FTP_ESTIMATION, type AiConfig, type AthleteParams } from '@/core/settings';

// 供编排层/设置页引用的配置类型（db 层是 AiConfig 的存取入口，re-export 同源导出）
export type { AiConfig };

const DB_NAME = 'fitness.db';
const DB_KEY_STORE = 'voltcoach.dbkey'; // SecureStore 键名（随 2026-09-19 更名用新前缀）
/** 建库 schema 版本（备份包 manifest.schema_version 与导入迁移链共用此口径，M4 导出） */
export const SCHEMA_VERSION = 1;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** 首启随机生成 32 字节 hex 密钥存 Keystore；已有则原样返回（SQLCipher 建库/开库用）。
 *  M4 导出给备份层：无口令导出时该 key 随包写入 manifest（§7.2 口径） */
export async function getDbKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(DB_KEY_STORE);
  if (existing) return existing;
  const key = Crypto.getRandomBytes(32).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  await SecureStore.setItemAsync(DB_KEY_STORE, key);
  return key;
}

/**
 * 懒打开数据库：SQLCipher 密钥就绪后开库（db 落在 expo-sqlite 默认的
 * documentDirectory/SQLite/ 目录，备份导出时从该路径取整库文件）、建表。
 * SQLCipher 由 app.json 插件（expo-sqlite useSQLCipher: true）在原生层启用；
 * 开库后第一条语句必须是 `PRAGMA key`（hex 密钥无引号转义问题）。
 * 建表 SQL 与旧版 db.js 平移一致（列直接建齐，user_version = 1 驱动备份迁移链）。
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const key = await getDbKey();
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(`PRAGMA key = "${key}";`);
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS activities (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_name TEXT NOT NULL UNIQUE,
          date TEXT NOT NULL,
          sport TEXT,
          duration_sec INTEGER,
          distance_km REAL,
          elevation_gain_m REAL,
          tss REAL,
          np REAL,
          avg_power REAL,
          intensity_factor REAL,
          summary_json TEXT NOT NULL,
          category TEXT DEFAULT 'training',
          note TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_activities_date ON activities(date);

        CREATE TABLE IF NOT EXISTS ai_reports (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mode TEXT NOT NULL,
          file_name TEXT,
          race_date TEXT,
          compare_with TEXT,
          prompt TEXT NOT NULL,
          markdown TEXT NOT NULL,
          status TEXT DEFAULT 'completed',
          error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ai_reports_mode_created ON ai_reports(mode, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ai_reports_status ON ai_reports(status);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_chats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mode TEXT NOT NULL,
          report_id INTEGER,
          file_name TEXT,
          title TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ai_chats_mode ON ai_chats(mode, id DESC);

        CREATE TABLE IF NOT EXISTS ai_chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          status TEXT DEFAULT 'completed',
          error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_chat ON ai_chat_messages(chat_id, id);

        CREATE TABLE IF NOT EXISTS ai_memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          content TEXT NOT NULL,
          category TEXT DEFAULT 'general',
          source TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          superseded_by INTEGER
        );

        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      return db;
    })();
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

/**
 * 更新骑手参数（允许只给部分字段）：校验 → 合并当前值写库。
 * 非法值抛 Error（message 按 lang 双语，界面直接透传展示）。
 */
export async function setAthlete(partial: Partial<AthleteParams>, lang: Lang = 'zh'): Promise<AthleteParams> {
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
  const merged = { ...(await getEffectiveAthlete()), ...updates };
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('athlete', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify(merged),
  );
  return merged;
}

// ---------------- 用户背景与训练目标（存 settings 表 profile 行，「我的」设置页维护） ----------------

/** 用户背景与训练目标（identity 一句话身份 / goal 一段话目标） */
export interface RiderProfile {
  identity: string;
  goal: string;
  /** 任一字段非空即视为已配置 */
  configured: boolean;
}

// 各字段长度上限：身份一句话、目标一段话
const PROFILE_LIMITS = { identity: 100, goal: 500 } as const;

/** 当前用户背景与训练目标；未配置时两字段为空字符串（行内容损坏时按未配置返回） */
export async function getProfile(): Promise<RiderProfile> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'profile'`,
  );
  let profile: RiderProfile = { identity: '', goal: '', configured: false };
  if (row) {
    try {
      const p = JSON.parse(row.value);
      profile = {
        identity: typeof p.identity === 'string' ? p.identity : '',
        goal: typeof p.goal === 'string' ? p.goal : '',
        configured: false,
      };
    } catch {
      // 行内容损坏时按未配置返回
    }
  }
  return { ...profile, configured: !!(profile.identity || profile.goal) };
}

/**
 * 更新用户背景与训练目标（允许只给部分字段）：校验 → 合并写库。
 * 两字段都为空时删除 profile 行（视为未配置）。非法值抛 Error（message 按 lang 双语）。
 */
export async function setProfile(
  partial: Partial<{ identity: string; goal: string }>,
  lang: Lang = 'zh',
): Promise<RiderProfile> {
  const current = await getProfile();
  const merged = { identity: current.identity, goal: current.goal };
  for (const key of Object.keys(PROFILE_LIMITS) as (keyof typeof PROFILE_LIMITS)[]) {
    if (partial?.[key] == null) continue;
    if (typeof partial[key] !== 'string')
      throw new Error(t(lang, 'profile.type', { key }));
    const v = (partial[key] as string).trim();
    if (v.length > PROFILE_LIMITS[key])
      throw new Error(t(lang, 'profile.too_long', { key, n: PROFILE_LIMITS[key] }));
    merged[key] = v;
  }
  const db = await getDb();
  if (!merged.identity && !merged.goal) {
    await db.runAsync(`DELETE FROM settings WHERE key = 'profile'`);
  } else {
    await db.runAsync(
      `INSERT INTO settings (key, value) VALUES ('profile', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      JSON.stringify(merged),
    );
  }
  return { ...merged, configured: !!(merged.identity || merged.goal) };
}

// ---------------- 训练记录（M1：导入 / 列表 / 详情） ----------------

/** 分析结果入库：同一文件名重复分析时覆盖更新（口径与旧版一致） */
export async function upsertActivity(fileName: string, summary: Summary): Promise<void> {
  const db = await getDb();
  const a = summary.activity;
  // 无功率数据的运动（跑步/游泳）没有 power 段；类型上以 Partial 放宽（旧版同款运行时口径）
  const p = (summary.power ?? {}) as Partial<NonNullable<Summary['power']>>;
  await db.runAsync(
    `INSERT INTO activities
       (file_name, date, sport, duration_sec, distance_km, elevation_gain_m,
        tss, np, avg_power, intensity_factor, summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(file_name) DO UPDATE SET
       date = excluded.date,
       sport = excluded.sport,
       duration_sec = excluded.duration_sec,
       distance_km = excluded.distance_km,
       elevation_gain_m = excluded.elevation_gain_m,
       tss = excluded.tss,
       np = excluded.np,
       avg_power = excluded.avg_power,
       intensity_factor = excluded.intensity_factor,
       summary_json = excluded.summary_json`,
    fileName,
    a.date,
    a.sport ?? null,
    a.duration_sec ?? null,
    a.distance_km ?? null,
    a.elevation_gain_m ?? null,
    p.tss ?? null,
    p.normalized_power ?? null,
    p.avg ?? null,
    p.intensity_factor ?? null,
    JSON.stringify(summary),
  );
}

/** 训练清单（含文件名/运动类型/分类，界面列表展示，按日期倒序；口径与旧版 listActivities 一致） */
export interface ActivityListItem {
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
}

export async function listActivities(n = 200): Promise<ActivityListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
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
  }>(
    `SELECT file_name, date, sport, category, duration_sec, distance_km, elevation_gain_m,
            tss, np, avg_power, intensity_factor
     FROM activities ORDER BY date DESC LIMIT ?`,
    n,
  );
  const r1 = (x: number | null) => (x == null ? null : Math.round(x * 10) / 10);
  return rows.map((r) => ({
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
    intensity_factor: r.intensity_factor == null ? null : r1(r.intensity_factor),
  }));
}

/** 按文件名取单条训练的完整 summary（详情页用），并把 category 与 note 合并进 activity；不存在返回 null */
export async function getActivitySummary(fileName: string): Promise<Summary | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ summary_json: string; category: string | null; note: string | null }>(
    `SELECT summary_json, category, note FROM activities WHERE file_name = ?`,
    fileName,
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
export async function setActivityCategory(fileName: string, category: string, lang: Lang = 'zh'): Promise<void> {
  if (!isValidCategory(category)) throw new Error(t(lang, 'category.invalid'));
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET category = ? WHERE file_name = ?`,
    category,
    fileName,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
}

// 备注长度上限（自由文本：体感/路况等），防止误贴大段内容撑爆训练库与提示词
const NOTE_MAX_LEN = 2000;

/** 更新训练备注（空串/纯空白清除）；训练不存在抛 Error */
export async function setActivityNote(fileName: string, note: string, lang: Lang = 'zh'): Promise<void> {
  const text = String(note ?? '').trim();
  if (text.length > NOTE_MAX_LEN)
    throw new Error(t(lang, 'note.too_long', { n: NOTE_MAX_LEN }));
  const db = await getDb();
  const info = await db.runAsync(
    `UPDATE activities SET note = ? WHERE file_name = ?`,
    text || null,
    fileName,
  );
  if (info.changes === 0) throw new Error(t(lang, 'activity.not_found'));
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
 * 递推用 core/form 的 formSeriesDaily；序列末端延伸到今天（UTC，无训练日 TSS=0 照常
 * 参与衰减），趋势图与「当前体能指数」反映今天而不是停在最后一次训练的日期。
 * 默认 90 天为仪表盘趋势图口径（Web 版 dashboard 同款）。
 */
export async function recentFormDaily(days = 90): Promise<{ date: string; tss: number; ctl: number; atl: number; tsb: number }[]> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ d: string | null }>(`SELECT MAX(date) AS d FROM activities`);
  if (!row?.d) return [];
  // 活动日期为 UTC 口径（records 时间戳的 ISO 前 10 位），今天同样取 UTC
  const today = new Date().toISOString().slice(0, 10);
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
    file_name: string;
    date: string;
    duration_sec: number | null;
    summary_json: string;
  }>(
    `SELECT file_name, date, duration_sec, summary_json
     FROM activities
     WHERE sport = 'cycling' AND date >= ?
     ORDER BY date DESC`,
    sinceStr,
  );
  const out: CyclingRideInput[] = [];
  for (const r of rows) {
    try {
      out.push({
        file_name: r.file_name,
        date: r.date,
        duration_sec: r.duration_sec,
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
  if (lang !== 'zh' && lang !== 'en') throw new Error('lang 仅支持 zh / en');
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO settings (key, value) VALUES ('lang', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    lang,
  );
  return lang;
}

// ---------------- 顽鹿同步状态（settings 表 sync 键，M4） ----------------
// 账号密码不进库（与 AI Key 同级敏感），存 SecureStore，由服务层管理。

/** 同步配置与最近结果（单 JSON 行；auto 为前台自动同步开关） */
export interface SyncState {
  auto: boolean;
  last_sync_at: string | null;
  last_result: 'ok' | 'error' | null;
  last_error: string | null;
  last_counts: { imported: number; skipped: number; failed: number } | null;
}

export const DEFAULT_SYNC_STATE: SyncState = {
  auto: true,
  last_sync_at: null,
  last_result: null,
  last_error: null,
  last_counts: null,
};

/** 当前同步状态（无行/行损坏回落默认值） */
export async function getSyncState(): Promise<SyncState> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    `SELECT value FROM settings WHERE key = 'sync'`,
  );
  if (!row) return { ...DEFAULT_SYNC_STATE };
  try {
    return { ...DEFAULT_SYNC_STATE, ...(JSON.parse(row.value) as Partial<SyncState>) };
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

// ---------------- AI 报告（ai_reports，M3 自 reference/src/db.js 平移） ----------------

export type AiReportMode = 'review' | 'plan' | 'taper' | 'compare';

/** 报告上下文（场景参数）：review 带文件名、taper 带比赛日期、compare 带对比文件 */
export interface AiReportContext {
  file_name?: string | null;
  race_date?: string | null;
  compare_with?: string | null;
}

/** 报告列表项（不含 prompt/markdown 正文，列表页用） */
export interface AiReportListItem {
  id: number;
  mode: AiReportMode;
  file_name: string | null;
  race_date: string | null;
  compare_with: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

/** 完整报告行（含 prompt + markdown） */
export interface AiReportRow extends AiReportListItem {
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
    `INSERT INTO ai_reports (mode, file_name, race_date, compare_with, prompt, markdown, status)
     VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
    mode,
    context?.file_name ?? null,
    context?.race_date ?? null,
    context?.compare_with ?? null,
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
    `INSERT INTO ai_reports (mode, file_name, race_date, compare_with, prompt, markdown, status)
     VALUES (?, ?, ?, ?, ?, '', 'pending')`,
    mode,
    context?.file_name ?? null,
    context?.race_date ?? null,
    context?.compare_with ?? null,
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
          `SELECT id, mode, file_name, race_date, compare_with, status, error, created_at
           FROM ai_reports ORDER BY id DESC LIMIT ?`,
          n,
        )
      : await db.getAllAsync<AiReportListItem & { prompt: string; markdown: string }>(
          `SELECT id, mode, file_name, race_date, compare_with, status, error, created_at
           FROM ai_reports WHERE mode = ? ORDER BY id DESC LIMIT ?`,
          mode,
          n,
        );
  return rows.map((r) => ({
    id: r.id,
    mode: r.mode,
    file_name: r.file_name,
    race_date: r.race_date,
    compare_with: r.compare_with,
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
  if (!row) return null;
  return {
    id: row.id,
    mode: row.mode,
    file_name: row.file_name,
    race_date: row.race_date,
    compare_with: row.compare_with,
    prompt: row.prompt,
    markdown: row.markdown,
    status: row.status,
    error: row.error,
    created_at: row.created_at,
  };
}

// ---------------- AI 对话（ai_chats / ai_chat_messages，追问与直接对话统一，M3） ----------------

export type AiChatMode = 'follow_up' | 'chat';

// 每个 mode 滚动保留的对话数上限（沿用 ai_reports 的 id DESC LIMIT 清理模式）
const AI_CHAT_KEEP = 50;

/** 对话列表项（附消息条数与 pending 标记，供列表态显示"生成中"，不含正文） */
export interface AiChatListItem {
  id: number;
  mode: AiChatMode;
  report_id: number | null;
  file_name: string | null;
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
 * 创建 AI 对话（mode: follow_up 报告追问 / chat 直接对话），返回 id。
 * 每个 mode 仅保留最近 50 个对话，超出的旧对话连同其全部消息一起删除（级联）。
 */
export async function createAiChat(
  mode: AiChatMode,
  meta: { report_id?: number | null; file_name?: string | null; title?: string | null } = {},
): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(
    `INSERT INTO ai_chats (mode, report_id, file_name, title) VALUES (?, ?, ?, ?)`,
    mode,
    meta.report_id ?? null,
    meta.file_name ?? null,
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

/** 有新消息时刷新对话的 updated_at（列表按它倒序，最近活跃的对话排前） */
export async function touchAiChat(chatId: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE ai_chats SET updated_at = datetime('now') WHERE id = ?`, chatId);
}

/** 某 mode 的对话列表（按 updated_at 倒序，附消息条数与 pending 标记，不含正文） */
export async function listAiChats(mode: AiChatMode, n = AI_CHAT_KEEP): Promise<AiChatListItem[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{
    id: number;
    mode: AiChatMode;
    report_id: number | null;
    file_name: string | null;
    title: string | null;
    message_count: number;
    has_pending: number;
    created_at: string;
    updated_at: string;
  }>(
    `SELECT c.id, c.mode, c.report_id, c.file_name, c.title, c.created_at, c.updated_at,
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
    file_name: r.file_name,
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
    file_name: string | null;
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
    file_name: row.file_name,
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

/** 删除整个对话及其全部消息，返回删除的对话数（0 = 不存在） */
export async function deleteAiChat(id: number): Promise<number> {
  const db = await getDb();
  await db.runAsync(`DELETE FROM ai_chat_messages WHERE chat_id = ?`, id);
  const info = await db.runAsync(`DELETE FROM ai_chats WHERE id = ?`, id);
  return info.changes;
}

// ---------------- AI 记忆（ai_memories，带时间戳与取代链，M3） ----------------

// 记忆分类白名单（非法值归入 general）
const MEMORY_CATEGORIES = new Set(['general', 'injury', 'schedule', 'goal', 'preference']);
// 单条记忆长度上限（AI 用中文概括的完整陈述）
const MEMORY_MAX_LEN = 500;
// 库中最多保留条数：超出先删最旧的已被取代记忆，不足再删最旧有效记忆
const MEMORY_KEEP = 100;

/** 记忆行（listAll 附 active 有效标记） */
export interface AiMemoryRow {
  id: number;
  content: string;
  category: string;
  source: string | null;
  created_at: string;
  superseded_by: number | null;
  active?: boolean;
}

/**
 * 保存一条 AI 记忆（用户个人事实：伤病/日程约束/目标变化/明确偏好等），返回 id。
 * content 必填且 ≤500 字；category 非法归 general；supersedes_id 存在时校验目标
 * 记忆存在，并把其 superseded_by 置为新 id（被取代的记忆不再注入但保留可追溯）。
 * 非法输入抛 Error（双语 message，工具层转为 {error} JSON 反馈给 AI）。
 */
export async function saveMemory(
  input: {
    content?: unknown;
    category?: unknown;
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
    `INSERT INTO ai_memories (content, category, source) VALUES (?, ?, ?)`,
    text,
    cat,
    input?.source ?? null,
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

/** 最近 n 条有效记忆（未被取代，注入提示词用；id DESC，拼装时反转为时间正序） */
export async function listMemories(n = 30): Promise<AiMemoryRow[]> {
  const db = await getDb();
  return db.getAllAsync<AiMemoryRow>(
    `SELECT id, content, category, source, created_at
     FROM ai_memories WHERE superseded_by IS NULL
     ORDER BY id DESC LIMIT ?`,
    n,
  );
}

/** 全部记忆（含已被取代的，管理界面用；id DESC，附 active 有效标记） */
export async function listAllMemories(): Promise<AiMemoryRow[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<AiMemoryRow>(
    `SELECT id, content, category, source, created_at, superseded_by
     FROM ai_memories ORDER BY id DESC`,
  );
  return rows.map((r) => ({ ...r, active: r.superseded_by == null }));
}

/** 删除指定记忆，返回删除条数（0 = 不存在） */
export async function deleteMemory(id: number): Promise<number> {
  const db = await getDb();
  const info = await db.runAsync(`DELETE FROM ai_memories WHERE id = ?`, id);
  return info.changes;
}
