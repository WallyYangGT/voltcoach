/**
 * ChatBubbles — 追问/对话消息气泡流（会话详情页与训练详情页共用）。
 *
 * 三态口径同 M3：pending 显示"生成中…"（有传输级自动重试时附重试进度）、failed
 * 显示错误 + 重试、completed 渲染 Markdown。user 消息右对齐、AI 左对齐。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from 'react-native-paper';
import type { AiChatMessageRow } from '@/db';
import { getChatProgress } from '@/services/aiGenerate';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import { AiMarkdown } from './AiMarkdown';

interface Props {
  chatId: number;
  messages: AiChatMessageRow[];
  /** 失败气泡上的重试：以同一条消息重跑生成 */
  onRetry: () => void;
}

export function ChatBubbles({ chatId, messages, onRetry }: Props) {
  const { t } = useI18n();
  return (
    <View style={styles.list}>
      {messages.map((m) => {
        // pending（生成中）与 failed（重试中）都可能带传输级自动重试进度
        const progress = m.status === 'pending' || m.status === 'failed'
          ? getChatProgress(chatId, m.id)
          : null;
        return (
          <View
            key={m.id}
            style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}>
            {m.status === 'pending' && (
              <View style={{ gap: 4 }}>
                <Text style={styles.pendingNote}>{t('session.generating')}</Text>
                {!!progress && (
                  <Text style={styles.progressNote}>
                    {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
                  </Text>
                )}
              </View>
            )}
            {m.status === 'failed' && (
              <View style={{ gap: 6 }}>
                <Text style={styles.failedText}>{t('session.failed')}</Text>
                {!!m.error && <Text style={styles.failedErr}>{m.error}</Text>}
                <Button compact mode="outlined" textColor={palette.volt} onPress={onRetry}>
                  {progress ? t('ai.retrying') : t('session.retry')}
                </Button>
                {/* 重试期间库状态仍是 failed：自动重试进度要在这里也可见（同 AiReportBody） */}
                {!!progress && (
                  <Text style={styles.progressNote}>
                    {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
                  </Text>
                )}
              </View>
            )}
            {m.status === 'completed' &&
              !!m.content &&
              (m.role === 'user' ? (
                <Text style={styles.bubbleUserText}>{m.content}</Text>
              ) : (
                <AiMarkdown markdown={m.content} />
              ))}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 0 },
  bubble: { maxWidth: '88%', borderRadius: 10, padding: 10, marginBottom: 8 },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#20301a', borderWidth: 1, borderColor: palette.voltDim },
  bubbleAi: { alignSelf: 'flex-start', backgroundColor: palette.panel, borderWidth: 1, borderColor: palette.lineSoft },
  bubbleUserText: { color: palette.text, fontSize: 13, lineHeight: 20 },
  pendingNote: { color: palette.orange, fontSize: 12 },
  progressNote: { color: palette.faint, fontSize: 11, lineHeight: 16 },
  failedText: { color: palette.red, fontSize: 13, fontWeight: '700' },
  failedErr: { color: palette.muted, fontSize: 12 },
});
