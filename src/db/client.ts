/**
 * client.ts — 训练库连接生命周期（expo-sqlite + SQLCipher 加密）
 *
 * 懒打开单例 + 密钥管理。SQLCipher 已拍板启用：db key 首次随机生成（expo-crypto）
 * 存 expo-secure-store（Android Keystore），密钥不落盘；开库后第一条语句必须是
 * `PRAGMA key`。从零建库按最新 schema 整体创建（src/db/schema.ts），存量库由
 * src/db/migrate.ts 按 PRAGMA user_version 走编号迁移链。
 *
 * 各业务域的读写实现按域拆分在同级文件（athlete/activities/reports/chats/…），
 * 都经本模块的 getDb() 取连接；'@/db' 的公共出口由 index.ts barrel 聚合。
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import { SCHEMA_VERSION } from './migrations';
import { migrateSchema } from './migrate';
import { ensureRecordFileLayout } from '@/records-store';

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
