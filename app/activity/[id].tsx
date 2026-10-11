/**
 * 训练详情页（M1）：summary 指标网格 + 时序多系列图 + 功率/心率分区 + 峰功率曲线
 * + 数据质量与异常标注（摘要行常驻，异常细则默认折叠、点击展开——对齐 Web 版
 * <details> 语义，M5 按用户口径一律默认收起）+ AI 复盘面板（M4 后补：对齐 Web 版
 * views/activities.js——顶部「AI 复盘」按钮 + 页尾内嵌报告，匹配本训练的最新
 * review 报告自动呈现，没有则由按钮触发生成，完成态附追问线程与「重新生成」）。
 * 数据源：训练库 getActivitySummary + records gzip 落盘文件（thinRecords ≤1400
 * 抽稀口径）。指标网格内容（含 IF/W·kg⁻¹/VI/心率漂移/当日 CTL-ATL-TSB 小字注释）
 * 由 core/metrics.buildActivityMetrics 装配（逐条对齐 Web 版 views/activities.js），
 * 本页只做排版；系列切换沿用 chips。时序图由 ChartScroller 承载横向滚动（900px
 * 内容宽口径）。
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  KeyboardAvoidingView,
  useKeyboardState,
  useWindowDimensions,
} from 'react-native-keyboard-controller';
import { Appbar, Button, Chip, Icon, TextInput } from 'react-native-paper';
import { ChartScroller } from '@/charts/ChartScroller';
import { HR_ZONE_COLORS, POWER_ZONE_COLORS, ZoneBars } from '@/charts/ZoneBars';
import { PeakCurve } from '@/charts/PeakCurve';
import { TimeSeriesChart, type SeriesSpec } from '@/charts/TimeSeriesChart';
import { AiReviewPanel, type AiReviewPanelHandle } from '@/components/AiReviewPanel';
import type { AskInputInstance } from '@/components/AskInput';
import type { Summary } from '@/core/analyze';
import { formatAnomaly } from '@/core/i18n';
import {
  buildActivityMetrics,
  buildCadenceMetrics,
  formatDurationClock,
  type MetricItem,
  type MetricText,
} from '@/core/metrics';
import { thinRecords } from '@/core/records';
import { HR_ZONES, POWER_ZONES, type Zone } from '@/core/settings';
import { CATEGORY_KEYS, deleteActivity, getActivitySummary, setActivityCategory, setActivityNote } from '@/db';
import { useI18n, type DictKey } from '@/i18n';
import { MetricGrid } from '@/components/MetricGrid';
import { deleteStoredRecord, loadStoredRecords } from '@/records-store';
import { invalidateReportTitles } from '@/services/aiTitle';
import { palette } from '@/theme';

/** 分区定义 × 基准值（FTP/最大心率）→ 各区范围文本（口径同 server.js zoneRanges） */
function zoneRanges(zones: Zone[], base: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const z of zones) {
    const lo = Math.round(z.min * base);
    out[z.name] = z.max === Infinity ? `${lo}+` : `${lo}-${Math.round(z.max * base)}`;
  }
  return out;
}

interface SeriesDef {
  key: 'power' | 'heart_rate' | 'cadence' | 'altitude' | 'speed' | 'temperature';
  labelKey: string;
  color: string;
  area?: boolean;
  field: 'power' | 'heart_rate' | 'cadence' | 'altitude' | 'speed' | 'temperature';
}

// 系列配色与 Web 版 views/activities.js 一致（power 用品牌色 + 面积渐变）
const SERIES_DEFS: SeriesDef[] = [
  { key: 'power', labelKey: 'series.power', color: palette.volt, area: true, field: 'power' },
  { key: 'heart_rate', labelKey: 'series.hr', color: palette.red, field: 'heart_rate' },
  { key: 'cadence', labelKey: 'series.cadence', color: palette.cyan, field: 'cadence' },
  { key: 'altitude', labelKey: 'series.altitude', color: palette.muted, field: 'altitude' },
  { key: 'speed', labelKey: 'series.speed', color: palette.blue, field: 'speed' },
  { key: 'temperature', labelKey: 'series.temp', color: palette.orange, field: 'temperature' },
];

