/**
 * make_backup_fixtures.mjs — 生成导入错误分支的夹具包（M4 冒烟用）
 *
 * 用途：在设备上跑通导入的全部拒绝路径——版本超前 / 坏 zip / 错 key（口令错）/
 * 需要口令。用 App 同源纯函数层打包（fflate STORE + manifest 同构），保证夹具与
 * 真实产物格式一致；基底 db 与 records 取自一个真实包（默认取旧 repo --export 的
 * 产物，可用 argv[2] 指定任意 .fitbackup）。
 *
 * 用法：node scripts/make_backup_fixtures.mjs [基底.fitbackup] [输出目录]
 * 产物用 adb push 到模拟器 Download，再在「数据管理 → 从备份包导入」里逐个选。
 */

import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { packBackup } from '../src/backup/archive.ts';

const src = process.argv[2] ?? 'D:/projects/fit-reader/export/voltcoach-backup-20260922-201134.fitbackup';
const outDir = process.argv[3] ?? path.join(process.env.TEMP ?? '/tmp', 'backup-fixtures');
fs.mkdirSync(outDir, { recursive: true });

// 真实包解出 db 与 manifest（作为夹具基底）
const real = unzipSync(new Uint8Array(fs.readFileSync(src)));
const dbBytes = real['fitness.db'];
const records = Object.entries(real)
  .filter(([n]) => n.startsWith('records/'))
  .map(([n, gz]) => ({ name: n.replace(/^records\//, '').replace(/\.records\.csv\.gz$/, ''), gz }));

const base = {
  format: 'fitbackup',
  schema_version: 1,
  app_version: '0.1.0',
  exported_at: '2026-09-22T12:00:00.000Z',
  device: 'fixture',
  db_key: null,
  counts: { activities: 22, records: records.length },
};

const write = (name, bytes) => {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, bytes);
  console.log(`${name}  ${(bytes.length / 1024).toFixed(0)} KB`);
};

// ① 版本超前：schema_version 高于本机 → 期望「备份来自更新版本的 App」并中止（无确认框）
write('fx1-too-new.fitbackup', packBackup({ ...base, schema_version: 99 }, dbBytes, records));

// ② 坏 zip：随机字节 → 期望「不是有效的备份包」
write('fx2-bad-zip.fitbackup', new Uint8Array(Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) % 256)));

// ③ 错 key：manifest 带一把无效密钥（库实为明文）→ 期望「口令错误或备份包损坏」
write(
  'fx3-wrong-key.fitbackup',
  packBackup({ ...base, db_key: 'f'.repeat(64) }, dbBytes, records),
);

// ④ 需要口令：manifest 无 key、db 为随机字节（模拟密文不可无口令打开）→ 期望「该备份由口令加密」
const garbage = new Uint8Array(Array.from({ length: dbBytes.length }, (_, i) => (i * 31 + 7) % 256));
write('fx4-needs-pass.fitbackup', packBackup({ ...base, db_key: null }, garbage, records));

// ⑤ 明文库 + 提示：db_key=null 的真库（合法），但 counts 虚标 → 确认框仍应显示（对照项）
write('fx5-plain-ok.fitbackup', packBackup({ ...base, counts: { activities: 1, records: 1 } }, dbBytes, records.slice(0, 1)));

console.log(`\n输出目录: ${outDir}`);
