/**
 * CoachProfileControls.tsx — 「我的」页的教练模式与时间预算控件（业余教练模式 P2）。
 *
 * 纯受控展示组件：模式 / 每周可用时间档 / 可骑日 / 单次时长上限，值由 me.tsx 持有，
 * 随档案保存一起落库（校验在 core/profile 与 db 层，组件不做业务判断）。
 * 周编号 1=周一 … 7=周日（ISO 口径，与训练计划「周从周一开始」一致）。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Chip, SegmentedButtons, TextInput } from 'react-native-paper';
import type { CoachMode, WeeklyHoursTier } from '@/core/settings';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 每周可用时间档（顺序即 UI 顺序；与 core/settings 的 WEEKLY_HOURS_TIERS 同源） */
const HOUR_TIERS: WeeklyHoursTier[] = ['lt3', '3to5', '5to8', 'gt8'];
/** 可骑日（1=周一 … 7=周日） */
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

interface Props {
  coachMode: CoachMode | null;
  weeklyHours: WeeklyHoursTier | null;
  availableDays: number[];
  /** 单次时长上限草稿（TextInput 字符串；空串 = 未设置） */
  sessionMax: string;
  onCoachModeChange: (v: CoachMode | null) => void;
  onWeeklyHoursChange: (v: WeeklyHoursTier | null) => void;
  onToggleDay: (day: number) => void;
  onSessionMaxChange: (v: string) => void;
}

export function CoachProfileControls({
  coachMode,
  weeklyHours,
  availableDays,
  sessionMax,
  onCoachModeChange,
  onWeeklyHoursChange,
  onToggleDay,
  onSessionMaxChange,
}: Props) {
  const { t } = useI18n();
  return (
    <View style={styles.root}>
      <Text style={styles.label}>{t('set.coach.mode')}</Text>
      <SegmentedButtons
        value={coachMode ?? ''}
        onValueChange={(v) => onCoachModeChange(v === '' ? null : (v as CoachMode))}
        buttons={[
          { value: '', label: t('set.coach.mode.unset'), testID: 'coach-mode-unset' },
          { value: 'amateur', label: t('set.coach.mode.amateur'), testID: 'coach-mode-amateur' },
          { value: 'standard', label: t('set.coach.mode.standard'), testID: 'coach-mode-standard' },
        ]}
        density="small"
      />

      <Text style={styles.label}>{t('set.coach.hours')}</Text>
      <SegmentedButtons
        value={weeklyHours ?? ''}
        onValueChange={(v) => onWeeklyHoursChange(v === '' ? null : (v as WeeklyHoursTier))}
        buttons={[
          { value: '', label: t('set.coach.hours.unset'), testID: 'coach-hours-unset' },
          ...HOUR_TIERS.map((tier) => ({
            value: tier,
            label: t(`set.coach.hours.${tier}` as never),
            testID: `coach-hours-${tier}`,
          })),
        ]}
        density="small"
      />

      <Text style={styles.label}>{t('set.coach.days')}</Text>
      <View style={styles.dayRow}>
        {WEEKDAYS.map((d) => (
          <Chip
            key={d}
            compact
            selected={availableDays.includes(d)}
            onPress={() => onToggleDay(d)}
            testID={`coach-day-${d}`}
            style={styles.dayChip}>
            {t(`set.coach.day.${d}` as never)}
          </Chip>
        ))}
      </View>
      <Text style={styles.hint}>{t('set.coach.days.empty')}</Text>

      <TextInput
        mode="outlined"
        dense
        label={t('set.coach.session_max')}
        value={sessionMax}
        onChangeText={onSessionMaxChange}
        keyboardType="numeric"
        style={styles.input}
        testID="coach-session-max"
      />
      <Text style={styles.hint}>{t('set.coach.note')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 8 },
  label: { color: palette.text, fontSize: 13, marginTop: 2 },
  dayRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  dayChip: { backgroundColor: palette.panel2 },
  input: { backgroundColor: palette.panel2 },
  hint: { color: palette.faint, fontSize: 11, lineHeight: 16 },
});
