/**
 * AI 会话中心（M3，§4.2）：顶部「新对话 / 生成报告」双主操作 + 统一历史列表
 * （报告与直接对话混排时间倒序、follow_up 不单独成卡——入口在报告详情页内，
 * 类型过滤 chips）。「生成报告」走底部弹层的四场景选择流：复盘（选训练）/
 * 周期规划（无参）/ 赛前减量（比赛日期）/ 两次对比（双训练）。
 *
 * 移植自 Web 版 views/ai.js（四场景卡片表单）+ views/chat.js（对话列表），
 * 按 §4.2 拍板改为统一会话中心。场景弹层用 Paper Modal 底部面板（M2 glossary
 * 先例；计划中 @gorhom/bottom-sheet 的降级方案，规避 reanimated 4 兼容风险）。
 * 生成流程：createReportDraft（prompt 落库 pending）→ 跳详情页 → fire
 * generateReport 后台任务；未配置 AI 时提供「复制提示词」兜底（§1.2）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import dayjs from 'dayjs';
import React, { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import * as Clipboard from 'expo-clipboard';
import { Button, Chip, Icon, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getAiConfig, listActivities, listAiChats, listAiReports, deleteAiChat, type AiChatListItem, type AiReportListItem, type AiReportMode } from '@/db';
import { buildReportPrompt, createReportDraft, generateReport } from '@/services/aiGenerate';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 统一列表条目（报告 / 对话混排） */
type CenterEntry =
  | { kind: 'report'; id: number; mode: AiReportMode; status: string; title: string; time: string; sortMs: number }
  | { kind: 'chat'; id: number; title: string; hasPending: boolean; time: string; sortMs: number };

type Scenario = AiReportMode | null;
const SCENARIOS: Exclude<Scenario, null>[] = ['review', 'plan', 'taper', 'compare'];
const FILTERS = ['all', 'review', 'plan', 'taper', 'compare', 'chat'] as const;
type Filter = (typeof FILTERS)[number];

