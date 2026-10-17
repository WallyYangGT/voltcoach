/**
 * defs.ts — AI agentic 工具 JSON schema 定义（自 fit-reader Web 版 src/tools.js 平移，只补类型）。
 * 双语：toolDefs(lang) 返回按语言本地化的工具 schema（描述随提示词语言切换）；
 * 执行层见 execute.ts（错误消息经 core/i18n 按 ctx.lang 生成）。
 */

import { AGENTIC } from '../core/settings.ts';
import type { Lang } from '../core/i18n.ts';

// ---------------- 工具 schema 定义（OpenAI tools 格式，按语言本地化） ----------------

const TOOL_TEXT: Record<Lang, Record<string, string>> = {
  zh: {
    list_activities: '查询训练简明清单（目录页）：日期/类型/分类/时长/距离/TSS/NP/IF。先用它找到目标训练的 file_name，再用 get_activity_summary 或 get_activity_records 深挖单次。',
    'list_activities.start_date': '起始日期 YYYY-MM-DD（含）',
    'list_activities.end_date': '结束日期 YYYY-MM-DD（含）',
    'list_activities.sport': '运动类型过滤，如 cycling / running / swimming',
    'list_activities.category': '训练分类过滤，如 训练 / 比赛 / 恢复 / 休闲',
    'list_activities.limit': '返回条数上限，最大 {n}',
    get_activity_summary: '取单次训练的完整汇总指标 JSON（NP/IF/TSS/分区分布/峰功率曲线/心率漂移/间歇/爬坡/备注等），入参为 list_activities 返回的 file_name。',
    'get_activity_summary.file_name': '训练文件名（list_activities 返回的 file_name）',
    get_activity_records: '取单次训练的逐秒时序（功率/心率/踏频/海拔/速度，抽稀后返回）。可用 start_sec/end_sec 只取时间窗片段（如最后 600 秒），不必取全程。',
    'get_activity_records.file_name': '训练文件名',
    'get_activity_records.start_sec': '时间窗起点（相对训练开始的秒数，含）',
    'get_activity_records.end_sec': '时间窗终点（相对训练开始的秒数，含）',
    get_form_series: '取最近 N 天逐日训练状态序列（CTL/ATL/TSB/TSS），用于判断疲劳与状态走势。',
    'get_form_series.days': '回看天数，最大 {n}',
    get_monthly_summary: '取逐月训练汇总（TSS/时长/距离/强度分布类型），用于长期负荷趋势。',
    'get_monthly_summary.months': '回看月数，最大 {n}',
    get_athlete_profile: '取骑手参数（FTP/最大心率/体重，含 athlete_configured 是否已校准）与用户档案：身份、训练目标、教练模式（coach_mode，null=未设置）、每周可用时间档（weekly_hours）、可骑的星期（available_days，空数组=未设置/不限）、单次时长上限（session_max_min）。',
    update_rider_profile: '更新骑手档案中的教练模式与时间预算（业余教练模式的结构化字段）：coach_mode（amateur 业余/健康导向、standard 系统训练提升）、weekly_hours（每周可用时间档）、available_days（可骑的星期 1=周一…7=周日，空数组=不限）、session_max_min（单次时长上限）。仅在用户明确回答首次模式询问、或主动提出「最近每周只能骑 X 小时」等变更时调用。⚠️ 确认协议：调用前先向用户复述将写入的内容（模式/时长档/可用日/单次上限）并获得用户肯定答复，不要抢跑；用户没提到的字段不要传（undefined = 不修改）。清空：coach_mode/weekly_hours 传空字符串；session_max_min 传 0；available_days 传空数组。',
    'update_rider_profile.coach_mode': 'amateur = 业余/健康导向（用户期望与可用时间主导）；standard = 系统训练提升（传统教练口径；档案未设置时不视为默认，须先询问用户）；传空字符串清空为未设置',
    'update_rider_profile.weekly_hours': '每周可用时间档：lt3 = 不足 3 小时；3to5 = 3–5 小时；5to8 = 5–8 小时；gt8 = 8 小时以上；传空字符串清空',
    'update_rider_profile.available_days': '可骑的星期编号数组：1=周一 … 7=周日；空数组 = 不限（也用于清空具体星期）',
    'update_rider_profile.session_max_min': '单次骑行时长上限（分钟，10–600）；传 0 表示清空（不设置）',
    estimate_ftp: '基于最近窗口期骑行的功率峰曲线与心率交叉验证估算 FTP（含置信度与数据需求），用户问 FTP 是否该调整时使用。',
    simulate_form: '未来负荷推演：给出未来逐日计划 TSS，按当前 CTL/ATL 推演 CTL/ATL/TSB 走势并标注风险（深度疲劳/CTL 周增幅过高）。用户问「如果我每周加练 X 会怎样」「赛前怎么减量」时使用。',
    'simulate_form.plan': '未来逐日计划（无训练日 tss=0），最多 {n} 天',
    'simulate_form.date': '日期 YYYY-MM-DD',
    'simulate_form.tss': '当日计划 TSS（0–1000）',
    'simulate_form.start_ctl': '起始 CTL；缺省取训练库当前值',
    'simulate_form.start_atl': '起始 ATL；缺省取训练库当前值',
    generate_workout: '按目标与可用时长生成单次课表：热身/主组（组数/时长/功率瓦特区间/组间休息）/冷身 + TSS 估算。用户问「今天有 X 小时，练什么」时使用。',
    'generate_workout.target': '课表类型：recovery 恢复 / endurance 有氧耐力 / sweet_spot 甜区 / threshold 阈值 / vo2max',
    'generate_workout.duration_minutes': '可用总时长（分钟，15–300）',
    'generate_workout.tsb': '当前 TSB（可选）；过低时自动降级为恢复课',
    save_memory: '保存一条关于用户的记忆（默认长期）。只要用户透露训练数据之外的个人事实或倾向（目标与赛事计划/伤病与身体不适/日程时间约束/训练偏好/器材/对建议的反馈与纠正/自述主观状态）就主动记录，不必等用户明确要求，宁多勿漏；训练数据本身已有的事实不要记。与用户商定的训练策略用 category=\'strategy\'（会以「既定结论」权威段置顶注入后续所有分析）；仅在近两三周有意义的临时上下文用 scope=\'short\'（到期自动失效）。',
    'save_memory.content': '记忆内容：带主语的完整陈述，≤500 字',
    'save_memory.category': '分类：general 通用 / injury 伤病 / schedule 日程 / goal 目标 / preference 偏好 / strategy 训练策略（与教练商定的既定结论）',
    'save_memory.scope': '记忆时效：short = 短期（超过两周或 5 次训练自动失效，适合临时上下文）；不传默认 long 长期',
    'save_memory.supersedes_id': '取代某条旧记忆的 id（注入的记忆清单中有 #id 标注），同主题更新时使用',
    get_dossier: '取个人训练档案（本地自动汇总的长期基线）：峰功率历史最佳与近 90 天、爬坡画像（坡度/强度/心率中位）、踏频风格占比、90 天强度结构、近 8 周负荷与心率漂移基线。评估进步/退步、定计划或讨论爬坡/踏频技术策略前先取它作对照，不要凭单次数据下长期结论。',
    get_training_plan: '取当前结构化训练计划：有效期（valid_from–valid_to 与剩余天数）、目标、逐课次安排（日期/课型/时长/强度区间/TSS/要点）。讨论计划、复盘执行对比、或周期规划生成新计划前先调用——存在现行或过期计划时按续订或替换处理并说明差异，不要无视既有计划直接重开。',
    update_training_plan: '提交调整后的完整训练计划（整体替换并生成新版本，旧版留档可回看）。仅用于用户明确要求调整时（换课/减量/顺延/加练）；会做格式与合理性校验（质量课间隔 ≥48h、每周休息日、减量周节奏、有效期覆盖未来），不通过返回具体原因——向用户解释原因并给合规替代方案，不要提交明知违规的计划，也不要只提交改动片段（必须整体重发）。少量课次的微调优先用 adjust_plan_sessions（免整体重发），本工具用于周期重规划或大面积重排。',
    'update_training_plan.plan': '完整计划对象：{valid_from, valid_to, goal, sessions:[{date, type, duration_min, intensity, tss, note}]}。type ∈ rest/recovery/endurance/long/sweet_spot/threshold/vo2max；rest 课 duration_min 留空；tss 可省略（按课型×时长估算回填）；一天至多一课',
    'update_training_plan.change_note': '一句话变更说明（如「周四阈值课顺延至周五」），记入版本历史供回看',
    adjust_plan_sessions: '对当前计划做课次级局部调整（顺延一节课/两课互换/改课型/改时长/删课/插课）：一次可提交多个操作、原子应用（任一失败整批拒绝、计划不变），只动目标课次、无需整体重发。仅用于用户明确要求的少量课次调整；周期重规划或大面积重排仍用 update_training_plan。约束：只能调整今天及以后的课；目标日已有课时两课互换用 swap、替换先 remove 再 insert；应用后会做全计划合理性复检（质量课间隔 ≥48h、每周休息日、减量周节奏），违规整批拒绝并返回原因。⚠️ 调用前必须先向用户复述具体变更（哪天什么课改成什么、from→to），获得用户肯定答复后方可调用——不要抢跑直接改计划。',
    'adjust_plan_sessions.ops': '操作数组（按序应用）：move{from,to} 把一节课移到空闲日 / swap{a,b} 互换两天的课 / set_type{date,type,duration_min?} 改课型（改训练课型需 duration_min；改 rest 清空时长）/ set_duration{date,duration_min} 改时长 / remove{date} 删课 / insert{date,type,duration_min,intensity?,note?} 插课（目标日须空闲）',
    'adjust_plan_sessions.change_note': '一句话变更说明（如「周一阈值课顺延至周二」），记入版本历史供回看',
    set_power_flag: '标记/取消某次骑行的「功率不可信」：功率计未校准、读数明显失真时使用（如 20 分钟峰功率无解释地大幅突进且心率无对应响应）。被标记的骑行会从训练档案的功率基线中排除（心率与时长仍保留），档案随之自动更新。可逆：误标可再次调用（flagged=false）取消。',
    'set_power_flag.file_name': '训练文件名（list_activities 返回的 file_name）',
    'set_power_flag.flagged': 'true = 标记为功率不可信；false = 取消标记',
    'set_power_flag.reason': '标记原因（须在本次回答中向用户转述），如「20min 功率较基线高 30% 且心率无对应响应」',
    recalibrate_activity_power: '按系数缩放重算某次骑行的全部功率派生指标并写回（功率计系统性校准偏差的修正）：逐秒功率 × scale 后重算 NP/平均/峰值功率/峰曲线/IF/TSS/区间/间歇/踏频-功率等，返回新旧指标对比。系数范围 0.5–1.5（越界被夹逼）；逐秒原始数据不改写，重导原文件或换系数重跑即可回退。仅在能给出可信依据（心率-功率交叉印证或用户明确告知偏差）时使用；拿不准时先 set_power_flag 标记。',
    'recalibrate_activity_power.file_name': '训练文件名（list_activities 返回的 file_name）',
    'recalibrate_activity_power.scale_factor': '缩放系数：真实功率 = 记录功率 × 系数（0.5–1.5）。如功率计普遍偏低 5%，传 1.05',
    update_ftp: '按当前最佳科学估算更新用户的 FTP 配置（无需参数，数值始终来自估算器而非模型自拟）。工具内部重新估算并硬校验数据量、两法一致性、全力锚点与数据新鲜度，不满足时返回拒绝原因与数据需求清单。',
    reanalyze_activity: '按当前骑手参数（FTP/最大心率/体重）重新分析一次训练并写回训练库：从已存逐秒数据重算 IF/TSS/功率心率区间/间歇识别等并覆盖该训练的分析结果，返回新旧指标对比。FTP 更新后可对受影响的训练（如估算锚点骑行）或用户指名的训练使用。',
    'reanalyze_activity.file_name': '训练文件名（list_activities 返回的 file_name）',
  },
  en: {
    list_activities: "Query the brief activity list (catalog page): date/type/category/duration/distance/TSS/NP/IF. Use it first to find the target activity's file_name, then dig into a single one with get_activity_summary or get_activity_records.",
    'list_activities.start_date': 'Start date YYYY-MM-DD (inclusive)',
    'list_activities.end_date': 'End date YYYY-MM-DD (inclusive)',
    'list_activities.sport': 'Sport filter, e.g. cycling / running / swimming',
    'list_activities.category': 'Category filter, e.g. training / race / recovery / leisure',
    'list_activities.limit': 'Max number of results, up to {n}',
    get_activity_summary: 'Get the full summary-metrics JSON of one activity (NP/IF/TSS/zone distribution/peak power curve/HR drift/intervals/climbs/notes etc.); input is the file_name returned by list_activities.',
    'get_activity_summary.file_name': 'Activity file name (file_name from list_activities)',
    get_activity_records: 'Get the per-second time series of one activity (power/HR/cadence/altitude/speed, thinned). Use start_sec/end_sec to fetch only a time window (e.g. the last 600 seconds) instead of the whole ride.',
    'get_activity_records.file_name': 'Activity file name',
    'get_activity_records.start_sec': 'Window start (seconds from ride start, inclusive)',
    'get_activity_records.end_sec': 'Window end (seconds from ride start, inclusive)',
    get_form_series: 'Get the daily form series for the last N days (CTL/ATL/TSB/TSS) to judge fatigue and form trends.',
    'get_form_series.days': 'Days to look back, up to {n}',
    get_monthly_summary: 'Get the monthly training summary (TSS/hours/distance/intensity distribution type) for long-term load trends.',
    'get_monthly_summary.months': 'Months to look back, up to {n}',
    get_athlete_profile: 'Get athlete parameters (FTP/max HR/weight, including athlete_configured) plus the rider profile: identity, training goal, coaching mode (coach_mode, null = unset), weekly available-time tier (weekly_hours), available days (available_days; empty array = unset/unrestricted), and per-session time cap (session_max_min).',
    update_rider_profile: "Update the rider profile fields for amateur coaching mode: coach_mode (amateur = health/time-first, standard = systematic training), weekly_hours (weekly available-time tier), available_days (1=Monday … 7=Sunday; empty array = unrestricted), session_max_min (per-session time cap in minutes). Call only when the rider answers the first-time mode question or proactively reports a change such as \"only 2 hours a week now\". ⚠️ Confirmation protocol: restate exactly what will be written (mode / hours tier / days / cap) and get the rider's explicit agreement before calling; never change the profile preemptively. Omit fields the rider did not mention (undefined = leave unchanged). Clearing: pass an empty string for coach_mode/weekly_hours, 0 for session_max_min, or an empty array for available_days.",
    'update_rider_profile.coach_mode': 'amateur = health/time-first (rider expectations and available time lead); standard = systematic performance training (the traditional coaching default, but NOT the default when the profile is unset — ask the rider first); pass an empty string to clear to unset',
    'update_rider_profile.weekly_hours': 'Weekly available-time tier: lt3 = under 3 h; 3to5 = 3–5 h; 5to8 = 5–8 h; gt8 = 8 h+; pass an empty string to clear',
    'update_rider_profile.available_days': 'Available weekday numbers 1=Monday … 7=Sunday; an empty array means unrestricted (also clears specific days)',
    'update_rider_profile.session_max_min': 'Per-session time cap in minutes (10–600); pass 0 to clear (unset)',
    estimate_ftp: 'Estimate FTP from rides in the recent window using peak power curves and HR cross-validation (with confidence and data needs). Use when the user asks whether FTP should be adjusted.',
    simulate_form: 'Future load simulation: given a daily plan TSS, project the CTL/ATL/TSB trend and flag risks (deep fatigue / CTL weekly ramp too high). Use when the user asks "what if I add X per week" or "how should I taper".',
    'simulate_form.plan': 'Future daily plan (rest days tss=0), up to {n} days',
    'simulate_form.date': 'Date YYYY-MM-DD',
    'simulate_form.tss': 'Planned TSS for the day (0–1000)',
    'simulate_form.start_ctl': 'Starting CTL; defaults to the current library value',
    'simulate_form.start_atl': 'Starting ATL; defaults to the current library value',
    generate_workout: 'Build a single workout by target and available time: warmup/main sets (reps/duration/watt range/rest)/cooldown + TSS estimate. Use when the user asks "I have X hours today, what should I do".',
    'generate_workout.target': 'Workout type: recovery / endurance / sweet_spot / threshold / vo2max',
    'generate_workout.duration_minutes': 'Total available time (minutes, 15–300)',
    'generate_workout.tsb': 'Current TSB (optional); auto-downgrades to recovery when too low',
    save_memory: "Save a memory about the user (long-term by default). Proactively record whenever the user reveals personal facts or preferences beyond training data (goals and race plans / injuries and physical issues / schedule-time constraints / training preferences / equipment / feedback on and corrections to your advice / self-reported subjective state) — better too many than too few, don't wait to be asked; facts already present in the training data need not be recorded. Training strategies agreed with the user use category='strategy' (rendered as the authoritative Training-Strategies block in all future analyses); temporary context meaningful only for the next couple of weeks uses scope='short' (auto-expires).",
    'save_memory.content': 'Memory content: a complete statement with a subject, ≤500 chars',
    'save_memory.category': 'Category: general / injury / schedule / goal / preference / strategy (agreed training conclusions)',
    'save_memory.scope': "Memory freshness: short = short-term (auto-expires after two weeks or 5 activities; for temporary context); omit for long (default)",
    'save_memory.supersedes_id': "id of an old memory to supersede (ids are #annotated in the injected memory list); use when updating the same topic",
    get_dossier: "Fetch the athlete dossier (auto-aggregated long-term baseline): all-time and 90-day peak power, climb profile (median grade/intensity/HR), cadence style shares, 90-day intensity structure, last-8-weeks load and HR-drift baseline. Consult it before judging progress, planning, or discussing climbing/cadence technique — never draw long-term conclusions from a single ride.",
    get_training_plan: "Fetch the current structured training plan: validity window (valid_from–valid_to and days remaining), goal, and per-session layout (date/type/duration/intensity zone/TSS/notes). Call it before discussing the plan, comparing execution, or generating a new plan in periodic planning — when a current or expired plan exists, renew or replace it and state the differences; never ignore the existing plan and start over.",
    update_training_plan: "Submit the FULLY adjusted training plan (replaces wholesale and creates a new version; old versions are kept for review). Only for explicit user adjustment requests (swap sessions / reduce load / shift days / add work). It runs format and sanity checks (quality-session spacing ≥48h, weekly rest days, recovery-week rhythm, validity covering the future) and returns concrete reasons on failure — explain them to the user and offer a compliant alternative; never submit a plan you know violates the rules, and never send only a diff (always resend the whole plan). For small tweaks of a few sessions prefer adjust_plan_sessions (no full resend); this tool is for replanning or large-scale reshuffles.",
    'update_training_plan.plan': 'Full plan object: {valid_from, valid_to, goal, sessions:[{date, type, duration_min, intensity, tss, note}]}. type ∈ rest/recovery/endurance/long/sweet_spot/threshold/vo2max; leave duration_min empty for rest sessions; tss may be omitted (estimated from type × duration); at most one session per day',
    'update_training_plan.change_note': 'One-line change summary (e.g. "Thursday threshold moved to Friday"), recorded in the version history',
    adjust_plan_sessions: "Make session-level local adjustments to the current plan (shift one session / swap two days / change type / change duration / remove / insert): multiple operations per call, applied atomically (any failure rejects the whole batch and the plan is untouched) — only targeted sessions change, no full resend. Only for small user-requested adjustments; for replanning or large-scale reshuffles still use update_training_plan. Constraints: only today and later can be adjusted; when the target day has a session, use swap to exchange or remove + insert to replace; a full-plan sanity check runs after applying (quality-session spacing ≥48h, weekly rest days, recovery-week rhythm) and any violation rejects the batch with reasons. ⚠️ Before calling, restate the concrete change to the user (which day, what changes into what, from→to) and call only after the user agrees — never modify the plan without confirmation.",
    'adjust_plan_sessions.ops': 'Operations array (applied in order): move{from,to} shift a session to a free day / swap{a,b} exchange two days / set_type{date,type,duration_min?} change type (training types need duration_min; rest clears it) / set_duration{date,duration_min} change duration / remove{date} delete / insert{date,type,duration_min,intensity?,note?} insert (target day must be free)',
    'adjust_plan_sessions.change_note': 'One-line change summary (e.g. "Monday threshold moved to Tuesday"), recorded in the version history',
    set_power_flag: "Flag/unflag a ride as power-untrusted: use when the power meter was uncalibrated or readings are clearly distorted (e.g. an unexplained 20-min peak jump with no HR response). Flagged rides are excluded from the dossier's power baselines (HR and duration are kept) and the dossier updates automatically. Reversible: call again with flagged=false to unflag.",
    'set_power_flag.file_name': 'Activity file name (file_name from list_activities)',
    'set_power_flag.flagged': 'true = flag as power-untrusted; false = clear the flag',
    'set_power_flag.reason': 'Reason for the flag (restate it to the user in your reply), e.g. "20min power 30% above baseline with no HR response"',
    recalibrate_activity_power: "Rescale and recompute all power-derived metrics of one ride and write back (corrects a systematic power-meter calibration offset): per-second power × scale, then recompute NP/avg/peak power/peak curve/IF/TSS/zones/intervals/cadence-power etc., returning an old-vs-new diff. Scale range 0.5–1.5 (clamped); raw per-second data is not rewritten — re-import the original file or re-run with another factor to revert. Use only with a credible basis (HR-power cross-check or a user-stated offset); when unsure, set_power_flag first.",
    'recalibrate_activity_power.file_name': 'Activity file name (file_name from list_activities)',
    'recalibrate_activity_power.scale_factor': 'Scale factor: true power = recorded power × factor (0.5–1.5). E.g. if the meter reads ~5% low, pass 1.05',
    update_ftp: "Update the user's FTP configuration from the current best scientific estimate (no arguments; the value always comes from the estimator, never invented by the model). The tool re-estimates internally and hard-validates data volume, method consistency, all-out anchor and data freshness; when unmet it returns the refusal reason and data-needs list.",
    reanalyze_activity: "Re-analyze one activity with the current athlete parameters (FTP/max HR/weight) and write it back to the library: recomputes IF/TSS/power-HR zones/interval detection etc. from stored per-second data, overwrites that activity's analysis results, and returns an old-vs-new metrics diff. Use after an FTP update for affected rides (e.g. the anchor ride) or rides the user names.",
    'reanalyze_activity.file_name': 'Activity file name (file_name from list_activities)',
  },
};

