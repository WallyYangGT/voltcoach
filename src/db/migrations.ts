/**
 * migrations.ts — 训练库 schema 迁移步骤表（纯函数层，无 IO、无 Expo 依赖）
 *
 * v1 时代 schema 一次建齐、无迁移机制；v2 起引入编号步进迁移：getDb() 读
 * PRAGMA user_version，低于 SCHEMA_VERSION 时按本表逐步执行 ALTER 并盖戳。
 * SCHEMA_VERSION 自本文件单源导出（db/index.ts re-export；备份包 manifest 与
 * 导入闸门沿用同一口径）。
 *
 * 约定：
 *  - 每个版本的迁移只允许「加列/建索引」类幂等友好操作；v2 起新库直接按最新
 *    schema 整体创建（建表脚本内联最新列），本表只服务存量库升级；
 *  - 重复列（v2 建库脚本中途崩溃后残留半新表）由执行侧捕获 duplicate column
 *    容错跳过——ALTER 本身无法幂等声明；
 *  - 方向校验：库版本高于代码版本属于「备份闸门」的职责（导入时拦截），此处
 *    双重防御直接抛错，不做任何回退写操作。
 */

/** 训练库 schema 版本（备份包 manifest.schema_version 与导入迁移链共用此口径） */
export const SCHEMA_VERSION = 2;

/** 各版本的步进迁移（key = 起始版本；执行完 key 的步骤后库即 key+1 版） */
const MIGRATIONS: Record<number, string[]> = {
  // v1 → 2：AI 记忆分层（scope，存量行默认长期）+ 功率可信度标记（power_flagged）
  1: [
    `ALTER TABLE ai_memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'long';`,
    `ALTER TABLE activities ADD COLUMN power_flagged INTEGER NOT NULL DEFAULT 0;`,
  ],
};

/**
 * 计算 from → to 的迁移语句序列。合法域：1 ≤ from ≤ to ≤ SCHEMA_VERSION；
 * from === to 返回空表（已是最新）。越界/方向非法一律抛 Error。
 */
export function migrationsFor(from: number, to: number): string[] {
  if (!Number.isInteger(from) || !Number.isInteger(to))
    throw new Error(`迁移版本须为整数: v${from} -> v${to}`);
  if (from < 1)
    throw new Error(`v${from} 无表结构，应由建库脚本整体创建而非迁移`);
  if (from > to)
    throw new Error(`迁移方向不可逆: v${from} -> v${to}（库新于代码应被备份闸门拦截）`);
  if (to > SCHEMA_VERSION)
    throw new Error(`目标版本 v${to} 超出代码支持的 v${SCHEMA_VERSION}`);
  const steps: string[] = [];
  for (let v = from; v < to; v += 1) steps.push(...(MIGRATIONS[v] ?? []));
  return steps;
}
