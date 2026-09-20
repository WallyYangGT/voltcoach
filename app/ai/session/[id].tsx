/**
 * AI 会话详情（M3）：参数 `<type>-<id>`——
 * - report-<id>：报告页（pending 生成中轮询 / failed 错误+重试 / completed 渲染
 *   Markdown 正文 + 内嵌追问线程）；追问对话按 report_id 找回（findFollowUpChat），
 *   首条追问时创建 follow_up 对话；支持系统分享 Markdown 全文。
 * - chat-<id>：直接对话（气泡流 + 输入框）。
 * - chat-new：新建对话（首条消息发送时才落库建对话，之后 replace 到真实 id）。
 *
 * 移植自 Web 版 web/js/ai.js（runAi/attachFollowUp/pollAiChat）与 views/chat.js。
 * 旧版"202 + 1.5s 轮询服务端"改为本地：fire 编排层任务 + 1.5s 轮询本地 db；
 * 应用中途被杀留下的 pending 占位，重进本页自动重跑生成（系统段可重拼）。
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { Appbar, Button, TextInput } from 'react-native-paper';
import Markdown from 'react-native-markdown-display';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  findFollowUpChat,
  getAiChat,
  getAiReport,
  type AiChatMessageRow,
} from '@/db';
import { generateReport, isChatGenerating, isReportGenerating, runChatGeneration, submitChatMessage } from '@/services/aiGenerate';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

const POLL_MS = 1500; // 生成中轮询节奏（对齐旧 Web 版 pollAiChat 间隔）

export default function AiSessionScreen() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string }>();
  const raw = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  // 路由参数解析：<type>-<id>（chat-new 为新建对话的特殊形态）
  const [kind, idStr] = raw.split('-');
  const entityId = /^\d+$/.test(idStr ?? '') ? Number(idStr) : null;
  const isNewChat = raw === 'chat-new';

  const [report, setReport] = useState<Awaited<ReturnType<typeof getAiReport>>>(null);
  const [chat, setChat] = useState<Awaited<ReturnType<typeof getAiChat>>>(null);
  const [followChatId, setFollowChatId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 上一次加载的实体 id：切换报告/对话时重置追问线程状态，防跨报告残留
  const lastEntityRef = useRef<string | null>(null);

  const title =
    kind === 'report'
      ? report
        ? t(`ai.mode.${report.mode}` as never)
        : t('ai.title')
      : t('session.chatTitle');

  /** 拉取当前页面数据（报告本体 / 对话消息流 / 追问对话 id）；
   *  发现 pending 残留（应用被杀中断、进程内无对应任务在跑）时补跑生成恢复 */
  const load = useCallback(async () => {
    try {
      // 实体切换时先清追问线程状态（load 抛错也不至于把追问写进另一份报告）
      const entityKey = `${kind}-${entityId}`;
      if (lastEntityRef.current !== entityKey) {
        lastEntityRef.current = entityKey;
        setFollowChatId(null);
        setChat(null);
      }
      if (kind === 'report' && entityId != null) {
        const r = await getAiReport(entityId);
        setReport(r);
        if (r) {
          if (r.status === 'pending' && !isReportGenerating(r.id)) {
            void generateReport(r.id, lang);
          }
          const fid = await findFollowUpChat(r.id);
          setFollowChatId(fid);
          if (fid) setChat(await getAiChat(fid));
        }
      } else if (kind === 'chat' && entityId != null) {
        const c = await getAiChat(entityId);
        setChat(c);
        if (c) {
          for (const m of c.messages) {
            if (m.status === 'pending' && !isChatGenerating(c.id, m.id)) {
              void runChatGeneration(c.id, m.id, lang);
            }
          }
        }
      }
    } catch (e) {
      console.warn('会话详情加载失败:', e);
    }
  }, [kind, entityId, lang]);

  useFocusEffect(
    useCallback(() => {
      load();
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      };
    }, [load]),
  );

  const hasPending = !!chat?.messages.some((m) => m.status === 'pending') ||
    (kind === 'report' && report?.status === 'pending');

  /** 生成中：1.5s 轮询本地 db；结束后停止 */
  useFocusEffect(
    useCallback(() => {
      if (!hasPending) return;
      pollRef.current = setInterval(() => {
        void load();
      }, POLL_MS);
      return () => {
        if (pollRef.current) clearInterval(pollRef.current);
        pollRef.current = null;
      };
    }, [hasPending, load]),
  );

  /** 重试：报告失败 → 重跑生成；对话消息失败 → 以同一消息重跑生成（运行中注册表防双跑） */
  const retry = () => {
    if (kind === 'report' && entityId != null) {
      void generateReport(entityId, lang);
      load();
    } else if (chat) {
      const target = chat.messages.find((m) => m.status === 'failed' || m.status === 'pending');
      if (target) void runChatGeneration(chat.id, target.id, lang);
      load();
    }
  };

  const shareReport = async () => {
    if (!report?.markdown) {
      Alert.alert(t('session.sharedEmpty'));
      return;
    }
    try {
      await Share.share({ message: report.markdown });
    } catch {
      // 用户取消分享不提示
    }
  };

  /** 发送消息：follow_up（报告页输入框）/ chat（对话页输入框）统一走编排层 */
  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      if (kind === 'report') {
        if (!report) return;
        const { chatId, messageId } = await submitChatMessage(
          {
            chatId: followChatId,
            mode: 'follow_up',
            message: text,
            reportId: report.id,
            fileName: report.file_name,
          },
          lang,
        );
        setFollowChatId(chatId);
        void runChatGeneration(chatId, messageId, lang);
      } else if (isNewChat) {
        // 新对话：首条消息落库建对话后 replace 到真实 id（返回列表可见）
        const { chatId, messageId } = await submitChatMessage({ mode: 'chat', message: text }, lang);
        setDraft('');
        router.replace(`/ai/session/chat-${chatId}`);
        void runChatGeneration(chatId, messageId, lang);
        return;
      } else if (entityId != null) {
        const { messageId } = await submitChatMessage({ chatId: entityId, mode: 'chat', message: text }, lang);
        void runChatGeneration(entityId, messageId, lang);
      }
      setDraft('');
      await load();
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const messages: AiChatMessageRow[] = chat?.messages ?? [];

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={title} titleStyle={styles.headerTitle} />
        {kind === 'report' && (
          <Appbar.Action icon="share-variant-outline" onPress={shareReport} />
        )}
      </Appbar.Header>

      {/* 滚动容器：报告正文（三态）与消息气泡流共用（P0 修复——长报告必须可滚动） */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {kind === 'report' && report?.status === 'pending' && (
          <Text style={styles.centerNote}>{t('session.reportPending')}</Text>
        )}
        {kind === 'report' && report?.status === 'failed' && (
          <View style={styles.failedBox}>
            <Text style={styles.failedText}>{t('session.failed')}</Text>
            {!!report.error && <Text style={styles.failedErr}>{report.error}</Text>}
            <Button compact mode="outlined" textColor={palette.volt} onPress={retry}>
              {t('session.retry')}
            </Button>
          </View>
        )}
        {kind === 'report' && report?.status === 'completed' && (
          <Markdown style={mdStyles}>{report.markdown}</Markdown>
        )}

        {/* 消息流（chat 页全程 / report 页的追问线程） */}
        {messages.length > 0 && (
          <View style={[styles.followUp, kind === 'report' && report?.status === 'completed' && styles.followUpTop]}>
            {kind === 'report' && report?.status === 'completed' && (
              <Text style={styles.followUpHead}>{t('session.followUp.hint')}</Text>
            )}
            {messages.map((m) => (
              <View key={m.id} style={[styles.bubble, m.role === 'user' ? styles.bubbleUser : styles.bubbleAi]}>
                {m.status === 'pending' && <Text style={styles.pendingNote}>{t('session.generating')}</Text>}
                {m.status === 'failed' && (
                  <View style={{ gap: 6 }}>
                    <Text style={styles.failedText}>{t('session.failed')}</Text>
                    {!!m.error && <Text style={styles.failedErr}>{m.error}</Text>}
                    <Button compact mode="outlined" textColor={palette.volt} onPress={retry}>
                      {t('session.retry')}
                    </Button>
                  </View>
                )}
                {m.status === 'completed' && !!m.content && (
                  m.role === 'user' ? (
                    <Text style={styles.bubbleUserText}>{m.content}</Text>
                  ) : (
                    <Markdown style={mdStyles}>{m.content}</Markdown>
                  )
                )}
              </View>
            ))}
          </View>
        )}
      </ScrollView>

      {/* 输入行：report 页仅 completed 后开放追问；chat 页常开。
          发送用显性 Button（Paper TextInput.Icon 在 multiline 下触摸不可靠，冒烟实证） */}
      {(kind === 'chat' || report?.status === 'completed') && (
        <View style={[styles.inputRow, { paddingBottom: insets.bottom + 10 }]}>
          <TextInput
            mode="outlined"
            dense
            multiline
            value={draft}
            onChangeText={setDraft}
            placeholder={kind === 'report' ? t('session.followUp.hint') : t('session.chat.hint')}
            style={styles.input}
          />
          <Button
            mode="contained"
            compact
            buttonColor={palette.volt}
            textColor={palette.bg}
            disabled={sending || !draft.trim()}
            onPress={send}>
            {t('session.send')}
          </Button>
        </View>
      )}
    </View>
  );
}

