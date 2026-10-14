/**
 * ResetFollowUpButton — 「重设追问」按钮（AI 体验整合批 AP4）：docker 版
 * 「清除追问」语义平移——确认后删除追问/计划会话（deleteAiChat），报告与计划
 * 本身保留，下轮提问按原锚惰性重建会话（系统段每轮重拼，只丢对话历史不丢上下文）。
 *
 * 哑组件：弹窗文案按 scope 区分（followup=报告追问 / plan=计划会话），删除动作
 * 经 onReset 交给宿主（各页面自行清状态/重载）。删除类操作二次确认（destructive），
 * pending/在飞生成时宿主传 disabled 禁用，避免删掉正在生成的会话。
 */
import React from 'react';
import { Alert, Pressable, StyleSheet, Text } from 'react-native';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

interface Props {
  scope: 'followup' | 'plan';
  disabled: boolean;
  onReset: () => void | Promise<void>;
}

export function ResetFollowUpButton({ scope, disabled, onReset }: Props) {
  const { t } = useI18n();
  const confirm = () => {
    Alert.alert(
      t('ai.reset.title'),
      t(scope === 'plan' ? 'ai.reset.planBody' : 'ai.reset.followupBody'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('mem.delete'),
          style: 'destructive',
          onPress: () => void onReset(),
        },
      ],
    );
  };
  return (
    <Pressable hitSlop={6} disabled={disabled} onPress={confirm}>
      <Text style={[styles.label, disabled && { opacity: 0.4 }]}>{t('ai.followup.reset')}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: { color: palette.volt, fontSize: 12, fontWeight: '600' },
});
