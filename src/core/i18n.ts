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
    'profile.type': '{key} 需为字符串',
    'profile.too_long': '{key} 过长（上限 {n} 字）',
    // ---- AI 配置与记忆校验消息（src/db，M3 自 reference/src/i18n.js 逐字搬运） ----
    'ai.key_type': 'api_key 需为字符串',
    'ai.base_url': 'base_url 需为 http(s) 地址',
    'ai.model': 'model 不能为空',
    'ai.temperature': 'temperature 需在 0–2 之间，或留空表示不传',
    'ai.ms': '{key} 需为 ≥1000 的毫秒数',
    'ai.none': '至少需要提供一个字段：api_key / base_url / model / temperature / timeout_ms / stream / stall_ms / agentic',
    'memory.empty': '记忆内容不能为空',
    'memory.too_long': '记忆内容过长（上限 {n} 字）',
    'memory.supersede_not_found': '要取代的记忆不存在: {id}',
    'srv.report_body': '训练分析报告：',
    'srv.training_data': '本次训练数据（供引用具体细节）：',
    // ---- FTP 历史估算（src/core/ftp.ts data_needs / notes / confidence / references；zh 与旧版逐字一致） ----
    'ftp.few_rides': '窗口内有效功率骑行仅 {n} 次（需 ≥{min} 次）：请积累更多佩戴功率计的骑行数据后再估算',
    'ftp.hr_coverage': '仅 {n}/{total} 次骑行有合格心率数据：后续骑行请全程佩戴心率带，以便心率交叉验证',
    'ftp.no_20min': '窗口内没有一次骑行包含连续 20 分钟的数据：请安排一次 ≥30 分钟、且含持续 20 分钟高功率输出的骑行（户外长坡或室内台子均可）',
    'ftp.cp_unavailable': 'CP 模型不可用（5min 与 20min 峰功率形态退化）：CP 法被跳过，仅采用 Coggan 法',
    'ftp.cp_precision': '为提高 CP 模型精度：可做一次充分休息后的 3–8 分钟全力骑行（刷新无氧锚点）',
    'ftp.not_maximal': '20min 峰功率所在骑行（{date}）心率峰值仅 {hr}bpm（全力阈值 ≥{thr}bpm）：该 20 分钟大概率不是全力输出，FTP 估值偏保守',
    'ftp.maximal_test': '需要一次充分休息后的 20 分钟全力测试（佩戴心率带、心率峰值应接近阈值区间），作为可靠的 FTP 锚点',
    'ftp.anchor_no_hr': '20min 峰功率所在骑行缺少心率数据，无法判定是否全力输出',
    'ftp.anchor_hr': '下次做 20 分钟高功率骑行时请佩戴心率带，用于判定输出是否接近全力',
    'ftp.power_above_hr': '功率高强度（Z5+）时间占比 {p}% 显著高于心率高强度（Z4+）占比 {h}%：当前 FTP 配置可能被低估（同样心率下能输出更高功率），或心率带数据异常',
    'ftp.hr_above_power': '心率高强度（Z4+）时间占比 {h}% 显著高于功率高强度（Z5+）占比 {p}%：当前 FTP 配置可能被高估，或存在疲劳/高温/脱水导致的心率漂移',
    'ftp.drift': '窗口内骑行心率漂移中位数 {d}%（> {t}%）：存在明显的有氧解耦（疲劳累积/脱水/高温），近期数据用于 FTP 推断时需谨慎',
    'ftp.confidence.high': '两种方法结果一致且心率验证通过，可信度高',
    'ftp.confidence.medium': '存在警告项（非全力锚点/区间偏移/心率漂移/单一方法），估值供参考',
    'ftp.confidence.low': '样本量不足，估值仅供参考，请按下方清单补充数据后重新估算',
    'ftp.ref.0': 'Morton 双参数临界功率模型：P(t) = CP + W′/t，由 5min/20min 峰功率解出 CP ≈ FTP',
    'ftp.ref.1': 'Coggan & Allen《Training and Racing with a Power Meter》：FTP ≈ 20min 峰功率 × 0.95',
    'ftp.ref.2': '心率交叉验证：全力阈值测试心率峰值应接近 HRmax 高位；功率/心率区间系统性偏移提示 FTP 配置漂移',
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
    'profile.type': '{key} must be a string',
    'profile.too_long': '{key} too long (max {n} chars)',
    'ftp.few_rides': 'Only {n} rides in the window have valid power (need ≥{min}): record more power-meter rides before estimating',
    'ftp.hr_coverage': 'Only {n}/{total} rides have valid HR data: wear a HR strap on all rides so HR cross-checking is possible',
    'ftp.no_20min': 'No ride in the window has 20 continuous minutes of data: do a ≥30 min ride with a sustained 20 min high-power effort (long outdoor climb or indoor trainer)',
    'ftp.cp_unavailable': 'CP model unavailable (5min/20min peak power shape degraded): CP method skipped, using Coggan method only',
    'ftp.cp_precision': 'For better CP-model precision: do a fresh 3–8 min all-out effort (refresh the anaerobic anchor)',
    'ftp.not_maximal': 'The ride with the 20min peak power ({date}) peaked at only {hr}bpm (all-out threshold ≥{thr}bpm): that 20 min was likely not maximal, so the FTP estimate is conservative',
    'ftp.maximal_test': 'Do a well-rested 20-minute all-out test (wear a HR strap; peak HR should approach the threshold zone) as a reliable FTP anchor',
    'ftp.anchor_no_hr': 'The ride with the 20min peak power has no HR data, so whether the effort was maximal cannot be judged',
    'ftp.anchor_hr': 'Wear a HR strap on your next 20-minute high-power ride so effort can be checked against near-maximal output',
    'ftp.power_above_hr': 'Time in high power zones (Z5+) is {p}% vs {h}% in high HR zones (Z4+): FTP is likely underestimated (more power at the same HR), or the HR strap data is abnormal',
    'ftp.hr_above_power': 'Time in high HR zones (Z4+) is {h}% vs {p}% in high power zones (Z5+): FTP is likely overestimated, or fatigue/heat/dehydration is causing HR drift',
    'ftp.drift': 'Median HR drift across rides in the window is {d}% (> {t}%): clear aerobic decoupling (fatigue/dehydration/heat) — be careful using recent data for FTP inference',
    'ftp.confidence.high': 'Both methods agree and HR cross-checks pass — high confidence',
    'ftp.confidence.medium': 'Warning items present (non-maximal anchor / zone mismatch / HR drift / single method) — treat as a reference',
    'ftp.confidence.low': 'Sample too small — reference only; collect more data per the list below and re-estimate',
    'ftp.ref.0': 'Morton two-parameter critical power model: P(t) = CP + W′/t, CP ≈ FTP solved from 5min/20min peak power',
    'ftp.ref.1': 'Coggan & Allen, Training and Racing with a Power Meter: FTP ≈ 20min peak power × 0.95',
    'ftp.ref.2': 'HR cross-check: all-out test peak HR should approach HRmax; systematic power/HR zone mismatch hints at FTP drift',
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
    'ai.key_type': 'api_key must be a string',
    'ai.base_url': 'base_url must be an http(s) URL',
    'ai.model': 'model must not be empty',
    'ai.temperature': 'temperature must be between 0 and 2, or left empty to omit',
    'ai.ms': '{key} must be a number of milliseconds ≥ 1000',
    'ai.none': 'Provide at least one field: api_key / base_url / model / temperature / timeout_ms / stream / stall_ms / agentic',
    'memory.empty': 'memory content must not be empty',
    'memory.too_long': 'memory content too long (max {n} chars)',
    'memory.supersede_not_found': 'memory to supersede not found: {id}',
    'srv.report_body': 'Training analysis report:',
    'srv.training_data': 'Data for this workout (to cite specifics):',
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
