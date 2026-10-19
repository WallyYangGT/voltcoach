/**
 * migrate.ts — 开库 schema 就位逻辑（纯端口，无 Expo 依赖，node:test 可直测）
 *
 * migrateSchema 只依赖 exec/getFirst/getAll 三个异步方法；expo-sqlite 与 node:sqlite
 * 适配器都能注入。拆出本模块的动机：v3 之前这里在存量库上先跑最新建表脚本，v3 索引
 * 会引用尚未创建的列（no such column），必须能被真实 SQL 回归测试钉住。
 */

import { runMigrations, SCHEMA_VERSION, type MigrationDbPort } from './migrations.ts';
import { CREATE_SCHEMA_SQL, CREATE_V2_COMPAT_SQL } from './schema.ts';

/** activities 是否已是 v3 形状（uuid 列存在）——用于建库中途崩溃的残留判定 */
export async function hasUuidColumn(db: MigrationDbPort): Promise<boolean> {
  const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(activities);');
  return cols.some((c) => c.name === 'uuid');
}

/**
 * 读 user_version 分支——
 *  - 已是最新：无事可做（每次开库的最常见路径）；
 *  - 0 且无表：全新库，整体建表（v3 脚本，末尾盖版本戳）；
 *  - 0 但 activities 已存在：建库脚本中途崩溃的残留。已是 v3 形状（uuid 列在）
 *    直接盖戳；否则先按 v2 形状补齐缺失空表（不能跑 v3 建表脚本——v3 索引会引用
 *    尚未创建的列），再走 v1→2→3 迁移；
 *  - 0 < v < 最新：直接按 ./migrations 步进迁移后盖戳（存量库不跑建表脚本）。
 * v2 的 ALTER 无幂等声明，「duplicate column」按已就位容错跳过；v3 重建在事务内
 * 执行，失败自动回滚（重入从 user_version 重来）。
 */
export async function migrateSchema(db: MigrationDbPort): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  if (current === SCHEMA_VERSION) return;
  const stamp = () => db.execAsync(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  let from = current;
  if (current === 0) {
    const hasTables = await db.getFirstAsync<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activities'`,
    );
    if (!hasTables) {
      await db.execAsync(CREATE_SCHEMA_SQL);
      await stamp();
      return;
    }
    // 建库脚本中途崩溃的残留：结构已是 v3 → 补齐可能缺失的表后直接盖戳
    if (await hasUuidColumn(db)) {
      await db.execAsync(CREATE_SCHEMA_SQL);
      await stamp();
      return;
    }
    // v1 残留：按 v2 形状补建缺失空表（IF NOT EXISTS），再走 v1→2→3
    await db.execAsync(CREATE_V2_COMPAT_SQL);
    from = 1;
  }
  await runMigrations(db, from, SCHEMA_VERSION);
  // 版本戳只在全部步骤成功后写：半途失败重入时靠 duplicate column / v3 事务回滚续跑
  await stamp();
}
