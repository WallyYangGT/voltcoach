/**
 * i18n.ts（core 层）— 数据层本地化：结构化异常与 form 状态的按语言渲染
 *
 * 移植自 fit-reader Web 版 src/i18n.js 的 normalizeLang / t / formNote / formatAnomaly
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
    // ---- AI 配置与记忆校验消息（src/db，M3 自 fit-reader Web 版 src/i18n.js 逐字搬运） ----
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
    // ---- 未来负荷推演与课表生成（src/planning，M3 自 fit-reader Web 版 src/i18n.js 逐字搬运） ----
    'plan.tsb_recovery': '当前 TSB {tsb} 低于 {thr}，身体未恢复，自动降级为恢复骑',
    'plan.unknown_type': '未知课表类型: {target}（可选: {opts}）',
    'plan.too_short': '{dur} 分钟装不下 {label} 课表（热身 {w} + 至少 {reps}×{min} 分钟主组 + 冷身 {c}），请增加时长或换低时长课表',
    'sim.tsb_low': 'TSB 连续 {days} 天低于 {thr}，深度疲劳风险',
    'sim.ctl_ramp': 'CTL 周增幅 {pct}% 超过 {thr}%，过度训练风险',
    // ---- 结构化训练计划（src/core/training-plan，v2 训练计划载体） ----
    'tp.no_block': '报告未包含 plan-json 计划数据块（```plan-json 围栏）',
    'tp.bad_json': '计划数据块不是合法 JSON：{msg}',
    'tp.shape': '计划数据结构不完整（需 valid_from / valid_to / goal / sessions）',
    'tp.date_invalid': '{key} 需为合法日期（YYYY-MM-DD）',
    'tp.window': '计划有效期需为 {min}–{max} 天（当前 {n} 天）',
    'tp.from_past': 'valid_from 最早为 {n} 天前，不能更早',
    'tp.to_past': 'valid_to 已早于今天（{date}），计划必须覆盖未来',
    'tp.session_empty': 'sessions 需为非空数组',
    'tp.session_shape': '第 {i} 条课次结构不完整（需 date / type / duration_min）',
    'tp.session_date': '第 {i} 条课次日期非法（需 YYYY-MM-DD）',
    'tp.session_dup': '日期 {date} 有多条课次（一天至多一课）',
    'tp.session_range': '第 {i} 条课次日期 {date} 超出计划有效期',
    'tp.type_invalid': '第 {i} 条课次类型「{type}」不支持（可选：{opts}）',
    'tp.duration_invalid': '第 {i} 条课次时长需为 10–600 的整数（rest 课留空）',
    'tp.tss_invalid': '第 {i} 条课次 tss 需为 0–500 的数值',
    'tp.warn.quality_gap': '{a} 与 {b} 两节质量课仅隔 {n} 天（同刺激质量课间隔需 ≥48h）',
    'tp.warn.no_rest': '{range}（一整周）没有休息日',
    'tp.warn.no_recovery': '{a} 起连续 {n} 周没有减量周（周计划 TSS 均高于最大周的 70%）',
    'tp.tool.report_source': '训练计划只能在对话中调整，报告生成场景不能修改计划',
    'tp.tool.adjust_hint': '请向用户解释以上原因，并给出满足训练节奏约束的替代调整方案',
    // ---- agentic 工具层消息（src/tools，M3 自 fit-reader Web 版 src/i18n.js 逐字搬运） ----
    'tool.date_invalid': '{key} 需为 YYYY-MM-DD',
    'tool.name_invalid': 'file_name 非法',
    'tool.summary_not_found': '训练库中找不到: {name}',
    'tool.records_not_found': '找不到时序数据: {name}',
    'tool.plan_array': 'plan 需为非空数组 [{date, tss}]',
    'tool.plan_max_days': 'plan 最多 {n} 天',
    'tool.plan_date': 'plan 中 date 需为 YYYY-MM-DD',
    'tool.plan_tss': 'plan 中 tss 需为数值',
    'tool.duration_invalid': 'duration_minutes 需为 15–300 的整数',
    'tool.dossier_empty': '训练库中暂无骑行数据，档案尚未生成',
    'tool.flag_invalid': 'flagged 需为布尔值',
    'tool.scale_invalid': 'scale_factor 需为数值（0.5–1.5）',
    'tool.no_power_data': '该训练没有功率数据（{name}），无法校准',
    'tool.unknown': '未知工具: {name}',
    'tool.failed': '工具执行失败: {msg}',
    'tool.result_truncated': '（结果已截断）',
    // ---- AI 请求层（src/ai，M3 自 fit-reader Web 版 src/i18n.js 逐字搬运） ----
    'ai.no_key': '未配置 AI 密钥（Web 设置页可配），无法调用 AI API',
    'ai.stall': 'AI 流已空闲超过 {sec} 秒未收到数据。可能是该模型/账号不真正流式输出，建议在设置页关闭流式。',
    'ai.total_timeout': 'AI 请求总时间超过 {sec} 秒。若模型确实需要更久，可在设置页增大超时时间；否则建议检查网络/API 可用性。',
    'ai.rounds_exhausted': '工具调用次数已用完，请基于已获得的信息直接作答。',
    'ai.empty': 'AI API 返回为空',
    // 传输级失败（正文为空/破损、读取中断）与自动重试——2026-09-22 真机 JSON 解析事故加固
    'ai.empty_body': 'AI 服务返回空响应（HTTP {status}）',
    'ai.empty_body_hint': '：连接可能被网关/代理中断，建议稍后重试或改用更短的报告场景。',
    'ai.bad_json': 'AI 响应不是完整 JSON（HTTP {status}，收到 {chars} 字符）：{head}',
    'ai.bad_sse': 'AI 流式帧被截断（连接中断）：{head}',
    'ai.stream_empty': 'AI API 流返回为空',
    'ai.read_failed': 'AI 响应读取失败：{msg}',
    'ai.network_failed': 'AI 连接失败：{msg}',
    'ai.retried_note': '（已自动重试 {n} 次）',
    // 前台服务保活（src/ai/keepalive，2026-10-11 推翻「不做保活」决策）：生成期间
    // dataSync FGS 的通知文案（传给原生模块前按语言取好）
    'ai.keepalive_title': 'AI 生成进行中',
    'ai.keepalive_body': '切到后台也会继续生成，完成后回 App 查看',
    'ai.keepalive_channel': 'AI 生成',
    // 同步保活（顽鹿同步复用同一保活壳，decisions §15）：首次 90 天全量是分钟级任务，
    // 同步期间退后台不被冻结；渠道 ID 固定为原生侧 generation_keepalive，此处仅显示名
    'sync.keepalive_title': '顽鹿同步进行中',
    'sync.keepalive_body': '正在从云端拉取训练数据，可切后台等待',
    'sync.keepalive_channel': '数据同步',
    // ---- 编排层消息（src/services/aiGenerate，M3 自 fit-reader Web 版 src/i18n.js 逐字搬运） ----
    'srv.ai_key_missing': '未配置 AI 密钥（设置页可配），无法使用对话',
    'srv.mode_invalid': 'mode 需为 follow_up/chat/plan',
    'srv.message_empty': 'message 不能为空',
    'srv.message_too_long': 'message 过长（上限 {n} 字）',
    'srv.chat_id_invalid': 'chat_id 参数无效',
    'srv.chat_not_found': '对话不存在',
    'srv.library_empty': '训练库为空',
    'srv.race_date': 'race_date 需为 YYYY-MM-DD',
    'srv.compare_not_found': '对比训练在训练库中找不到',
    'srv.unknown_mode': '未知 mode: {mode}',
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
    'ftp.flagged_excluded': '窗口内有 {n} 次骑行被标记「功率不可信」，已从估算样本剔除；如需纳入请先校准（recalibrate_activity_power）或取消标记',
    'ftp.power_above_hr': '功率高强度（Z5+）时间占比 {p}% 显著高于心率高强度（Z4+）占比 {h}%：当前 FTP 配置可能被低估（同样心率下能输出更高功率），或心率带数据异常',
    'ftp.hr_above_power': '心率高强度（Z4+）时间占比 {h}% 显著高于功率高强度（Z5+）占比 {p}%：当前 FTP 配置可能被高估，或存在疲劳/高温/脱水导致的心率漂移',
    'ftp.drift': '窗口内骑行心率漂移中位数 {d}%（> {t}%）：存在明显的有氧解耦（疲劳累积/脱水/高温），近期数据用于 FTP 推断时需谨慎',
    'ftp.confidence.high': '两种方法结果一致且心率验证通过，可信度高',
    'ftp.confidence.medium': '存在警告项（非全力锚点/区间偏移/心率漂移/单一方法），估值供参考',
    'ftp.confidence.low': '样本量不足，估值仅供参考，请按下方清单补充数据后重新估算',
    'ftp.ref.0': 'Morton 双参数临界功率模型：P(t) = CP + W′/t，由 5min/20min 峰功率解出 CP ≈ FTP',
    'ftp.ref.1': 'Coggan & Allen《Training and Racing with a Power Meter》：FTP ≈ 20min 峰功率 × 0.95',
    'ftp.ref.2': '心率交叉验证：全力阈值测试心率峰值应接近 HRmax 高位；功率/心率区间系统性偏移提示 FTP 配置漂移',
    // ---- FTP 自动采纳门槛（ftp.ts evaluateFtpApply 的拒绝原因，AI 工具转述给用户） ----
    'ftp.apply.no_data': '窗口内没有可用的 FTP 估算（缺少含 20 分钟连续输出的骑行），无法自动更新',
    'ftp.apply.few_rides': '窗口内有效功率骑行次数不足（需 ≥{min} 次），样本太少不宜自动更新',
    'ftp.apply.low_confidence': 'FTP 估算置信度低（样本不足），不宜自动更新；建议按数据需求清单补充骑行后重试',
    'ftp.apply.inconsistent': 'CP 模型与 Coggan 法估算相差超过 {pct}%，两种方法互斥，估值不可信',
    'ftp.apply.not_maximal': '20min 峰功率所在骑行的心率未达全力阈值，估值大概率偏低，不宜据此自动更新',
    'ftp.apply.stale': '最近一次骑行距今天已超过 {n} 天，数据不够新鲜，不宜自动更新',
    'ftp.apply.no_change': '估算值与当前 FTP 一致，无需更新',
    'ftp.apply.range': '估算值 {w}W 超出可采纳范围（{lo}–{hi}W）',
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
    'anom.stationary': '计时未停的静止 {duration}s，起始 {at}',
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
    'ftp.flagged_excluded': '{n} rides in the window are flagged power-untrusted and excluded from the sample; calibrate (recalibrate_activity_power) or clear the flag to include them',
    'ftp.power_above_hr': 'Time in high power zones (Z5+) is {p}% vs {h}% in high HR zones (Z4+): FTP is likely underestimated (more power at the same HR), or the HR strap data is abnormal',
    'ftp.hr_above_power': 'Time in high HR zones (Z4+) is {h}% vs {p}% in high power zones (Z5+): FTP is likely overestimated, or fatigue/heat/dehydration is causing HR drift',
    'ftp.drift': 'Median HR drift across rides in the window is {d}% (> {t}%): clear aerobic decoupling (fatigue/dehydration/heat) — be careful using recent data for FTP inference',
    'ftp.confidence.high': 'Both methods agree and HR cross-checks pass — high confidence',
    'ftp.confidence.medium': 'Warning items present (non-maximal anchor / zone mismatch / HR drift / single method) — treat as a reference',
    'ftp.confidence.low': 'Sample too small — reference only; collect more data per the list below and re-estimate',
    'ftp.ref.0': 'Morton two-parameter critical power model: P(t) = CP + W′/t, CP ≈ FTP solved from 5min/20min peak power',
    'ftp.ref.1': 'Coggan & Allen, Training and Racing with a Power Meter: FTP ≈ 20min peak power × 0.95',
    'ftp.ref.2': 'HR cross-check: all-out test peak HR should approach HRmax; systematic power/HR zone mismatch hints at FTP drift',
    'ftp.apply.no_data': 'No usable FTP estimate in the window (no ride with 20 continuous minutes of output) — cannot auto-update',
    'ftp.apply.few_rides': 'Too few rides with valid power in the window (need ≥{min}) — sample too thin to auto-update',
    'ftp.apply.low_confidence': 'FTP estimate confidence is low (thin sample) — auto-update not advisable; collect more rides per the data-needs list and retry',
    'ftp.apply.inconsistent': 'CP model and Coggan estimates differ by more than {pct}% — the methods contradict each other, estimate untrustworthy',
    'ftp.apply.not_maximal': 'The ride holding the 20min peak power did not reach the all-out HR threshold — the estimate is likely low, do not auto-update from it',
    'ftp.apply.stale': 'The most recent ride is more than {n} days old — data not fresh enough to auto-update',
    'ftp.apply.no_change': 'The estimate matches the current FTP — no update needed',
    'ftp.apply.range': 'Estimated value {w}W is outside the applicable range ({lo}–{hi}W)',
    'form.note.0': 'Very fresh — good for racing or hard testing',
    'form.note.1': 'Good form, well recovered',
    'form.note.2': 'Load and recovery balanced — sustainable training',
    'form.note.3': 'Fatigue is building — mind sleep and recovery',
    'form.note.4': 'Overtraining risk — consider a recovery week',
    'anom.power_gap': 'Power missing {duration}s, starting {at}',
    'anom.record_gap': 'Record missing {duration}s, starting {at}',
    'anom.timer_pause': 'Timer paused {duration}s, starting {at}',
    'anom.stationary': 'Stationary with the timer running {duration}s, at {at}',
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
    'plan.tsb_recovery': 'Current TSB {tsb} is below {thr} — body not recovered, auto-downgraded to a recovery ride',
    'plan.unknown_type': 'Unknown workout type: {target} (options: {opts})',
    'plan.too_short': '{dur} minutes cannot fit the {label} workout (warmup {w} + at least {reps}×{min} min main sets + cooldown {c}) — increase the duration or pick a shorter workout',
    'sim.tsb_low': 'TSB below {thr} for {days} consecutive days — deep fatigue risk',
    'sim.ctl_ramp': 'CTL weekly ramp {pct}% exceeds {thr}% — overtraining risk',
    'tp.no_block': 'Report has no plan-json data block (```plan-json fence)',
    'tp.bad_json': 'The plan-json block is not valid JSON: {msg}',
    'tp.shape': 'Incomplete plan structure (needs valid_from / valid_to / goal / sessions)',
    'tp.date_invalid': '{key} must be a valid date (YYYY-MM-DD)',
    'tp.window': 'Plan validity must span {min}–{max} days (got {n})',
    'tp.from_past': 'valid_from may be at most {n} days in the past',
    'tp.to_past': 'valid_to is before today ({date}) — the plan must cover the future',
    'tp.session_empty': 'sessions must be a non-empty array',
    'tp.session_shape': 'Session {i} is incomplete (needs date / type / duration_min)',
    'tp.session_date': 'Session {i} has an invalid date (YYYY-MM-DD required)',
    'tp.session_dup': 'Duplicate date {date} (at most one session per day)',
    'tp.session_range': 'Session {i} date {date} falls outside the plan validity window',
    'tp.type_invalid': 'Session {i} type "{type}" is not supported (options: {opts})',
    'tp.duration_invalid': 'Session {i} duration must be an integer from 10–600 minutes (leave empty for rest)',
    'tp.tss_invalid': 'Session {i} tss must be a number from 0–500',
    'tp.warn.quality_gap': 'Quality sessions on {a} and {b} are only {n} days apart (same-stimulus quality sessions need ≥48h)',
    'tp.warn.no_rest': '{range} (a full week) has no rest day',
    'tp.warn.no_recovery': '{n} consecutive weeks from {a} without a recovery week (weekly planned TSS always above 70% of the max week)',
    'tp.tool.report_source': 'The training plan can only be adjusted in conversations — report generation must not modify it',
    'tp.tool.adjust_hint': 'Explain these reasons to the user and propose an alternative adjustment that satisfies the training-rhythm constraints',
    'tool.date_invalid': '{key} must be YYYY-MM-DD',
    'tool.name_invalid': 'invalid file_name',
    'tool.summary_not_found': 'not found in training library: {name}',
    'tool.records_not_found': 'time-series data not found: {name}',
    'tool.plan_array': 'plan must be a non-empty array of [{date, tss}]',
    'tool.plan_max_days': 'plan may have at most {n} days',
    'tool.plan_date': 'date in plan must be YYYY-MM-DD',
    'tool.plan_tss': 'tss in plan must be numeric',
    'tool.duration_invalid': 'duration_minutes must be an integer from 15–300',
    'tool.dossier_empty': 'No rides in the training library yet; the dossier has not been built',
    'tool.flag_invalid': 'flagged must be a boolean',
    'tool.scale_invalid': 'scale_factor must be a number (0.5–1.5)',
    'tool.no_power_data': 'This ride has no power data ({name}) — nothing to calibrate',
    'tool.unknown': 'unknown tool: {name}',
    'tool.failed': 'tool execution failed: {msg}',
    'tool.result_truncated': '（result truncated）',
    'ai.no_key': 'No AI key configured (Settings page) — cannot call the AI API',
    'ai.stall': 'AI stream idle for over {sec} seconds with no data. The model/account may not truly stream — consider turning streaming off in Settings.',
    'ai.total_timeout': 'AI request exceeded {sec} seconds total. If the model genuinely needs longer, raise the timeout in Settings; otherwise check network/API availability.',
    'ai.rounds_exhausted': 'Tool call rounds exhausted — answer directly based on the information gathered so far.',
    'ai.empty': 'AI API returned empty',
    'ai.empty_body': 'AI service returned an empty response (HTTP {status})',
    'ai.empty_body_hint': ' — the connection was likely cut by a gateway/proxy. Retry later or use a shorter report scenario.',
    'ai.bad_json': 'AI response is not complete JSON (HTTP {status}, {chars} chars received): {head}',
    'ai.bad_sse': 'AI stream frame truncated (connection cut): {head}',
    'ai.stream_empty': 'AI API stream returned empty',
    'ai.read_failed': 'Failed to read the AI response: {msg}',
    'ai.network_failed': 'AI connection failed: {msg}',
    'ai.retried_note': ' (auto-retried {n}x)',
    'ai.keepalive_title': 'AI generation in progress',
    'ai.keepalive_body': 'Generation continues in the background — come back for the result',
    'ai.keepalive_channel': 'AI generation',
    'sync.keepalive_title': 'Onelap sync in progress',
    'sync.keepalive_body': 'Pulling training data from the cloud — you can leave the app',
    'sync.keepalive_channel': 'Data sync',
    'srv.ai_key_missing': 'No AI key configured (Settings page) — chat unavailable',
    'srv.mode_invalid': 'mode must be follow_up/chat/plan',
    'srv.message_empty': 'message must not be empty',
    'srv.message_too_long': 'message too long (max {n} chars)',
    'srv.chat_id_invalid': 'invalid chat_id',
    'srv.chat_not_found': 'chat not found',
    'srv.library_empty': 'training library is empty',
    'srv.race_date': 'race_date must be YYYY-MM-DD',
    'srv.compare_not_found': 'comparison workouts not found in the training library',
    'srv.unknown_mode': 'unknown mode: {mode}',
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
 * 新格式：{ type: "power_gap"|"record_gap"|"timer_pause"|"stationary"|"hr_jump", duration_sec?, from?, to?, at }
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
    case 'stationary':
      return t(lang, 'anom.stationary', { duration: an.duration_sec, at: an.at });
    case 'hr_jump':
      return t(lang, 'anom.hr_jump', { from: an.from, to: an.to, at: an.at });
    default:
      return t(lang, 'anom.other', { text: an.text ?? String(an) });
  }
}
