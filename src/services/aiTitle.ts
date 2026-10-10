/**
 * aiTitle.ts — AI 报告标题装配（App 层：从库里取骑行信息 → core/reportTitle 拼串）
 *
 * core/reportTitle 只做日期格式化与分支选择，骑行信息（运动类型、起骑时刻）要在
 * 这里从训练库取：活动行来自 listActivityRideKeys（一次全表查询，按 file_name 建索引），
 * 起骑时刻来自该活动的 records 首帧（readStoredRecordStart，读 gzip 后只扫头部）。
 *
 * 两级进程内缓存（训练库是唯一数据源，改动点全部由本模块的失效函数收口）：
 *  - startCache：file_name → 首帧 ISO（null 也缓存，避免反复读不存在的文件）；
 *  - titleCache：标题键（lang + 报告标识字段）→ 标题文本，让「报告详情页 1.5s 轮询
 *    刷新」这类同内容重算只花一次 Map 查找，不再重查库/读盘。
 * 导入、删除、合并重复都会改数据，各自调用 invalidateReportTitles() 清缓存。
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

/** 起骑时刻缓存（file_name → ISO/null） */
let startCache = new Map<string, string | null>();
/** 标题缓存（标题键 → 文本） */
let titleCache = new Map<string, string>();

/**
 * 清缓存：数据变更（导入/删除/合并重复）后调用，否则标题与起骑时刻会停在旧值
 * （合并时逐秒数据从副本接管到保留项、同名重导入换了内容都属于这类）。
 * 传 fileName 只清该文件的起骑时刻；不传则全清。标题缓存一律全清（compare 跨两条记录）。
 */
export function invalidateReportTitles(fileName?: string): void {
  titleCache = new Map();
  if (fileName) startCache.delete(fileName);
  else startCache = new Map();
}

/**
 * 标题键：只含影响标题的字段（轮询产生的同内容新对象命中同一键）。
 * 含时区偏移——标题按本地时区格式化，进程存活期间改时区（罕见）要让键失效。
 */
function titleKeyOf(r: ReportTitleSource, lang: Lang): string {
  const tz = new Date().getTimezoneOffset();
  return [lang, tz, r.mode, r.file_name ?? '', r.race_date ?? '', r.compare_with ?? '', r.created_at].join('|');
}

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

/**
 * 运动类型词条名：缺词条时返回 null，让标题走「训练复盘」泛称，而不是渲染出
 * 「复盘sport.e_biking」这种原始 key——FIT 的 sport 枚举有 40+ 值，词典只覆盖常见几种
 * （旧版 Web 同款守卫，见 Web 版 js/i18n.js）。
 */
function sportLabelOf(t: (key: never) => string, sport: string): string | null {
  const key = `sport.${sport}` as never;
  const label = t(key);
  return label === key ? null : label;
}

/**
 * 批量装配报告标题（AI 列表用）：一次全表取活动行，review/compare 再各读一次
 * records 首帧（带缓存）。返回 map：报告 id → 标题。
 */
export async function buildReportTitles(
  reports: ReportTitleSource[],
  lang: Lang,
  t: ReportTitleTranslate & ((key: never) => string),
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!reports.length) return out;

  // 只需要 review/compare 的活动信息：plan/taper 不查库；全部命中标题缓存时同样不查
  const pending = reports.filter((r) => !titleCache.has(titleKeyOf(r, lang)));
  const needsActivities = pending.some((r) => r.mode === 'review' || r.mode === 'compare');
  const rows = new Map<string, { sport: string; date: string }>();
  if (needsActivities) {
    for (const r of await listActivityRideKeys()) rows.set(r.file_name, { sport: r.sport, date: r.date });
  }

  for (const r of reports) {
    const key = titleKeyOf(r, lang);
    const cached = titleCache.get(key);
    if (cached != null) {
      out.set(r.id, cached);
      continue;
    }
    const withSport = (b: RideBrief | null): RideBrief | null =>
      b ? { ...b, sport: b.sport ? sportLabelOf(t, b.sport) : null } : null;
    const ride = await loadBrief(r.file_name, rows);
    const other = r.mode === 'compare' ? await loadBrief(r.compare_with, rows) : null;
    const title = reportTitle(
      {
        mode: r.mode,
        lang,
        ride: withSport(ride),
        other: withSport(other),
        raceDate: r.race_date,
        createdAt: r.created_at,
      },
      t,
    );
    titleCache.set(key, title);
    out.set(r.id, title);
  }
  return out;
}

/** 单个报告标题（详情页用） */
export async function buildReportTitle(
  report: ReportTitleSource,
  lang: Lang,
  t: ReportTitleTranslate & ((key: never) => string),
): Promise<string> {
  const titles = await buildReportTitles([report], lang, t);
  return titles.get(report.id) ?? '';
}

/**
 * 单个报告标题的 React 装配（详情页头部用）：报告行变化时重算（同内容重算走标题缓存）。
 * 装配完成前返回 null（调用方回退到模式名），避免闪一个空标题。
 */
export function useReportTitle(report: ReportTitleSource | null): string | null {
  const { t, lang } = useI18n();
  const [title, setTitle] = useState<string | null>(null);

  const compute = useCallback(async () => {
    if (!report) return null;
    return buildReportTitle(report, lang, t);
  }, [report, lang, t]);

  useEffect(() => {
    let alive = true;
    void compute()
      .then((res) => {
        if (alive) setTitle(res);
      })
      .catch((e) => {
        // 库损坏/备份导入换库期间可能抛错：不弹窗（标题只是装饰），回退到模式名
        console.warn('报告标题装配失败:', e);
        if (alive) setTitle(null);
      });
    return () => {
      alive = false;
    };
  }, [compute]);

  return title;
}