export default function AiCenterScreen() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [entries, setEntries] = useState<CenterEntry[] | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [copied, setCopied] = useState(false);

  // 场景选择弹层状态
  const [sheetOpen, setSheetOpen] = useState(false);
  const [scenario, setScenario] = useState<Scenario>(null);
  const [acts, setActs] = useState<Awaited<ReturnType<typeof listActivities>>>([]);
  const [pickA, setPickA] = useState<string | null>(null);
  const [pickB, setPickB] = useState<string | null>(null);
  const [raceDate, setRaceDate] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const [reports, chats, cfg] = await Promise.all([
        listAiReports('all', 30),
        listAiChats('chat'),
        getAiConfig(),
      ]);
      setConfigured(cfg.configured);
      setEntries(mergeEntries(reports, chats));
    } catch (e) {
      console.warn('会话中心加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  /** 场景弹层：打开时拉取活动清单（选择器数据源）并重置选择 */
  const openSheet = useCallback(async () => {
    setSheetOpen(true);
    setScenario(null);
    setPickA(null);
    setPickB(null);
    setRaceDate('');
    try {
      setActs(await listActivities(50));
    } catch {
      setActs([]);
    }
  }, []);

  /** 场景参数是否齐备（review/taper/compare 需要场景参数，plan 无参） */
  const paramReady = (s: Scenario): boolean => {
    if (s === 'review') return !!pickA;
    if (s === 'taper') return /^\d{4}-\d{2}-\d{2}$/.test(raceDate);
    if (s === 'compare') return !!pickA && !!pickB;
    return s === 'plan';
  };

  const scenarioContext = (s: Scenario) => ({
    file_name: pickA,
    race_date: s === 'taper' ? raceDate : null,
    compare_with: s === 'compare' ? pickB : null,
  });

  const generate = async () => {
    if (!scenario || !paramReady(scenario)) {
      Alert.alert(t('ai.scenario.needParam'));
      return;
    }
    setCreating(true);
    try {
      const id = await createReportDraft(scenario, scenarioContext(scenario), lang);
      setSheetOpen(false);
      router.push(`/ai/session/report-${id}`);
      // 后台生成：详情页轮询 db 状态展示进度
      void generateReport(id, lang);
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  /** 复制提示词兜底（未配置密钥时的降级路径，§1.2） */
  const copyPrompt = async () => {
    if (!scenario || !paramReady(scenario)) {
      Alert.alert(t('ai.scenario.needParam'));
      return;
    }
    try {
      const prompt = await buildReportPrompt(scenario, scenarioContext(scenario), lang);
      await Clipboard.setStringAsync(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      Alert.alert(t('ai.center.copyFailed', { msg: e instanceof Error ? e.message : String(e) }));
    }
  };

  const deleteChat = (chat: Extract<CenterEntry, { kind: 'chat' }>) => {
    Alert.alert(t('ai.center.deleteChat'), t('ai.center.deleteChatMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('mem.delete'),
        style: 'destructive',
        onPress: async () => {
          await deleteAiChat(chat.id);
          load();
        },
      },
    ]);
  };

  const filtered = (entries ?? []).filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'chat') return e.kind === 'chat';
    return e.kind === 'report' && e.mode === filter;
  });

  return (
    <View style={styles.page}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 96, gap: 12 }}>
        <Text style={styles.title}>{t('ai.title')}</Text>

        {/* 顶部双主操作（§4.2） */}
        <View style={styles.actions}>
          <Button
            mode="contained"
            buttonColor={palette.volt}
            textColor={palette.bg}
            icon="plus"
            onPress={() => router.push('/ai/session/chat-new')}
            style={{ flex: 1 }}>
            {t('ai.center.new')}
          </Button>
          <Button
            mode="outlined"
            textColor={palette.volt}
            icon="file-document-outline"
            onPress={openSheet}
            style={{ flex: 1, borderColor: palette.volt }}>
            {t('ai.center.report')}
          </Button>
        </View>

        {/* 未配置引导 + 复制提示词兜底入口 */}
        {configured === false && (
          <View style={[styles.callout, { borderColor: palette.voltDim }]}>
            <Text style={styles.calloutText}>{t('ai.center.unconfigured')}</Text>
            <Button compact mode="text" textColor={palette.volt} onPress={() => router.push('/me')}>
              {t('ai.center.toSettings')}
            </Button>
          </View>
        )}

        {/* 类型过滤 chips */}
        <View style={styles.filterRow}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {FILTERS.map((f) => (
              <Chip
                key={f}
                selected={filter === f}
                onPress={() => setFilter(f)}
                style={filter === f ? styles.chipOn : styles.chip}
                textStyle={{ fontSize: 12 }}>
                {t(`ai.filter.${f}` as never)}
              </Chip>
            ))}
          </ScrollView>
        </View>

        {/* 统一历史列表（报告 + 对话混排） */}
        {filtered.length === 0 && entries != null && (
          <Text style={styles.empty}>{t('ai.center.empty')}</Text>
        )}
        {filtered.map((entry) =>
          entry.kind === 'report' ? (
            <Pressable
              key={`r${entry.id}`}
              style={styles.card}
              onPress={() => router.push(`/ai/session/report-${entry.id}`)}>
              <View style={styles.cardHead}>
                <View style={[styles.badge, { borderColor: palette.volt }]}>
                  <Text style={[styles.badgeText, { color: palette.volt }]}>{t(`ai.mode.${entry.mode}` as never)}</Text>
                </View>
                {entry.status === 'pending' && <Text style={styles.pending}>{t('ai.badge.pending')}</Text>}
                {entry.status === 'failed' && <Text style={styles.failed}>{t('ai.badge.failed')}</Text>}
                <Text style={styles.time}>{entry.time}</Text>
              </View>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {entry.title}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              key={`c${entry.id}`}
              style={styles.card}
              onPress={() => router.push(`/ai/session/chat-${entry.id}`)}>
              <View style={styles.cardHead}>
                <View style={[styles.badge, { borderColor: palette.cyan }]}>
                  <Text style={[styles.badgeText, { color: palette.cyan }]}>{t('ai.mode.chat')}</Text>
                </View>
                {entry.hasPending && <Text style={styles.pending}>{t('ai.badge.pending')}</Text>}
                <Text style={styles.time}>{entry.time}</Text>
                <Pressable hitSlop={8} onPress={() => deleteChat(entry)}>
                  <Icon source="delete-outline" size={16} color={palette.faint} />
                </Pressable>
              </View>
              <Text style={styles.cardTitle} numberOfLines={1}>
                {entry.title || t('session.chatTitle')}
              </Text>
            </Pressable>
          ),
        )}
      </ScrollView>

      {/* 生成报告：四场景选择流（Paper Modal 底部面板） */}
      <Modal visible={sheetOpen} transparent animationType="slide" onRequestClose={() => setSheetOpen(false)}>
        <Pressable style={styles.sheetMask} onPress={() => setSheetOpen(false)}>
          <Pressable style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
            <Text style={styles.sheetTitle}>{t('ai.scenario.title')}</Text>
            {configured === false && (
              <View style={[styles.callout, { marginBottom: 10 }]}>
                <Text style={styles.calloutText}>{t('ai.center.unconfigured')}</Text>
              </View>
            )}

            {/* 第一步：场景列表 */}
            {scenario == null &&
              SCENARIOS.map((s) => (
                <Pressable key={s} style={styles.scenarioRow} onPress={() => setScenario(s)}>
                  <Text style={styles.scenarioName}>{t(`ai.scenario.${s}` as never)}</Text>
                  <Text style={styles.scenarioDesc}>{t(`ai.scenario.${s}.d` as never)}</Text>
                </Pressable>
              ))}

            {/* 第二步：场景参数 */}
            {scenario != null && (
              <View style={{ gap: 10 }}>
                <Text style={styles.scenarioName}>{t(`ai.scenario.${scenario}` as never)}</Text>

                {(scenario === 'review' || scenario === 'compare') && (
                  <ActivityPicker
                    label={scenario === 'review' ? t('ai.scenario.pick') : t('ai.scenario.pickA')}
                    acts={acts}
                    selected={pickA}
                    onSelect={setPickA}
                  />
                )}
                {scenario === 'compare' && (
                  <ActivityPicker
                    label={t('ai.scenario.pickB')}
                    acts={acts}
                    selected={pickB}
                    onSelect={setPickB}
                  />
                )}

                {scenario === 'taper' && (
                  <View>
                    <TextInput
                      mode="outlined"
                      dense
                      label={t('ai.scenario.raceDate')}
                      value={raceDate}
                      onChangeText={setRaceDate}
                      placeholder="2026-10-18"
                      style={styles.input}
                      right={
                        <TextInput.Icon icon="calendar-outline" onPress={() => setPickerOpen(true)} />
                      }
                    />
                    {pickerOpen && (
                      <DateTimePicker
                        value={/^\d{4}-\d{2}-\d{2}$/.test(raceDate) ? new Date(raceDate + 'T00:00:00') : new Date()}
                        mode="date"
                        onChange={(_e, d) => {
                          setPickerOpen(false);
                          if (d) setRaceDate(dayjs(d).format('YYYY-MM-DD'));
                        }}
                      />
                    )}
                  </View>
                )}

                <View style={styles.sheetActions}>
                  <Button mode="text" textColor={palette.muted} onPress={() => setScenario(null)}>
                    {t('session.back')}
                  </Button>
                  {configured === false ? (
                    <Button mode="outlined" textColor={palette.volt} onPress={copyPrompt}>
                      {copied ? t('ai.center.copied') : t('ai.center.report')}
                    </Button>
                  ) : (
                    <Button
                      mode="contained"
                      buttonColor={palette.volt}
                      textColor={palette.bg}
                      disabled={creating}
                      onPress={generate}>
                      {t('ai.scenario.generate')}
                    </Button>
                  )}
                </View>
              </View>
            )}
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

