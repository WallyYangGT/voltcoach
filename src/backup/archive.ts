/**
 * archive.ts — .fitbackup 备份包的 zip 打包/解包（格式规范见 docs/BACKUP_FORMAT.md）
 *
 * 纯函数层：只依赖 fflate（纯 JS zip 实现，Node/Hermes 通用）与 manifest 校验，
 * node:test 直接覆盖。压缩口径：zip 用 STORE（level 0）——db 与 records 本身已是
 * 密文/gzip，再 deflate 无收益只耗电；.fitbackup 本质 zip 仅为容器格式。
 *
 * 条目白名单：只认 manifest.json / fitness.db / records/<base>.records.csv.gz，
 * 解包时其余条目静默跳过、records 条目名过 safeName 校验——防构造包的路径穿越
 * 与垃圾条目（解包产物全在内存，再由调用方写到固定路径，穿越风险本就为零，
 * 白名单是最后一道防御）。
 *
 * UTF-8 编解码手写实现（不依赖 TextEncoder/TextDecoder——Hermes 环境无保证，
 * 口径同 src/ai/http.ts 的手写解码）。
 */

import { unzipSync, zipSync } from 'fflate';
// 相对导入带 .ts 扩展名：node:test 原生跑 TS 要求精确路径（口径同 src/ai）
import { safeName } from '../core/records.ts';
import { BackupError, validateBackupManifest, type BackupManifest } from './manifest.ts';

/** 包内固定条目名 */
export const MANIFEST_ENTRY = 'manifest.json';
export const DB_ENTRY = 'fitness.db';
/** records 条目前缀与后缀：<prefix><base><suffix>，<base> = 训练文件名去扩展名 */
export const RECORDS_PREFIX = 'records/';
export const RECORDS_SUFFIX = '.records.csv.gz';

/** 单条 records 的打包形态（name 为 zip 内条目名，由 recordsEntryName 生成） */
export interface BackupRecordEntry {
  name: string;
  gz: Uint8Array;
}

/** 打包产物（解包后的整体形状） */
export interface UnpackedBackup {
  manifest: BackupManifest;
  db: Uint8Array;
  records: { base: string; gz: Uint8Array }[];
}

/** UTF-8 字符串 → 字节（手写：代理对合成 4 字节序列，孤立代理替换为 U+FFFD） */
export function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let cp = text.codePointAt(i) as number;
    if (cp >= 0xd800 && cp <= 0xdfff) {
      cp = 0xfffd; // codePointAt 对孤立代理返回原码点，替换为 U+FFFD
    } else if (cp >= 0x10000) {
      i += 1; // 合法增补平面字符占两个 code unit
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

/** 字节 → UTF-8 字符串（手写：续字节不合法输出 U+FFFD 并按 1 字节推进，口径同 http.ts） */
export function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp: number;
    if (b0 < 0x80) {
      cp = b0;
      i += 1;
    } else if (b0 >= 0xc2 && b0 < 0xe0 && i + 1 < bytes.length && (bytes[i + 1] & 0xc0) === 0x80) {
      cp = ((b0 & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      i += 2;
    } else if (
      b0 >= 0xe0 &&
      b0 < 0xf0 &&
      i + 2 < bytes.length &&
      (bytes[i + 1] & 0xc0) === 0x80 &&
      (bytes[i + 2] & 0xc0) === 0x80
    ) {
      cp = ((b0 & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      i += 3;
    } else if (
      b0 >= 0xf0 &&
      b0 < 0xf5 &&
      i + 3 < bytes.length &&
      (bytes[i + 1] & 0xc0) === 0x80 &&
      (bytes[i + 2] & 0xc0) === 0x80 &&
      (bytes[i + 3] & 0xc0) === 0x80
    ) {
      cp = ((b0 & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      i += 4;
    } else {
      cp = 0xfffd;
      i += 1;
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** 训练文件名（去扩展名后的 base）→ records 条目名；base 非法返回 null（safeName 口径） */
export function recordsEntryName(base: string): string | null {
  const safe = safeName(base);
  if (!safe || safe.startsWith('.') || safe.endsWith(RECORDS_SUFFIX)) return null;
  return `${RECORDS_PREFIX}${safe}${RECORDS_SUFFIX}`;
}

/** records 条目名 → base（recordsEntryName 的逆运算）；非白名单形状返回 null */
export function recordsEntryBase(name: string): string | null {
  if (!name.startsWith(RECORDS_PREFIX) || !name.endsWith(RECORDS_SUFFIX)) return null;
  const base = name.slice(RECORDS_PREFIX.length, name.length - RECORDS_SUFFIX.length);
  return recordsEntryName(base) === name ? base : null;
}

/**
 * 打包 .fitbackup（调用方：备份导出/本地快照）。manifest 由调用方构造并保证合法
 * （此处再跑一遍校验，防止构造侧字段漂移直接落盘坏包）。
 */
export function packBackup(manifest: BackupManifest, db: Uint8Array, records: BackupRecordEntry[]): Uint8Array {
  const checked = validateBackupManifest(manifest);
  const files: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: utf8ToBytes(JSON.stringify(checked)),
    [DB_ENTRY]: db,
  };
  for (const rec of records) {
    const name = recordsEntryName(rec.name);
    if (!name) throw new BackupError('bad_manifest', `非法 records 条目名: ${rec.name}`);
    files[name] = rec.gz;
  }
  // level 0 = STORE：不再 deflate（payload 已压缩/加密），打包快且省电
  return zipSync(files, { level: 0 });
}

/**
 * 解包 .fitbackup（调用方：备份导入；zip 字节来自用户选择的文件，视为不可信输入）。
 * 结构不符按稳定码抛 BackupError；未知/非法 records 条目静默跳过（不因垃圾条目
 * 中断导入，记录数对不上由 counts 校验提示）。
 */
export function unpackBackup(zipBytes: Uint8Array): UnpackedBackup {
  let entries: Record<string, Uint8Array>;
  try {
    entries = flatten(unzipSync(zipBytes));
  } catch {
    throw new BackupError('invalid_zip', '不是合法的 zip 容器');
  }

  const manifestRaw = entries[MANIFEST_ENTRY];
  if (!manifestRaw) throw new BackupError('missing_manifest', '包内无 manifest.json');
  let manifest: BackupManifest;
  try {
    manifest = validateBackupManifest(JSON.parse(bytesToUtf8(manifestRaw)));
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError('bad_manifest', 'manifest.json 不是合法 JSON');
  }

  const db = entries[DB_ENTRY];
  if (!db) throw new BackupError('missing_db', '包内无 fitness.db');

  const records: { base: string; gz: Uint8Array }[] = [];
  for (const [name, gz] of Object.entries(entries)) {
    if (name === MANIFEST_ENTRY || name === DB_ENTRY) continue;
    const base = recordsEntryBase(name);
    if (base) records.push({ base, gz });
  }
  return { manifest, db, records };
}

/** unzipSync 产出嵌套目录树，拍平成 'a/b' 全路径键（目录节点无字节值，自动消失） */
function flatten(nested: Record<string, Uint8Array>, prefix = ''): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const [name, value] of Object.entries(nested)) {
    const full = prefix ? `${prefix}/${name}` : name;
    if (value instanceof Uint8Array) out[full] = value;
    else Object.assign(out, flatten(value as Record<string, Uint8Array>, full));
  }
  return out;
}
