/**
 * useAiReport — 单份 AI 报告的状态机（会话详情页与训练详情页共用）。
 *
 * 职责：读报告 + 找回该报告的追问对话；发现 pending 残留（应用被杀中断、进程内无
 * 任务在跑）时补跑生成恢复；生成期间 1.5s 轮询本地 db；提供重试 / 重新生成 /
 * 追问提交三个动作。
 *
 * ⚠️ 轮询口径修正（2026-09-22 真机事故）：原实现只要报告状态离开 pending 就停止
 * 轮询，于是「失败 → 点重试 → 重试成功回写 completed」这条路径上界面永远不会刷新，
 * 用户必须退出页面再进来才能看到报告（真机现象：一直显示 JSON 解析失败，退出重进
 * 后报告正常出现）。现在改为：只要本报告还有进程内生成任务在跑就继续轮询。
 */
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  findFollowUpChat,
  getAiChat,
  getAiReport,
  type AiChatRow,
  type AiReportRow,
} from '@/db';
import {
  createReportDraft,
  generateReport,
  getReportProgress,
  isChatGenerating,
  isReportGenerating,
  runChatGeneration,
  submitChatMessage,
  type GenProgress,
} from '@/services/aiGenerate';
import { shouldPollReport } from '@/core/report-status';
import type { Lang } from '@/core/i18n';

const POLL_MS = 1500; // 生成中轮询节奏（对齐旧 Web 版 pollAiChat 间隔）

/** 报告创建时刻起的已等待秒数（created_at 是 UTC 的 datetime('now')，需补 Z 解析） */
function elapsedFrom(createdAt: string | null | undefined, now: number): number | null {
  if (!createdAt) return null;
  const started = Date.parse(createdAt.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(started)) return null;
  return Math.max(0, Math.round((now - started) / 1000));
}

export interface UseAiReportResult {
  report: AiReportRow | null;
  chat: AiChatRow | null;
  followChatId: number | null;
  /** 报告本体在生成中，或本报告有进程内任务在跑（含手动重试 / 重新生成） */
  generating: boolean;
  /** 手动重试 / 重新生成已发起、尚未回写状态 */
  retrying: boolean;
  /** 传输级自动重试进度（进程内，重试中才有值） */
  progress: GenProgress | null;
  /** 已等待秒数（按报告创建时间起算；无报告为 null） */
  elapsedSec: number | null;
  reload: () => Promise<void>;
  /** 重试当前报告（同一占位记录重跑生成） */
  retry: () => void;
  /**
   * 重新生成：以同一场景参数新建一份报告并返回其 id（旧报告留在历史里，
   * 口径同 Web 版「重新生成」）。调用方决定如何切换（路由 replace 或切 id）。
   */
  regenerate: () => Promise<number>;
  sending: boolean;
  /** 追问：返回错误文案（成功为 null），由调用方决定如何提示 */
  sendFollowUp: (text: string) => Promise<string | null>;
  /** 重试追问/对话里的一条失败消息（失败气泡上的重试） */
  retryChatMessage: (chatId: number, messageId: number) => void;
}

