/**
 * settings.ts — 全部可调配置集中于此：骑手参数出厂默认值、分区定义、各分析算法阈值。
 *
 * 移植自 fit-reader Web 版 src/settings.js（来源 commit 35dc14f 前身版本，逻辑原样、只补类型）。
 *
 * 骑手参数（ATHLETE）与 AI 服务配置（AI_CONFIG）只是"出厂默认值"：训练库 settings 表
 * 存有 athlete / ai 两行配置，由「我的」设置页维护并作为唯一事实来源；库中无配置时
 * 才用这里的值。分区定义与算法阈值仍只在本文件调整（算法移植纪律：不在组件里硬编码）。
 */

/** 骑手参数（FTP/最大心率/体重）——生效值以训练库 settings 表为准，此处为出厂默认 */
export interface AthleteParams {
  ftp_watts: number;
  max_hr: number;
  weight_kg: number;
}

// ============ 骑手参数出厂默认值（设置页保存后以训练库为准） ============
export const ATHLETE: AthleteParams = {
  ftp_watts: 106, // 功能阈值功率
  max_hr: 195, // 最大心率
  weight_kg: 60,
};

// ============ 教练模式与骑手时间预算（业余教练模式，2026-10-17；decisions §30） ============
// 08 水平校准（身体能承受多少）与本组字段（想要什么、有多少时间）正交。
export type CoachMode = 'amateur' | 'standard';

/** 每周可用时间档（区间档：防用户高估自己的时间；TrainerRoad volume tier 先例） */
export const WEEKLY_HOURS_TIERS = ['lt3', '3to5', '5to8', 'gt8'] as const;
export type WeeklyHoursTier = (typeof WEEKLY_HOURS_TIERS)[number];

export const COACH_PROFILE_LIMITS = {
  session_max_min: { min: 10, max: 600 }, // 与 plan 课次时长硬错区间同口径
} as const;

// ============ 功率分区（Coggan 7 区，按 FTP 百分比） ============
export interface Zone {
  name: string;
  min: number;
  max: number;
}

export const POWER_ZONES: Zone[] = [
  { name: 'Z1', min: 0.0, max: 0.55 },
  { name: 'Z2', min: 0.55, max: 0.75 },
  { name: 'Z3', min: 0.75, max: 0.9 },
  { name: 'Z4', min: 0.9, max: 1.05 },
  { name: 'Z5', min: 1.05, max: 1.2 },
  { name: 'Z6', min: 1.2, max: 1.5 },
  { name: 'Z7', min: 1.5, max: Infinity },
];

// ============ 心率分区（按最大心率百分比） ============
export const HR_ZONES: Zone[] = [
  { name: 'Z1', min: 0.0, max: 0.68 },
  { name: 'Z2', min: 0.68, max: 0.75 },
  { name: 'Z3', min: 0.75, max: 0.85 },
  { name: 'Z4', min: 0.85, max: 0.92 },
  { name: 'Z5', min: 0.92, max: Infinity },
];

// ============ 间歇识别阈值 ============
export const INTERVAL_DETECTION = {
  threshold_pct: 1.05, // 工作段功率下限（按 FTP 百分比，Z5 起步）
  min_duration_sec: 30, // 短于该时长的工作段不计为间歇
  merge_gap_sec: 10, // 低于阈值不超过该时长视为瞬时掉功率，合并相邻段
};

// ============ 爬坡段提取阈值 ============
export const CLIMB_DETECTION = {
  min_grade_pct: 3, // 平均坡度下限（%）
  min_gain_m: 15, // 段内累计爬升下限（米）
  min_distance_m: 300, // 段长下限（米）
  smooth_sec: 30, // 坡度计算窗口（秒），用于压海拔噪声
};

// ============ 累计爬升阈值（analyze.ts：elevationGain 滞回去抖） ============
export const ELEVATION = {
  noise_threshold_m: 1, // 爬升去抖阈值：以最近确认点为基线，累计上升达到该值才计入爬升（压制气压计亚米级抖动）
};

