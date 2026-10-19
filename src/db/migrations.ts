/**
 * migrations.ts — 训练库 schema 编号步进迁移（无 Expo 依赖，node:test 可直测）
 *
 * v1 时代 schema 一次建齐、无迁移机制；v2 起引入编号步进迁移：开库读
 * PRAGMA user_version，低于 SCHEMA_VERSION 时按本表逐步执行并盖戳。
 * SCHEMA_VERSION 自本文件单源导出（db/index.ts re-export；备份包 manifest 与
 * 导入闸门沿用同一口径）。
 *
 * 步骤模型（v3 起）：
 *  - `sql`：可独立执行的幂等友好语句（加列/建索引），重复列由执行侧容错跳过；
 *  - `rebuild-v3`：表重建类迁移（去 file_name UNIQUE、加 uuid/外键），必须整体
 *    放在一个事务里——SQLite 的 DDL 是事务性的，中断自动回滚，重入时从
 *    user_version 重新开始，不会留下半新半旧的表。
 *
 * 方向校验：库版本高于代码版本属于「备份闸门」的职责（导入时拦截），此处双重
 * 防御直接抛错，不做任何回退写操作。
 */

/** 训练库 schema 版本（备份包 manifest.schema_version 与导入迁移链共用此口径） */
export const SCHEMA_VERSION = 3;

/** runMigrations 需要的最小 db 端口（expo-sqlite / node:sqlite 均可适配） */
export interface MigrationDbPort {
  execAsync(sql: string): Promise<void>;
  getFirstAsync<T>(sql: string): Promise<T | null>;
  getAllAsync<T>(sql: string): Promise<T[]>;
}

export type MigrationStep =
  | { kind: 'sql'; sql: string }
  | { kind: 'rebuild-v3' };

/** v3 表重建：活动 uuid 身份、file_name 去唯一、AI 引用改外键 + 指纹列 */
const REBUILD_V3_SQL = `
  CREATE TABLE activities_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    file_name TEXT NOT NULL,
    source TEXT,
    fingerprint TEXT NOT NULL DEFAULT '',
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
    power_flagged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO activities_v3 (
    id, uuid, file_name, source, fingerprint, date, sport, duration_sec, distance_km,
    elevation_gain_m, tss, np, avg_power, intensity_factor, summary_json, category, note,
    power_flagged, created_at
  )
  SELECT
    id,
    lower(hex(randomblob(16))),
    file_name,
    NULL,
    date || '|' || COALESCE(duration_sec, '') || '|' ||
      CASE WHEN distance_km IS NOT NULL AND distance_km > 0
           THEN CAST(CAST(round(distance_km * 1000) AS INTEGER) AS TEXT)
           ELSE '' END,
    date, sport, duration_sec, distance_km, elevation_gain_m, tss, np, avg_power,
    intensity_factor, summary_json, category, note, power_flagged, created_at
  FROM activities;
  DROP TABLE activities;
  ALTER TABLE activities_v3 RENAME TO activities;
  CREATE INDEX idx_activities_date ON activities(date);
  CREATE INDEX idx_activities_file_name ON activities(file_name);
  CREATE INDEX idx_activities_fingerprint ON activities(fingerprint);

  CREATE TABLE ai_reports_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    activity_uuid TEXT REFERENCES activities(uuid) ON DELETE SET NULL,
    race_date TEXT,
    compare_uuid TEXT REFERENCES activities(uuid) ON DELETE SET NULL,
    activity_fingerprint TEXT,
    compare_fingerprint TEXT,
    prompt TEXT NOT NULL,
    markdown TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO ai_reports_v3 (
    id, mode, activity_uuid, race_date, compare_uuid, activity_fingerprint,
    compare_fingerprint, prompt, markdown, status, error, created_at
  )
  SELECT
    r.id,
    r.mode,
    (SELECT a.uuid FROM activities a WHERE a.file_name = r.file_name ORDER BY a.id LIMIT 1),
    r.race_date,
    (SELECT a.uuid FROM activities a WHERE a.file_name = r.compare_with ORDER BY a.id LIMIT 1),
    (SELECT a.fingerprint FROM activities a WHERE a.file_name = r.file_name ORDER BY a.id LIMIT 1),
    (SELECT a.fingerprint FROM activities a WHERE a.file_name = r.compare_with ORDER BY a.id LIMIT 1),
    r.prompt, r.markdown, r.status, r.error, r.created_at
  FROM ai_reports r;
  DROP TABLE ai_reports;
  ALTER TABLE ai_reports_v3 RENAME TO ai_reports;
  CREATE INDEX idx_ai_reports_mode_activity ON ai_reports(mode, activity_uuid, id DESC);
  CREATE INDEX idx_ai_reports_compare ON ai_reports(compare_uuid);
  CREATE INDEX idx_ai_reports_activity_fp ON ai_reports(activity_fingerprint);
  CREATE INDEX idx_ai_reports_status ON ai_reports(status);

  CREATE TABLE ai_chats_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    report_id INTEGER REFERENCES ai_reports(id) ON DELETE SET NULL,
    activity_uuid TEXT REFERENCES activities(uuid) ON DELETE SET NULL,
    activity_fingerprint TEXT,
    title TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO ai_chats_v3 (
    id, mode, report_id, activity_uuid, activity_fingerprint, title, created_at, updated_at
  )
  SELECT
    c.id,
    c.mode,
    CASE WHEN EXISTS(SELECT 1 FROM ai_reports r WHERE r.id = c.report_id) THEN c.report_id ELSE NULL END,
    (SELECT a.uuid FROM activities a WHERE a.file_name = c.file_name ORDER BY a.id LIMIT 1),
    (SELECT a.fingerprint FROM activities a WHERE a.file_name = c.file_name ORDER BY a.id LIMIT 1),
    c.title, c.created_at, c.updated_at
  FROM ai_chats c;

  CREATE TABLE ai_chat_messages_v3 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO ai_chat_messages_v3 (id, chat_id, role, content, status, error, created_at)
  SELECT m.id, m.chat_id, m.role, m.content, m.status, m.error, m.created_at
  FROM ai_chat_messages m
  WHERE m.chat_id IN (SELECT id FROM ai_chats);

  DROP TABLE ai_chat_messages;
  DROP TABLE ai_chats;
  ALTER TABLE ai_chats_v3 RENAME TO ai_chats;
  ALTER TABLE ai_chat_messages_v3 RENAME TO ai_chat_messages;
  CREATE INDEX idx_ai_chats_mode ON ai_chats(mode, id DESC);
  CREATE INDEX idx_ai_chats_report ON ai_chats(report_id);
  CREATE INDEX idx_ai_chats_activity ON ai_chats(activity_uuid);
  CREATE INDEX idx_ai_chat_messages_chat ON ai_chat_messages(chat_id, id);
`;

