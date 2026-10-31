/**
 * import.ts — .fitbackup 备份导入（格式规范见 docs/BACKUP_FORMAT.md）
 *
 * 覆盖式导入 + 防误清（口径）：选包 → 解包校验 manifest → schema 版本闸门
 * （高于本机拒绝并提示升级 App）→ staged 库开包验证（试读，错 key/错口令在此拦下，
 * 原库无损）→ 覆盖前自动导出安全备份（document/backups/pre-import-*.fitbackup，
 * 滚动保留 3 份）→ 关库 → 原子替换（删旧 fitness.db(+wal/shm) → 重加密产物改名）
 * → records 目录清空重写 → 单例复位（各页 useFocusEffect 聚焦自刷新）。
 *
 * 替换发生之前的任何失败都只清理临时文件，原库与 records 不受影响；替换发生之后
 * 仅剩 records 写盘可能部分失败——库已换新，缺的记录文件按既有降级口径显示空图表。
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import { closeDb, countActivities, getDbKey, SCHEMA_VERSION } from '@/db';
import { invalidateAllDb } from '@/db/notify';
import { runMigrations } from '@/db/migrations';
import { CREATE_V2_COMPAT_SQL } from '@/db/schema';
import { recordBaseFromFileName } from '@/core/records';
import { clearStoredRecords, writeStoredRecordGz } from '@/records-store';
import { unpackBackup } from './archive';
import { BackupError, checkSchemaVersion, checkStagedDbVersion, type BackupManifest } from './manifest';
import { buildBackup } from './export';
import { appDbFile, fileUriToPath, hasSqlCipher, sqliteDir, sqlStr } from './sqlite.ts';

/** 导入结果（UI 成功提示展示数量口径：库内活动数 + 恢复的记录文件数） */
export interface ImportOutcome {
  activities: number;
  records: number;
}

/** 覆盖前自动安全备份的滚动保留份数 */
const PRE_IMPORT_KEEP = 3;

/**
 * 导入 .fitbackup 备份包（uri 来自 DocumentPicker，file:// 缓存路径）。
 * passphrase：用户输入的备份口令（包由口令加密时必填）；manifest 自带 db_key 的
 * 包传 null 即可。成功返回库内活动数与恢复的记录文件数。
 */