/** 活动选择器（label + 已选显示 + 展开的 chip 列表） */
function ActivityPicker({
  label,
  acts,
  selected,
  onSelect,
}: {
  label: string;
  acts: Awaited<ReturnType<typeof listActivities>>;
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const sel = acts.find((a) => a.file_name === selected);
  return (
    <View>
      <Pressable style={styles.pickerRow} onPress={() => setOpen((v) => !v)}>
        <Text style={styles.pickerLabel}>{label}</Text>
        <Text style={[styles.pickerValue, { color: sel ? palette.text : palette.faint }]} numberOfLines={1}>
          {sel ? `${sel.date} · ${sel.file_name}` : label}
        </Text>
        <Icon source={open ? 'chevron-up' : 'chevron-down'} size={18} color={palette.muted} />
      </Pressable>
      {open && (
        <View style={styles.pickerList}>
          <ScrollView style={{ maxHeight: 200 }} nestedScrollEnabled>
            {acts.map((a) => (
              <Pressable
                key={a.file_name}
                style={styles.pickerItem}
                onPress={() => {
                  onSelect(a.file_name);
                  setOpen(false);
                }}>
                <Text style={styles.pickerItemText} numberOfLines={1}>
                  {a.date} · {a.category} · {a.file_name}
                </Text>
              </Pressable>
            ))}
            {acts.length === 0 && <Text style={styles.scenarioDesc}>—</Text>}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

/** 报告 + 对话合并为统一列表（时间倒序；报告时间取 created_at、对话取 updated_at） */
function mergeEntries(reports: AiReportListItem[], chats: AiChatListItem[]): CenterEntry[] {
  const ms = (s: string) => Date.parse(s.replace(' ', 'T') + 'Z') || 0;
  const entries: CenterEntry[] = [];
  for (const r of reports) {
    entries.push({
      kind: 'report',
      id: r.id,
      mode: r.mode,
      status: r.status,
      title: reportTitle(r),
      time: fmtTime(r.created_at),
      sortMs: ms(r.created_at),
    });
  }
  for (const c of chats) {
    entries.push({
      kind: 'chat',
      id: c.id,
      title: c.title ?? '',
      hasPending: c.has_pending,
      time: fmtTime(c.updated_at),
      sortMs: ms(c.updated_at),
    });
  }
  return entries.sort((a, b) => b.sortMs - a.sortMs);
}

/** 报告卡标题：review 用文件名 / taper 用比赛日期 / compare 用 A vs B / plan 用模式名 */
function reportTitle(r: AiReportListItem): string {
  if (r.mode === 'taper') return r.race_date ?? '';
  if (r.mode === 'compare') return `${r.file_name ?? ''} vs ${r.compare_with ?? ''}`;
  return r.file_name ?? '';
}

/** sqlite UTC 时间（YYYY-MM-DD HH:MM:SS）→ 本地 MM-DD HH:mm */
function fmtTime(s: string): string {
  const d = dayjs(s.replace(' ', 'T') + 'Z');
  return d.isValid() ? d.format('MM-DD HH:mm') : s;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg, paddingHorizontal: 16 },
  title: { color: palette.text, fontSize: 22, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10 },
  callout: { borderWidth: 1, borderRadius: 10, padding: 12, backgroundColor: palette.panel },
  calloutText: { color: palette.text, fontSize: 12, lineHeight: 19 },
  filterRow: { flexDirection: 'row' },
  chip: { backgroundColor: palette.panel, borderColor: palette.lineSoft, borderWidth: 1 },
  chipOn: { backgroundColor: palette.voltDim, borderColor: palette.volt, borderWidth: 1 },
  empty: { color: palette.muted, fontSize: 13, textAlign: 'center', marginTop: 32 },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  badge: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { fontSize: 10, fontWeight: '700' },
  pending: { color: palette.orange, fontSize: 11 },
  failed: { color: palette.red, fontSize: 11 },
  time: { color: palette.faint, fontSize: 11, marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  cardTitle: { color: palette.text, fontSize: 13 },
  sheetMask: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: palette.bgSoft,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: palette.lineSoft,
    padding: 16,
    gap: 8,
    maxHeight: '80%',
  },
  sheetTitle: { color: palette.text, fontSize: 15, fontWeight: '700' },
  sheetActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 4 },
  scenarioRow: { paddingVertical: 10, paddingHorizontal: 4, gap: 3 },
  scenarioName: { color: palette.text, fontSize: 14, fontWeight: '600' },
  scenarioDesc: { color: palette.muted, fontSize: 12 },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1,
    borderColor: palette.lineSoft,
    borderRadius: 8,
    padding: 10,
    backgroundColor: palette.panel,
  },
  pickerLabel: { color: palette.muted, fontSize: 12 },
  pickerValue: { fontSize: 12, flex: 1, textAlign: 'right' },
  pickerList: {
    borderWidth: 1,
    borderColor: palette.lineSoft,
    borderRadius: 8,
    backgroundColor: palette.panel2,
  },
  pickerItem: { paddingHorizontal: 12, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: palette.lineSoft },
  pickerItemText: { color: palette.text, fontSize: 12 },
  input: { backgroundColor: palette.panel },
});
