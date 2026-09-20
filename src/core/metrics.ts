/**
 * metrics.ts — 训练详情指标网格的内容装配（纯函数，无 IO、不 import RN/Expo）
 *
 * 逐条对齐 Web 版 views/activities.js 的 metrics 列表：同样的条件渲染（缺数据不显示该项）
 * 与顺序（时长/距离/速度/爬升/卡路里 → NP+IF / 平均功率+W·kg⁻¹ / 最大功率 / TSS+VI →
 * 平均心率+最大值 / 心率漂移+判读 → 踏频 / 温度 / 配速 / 游泳 → 当日 CTL-ATL-TSB+说明），
 * 每条附小字注释。文案由调用方注入取词函数（前端词典 m.* 词条，zh 与 Web 版逐字一致），
 * 本模块只负责「什么条件下出哪一格、值怎么格式化」，因此可在 node:test 直接断言。
 */

import type { Summary } from './analyze.ts';
import type { DictKey } from '../i18n/dict.ts';
import { formNote, type Lang } from './i18n.ts';

/** 指标格：标签 + 等宽大数字（含单位）+ 小字注释 */
export interface MetricItem {
  label: string;
  value: string;
  unit?: string;
  /** 小字注释（IF / W·kg⁻¹ / VI / 最大心率 / 漂移判读 / 当日负荷说明） */
  sub?: string;
}

/** 取词函数（签名同 useI18n().t，注入以便纯函数层复用 UI 词典） */
export type MetricText = (key: DictKey, vars?: Record<string, string | number>) => string;

/** 数值格式化（口径同 Web 版 common.js num：null → "-"，定点后去掉全零小数位，2.00 → 2） */
export function formatNum(v: number | null | undefined, digits = 0): string {
  return v == null ? '-' : v.toFixed(digits).replace(/\.0+$/, '');
}

/**
 * 时长缩写（与训练列表同口径：1h05 / 45m）。分钟先四舍五入再拆小时，
 * 避免 59:40 落到 "60m"；null 用占位符（列表页「—」）。
 */
export function formatDuration(sec: number | null | undefined, nullText = '—'): string {
  if (sec == null) return nullText;
  const total = Math.round(sec / 60);
  const h = Math.floor(total / 60);
  return h > 0 ? `${h}h${String(total % 60).padStart(2, '0')}` : `${total}m`;
}

/** 配速 m:ss（口径同 Web 版 fmtPace；秒位四舍五入到 60 时进位，避免 "5:60"） */
export function formatPace(minPerKm: number | null | undefined): string {
  if (minPerKm == null) return '-';
  let m = Math.floor(minPerKm),
    s = Math.round((minPerKm - m) * 60);
  if (s === 60) {
    m += 1;
    s = 0;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 指标网格列数：按屏宽每列约 180px 起算，夹在 2–4 列之间
 * （窄屏 2 列同 Web 版窄屏；平板/横屏加列，避免十几格把图表挤到屏外）。
 */
export function metricColumns(width: number): number {
  return Math.min(4, Math.max(2, Math.floor(width / 180)));
}

/** summary → 指标格序列（顺序与 Web 版一致；缺失项跳过，缺整组不崩） */
export function buildActivityMetrics(summary: Summary, t: MetricText, lang: Lang = 'zh'): MetricItem[] {
  const a = summary.activity;
  const p = summary.power;
  const hr = summary.heart_rate;
  const ac = summary.athlete_context;
  const out: MetricItem[] = [];

  out.push({ label: t('m.duration'), value: formatDuration(a.duration_sec) });
  out.push({ label: t('m.distance'), value: formatNum(a.distance_km, 2), unit: 'km' });
  if (a.avg_speed_kmh != null)
    out.push({ label: t('m.avg_speed'), value: formatNum(a.avg_speed_kmh, 2), unit: 'km/h' });
  if (a.elevation_gain_m) out.push({ label: t('m.gain'), value: String(a.elevation_gain_m), unit: 'm' });
  if (a.total_calories != null)
    out.push({ label: t('m.calories'), value: String(a.total_calories), unit: 'kcal' });

  if (p?.normalized_power != null)
    out.push({
      label: 'NP',
      value: String(p.normalized_power),
      unit: 'W',
      sub: t('m.np_sub', { if: formatNum(p.intensity_factor, 2) }),
    });
  if (p?.avg != null)
    out.push({
      label: t('m.avg_power'),
      value: formatNum(p.avg, 0),
      unit: 'W',
      sub: p.w_per_kg_avg ? `${formatNum(p.w_per_kg_avg, 2)} W/kg` : '',
    });
  if (p?.max != null) out.push({ label: t('m.max_power'), value: String(p.max), unit: 'W' });
  if (p?.tss != null)
    out.push({
      label: 'TSS',
      value: String(p.tss),
      sub: t('m.tss_sub', { vi: formatNum(p.variability_index, 2) }),
    });

  if (hr?.avg != null)
    out.push({
      label: t('m.avg_hr'),
      value: formatNum(hr.avg, 0),
      unit: 'bpm',
      sub: hr.max ? t('m.max_hr_sub', { max: hr.max }) : '',
    });
  if (hr?.hr_drift_pct != null)
    out.push({
      label: t('m.hr_drift'),
      value: formatNum(hr.hr_drift_pct, 1),
      unit: '%',
      sub: Math.abs(hr.hr_drift_pct) < 5 ? t('m.drift_good') : t('m.drift_high'),
    });

  const cadenceAvg = summary.cadence?.avg;
  if (cadenceAvg != null) {
    const running = a.sport === 'running';
    out.push({
      label: running ? t('m.stride') : t('m.cadence'),
      value: formatNum(cadenceAvg, 0),
      unit: running ? 'spm' : 'rpm',
    });
  }
  if (summary.temperature)
    out.push({
      label: t('m.temp'),
      value: formatNum(summary.temperature.avg, 1),
      unit: '°C',
      sub: summary.temperature.max != null ? t('m.temp_max', { t: summary.temperature.max }) : '',
    });
  if (summary.pace) {
    out.push({ label: t('m.pace'), value: formatPace(summary.pace.avg_pace_min_per_km), unit: '/km' });
    if (summary.pace.best_1min_pace_min_per_km)
      out.push({
        label: t('m.pace_best'),
        value: formatPace(summary.pace.best_1min_pace_min_per_km),
        unit: '/km',
      });
  }
  if (summary.swim) {
    const sw = summary.swim;
    out.push({ label: t('m.swim_lengths'), value: String(sw.lengths_count) });
    if (sw.avg_swolf) out.push({ label: t('m.swolf'), value: String(sw.avg_swolf) });
    if (sw.avg_length_time_sec)
      out.push({ label: t('m.swim_avg'), value: formatNum(sw.avg_length_time_sec, 1), unit: 's' });
  }

  // 当日负荷：入库时注入 athlete_context（旧数据无 form 快照则逐字段跳过）
  if (ac.ctl != null) out.push({ label: t('m.ctl'), value: String(ac.ctl), sub: t('m.ctl_sub') });
  if (ac.atl != null) out.push({ label: t('m.atl'), value: String(ac.atl), sub: t('m.atl_sub') });
  if (ac.tsb != null)
    out.push({
      label: t('m.tsb'),
      value: (ac.tsb > 0 ? '+' : '') + ac.tsb,
      // 简评按当前界面语言重算（入库快照的 form_note 是导入当时的语言，界面不读它）
      sub: formNote(ac.tsb, lang),
    });

  return out;
}
