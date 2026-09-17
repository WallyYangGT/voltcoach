/**
 * PoC 4 — node:sqlite 生成的训练库在 expo-sqlite 打开查询（M1 建库/迁移路径前置验证）。
 *
 * 素材：assets/poc/fitness.db，由旧 repo 代码（reference/，node:sqlite）分析
 * docs/sample-fit-files/ 三个真实 MAGENE 文件生成——3 条骑行、TSS 合计 215。
 * 链路：expo-asset 下发 → 复制到文档目录 → expo-sqlite 只读打开 → 业务查询。
 *
 * 通过标准：3 条 activities、逐行字段与生成侧一致（date/distance/tss/np）、
 * settings 可查、PRAGMA user_version 可读——即两套 SQLite 驱动完全互通。
 */
import { Asset } from 'expo-asset';
import { File, Paths } from 'expo-file-system';
import * as SQLite from 'expo-sqlite';
import type { PocResult } from './types';

interface ExpectedRow {
  date: string;
  distance_km: number;
  tss: number;
  np: number;
}

/** 生成侧（node:sqlite 直查）的黄金值，运行时逐字段比对 */
const EXPECTED: ExpectedRow[] = [
  { date: '2026-07-27', distance_km: 21.6, tss: 50, np: 75 },
  { date: '2026-07-31', distance_km: 9.94, tss: 72, np: 154 },
  { date: '2026-09-04', distance_km: 34.27, tss: 93, np: 80 },
];

export async function runSqlitePoc(): Promise<PocResult> {
  const t0 = Date.now();
  // 1. 从 Metro 资产取 db 文件并复制到文档目录（每轮删除重拷，验证完整复制链路）
  const asset = Asset.fromModule(require('../../assets/poc/fitness.db'));
  await asset.downloadAsync();
  if (!asset.localUri) {
    return { pass: false, detail: '✗ 资产下载失败（localUri 为空）' };
  }
  // File 构造器要求带 scheme 的绝对 URI（file:///...），asset.localUri 原样传入
  const src = new File(asset.localUri);
  const dest = new File(Paths.document, 'poc-fitness.db');
  if (dest.exists) dest.delete();
  dest.write(await src.bytes());

  // 2. expo-sqlite 打开并查询（只读语义，用副本）
  const db = await SQLite.openDatabaseAsync(dest.uri);
  try {
    const rows = await db.getAllAsync<{
      file_name: string;
      date: string;
      sport: string;
      duration_sec: number;
      distance_km: number;
      tss: number;
      np: number;
    }>(
      'SELECT file_name, date, sport, duration_sec, distance_km, tss, np FROM activities ORDER BY date',
    );
    const settingsRows = await db.getAllAsync<{ key: string }>('SELECT key FROM settings');
    const uv = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');

    const lines = [`耗时: ${Date.now() - t0}ms（含资产复制）`, `activities: ${rows.length} 条`, `settings: ${settingsRows.length} 行`, `user_version: ${uv?.user_version}`];
    let mismatch = '';
    if (rows.length !== EXPECTED.length) {
      mismatch = `条数不符（期望 ${EXPECTED.length}）`;
    } else {
      for (let i = 0; i < EXPECTED.length; i++) {
        const got = rows[i];
        const exp = EXPECTED[i];
        const ok =
          got.date === exp.date &&
          Math.abs(got.distance_km - exp.distance_km) < 0.01 &&
          got.tss === exp.tss &&
          got.np === exp.np &&
          got.sport === 'cycling';
        lines.push(
          `${ok ? '✓' : '✗'} ${got.date} ${got.distance_km}km TSS ${got.tss} NP ${got.np}W (${got.file_name.slice(0, 24)}…)`,
        );
        if (!ok) mismatch ||= `${got.date} 行字段与生成侧不一致`;
      }
    }
    const pass = !mismatch;
    return { pass, detail: `${pass ? '✓' : '✗'} ${mismatch || 'node:sqlite ⇄ expo-sqlite 互通验证通过'}\n${lines.join('\n')}` };
  } finally {
    await db.closeAsync();
  }
}
