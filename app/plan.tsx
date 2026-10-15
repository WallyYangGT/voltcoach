/**
 * plan.tsx — 训练计划页（v2 训练计划载体）：有效期横幅 + 周计划/长期计划/历史版本
 * 三视图（PlanTable 表格）+ 底部计划会话窗口（mode='plan'，围绕计划追问与调整，
 * 调整经 update_training_plan 过确定性校验落新版本）。
 *
 * 数据口径：计划与历史读 db（settings 行）；「今天」与周锚点走 localDay 本地日历日；
 * 推演旗标复用 projectPlanForm（起始 CTL/ATL 取 recentFormDaily 末端）。会话窗口的
 * 轮询/残留补跑/逐条重试与会话详情页（ai/session/[id]）同款：1.5s 轮询 pending、
 * 进页补跑不在进程内跑的占位消息，轮询收尾静默重载计划（调整可能已落新版本）。
 * 未配置 LLM Key 显示去配置引导（本页正常只从首页计划卡进入，防御可达路径）。
 */
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Button, SegmentedButtons } from 'react-native-paper';
import { KeyboardAvoidingView, useKeyboardState } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deleteAiChat,
  findPlanChat,
  getAiChat,
  getAiConfig,
  getAiReport,
  getCurrentPlan,
  getPlanHistory,
  recentFormDaily,
  type AiChatMessageRow,
  type AiReportRow,
  type StoredPlan,
} from '@/db';
import { cancelChatGeneration, isChatGenerating, runChatGeneration, submitChatMessage, createReportDraft, generateReport } from '@/services/aiGenerate';
import { localDay, localDayFromUtc } from '@/core/local-day';
import { formatDuration } from '@/core/metrics';
import type { SimRiskFlag } from '@/planning/planning';
import {
  addDays,
  aggregatePlanWeeks,
  formatPlanIssue,
  planValidity,
  projectPlanForm,
  QUALITY_TYPES,
  weekStartOf,
  type PlanSession,
  type TrainingPlan,
} from '@/core/training-plan';
import { PlanTable, type PlanTableColumn } from '@/components/PlanTable';
import { PlanAdherenceCard } from '@/components/PlanAdherenceCard';
import { PlanAdjustBanner } from '@/components/PlanAdjustBanner';
import { PlanReportSection } from '@/components/PlanReportSection';
import { ResetFollowUpButton } from '@/components/ResetFollowUpButton';
import { AskInput } from '@/components/AskInput';
import { ChatBubbles } from '@/components/ChatBubbles';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

const POLL_MS = 1500;
/** 质量课集合（课型标签染 volt 色）——单一事实源在 core/training-plan 的 QUALITY_TYPES */
const QUALITY = new Set(QUALITY_TYPES);

/** 周锚点夹进计划窗（今天在窗前→首周；窗后→末周） */
function clampWeekToPlan(monday: string, plan: TrainingPlan): string {
  const fromW = weekStartOf(plan.valid_from);
  const toW = weekStartOf(plan.valid_to);
  if (monday < fromW) return fromW;
  if (monday > toW) return toW;
  return monday;
}

