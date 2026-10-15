/**
 * TodayAdviceCard.tsx — 首页「今日建议」卡（U1 收尾①：教练执行闭环的零 token 半边）。
 *
 * 回答「今天怎么办」，与 WeeklyPlanCard（这周怎么排）分工：结论 + 一行依据 + 双出口。
 * 判定全部在 core/today-advice 纯函数（阈值只引 FORM_SIMULATION 单源），组件零硬编码；
 * TSB 用首页 recentFormDaily 末端（props 传入，与 hero 同源不重算），计划读 settings
 * 当前行（自加载，OnelapSyncCard/WeeklyPlanCard 先例）。纯本地计算，不被 LLM Key
 * 门控——无 Key 用户「教练感」的主来源；空库（last=null）整卡隐藏。
 *
 * 双出口：「看今日课表」= generateWorkout 本地秒出课表（卡内展开渲染）；
 * 「和教练聊聊」= 深链新对话并预填上下文（session 页 draft 参数，AP1 聚焦链路照旧）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getCurrentPlan, type StoredPlan } from '@/db';
import type { TrendPoint } from '@/charts/TrendChart';
import type { AthleteParams } from '@/core/settings';
import { localDay } from '@/core/local-day';
import { planValidity } from '@/core/training-plan';
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
  const { t } = useI18n();
  const router = useRouter();
  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [workout, setWorkout] = useState<WorkoutResult | null>(null);

  const load = useCallback(async () => {
    try {
      setStored(await getCurrentPlan());
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
  const session = stored?.plan.sessions.find((s) => s.date === today) ?? null;
  const planState = stored ? planValidity(stored.plan, today).state : null;
  const advice = computeTodayAdvice({ tsb: last.tsb, trainedToday, session, planState });

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

  // 一行依据：TSB + 计划交叉（roadmap 口径「建议轻松骑 · TSB -15 / 计划阈值课」，不堆原始数值）
  const planPart = advice.hasPlan
    ? advice.planned && typeLabel
      ? `${t('dash.today.plan_prefix')}${typeLabel}`
      : t('dash.today.basis_free')
    : t('dash.today.basis_noplan');
  const basis = t('dash.today.basis', { tsb: tsbStr, plan: planPart });

  const onWorkout = () => {
    if (!advice.workoutTarget) return;
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

  return (
    <View style={styles.card} testID="today-advice-card">
      <View style={styles.head}>
        <Text style={styles.title}>{t('dash.today.title')}</Text>
        <Text style={[styles.badge, { color: LEVEL_COLOR[advice.level] }]}>
          {t(`dash.today.level.${advice.level}` as never)}
        </Text>
      </View>
      <Text style={styles.headline}>{head}</Text>
      <Text style={styles.basis}>{basis}</Text>

      {/* 双出口（done 免扰档不出）；无 FTP 时课表出口隐藏（瓦特区间无意义） */}
      {advice.level !== 'done' && (
        <View style={styles.actions}>
          {advice.workoutTarget != null && (
            <Pressable hitSlop={8} onPress={onWorkout}>
              <Text style={styles.cta}>
                {workout ? t('dash.today.workout_hide') : t('dash.today.workout_btn')}
              </Text>
            </Pressable>
          )}
          <Pressable hitSlop={8} onPress={onChat}>
            <Text style={styles.cta}>{t('dash.today.chat_btn')}</Text>
          </Pressable>
          {!advice.hasPlan && (
            <Pressable hitSlop={8} onPress={() => router.push('/plan')}>
              <Text style={styles.cta}>{t('dash.today.plan_btn')}</Text>
            </Pressable>
          )}
        </View>
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
