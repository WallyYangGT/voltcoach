/**
 * AiReviewPanel — 训练详情页内嵌的 AI 复盘面板（对齐 Web 版 views/activities.js 的
 * #aiPanel：自动加载本训练最新的 review 报告，没有则给「AI 复盘」按钮；完成态附
 * 追问线程与「重新生成」）。
 *
 * 三态口径（同 Web 版）：pending 提示生成中、failed 显示错误 + 重试、completed 渲染
 * 报告正文并接上追问。顶部「AI 分析」按钮走 analyze()：已有报告则直接露出本面板，
 * 没有则新建并触发后台生成（口径同 Web 版「已有报告时跳到底部，否则触发分析」）。
 */
import React, { useCallback, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button } from 'react-native-paper';
import { useFocusEffect, useRouter } from 'expo-router';
import * as Clipboard from 'expo-clipboard';
import { getAiConfig, getLatestReviewReport } from '@/db';
import { buildReportPrompt, createReportDraft } from '@/services/aiGenerate';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import { AiReportBody } from './AiReportBody';
import { AskInput, type AskInputInstance } from './AskInput';
import { ChatBubbles } from './ChatBubbles';
import { useAiReport } from './useAiReport';

export interface AiReviewPanelHandle {
  /** 顶部按钮：没有报告就新建并触发生成，然后请页面滚到本面板（已有则仅滚动） */
  analyze: () => void;
}

interface Props {
  fileName: string;
  /** 面板需要露出自身时回调（页面负责滚动） */
  onReveal?: () => void;
  /** 追问输入聚焦信号（页面据此把滚动目标切到追问行） */
  onFollowUpFocus?: () => void;
  /** 追问行容器实例（页面测量位置把整行滚出键盘遮挡，M5） */
  followUpInputRef?: Ref<AskInputInstance>;
  /** 追问行布局回调透传（内容长高——回复落地/多行自增——时页面重滚，M5） */
  onFollowUpLayout?: () => void;
  ref?: React.Ref<AiReviewPanelHandle>;
}