export async function importBackupFile(uri: string, passphrase: string | null): Promise<ImportOutcome> {
  const bytes = await new File(uri).bytes();

  // ① 解包 + 校验（结构/清单/版本闸门——任何一步不过即原库无损返回）
  const { manifest, db: dbBytes, records } = unpackBackup(bytes);
  checkSchemaVersion(manifest, SCHEMA_VERSION);

  const dir = sqliteDir();
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

  // ② staged 库开包验证：写临时文件 → 按包密钥策略打开试读。
  //    密钥顺序：用户口令 > manifest.db_key > 无 key 明文打开（旧 repo --export /
  //    iOS 导出）。验证失败映射稳定码——有 key 视为口令错误，无 key 视为需要口令。
  //    非 SQLCipher 构建（iOS）带不动加密库：db_key != null 的包在此前置拒绝。
  if (!(await hasSqlCipher()) && manifest.db_key !== null) {
    throw new BackupError('no_sqlcipher', '当前构建无 SQLCipher，无法导入加密备份');
  }
  const staged = new File(dir, `voltcoach-import-staged-${Date.now()}.db`);
  let conn: SQLite.SQLiteDatabase | null = null;
  try {
    staged.write(dbBytes);
    conn = await openStagedVerified(staged, manifest, passphrase);
  } catch (e) {
    cleanup(staged);
    throw e;
  }

  // ③ 覆盖前安全备份（防误导入清库；失败即中止导入，不带病替换）
  try {
    await createPreImportBackup();
  } catch (e) {
    await closeQuietly(conn);
    cleanup(staged);
    throw new BackupError('safety_backup_failed', String(e));
  }

  // ④ 重加密到本机 key（staged → import_new），⑤ 关库原子替换，⑥ records 重写
  // ⚠️ File.move() 会原地改写实例 uri（expo-file-system 契约：实例指向改名后的
  // fitness.db），因此清理必须「名字落字符串 + finally 新造 File」：cleanup 操作的
  // 实例永远指向原临时名（move 成功时该路径已不存在 → no-op）；绝不能用传给 move()
  // 的实例做清理——那是把刚换上的新库当临时文件删掉（数据销毁且当次会话不可见）。
  const importedTmpName = `voltcoach-import-new-${Date.now()}.db`;
  const importedTmp = new File(dir, importedTmpName);
  // staged 库已完成迁移：读活动身份映射，records 恢复时把 v2 的旧基名折算成 uuid
  // （旧基名可能被多条活动共享，逐条写入；未知基名原样保留，导出时会按 uuid 过滤）
  const stagedActivities = await conn.getAllAsync<{ uuid: string; file_name: string }>(
    'SELECT uuid, file_name FROM activities;',
  );
  const activityUuids = new Set(stagedActivities.map((a) => a.uuid));
  const uuidByOldBase = new Map<string, string[]>();
  for (const a of stagedActivities) {
    const oldBase = recordBaseFromFileName(a.file_name);
    if (!oldBase) continue;
    const bucket = uuidByOldBase.get(oldBase);
    if (bucket) bucket.push(a.uuid);
    else uuidByOldBase.set(oldBase, [a.uuid]);
  }
  try {
    if (await hasSqlCipher(conn)) {
      const localKey = await getDbKey();
      try {
        await conn.execAsync(
          `ATTACH DATABASE ${sqlStr(fileUriToPath(importedTmp))} AS import_new KEY ${sqlStr(localKey)};`,
        );
        await conn.execAsync(`SELECT sqlcipher_export('import_new');`);
        const uv = await conn.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
        await conn.execAsync(`PRAGMA import_new.user_version = ${uv?.user_version ?? 0};`);
      } finally {
        await conn.execAsync('DETACH DATABASE import_new;');
      }
    } else {
      // 无 SQLCipher 构建（iOS）：必须用**已迁移**的 staged 文件做替换产物。
      // 包内原始 dbBytes 是迁移前旧库；直接写回会让下一次开库再生成一批新 uuid，
      // 与上面按 staged 映射恢复的 records 全部错位（code-review P1-2）。
      // 显式关闭（失败即中止）：close 负责 checkpoint WAL，悄悄失败会复制到旧数据。
      try {
        await conn.closeAsync();
      } catch (e) {
        throw new BackupError('migration_failed', `staged 库关闭失败: ${String(e)}`);
      }
      conn = null;
      importedTmp.write(await staged.bytes());
    }
    await closeQuietly(conn);
    conn = null;
    if (!importedTmp.exists) throw new BackupError('missing_db', '重加密产物未生成，中止替换');

    // 关库后清 WAL 残留 → 产物改名就位（overwrite 直换，消除"删旧未换新"的进程被杀窗口）
    await closeDb();
    removeWalSiblings();
    await importedTmp.move(appDbFile(), { overwrite: true });
    // 换库窗口内可能有并发读（事件驱动的页面重取、AI 生成的进度写）经 getDb() 又开了
    // **旧文件**并把句柄缓存进单例——旧文件此时已被覆盖，句柄指向失效 inode，后续读全部
    // 停在旧数据直到重启。再关一次（幂等）把这种偷开的句柄丢弃，让下一次读重开新库。
    await closeDb();

    clearStoredRecords();
    let restored = 0;
    const written = new Set<string>();
    for (const rec of records) {
      // v3 包直接是 uuid 基名；v2 包是 file_name 去扩展名 → 折算到 uuid（可多条）
      const targets = activityUuids.has(rec.base)
        ? [rec.base]
        : (uuidByOldBase.get(rec.base) ?? [rec.base]);
      for (const base of targets) {
        if (written.has(base)) continue;
        try {
          await writeStoredRecordGz(base, rec.gz);
          written.add(base);
          restored += 1;
        } catch (e) {
          console.warn(`records 恢复失败（详情页图表将无数据）: ${base}:`, e);
        }
      }
    }
    return finish(restored);
  } finally {
    await closeQuietly(conn);
    cleanup(staged);
    cleanup(new File(dir, importedTmpName)); // 新实例恒指原临时名：成功路径 no-op，失败路径清真临时文件
  }
}

/**
 * 收尾：统计新库活动数 → 全域失效 → 返回。
 *
 * 整库替换后**所有**域的数据都变了（含 records 已写完这一前提——详情页图表
 * 读到的是新库对应的逐秒数据）。此前的口径是「单例复位 + 各页 useFocusEffect
 * 聚焦自刷新」，但导入完成后用户可能正停在首页/列表上（备份导入入口在数据页，
 * 返回栈里其它 tab 仍挂载），focus 不会触发 → 停在旧数据。失效事件补上这条路径。
 */
async function finish(restored: number): Promise<ImportOutcome> {
  const activities = await countActivities();
  invalidateAllDb();
  return { activities, records: restored };
}

/**
 * 按包密钥策略打开 staged 库、试读验证，并在**替换本机库之前**完成 schema 迁移。
 * SQLCipher 构建下开加密库必须先 PRAGMA key；明文库不能带 key（会被当错误密钥）。
 * 验证读 sqlite_master + activities 表在位——结构不符说明不是本应用的备份。
 *
 * v3 起迁移前移（2026-10-19）：v1/v2 包在 staged 库上跑完迁移链，失败按
 * migration_failed 中止，原库与 records 完全未动；成功后再替换，避免“替换后
 * 迁移失败”把用户库置于不可用状态。
 */