/** Markdown 暗色样式（跟随 Web 版报告排版的关键口径：标题 volt、表格细线） */
const mdStyles = {
  body: { color: palette.text, fontSize: 14, lineHeight: 22 },
  heading1: { color: palette.volt, fontSize: 19, fontWeight: '700' as const, marginTop: 14, marginBottom: 6 },
  heading2: { color: palette.volt, fontSize: 17, fontWeight: '700' as const, marginTop: 12, marginBottom: 5 },
  heading3: { color: palette.text, fontSize: 15, fontWeight: '700' as const, marginTop: 10, marginBottom: 4 },
  strong: { color: palette.text, fontWeight: '700' as const },
  bullet_list: { marginVertical: 4 },
  ordered_list: { marginVertical: 4 },
  list_item: { marginVertical: 2 },
  paragraph: { marginTop: 0, marginBottom: 8 },
  code_inline: { color: palette.cyan, backgroundColor: palette.panel2, fontSize: 13 },
  fence: { color: palette.cyan, backgroundColor: palette.panel2, fontSize: 12, padding: 10, borderRadius: 8 },
  table: { borderWidth: 1, borderColor: palette.line, borderRadius: 6, marginVertical: 8 },
  thead: { backgroundColor: palette.panel2 },
  th: { color: palette.text, padding: 6, borderWidth: 0.5, borderColor: palette.line },
  td: { color: palette.text, padding: 6, borderWidth: 0.5, borderColor: palette.line },
  blockquote: { backgroundColor: palette.panel, borderLeftWidth: 3, borderLeftColor: palette.volt, paddingHorizontal: 10, paddingVertical: 4, marginVertical: 6 },
  hr: { backgroundColor: palette.line, marginVertical: 10 },
  link: { color: palette.cyan },
};

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, borderBottomWidth: 1, borderBottomColor: palette.lineSoft },
  headerTitle: { color: palette.text, fontSize: 15 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  followUp: { gap: 8 },
  followUpTop: { borderTopWidth: 1, borderTopColor: palette.lineSoft, paddingTop: 10, marginTop: 4 },
  followUpHead: { color: palette.faint, fontSize: 11 },
  centerNote: { color: palette.muted, fontSize: 13, textAlign: 'center', marginTop: 48 },
  failedBox: { margin: 16, padding: 12, borderWidth: 1, borderColor: palette.red, borderRadius: 10, gap: 6 },
  failedText: { color: palette.red, fontSize: 13, fontWeight: '700' },
  failedErr: { color: palette.muted, fontSize: 12 },
  bubble: {
    maxWidth: '88%',
    borderRadius: 10,
    padding: 10,
    marginBottom: 8,
  },
  bubbleUser: { alignSelf: 'flex-end', backgroundColor: '#20301a', borderWidth: 1, borderColor: palette.voltDim },
  bubbleAi: { alignSelf: 'flex-start', backgroundColor: palette.panel, borderWidth: 1, borderColor: palette.lineSoft },
  bubbleUserText: { color: palette.text, fontSize: 13, lineHeight: 20 },
  pendingNote: { color: palette.orange, fontSize: 12 },
  inputRow: { paddingHorizontal: 12, paddingTop: 6, flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { backgroundColor: palette.panel, maxHeight: 120, flex: 1 },
});
