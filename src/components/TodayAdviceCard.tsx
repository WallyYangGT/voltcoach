/**
 * TodayAdviceCard.tsx — 首页「今日建议」卡（U1 收尾①：教练执行闭环的零 token 半边）。
 *
 * 2026-10-15 用户拍板：与 WeeklyPlanCard 信息重叠（都答「今天练什么」、都有计划
 * 入口），**整卡合并**——本卡成为首页计划信息的唯一出口，WeeklyPlanCard 移除。
 * 吸收的能力：计划四态级联概要（有效=本周摘要 / 未开始=开始日期 / 过期=置灰 /
 * 无计划=两档引导）、今日训练内容行（课型·时长·TSS）、一键生成 CTA（report 链路）、
 * 查看课表入口。
 *
 * 判定全在 core/today-advice 纯函数（阈值只引 FORM_SIMULATION 单源），组件零硬编码；
 * TSB 用首页 recentFormDaily 末端（props 传入，与 hero 同源不重算），计划读 settings
 * 当前行（自加载）。纯本地计算，不被 LLM Key 门控——无 Key 用户「教练感」的主来源；
 * 空库（last=null）整卡隐藏（无 Key 时生成 CTA 走到报告页会有明确的未配置错误，可接受）。
 *
 * 双出口：「看今日课表」= generateWorkout 本地秒出课表（卡内展开渲染）；
 * 「和教练聊聊」= 深链新对话并预填上下文（session 页 draft 参数，AP1 聚焦链路照旧）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import dayjs from 'dayjs';
import React, { useCallback, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { getCurrentPlan, listAiReports, type StoredPlan } from '@/db';
import { createReportDraft, generateReport } from '@/services/aiGenerate';
import type { TrendPoint } from '@/charts/TrendChart';
import type { AthleteParams } from '@/core/settings';
import { localDay } from '@/core/local-day';
import { formatDuration } from '@/core/metrics';
import { planValidity, slicePlanWeek, weekStartOf } from '@/core/training-plan';
import { computeTodayAdvice, type TodayAdviceLevel } from '@/core/today-advice';
import { generateWorkout, type WorkoutResult } from '@/planning/planning';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

interface Props {
  /** recentFormDaily 末端（hero 同源）；null=空库整卡隐藏 */
  last: TrendPoint | null;
  athlete: AthleteParams | null;
  /** 今天是否已练（首页按最近训练行的本地日标签判定，免扰档输入） */
  trainedToday: boolean;
}

/** 状态档徽章配色：绿=能练 / 橙=轻松练（进行中语义同款）/ 蓝=休息（计划页恢复周同款）/ 灰=已练 */
const LEVEL_COLOR: Record<TodayAdviceLevel, string> = {
  done: palette.muted,
  train: palette.green,
  easy: palette.orange,
  rest: palette.blue,
};

const fmtW = ([a, b]: [number, number]) => `${a}–${b}W`;

