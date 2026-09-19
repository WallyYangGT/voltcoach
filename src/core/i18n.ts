/**
 * i18n.ts（core 层）— 数据层本地化：结构化异常与 form 状态的按语言渲染
 *
 * 移植自 reference/src/i18n.js 的 normalizeLang / t / formNote / formatAnomaly
 * 及其依赖的 form.note.* / anom.* 词条（zh 文案与旧版逐字一致——回归断言依赖）。
 * 完整服务端词典（db 校验消息、AI 工具文案等）随 M3 AI 层搬运时合并进来。
 *
 * 约定：t(lang, key, vars) 中 {var} 为插值占位；缺省语言一律回落 zh。
 */

export type Lang = 'zh' | 'en';

/** 语言归一化：仅认 zh / en，其余一律回落 zh */
export function normalizeLang(l: unknown): Lang {
  return l === 'en' ? 'en' : 'zh';
}

const DICT: Record<Lang, Record<string, string>> = {
  zh: {
    // ---- 训练库（src/db）校验消息 ----
    'athlete.range': '{key} 需在 {lo}–{hi} 之间',
    'athlete.none': '至少需要提供一个字段：ftp_watts / max_hr / weight_kg',
    'category.invalid': '分类需为 training/race/recovery/leisure',
    'activity.not_found': '训练不存在',
    'note.too_long': '备注过长（上限 {n} 字）',
    // ---- TSB 状态简评（formNote，zh 与历史逐字一致） ----
    'form.note.0': '状态很新鲜，适合比赛或高强度测试',
    'form.note.1': '状态良好，恢复充分',
    'form.note.2': '负荷与恢复平衡，可持续训练',
    'form.note.3': '疲劳积累期，注意睡眠与恢复',
    'form.note.4': '过度疲劳风险，建议安排减量周',
    // ---- 异常标注（结构化 anomalies → formatAnomaly 渲染） ----
    'anom.power_gap': '功率缺失 {duration}s，起始 {at}',
    'anom.record_gap': '记录缺失 {duration}s，起始 {at}',
    'anom.timer_pause': '计时暂停 {duration}s，起始 {at}',
    'anom.hr_jump': '心率跳变 {from}→{to}，位于 {at}',
    'anom.other': '{text}',
  },
  en: {
    'athlete.range': '{key} must be between {lo} and {hi}',
    'athlete.none': 'Provide at least one field: ftp_watts / max_hr / weight_kg',
    'category.invalid': 'category must be training/race/recovery/leisure',
    'activity.not_found': 'activity not found',
    'note.too_long': 'note too long (max {n} chars)',
    'form.note.0': 'Very fresh — good for racing or hard testing',
    'form.note.1': 'Good form, well recovered',
    'form.note.2': 'Load and recovery balanced — sustainable training',
    'form.note.3': 'Fatigue is building — mind sleep and recovery',
    'form.note.4': 'Overtraining risk — consider a recovery week',
    'anom.power_gap': 'Power missing {duration}s, starting {at}',
    'anom.record_gap': 'Record missing {duration}s, starting {at}',
    'anom.timer_pause': 'Timer paused {duration}s, starting {at}',
    'anom.hr_jump': 'Heart rate jump {from}→{to} at {at}',
    'anom.other': '{text}',
  },
};

/** 取当前语言的文案并做 {var} 插值；未知 key / 语言缺失时回落 zh / 原 key */
export function t(lang: unknown, key: string, vars?: Record<string, string | number>): string {
  const dict = DICT[normalizeLang(lang)] ?? DICT.zh;
  let s = dict[key] ?? DICT.zh[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(v == null ? '' : String(v));
    }
  }
  return s;
}

/** TSB 状态简评（zh 文案与历史 formNote 逐字一致，供 computeForm 按语言生成） */
export function formNote(tsb: number, lang: Lang = 'zh'): string {
  if (tsb >= 15) return t(lang, 'form.note.0');
  if (tsb >= 5) return t(lang, 'form.note.1');
  if (tsb >= -10) return t(lang, 'form.note.2');
  if (tsb >= -20) return t(lang, 'form.note.3');
  return t(lang, 'form.note.4');
}

/**
 * 结构化异常标注 → 展示文本。
 * 新格式：{ type: "power_gap"|"record_gap"|"timer_pause"|"hr_jump", duration_sec?, from?, to?, at }
 * 旧数据（字符串 anomalies）原样透传，不做翻译。
 */
export function formatAnomaly(a: unknown, lang: Lang = 'zh'): string {
  if (typeof a === 'string') return a;
  if (!a || typeof a !== 'object') return '';
  const an = a as Record<string, any>;
  switch (an.type) {
    case 'power_gap':
      return t(lang, 'anom.power_gap', { duration: an.duration_sec, at: an.at });
    case 'record_gap':
      return t(lang, 'anom.record_gap', { duration: an.duration_sec, at: an.at });
    case 'timer_pause':
      return t(lang, 'anom.timer_pause', { duration: an.duration_sec, at: an.at });
    case 'hr_jump':
      return t(lang, 'anom.hr_jump', { from: an.from, to: an.to, at: an.at });
    default:
      return t(lang, 'anom.other', { text: an.text ?? String(an) });
  }
}
