/**
 * sqlite.ts — 备份层与训练库文件交互的共享辅助（导出/导入两侧共用）
 *
 * 路径口径：expo-sqlite 的 openDatabaseAsync 只认 documentDirectory/SQLite/ 下的
 * 库名（src/db/index.ts 注释已声明），因此备份的临时库（sqlcipher_export 产物、
 * 导入 staged 库）也必须落在同一目录。
 */

import { Directory, File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getDb } from '@/db';
import { BackupError } from './manifest.ts';

/** 库文件名（与 src/db DB_NAME 同口径；.fitbackup 包内条目名也用它） */
export const APP_DB_NAME = 'fitness.db';

/** expo-sqlite 默认库目录：<documentDirectory>/SQLite/ */
export function sqliteDir(): Directory {
  return new Directory(Paths.document, 'SQLite');
}

/** 训练库文件（整库导出/导入替换的对象） */
export function appDbFile(): File {
  return new File(sqliteDir(), APP_DB_NAME);
}

/** file:// URI → SQLite 可用的纯路径（ATTACH 只认文件系统路径，不认 scheme） */
export function fileUriToPath(file: File): string {
  return file.uri.replace(/^file:\/\//, '');
}

/** SQL 字符串字面量（单引号翻倍转义，PRAGMA key / ATTACH KEY / 路径共用） */
export function sqlStr(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * 当前原生层是否带 SQLCipher：useSQLCipher 插件仅在安卓生效，iOS 默认构建是
 * 明文 SQLite——PRAGMA cipher_version 在 SQLCipher 下返回版本行，否则无行。
 * 备份导出/导入按此分支（无 SQLCipher 时包内库恒为明文，db_key 必为 null）。
 */
export async function hasSqlCipher(db?: SQLiteDatabase): Promise<boolean> {
  const conn = db ?? (await getDb());
  const row = await conn.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version;');
  return Boolean(row?.cipher_version);
}

/**
 * 产出「包内 fitness.db」字节：SQLCipher 构建下用包密钥（用户口令或本机 key）
 * sqlcipher_export 重加密到临时库后读取；无 SQLCipher 时库本就明文，直拷文件。
 * 注意 sqlcipher_export 不复制 user_version，需手工对齐（导入端版本闸门依赖）。
 */
export async function buildPackageDbBytes(pkgKey: string | null): Promise<Uint8Array> {
  const db = await getDb();
  if (!(await hasSqlCipher(db))) {
    return appDbFile().bytes();
  }
  if (!pkgKey) throw new BackupError('no_sqlcipher', '加密构建缺少包密钥');

  // 临时库名带时间戳：连续导入/快照并发时防同名冲突
  const tmp = new File(sqliteDir(), `voltcoach-export-${Date.now()}.db`);
  try {
    try {
      await db.execAsync(
        `ATTACH DATABASE ${sqlStr(fileUriToPath(tmp))} AS backup_export KEY ${sqlStr(pkgKey)};`,
      );
      await db.execAsync(`SELECT sqlcipher_export('backup_export');`);
      const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
      await db.execAsync(`PRAGMA backup_export.user_version = ${row?.user_version ?? 0};`);
    } finally {
      await db.execAsync('DETACH DATABASE backup_export;');
    }
    return await tmp.bytes();
  } finally {
    if (tmp.exists) tmp.delete();
  }
}