export function TodayAdviceCard({ last, athlete, trainedToday }: Props) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [hasPlanReport, setHasPlanReport] = useState(false);
  const [workout, setWorkout] = useState<WorkoutResult | null>(null);
  const [nextOpen, setNextOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [plan, recent] = await Promise.all([getCurrentPlan(), listAiReports('plan', 1)]);
      setStored(plan);
      setHasPlanReport(recent.length > 0);
    } catch (e) {
      console.warn('今日建议卡加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  if (!last || !athlete) return null;

  const today = localDay();
  const validity = stored ? planValidity(stored.plan, today) : null;
  const session = stored?.plan.sessions.find((s) => s.date === today) ?? null;
  // 下一节课：今天之后第一堂非 rest 课（§19 计划日期即本地日口径，ISO 串直接比序；
  // 无计划/已过期的窗内不会有未来课，自然为 null）
  const nextSession =
    stored?.plan.sessions
      .filter((s) => s.date > today && s.type !== 'rest')
      .sort((a, b) => (a.date < b.date ? -1 : 1))[0] ?? null;
  const advice = computeTodayAdvice({
    tsb: last.tsb,
    trainedToday,
    session,
    nextSession,
    planState: validity?.state ?? null,
  });

  const typeLabel = advice.planType ? t(`plan.type.${advice.planType}` as never) : null;
  const tsbStr = advice.tsb > 0 ? `+${advice.tsb}` : String(advice.tsb);

  // 结论行：状态档 → head 文案分档（休息档区分深度疲劳/计划休息日；轻松档区分是否降级提示）
  const head =
    advice.level === 'done'
      ? t('dash.today.head.done')
      : advice.level === 'rest'
        ? t(
            advice.deepFatigue
              ? 'dash.today.head.rest_deep'
              : advice.restDay
                ? 'dash.today.head.rest_planned'
                : 'dash.today.head.rest',
          )
        : advice.level === 'easy'
          ? advice.downgrade && typeLabel
            ? t('dash.today.head.easy_down', { type: typeLabel })
            : t('dash.today.head.easy')
          : advice.planned && typeLabel
            ? t('dash.today.head.train_planned', { type: typeLabel })
            : t('dash.today.head.train_free');

  // 一行依据（今天的状态侧）：计划有效给计划交叉，未开始/已过期如实标注（真机反馈：
  // upcoming 时「无生效计划」观感是错的），无计划才说无计划
  const planPart = advice.hasPlan
    ? advice.planned && typeLabel
      ? `${t('dash.today.plan_prefix')}${typeLabel}`
      : t('dash.today.basis_free')
    : validity?.state === 'upcoming'
      ? t('dash.today.basis_upcoming')
      : validity?.state === 'expired'
        ? t('dash.today.basis_expired')
        : t('dash.today.basis_noplan');
  const basis = t('dash.today.basis', { tsb: tsbStr, plan: planPart });

  const onWorkout = () => {
    if (!advice.workoutTarget) return;
    setNextOpen(false); // 两个展开互斥
    if (workout) {
      setWorkout(null); // 再点收起
      return;
    }
    setWorkout(
      generateWorkout({
        target: advice.workoutTarget,
        durationMinutes: session?.duration_min ?? 60,
        ftpWatts: athlete.ftp_watts,
        tsb: last.tsb,
      }),
    );
  };

  // 下一节课出口（无课日替代兜底课表，2026-10-15 真机反馈）：读计划不 token，展开带日期
  const onNext = () => {
    setWorkout(null);
    setNextOpen((v) => !v);
  };

  // 深聊出口：预填上下文进新对话（会话页 draft 参数 + 进入即聚焦）
  const onChat = () => {
    const plan = advice.hasPlan
      ? advice.planned && typeLabel
        ? t('dash.today.draft_planned', { type: typeLabel })
        : t('dash.today.draft_rest')
      : t('dash.today.draft_noplan');
    router.push({
      pathname: '/ai/session/[id]',
      params: { id: 'chat-new', draft: t('dash.today.draft', { tsb: tsbStr, plan }) },
    });
  };

  // 下一节课日期标签（计划日期是本地日口径纯日期串，直接格式化）
  const nextDate = nextSession ? dayjs(nextSession.date) : null;
  const nextDateLabel = nextDate
    ? lang === 'zh'
      ? `${nextDate.format('M月D日')}（周${'日一二三四五六'[nextDate.day()]}）`
      : `${nextDate.format('MMM D')} (${nextDate.format('ddd')})`
    : '';

  // 一键生成（原 WeeklyPlanCard 链路）：draft → 跳报告页（三态/保活/轮询都在那边）→ fire
  // （普通函数而非 useCallback——组件在无训练数据时提前 return null，其后不能再调 Hook）
  const onGenerate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await createReportDraft('plan', {}, lang);
      router.push(`/ai/session/report-${id}`);
      void generateReport(id, lang).catch((e) => console.warn('计划生成失败:', e));
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // 计划概要行（原 WeeklyPlanCard 四态级联）：valid 摘要+查看课表 / upcoming 开始日 /
  // expired 置灰+生成 / 无计划两档引导+生成
  let planSummary: React.ReactNode = null;
  if (stored && validity) {
    const expired = validity.state === 'expired';
    const summary =
      expired
        ? t('plan.card.expired')
        : validity.state === 'upcoming'
          ? t('plan.card.upcoming', {
              date: stored.plan.valid_from,
              n: stored.plan.sessions.filter((s) => s.type !== 'rest').length,
            })
          : t('plan.card.valid', {
              n: slicePlanWeek(stored.plan, weekStartOf(today)).filter((s) => s.type !== 'rest').length,
              tss: Math.round(
                slicePlanWeek(stored.plan, weekStartOf(today)).reduce((acc, s) => acc + (s.tss ?? 0), 0),
              ),
            });
    planSummary = (
      <View style={styles.planRow}>
        <Text style={[styles.planSummary, expired && styles.planExpired]}>{summary}</Text>
        {!expired && (
          <Pressable hitSlop={8} onPress={() => router.push('/plan')}>
            <Text style={styles.planLink}>{t('plan.card.open')}</Text>
          </Pressable>
        )}
      </View>
    );
    if (validity.state === 'valid' && session) {
      planSummary = (
        <View style={styles.planBlock}>
          <View style={styles.planRow}>
            <Text style={styles.planSummary}>{summary}</Text>
            <Pressable hitSlop={8} onPress={() => router.push('/plan')}>
              <Text style={styles.planLink}>{t('plan.card.open')}</Text>
            </Pressable>
          </View>
          <Text style={styles.planToday}>
            {session.type === 'rest' || session.duration_min == null
              ? t('plan.card.rest_today')
              : t('plan.card.today', {
                  text: `${typeLabel ?? ''} · ${formatDuration(session.duration_min * 60)} · TSS ${Math.round(session.tss ?? 0)}`,
                })}
          </Text>
        </View>
      );
    }
  } else {
    planSummary = (
      <View style={styles.planRow}>
        <Text style={styles.planSummary}>{hasPlanReport ? t('plan.card.regen') : t('plan.card.none')}</Text>
      </View>
    );
  }
  const showGenerateCta = !stored || validity?.state === 'expired';

  return (
    <View style={styles.card} testID="today-advice-card">
      <View style={styles.head}>
        <Text style={styles.title}>{t('dash.today.title')}</Text>
        <Text style={[styles.badge, { color: LEVEL_COLOR[advice.level] }]}>
          {t(`dash.today.level.${advice.level}` as never)}
        </Text>
      </View>
      {planSummary}
      <Text style={styles.headline}>{head}</Text>
      <Text style={styles.basis}>{basis}</Text>

      {/* 出口（done 免扰档不出；生成引导在概要行）。课表按钮双文案：计划课=看今日课表，
          兜底=看建议课表（不暗示计划内容——真机误读根因之一） */}
      {advice.level !== 'done' && (
        <View style={styles.actions}>
          {advice.workoutTarget != null && (
            <Pressable hitSlop={8} onPress={onWorkout}>
              <Text style={styles.cta}>
                {workout
                  ? t('dash.today.workout_hide')
                  : advice.planned
                    ? t('dash.today.workout_btn')
                    : t('dash.today.workout_suggest')}
              </Text>
            </Pressable>
          )}
          {nextSession && !(session && session.type !== 'rest') && (
            <Pressable hitSlop={8} onPress={onNext}>
              <Text style={styles.cta}>{nextOpen ? t('dash.today.next_hide') : t('dash.today.next_btn')}</Text>
            </Pressable>
          )}
          <Pressable hitSlop={8} onPress={onChat}>
            <Text style={styles.cta}>{t('dash.today.chat_btn')}</Text>
          </Pressable>
        </View>
      )}
      {showGenerateCta && (
        <Pressable disabled={busy} onPress={onGenerate}>
          <Text style={[styles.cta, busy && { opacity: 0.5 }]}>{t('plan.card.cta')}</Text>
        </Pressable>
      )}

      {/* 本地秒出课表（WorkoutResult 渲染；error 时如实展示原因） */}
      {workout && (
        <View style={styles.workout}>
          {workout.error ? (
            <Text style={styles.wError}>{workout.error}</Text>
          ) : (
            <>
              <Text style={styles.wHead}>
                {t('dash.today.w.head', {
                  label: workout.label,
                  min: workout.duration_minutes,
                  tss: workout.estimated_tss,
                })}
              </Text>
              {workout.steady && (
                <Text style={styles.wRow}>
                  {t('dash.today.w.steady', { min: workout.steady.minutes, w: fmtW(workout.steady.power_watts) })}
                </Text>
              )}
              {workout.warmup && (
                <Text style={styles.wRow}>
                  {t('dash.today.w.warmup', { min: workout.warmup.minutes, w: fmtW(workout.warmup.power_watts) })}
                </Text>
              )}
              {workout.main_sets && (
                <Text style={styles.wRow}>
                  {t('dash.today.w.main', {
                    reps: workout.main_sets.reps,
                    min: workout.main_sets.set_minutes,
                    w: fmtW(workout.main_sets.power_watts),
                    rest: workout.main_sets.rest_minutes,
                    rw: fmtW(workout.main_sets.rest_power_watts),
                  })}
                </Text>
              )}
              {workout.cooldown && (
                <Text style={styles.wRow}>
                  {t('dash.today.w.cooldown', { min: workout.cooldown.minutes, w: fmtW(workout.cooldown.power_watts) })}
                </Text>
              )}
              {workout.notes.map((n, i) => (
                <Text key={i} style={styles.wNote}>
                  · {n}
                </Text>
              ))}
            </>
          )}
        </View>
      )}
      {/* 下一节课（计划直读，带日期——无课日替代兜底课表的出口） */}
      {nextOpen && nextSession && (
        <View style={styles.workout}>
          <Text style={styles.wHead}>
            {t('dash.today.next_line', {
              date: nextDateLabel,
              type: t(`plan.type.${nextSession.type}` as never),
              min: nextSession.duration_min != null ? formatDuration(nextSession.duration_min * 60) : '—',
              tss: nextSession.tss != null ? String(Math.round(nextSession.tss)) : '—',
            })}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 8,
  },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: palette.text, fontSize: 14, fontWeight: '700' },
  badge: { fontSize: 12, fontWeight: '700' },
  planBlock: { gap: 4 },
  planRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  planSummary: { color: palette.muted, fontSize: 12, fontVariant: ['tabular-nums'], flexShrink: 1 },
  planExpired: { color: palette.faint },
  planLink: { color: palette.volt, fontSize: 12, fontWeight: '600' },
  planToday: { color: palette.text, fontSize: 12, fontVariant: ['tabular-nums'] },
  headline: { color: palette.text, fontSize: 15, fontWeight: '600' },
  basis: { color: palette.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', gap: 18, flexWrap: 'wrap' },
  cta: { color: palette.volt, fontSize: 13, fontWeight: '700' },
  workout: { gap: 4, borderTopWidth: 1, borderTopColor: palette.lineSoft, paddingTop: 8 },
  wHead: { color: palette.text, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  wRow: { color: palette.text, fontSize: 12, lineHeight: 18, fontVariant: ['tabular-nums'] },
  wNote: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  wError: { color: palette.orange, fontSize: 12, lineHeight: 18 },
});
