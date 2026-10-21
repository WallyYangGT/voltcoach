/// <reference types="node" />
/**
 * sqlite-port.ts — db 域函数真 SQL 测试的假库（node:sqlite 适配 expo-sqlite 端口）
 *
 * 域函数内部经 './client' 的 getDb() 取连接；test/db/* 用 jest.mock('@/db/client')
 * 把 getDb 替换为本文件的 getTestDb()（:memory: 按最新 schema 建库，node:sqlite 同步
 * API 适配成 expo-sqlite 异步形状）。迁移链与 SQLCipher 不在此覆盖
 * （test/migrations-db.test.mjs 与 L3 冒烟各管一段），这里只钉域函数的 SQL 行为：
 * 滚动清理 / 事务原子性 / pending 守卫 / 指纹重挂 / 溯源戳。
 *
 * jest.mock 工厂只能引用 mock* 前缀的外部绑定（jest 约定），测试文件以
 * `import * as mockSqlite from '../helpers/sqlite-port'` 引入本模块。
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Summary } from '@/core/analyze';
import { ATHLETE } from '@/core/settings';
import { CREATE_SCHEMA_SQL } from '@/db/schema';

/** SQLite 可绑定参数（域层只绑 string/number/null；node:sqlite 的 SQLInputValue 同域） */
type SqlParam = string | number | bigint | null;

/** node:sqlite 同步 API → expo-sqlite 异步形状（域函数用到的最小端口） */
function portOf(db: DatabaseSync) {
  return {
    execAsync: async (sql: string) => {
      db.exec(sql);
    },
    getFirstAsync: async <T>(sql: string, ...params: SqlParam[]): Promise<T | null> =>
      (db.prepare(sql).get(...params) as T | undefined) ?? null,
    getAllAsync: async <T>(sql: string, ...params: SqlParam[]): Promise<T[]> =>
      db.prepare(sql).all(...params) as T[],
    runAsync: async (sql: string, ...params: SqlParam[]) => {
      const r = db.prepare(sql).run(...params);
      // 键名对齐 expo-sqlite 的 RunResult（lastInsertRowId 大写 D；node:sqlite 是小写 d）
      return { changes: Number(r.changes ?? 0), lastInsertRowId: Number(r.lastInsertRowid ?? 0) };
    },
    // 语义对齐 expo-sqlite：fn 抛错整体回滚，无 savefile/嵌套事务用法（域层未用）
    withTransactionAsync: async (fn: () => Promise<void>) => {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
}

type DbPort = ReturnType<typeof portOf>;

let raw: DatabaseSync | null = null;
let port: DbPort | null = null;

/** 重建空库（每个测试 beforeEach 调用，测试间零串味） */
export function resetTestDb(): void {
  // 显式开启外键（对齐生产 client.ts 的 `PRAGMA foreign_keys = ON`，不依赖
  // node:sqlite 的默认值——默认值未来可能变，且与 expo-sqlite 的「显式开启」不同源）
  raw = new DatabaseSync(':memory:', { enableForeignKeyConstraints: true });
  raw.exec(CREATE_SCHEMA_SQL);
  port = portOf(raw);
}

/** 被注入为 getDb 的假连接（未显式 reset 时惰性建库） */
export function getTestDb(): DbPort {
  if (!port) resetTestDb();
  return port!;
}

/** 原始 node:sqlite 句柄（断言与直接造数/改行用） */
export function getRawDb(): DatabaseSync {
  if (!raw) resetTestDb();
  return raw!;
}

/** 32 位小写 hex 活动 uuid（与 core/identity 同形状；测试造数直接写表时用） */
export const makeUuid = (): string => randomUUID().replace(/-/g, '').toLowerCase();

/** 直接插一行活动（绕过域函数，控制 uuid/created_at 等测试关心的一切列） */
export function seedActivityRow(
  opts: Partial<{
    uuid: string;
    file_name: string;
    fingerprint: string;
    date: string;
    sport: string | null;
    duration_sec: number | null;
    distance_km: number | null;
    tss: number | null;
    intensity_factor: number | null;
    category: string | null;
    note: string | null;
    power_flagged: number;
    created_at: string;
  }> = {},
): string {
  const uuid = opts.uuid ?? makeUuid();
  getRawDb()
    .prepare(
      `INSERT INTO activities
         (uuid, file_name, fingerprint, date, sport, duration_sec, distance_km, tss,
          intensity_factor, category, note, power_flagged, summary_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      uuid,
      opts.file_name ?? `ride-${uuid.slice(0, 6)}.fit`,
      opts.fingerprint ?? `2026-10-01|${opts.duration_sec ?? 3600}|${Math.round((opts.distance_km ?? 40) * 1000)}`,
      opts.date ?? '2026-10-01',
      opts.sport ?? 'cycling',
      opts.duration_sec ?? 3600,
      opts.distance_km ?? 40,
      opts.tss ?? 60,
      opts.intensity_factor ?? 0.8,
      opts.category ?? 'training',
      opts.note ?? null,
      opts.power_flagged ?? 0,
      JSON.stringify(
        makeSummary({
          date: opts.date ?? '2026-10-01',
          sport: opts.sport ?? 'cycling',
          duration_sec: opts.duration_sec ?? 3600,
          distance_km: opts.distance_km ?? 40,
          tss: opts.tss ?? 60,
        }),
      ),
      opts.created_at ?? '2026-10-01T08:00:00',
    );
  return uuid;
}

/** 最小可用 Summary：只填 SQL 层与档案聚合读取的字段，其余以类型断言放宽 */
export function makeSummary(
  opts: {
    date?: string;
    sport?: string;
    duration_sec?: number;
    distance_km?: number | null;
    tss?: number | null;
    intensity_factor?: number | null;
  } = {},
): Summary {
  return {
    activity: {
      date: opts.date ?? '2026-10-01',
      sport: opts.sport ?? 'cycling',
      duration_sec: opts.duration_sec ?? 3600,
      distance_km: opts.distance_km ?? 40,
      elevation_gain_m: 100,
      elevation_gain_source: 'device',
    },
    athlete_context: { ...ATHLETE },
    power: {
      avg: 200,
      normalized_power: 220,
      max: 600,
      variability_index: 1.1,
      intensity_factor: opts.intensity_factor ?? 0.8,
      tss: opts.tss ?? 60,
      w_per_kg_avg: 3.0,
    },
  } as unknown as Summary;
}