/** 各版本的步进迁移（key = 起始版本；执行完 key 的步骤后库即 key+1 版） */
const MIGRATIONS: Record<number, MigrationStep[]> = {
  // v1 → 2：AI 记忆分层（scope，存量行默认长期）+ 功率可信度标记（power_flagged）
  1: [
    { kind: 'sql', sql: `ALTER TABLE ai_memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'long';` },
    { kind: 'sql', sql: `ALTER TABLE activities ADD COLUMN power_flagged INTEGER NOT NULL DEFAULT 0;` },
  ],
  // v2 → 3：实体 uuid 化 + 外键 + 指纹（表重建，事务执行）
  2: [{ kind: 'rebuild-v3' }],
};

/**
 * 计算 from → to 的迁移步骤序列。合法域：1 ≤ from ≤ to ≤ SCHEMA_VERSION；
 * from === to 返回空表（已是最新）。越界/方向非法一律抛 Error。
 */
export function migrationsFor(from: number, to: number): MigrationStep[] {
  if (!Number.isInteger(from) || !Number.isInteger(to))
    throw new Error(`迁移版本须为整数: v${from} -> v${to}`);
  if (from < 1)
    throw new Error(`v${from} 无表结构，应由建库脚本整体创建而非迁移`);
  if (from > to)
    throw new Error(`迁移方向不可逆: v${from} -> v${to}（库新于代码应被备份闸门拦截）`);
  if (to > SCHEMA_VERSION)
    throw new Error(`目标版本 v${to} 超出代码支持的 v${SCHEMA_VERSION}`);
  const steps: MigrationStep[] = [];
  for (let v = from; v < to; v += 1) {
    const part = MIGRATIONS[v];
    // 步骤表条目必须显式存在（无步骤的版本写 []）：bump SCHEMA_VERSION 忘写步骤时
    // 在此硬失败，而不是静默空迁移后盖新版本戳把库永久标错（code-review P2-2）
    if (part === undefined)
      throw new Error(`v${v} 的迁移步骤缺失：升级 SCHEMA_VERSION 必须同步补步骤表（无变更的版本显式写 []）`);
    steps.push(...part);
  }
  return steps;
}

/**
 * 执行 v2 → v3 表重建（一个事务内完成；失败回滚，重入从 user_version 重来）。
 * PRAGMA foreign_keys 必须在事务外关闭——事务内设置不生效。
 */
async function rebuildV3(db: MigrationDbPort): Promise<void> {
  await db.execAsync('PRAGMA foreign_keys = OFF;');
  try {
    // 目标版本固定写 3（不是 SCHEMA_VERSION）：未来 v4 由后续步骤盖戳；写成
    // SCHEMA_VERSION 会让 v3 重建把库提前标成最新版本、静默跳过 v4 迁移
    await db.execAsync(`BEGIN;\n${REBUILD_V3_SQL}\nPRAGMA user_version = 3;\nCOMMIT;`);
  } catch (e) {
    try {
      await db.execAsync('ROLLBACK;');
    } catch {
      // BEGIN 都未成功时 ROLLBACK 会报 “no transaction is active”，忽略即可
    }
    throw e;
  }
  const violations = await db.getAllAsync<Record<string, unknown>>('PRAGMA foreign_key_check;');
  if (violations.length)
    console.warn(`schema v3 外键校验发现 ${violations.length} 条异常引用（迁移已提交，保留观察）:`, violations);
  await db.execAsync('PRAGMA foreign_keys = ON;');
}

/**
 * 按步骤表执行 from → to 迁移。调用方负责在成功后写 user_version（本函数对
 * v3 步骤在事务内已写，外层重复盖戳无害）；`sql` 步骤的 duplicate column 容错
 * 与服务 v2 的崩溃残留自愈口径一致。
 */
export async function runMigrations(db: MigrationDbPort, from: number, to = SCHEMA_VERSION): Promise<void> {
  const steps = migrationsFor(from, to);
  for (const step of steps) {
    if (step.kind === 'sql') {
      try {
        await db.execAsync(step.sql);
      } catch (e) {
        if (!/duplicate column/i.test(String(e))) throw e;
      }
    } else {
      await rebuildV3(db);
    }
  }
}
