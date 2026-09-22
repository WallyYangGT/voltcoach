/**
 * backup.test.mjs — .fitbackup 备份包纯函数层测试（node:test）
 *
 * 覆盖：manifest 校验分支、schema 版本闸门、UTF-8 手写编解码（含多字节/表情/孤立
 * 代理）、zip 打包/解包 roundtrip、records 条目名白名单与穿越防御、坏包稳定码。
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import {
  BackupError,
  checkSchemaVersion,
  validateBackupManifest,
} from '../src/backup/manifest.ts';
import {
  bytesToUtf8,
  packBackup,
  recordsEntryBase,
  recordsEntryName,
  unpackBackup,
  utf8ToBytes,
  DB_ENTRY,
  MANIFEST_ENTRY,
} from '../src/backup/archive.ts';

const manifest = (overrides = {}) => ({
  format: 'fitbackup',
  schema_version: 1,
  app_version: '0.1.0',
  exported_at: '2026-09-22T10:00:00.000Z',
  device: 'android/Medium_Phone',
  db_key: 'a'.repeat(64),
  counts: { activities: 3, records: 2 },
  ...overrides,
});

test('validateBackupManifest: 合法清单原样规整返回', () => {
  const m = validateBackupManifest(manifest());
  assert.equal(m.format, 'fitbackup');
  assert.equal(m.schema_version, 1);
  assert.equal(m.db_key, 'a'.repeat(64));
  assert.deepEqual(m.counts, { activities: 3, records: 2 });
});

test('validateBackupManifest: 多余字段忽略（向前兼容）', () => {
  const m = validateBackupManifest(manifest({ extra_field: 'future' }));
  assert.ok(!('extra_field' in m));
});

const badCases = [
  ['非对象', null],
  ['数组', []],
  ['format 不对', manifest({ format: 'zip' })],
  ['schema_version 非整数', manifest({ schema_version: 1.5 })],
  ['schema_version < 1', manifest({ schema_version: 0 })],
  ['app_version 缺失', manifest({ app_version: 1 })],
  ['exported_at 非时间', manifest({ exported_at: 'not-a-date' })],
  ['device 缺失', manifest({ device: null })],
  ['db_key 数字', manifest({ db_key: 42 })],
  ['counts 缺失', manifest({ counts: undefined })],
  ['counts.activities 负数', manifest({ counts: { activities: -1, records: 0 } })],
  ['counts.records 非数', manifest({ counts: { activities: 1, records: 'x' } })],
];

for (const [label, value] of badCases) {
  test(`validateBackupManifest: ${label} → bad_manifest`, () => {
    assert.throws(() => validateBackupManifest(value), (e) => e instanceof BackupError && e.code === 'bad_manifest');
  });
}

test('checkSchemaVersion: 包版本高于本机 → unsupported_version（提示升级 App）', () => {
  assert.throws(
    () => checkSchemaVersion(validateBackupManifest(manifest({ schema_version: 2 })), 1),
    (e) => e instanceof BackupError && e.code === 'unsupported_version',
  );
});

test('checkSchemaVersion: 包版本等于/低于本机放行（旧包由迁移链补齐）', () => {
  checkSchemaVersion(validateBackupManifest(manifest({ schema_version: 1 })), 1);
  checkSchemaVersion(validateBackupManifest(manifest({ schema_version: 1 })), 2);
});

test('utf8ToBytes/bytesToUtf8: ASCII roundtrip', () => {
  const s = 'MAGENE_C506SE_2026-08-30_094612_1273797';
  assert.deepEqual([...bytesToUtf8(utf8ToBytes(s))], [...s]);
});

test('utf8ToBytes/bytesToUtf8: 中文与表情 roundtrip', () => {
  const s = '环太湖骑行🚴100km！';
  const round = bytesToUtf8(utf8ToBytes(s));
  assert.equal(round, s);
});

test('utf8ToBytes: 孤立代理替换为 U+FFFD（不产生非法字节序列）', () => {
  const bytes = utf8ToBytes('\ud83d'); // 孤立高代理
  assert.deepEqual([...bytes], [0xef, 0xbf, 0xbd]);
});

test('utf8ToBytes: 与标准 TextEncoder 一致（抽样对照）', () => {
  const s = 'Café—汉字β';
  const expected = [...new TextEncoder().encode(s)];
  assert.deepEqual([...utf8ToBytes(s)], expected);
});

test('packBackup/unpackBackup: 完整 roundtrip（manifest + db + records 字节一致）', () => {
  const db = new Uint8Array([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 1, 2, 3]);
  const records = [
    { name: 'MAGENE_C506SE_2026-08-30_094612_1273797', gz: new Uint8Array([31, 139, 8, 0]) },
    { name: '环湖骑行', gz: new Uint8Array([1, 2, 3, 4, 5]) },
  ];
  const zip = packBackup(manifest(), db, records);
  const out = unpackBackup(zip);
  assert.equal(out.manifest.device, 'android/Medium_Phone');
  assert.deepEqual([...out.db], [...db]);
  assert.equal(out.records.length, 2);
  assert.equal(out.records[0].base, records[0].name);
  assert.deepEqual([...out.records[0].gz], [...records[0].gz]);
  assert.deepEqual([...out.records[1].gz], [...records[1].gz]);
});

test('packBackup: 构造时 manifest 非法立即抛错（坏包不落盘）', () => {
  assert.throws(() => packBackup(manifest({ schema_version: 0 }), new Uint8Array(4), []), BackupError);
  assert.throws(() => packBackup(manifest(), new Uint8Array(4), [{ name: 'a/../b', gz: new Uint8Array(1) }]), BackupError);
});

test('recordsEntryName/recordsEntryBase: 互逆 + 非法输入拒绝', () => {
  const good = 'MAGENE_C506SE_2026-08-30_094612_1273797';
  assert.equal(recordsEntryName(good), `records/${good}.records.csv.gz`);
  assert.equal(recordsEntryBase(`records/${good}.records.csv.gz`), good);
  // 路径穿越 / 目录片段 / 空名 / 已带后缀的重复包装，全部拒绝
  assert.equal(recordsEntryName('../evil'), null);
  assert.equal(recordsEntryName('a/b'), null);
  assert.equal(recordsEntryName(''), null);
  assert.equal(recordsEntryName('x.records.csv.gz.records.csv.gz'), null);
  assert.equal(recordsEntryBase('records/x.gz'), null);
  assert.equal(recordsEntryBase('other/x.records.csv.gz'), null);
});

test('unpackBackup: 缺 manifest → missing_manifest；缺 db → missing_db', () => {
  const onlyDb = zipSync({ [DB_ENTRY]: new Uint8Array(4) }, { level: 0 });
  assert.throws(() => unpackBackup(onlyDb), (e) => e instanceof BackupError && e.code === 'missing_manifest');
  const onlyManifest = zipSync({ [MANIFEST_ENTRY]: utf8ToBytes(JSON.stringify(manifest())) }, { level: 0 });
  assert.throws(() => unpackBackup(onlyManifest), (e) => e instanceof BackupError && e.code === 'missing_db');
});

test('unpackBackup: 非法 zip 容器 → invalid_zip', () => {
  assert.throws(
    () => unpackBackup(new Uint8Array([1, 2, 3, 4, 5])),
    (e) => e instanceof BackupError && e.code === 'invalid_zip',
  );
});

test('unpackBackup: manifest 内容坏 → bad_manifest（与条目缺失区分）', () => {
  const zip = zipSync(
    { [MANIFEST_ENTRY]: utf8ToBytes('not json'), [DB_ENTRY]: new Uint8Array(4) },
    { level: 0 },
  );
  assert.throws(() => unpackBackup(zip), (e) => e instanceof BackupError && e.code === 'bad_manifest');
});

test('unpackBackup: 构造包的穿越条目与未知条目静默跳过，白名单正常收下', () => {
  const zip = zipSync(
    {
      [MANIFEST_ENTRY]: utf8ToBytes(JSON.stringify(manifest({ counts: { activities: 0, records: 0 } }))),
      [DB_ENTRY]: new Uint8Array([9, 9]),
      'records/../evil.gz': strToU8('evil'),
      'records/,,bad*.csv.gz': strToU8('bad name'),
      'unknown.txt': strToU8('noise'),
    },
    { level: 0 },
  );
  const out = unpackBackup(zip);
  assert.equal(out.records.length, 0);
  assert.deepEqual([...out.db], [9, 9]);
});
