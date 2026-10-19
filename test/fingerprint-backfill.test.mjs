/**
 * fingerprint-backfill.test.mjs — 存量室内骑行指纹回填（node:sqlite，node:test）
 *
 * 钉住 v2→v3 迁移后「旧 3 段指纹（无起骑时刻）→ 新 4 段指纹」的补齐：
 * 活动、报告（主/对比引用）、追问对话同步更新；已新格式跳过；缺 records 首帧保留旧值。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { CREATE_SCHEMA_SQL } from '../src/db/schema.ts';
import { backfillIndoorFingerprints } from '../src/db/fingerprint.ts';

const uid = (c) => c.repeat(32);
const OLD_FP = '2026-09-20|3600|';
const OLD_FP2 = '2026-09-21|1800|';
const START = '2026-09-20T10:00:00.000Z';
const NEW_FP = `${OLD_FP}|${START}`;
const NEW_FP2 = `${OLD_FP2}|${START}`;

function portOf(raw) {
  return {
    getAllAsync: async (sql, ...params) => raw.prepare(sql).all(...params),
    runAsync: async (sql, ...params) => {
      const info = raw.prepare(sql).run(...params);
      return { changes: info.changes };
    },
    withTransactionAsync: async (fn) => {
      raw.exec('BEGIN');
      try {
        await fn();
        raw.exec('COMMIT');
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

function seed(raw) {
  raw.exec(CREATE_SCHEMA_SQL);
  raw.exec(`INSERT INTO activities (uuid, file_name, date, duration_sec, distance_km, fingerprint, summary_json)
            VALUES ('${uid('a')}', 'indoor.fit', '2026-09-20', 3600, NULL, '${OLD_FP}', '{}'),
                   ('${uid('b')}', 'indoor2.fit', '2026-09-21', 1800, 0, '${OLD_FP2}', '{}')`);
  raw.exec(`INSERT INTO ai_reports (mode, activity_uuid, compare_uuid, activity_fingerprint, compare_fingerprint, prompt, markdown)
            VALUES ('review', '${uid('a')}', NULL, '${OLD_FP}', NULL, 'p', 'm'),
                   ('compare', '${uid('a')}', '${uid('b')}', '${OLD_FP}', '${OLD_FP2}', 'p', 'm')`);
  raw.exec(`INSERT INTO ai_chats (mode, activity_uuid, activity_fingerprint, title)
            VALUES ('follow_up', '${uid('a')}', '${OLD_FP}', 't')`);
}

test('室内旧指纹：活动 + 报告 + 对比引用 + 对话同步补起骑时刻', async () => {
  const raw = new DatabaseSync(':memory:');
  seed(raw);
  const fixed = await backfillIndoorFingerprints(portOf(raw), async (uuid) => (uuid === uid('a') ? START : null));

  assert.equal(fixed, 1); // b 缺首帧 → 保留旧值
  assert.equal(raw.prepare(`SELECT fingerprint FROM activities WHERE uuid='${uid('a')}'`).get().fingerprint, NEW_FP);
  assert.equal(raw.prepare(`SELECT fingerprint FROM activities WHERE uuid='${uid('b')}'`).get().fingerprint, OLD_FP2);

  const reports = raw.prepare('SELECT * FROM ai_reports ORDER BY id').all();
  assert.equal(reports[0].activity_fingerprint, NEW_FP);
  assert.equal(reports[1].activity_fingerprint, NEW_FP);
  assert.equal(reports[1].compare_fingerprint, OLD_FP2); // b 未回填
  assert.equal(raw.prepare('SELECT activity_fingerprint FROM ai_chats WHERE id=1').get().activity_fingerprint, NEW_FP);
});

test('已是新格式/无距离有距离更新 → 直接跳过，幂等', async () => {
  const raw = new DatabaseSync(':memory:');
  seed(raw);
  raw.exec(`UPDATE activities SET fingerprint='${NEW_FP}' WHERE uuid='${uid('a')}'`);
  raw.exec(`UPDATE activities SET fingerprint='${NEW_FP2}' WHERE uuid='${uid('b')}'`);
  assert.equal(await backfillIndoorFingerprints(portOf(raw), async () => START), 0);
  assert.equal(await backfillIndoorFingerprints(portOf(raw), async () => START), 0);
});

test('有有效距离的户外行不参与回填', async () => {
  const raw = new DatabaseSync(':memory:');
  raw.exec(CREATE_SCHEMA_SQL);
  raw.exec(`INSERT INTO activities (uuid, file_name, date, duration_sec, distance_km, fingerprint, summary_json)
            VALUES ('${uid('a')}', 'outdoor.fit', '2026-09-20', 3600, 30, '2026-09-20|3600|30000', '{}')`);
  assert.equal(await backfillIndoorFingerprints(portOf(raw), async () => START), 0);
  assert.equal(
    raw.prepare(`SELECT fingerprint FROM activities WHERE uuid='${uid('a')}'`).get().fingerprint,
    '2026-09-20|3600|30000',
  );
});
