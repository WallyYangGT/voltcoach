/**
 * aiTitle.ts — AI 报告标题装配 + 骑行首帧时刻/本地日缓存（App 层）。
 *
 * core/reportTitle 只做日期格式化与分支选择，骑行信息（运动类型、起骑时刻）要在
 * 这里从训练库取：活动行来自 listActivityRideKeys（一次全表查询，按 activity uuid
 * 建索引），起骑时刻来自该活动的 records 首帧（readStoredRecordStart，读 gzip 后只扫头部）。
 *
 * v3（2026-10-19，decisions §34）：所有缓存键从 file_name 换成 activity uuid——
 * file_name 可同名并存，不能再当唯一键。
 *
 * 两级进程内缓存（训练库是唯一数据源，失效由 db 失效事件收口）：
 *  - startCache：uuid → 首帧 ISO（null 也缓存，避免反复读不存在的文件）；
 *  - titleCache：标题键（lang + 报告标识字段）→ 标题文本，让「报告详情页 1.5s 轮询
 *    刷新」这类同内容重算只花一次 Map 查找，不再重查库/读盘。
 *
 * 失效机制（架构评审 A3，2026-10）：订阅 `@/db/notify` 的 activities 域事件——
 * 导入/删除/合并/重挂等任何写路径的 db 层事件都会带 uuid 自动清这里（此前靠 7 处
 * 散点手工调用 invalidateReportTitles，漏一处就停旧值）。
 */

import { useCallback, useEffect, useState } from 'react';
import type { Lang } from '@/core/i18n';
import { localDayFromUtc } from '@/core/local-day';
import { reportTitle, type ReportTitleTranslate, type RideBrief } from '@/core/reportTitle';
import { listActivityRideKeys } from '@/db';
import { subscribeDbInvalidation } from '@/db/notify';
import { useI18n } from '@/i18n';
import { readStoredRecordStart } from '@/records-store';

/** 标题装配所需的报告字段（AiReportRow / AiReportListItem 均满足） */
export interface ReportTitleSource {
  id: number;
  mode: 'review' | 'plan' | 'taper' | 'compare';
  activity_uuid: string | null;
  race_date: string | null;
  compare_uuid: string | null;
  created_at: string;
}

/** 起骑时刻缓存（activity uuid → ISO/null） */
let startCache = new Map<string, string | null>();
/** 标题缓存（标题键 → 文本） */
let titleCache = new Map<string, string>();
/** 缓存代际：失效时 +1，useRideDateLabels 订阅后重新解析（同名重导入换内容/重挂） */
let cacheEpoch = 0;
const cacheListeners = new Set<() => void>();

/**
 * 清缓存：数据变更后由 db 失效事件自动调用（见文件末的订阅）。
 * 传 uuid 只清该活动的起骑时刻；不传则全清。标题缓存一律全清（compare 跨两条记录）。
 *
 * 仍是导出的公共入口：批量清理与测试直接调用；业务写入路径**不再**手工调用——
 * 架构评审 A3 后由 `subscribeDbInvalidation` 收口（此前 7 处散点调用，漏一处标题
 * 就停在旧值）。
 */
export function invalidateReportTitles(uuid?: string | readonly string[]): void {
  titleCache = new Map();
  if (typeof uuid === 'string') {
    startCache.delete(uuid);
  } else if (uuid) {
    for (const id of uuid) startCache.delete(id); // 批量（一行级事件带多个 uuid）
  } else {
    startCache = new Map();
  }
  cacheEpoch += 1;
  for (const fn of cacheListeners) fn();
}

/**
 * 单个骑行的首帧时刻（ISO UTC；带进程内缓存）。本地日历日换算的瞬间源——
 * AI 数据面整形与 UI 展示面共用，缺 records/读盘失败返回 null（调用方回退 UTC 日）。
 */
export async function getRideStartAt(activityId: string): Promise<string | null> {
  let startAt = startCache.get(activityId);
  if (startAt === undefined) {
    startAt = await readStoredRecordStart(activityId);
    startCache.set(activityId, startAt);
  }
  return startAt;
}

/**
 * 批量解析骑行本地日历日标签（展示面用）：activity uuids → Map(uuid → 本地日)。
 * 缺首帧/解析失败的键不进 Map，调用方以 `labels.get(uuid) ?? row.date` 回退存储 UTC 日。
 * 语义上假定传入的是一小批（调用方大批量自行分片，见 useRideDateLabels）。
 */
export async function resolveRideDateLabels(
  activityIds: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const id of new Set(activityIds)) {
    if (!id) continue;
    const day = localDayFromUtc(await getRideStartAt(id));
    if (day) out.set(id, day);
  }
  return out;
}