export function useAiReport(reportId: number | null, lang: Lang): UseAiReportResult {
  const [report, setReport] = useState<AiReportRow | null>(null);
  const [chat, setChat] = useState<AiChatRow | null>(null);
  const [followChatId, setFollowChatId] = useState<number | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [progress, setProgress] = useState<GenProgress | null>(null);
  const [sending, setSending] = useState(false);
  const [now, setNow] = useState(() => Date.now()); // 轮询心跳：驱动"已等待时长"重算
  // 上一次加载的实体：切换报告时清掉追问线程状态，防跨报告残留
  const lastIdRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (reportId == null) {
      lastIdRef.current = null;
      setReport(null);
      setChat(null);
      setFollowChatId(null);
      setProgress(null);
      return;
    }
    const id = reportId; // 本次加载的目标：await 期间 reportId 可能被切走（重新生成），旧结果不许覆盖
    try {
      if (lastIdRef.current !== id) {
        lastIdRef.current = id;
        setChat(null);
        setFollowChatId(null);
      }
      const r = await getAiReport(id);
      if (lastIdRef.current !== id) return; // 已切到别的报告：丢弃过期响应
      setReport(r);
      setProgress(getReportProgress(id));
      if (r && r.status === 'pending' && !isReportGenerating(r.id)) {
        // pending 残留（进程被杀中断）：提示词与系统段均已落库，重跑即可恢复
        void generateReport(r.id, lang).catch((e) => console.warn('报告恢复生成失败:', e));
      }
      const fid = await findFollowUpChat(id);
      if (lastIdRef.current !== id) return;
      setFollowChatId(fid);
      const c = fid ? await getAiChat(fid) : null;
      if (lastIdRef.current !== id) return;
      setChat(c);
      // 追问消息的 pending 残留同样要补跑（否则气泡永远"生成中"、轮询也停不下来）
      if (c) {
        for (const m of c.messages) {
          if (m.status === 'pending' && !isChatGenerating(c.id, m.id)) {
            void runChatGeneration(c.id, m.id, lang).catch((e) =>
              console.warn('追问恢复生成失败:', e),
            );
          }
        }
      }
    } catch (e) {
      console.warn('报告加载失败:', e);
    }
  }, [reportId, lang]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // 生成中轮询：判定抽到 core/report-status（纯函数 + 单测守住 2026-09-22 的回归）。
  // chatRunning：追问里"失败气泡点了重试"时库状态仍是 failed，只有进程内任务在跑——
  // 不把它算进来，重试成功的气泡就永远停在失败态（与报告页同一个坑）。
  const chatPending = !!chat?.messages.some((m) => m.status === 'pending');
  const chatRunning = !!chat && chat.messages.some((m) => isChatGenerating(chat.id, m.id));
  const taskRunning = reportId != null && isReportGenerating(reportId);
  const polling = shouldPollReport({
    status: report?.status,
    retrying,
    taskRunning,
    chatPending,
    chatRunning,
  });

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const retry = useCallback(() => {
    if (reportId == null) return;
    setRetrying(true);
    // 生成任务回写状态后 load 会读到新状态；retrying 交给下面的生成态归零
    void generateReport(reportId, lang)
      .catch((e) => console.warn('报告重试失败:', e))
      .finally(() => {
        setRetrying(false);
        void load();
      });
    void load();
  }, [reportId, lang, load]);

  const regenerate = useCallback(async (): Promise<number> => {
    if (!report) throw new Error('report not loaded');
    const id = await createReportDraft(
      report.mode,
      { file_name: report.file_name, race_date: report.race_date, compare_with: report.compare_with },
      lang,
    );
    return id;
  }, [report, lang]);

  const reportFileName = report?.file_name ?? null;

  /**
   * 重试追问/对话里的一条失败消息（失败气泡上的重试）。
   * ⚠️ 必须紧跟一次 load()：此刻库状态仍是 failed、只有进程内有任务在跑，不重渲染的话
   * shouldPollReport 拿不到 chatRunning，轮询不会启动 → 重试成功了气泡也永远停在失败态
   * （2026-09-22 那个坑的第三处：报告 / 对话框 / 追问气泡）。
   */
  const retryChatMessage = useCallback(
    (chatId: number, messageId: number) => {
      void runChatGeneration(chatId, messageId, lang).catch((e) =>
        console.warn('追问重试失败:', e),
      );
      void load();
    },
    [lang, load],
  );

  const sendFollowUp = useCallback(
    async (text: string): Promise<string | null> => {
      if (reportId == null) return null;
      setSending(true);
      try {
        const { chatId, messageId } = await submitChatMessage(
          {
            chatId: followChatId,
            mode: 'follow_up',
            message: text,
            reportId,
            fileName: reportFileName,
          },
          lang,
        );
        setFollowChatId(chatId);
        void runChatGeneration(chatId, messageId, lang).catch((e) =>
          console.warn('追问生成任务异常:', e),
        );
        await load();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      } finally {
        setSending(false);
      }
    },
    [reportId, followChatId, reportFileName, lang, load],
  );

  const elapsedSec = useMemo(() => elapsedFrom(report?.created_at, now), [report?.created_at, now]);

  return {
    report,
    chat,
    followChatId,
    generating: report?.status === 'pending' || retrying || taskRunning,
    retrying,
    progress,
    elapsedSec,
    reload: load,
    retry,
    regenerate,
    sending,
    sendFollowUp,
    retryChatMessage,
  };
}
