/**
 * PoC 1 — fit-file-parser 在 Metro/Hermes 下解析真实 MAGENE FIT（全计划最大单点风险）。
 *
 * 链路：expo-document-picker 选文件（copyToCacheDirectory）→ expo-file-system 读字节
 * → fit-file-parser（与旧 repo 完全同版本 3.0.2、同参数 force/km/h/km/list）解析。
 * 旧版传入的是 Node Buffer，这里传 Uint8Array——解析器 getArrayBuffer() 两者都接受。
 *
 * 通过标准：解析无异常、records ≥ 1000 条（真实骑行量级）、距离 ≥ 5km、
 * 功率均值在合理区间；附耗时与概要供人工核对。
 */
import FitParser from 'fit-file-parser';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import type { PocResult } from './types';

function fmt(n: number, digits = 1): string {
  return Number.isFinite(n) ? n.toFixed(digits) : '—';
}

export async function runFitParserPoc(): Promise<PocResult> {
  const picked = await DocumentPicker.getDocumentAsync({
    // .fit 无通用 MIME，用 */* 全类型并在 UI 提示选择 .fit 文件
    type: '*/*',
    copyToCacheDirectory: true,
    multiple: false,
  });
  if (picked.canceled) {
    return { pass: false, detail: '未选择文件（取消）' };
  }
  const asset = picked.assets[0];
  const name = asset.name ?? 'unknown';
  if (!name.toLowerCase().endsWith('.fit')) {
    return { pass: false, detail: `选中的不是 .fit 文件：${name}` };
  }

  const t0 = Date.now();
  // File 接受绝对路径，document-picker 返回 file:// URI（缓存目录）
  const file = new File(asset.uri.replace(/^file:\/\//, ''));
  const bytes = await file.bytes();
  const tRead = Date.now() - t0;

  const parser = new FitParser({
    force: true,
    speedUnit: 'km/h',
    lengthUnit: 'km',
    mode: 'list',
  });
  const data = await new Promise<any>((resolve, reject) =>
    parser.parse(bytes, (err, d) => (err ? reject(new Error(String(err))) : resolve(d))),
  );
  const tParse = Date.now() - t0 - tRead;

  const records: any[] = data?.records ?? [];
  const session = data?.sessions?.[0] ?? {};
  const sport = data?.sport?.sport || session.sport || 'unknown';

  const withPower = records.filter((r) => typeof r.power === 'number');
  const avgPower = withPower.length
    ? withPower.reduce((s, r) => s + (r.power ?? 0), 0) / withPower.length
    : NaN;
  const withHr = records.filter((r) => typeof r.heart_rate === 'number');
  const avgHr = withHr.length
    ? withHr.reduce((s, r) => s + (r.heart_rate ?? 0), 0) / withHr.length
    : NaN;

  const distanceKm =
    typeof session.total_distance === 'number'
      ? session.total_distance
      : typeof records[records.length - 1]?.distance === 'number'
        ? (records[records.length - 1].distance as number)
        : NaN;
  const timerMin = session.total_timer_time ? session.total_timer_time / 60 : NaN;

  const lines = [
    `文件: ${name} (${(bytes.length / 1024).toFixed(0)} KB)`,
    `耗时: 读字节 ${tRead}ms + 解析 ${tParse}ms`,
    `sport: ${sport}`,
    `records: ${records.length} 条（含时间戳 ${records.filter((r) => r.timestamp).length}）`,
    `session: 时长 ${fmt(timerMin)} min · 距离 ${fmt(distanceKm)} km · 爬升 ${session.total_ascent ?? '—'} m`,
    `均值: 功率 ${fmt(avgPower, 0)} W（${withPower.length} 秒有功率）· 心率 ${fmt(avgHr, 0)} bpm`,
    `首条记录字段: ${records[0] ? Object.keys(records[0]).join(',') : '—'}`,
  ];

  const pass =
    records.length >= 1000 &&
    Number.isFinite(distanceKm) &&
    distanceKm >= 5 &&
    (withPower.length === 0 || (avgPower > 50 && avgPower < 500));

  return { pass, detail: `${pass ? '✓' : '✗'}\n${lines.join('\n')}` };
}
