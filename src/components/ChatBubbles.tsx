/**
 * ChatBubbles — 追问/对话消息气泡流（会话详情页与训练详情页共用）。
 *
 * 状态口径：pending 显示生成状态行（思考/工具/生成三态，2026-10 可视化：菱形/放大镜
 * 闪烁 + 推理模型思考正文单行滚动；有传输级自动重试时附重试进度，2026-10 增量落库后
 * 附部分正文实时预览与停止按钮——直接停止不弹框，对话单次消耗小）；cancelled 显示
 * "已取消" + 部分正文 + 重试；failed 显示错误 + 重试；completed 渲染 Markdown。
 * user 消息右对齐、AI 消息占满整行（左缘对齐）。
 * M5：重试按消息逐条生效（此前固定重跑第一条失败消息，点第 3 条实际重试第 1 条）；
 * 该消息在跑时重试按钮禁用（此前无 disabled，「实际在重试还能点」即此）。
 * 2026-10-18 宽度口径：AI 气泡占满可用宽度（stretch），不再按内容收缩——收缩布局下
 * GenStatusRow 的思考 ticker（flex:1 横向滚动）不贡献内在宽度，pending 气泡会被压成
 * 图标宽，对话页几乎看不到思考/工具信息；Markdown 表格也更需要整行宽度。用户气泡
 * 仍右对齐且上限 88%（短消息保留聊天气泡形态）。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from 'react-native-paper';
import type { AiChatMessageRow } from '@/db';
import { getChatProgress, isChatGenerating } from '@/services/aiGenerate';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import { AiMarkdown } from './AiMarkdown';
import { GenStatusRow } from './GenStatusRow';

interface Props {
  chatId: number;
  messages: AiChatMessageRow[];
  /** 失败/取消气泡上的重试：以该条消息重跑生成 */
  onRetry: (messageId: number) => void;
  /** 停止该条消息的生成（2026-10，仅 pending 气泡显示；缺省不显示按钮） */
  onCancelMessage?: (messageId: number) => void;
}

export function ChatBubbles({ chatId, messages, onRetry, onCancelMessage }: Props) {
  const { t } = useI18n();
  return (
    <View style={styles.list}>
      {messages.map((m) => {
        // pending（生成中）与 failed/cancelled（重试中）都可能带传输级自动重试进度；
        // 在跑判定看进程内注册表（手动重试/残留补跑时库状态仍是 failed/cancelled）
        const running = m.status !== 'completed' && isChatGenerating(chatId, m.id);
        const progress =
          m.status === 'pending' || m.status === 'failed' || m.status === 'cancelled'
            ? getChatProgress(chatId, m.id)
            : null;
        return (
          <View
            key={m.id}
            testID={`chat-bubble-${m.id}`}
            style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}>
            {m.status === 'pending' && (
              <View style={{ gap: 4 }}>
                <GenStatusRow progress={progress} live />
                {!!progress?.note && (
                  <Text style={styles.progressNote}>
                    {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
                  </Text>
                )}
                {/* 增量落库的部分正文实时预览（口径同 AiReportBody 的 pending 预览） */}
                {!!m.content &&
                  (m.role === 'user' ? (
                    <Text style={styles.bubbleUserText}>{m.content}</Text>
                  ) : (
                    <AiMarkdown markdown={m.content} />
                  ))}
                {/* 停止按钮只给 AI 气泡（user 消息不存在生成态）；直接停止不弹确认框。
                    视觉口径（2026-10-15）：描边 + stop 图标 + 右对齐 + orange——「停止」是
                    主动控制不是错误恢复，红色系留给 failed 盒，消掉「红色=出错」的联想 */}
                {!!onCancelMessage && m.role === 'assistant' && (
                  <Button
                    compact
                    mode="outlined"
                    icon="stop"
                    textColor={palette.orange}
                    style={styles.cancelBtn}
                    testID="cancel-generate"
                    onPress={() => onCancelMessage(m.id)}>
                    {t('ai.cancelGenerate')}
                  </Button>
                )}
              </View>
            )}
            {m.status === 'cancelled' && (
              <View style={{ gap: 6 }}>
                <Text style={styles.cancelledText}>{t('ai.badge.cancelled')}</Text>
                {/* 重试期间（running）停止按钮同样可达——「疯狂重试能停」不分状态（code-review P1-2） */}
                {running && !!onCancelMessage && (
                  <Button
                    compact
                    mode="outlined"
                    icon="stop"
                    textColor={palette.orange}
                    style={styles.cancelBtn}
                    testID="cancel-generate"
                    onPress={() => onCancelMessage(m.id)}>
                    {t('ai.cancelGenerate')}
                  </Button>
                )}
                <GenStatusRow progress={progress} live={running} />
                {!!m.content && <AiMarkdown markdown={m.content} />}
                <Button
                  compact
                  mode="outlined"
                  textColor={palette.volt}
                  disabled={running}
                  onPress={() => onRetry(m.id)}>
                  {running || progress ? t('ai.retrying') : t('session.retry')}
                </Button>
                {/* 重试期间库状态仍是 cancelled：自动重试进度要在这里也可见（同 AiReportBody） */}
                {!!progress?.note && (
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
                {/* 重试期间（running）停止按钮同样可达（同 cancelled 分支） */}
                {running && !!onCancelMessage && (
                  <Button
                    compact
                    mode="outlined"
                    icon="stop"
                    textColor={palette.orange}
                    style={styles.cancelBtn}
                    testID="cancel-generate"
                    onPress={() => onCancelMessage(m.id)}>
                    {t('ai.cancelGenerate')}
                  </Button>
                )}
                <GenStatusRow progress={progress} live={running} />
                <Button
                  compact
                  mode="outlined"
                  textColor={palette.volt}
                  disabled={running}
                  onPress={() => onRetry(m.id)}>
                  {running || progress ? t('ai.retrying') : t('session.retry')}
                </Button>
                {/* 重试期间库状态仍是 failed：自动重试进度要在这里也可见（同 AiReportBody） */}
                {!!progress?.note && (
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
  bubble: { borderRadius: 10, padding: 10, marginBottom: 8 },
  // 宽度上限只给用户气泡；AI 气泡走 stretch（见文件头 2026-10-18 口径）
  bubbleUser: { alignSelf: 'flex-end', maxWidth: '88%', backgroundColor: '#20301a', borderWidth: 1, borderColor: palette.voltDim },
  bubbleAi: { alignSelf: 'stretch', backgroundColor: palette.panel, borderWidth: 1, borderColor: palette.lineSoft },
  bubbleUserText: { color: palette.text, fontSize: 13, lineHeight: 20 },
  progressNote: { color: palette.faint, fontSize: 11, lineHeight: 16 },
  failedText: { color: palette.red, fontSize: 13, fontWeight: '700' },
  failedErr: { color: palette.muted, fontSize: 12 },
  cancelledText: { color: palette.orange, fontSize: 13, fontWeight: '700' },
  // 停止按钮：主题 outline 是 line 灰，需显式盖边框色（先例 ai 页 volt 描边）
  cancelBtn: { borderColor: palette.orange, alignSelf: 'flex-end' },
});
