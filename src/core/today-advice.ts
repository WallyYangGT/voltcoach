/**
 * today-advice.ts — 今日训练建议纯函数（U1 收尾①：首页「今日建议」卡的判定层）。
 *
 * 零 token 本地判定，回答「今天怎么办」（与训练计划卡「这周怎么排」分工）。分档阈值
 * 只引 FORM_SIMULATION 单源：tsb_recovery（-20，generateWorkout 自动降级同一条线）/
 * tsb_low（-30，深度疲劳线），组件零硬编码。
 *
 * 分层（roadmap 2026-10-15 内容口径）：
 * ① 状态判定——TSB 三档「能练 / 轻松练 / 建议休息」+「今天已练」免扰优先；
 * ② 计划课型交叉——生效计划的质量课遇 TSB 深负提示降级或顺延；计划休息日/无课
 *    不出课表；无生效计划降级为纯状态建议（生成计划引导在组件层）；
 * ③ 课表出口的判定半边——三分支（2026-10-15 真机反馈拍板）：今天有课 → 按课出表
 *    （质量课映射课型 / easy 档给 recovery：该档在 generateWorkout 的 tsb_recovery
 *    降级线之下时，generateWorkout 以 key !== 'recovery' 守卫不再二次降级，两层口径
 *    不打架）；无课但计划有未来课（生效中整日无课 / 未开始）→ 不出表，组件转
 *    「看下一节课」出口（带日期，免得兜底课表被误读成计划课）；真无课表（无计划 /
 *    已过期）→ 兜底建议课表（train=endurance / easy=recovery）。深聊出口的预填文案
 *    在组件层按本结构拼。
 *
 * 不返回文案（展示与 i18n 在组件层走词典）；tsb 由调用方传 recentFormDaily 末端
 * （与 hero 同源不重算），本层只取整为展示值。
 */

import { FORM_SIMULATION } from './settings.ts';
import { QUALITY_TYPES, type PlanSessionType } from './training-plan.ts';

/** 课表生成 target（WORKOUT_TEMPLATES 的 key） */
export type WorkoutTarget = 'recovery' | 'endurance' | 'sweet_spot' | 'threshold' | 'vo2max';

export type TodayAdviceLevel = 'done' | 'train' | 'easy' | 'rest';

/** 计划课型 → 课表 target 的映射（long 无对应模板按 endurance 口径，与 PLAN_TYPE_IF 同思路） */
const TYPE_TO_TARGET: Record<PlanSessionType, WorkoutTarget | null> = {
  rest: null,
  recovery: 'recovery',
  endurance: 'endurance',
  long: 'endurance',
  sweet_spot: 'sweet_spot',
  threshold: 'threshold',
  vo2max: 'vo2max',
};

export interface TodayAdvice {
  /** 结论档：done=今天已练（免扰）/ train=能练 / easy=轻松练 / rest=建议休息（含计划休息日） */
  level: TodayAdviceLevel;
  /** 有生效中的计划（planValidity === 'valid'）；upcoming/expired/无计划均 false */
  hasPlan: boolean;
  /** 今天在计划内有课次行（显式 rest 也算；整日无课为 false，语义是计划内休息日） */
  planned: boolean;
  /** 今天是计划内的休息日（显式 rest 课或整日无课——校验 R2 同一口径） */
  restDay: boolean;
  /** 今天计划的课型 key（组件经 plan.type.* 词典翻译；无课/无计划为 null） */
  planType: PlanSessionType | null;
  /** 计划排了质量课而 TSB 深负：提示降级为轻松骑或顺延 */
  downgrade: boolean;
  /** TSB 低于 tsb_low 深度疲劳线（head 文案分档用） */
  deepFatigue: boolean;
  /** 展示用 TSB（四舍五入取整，与 hero 大数字同观感） */
  tsb: number;
  /** 课表出口的 generateWorkout target；done/rest（建议休息）与「无课但计划有未来课」为 null（后者组件走「下一节课」出口） */
  workoutTarget: WorkoutTarget | null;
}

export function computeTodayAdvice({
  tsb,
  trainedToday,
  session,
  nextSession = null,
  planState,
}: {
  tsb: number;
  trainedToday: boolean;
  session: { type: PlanSessionType } | null;
  /** 计划内今天之后的下一节非 rest 课（组件从 plan 过滤传入）；null=前面没有课可指（含无计划/已过期/空窗） */
  nextSession?: { type: PlanSessionType } | null;
  planState: 'upcoming' | 'valid' | 'expired' | null;
}): TodayAdvice {
  const tsbRound = Math.round(tsb);
  const deepFatigue = tsb < FORM_SIMULATION.tsb_low;

  const hasPlan = planState === 'valid';
  const planned = hasPlan && session != null;
  const planType = planned ? session!.type : null;
  // 休息日 = 显式 rest 课或整日无课（合理性校验 R2 的同一口径）
  const restDay = hasPlan && (session == null || session.type === 'rest');
  const isQuality = planType != null && (QUALITY_TYPES as readonly string[]).includes(planType);

  // 结论档：已练免扰 > 计划休息日（结论就是休息，与 TSB 无关）> TSB 三档
  const level: TodayAdviceLevel = trainedToday
    ? 'done'
    : restDay
      ? 'rest'
      : tsb >= FORM_SIMULATION.tsb_recovery
        ? 'train'
        : tsb >= FORM_SIMULATION.tsb_low
          ? 'easy'
          : 'rest';

  // 计划交叉：质量课 + 非能练档 → 提示降级/顺延（rest 档即深度疲劳，更是别按计划硬扛）
  const downgrade = isQuality && level !== 'train' && level !== 'done';

  // 课表出口三分支：planAhead=计划在今天或前面还有课——有课按课出表，无课但有未来课
  // 不出表（组件转「下一节课」出口），真无课表才走兜底（upcoming 误落兜底是真机 bug 根因）
  const planAhead = planned || nextSession != null;
  let workoutTarget: WorkoutTarget | null = null;
  if (level === 'easy') {
    workoutTarget = planned || !planAhead ? 'recovery' : null;
  } else if (level === 'train') {
    // 与 planned 同一门控收口（code-review P3-3）：session 只在 hasPlan 时有意义
    if (planned && session) workoutTarget = TYPE_TO_TARGET[session.type];
    else if (!planAhead) workoutTarget = 'endurance'; // 兜底建议课表（无计划/已过期）
  }

  return {
    level,
    hasPlan,
    planned,
    restDay,
    planType,
    downgrade,
    deepFatigue,
    tsb: tsbRound,
    workoutTarget,
  };
}