async function openStagedVerified(
  staged: File,
  manifest: BackupManifest,
  passphrase: string | null,
): Promise<SQLite.SQLiteDatabase> {
  const key = passphrase ?? manifest.db_key; // null = 明文打开（口令加密包走 passphrase_required 提示）
  const conn = await SQLite.openDatabaseAsync(staged.name);
  const fail = (e: unknown): never => {
    const keyed = Boolean(key);
    throw new BackupError(keyed ? 'wrong_key' : 'passphrase_required', String(e));
  };
  try {
    if (key) await conn.execAsync(`PRAGMA key = ${sqlStr(key)};`);
    const table = await conn.getFirstAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'activities';",
    );
    if (!table) throw new BackupError('bad_manifest', '库内无 activities 表，不像本应用的备份');

    // schema 迁移在 staged 库上先行（替换前失败 = 原库无损）
    const uv = await conn.getFirstAsync<{ user_version: number }>('PRAGMA user_version;');
    const dbVersion = uv?.user_version ?? 0;
    // manifest 只是声明：库内版本更高（篡改/损包）必须在替换前拒绝
    checkStagedDbVersion(manifest.schema_version, dbVersion, SCHEMA_VERSION);
    let from = dbVersion;
    if (from < SCHEMA_VERSION) {
      if (from === 0) {
        // v1/v3 建库中途崩溃的残留：uuid 列已在说明结构至少是 v3——从 3 起跑剩余
        // 迁移补齐加列型新列（v4 起不能把 uuid 形状当「最新」，CREATE_SCHEMA_SQL
        // 的 IF NOT EXISTS 不会给已存在的表补列）；否则按 v2 形状补齐后从 1 起跑
        const cols = await conn.getAllAsync<{ name: string }>('PRAGMA table_info(activities);');
        from = cols.some((c) => c.name === 'uuid') ? 3 : 1;
      }
      if (from < SCHEMA_VERSION) {
        try {
          // v1 包可能缺 ai_memories/ai_reports 等表（旧导出中途残留）：按 v2 形状
          // 补建缺失空表（IF NOT EXISTS），与开库迁移的自愈口径一致
          await conn.execAsync(CREATE_V2_COMPAT_SQL);
          await runMigrations(conn, from, SCHEMA_VERSION);
        } catch (e) {
          throw new BackupError('migration_failed', String(e));
        }
      }
    }
    return conn;
  } catch (e) {
    if (e instanceof BackupError) {
      await closeQuietly(conn);
      throw e;
    }
    await closeQuietly(conn);
    return fail(e);
  }
}

/** 覆盖前自动安全备份：无口令（本机 key 随包）整包写 document/backups/，滚动保留 */
async function createPreImportBackup(): Promise<void> {
  const { bytes } = await buildBackup(null);
  const dir = new Directory(Paths.document, 'backups');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  new File(dir, `pre-import-${stamp}.fitbackup`).write(bytes);
  prunePreImportBackups(dir);
}

/** pre-import-*.fitbackup 按文件名时间戳倒序，超出保留份数删最旧 */
function prunePreImportBackups(dir: Directory): void {
  const olds = dir
    .list()
    .filter((e): e is File => e instanceof File)
    .map((f) => f.name)
    .filter((n) => /^pre-import-\d{14}\.fitbackup$/.test(n))
    .sort()
    .reverse()
    .slice(PRE_IMPORT_KEEP);
  for (const name of olds) {
    try {
      new File(dir, name).delete();
    } catch (e) {
      console.warn(`安全备份清理失败（忽略）: ${name}:`, e);
    }
  }
}

/** 删除主库的 WAL/SHM/ journal 残留（关库后本应消失，防御性清理） */
function removeWalSiblings(): void {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const f = new File(sqliteDir(), `${appDbFile().name}${suffix}`);
    if (f.exists) f.delete();
  }
}

async function closeQuietly(conn: SQLite.SQLiteDatabase | null): Promise<void> {
  if (!conn) return;
  try {
    await conn.closeAsync();
  } catch {
    // 验证失败路径的兜底关闭，无需处理
  }
}

function cleanup(file: File): void {
  try {
    if (file.exists) file.delete();
    // 临时库的 WAL/SHM 兄弟文件一并清（残留会永驻 SQLite 目录）
    for (const suffix of ['-wal', '-shm', '-journal']) {
      const f = new File(sqliteDir(), `${file.name}${suffix}`);
      if (f.exists) f.delete();
    }
  } catch (e) {
    console.warn('备份导入临时文件清理失败（忽略）:', file.name, e);
  }
}
