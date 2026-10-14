/**
 * ChatInviteCard — 首页顶部的「和教练讨论一下」输入框卡片（AI 体验整合批 AP1）。
 *
 * 哑组件：视觉仿输入框（muted 占位文案 + volt chat 图标），点击整卡跳新对话页；
 * 自动聚焦由会话页侧按路由参数 autoFocus 驱动（AskInput.autoFocus），卡片不带草稿。
 * 渲染门（未配置 LLM Key 整卡隐藏）在首页侧控制——与 WeeklyPlanCard、原对话 FAB
 * 同口径；AP1 起对话 FAB 由本卡替代移除。
 */
import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Icon } from 'react-native-paper';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

interface Props {
  onPress: () => void;
}

export function ChatInviteCard({ onPress }: Props) {
  const { t } = useI18n();
  return (
    <Pressable
      testID="chat-invite-card"
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.8 }]}
      onPress={onPress}>
      <Icon source="chat" size={18} color={palette.volt} />
      <Text style={styles.placeholder}>{t('ai.invite.placeholder')}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  placeholder: { color: palette.muted, fontSize: 14 },
});