// ============ 数据质量阈值 ============
export const DATA_QUALITY = {
  record_gap_sec: 10, // 逐秒网格中连续缺失超过该时长，在 anomalies 中标注（损坏文件被跳过的记录会表现为这种缺口）
  pause_dist_jump_m: 10, // 距离冻结判定（米）：间隙两侧设备累计距离跳变不超过该值视为"设备未计时"→ 判为暂停（骑行中掉数据距离会按速度继续跳变）
  pause_resume_speed_kmh: 2, // 记录恢复后仍低于该速度视为"静止恢复"→ 判为计时暂停（无距离数据的文件的兜底判据）
  pause_resume_window_sec: 5, // 静止判定窗口（秒）：取恢复记录后该窗口内的最大速度判断
};

// ============ 踩踏时间分解与静止段标注（pedalTime.ts：analyze 装配 + 详情页共用） ============
// 0W 根治后 pedal_time 已进 summary 喂 AI、静止段进 anomalies（口径拍板只披露不改数值）；
// 静止判据复用 DATA_QUALITY.pause_resume_speed_kmh
export const PEDAL_TIME = {
  stationary_min_sec: 30, // 静止段标注下限（秒）：达到该时长的"计时未停静止"才进 anomalies（短暂红灯不标）
  stationary_hint_sec: 60, // 静止累计提示线：达到该秒数（≥）在卡片附「计时未停的静止以 0W 计入指标」提示
};

// ============ 功率峰曲线缺口容忍（analyze.ts：fillShortGaps 插值后再算峰功率/FTP 估算） ============
export const PEAK_CURVE = {
  max_interp_gap_sec: 10, // 允许线性插值补齐的连续缺口上限（秒）：功率计偶发掉几秒不应让 20min 峰功率整体作废；更长缺口仍视为不连续
};

// ============ 功率校准系数界限（AI 经 recalibrate_activity_power 缩放重算时的夹逼） ============
export const POWER_CALIBRATION = {
  min_scale: 0.5, // 系数下限：低于它意味着功率计读数虚高 2 倍以上——更可能是数据本身不可信（应 set_power_flag 标记而非缩放）
  max_scale: 1.5, // 系数上限：同理，超高 2 倍以上的读数不建议用线性缩放"修复"
};

// ============ FTP 历史估算阈值（ftp.js：窗口内功率峰曲线 + 心率交叉验证，M3 搬运） ============
export const FTP_ESTIMATION = {
  window_days: 42, // 回看窗口（天）：取最近 6 周内的骑行做联合估算
  min_rides: 3, // 窗口内带功率数据的骑行次数下限，不足则判定数据不充分
  min_coverage_pct: 80, // 单次骑行的功率/心率覆盖率下限（%），低于则不采信该次数据
  max_effort_hr_pct: 0.9, // 全力判定：20min 峰功率所在骑行的心率峰值需 ≥ 该比例 × max_hr
  zone_mismatch_pct: 15, // 功率 Z4+ 与心率 Z4+ 时长占比差（百分点）超过该值判定系统性偏移
  drift_warn_pct: 5, // 心率漂移（有氧解耦）中位数超过该值提示数据漂移（疲劳/脱水/高温）
  consistency_pct: 3, // CP 模型与 Coggan 20min×0.95 两法结果相差在该比例内判定"一致"
  cp_short_sec: 300, // CP 模型短锚点：5 分钟峰功率
  cp_long_sec: 1200, // CP 模型长锚点：20 分钟峰功率
  coggan_factor: 0.95, // Coggan 口径：20 分钟峰功率 × 该系数 ≈ FTP
  apply_min_w: 50, // 「采纳写回」时可接受的 FTP 下限（W）
  apply_max_w: 500, // 「采纳写回」时可接受的 FTP 上限（W）
  freshness_days: 7, // AI 自动采纳的新鲜度门槛（天）：窗口内最近一次骑行距今天不超过该值才允许写回
};

