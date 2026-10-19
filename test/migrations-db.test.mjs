/**
 * migrations-db.test.mjs — schema v3 迁移的真实 SQL 回归（node:sqlite，node:test）
 *
 * 覆盖 v2→v3 表重建：数据保留、uuid 回填唯一、报告/对话 file_name→uuid 映射、
 * 孤儿消息清理、user_version 盖戳、sqlite_sequence 续号、外键 ON DELETE SET NULL、
 * 同名 file_name 可并存、迁移失败事务回滚。设备侧 SQLCipher 行为不变（同一
 * SQLite 语义），锁与加密层由 L3 冒烟覆盖。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { runMigrations } from '../src/db/migrations.ts';
import { migrateSchema } from '../src/db/migrate.ts';
import { CREATE_SCHEMA_SQL } from '../src/db/schema.ts';

/** expo-sqlite 的异步 API → node:sqlite 同步 API 适配 */
function portOf(raw) {
  return {
    execAsync: async (sql) => raw.exec(sql),
    getFirstAsync: async (sql, ...params) => raw.prepare(sql).get(...params) ?? null,
    getAllAsync: async (sql, ...params) => raw.prepare(sql).all(...params),
  };
}

/** v2 形状的库（含代表数据；用于验证迁移保留口径） */
const V2_SCHEMA = `
  CREATE TABLE activities (
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
    power_flagged INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE ai_reports (
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
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE ai_chats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT NOT NULL,
    report_id INTEGER,
    file_name TEXT,
    title TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE ai_chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'completed',
    error TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE ai_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content TEXT NOT NULL,
    category TEXT DEFAULT 'general',
    source TEXT,
    scope TEXT NOT NULL DEFAULT 'long',
    created_at TEXT DEFAULT (datetime('now')),
    superseded_by INTEGER
  );
  CREATE INDEX idx_activities_date ON activities(date);
  CREATE INDEX idx_ai_reports_mode_created ON ai_reports(mode, created_at DESC);
  CREATE INDEX idx_ai_reports_status ON ai_reports(status);
  CREATE INDEX idx_ai_chats_mode ON ai_chats(mode, id DESC);
  CREATE INDEX idx_ai_chat_messages_chat ON ai_chat_messages(chat_id, id);
  PRAGMA user_version = 2;
`;

const V2_DATA = `
  INSERT INTO activities
    (file_name, date, sport, duration_sec, distance_km, elevation_gain_m, tss, np,
     avg_power, intensity_factor, summary_json, category, note, power_flagged)
  VALUES
    ('a.fit', '2026-10-01', 'cycling', 3600, 30, 100, 50, 200, 180, 0.8, '{}', 'race', 'note-a', 1),
    ('b.fit', '2026-10-02', 'cycling', 1800, 15, 50, 20, 150, 140, 0.7, '{}', 'training', NULL, 0);
  INSERT INTO ai_reports (mode, file_name, compare_with, prompt, markdown)
  VALUES
    ('review', 'a.fit', NULL, 'p1', 'm1'),
    ('compare', 'a.fit', 'b.fit', 'p2', 'm2'),
    ('plan', NULL, NULL, 'p3', 'm3');
  INSERT INTO ai_chats (mode, report_id, file_name, title)
  VALUES ('follow_up', 1, 'a.fit', 'chat-a'), ('plan', NULL, NULL, 'plan-chat');
  INSERT INTO ai_chat_messages (chat_id, role, content)
  VALUES (1, 'user', 'hello'), (1, 'assistant', 'hi'), (99, 'user', 'orphan');
  INSERT INTO ai_memories (content) VALUES ('memory-1');
  INSERT INTO settings (key, value) VALUES ('athlete', '{"ftp_watts":200}');
`;

function freshDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(V2_SCHEMA);
  raw.exec(V2_DATA);
  return raw;
}

