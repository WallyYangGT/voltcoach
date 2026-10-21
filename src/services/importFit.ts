/**
 * importFit.ts — FIT 导入服务（App 层编排，串联 core 管线与存储层）
 *
 * 流程：解析（core，依赖注入骑手参数）→ 内容指纹查重/决策（core/dedupe）→
 * 入库或更新（v3：uuid 身份）→ 当日 CTL/ATL/TSB 注入 → records gzip 以 uuid 落盘。
 * 来源：DocumentPicker（file:// URI）或安卓分享面板（content:// URI），统一经
 * expo-file-system File API 读字节。
 *
 * v3（2026-10-19，decisions §34）：
 *  - file_name 只是来源元数据，同名不同骑行不再静默覆盖（decideImport 返回 insert）；
 *  - 活动身份由 db 层生成 uuid，records 文件名与 AI 引用都用 uuid；
 *  - 插入/更新/跳过三条路径都按 fingerprint 重挂孤儿报告/对话（删除后重导入场景）。
 */

import { File } from 'expo-file-system';
import { rollLocalSnapshotQuietly } from '@/backup/export';
import { analyzeFile, type SecRecord, type Summary } from '@/core/analyze';
import { decideImport, rideFingerprint, type ImportDecision } from '@/core/dedupe';
import { safeName } from '@/core/records';
import {
  computeForm,
  getEffectiveAthlete,
  insertActivity,
  listActivityRideKeys,
  reattachOrphanRefs,
  rebuildDossierQuietly,
  updateActivitySummary,
} from '@/db';
import { invalidateDb } from '@/db/notify';
import { saveRecords } from '@/records-store';
import { enrichRideKeysForDedupe } from './dedupe';

/** 单次导入结果（导入页逐文件进度展示） */
export interface ImportOutcome {
  fileName: string;
  ok: boolean;
  summary?: Summary;
  /** 入库/更新后的活动 uuid（点击结果行跳详情用） */
  uuid?: string;
  /** 命中内容指纹时给出库内已有活动的 uuid 与来源文件名（本次未入库） */
  duplicateOfUuid?: string;
  duplicateOfFileName?: string;
  error?: string;
}

/** 导入管线返回值：duplicateOfUuid 非空表示判定为同一趟骑行、已跳过入库 */
export interface ImportResult {
  summary: Summary;
  /** 本次入库/更新后的活动身份（重复时是库内已有活动的 uuid） */
  uuid: string;
  /** 是否为新建活动（false = 更新已有行或命中重复跳过） */
  created: boolean;
  duplicateOfUuid: string | null;
  duplicateOfFileName: string | null;
}

/** 读源 URI 字节 → 走 importFitBytes（来源：DocumentPicker file:// 或分享面板 content://） */
export async function importFitSource(
  uri: string,
  fileName: string,
  opts?: { source?: string },
): Promise<ImportResult> {
  const safe = safeName(fileName);
  if (!safe) throw new Error(`非法文件名: ${fileName}`);
  if (!safe.toLowerCase().endsWith('.fit')) throw new Error(`不是 .fit 文件: ${safe}`);

  // File 构造器接受带 scheme 的绝对 URI（file:// / content:// 均可）
  const bytes = await new File(uri).bytes();
  if (!bytes.length) throw new Error('文件为空');
  return importFitBytes(bytes, safe, opts);
}

/**
 * 库内同一趟骑行的决策（v3）：精确指纹 → 更新；同名同骑行 → 更新；
 * 异名同骑行 → 跳过；同名不同骑行 → 插入新行。候选带 records 首帧起骑时刻，
 * 库内同日无距离行经 services/dedupe 补首帧后才参与室内判定。
 */
async function decideExistingRide(
  fileName: string,
  summary: Summary,
  records: SecRecord[],
): Promise<{ decision: ImportDecision; fingerprint: string }> {
  const a = summary.activity;
  const startAt = records[0]?.timestamp ?? null;
  const fingerprint = rideFingerprint({
    date: a.date,
    duration_sec: a.duration_sec ?? null,
    distance_km: a.distance_km ?? null,
    sport: a.sport ?? null,
    start_at: startAt,
  });
  const candidate = {
    file_name: fileName,
    fingerprint,
    date: a.date,
    duration_sec: a.duration_sec ?? null,
    distance_km: a.distance_km ?? null,
    sport: a.sport ?? null,
    start_at: startAt,
  };
  const rows = await listActivityRideKeys();
  const enriched = await enrichRideKeysForDedupe(rows, candidate);
  return { decision: decideImport(candidate, enriched), fingerprint };
}