// ============ 踏频-功率联合分析阈值 ============
export const CADENCE_ANALYSIS = {
  power_floor_pct: 0.75, // 只统计功率 ≥ 该比例 × FTP 的"发力时段"（Z3 起步）
  low_cadence_rpm: 80, // 低于该踏频视为低踏频高扭矩
  high_cadence_rpm: 90, // 高于该踏频视为高踏频
};

// ============ AI 服务出厂默认值（M3：设置页保存后以训练库 settings 表 ai 行为准，默认 Kimi） ============
// api_key 例外：不进库，存 expo-secure-store（Android Keystore），见 src/db/index.ts
export interface AiConfig {
  api_key: string | null; // API 密钥；为空时 AI 报告退化为"复制提示词"模式
  base_url: string; // OpenAI 兼容接口地址
  model: string; // 模型名
  temperature: number | null; // 采样温度；null 表示请求体不传（部分模型只允许特定取值）
  timeout_ms: number; // 总等待超时（复盘报告生成慢，默认 10 分钟）
  stream: boolean; // 是否流式输出；部分账号/模型不真正流式吐字，非流式更稳
  stall_ms: number; // 流式空闲超时，每收到一个 chunk 重置
  agentic: boolean; // 是否启用 agentic 工具调用；模型不支持 tools 时自动降级单轮
}

export const AI_CONFIG: AiConfig = {
  api_key: null,
  base_url: 'https://api.moonshot.cn/v1', // OpenAI 兼容接口地址
  model: 'kimi-k2.6',
  temperature: null,
  timeout_ms: 600000,
  stream: false,
  stall_ms: 60000,
  agentic: true,
};

// ============ 以下配置块随对应模块在后续里程碑搬运 ============

// Agentic 工具调用参数（M3 src/ai / src/tools）
export const AGENTIC = {
  max_rounds: 8, // 最大工具调用轮数，超出后强制模型直接作答（M5 扩到 8：估算→更新 FTP→重算数次训练→汇总作答）
  tool_result_max_chars: 16000, // 单个工具结果上限（超出走 compactJsonToLimit 结构化降级为合法 JSON，不再是尾部硬切）；2026-10 由 4000 放宽 4×——start_sec/end_sec 窄窗逐秒核对在 4000 下也不可用（60s 全秒窗约 7k 字符），16k ≈ 4-8k tokens，BYOK 模型上下文可承受
  records_max_points: 600, // get_activity_records 时序抽稀点数上限
  list_limit: 50, // list_activities 返回条数上限
  form_max_days: 120, // get_form_series 天数上限
  monthly_max: 24, // get_monthly_summary 月数上限
  simulate_max_days: 60, // simulate_form 推演天数上限（紧凑数组输出不超截断线）
  // agent 循环内累积消息（含逐轮重发的 tool 结果）的请求体预算：超限把更旧轮的
  // tool 结果降为占位 JSON（compactAgentHistory），防 8 轮 × 16k 字符全量重发
  // （架构评审 E1：最坏 ~128k 字符的历史复利）。首条 prompt 与最近几轮原样保留。
  agent_history_max_chars: 32000,
};

