/**
 * importFit.ts — FIT 导入服务（App 层编排，串联 core 管线与存储层）
 *
 * 流程与旧版 analyzeFile 的 ⑤⑥ 步对齐：解析（core，依赖注入骑手参数）→
 * 入库 + 当日 CTL/ATL/TSB 注入（两次 upsert，form 注入后的最终版入库——口径
 * 与旧版一致）→ records gzip 落盘。来源：DocumentPicker（file:// URI）或
 * 安卓分享面板（content:// URI），统一经 expo-file-system File API 读字节。
 *
 * M5 追加内容指纹查重：手动导入与顽鹿云同步给同一个文件取的名字不同（本地原名 vs
 * 云端 fileKey），只按 file_name 去重会让同一趟骑行二次入库。解析后先与库内异名
 * 记录比对骑行指纹（core/dedupe），命中则不入库、不落盘、不滚快照。
 */

import { File } from 'expo-file-system';
import { rollLocalSnapshotQuietly } from '@/backup/export';
import { analyzeFile, type Summary } from '@/core/analyze';
import { findDuplicateOf } from '@/core/dedupe';
import { safeName } from '@/core/records';
import { computeForm, getEffectiveAthlete, listActivityRideKeys, rebuildDossierQuietly, upsertActivity } from '@/db';
import { saveRecords } from '@/records-store';
import { invalidateReportTitles } from './aiTitle';

/** 单次导入结果（导入页逐文件进度展示） */
export interface ImportOutcome {
  fileName: string;
  ok: boolean;
  summary?: Summary;
  /** 命中内容指纹时给出库内已有记录的文件名（本次未入库） */
  duplicateOf?: string;
  error?: string;
}

/** 导入管线返回值：duplicateOf 非空表示判定为同一趟骑行、已跳过入库 */
export interface ImportResult {
  summary: Summary;
  duplicateOf: string | null;
}

/** 读源 URI 字节 → 走 importFitBytes（来源：DocumentPicker file:// 或分享面板 content://） */
export async function importFitSource(uri: string, fileName: string): Promise<ImportResult> {
  const safe = safeName(fileName);
  if (!safe) throw new Error(`非法文件名: ${fileName}`);
  if (!safe.toLowerCase().endsWith('.fit')) throw new Error(`不是 .fit 文件: ${safe}`);

  // File 构造器接受带 scheme 的绝对 URI（file:// / content:// 均可）
  const bytes = await new File(uri).bytes();
  if (!bytes.length) throw new Error('文件为空');
  return importFitBytes(bytes, safe);
}

/**
 * 库内是否已有同一趟骑行（异名同指纹）：命中返回已有记录的文件名；
 * 同名行存在时返回 null（走 upsert 覆盖更新，口径见 core/dedupe.findDuplicateOf）。
 */
async function findExistingRide(fileName: string, summary: Summary): Promise<string | null> {
  const a = summary.activity;
  const rows = await listActivityRideKeys();
  return findDuplicateOf(
    {
      file_name: fileName,
      date: a.date,
      duration_sec: a.duration_sec ?? null,
      distance_km: a.distance_km ?? null,
    },
    rows,
  );
}

/**
 * FIT 字节 → 分析 → 查重 → 入库 + records 落盘，返回解析结果（失败抛 Error）。
 * URI 与字节双入口共用本管线（顽鹿同步下载的字节不经落盘直接入，M4）。
 */
export async function importFitBytes(bytes: Uint8Array, fileName: string): Promise<ImportResult> {
  const safe = safeName(fileName);
  if (!safe) throw new Error(`非法文件名: ${fileName}`);
  if (!safe.toLowerCase().endsWith('.fit')) throw new Error(`不是 .fit 文件: ${safe}`);
  if (!bytes.length) throw new Error('文件为空');

  // 骑手参数以训练库为准；只解构三个数值参数——getEffectiveAthlete 运行时携带的
  // FTP 溯源戳（ftp_updated_at/ftp_source）不进 analyzeFile，避免泄入 summary.athlete_context
  const { ftp_watts, max_hr, weight_kg } = await getEffectiveAthlete();
  const { records, summary } = await analyzeFile({
    bytes,
    fileName: safe,
    athlete: { ftp_watts, max_hr, weight_kg },
  });

  // 查重放在入库之前：命中即整体跳过（含 records 落盘与快照滚动，避免留下孤儿文件）
  const duplicateOf = await findExistingRide(safe, summary);
  if (duplicateOf) return { summary, duplicateOf };

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

  // 触发点：入库成功后静默滚一份本地快照（fire-and-forget 串行链，失败仅警告）
  void rollLocalSnapshotQuietly();
  invalidateReportTitles(safe); // 同名重导入可能换了内容 → 起骑时刻缓存失效
  void rebuildDossierQuietly(); // 训练档案基线随之更新（fire-and-forget，指纹兜底自愈）
  return { summary, duplicateOf: null };
}
