/**
 * AI 会话详情（M3）：参数 `<type>-<id>`——
 * - report-<id>：报告页（pending 生成中轮询 / failed 错误+重试 / completed 渲染
 *   Markdown 正文 + 内嵌追问线程）；追问对话按 report_id 找回（findFollowUpChat），
 *   首条追问时创建 follow_up 对话；支持系统分享 Markdown 全文、「重新生成」。
 * - chat-<id>：直接对话（气泡流 + 输入框）。
 * - chat-new：新建对话（首条消息发送时才落库建对话，之后 replace 到真实 id）。
 *
 * 移植自 Web 版 web/js/ai.js（runAi/attachFollowUp/pollAiChat）与 views/chat.js。
 * 旧版"202 + 1.5s 轮询服务端"改为本地：fire 编排层任务 + 1.5s 轮询本地 db；
 * 应用中途被杀留下的 pending 占位，重进本页自动重跑生成（系统段可重拼）。
 * 报告状态机与三态正文抽到 useAiReport / AiReportBody（与训练详情页 AI 面板共用）。
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { Appbar } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AiReportBody } from '@/components/AiReportBody';
import { AskInput } from '@/components/AskInput';
import { ChatBubbles } from '@/components/ChatBubbles';
import { ChatEmptyHero } from '@/components/ChatEmptyHero';
import { ResetFollowUpButton } from '@/components/ResetFollowUpButton';
import { useAiReport } from '@/components/useAiReport';
import { deleteAiChat, getAiChat, type AiChatRow } from '@/db';
import {
  cancelChatGeneration,
  cancelReportGeneration,
  isChatGenerating,
  runChatGeneration,
  submitChatMessage,
} from '@/services/aiGenerate';
import { useReportTitle } from '@/services/aiTitle';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

const POLL_MS = 1500; // 直接对话的 pending 轮询节奏（报告页在 useAiReport 内同频轮询）

export default function AiSessionScreen() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id?: string; autoFocus?: string | string[]; draft?: string | string[] }>();
  const raw = Array.isArray(params.id) ? params.id[0] : (params.id ?? '');
  // 路由参数解析：<type>-<id>（chat-new 为新建对话的特殊形态）
  const [kind, idStr] = raw.split('-');
  const entityId = /^\d+$/.test(idStr ?? '') ? Number(idStr) : null;
  const isNewChat = raw === 'chat-new';
  // AP1：进入即聚焦输入框——chat-new 天然聚焦；replace 到真实 id 时经参数续焦
  // （首页输入卡片入口直达可输入态；从会话中心浏览既有对话不聚焦）
  const rawAutoFocus = Array.isArray(params.autoFocus) ? params.autoFocus[0] : params.autoFocus;
  const wantsFocus = isNewChat || rawAutoFocus === '1';
  // 预填草稿（2026-10-15：今日建议卡「和教练聊聊」深链带上下文；仅 chat 分支消费）
  const rawDraft = Array.isArray(params.draft) ? params.draft[0] : params.draft;

  const [sending, setSending] = useState(false);

  // 键盘浮起（M5）：edge-to-edge 下系统 adjustResize 失效，由 KeyboardProvider +
  // KeyboardAvoidingView 接管——输入行跟随键盘上移，用户能看到正在输入的内容
  const scrollRef = useRef<ScrollView>(null);
  const kbVisible = useKeyboardState((s) => s.isVisible);

  // 报告分支：状态机与三态正文由共用 hook 提供（含"重试中继续轮询"的修正）
  const ai = useAiReport(kind === 'report' ? entityId : null, lang);

  // 对话分支（chat / chat-new）
  const [chatRow, setChatRow] = useState<AiChatRow | null>(null);

  const loadChat = useCallback(async () => {
    if (kind !== 'chat' || entityId == null) return;
    try {
      const c = await getAiChat(entityId);
      setChatRow(c);
      if (c) {
        for (const m of c.messages) {
          if (m.status === 'pending' && !isChatGenerating(c.id, m.id)) {
            // pending 残留（应用被杀中断）：以同一消息重跑即可恢复
            void runChatGeneration(c.id, m.id, lang).catch((e) =>
              console.warn('对话恢复生成失败:', e),
            );
          }
        }
      }
    } catch (e) {
      console.warn('对话加载失败:', e);
    }
  }, [kind, entityId, lang]);

  useFocusEffect(
    useCallback(() => {
      void loadChat();
    }, [loadChat]),
  );

  // 报告页的追问线程与对话页的消息流统一成一个变量（重试逻辑随之共用）
  const chat = kind === 'report' ? ai.chat : chatRow;
  const chatMessages = chat?.messages ?? [];

  // 新消息到达（含自己发送的）→ 滚到底：键盘浮起后可视区变矮，最新气泡容易落在折叠线下
  const lastMsgCountRef = useRef(0);
  useEffect(() => {
    if (chatMessages.length > lastMsgCountRef.current) {
      scrollRef.current?.scrollToEnd({ animated: true });
    }
    lastMsgCountRef.current = chatMessages.length;
  }, [chatMessages.length]);

  // 键盘弹出 → 滚到底：等 KeyboardAvoidingView 的 padding 动画落位后再滚
  useEffect(() => {
    if (!kbVisible) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 260);
    return () => clearTimeout(timer);
  }, [kbVisible]);

  // 对话 pending 轮询（报告页轮询在 useAiReport 内）。
  // chatRunning：失败气泡点重试时库状态仍是 failed、只有进程内有任务——不轮询就永远停在失败态
  const chatPending = !!chatRow?.messages.some((m) => m.status === 'pending');
  const chatRunning = !!chatRow && chatRow.messages.some((m) => isChatGenerating(chatRow.id, m.id));
  useFocusEffect(
    useCallback(() => {
      if (!chatPending && !chatRunning) return;
      const timer = setInterval(() => {
        void loadChat();
      }, POLL_MS);
      return () => clearInterval(timer);
    }, [chatPending, chatRunning, loadChat]),
  );

  const report = ai.report;
  // 报告标题（M5）：装配完成前回退到模式名（「复盘」），避免闪一下空标题
  const reportTitleText = useReportTitle(kind === 'report' ? report : null);
  const title =
    kind === 'report'
      ? reportTitleText || (report ? t(`ai.mode.${report.mode}` as never) : t('ai.title'))
      : t('session.chatTitle');

  /** 重试追问/对话消息：以指定消息重跑生成（运行中注册表防双跑，按钮侧已禁用） */
  const reloadReport = ai.reload;
  const retryChat = useCallback(
    (messageId: number) => {
      if (!chat) return;
      void runChatGeneration(chat.id, messageId, lang).catch((e) =>
        console.warn('对话重试失败:', e),
      );
      if (kind === 'report') void reloadReport();
      else void loadChat();
    },
    [chat, lang, kind, reloadReport, loadChat],
  );

  /** 取消生成（2026-10）：报告与消息各接一路；无任务时服务层兜底直接落库取消。
      取消后状态由任务回写（毫秒级），轮询自然把界面带到 cancelled 态，无需手动刷新 */
  const cancelReport = useCallback(() => {
    if (kind !== 'report' || entityId == null) return;
    void cancelReportGeneration(entityId).catch((e) => console.warn('取消报告生成失败:', e));
  }, [kind, entityId]);

  const cancelChatMessage = useCallback(
    (messageId: number) => {
      if (!chat) return;
      void cancelChatGeneration(chat.id, messageId).catch((e) =>
        console.warn('取消消息生成失败:', e),
      );
    },
    [chat],
  );

  /** 重设追问（AP4）：删该报告的追问会话（报告保留），reload 重新查找（null 即恢复
      干净态），下轮提问惰性新建。docker 版「清除追问」语义平移；生成中禁用 */
  const followUpBusy =
    !!chat &&
    (chat.messages.some((m) => m.status === 'pending') ||
      chat.messages.some((m) => isChatGenerating(chat.id, m.id)));
  const resetFollowUp = useCallback(async () => {
    if (kind !== 'report' || !chat) return;
    try {
      await deleteAiChat(chat.id);
      await ai.reload();
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    }
  }, [chat, kind, ai]);

  /** 重新生成报告：新建一份（旧报告留在历史列表里），随后路由切到新报告 */
  const regenerate = useCallback(() => {
    void (async () => {
      try {
        const id = await ai.regenerate();
        router.replace(`/ai/session/report-${id}`);
      } catch (e) {
        Alert.alert(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [ai, router]);

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
  const send = async (text: string) => {
    setSending(true);
    try {
      if (kind === 'report') {
        if (!report) return;
        const err = await ai.sendFollowUp(text);
        if (err) Alert.alert(err);
      } else if (isNewChat) {
        // 新对话：首条消息落库建对话后 replace 到真实 id（返回列表可见）；
        // autoFocus 续传——replace 会重挂载页面，不带参数键盘会收起
        const { chatId, messageId } = await submitChatMessage({ mode: 'chat', message: text }, lang);
        router.replace({
          pathname: '/ai/session/[id]',
          params: { id: `chat-${chatId}`, autoFocus: '1' },
        });
        void runChatGeneration(chatId, messageId, lang).catch((e) =>
          console.warn('对话生成任务异常:', e),
        );
      } else if (entityId != null) {
        const { messageId } = await submitChatMessage(
          { chatId: entityId, mode: 'chat', message: text },
          lang,
        );
        void runChatGeneration(entityId, messageId, lang).catch((e) =>
          console.warn('对话生成任务异常:', e),
        );
        await loadChat();
      }
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.page} behavior="padding">
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={title} titleStyle={styles.headerTitle} />
        {kind === 'report' && (
          <>
            {report?.status === 'completed' && (
              <Appbar.Action icon="refresh" onPress={regenerate} accessibilityLabel={t('ai.regen')} />
            )}
            <Appbar.Action icon="share-variant-outline" onPress={shareReport} />
          </>
        )}
      </Appbar.Header>

      {/* 滚动容器：报告正文（三态）与消息气泡流共用（P0 修复——长报告必须可滚动）。
          直接对话空会话时给引导 hero（AP2），不再白屏 */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {kind === 'chat' && chatMessages.length === 0 && <ChatEmptyHero />}
        {kind === 'report' && (
          <AiReportBody
            report={report}
            progress={ai.progress}
            elapsedSec={ai.elapsedSec}
            generating={ai.generating}
            onRetry={ai.retry}
            onCancel={cancelReport}
          />
        )}

        {/* 消息流（chat 页全程 / report 页的追问线程） */}
        {chatMessages.length > 0 && (
          <View
            style={[
              styles.followUp,
              kind === 'report' && report?.status === 'completed' && styles.followUpTop,
            ]}>
            {kind === 'report' && report?.status === 'completed' && (
              <View style={styles.followUpHead}>
                <Text style={styles.followUpHeadText}>{t('session.followUp.hint')}</Text>
                {chat && (
                  <ResetFollowUpButton
                    scope="followup"
                    disabled={followUpBusy}
                    onReset={resetFollowUp}
                  />
                )}
              </View>
            )}
            <ChatBubbles
              chatId={chat?.id ?? -1}
              messages={chatMessages}
              onRetry={retryChat}
              onCancelMessage={cancelChatMessage}
            />
          </View>
        )}
      </ScrollView>

      {/* 输入行：report 页仅 completed 后开放追问；chat 页常开。
          键盘可见时 KeyboardAvoidingView 已垫起整个页面，再保留 insets.bottom 会双重垫高。
          autoFocus 仅 chat 分支生效（AP1：首页卡片/chat-new 入口进入即聚焦） */}
      {(kind === 'chat' || report?.status === 'completed') && (
        <AskInput
          placeholder={kind === 'report' ? t('session.followUp.hint') : t('session.chat.hint')}
          sending={sending}
          onSend={send}
          autoFocus={kind === 'chat' && wantsFocus}
          initialDraft={kind === 'chat' ? rawDraft : undefined}
          style={[styles.inputRow, { paddingBottom: (kbVisible ? 0 : insets.bottom) + 10 }]}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, borderBottomWidth: 1, borderBottomColor: palette.lineSoft },
  // 标题含骑行日期/规划区间（可达 20+ 字），字号比默认小一档让长标题尽量不截断
  headerTitle: { color: palette.text, fontSize: 14 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingVertical: 12, gap: 8 },
  followUp: { gap: 8 },
  followUpTop: { borderTopWidth: 1, borderTopColor: palette.lineSoft, paddingTop: 10, marginTop: 4 },
  followUpHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  followUpHeadText: { color: palette.faint, fontSize: 11 },
  inputRow: { paddingHorizontal: 12, paddingTop: 6 },
});

// 路由级错误边界（架构评审 T2）：本屏渲染异常在此兜底，不再冒泡到根边界丢失导航位置
export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';