// ============ 上下文装配预算（E1 完整解，2026-10-17；字符口径与 tool_result_max_chars 一致） ============
// 单位是字符（≈ token 的 2-4 倍），不做 tokenizer 依赖。预算超限时的降级次序见
// src/prompts/context.ts 的 assembleBudgetedSections（优先级低/声明 optional 的段先丢，
// 可截段走 degrade() 按边界截断；数据 JSON 段不可截断）。
export const CONTEXT_BUDGET = {
  /** 单次请求 prompt 软上限（不含工具 schema 的常量成本） */
  request_max_chars: 70000,
  /** 对话系统段上限（技能/档案/记忆/摘要都在其内） */
  system_max_chars: 56000,
  /** 报告基础 prompt（createReportDraft 冻结落库前）上限 */
  report_base_max_chars: 56000,
  /** 报告基础段 + agentic 指引 + 记忆段的总量上限 */
  report_total_max_chars: 66000,
  /** 专业知识库段上限（zh 实测 ~14.6k / en ~40k，en 仍完整；未来新增技能的增长闸门） */
  skills_max_chars: 44000,
  /** follow_up 内联报告正文上限（超出走 compactReportForPrompt 首末章瘦身） */
  report_inline_max_chars: 16000,
  /** follow_up 训练 summary JSON 上限；超出第 1 轮即直接降 headline（不再区分轮次） */
  summary_json_max_chars: 6000,
  /** 注入记忆条数上限（db 层 listMemories 取全量有效记忆，rankMemories 在此预算内挑选） */
  memory_top_k: 12,
  /** 注入记忆段字符预算（12 条 × ~500 字全满约 6k，预算兜住组合爆炸） */
  memory_max_chars: 4000,
  /** 对话窗口保留的最近轮数（1 轮 = 一次用户提问 + 一次教练回答） */
  history_recent_turns: 6,
  /** 对话窗口保留的最近历史字符上限（与轮数取更严者；最新一轮永远保留） */
  history_recent_chars: 12000,
  /** 模型滚动摘要的输出上限（超出截断，摘要只是定位性回顾不需要全文） */
  chat_summary_output_max_chars: 1200,
  /** 被挤出窗口的旧消息体量达到该字符数才值得调一次模型摘要（否则用确定性 digest，零成本） */
  chat_summary_trigger_chars: 4000,
  /** 摘要调用的输入消息体量上限（逐条截 1500 字后再总截，防摘要请求本身爆炸） */
  chat_summary_input_max_chars: 16000,
} as const;

// 未来负荷推演风险阈值（M3 src/planning）
export const FORM_SIMULATION = {
  tsb_low: -30, // TSB 低于该值视为深度疲劳
  tsb_low_days: 7, // TSB 持续低于阈值达到该天数触发警示
  ctl_ramp_pct: 10, // CTL 周增幅上限（%），超出触发过度训练风险警示
  tsb_recovery: -20, // generateWorkout 中 TSB 低于该值自动降级为恢复课
};

// 业余模式的推演阈值：低负荷骑手的 TSB 基数更浅，按训练者标尺会把正常波动标成
// 风险；放宽深度疲劳线与 CTL 增幅线（只影响展示推演旗标，不改 CTL/ATL 递推数值）。
export const AMATEUR_FORM_SIMULATION = {
  ...FORM_SIMULATION,
  tsb_low: -40,
  ctl_ramp_pct: 12,
};

// ============ 结构化训练计划校验（v2 训练计划载体，src/core/training-plan） ============
// 阈值口径与 src/prompts/skills/05-weekly-planning 技能一致（代码单源，技能为知识层文本，
// 改阈值须两处同步评审）；history_keep 供 db 层版本历史裁剪。
export const PLAN_VALIDATION = {
  max_window_days: 42, // 计划窗上限：结构化课表覆盖 ≤6 周（05 技能中期方向 4–8 周，课表层取窄）
  min_window_days: 3, // 计划窗下限：少于 3 天不构成「计划」
  from_max_past_days: 7, // valid_from 允许早于今天的最大天数（模型日期笔误的容错窗）
  quality_gap_days: 2, // 质量课最小日期间隔（「≥48h」的日粒度口径：相邻质量课间隔 ≥2 天为过）
  recovery_week_ratio: 0.7, // 减量周判定：周计划 TSS ≤ 窗内最大周 × 该系数（05 技能：减量 30–50%）
  recovery_window_weeks: 4, // 减量节奏：任 N 连周须含一个减量周（05 技能：每 3–4 周）
  week_min_covered_days: 5, // 自然周「须含休息日」检查的最小窗内覆盖天数（窗边残周不查）
  history_keep: 10, // 计划版本历史上限（db 层 training_plan_history 裁剪）
};

// 业余模式计划约束（2026-10-17，decisions §30）：**只提示不拦截**——用户可能真的
// 没空，不逼用户放弃爱好；既有结构规则（质量课间隔/休息日/减量周）不放松。
export const PLAN_AMATEUR_LIMITS = {
  weekly_quality_max: 2, // 每周质量课建议上限
  weekly_sessions_max: 5, // 每周非休息课次软上限（6 次起提示；7 次无休息日在 adjust/ops 档会被既有结构规则硬拒，create 档只提示）
};