export function AiReviewPanel({ fileName, onReveal, onFollowUpFocus, followUpInputRef, onFollowUpLayout, ref }: Props) {
  const { t, lang } = useI18n();
  const router = useRouter();
  const [reportId, setReportId] = useState<number | null>(null);
  const [looking, setLooking] = useState(true); // 首次查找中：先不渲染，避免"无报告"CTA 闪一下
  const [configured, setConfigured] = useState<boolean | null>(null); // 未配置 AI → 复制提示词兜底
  const [copied, setCopied] = useState(false);
  const busyRef = useRef(false); // analyze 在飞行中（防连点造重复报告）
  const ai = useAiReport(reportId, lang);

  const find = useCallback(async () => {
    try {
      const [r, cfg] = await Promise.all([getLatestReviewReport(fileName), getAiConfig()]);
      setReportId(r?.id ?? null);
      setConfigured(cfg.configured);
    } catch (e) {
      console.warn('训练详情 AI 报告查找失败:', e);
      setReportId(null);
    } finally {
      setLooking(false);
    }
  }, [fileName]);

  useFocusEffect(
    useCallback(() => {
      void find();
    }, [find]),
  );

  /** 新建一份复盘报告并交给 useAiReport 的 pending 恢复路径触发后台生成 */
  const startNew = useCallback(async () => {
    const id = await createReportDraft('review', { file_name: fileName }, lang);
    setReportId(id);
  }, [fileName, lang]);

  const analyze = useCallback(() => {
    if (busyRef.current) return; // 连点保护：查找/新建期间不重复发起
    busyRef.current = true;
    void (async () => {
      try {
        // 以库为准再查一次（防"查找未完成时连点"造出重复报告）
        const current = await getLatestReviewReport(fileName);
        if (current) {
          setReportId(current.id);
        } else {
          // 未配置密钥时不落"注定失败"的占位报告（口径同会话中心：直接给配置/复制提示词）
          const cfg = await getAiConfig();
          setConfigured(cfg.configured);
          if (cfg.configured) await startNew();
        }
      } catch (e) {
        Alert.alert(e instanceof Error ? e.message : String(e));
      } finally {
        busyRef.current = false;
      }
      onReveal?.();
    })();
  }, [fileName, startNew, onReveal]);

  useImperativeHandle(ref, () => ({ analyze }), [analyze]);

  /** 重新生成：新建一份（旧报告留档在会话中心），口径同 Web 版 */
  const { regenerate: regenerateReport, sendFollowUp, retryChatMessage } = ai;
  const regenerate = useCallback(() => {
    void (async () => {
      try {
        setReportId(await regenerateReport());
      } catch (e) {
        Alert.alert(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [regenerateReport]);

  const retryFollowUp = useCallback(
    (messageId: number) => {
      const chat = ai.chat;
      if (chat) retryChatMessage(chat.id, messageId);
    },
    [ai.chat, retryChatMessage],
  );

  const send = useCallback(
    async (text: string) => {
      const err = await sendFollowUp(text);
      if (err) Alert.alert(err);
    },
    [sendFollowUp],
  );

  /** 复制提示词兜底（未配置密钥时的降级路径，口径同会话中心 §1.2） */
  const copyPrompt = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(await buildReportPrompt('review', { file_name: fileName }, lang));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      Alert.alert(t('ai.center.copyFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  }, [fileName, lang, t]);

  if (looking) return null;

  const report = ai.report;
  const title =
    report == null
      ? t('ai.panel')
      : report.status === 'pending'
        ? t('ai.panel.pending')
        : report.status === 'failed'
          ? t('ai.panel.failed')
          : t('ai.panel.cached', { id: report.id });

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Text style={styles.cardTitle}>{title}</Text>
        {report?.status === 'completed' && (
          <Button compact mode="text" textColor={palette.volt} onPress={regenerate}>
            {t('ai.regen')}
          </Button>
        )}
      </View>

      {report == null ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.hint}>{t('ai.panel.empty_hint')}</Text>
          {configured === false ? (
            // 未配置 AI 服务：给"去配置"与"复制提示词"两条路，免得点下去只报密钥缺失
            <View style={{ gap: 6 }}>
              <Text style={styles.hint}>{t('ai.center.unconfigured')}</Text>
              <View style={styles.btnRow}>
                <Button
                  compact
                  mode="contained"
                  buttonColor={palette.volt}
                  textColor={palette.bg}
                  onPress={() => router.push('/me')}>
                  {t('ai.center.toSettings')}
                </Button>
                <Button compact mode="outlined" textColor={palette.volt} onPress={copyPrompt}>
                  {copied ? t('ai.center.copied') : t('common.copy')}
                </Button>
              </View>
            </View>
          ) : (
            <Button
              mode="contained"
              buttonColor={palette.volt}
              textColor={palette.bg}
              icon="robot-outline"
              onPress={analyze}>
              {t('btn.ai_review')}
            </Button>
          )}
        </View>
      ) : (
        <>
          <AiReportBody
            report={report}
            progress={ai.progress}
            elapsedSec={ai.elapsedSec}
            generating={ai.generating}
            onRetry={ai.retry}
          />
          {report.status === 'completed' && (
            <View style={styles.followUp}>
              <Text style={styles.hint}>{t('session.followUp.hint')}</Text>
              {!!ai.chat && (
                <ChatBubbles chatId={ai.chat.id} messages={ai.chat.messages} onRetry={retryFollowUp} />
              )}
              <AskInput
                ref={followUpInputRef}
                placeholder={t('session.followUp.hint')}
                sending={ai.sending}
                onSend={send}
                maxHeight={100}
                onFocus={onFollowUpFocus}
                onLayout={onFollowUpLayout}
              />
            </View>
          )}
        </>
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
    gap: 10,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitle: { color: palette.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  hint: { color: palette.muted, fontSize: 12.5, lineHeight: 18 },
  btnRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  followUp: { gap: 8, borderTopWidth: 1, borderTopColor: palette.lineSoft, paddingTop: 10 },
});
