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
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type { Summary } from '@/core/analyze';
import { fillDailyTss, formSeriesDaily, formSnapshotAtEnd } from '@/core/form';
import type { CyclingRideInput } from '@/core/ftp';
import { t, type Lang } from '@/core/i18n';
import { monthlySummaryFromRows, type MonthlyItem, type MonthlyRow } from '@/core/monthly';
import { ATHLETE, FTP_ESTIMATION, type AthleteParams } from '@/core/settings';

const DB_NAME = 'fitness.db';
const DB_KEY_STORE = 'voltcoach.dbkey'; // SecureStore 键名（随 2026-09-19 更名用新前缀）
const SCHEMA_VERSION = 1;

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/** 首启随机生成 32 字节 hex 密钥存 Keystore；已有则原样返回（SQLCipher 建库/开库用） */
async function ensureDbKey(): Promise<string> {
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
      const key = await ensureDbKey();
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