test('v2→v3：数据保留、uuid 回填、报告/对话映射、消息孤儿清理、版本戳', async () => {
  const raw = freshDb();
  await runMigrations(portOf(raw), 2, 3);

  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);

  const acts = raw.prepare('SELECT * FROM activities ORDER BY id').all();
  assert.equal(acts.length, 2);
  assert.equal(acts[0].file_name, 'a.fit');
  assert.equal(acts[0].category, 'race');
  assert.equal(acts[0].note, 'note-a');
  assert.equal(acts[0].power_flagged, 1);
  assert.match(acts[0].uuid, /^[0-9a-f]{32}$/);
  assert.notEqual(acts[0].uuid, acts[1].uuid);
  assert.equal(acts[0].fingerprint, '2026-10-01|3600|30000');
  assert.equal(acts[1].fingerprint, '2026-10-02|1800|15000');

  const reports = raw.prepare('SELECT * FROM ai_reports ORDER BY id').all();
  assert.equal(reports.length, 3);
  assert.equal(reports[0].activity_uuid, acts[0].uuid);
  assert.equal(reports[0].activity_fingerprint, acts[0].fingerprint);
  assert.equal(reports[1].activity_uuid, acts[0].uuid);
  assert.equal(reports[1].compare_uuid, acts[1].uuid);
  assert.equal(reports[1].compare_fingerprint, acts[1].fingerprint);
  assert.equal(reports[2].activity_uuid, null);

  const chats = raw.prepare('SELECT * FROM ai_chats ORDER BY id').all();
  assert.equal(chats[0].activity_uuid, acts[0].uuid);
  assert.equal(chats[0].activity_fingerprint, acts[0].fingerprint);
  assert.equal(chats[1].activity_uuid, null);
  assert.equal(chats[1].report_id, null);

  const messages = raw.prepare('SELECT * FROM ai_chat_messages ORDER BY id').all();
  assert.equal(messages.length, 2); // chat 99 的孤儿消息被清理
  assert.deepEqual(messages.map((m) => m.content), ['hello', 'hi']);

  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM ai_memories').get().c, 1);
  assert.equal(raw.prepare("SELECT value FROM settings WHERE key='athlete'").get().value, '{"ftp_watts":200}');
});

test('v3：同名 file_name 可并存，id 续号不回退', async () => {
  const raw = freshDb();
  await runMigrations(portOf(raw), 2, 3);

  raw.exec(
    `INSERT INTO activities (uuid, file_name, date, summary_json)
     VALUES ('${'c'.repeat(32)}', 'a.fit', '2026-10-03', '{}')`,
  );
  assert.equal(raw.prepare("SELECT COUNT(*) AS c FROM activities WHERE file_name='a.fit'").get().c, 2);

  const next = raw.prepare("SELECT MAX(id) AS m FROM activities").get().m + 1;
  raw.exec(`INSERT INTO activities (uuid, file_name, date, summary_json)
            VALUES ('${'d'.repeat(32)}', 'd.fit', '2026-10-04', '{}')`);
  const seq = raw.prepare("SELECT seq FROM sqlite_sequence WHERE name='activities'").get();
  assert.ok(seq.seq >= next);
});

test('v3 外键：删活动置 NULL，指纹保留（报告可重挂）', async () => {
  const raw = freshDb();
  await runMigrations(portOf(raw), 2, 3);
  raw.exec('PRAGMA foreign_keys = ON;');

  const a = raw.prepare("SELECT uuid, fingerprint FROM activities WHERE file_name='a.fit'").get();
  raw.prepare('DELETE FROM activities WHERE uuid = ?').run(a.uuid);

  const report = raw.prepare('SELECT * FROM ai_reports WHERE id=1').get();
  assert.equal(report.activity_uuid, null);
  assert.equal(report.activity_fingerprint, a.fingerprint);

  const chat = raw.prepare('SELECT * FROM ai_chats WHERE id=1').get();
  assert.equal(chat.activity_uuid, null);
  assert.equal(chat.activity_fingerprint, a.fingerprint);
});