const EMPTY_LABELS: Map<string, string> = new Map();

/**
 * 骑行本地日标签的 React 装配（列表类屏共用）：activity uuids 变化或缓存失效时
 * 重新解析。首帧读取是整包 gzip 解压（cold ~几十 ms/条），列表 200 行按 8 条分批
 * 渐进 setState——先出 UTC 日标签，本地日随解析进度补齐（多数骑行两种口径同日，
 * 翻转不可感知）；进程内缓存命中后同批同步完成。返回的 Map 只含解析成功的键。
 *
 * state 以「key#epoch」为版本：集合或缓存代际变化时渲染侧立即用空 Map（不展示上一轮
 * 的陈旧标签），异步批次到达后按版本合并——effect 体内不做同步 setState。
 */
export function useRideDateLabels(activityIds: (string | null | undefined)[]): Map<string, string> {
  const key = activityIds.filter(Boolean).join('|');
  const [epoch, setEpoch] = useState(cacheEpoch);
  const version = `${key}#${epoch}`;
  const [state, setState] = useState<{ version: string; labels: Map<string, string> }>({
    version: '',
    labels: EMPTY_LABELS,
  });
  // 失效通知：invalidateReportTitles 后重新解析（uuid 集合不变但 contents 变了）
  useEffect(() => {
    const fn = () => setEpoch((e) => e + 1);
    cacheListeners.add(fn);
    return () => {
      cacheListeners.delete(fn);
    };
  }, []);
  useEffect(() => {
    let alive = true;
    const ids = key ? key.split('|') : [];
    void (async () => {
      for (let i = 0; i < ids.length; i += 8) {
        const batch = await resolveRideDateLabels(ids.slice(i, i + 8));
        if (!alive) return;
        if (batch.size) {
          setState((prev) => {
            const base = prev.version === version ? prev.labels : EMPTY_LABELS;
            return { version, labels: new Map([...base, ...batch]) };
          });
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [version, key]);
  return state.version === version ? state.labels : EMPTY_LABELS;
}

/**
 * 标题键：只含影响标题的字段（轮询产生的同内容新对象命中同一键）。
 * 含时区偏移——标题按本地时区格式化，进程存活期间改时区（罕见）要让键失效。
 */
function titleKeyOf(r: ReportTitleSource, lang: Lang): string {
  const tz = new Date().getTimezoneOffset();
  return [lang, tz, r.mode, r.activity_uuid ?? '', r.race_date ?? '', r.compare_uuid ?? '', r.created_at].join('|');
}

/** 单个活动的骑行简报（活动不存在返回 null） */
async function loadBrief(
  activityId: string | null | undefined,
  rows: Map<string, { sport: string; date: string }>,
): Promise<RideBrief | null> {
  if (!activityId) return null;
  const row = rows.get(activityId);
  if (!row) return null;
  const startAt = await getRideStartAt(activityId);
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
 * 批量装配报告标题（对话页列表用）：一次全表取活动行，review/compare 再各读一次
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
    for (const r of await listActivityRideKeys()) rows.set(r.uuid, { sport: r.sport, date: r.date });
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
    const ride = await loadBrief(r.activity_uuid, rows);
    const other = r.mode === 'compare' ? await loadBrief(r.compare_uuid, rows) : null;
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
  const [epoch, setEpoch] = useState(cacheEpoch);
  // 数据变更（导入/删除/合并/重挂）后重新装配：报告对象本身可能没变，但起骑时刻变了
  useEffect(() => {
    const fn = () => setEpoch((e) => e + 1);
    cacheListeners.add(fn);
    return () => {
      cacheListeners.delete(fn);
    };
  }, []);

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
  }, [compute, epoch]);

  return title;
}

// ---------------- 失效订阅（模块级，一次） ----------------
//
// activities 域的写都意味着「活动行或逐秒数据变了」：导入/同名重导入/重算/校准/
// 分类备注/功率标记/删除/合并/重挂。行级事件带 uuid，只清那几条的起骑时刻；
// 域级事件（合并/重挂/备份整库替换）不带 uuid，全清。
//
// 订阅放在模块加载时是因为 db 写可能在没有任何标题组件挂载时发生（后台云同步
// 导入），此时缓存也必须失效，否则下次挂载读到的是旧值。
subscribeDbInvalidation((ev) => {
  if (!ev.domains.has('activities')) return;
  if (ev.activityUuids.length) invalidateReportTitles(ev.activityUuids);
  else invalidateReportTitles();
});
