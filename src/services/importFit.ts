/**
 * importFit.ts — FIT 导入服务（App 层编排，串联 core 管线与存储层）
 *
 * 流程与旧版 analyzeFile 的 ⑤⑥ 步对齐：解析（core，依赖注入骑手参数）→
 * 入库 + 当日 CTL/ATL/TSB 注入（两次 upsert，form 注入后的最终版入库——口径
 * 与旧版一致）→ records gzip 落盘。来源：DocumentPicker（file:// URI）或
 * 安卓分享面板（content:// URI），统一经 expo-file-system File API 读字节。
 */

import { File } from 'expo-file-system';
import { rollLocalSnapshotQuietly } from '@/backup/export';
import { analyzeFile, type Summary } from '@/core/analyze';
import { safeName } from '@/core/records';
import { computeForm, getEffectiveAthlete, upsertActivity } from '@/db';
import { saveRecords } from '@/records-store';

/** 单次导入结果（导入页逐文件进度展示） */
export interface ImportOutcome {
  fileName: string;
  ok: boolean;
  summary?: Summary;
  error?: string;
}

/** 读源 URI 字节 → 走 importFitBytes（来源：DocumentPicker file:// 或分享面板 content://） */
export async function importFitSource(uri: string, fileName: string): Promise<Summary> {
  const safe = safeName(fileName);
  if (!safe) throw new Error(`非法文件名: ${fileName}`);
  if (!safe.toLowerCase().endsWith('.fit')) throw new Error(`不是 .fit 文件: ${safe}`);

  // File 构造器接受带 scheme 的绝对 URI（file:// / content:// 均可）
  const bytes = await new File(uri).bytes();
  if (!bytes.length) throw new Error('文件为空');
  return importFitBytes(bytes, safe);
}

/**
 * FIT 字节 → 分析 → 入库 + records 落盘，返回 summary（失败抛 Error）。
 * URI 与字节双入口共用本管线（顽鹿同步下载的字节不经落盘直接入，M4）。
 */
export async function importFitBytes(bytes: Uint8Array, fileName: string): Promise<Summary> {
  const safe = safeName(fileName);
  if (!safe) throw new Error(`非法文件名: ${fileName}`);
  if (!safe.toLowerCase().endsWith('.fit')) throw new Error(`不是 .fit 文件: ${safe}`);
  if (!bytes.length) throw new Error('文件为空');

  const athlete = await getEffectiveAthlete(); // 骑手参数以训练库为准
  const { records, summary } = await analyzeFile({ bytes, fileName: safe, athlete });

  // 入库 + 注入当日 CTL/ATL/TSB（form 注入后的最终版再入库一次，口径与旧版一致）
  await upsertActivity(safe, summary);
  const form = await computeForm(summary.activity.date);
  if (form) {
    Object.assign(summary.athlete_context, form);
    await upsertActivity(safe, summary);
  }

  // records gzip 落盘（详情页图表数据源）；失败不回滚入库（summary 已有效）
  try {
    await saveRecords(safe, records);
  } catch (e) {
    console.warn(`records 落盘失败（详情页图表将无数据）: ${safe}:`, e);
  }

  // §7.2 触发点：入库成功后静默滚一份本地快照（fire-and-forget 串行链，失败仅警告）
  void rollLocalSnapshotQuietly();
  return summary;
}