const LANG_T = (lang: Lang, key: string, vars?: Record<string, string | number>): string => {
  const tpl = TOOL_TEXT[lang]?.[key] ?? TOOL_TEXT.zh[key] ?? key;
  if (!vars) return tpl;
  return Object.entries(vars).reduce(
    (s, [k, v]) => s.split(`{${k}}`).join(v == null ? '' : String(v)),
    tpl,
  );
};

/** OpenAI tools 格式的单个工具定义 */
export interface ToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/** 工具 JSON schema（描述按语言本地化；OpenAI tools 格式） */
export function toolDefs(lang: Lang = 'zh'): ToolDef[] {
  const L = (key: string, vars?: Record<string, string | number>) => LANG_T(lang, key, vars);
  return [
    {
      type: 'function',
      function: {
        name: 'list_activities',
        description: L('list_activities'),
        parameters: {
          type: 'object',
          properties: {
            start_date: { type: 'string', description: L('list_activities.start_date') },
            end_date: { type: 'string', description: L('list_activities.end_date') },
            sport: { type: 'string', description: L('list_activities.sport') },
            category: { type: 'string', description: L('list_activities.category') },
            limit: { type: 'integer', description: L('list_activities.limit', { n: AGENTIC.list_limit }) },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_activity_summary',
        description: L('get_activity_summary'),
        parameters: {
          type: 'object',
          properties: {
            file_name: { type: 'string', description: L('get_activity_summary.file_name') },
          },
          required: ['file_name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_activity_records',
        description: L('get_activity_records'),
        parameters: {
          type: 'object',
          properties: {
            file_name: { type: 'string', description: L('get_activity_records.file_name') },
            start_sec: { type: 'integer', description: L('get_activity_records.start_sec') },
            end_sec: { type: 'integer', description: L('get_activity_records.end_sec') },
          },
          required: ['file_name'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_form_series',
        description: L('get_form_series'),
        parameters: {
          type: 'object',
          properties: {
            days: { type: 'integer', description: L('get_form_series.days', { n: AGENTIC.form_max_days }) },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_monthly_summary',
        description: L('get_monthly_summary'),
        parameters: {
          type: 'object',
          properties: {
            months: { type: 'integer', description: L('get_monthly_summary.months', { n: AGENTIC.monthly_max }) },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_athlete_profile',
        description: L('get_athlete_profile'),
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_rider_profile',
        description: L('update_rider_profile'),
        parameters: {
          type: 'object',
          properties: {
            coach_mode: {
              type: 'string',
              enum: ['', 'amateur', 'standard'],
              description: L('update_rider_profile.coach_mode'),
            },
            weekly_hours: {
              type: 'string',
              enum: ['', 'lt3', '3to5', '5to8', 'gt8'],
              description: L('update_rider_profile.weekly_hours'),
            },
            available_days: {
              type: 'array',
              items: { type: 'integer', minimum: 1, maximum: 7 },
              description: L('update_rider_profile.available_days'),
            },
            session_max_min: {
              type: 'integer',
              minimum: 0,
              maximum: 600,
              description: L('update_rider_profile.session_max_min'),
            },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'estimate_ftp',
        description: L('estimate_ftp'),
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'simulate_form',
        description: L('simulate_form'),
        parameters: {
          type: 'object',
          properties: {
            plan: {
              type: 'array',
              description: L('simulate_form.plan', { n: AGENTIC.simulate_max_days }),
              items: {
                type: 'object',
                properties: {
                  date: { type: 'string', description: L('simulate_form.date') },
                  tss: { type: 'number', description: L('simulate_form.tss') },
                },
                required: ['date', 'tss'],
              },
            },
            start_ctl: { type: 'number', description: L('simulate_form.start_ctl') },
            start_atl: { type: 'number', description: L('simulate_form.start_atl') },
          },
          required: ['plan'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'generate_workout',
        description: L('generate_workout'),
        parameters: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              enum: ['recovery', 'endurance', 'sweet_spot', 'threshold', 'vo2max'],
              description: L('generate_workout.target'),
            },
            duration_minutes: { type: 'integer', description: L('generate_workout.duration_minutes') },
            tsb: { type: 'number', description: L('generate_workout.tsb') },
          },
          required: ['target', 'duration_minutes'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'save_memory',
        description: L('save_memory'),
        parameters: {
          type: 'object',
          properties: {
            content: {
              type: 'string',
              description: L('save_memory.content'),
            },
            category: {
              type: 'string',
              enum: ['general', 'injury', 'schedule', 'goal', 'preference', 'strategy'],
              description: L('save_memory.category'),
            },
            scope: {
              type: 'string',
              enum: ['short', 'long'],
              description: L('save_memory.scope'),
            },
            supersedes_id: {
              type: 'integer',
              description: L('save_memory.supersedes_id'),
            },
          },
          required: ['content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_dossier',
        description: L('get_dossier'),
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_training_plan',
        description: L('get_training_plan'),
        // 零参：计划全局只有一份当前版
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_training_plan',
        description: L('update_training_plan'),
        parameters: {
          type: 'object',
          properties: {
            plan: { type: 'object', description: L('update_training_plan.plan') },
            change_note: { type: 'string', description: L('update_training_plan.change_note') },
          },
          required: ['plan'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'adjust_plan_sessions',
        description: L('adjust_plan_sessions'),
        parameters: {
          type: 'object',
          properties: {
            ops: {
              type: 'array',
              description: L('adjust_plan_sessions.ops'),
              items: {
                type: 'object',
                properties: {
                  op: {
                    type: 'string',
                    enum: ['move', 'swap', 'set_type', 'set_duration', 'remove', 'insert'],
                  },
                  from: { type: 'string', description: L('adjust_plan_sessions.ops') },
                  to: { type: 'string', description: L('adjust_plan_sessions.ops') },
                  a: { type: 'string', description: L('adjust_plan_sessions.ops') },
                  b: { type: 'string', description: L('adjust_plan_sessions.ops') },
                  date: { type: 'string', description: L('adjust_plan_sessions.ops') },
                  type: { type: 'string', description: L('adjust_plan_sessions.ops') },
                  duration_min: { type: 'integer', description: L('adjust_plan_sessions.ops') },
                  intensity: { type: 'string', description: L('adjust_plan_sessions.ops') },
                  note: { type: 'string', description: L('adjust_plan_sessions.ops') },
                },
                required: ['op'],
              },
            },
            change_note: { type: 'string', description: L('adjust_plan_sessions.change_note') },
          },
          required: ['ops'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_power_flag',
        description: L('set_power_flag'),
        parameters: {
          type: 'object',
          properties: {
            file_name: { type: 'string', description: L('set_power_flag.file_name') },
            flagged: { type: 'boolean', description: L('set_power_flag.flagged') },
            reason: { type: 'string', description: L('set_power_flag.reason') },
          },
          required: ['file_name', 'flagged'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'recalibrate_activity_power',
        description: L('recalibrate_activity_power'),
        parameters: {
          type: 'object',
          properties: {
            file_name: { type: 'string', description: L('recalibrate_activity_power.file_name') },
            scale_factor: { type: 'number', description: L('recalibrate_activity_power.scale_factor') },
          },
          required: ['file_name', 'scale_factor'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'update_ftp',
        description: L('update_ftp'),
        // 零参：数值只来自估算器，模型没有自定 FTP 的入口
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'reanalyze_activity',
        description: L('reanalyze_activity'),
        parameters: {
          type: 'object',
          properties: {
            file_name: { type: 'string', description: L('reanalyze_activity.file_name') },
          },
          required: ['file_name'],
        },
      },
    },
  ];
}