/**
 * 按内容指纹把孤儿 AI 引用挂回指定活动（best-effort，失败不影响导入）。
 * 插入/更新/跳过三条路径都调用：库里可能已存在同趟骑行的另一份副本，
 * 而被删掉的那份才是报告原先锚定的活动。
 * 标题缓存失效由 db 层事件承担（reattachOrphanRefs 成功后发 activities 域事件）。
 */
async function reattachQuietly(fingerprint: string, uuid: string): Promise<void> {
  try {
    const reattached = await reattachOrphanRefs(fingerprint, uuid);
    if (reattached > 0) {
      console.info(`孤儿 AI 引用已重挂: ${reattached} 条 → ${uuid}`);
    }
  } catch (e) {
    console.warn('孤儿 AI 引用重挂失败（不影响导入）:', e);
  }
}

/**
 * FIT 字节 → 分析 → 查重决策 → 入库/更新 + records 落盘，返回解析结果（失败抛 Error）。
 * URI 与字节双入口共用本管线（云同步下载的字节不经落盘直接入）。
 * opts.source：来源元数据（手动导入 'import'，云同步传平台 id）。
 */
export async function importFitBytes(
  bytes: Uint8Array,
  fileName: string,
  opts?: { source?: string },
): Promise<ImportResult> {
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
  const { decision, fingerprint } = await decideExistingRide(safe, summary, records);
  if (decision.action === 'skip') {
    // 同趟骑行的异名副本已存在：不入库，但可能正是某份孤儿报告等待重挂的目标
    await reattachQuietly(fingerprint, decision.uuid);
    return {
      summary,
      uuid: decision.uuid,
      created: false,
      duplicateOfUuid: decision.uuid,
      duplicateOfFileName: decision.file_name,
    };
  }

  let uuid: string;
  let created: boolean;
  if (decision.action === 'update') {
    uuid = decision.uuid;
    created = false;
    await updateActivitySummary(uuid, summary, { fingerprint });
  } else {
    uuid = await insertActivity({
      fileName: safe,
      fingerprint,
      source: opts?.source ?? 'import',
      summary,
    });
    created = true;
  }

  // 注入当日 CTL/ATL/TSB（form 注入后的最终版再写一次，口径与旧版一致）
  const form = await computeForm(summary.activity.date);
  if (form) {
    Object.assign(summary.athlete_context, form);
    await updateActivitySummary(uuid, summary, { fingerprint });
  }

  // records gzip 落盘（详情页图表数据源）；失败不回滚入库（summary 已有效）
  try {
    await saveRecords(uuid, records);
  } catch (e) {
    console.warn(`records 落盘失败（详情页图表将无数据）: ${uuid}:`, e);
  }

  // 触发点：入库成功后静默滚一份本地快照（fire-and-forget 串行链，失败仅警告）
  void rollLocalSnapshotQuietly();
  // 补充失效：入库/更新的 db 写已经发过一次 activities 事件，但那可能早于 records
  // 落盘（保存逐秒数据是本层职责，不在 db 域内）——标题的起骑时刻来自 records 首帧，
  // 早发的那次事件清完缓存后若立刻重读，会读到旧/缺失文件并把 null 缓存下来。
  // 这里在 records 落盘之后再发一次，保证订阅方重取时数据已完整（v3 起缓存键是 uuid）。
  invalidateDb('activities', uuid);
  // 更新/插入都可能正是某份孤儿报告/对话等待重挂的同一趟骑行
  await reattachQuietly(fingerprint, uuid);
  void rebuildDossierQuietly(); // 训练档案基线随之更新（fire-and-forget，指纹兜底自愈）
  return { summary, uuid, created, duplicateOfUuid: null, duplicateOfFileName: null };
}