export default function PlanScreen() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const kbVisible = useKeyboardState((s) => s.isVisible);
  const scrollRef = useRef<ScrollView>(null);
  // 深链 version 参数（U1③：报告 chip「关联计划 · 第 N 版」→ 定位历史版本）
  const params = useLocalSearchParams<{ version?: string | string[] }>();
  const rawVersion = Array.isArray(params.version) ? params.version[0] : params.version;
  const pendingVersionRef = useRef<number | null>(
    rawVersion != null && /^\d+$/.test(rawVersion) ? Number(rawVersion) : null,
  );

  const [cfg, setCfg] = useState<boolean | null>(null);
  const [stored, setStored] = useState<StoredPlan | null>(null);
  const [history, setHistory] = useState<StoredPlan[]>([]);
  // 历史版本查看锚（StoredPlan.created_at，位置无关）；null=当前版。
  // 用锚不用下标：新版本落库会把旧当前版挪进历史头部、历史整体后移一位，
  // 下标会让「正在读的版本」静默换成另一版（code-review P2-3）
  const [viewingAt, setViewingAt] = useState<string | null>(null);
  const viewingIdx = viewingAt != null ? history.findIndex((h) => h.created_at === viewingAt) : -1;
  const [tab, setTab] = useState<'week' | 'long' | 'history'>('week');
  const [week, setWeek] = useState<string | null>(null); // 周视图锚点（ISO 周一）；null=默认夹今天
  const [risk, setRisk] = useState<SimRiskFlag[]>([]);
  const [generating, setGenerating] = useState(false);

  // 计划会话（mode='plan'）
  const [chatId, setChatId] = useState<number | null>(null);
  const [messages, setMessages] = useState<AiChatMessageRow[]>([]);
  const [sending, setSending] = useState(false);
  // 规划解读（AP3）：当前查看版本的来源报告只读快照，null = 无来源/未生成/被滚动清出
  const [planReport, setPlanReport] = useState<AiReportRow | null>(null);

  const load = useCallback(async () => {
    try {
      const [cfgRes, plan, hist, cid] = await Promise.all([
        getAiConfig(),
        getCurrentPlan(),
        getPlanHistory(),
        findPlanChat(),
      ]);
      setCfg(cfgRes.configured);
      setStored(plan);
      setHistory(hist);
      if (cid != null) {
        const c = await getAiChat(cid);
        setChatId(c?.id ?? null);
        setMessages(c?.messages ?? []);
      } else {
        setChatId(null);
        setMessages([]);
      }
      // 推演风险旗标（展示用不阻断）：起始 CTL/ATL 取负荷序列末端；空库跳过
      if (plan) {
        const daily = await recentFormDaily(1);
        const last = daily[daily.length - 1];
        setRisk(last ? projectPlanForm(plan.plan, last.ctl, last.atl, lang).risk_flags : []);
      } else {
        setRisk([]);
      }
    } catch (e) {
      console.warn('训练计划页加载失败:', e);
    }
  }, [lang]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // 深链版本定位（U1③）：历史加载后把 version 序号换算为 history 下标消费一次，
  // 越界/已被 history_keep 裁剪 → 静默停在当前版；历史条目点击同款（setViewing + 长期视图）
  useEffect(() => {
    if (cfg == null || pendingVersionRef.current == null) return; // 未加载完不消费
    const n = pendingVersionRef.current;
    pendingVersionRef.current = null;
    const idx = history.length - n;
    if (idx >= 0 && idx < history.length) {
      setViewingAt(history[idx].created_at);
      setTab('long');
    }
    // n === history.length + 1（指向当前版的 chip）落在 idx = -1 分支被静默忽略——
    // 内容正确（本就在当前版），无「已定位」反馈属可接受取舍
  }, [cfg, history]);

  // 会话：残留补跑 + pending 轮询（口径同 ai/session/[id]），收尾静默重载计划
  useEffect(() => {
    if (chatId == null) return;
    for (const m of messages) {
      if (m.role === 'assistant' && m.status === 'pending' && !isChatGenerating(chatId, m.id)) {
        void runChatGeneration(chatId, m.id, lang).catch((e) =>
          console.warn('计划会话残留补跑失败:', e),
        );
      }
    }
    if (!messages.some((m) => m.status === 'pending')) return;
    const timer = setInterval(async () => {
      if (chatId == null) return;
      try {
        const c = await getAiChat(chatId);
        if (!c) return;
        setMessages(c.messages);
        if (!c.messages.some((m) => m.status === 'pending')) {
          clearInterval(timer);
          void load().catch((e) => console.warn('计划页轮询收尾重载失败:', e)); // 调整可能已落新版本
        }
      } catch {
        // 轮询失败下轮再试
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [messages, chatId, lang, load]);

  // 规划解读（AP3）：跟随当前查看版本（当前版/历史版各自的 source_report_id）拉取
  // 只读快照；无来源（adjust 版）、未生成或被 trimAiReports 清出时为 null 整段隐藏。
  // setState 全部在异步回调里（react-hooks/set-state-in-effect 禁同步触发级联渲染）
  useEffect(() => {
    const sid = (viewingAt != null ? (history[viewingIdx] ?? null) : stored)?.source_report_id ?? null;
    let alive = true;
    void (async () => {
      const r = sid == null ? null : await getAiReport(sid).catch((e) => {
        console.warn('规划解读加载失败:', e);
        return null;
      });
      if (alive) setPlanReport(r);
    })();
    return () => {
      alive = false;
    };
  }, [stored, history, viewingAt, viewingIdx]);

  // 键盘弹起滚到底（口径同会话详情页，延时等 KeyboardAvoidingView 落位）。
  // AP3 起进页不再自动滚——此前 messages.length 驱动的 scrollToEnd 会把进页视口
  // 甩到底部会话区，横跨数周的计划表反而看不到；现在只有键盘浮起与主动发送才滚
  useEffect(() => {
    if (!kbVisible) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 260);
    return () => clearTimeout(timer);
  }, [kbVisible]);

  const send = useCallback(
    async (text: string) => {
      if (sending) return;
      setSending(true);
      try {
        const { chatId: cid, messageId } = await submitChatMessage(
          { chatId, mode: 'plan', message: text },
          lang,
        );
        setChatId(cid);
        const c = await getAiChat(cid);
        if (c) setMessages(c.messages);
        // AP3：仅用户主动发送后滚动到会话区（进页不再自动滚）
        requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
        void runChatGeneration(cid, messageId, lang).catch((e) =>
          console.warn('计划会话生成失败:', e),
        );
      } catch (e) {
        Alert.alert(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    },
    [chatId, lang, sending],
  );

  const retry = useCallback(
    (messageId: number) => {
      if (chatId == null) return;
      void runChatGeneration(chatId, messageId, lang).catch((e) =>
        console.warn('计划会话重试失败:', e),
      );
    },
    [chatId, lang],
  );

  // 取消消息生成（2026-10）：直接停止不弹框（口径同会话页气泡）；状态由任务回写，
  // 页面既有的 pending 轮询会自然把气泡带到 cancelled 态
  const cancelMessage = useCallback(
    (messageId: number) => {
      if (chatId == null) return;
      void cancelChatGeneration(chatId, messageId).catch((e) =>
        console.warn('计划会话取消失败:', e),
      );
    },
    [chatId],
  );

  // 重设追问（AP4）：计划会话是全局单线程，多周追问历史每轮全量进 prompt——
  // 重设即开新话题（token 止血）。删会话后置空本地态，下次发送走 chatId=null
  // 的惰性新建路径。生成中禁用（防删掉在飞会话）
  const chatBusy =
    messages.some((m) => m.status === 'pending') ||
    (chatId != null && messages.some((m) => isChatGenerating(chatId, m.id)));
  const resetPlanChat = useCallback(async () => {
    if (chatId == null) return;
    try {
      await deleteAiChat(chatId);
      setChatId(null);
      setMessages([]);
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    }
  }, [chatId]);

  const onGenerate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    try {
      // 首页计划卡同款：draft → 跳报告页（三态/保活/轮询都在那边）→ fire 生成
      const id = await createReportDraft('plan', {}, lang);
      router.push(`/ai/session/report-${id}`);
      void generateReport(id, lang).catch((e) => console.warn('计划生成失败:', e));
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }, [generating, lang, router]);

  // ---------------- 渲染 ----------------

  if (cfg === false) {
    return (
      <View style={[styles.page, styles.center, { paddingTop: insets.top }]}>
        <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
          <Appbar.BackAction onPress={() => router.back()} />
          <Appbar.Content title={t('plan.title')} />
        </Appbar.Header>
        <View style={styles.centerBody}>
          <Text style={styles.emptyText}>{t('ai.center.unconfigured')}</Text>
          <Button mode="outlined" textColor={palette.volt} onPress={() => router.push('/me')}>
            {t('ai.center.toSettings')}
          </Button>
        </View>
      </View>
    );
  }

  const shown = viewingAt != null ? (history[viewingIdx] ?? null) : stored;
  const plan = shown?.plan ?? null;
  const versionNo = shown ? (viewingIdx >= 0 ? history.length - viewingIdx : history.length + 1) : 0;
  const validity = plan ? planValidity(plan, localDay()) : null;
  const today = localDay();

  // 周视图数据
  const anchor = plan ? (week ?? clampWeekToPlan(weekStartOf(today), plan)) : weekStartOf(today);
  const weekRows: { date: string; s: PlanSession | undefined }[] = Array.from({ length: 7 }, (_, k) => {
    const date = addDays(anchor, k);
    return { date, s: plan?.sessions.find((x) => x.date === date) };
  });
  const minWeek = plan ? weekStartOf(plan.valid_from) : anchor;
  const maxWeek = plan ? weekStartOf(plan.valid_to) : anchor;

  const weekColumns: PlanTableColumn[] = [
    { key: 'day', label: t('plan.col.day'), flex: 1.5 },
    { key: 'type', label: t('plan.col.type'), flex: 1 },
    { key: 'dur', label: t('plan.col.dur'), flex: 0.9 },
    { key: 'intensity', label: t('plan.col.intensity'), flex: 1.3 },
    { key: 'tss', label: t('plan.col.tss'), flex: 0.7, align: 'right' },
    { key: 'note', label: t('plan.col.note'), flex: 2 },
  ];
  const weekTableCells = weekRows.map(({ date, s }) => {
    const dow = t(`plan.dow.${(new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7 + 1}` as never);
    const dim = !s;
    const cell = (text: string, extra?: object) => (
      <Text style={[styles.cell, dim && styles.cellDim, extra]}>{text}</Text>
    );
    return [
      cell(`${dow} ${date.slice(5)}`, date === today ? styles.cellToday : undefined),
      s ? (
        <Text
          key="type"
          style={[
            styles.cell,
            dim && styles.cellDim,
            QUALITY.has(s.type) && { color: palette.volt },
            s.type === 'rest' && styles.cellDim,
          ]}>
          {t(`plan.type.${s.type}` as never)}
        </Text>
      ) : (
        cell('—')
      ),
      cell(s?.duration_min != null ? formatDuration(s.duration_min * 60) : '—'),
      cell(s?.intensity ?? '—'),
      cell(s?.tss != null ? String(Math.round(s.tss)) : '—'),
      cell(s?.note ?? ''),
    ];
  });
  const weekHasSession = weekRows.some((r) => r.s);

  // 长期视图数据
  const weeksAgg = plan ? aggregatePlanWeeks(plan.sessions) : [];
  const tssTotal = Math.round(weeksAgg.reduce((acc, w) => acc + w.tss, 0));
  const longColumns: PlanTableColumn[] = [
    { key: 'week', label: t('plan.col.week'), flex: 1.4 },
    { key: 'sessions', label: t('plan.col.sessions'), flex: 0.8, align: 'right' },
    { key: 'quality', label: t('plan.col.quality'), flex: 0.9, align: 'right' },
    { key: 'wtss', label: t('plan.col.wtss'), flex: 1, align: 'right' },
    { key: 'tag', label: t('plan.col.tag'), flex: 1 },
  ];
  const longTableCells = weeksAgg.map((w) => [
    `${w.week_start.slice(5)} ~ ${w.week_end.slice(5)}`,
    String(w.sessions),
    String(w.quality),
    String(Math.round(w.tss)),
    w.recovery ? (
      <Text key="tag" style={[styles.cell, { color: palette.blue }]}>
        {t('plan.tag.recovery')}
      </Text>
    ) : (
      t('plan.tag.none')
    ),
  ]);

  return (
    <KeyboardAvoidingView style={styles.page} behavior="padding">
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={t('plan.title')} />
      </Appbar.Header>

      <ScrollView
        ref={scrollRef}
        style={styles.body}
        contentContainerStyle={{ paddingBottom: 24, gap: 12, paddingHorizontal: 16 }}>
        {/* 有效期横幅 / 空态 */}
        {plan && validity ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>
              {validity.state === 'expired'
                ? t('plan.banner.expired', {
                    from: plan.valid_from,
                    to: plan.valid_to,
                    n: validity.days_left,
                  })
                : validity.state === 'upcoming'
                  ? t('plan.banner.upcoming', {
                      from: plan.valid_from,
                      to: plan.valid_to,
                      n: validity.days_left,
                    })
                  : t('plan.banner.valid', {
                      from: plan.valid_from,
                      to: plan.valid_to,
                      n: validity.days_left,
                    })}
              {' · '}
              {t('plan.version', { n: versionNo })}
            </Text>
            <View style={styles.bannerActions}>
              {shown?.source_report_id != null && (
                <Pressable
                  hitSlop={6}
                  onPress={() => router.push(`/ai/session/report-${shown.source_report_id}`)}>
                  <Text style={styles.link}>{t('plan.view_report')}</Text>
                </Pressable>
              )}
              {viewingAt == null && (
                <Pressable hitSlop={6} disabled={generating} onPress={onGenerate}>
                  <Text style={[styles.link, generating && { opacity: 0.5 }]}>{t('plan.generate')}</Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{t('plan.empty')}</Text>
            <Pressable hitSlop={6} disabled={generating} onPress={onGenerate}>
              <Text style={[styles.link, generating && { opacity: 0.5 }]}>{t('plan.generate')}</Text>
            </Pressable>
          </View>
        )}

        {/* AI 调整披露条（U1 收尾④）：props 驱动——页面轮询收尾 load() 刷新 stored/
            history，本页内完成的调整立即反映（§22 P1-3「banner 不可达」同款教训） */}
        <PlanAdjustBanner
          stored={stored}
          history={history}
          onChanged={load}
        />

        {/* 历史版本查看条 */}
        {viewingAt != null && shown && (
          <View style={[styles.banner, styles.viewingBar]}>
            <Text style={styles.bannerText}>
              {t('plan.history.viewing', {
                // created_at 是 SQLite UTC 时刻文本 → 本地日历日（双口径统一）
                date: localDayFromUtc(shown.created_at) ?? shown.created_at.slice(0, 10),
              })}
            </Text>
            <Pressable hitSlop={6} onPress={() => setViewingAt(null)}>
              <Text style={styles.link}>{t('plan.history.back')}</Text>
            </Pressable>
          </View>
        )}

        <SegmentedButtons
          value={tab}
          onValueChange={(v) => setTab(v as 'week' | 'long' | 'history')}
          buttons={[
            { value: 'week', label: t('plan.tab.week') },
            { value: 'long', label: t('plan.tab.long') },
            { value: 'history', label: t('plan.tab.history') },
          ]}
        />

        {tab === 'week' && plan && (
          <View style={styles.panel}>
            <View style={styles.weekNav}>
              <Pressable
                hitSlop={8}
                disabled={anchor <= minWeek}
                onPress={() => setWeek(addDays(anchor, -7))}>
                <Text style={[styles.navArrow, anchor <= minWeek && { opacity: 0.3 }]}>{'‹'}</Text>
              </Pressable>
              <Text style={styles.weekLabel}>
                {anchor.slice(5)} ~ {addDays(anchor, 6).slice(5)}
              </Text>
              <Pressable
                hitSlop={8}
                disabled={anchor >= maxWeek}
                onPress={() => setWeek(addDays(anchor, 7))}>
                <Text style={[styles.navArrow, anchor >= maxWeek && { opacity: 0.3 }]}>{'›'}</Text>
              </Pressable>
            </View>
            {weekHasSession ? (
              <PlanTable
                columns={weekColumns}
                rows={weekTableCells}
                highlightIndex={weekRows.findIndex((r) => r.date === today)}
              />
            ) : (
              <Text style={styles.emptyText}>{t('plan.week.empty')}</Text>
            )}
          </View>
        )}

        {/* 本周执行情况（U1 收尾②：计划 vs 实际三态对比；随周锚点切换，与周表同锚） */}
        {tab === 'week' && plan && <PlanAdherenceCard plan={plan} weekStart={anchor} today={today} />}

        {tab === 'long' && plan && (
          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>
              {t('plan.long.goal')}：{plan.goal || '—'}
            </Text>
            <PlanTable columns={longColumns} rows={longTableCells} />
            <Text style={styles.tssTotal}>{t('plan.long.tss_head', { n: tssTotal })}</Text>
            {shown?.warnings?.length ? (
              <View style={styles.notes}>
                <Text style={styles.notesHead}>{t('plan.warn.head')}</Text>
                {shown.warnings.map((w, i) => (
                  <Text key={i} style={styles.noteWarn}>
                    · {formatPlanIssue(w, lang)}
                  </Text>
                ))}
              </View>
            ) : null}
            {risk.length ? (
              <View style={styles.notes}>
                <Text style={styles.notesHead}>{t('plan.risk.head')}</Text>
                {risk.slice(0, 3).map((f, i) => (
                  <Text key={i} style={styles.noteWarn}>
                    · {f.message}
                  </Text>
                ))}
                {risk.length > 3 && (
                  <Text style={styles.noteWarn}>· {t('plan.risk.more', { n: risk.length - 3 })}</Text>
                )}
              </View>
            ) : null}
          </View>
        )}

        {tab === 'history' && (
          <View style={styles.panel}>
            {history.length === 0 ? (
              <Text style={styles.emptyText}>{t('plan.history.empty')}</Text>
            ) : (
              history.map((h, i) => (
                <Pressable
                  key={i}
                  style={styles.historyRow}
                  onPress={() => {
                    setViewingAt(h.created_at);
                    setTab('long');
                  }}>
                  <View style={styles.historyTop}>
                    <Text style={styles.historyVer}>
                      {t('plan.version', { n: history.length - i })}
                    </Text>
                    <Text style={styles.historyOrigin}>
                      {t(`plan.history.origin.${h.origin}` as never)}
                    </Text>
                    <Text style={styles.historyDate}>{localDayFromUtc(h.created_at) ?? h.created_at.slice(0, 10)}</Text>
                  </View>
                  <Text style={styles.historyNote} numberOfLines={2}>
                    {h.change_note ?? h.plan.goal}
                  </Text>
                  <Text style={styles.historyRange}>
                    {h.plan.valid_from} ~ {h.plan.valid_to}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        )}

        {/* 规划解读（AP3）：当前查看版本的来源报告只读挂底，不自动滚动；
            报告页仍是唯一真源（三态/分享/重新生成/追问都在那边） */}
        <PlanReportSection
          report={planReport}
          onViewReport={() => {
            const sid = (viewingAt != null ? (history[viewingIdx] ?? null) : stored)?.source_report_id;
            if (sid != null) router.push(`/ai/session/report-${sid}`);
          }}
        />

        {/* 计划会话 */}
        <View style={styles.chatSection}>
          <View style={styles.chatHead}>
            <Text style={styles.sectionTitle}>{t('plan.chat.head')}</Text>
            {chatId != null && (
              <ResetFollowUpButton scope="plan" disabled={chatBusy} onReset={resetPlanChat} />
            )}
          </View>
          {chatId != null && (
            <ChatBubbles
              chatId={chatId}
              messages={messages}
              onRetry={retry}
              onCancelMessage={cancelMessage}
            />
          )}
        </View>
      </ScrollView>

      <AskInput
        placeholder={t('plan.chat.hint')}
        sending={sending}
        onSend={send}
        style={[styles.inputRow, { paddingBottom: (kbVisible ? 0 : insets.bottom) + 10 }]}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, elevation: 0 },
  center: { justifyContent: 'center' },
  centerBody: { paddingHorizontal: 24, gap: 16 },
  body: { flex: 1 },
  banner: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  viewingBar: { borderColor: palette.voltDim },
  bannerText: { color: palette.text, fontSize: 12, fontVariant: ['tabular-nums'], flexShrink: 1 },
  bannerActions: { flexDirection: 'row', gap: 14 },
  link: { color: palette.volt, fontSize: 12, fontWeight: '600' },
  panel: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  sectionTitle: { color: palette.text, fontSize: 13, fontWeight: '700' },
  weekNav: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navArrow: { color: palette.text, fontSize: 22, paddingHorizontal: 12 },
  weekLabel: { color: palette.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  cell: { color: palette.text, fontSize: 12, lineHeight: 18, fontVariant: ['tabular-nums'] },
  cellDim: { color: palette.muted },
  cellToday: { color: palette.volt, fontWeight: '700' },
  tssTotal: { color: palette.muted, fontSize: 12, fontVariant: ['tabular-nums'], alignSelf: 'flex-end' },
  notes: { gap: 4 },
  notesHead: { color: palette.muted, fontSize: 11, fontWeight: '700' },
  noteWarn: { color: palette.orange, fontSize: 12, lineHeight: 18 },
  historyRow: { gap: 4, borderTopWidth: 1, borderTopColor: palette.lineSoft, paddingTop: 10 },
  historyTop: { flexDirection: 'row', gap: 10, alignItems: 'baseline' },
  historyVer: { color: palette.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  historyOrigin: { color: palette.volt, fontSize: 11 },
  historyDate: { color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  historyNote: { color: palette.text, fontSize: 12 },
  historyRange: { color: palette.muted, fontSize: 11, fontVariant: ['tabular-nums'] },
  chatSection: { gap: 8, paddingHorizontal: 0 },
  chatHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  emptyText: { color: palette.muted, textAlign: 'center', lineHeight: 24, paddingVertical: 8 },
  inputRow: {
    paddingHorizontal: 16,
    backgroundColor: palette.bg,
    borderTopWidth: 1,
    borderTopColor: palette.lineSoft,
  },
});

// 路由级错误边界（架构评审 T2）：本屏渲染异常在此兜底，不再冒泡到根边界丢失导航位置
export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';
