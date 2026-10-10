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
    get_athlete_profile: '取骑手参数（FTP/最大心率/体重）与用户身份、训练目标。',
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
    save_memory: '保存一条关于用户的长期记忆。只要用户透露训练数据之外的个人事实或倾向（目标与赛事计划/伤病与身体不适/日程时间约束/训练偏好/器材/对建议的反馈与纠正/自述主观状态）就主动记录，不必等用户明确要求，宁多勿漏；训练数据本身已有的事实不要记。',
    'save_memory.content': '记忆内容：带主语的完整陈述，≤500 字',
    'save_memory.category': '分类：general 通用 / injury 伤病 / schedule 日程 / goal 目标 / preference 偏好',
    'save_memory.supersedes_id': '取代某条旧记忆的 id（注入的记忆清单中有 #id 标注），同主题更新时使用',
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
    get_athlete_profile: 'Get athlete parameters (FTP/max HR/weight) plus user identity and training goals.',
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
    save_memory: 'Save a long-term memory about the user. Proactively record whenever the user reveals personal facts or preferences beyond training data (goals and race plans / injuries and physical issues / schedule-time constraints / training preferences / equipment / feedback on and corrections to your advice / self-reported subjective state) — better too many than too few, don\'t wait to be asked; facts already present in the training data need not be recorded.',
    'save_memory.content': 'Memory content: a complete statement with a subject, ≤500 chars',
    'save_memory.category': 'Category: general / injury / schedule / goal / preference',
    'save_memory.supersedes_id': "id of an old memory to supersede (ids are #annotated in the injected memory list); use when updating the same topic",
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
              enum: ['general', 'injury', 'schedule', 'goal', 'preference'],
              description: L('save_memory.category'),
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
