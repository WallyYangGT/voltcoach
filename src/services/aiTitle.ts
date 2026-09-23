/**
 * aiTitle.ts — AI 报告标题装配（App 层：从库里取骑行信息 → core/reportTitle 拼串）
 *
 * core/reportTitle 只做日期格式化与分支选择，骑行信息（运动类型、起骑时刻）要在
 * 这里从训练库取：活动行来自 listActivityRideKeys（一次全表查询，按 file_name 建索引），
 * 起骑时刻来自该活动的 records 首帧（readStoredRecordStart，读 gzip 后只扫头部）。
 * 逐秒记录的读取结果按文件名进程内缓存——列表最多 30 份报告，同一次会话内不重复读盘。
 *
 * 训练被删 / records 缺失都不算错误：标题退化为泛称或只显示日期（见 core/reportTitle）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { Lang } from '@/core/i18n';
import { reportTitle, type ReportTitleTranslate, type RideBrief } from '@/core/reportTitle';
import { listActivityRideKeys } from '@/db';
import { useI18n } from '@/i18n';
import { readStoredRecordStart } from '@/records-store';

/** 标题装配所需的报告字段（AiReportRow / AiReportListItem 均满足） */
export interface ReportTitleSource {
  id: number;
  mode: 'review' | 'plan' | 'taper' | 'compare';
  file_name: string | null;
  race_date: string | null;
  compare_with: string | null;
  created_at: string;
}

/** 起骑时刻缓存（file_name → ISO/null）；null 也缓存，避免反复读不存在的文件 */
const startCache = new Map<string, string | null>();

/** 单个活动的骑行简报（活动不存在返回 null） */
async function loadBrief(
  fileName: string | null | undefined,
  rows: Map<string, { sport: string; date: string }>,
): Promise<RideBrief | null> {
  if (!fileName) return null;
  const row = rows.get(fileName);
  if (!row) return null;
  let startAt = startCache.get(fileName);
  if (startAt === undefined) {
    startAt = await readStoredRecordStart(fileName);
    startCache.set(fileName, startAt);
  }
  return {
    // 'unknown' 视为未知 → 标题走泛称模板（与列表里显示「未知」徽章同源）
    sport: row.sport === 'unknown' ? null : row.sport,
    startAt,
    date: row.date,
  };
}

/** 单个报告标题（详情页用） */
export async function buildReportTitle(
  report: ReportTitleSource,
  lang: Lang,
  t: ReportTitleTranslate,
  sportLabel: (sport: string) => string,
): Promise<string> {
  const titles = await buildReportTitles([report], lang, t, sportLabel);
  return titles.get(report.id) ?? '';
}

/**
 * 批量装配报告标题（AI 列表用）：一次全表取活动行，review/compare 再各读一次
 * records 首帧（带缓存）。返回 map：报告 id → 标题。
 */
export async function buildReportTitles(
  reports: ReportTitleSource[],
  lang: Lang,
  t: ReportTitleTranslate,
  sportLabel: (sport: string) => string,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!reports.length) return out;

  // 只需要 review/compare 的活动信息：plan/taper 不查库
  const needsActivities = reports.some((r) => r.mode === 'review' || r.mode === 'compare');
  const rows = new Map<string, { sport: string; date: string }>();
  if (needsActivities) {
    for (const r of await listActivityRideKeys()) rows.set(r.file_name, { sport: r.sport, date: r.date });
  }

  for (const r of reports) {
    const withSport = (b: RideBrief | null): RideBrief | null =>
      b ? { ...b, sport: b.sport ? sportLabel(b.sport) : null } : null;
    const ride = await loadBrief(r.file_name, rows);
    const other = r.mode === 'compare' ? await loadBrief(r.compare_with, rows) : null;
    out.set(
      r.id,
      reportTitle(
        {
          mode: r.mode,
          lang,
          ride: withSport(ride),
          other: withSport(other),
          raceDate: r.race_date,
          createdAt: r.created_at,
        },
        t,
      ),
    );
  }
  return out;
}

/**
 * 单个报告标题的 React 装配（详情页头部用）：报告行变化时重算。
 * 装配完成前返回 null（调用方回退到模式名），避免闪一个空标题。
 */
export function useReportTitle(report: ReportTitleSource | null): string | null {
  const { t, lang } = useI18n();
  const [title, setTitle] = useState<string | null>(null);

  const compute = useCallback(async () => {
    if (!report) return null;
    const label = (sport: string) => t(`sport.${sport}` as never);
    return buildReportTitle(report, lang, t, label);
  }, [report, t, lang]);

  useEffect(() => {
    let alive = true;
    void compute().then((res) => {
      if (alive) setTitle(res);
    });
    return () => {
      alive = false;
    };
  }, [compute]);

  return title;
}
