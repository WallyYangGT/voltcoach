/**
 * ChatEmptyHero — 直接对话页的空态引导（AI 体验整合批 AP2）：空会话时正文区
 * 不再白屏。占位文案与首页输入卡片同族（ai.invite.placeholder），副行复用
 * session.chat.hint。纯展示组件——首条消息出现后即被消息流替代，无交互。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Icon } from 'react-native-paper';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export function ChatEmptyHero() {
  const { t } = useI18n();
  return (
    <View style={styles.hero}>
      <Icon source="chat-processing-outline" size={40} color={palette.faint} />
      <Text style={styles.title}>{t('ai.invite.placeholder')}</Text>
      <Text style={styles.sub}>{t('session.chat.hint')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 10, paddingVertical: 48 },
  title: { color: palette.text, fontSize: 16, fontWeight: '600' },
  sub: { color: palette.muted, fontSize: 12.5, textAlign: 'center', lineHeight: 18 },
});