const DEFAULT_VISIBLE = new Set(['power', 'heart_rate', 'cadence']);

export default function ActivityDetailScreen() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const fileName = decodeURIComponent(Array.isArray(params.id) ? params.id[0] : (params.id ?? ''));

  const [summary, setSummary] = useState<Summary | null | undefined>(undefined); // undefined=加载中
  const [thinned, setThinned] = useState<Awaited<ReturnType<typeof thinRecords>> | null>(null);
  const [visible, setVisible] = useState<Set<string>>(new Set(DEFAULT_VISIBLE));
  // 分类与备注草稿（M2：备注点「保存」写库，分类点 chip 即时生效）
  const [note, setNote] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  // 异常细则折叠（M5）：默认收起只看摘要行（含总暂停秒数），点击展开逐条标注
  const [dqOpen, setDqOpen] = useState(false);
  // AI 复盘面板：顶部按钮触发生成/露出面板，panelY 记录面板位置供滚动定位
  const scrollRef = useRef<ScrollView>(null);
  const panelRef = useRef<AiReviewPanelHandle>(null);
  const panelY = useRef<number | null>(null); // null = 面板尚未完成 layout（首次渲染前不滚动）
  const revealPanel = useCallback(() => {
    if (panelY.current == null) return; // 还没量到位置就滚 = 滚到页顶
    scrollRef.current?.scrollTo({ y: Math.max(0, panelY.current - 12), animated: true });
  }, []);

  // 键盘浮起（M5，口径同 AI 会话页）：edge-to-edge 下系统 adjustResize 不再缩放窗口，
  // 由 KeyboardProvider + KeyboardAvoidingView 接管整页垫起。本页备注/追问两个输入都
  // 在长 ScrollView 内部，原生只在聚焦瞬间做过「键盘弹出前」的最小滚动，键盘弹出后
  // 还得把目标输入滚到键盘上方。不走 RN 自带的 scrollResponderScrollNativeHandle
  // ToKeyboard：bridgeless/edge-to-edge 下 RN 核心键盘事件根本不派发（ReactRootView
  // 的 sendEvent 在新架构 no-op，模拟器实测亦然），ScrollView 缓存的 Keyboard.metrics
  // 恒为 null、按整窗高度当键盘顶必滚错——这里用 keyboard-controller 的键盘高度 +
  // 输入行宿主实例的 measureInWindow 自己算目标偏移。不依赖 onFocus 事件拿节点：
  // 已聚焦的输入再点一下不派发 onFocus（模拟器实测），事件只用来记「哪个输入是滚动
  // 目标」，位置一律从 ref 现量
  const kbVisible = useKeyboardState((s) => s.isVisible);
  const kbHeight = useKeyboardState((s) => s.height);
  const windowDp = useWindowDimensions(); // 键盘库同源窗口高度，与 KAV padding 同一真值
  const [lastFocus, setLastFocus] = useState<'note' | 'followup'>('followup');
  const [rescrollTick, setRescrollTick] = useState(0); // 布局变化时 +1，触发重滚
  const scrollOffsetRef = useRef(0);
  const noteWrapRef = useRef<View>(null);
  const followUpInputRef = useRef<AskInputInstance | null>(null);

  // 内容在键盘开着时长高（回复气泡落地、备注/追问多行自增）→ 请重滚一次。滚动只改
  // 偏移不改布局，onLayout 不会因此再触发，无反馈环；键盘关着时 effect 早退，空转无害
  const rescrollOnLayout = useCallback(() => {
    if (kbVisible) setRescrollTick((v) => v + 1);
  }, [kbVisible]);

  // 键盘已开 → 把目标输入行滚到键盘上方。等键盘动画落位后量窗口坐标（此时 KAV
  // padding 已垫满，量到的即终态），目标比当前偏移还小说明整行已可见，不回拉
  useEffect(() => {
    if (!kbVisible || kbHeight <= 0) return;
    const timer = setTimeout(() => {
      const target = lastFocus === 'note' ? noteWrapRef.current : followUpInputRef.current;
      const fromOffset = scrollOffsetRef.current; // 量前先取偏移，与测量同刻配对
      target?.measureInWindow((_x, y, _w, h) => {
        const overflow = y + h + 12 - (windowDp.height - kbHeight);
        if (overflow <= 0) return;
        scrollRef.current?.scrollTo({ y: fromOffset + overflow, animated: true });
      });
    }, 600);
    return () => clearTimeout(timer);
  }, [kbVisible, kbHeight, lastFocus, rescrollTick, windowDp.height]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await getActivitySummary(fileName);
        if (!alive) return;
        setSummary(s);
        setNote(s?.activity.note ?? '');
        if (s) {
          const stored = await loadStoredRecords(fileName);
          if (alive) setThinned(stored ? thinRecords(stored) : null);
        }
      } catch (e) {
        console.warn('加载训练详情失败:', e);
        if (alive) setSummary(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fileName]);

  const flashSaved = () => {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
  };

  /** 删除本训练（含逐秒数据）；AI 报告保留，删完返回列表 */
  const confirmDelete = () => {
    Alert.alert(t('activities.deleteTitle'), t('activities.deleteMsg'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          void (async () => {
            try {
              await deleteActivity(fileName);
            } catch (e) {
              Alert.alert(t('data.err.generic'), e instanceof Error ? e.message : String(e));
              return;
            }
            // 删完就返回：逐秒数据清理失败不该让用户停在一条已删训练的页面上
            try {
              deleteStoredRecord(fileName);
            } catch (e) {
              console.warn('逐秒数据清理失败（训练已删除）:', e);
            }
            invalidateReportTitles(fileName);
            router.back();
          })();
        },
      },
    ]);
  };

  const changeCategory = async (cat: string) => {
    try {
      await setActivityCategory(fileName, cat, lang);
      setSummary((prev) => (prev ? { ...prev, activity: { ...prev.activity, category: cat } } : prev));
      flashSaved();
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    }
  };

  const saveNote = async () => {
    try {
      await setActivityNote(fileName, note, lang);
      setSummary((prev) => (prev ? { ...prev, activity: { ...prev.activity, note } } : prev));
      flashSaved();
    } catch (e) {
      Alert.alert(e instanceof Error ? e.message : String(e));
    }
  };

  const series = useMemo<SeriesSpec[]>(() => {
    if (!thinned) return [];
    const stride = Math.max(1, thinned.stride);
    return SERIES_DEFS.filter((d) => visible.has(d.key)).map((d) => ({
      key: d.key,
      color: d.color,
      area: d.area,
      step: stride,
      points: thinned.points.map((p) => p[d.field]),
    }));
  }, [thinned, visible]);

  // 指标格内容（字典 key 在 UI 词典侧，故在此适配成 core 的取词签名）
  const metrics = useMemo<MetricItem[]>(() => {
    if (!summary) return [];
    const tMetric: MetricText = (key, vars) => t(key as DictKey, vars);
    return buildActivityMetrics(summary, tMetric, lang);
  }, [summary, t, lang]);

  // 踏频-功率分析卡指标格（cadence_power 非骑行/发力样本 <60s 时 analyze 不产出，此为空）
  const cadenceMetrics = useMemo<MetricItem[]>(() => {
    if (!summary?.cadence_power) return [];
    const tMetric: MetricText = (key, vars) => t(key as DictKey, vars);
    return buildCadenceMetrics(summary.cadence_power, tMetric);
  }, [summary, t]);

  if (summary === undefined) return <View style={styles.page} />;
  if (!summary) {
    return (
      <View style={styles.page}>
        <Appbar.Header style={styles.header}>
          <Appbar.BackAction color={palette.text} onPress={() => router.back()} />
          <Appbar.Content title={t('detail.title')} titleStyle={{ color: palette.text }} />
        </Appbar.Header>
        <Text style={styles.empty}>{t('detail.no_data')}</Text>
      </View>
    );
  }

  const a = summary.activity;
  const p = summary.power;
  const hr = summary.heart_rate;
  const ac = summary.athlete_context;
  const dq = summary.data_quality;

  const toggle = (key: string) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <KeyboardAvoidingView style={styles.page} behavior="padding">
      <Appbar.Header style={styles.header}>
        <Appbar.BackAction color={palette.text} onPress={() => router.back()} />
        <Appbar.Content
          title={`${a.date} · ${t(`sport.${a.sport}` as never)}`}
          titleStyle={{ color: palette.text }}
        />
        <Appbar.Action
          icon="robot-outline"
          color={palette.volt}
          accessibilityLabel={t('btn.ai_review')}
          onPress={() => panelRef.current?.analyze()}
        />
        {/* 删除训练（M5）：与列表左滑删除同一口径，删完返回列表（useFocusEffect 自动重载） */}
        <Appbar.Action
          icon="delete-outline"
          color={palette.muted}
          accessibilityLabel={t('common.delete')}
          onPress={confirmDelete}
        />
      </Appbar.Header>
      <ScrollView
        ref={scrollRef}
        contentContainerStyle={styles.body}
        // 键盘开着时点 Save/Send 不吃掉首击收键盘（iOS 上 RN 内置收起拦截会生效、
        // Android 因核心键盘事件不派发本就无此问题，显式声明双端口径一致）
        keyboardShouldPersistTaps="handled"
        // 键盘滚动定位的数据源：当前偏移量（measure 回调里现读配对）
        onScroll={(e) => {
          scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}>
        {/* 概览指标网格（列数随屏宽 2–4；内容与小字注释对齐 Web 版 metric-grid） */}
        <MetricGrid items={metrics} />

        {/* 分类与备注（M2：写库即时生效，AI 复盘时纳入考量） */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('detail.cat_note')}</Text>
          <View style={styles.chipRow}>
            {CATEGORY_KEYS.map((c) => {
              const active = (a.category ?? 'training') === c;
              return (
                <Chip
                  key={c}
                  mode="outlined"
                  selected={active}
                  onPress={() => changeCategory(c)}
                  textStyle={{ color: active ? palette.bg : palette.muted, fontSize: 11 }}
                  style={[styles.chip, active && { backgroundColor: palette.volt, borderColor: palette.volt }]}>
                  {t(`cat.${c}` as never)}
                </Chip>
              );
            })}
          </View>
          {/* 输入+Save 包一层：宿主实例可测量（键盘滚动定位）；gap 补回 card 的 10，
              onLayout 在内容长高（多行自增）时请页面重滚 */}
          <View ref={noteWrapRef} onLayout={rescrollOnLayout} style={styles.noteWrap}>
            <TextInput
              mode="outlined"
              dense
              multiline
              label={t('detail.note_label')}
              value={note}
              onChangeText={setNote}
              style={styles.noteInput}
              onFocus={() => setLastFocus('note')}
            />
            {/* Save 行一并纳入键盘滚动测量范围：输完字保存按钮不被键盘压住 */}
            <View style={styles.saveRow}>
              <Button mode="contained" buttonColor={palette.volt} textColor={palette.bg} onPress={saveNote}>
                {t('common.save')}
              </Button>
              {savedFlash && <Text style={styles.savedText}>{t('common.saved')}</Text>}
            </View>
          </View>
        </View>

        {/* 时序图（系列 chips 切换） */}
        <View style={styles.card}>
          <View style={styles.chipRow}>
            {SERIES_DEFS.map((d) => (
              <Chip
                key={d.key}
                mode="outlined"
                selected={visible.has(d.key)}
                onPress={() => toggle(d.key)}
                textStyle={{
                  color: visible.has(d.key) ? palette.bg : palette.muted,
                  fontSize: 11,
                }}
                style={[
                  styles.chip,
                  visible.has(d.key) && { backgroundColor: d.color, borderColor: d.color },
                ]}>
                {t(d.labelKey as never)}
              </Chip>
            ))}
          </View>
          {series.length && thinned ? (
            <ChartScroller>
              {(w) => <TimeSeriesChart series={series} height={200} width={w} />}
            </ChartScroller>
          ) : (
            <Text style={styles.emptySmall}>{t('chart.no_data')}</Text>
          )}
        </View>

        {/* 分区分布 */}
        {p?.zone_distribution_pct && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('zone.power')}</Text>
            <ZoneBars
              dist={p.zone_distribution_pct}
              colors={POWER_ZONE_COLORS}
              ranges={zoneRanges(POWER_ZONES, ac.ftp_watts)}
            />
          </View>
        )}
        {hr?.zone_distribution_pct && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('zone.hr')}</Text>
            <ZoneBars
              dist={hr.zone_distribution_pct}
              colors={HR_ZONE_COLORS}
              ranges={zoneRanges(HR_ZONES, ac.max_hr)}
            />
          </View>
        )}

        {/* 峰功率曲线 */}
        {p?.peak_curve && Object.keys(p.peak_curve).length > 0 && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('chart.peak_curve')}</Text>
            <PeakCurve curve={p.peak_curve} ftp={ac.ftp_watts} />
          </View>
        )}

        {/* 爬坡段（回补：数据 M1 起随 summary 入库、仅 UI 缺失；位置对齐 Web 版
            climbsHtml → cadencePowerHtml 相邻顺序，插在踏频-功率分析卡之前。
            内容同 Web 版 climbsHtml 七列口径，布局按移动端重做：每段两行——
            首行名称+时长，次行五项小字指标（列头带单位，值直出数字，缺失显示 -） */}
        {summary.climbs?.length ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('climb.title', { n: summary.climbs.length })}</Text>
            {summary.climbs.map((c, i) => (
              <View key={c.name} style={[styles.climbBlock, i > 0 && styles.climbSep]}>
                <View style={styles.climbHead}>
                  <Text style={styles.climbName}>{c.name}</Text>
                  <Text style={styles.climbDur}>{formatDurationClock(c.duration_sec)}</Text>
                </View>
                <View style={styles.climbMetrics}>
                  {(
                    [
                      [t('climb.col.distance'), String(c.distance_m)],
                      [t('climb.col.gain'), String(c.elevation_gain_m)],
                      [t('climb.col.grade'), String(c.avg_grade_pct)],
                      [t('climb.col.avg_power'), c.avg_power != null ? String(c.avg_power) : '-'],
                      [t('climb.col.avg_hr'), c.avg_hr != null ? String(c.avg_hr) : '-'],
                    ] as const
                  ).map(([label, value]) => (
                    <View key={label} style={styles.climbMetricCell}>
                      <Text style={styles.climbMetricLabel}>{label}</Text>
                      <Text style={styles.climbMetricValue}>{value}</Text>
                    </View>
                  ))}
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {/* 踏频-功率分析（M5 回补：数据 M1 起随 summary 入库、仅 UI 缺失；位置在
            数据质量与异常卡上方，对齐 Web 版 cadencePowerHtml → anomaliesHtml 顺序） */}
        {summary.cadence_power && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>{t('cad.title')}</Text>
            <MetricGrid items={cadenceMetrics} />
            {/* 不用 as never：模板字面量类型恰为三个 DictKey 成员，style 扩枚举而未补词典时 tsc 直接报错 */}
            <Text style={styles.dqLine}>{t(`cad.style.${summary.cadence_power.style}`)}</Text>
          </View>
        )}

        {/* 数据质量与异常 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('dq.title')}</Text>
          <View style={styles.dqList}>
            <Text style={styles.dqLine}>
              • {t('dq.power', { p: dq.power_coverage_pct })} · {t('dq.hr', { p: dq.hr_coverage_pct })}
            </Text>
            {dq.dropped_records_no_timestamp != null && (
              <Text style={styles.dqLine}>• {t('dq.dropped', { n: dq.dropped_records_no_timestamp })}</Text>
            )}
            {dq.missing_seconds != null && (
              <Text style={styles.dqLine}>• {t('dq.missing', { n: dq.missing_seconds })}</Text>
            )}
            {dq.pause_seconds != null && (
              <Text style={styles.dqLine}>• {t('dq.paused', { n: dq.pause_seconds })}</Text>
            )}
            {summary.anomalies?.length ? (
              <View>
                {/* 细则默认折叠：头行只报条数（dq.summary），对齐 Web 版 <details> 语义；
                    按用户口径一律默认收起（Web ≤5 条自动展开的分支不搬） */}
                <Pressable
                  onPress={() => setDqOpen((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: dqOpen }}
                  style={styles.dqToggle}>
                  <Icon
                    source={dqOpen ? 'chevron-down' : 'chevron-right'}
                    size={16}
                    color={palette.muted}
                  />
                  <Text style={styles.dqToggleText}>
                    {t('dq.summary', { n: summary.anomalies.length })}
                  </Text>
                </Pressable>
                {dqOpen &&
                  summary.anomalies.map((an, i) => (
                    <Text key={i} style={styles.dqLine}>
                      • {formatAnomaly(an, lang)}
                    </Text>
                  ))}
              </View>
            ) : (
              <Text style={styles.dqLine}>• {t('dq.clean')}</Text>
            )}
          </View>
        </View>

        {/* AI 复盘（页尾，位置对齐 Web 版 #aiPanel：有匹配报告直接呈现，无则按钮生成） */}
        <View
          onLayout={(e) => {
            panelY.current = e.nativeEvent.layout.y;
          }}>
          <AiReviewPanel
            ref={panelRef}
            fileName={fileName}
            onReveal={revealPanel}
            onFollowUpFocus={() => setLastFocus('followup')}
            followUpInputRef={followUpInputRef}
            onFollowUpLayout={rescrollOnLayout}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bgSoft },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  cardTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { height: 30, borderColor: palette.line },
  noteInput: { backgroundColor: palette.panel2 },
  noteWrap: { gap: 10 }, // 补回被包装 View 隔断的 card gap（输入框与 Save 行间距）
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  savedText: { color: palette.green, fontSize: 12 },
  empty: { color: palette.muted, textAlign: 'center', marginTop: 48 },
  emptySmall: { color: palette.muted, textAlign: 'center', paddingVertical: 24 },
  dqList: { gap: 4 },
  dqLine: { color: palette.muted, fontSize: 12.5, lineHeight: 19 },
  dqToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    marginLeft: -10,
    paddingVertical: 6, // 触控目标 ≥48dp 无障碍建议（行高约 19px + 上下 6px）
  },
  dqToggleText: { color: palette.muted, fontSize: 12.5 },
  // 爬坡段卡：段间细分隔线 + 头行（名称+时长）+ 五列小字指标行
  climbBlock: { gap: 6 },
  climbSep: { borderTopWidth: 1, borderTopColor: palette.lineSoft, paddingTop: 10 },
  climbHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  climbName: { color: palette.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  climbDur: { color: palette.muted, fontSize: 12.5, fontVariant: ['tabular-nums'] },
  climbMetrics: { flexDirection: 'row' },
  climbMetricCell: { flex: 1, gap: 1 },
  climbMetricLabel: { color: palette.faint, fontSize: 10, fontWeight: '700' },
  climbMetricValue: {
    color: palette.text,
    fontSize: 13.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
});