// ============ 计划执行情况视图（U1 收尾②：本地 adherence，src/core/plan-adherence） ============
// 三态口径与 src/prompts/skills/07-training-plan 技能「完成 / 降强度完成 / 未做」配套
// （技能为知识层定性描述，本处是本地确定性判定的量化单源）
export const PLAN_ADHERENCE = {
  done_ratio: 0.8, // 实际 TSS ≥ 计划 TSS × 该系数 → 完成；>0 但不足 → 降强完成；=0（已过期）→ 未做
};

// ============ 单次课表模板（M3 src/planning generateWorkout 使用） ============
// 功率按 FTP 百分比；时长单位分钟；TSS 估算按各段 时长秒 × IF² / 36 逐段求和
export interface WorkoutTemplate {
  label: string;
  warmup_min?: number;
  steady?: { pct: [number, number]; if: number }; // 无间歇组的全程稳态课
  set?: { pct: [number, number]; if: number; min_min: number; max_min: number };
  reps?: [number, number];
  rest_min?: number | null; // null = 组间休息与单组等时
  cooldown_min?: number;
}

export const WORKOUT_TEMPLATES: Record<
  'recovery' | 'endurance' | 'sweet_spot' | 'threshold' | 'vo2max',
  WorkoutTemplate
> = {
  recovery: {
    label: '恢复骑',
    steady: { pct: [0.4, 0.55], if: 0.5 }, // 全程稳态，无间歇组
  },
  endurance: {
    label: '有氧耐力',
    steady: { pct: [0.56, 0.75], if: 0.68 },
  },
  sweet_spot: {
    label: '甜区',
    warmup_min: 15,
    set: { pct: [0.88, 0.94], if: 0.91, min_min: 10, max_min: 20 },
    reps: [2, 3],
    rest_min: 5,
    cooldown_min: 10,
  },
  threshold: {
    label: '阈值',
    warmup_min: 15,
    set: { pct: [0.95, 1.05], if: 1.0, min_min: 10, max_min: 15 },
    reps: [2, 3],
    rest_min: 5,
    cooldown_min: 10,
  },
  vo2max: {
    label: 'VO2max',
    warmup_min: 15,
    set: { pct: [1.06, 1.2], if: 1.13, min_min: 3, max_min: 5 },
    reps: [4, 6],
    rest_min: null, // null = 组间休息与单组等时
    cooldown_min: 10,
  },
};

// 短课版模板（业余模式：30–45 分钟也能上一次质量课；2026-10-17 decisions §30）。
// 标准模板的甜区最短约 50 分钟（热身 15 + 2×10 + 组间 5 + 冷身 10），对时间受限
// 骑手直接判「装不下」；短课版压缩热身/冷身与最少组数（甜区/阈值最少 19 分钟、
// VO2max 最少 23 分钟）。只在标准模板装不下时回退使用，不改变标准模板行为。
export const WORKOUT_TEMPLATES_SHORT: Partial<
  Record<'recovery' | 'endurance' | 'sweet_spot' | 'threshold' | 'vo2max', WorkoutTemplate>
> = {
  sweet_spot: {
    label: '甜区（短课）',
    warmup_min: 8,
    set: { pct: [0.88, 0.94], if: 0.91, min_min: 6, max_min: 12 },
    reps: [1, 2],
    rest_min: 3,
    cooldown_min: 5,
  },
  threshold: {
    label: '阈值（短课）',
    warmup_min: 8,
    set: { pct: [0.95, 1.05], if: 1.0, min_min: 6, max_min: 10 },
    reps: [1, 2],
    rest_min: 3,
    cooldown_min: 5,
  },
  vo2max: {
    label: 'VO2max（短课）',
    warmup_min: 8,
    set: { pct: [1.06, 1.2], if: 1.13, min_min: 2, max_min: 4 },
    reps: [3, 4],
    rest_min: null,
    cooldown_min: 5,
  },
};