test('v3 外键：删报告置空 chat.report_id，删对话级联消息', async () => {
  const raw = freshDb();
  await runMigrations(portOf(raw), 2, 3);
  raw.exec('PRAGMA foreign_keys = ON;');

  raw.exec('DELETE FROM ai_reports WHERE id=1');
  assert.equal(raw.prepare('SELECT report_id FROM ai_chats WHERE id=1').get().report_id, null);

  raw.exec('DELETE FROM ai_chats WHERE id=1');
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM ai_chat_messages WHERE chat_id=1').get().c, 0);
});

test('迁移失败事务回滚：旧表与 user_version 原样保留', async () => {
  const raw = freshDb();
  raw.exec('CREATE TABLE activities_v3 (x)'); // 让重建第一步撞名
  const port = portOf(raw);

  await assert.rejects(() => runMigrations(port, 2, 3), /activities_v3/);

  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 2);
  const cols = raw.prepare('PRAGMA table_info(activities)').all().map((c) => c.name);
  assert.ok(cols.includes('file_name'));
  assert.ok(!cols.includes('uuid'));
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM activities').get().c, 2);
});

test('migrateSchema：v2 存量库（含旧索引）直接升级，不再先跑 v3 建表脚本', async () => {
  const raw = freshDb();
  await migrateSchema(portOf(raw));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM activities').get().c, 2);
  const report = raw.prepare('SELECT activity_uuid FROM ai_reports WHERE id=1').get();
  assert.match(report.activity_uuid, /^[0-9a-f]{32}$/);
  // 旧索引随旧表删除，新索引就位
  const idx = raw.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='ai_reports'").all().map((r) => r.name);
  assert.ok(idx.includes('idx_ai_reports_mode_activity'));
  assert.ok(!idx.includes('idx_ai_reports_mode_created'));
});

test('migrateSchema：v1 崩溃残留（user_version=0 但有表）升到 v3', async () => {
  const raw = freshDb();
  raw.exec('PRAGMA user_version = 0;');
  await migrateSchema(portOf(raw));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM activities').get().c, 2);
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM ai_memories').get().c, 1);
});

test('migrateSchema：全新空库按 v3 脚本一次建齐', async () => {
  const raw = new DatabaseSync(':memory:');
  await migrateSchema(portOf(raw));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['activities', 'ai_reports', 'settings', 'ai_chats', 'ai_chat_messages', 'ai_memories']) {
    assert.ok(tables.includes(t), t);
  }
});

test('migrateSchema：v3 结构但版本戳丢失（0）只盖戳，不重建 uuid', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(CREATE_SCHEMA_SQL);
  raw.exec(`INSERT INTO activities (uuid, file_name, date, summary_json)
            VALUES ('${'a'.repeat(32)}', 'a.fit', '2026-10-01', '{}')`);
  raw.exec('PRAGMA user_version = 0;');
  await migrateSchema(portOf(raw));
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(raw.prepare('SELECT uuid FROM activities').get().uuid, 'a'.repeat(32));
});

test('新建库脚本即 v3 形状（uuid/外键/同名可插）', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(CREATE_SCHEMA_SQL);
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec(`INSERT INTO activities (uuid, file_name, date, summary_json)
            VALUES ('${'a'.repeat(32)}', 'same.fit', '2026-10-01', '{}'),
                   ('${'b'.repeat(32)}', 'same.fit', '2026-10-01', '{}')`);
  raw.exec(`INSERT INTO ai_reports (mode, activity_uuid, prompt, markdown)
            VALUES ('review', '${'a'.repeat(32)}', 'p', 'm')`);
  raw.exec(`INSERT INTO ai_chats (mode, report_id, activity_uuid) VALUES ('follow_up', 1, '${'a'.repeat(32)}')`);

  raw.exec(`DELETE FROM activities WHERE uuid='${'a'.repeat(32)}'`);
  const report = raw.prepare('SELECT activity_uuid FROM ai_reports WHERE id=1').get();
  assert.equal(report.activity_uuid, null);
  assert.equal(raw.prepare('SELECT COUNT(*) AS c FROM activities').get().c, 1);
});
