/**
 * ChatInviteCard — 首页吸底常驻的「和教练讨论一下」输入框卡片（AI 体验整合批 AP1
 * 顶置 → 2026-10-15 迁移为吸底：位置迁移非推翻，会话页转场/聚焦链路不动）。
 *
 * 哑组件：视觉仿输入框（muted 占位文案 + volt chat 图标 + volt 高亮描边——用户拍板
 * 直接主题黄一笔描边，与灰底卡片群拉开），点击整卡跳新对话页；自动聚焦由会话页侧
 * 按路由参数 autoFocus 驱动（AskInput.autoFocus），卡片带 initialDraft 预填（今日
 * 建议卡「和教练聊聊」出口）。渲染门（未配置 LLM Key 整卡隐藏）在首页侧控制。
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
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.85 }]}
      onPress={onPress}>
      <Icon source="chat" size={18} color={palette.volt} />
      <Text style={styles.placeholder}>{t('ai.invite.placeholder')}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // 主题 volt 高亮描边（2026-10-15 用户拍板：双环光环太花，直接 volt 一笔画出吸底卡的「活」入口感）
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.volt,
    borderWidth: 1.5,
    borderRadius: 10,
    paddingVertical: 13,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  placeholder: { color: palette.muted, fontSize: 14 },
});
