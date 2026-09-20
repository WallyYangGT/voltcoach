/**
 * 首页仪表盘（M2）：CTL/ATL/TSB/FTP 大数字瓦片 + 负荷趋势图 + 月度汇总 + 最近训练。
 * 移植自 Web 版 views/dashboard.js：hero 瓦片/趋势/月度/最近训练同在首页（Web 版即此
 * 信息架构），App 侧空库引导语按 §4.1 改指「训练」tab。数据一次并行取齐：
 * recentFormDaily(90)（趋势图与 hero 大数字同源，序列末端已延伸到今天）/ monthlySummary(6) /
 * listActivities(6)；FTP 科学估算面板见 FtpEstimatePanel（dash.ftp_btn 入口）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChartScroller } from '@/charts/ChartScroller';
import { TrendChart, type TrendPoint } from '@/charts/TrendChart';
import { formNote } from '@/core/i18n';
import { formatDuration } from '@/core/metrics';
import type { MonthlyItem } from '@/core/monthly';
import { ATHLETE, type AthleteParams } from '@/core/settings';
import {
  ActivityListItem,
  getEffectiveAthlete,
  listActivities,
  monthlySummary,
  recentFormDaily,
} from '@/db';
import { FtpEstimatePanel } from '@/components/FtpEstimatePanel';
import { GlossaryModal } from '@/components/GlossaryModal';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 仪表盘一次加载的数据包（loading 态用 null 区分于空库） */
interface HomeData {
  athlete: AthleteParams;
  daily: TrendPoint[];
  monthly: MonthlyItem[];
  recent: ActivityListItem[];
}

export default function HomeScreen() {
  const { t, lang } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<HomeData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [ftpOpen, setFtpOpen] = useState(false); // FTP 科学估算面板展开态（dash.ftp_btn）
  const [glossOpen, setGlossOpen] = useState(false); // 指标说明弹窗（标题旁「?」）

  const load = useCallback(async () => {
    try {
      const [athlete, daily, monthly, recent] = await Promise.all([
        getEffectiveAthlete(),
        recentFormDaily(90),
        monthlySummary(6),
        listActivities(6),
      ]);
      setData({ athlete, daily, monthly, recent });
    } catch (e) {
      console.warn('仪表盘加载失败:', e);
      setData({ athlete: ATHLETE, daily: [], monthly: [], recent: [] });
    }
  }, []);

  // 每次进入该 tab 刷新（导入/设置修改返回后立即反映）
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const last = data && data.daily.length ? data.daily[data.daily.length - 1] : null;

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{ paddingTop: insets.top + 12, paddingBottom: 96, gap: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={palette.muted}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }>
      <View style={styles.titleRow}>
        <Text style={styles.title}>{t('dash.title')}</Text>
        <Pressable hitSlop={10} style={styles.glossBtn} onPress={() => setGlossOpen(true)}>
          <Text style={styles.glossBtnText}>?</Text>
        </Pressable>
      </View>
      <Text style={styles.sub}>{t('dash.sub')}</Text>

      {/* hero 瓦片：CTL 蓝 / ATL 红 / TSB 绿（附 form 简评）/ FTP volt */}
      <View style={styles.heroGrid}>
        {last && (
          <>
            <HeroTile color={palette.blue} label={t('dash.ctl')} value={String(last.ctl)} note={t('dash.ctl_note')} />
            <HeroTile color={palette.red} label={t('dash.atl')} value={String(last.atl)} note={t('dash.atl_note')} />
            <HeroTile
              color={palette.green}
              label={t('dash.tsb')}
              value={(last.tsb > 0 ? '+' : '') + last.tsb}
              note={formNote(last.tsb, lang)}
            />
          </>
        )}
        {/* FTP 瓦片：值 + 「科学估算」入口（Web 版 hero 的 note 位即按钮） */}
        <View style={styles.tile}>
          <View style={[styles.tileBar, { backgroundColor: palette.volt }]} />
          <Text style={styles.tileLabel}>{t('dash.ftp')}</Text>
          <Text style={[styles.tileValue, { color: palette.volt }]}>
            {data?.athlete.ftp_watts ?? '—'}
            <Text style={styles.tileUnit}> W</Text>
          </Text>
          <Pressable style={styles.ftpBtn} onPress={() => setFtpOpen((v) => !v)}>
            <Text style={styles.ftpBtnText}>{t('dash.ftp_btn')}</Text>
          </Pressable>
        </View>
        {!last && (
          <View style={[styles.tile, styles.tileFull]}>
            <Text style={styles.emptyText}>{t('dash.empty')}</Text>
          </View>
        )}
      </View>

      {/* FTP 科学估算面板（展开时渲染，采纳写回后经 onApplied 刷新 hero） */}
      {ftpOpen && <FtpEstimatePanel onApplied={load} />}

      {/* 负荷趋势（近 90 天逐日 CTL/ATL/TSB + TSS 灰柱；空库隐藏面板） */}
      {last && (
        <View style={styles.panel}>
          <Text style={styles.panelTitle}>{t('dash.trend')}</Text>
          <View style={styles.legend}>
            <LegendChip color={palette.blue} label={t('dash.legend.ctl')} />
            <LegendChip color={palette.red} label={t('dash.legend.atl')} />
            <LegendChip color={palette.green} label={t('dash.legend.tsb')} />
          </View>
          {/* 初始停在最近日期一端（今天在最右端），向左滑看历史 */}
          <ChartScroller initialScrollToEnd>
            {(w) => <TrendChart daily={data!.daily} width={w} />}
          </ChartScroller>
        </View>
      )}

      {/* 月度汇总（自然月倒序，最多 6 个月） */}
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>{t('dash.monthly')}</Text>
        {data?.monthly.length ? (
          data.monthly.map((m) => <MonthlyRow key={m.month} m={m} />)
        ) : (
          <Text style={styles.emptyText}>{data ? t('month.empty') : ''}</Text>
        )}
      </View>

      {/* 最近训练（点击进详情） */}
      <View style={styles.panel}>
        <Text style={styles.panelTitle}>{t('dash.recent')}</Text>
        {data?.recent.length ? (
          data.recent.map((item) => (
            <Pressable
              key={item.file_name}
              style={({ pressed }) => [styles.recentRow, pressed && { opacity: 0.7 }]}
              onPress={() =>
                router.push({
                  pathname: '/activity/[id]',
                  params: { id: encodeURIComponent(item.file_name) },
                })
              }>
              <View style={styles.recentTop}>
                <Text style={styles.recentDate}>{item.date}</Text>
                <View style={styles.badges}>
                  <Text style={[styles.recentSport, item.category === 'race' && { color: palette.volt }]}>
                    {t(`cat.${item.category}` as never)}
                  </Text>
                  <Text style={styles.recentSport}>{t(`sport.${item.sport}` as never)}</Text>
                </View>
              </View>
              <View style={styles.recentMetrics}>
                <Metric label={t('act.duration')} value={formatDuration(item.duration_sec)} />
                <Metric label="km" value={item.distance_km != null ? item.distance_km.toFixed(2) : '—'} />
                <Metric label="TSS" value={item.tss != null ? String(item.tss) : '—'} />
                <Metric label="NP" value={item.np != null ? `${item.np}W` : '—'} />
              </View>
            </Pressable>
          ))
        ) : (
          <Text style={styles.emptyText}>{data ? t('dash.no_acts') : ''}</Text>
        )}
      </View>

      {/* 指标说明弹窗（Web 版 glossaryHtml 同源词条） */}
      <GlossaryModal visible={glossOpen} onClose={() => setGlossOpen(false)} />
    </ScrollView>
  );
}

/** hero 瓦片：顶部 3px 色条 + 大写小字 label + 44 级等宽大数字 + muted 简评（Web hero-tile 同构） */
function HeroTile({ color, label, value, note }: { color: string; label: string; value: string; note: string }) {
  return (
    <View style={styles.tile}>
      <View style={[styles.tileBar, { backgroundColor: color }]} />
      <Text style={styles.tileLabel}>{label}</Text>
      <Text style={[styles.tileValue, { color }]}>{value}</Text>
      <Text style={styles.tileNote}>{note}</Text>
    </View>
  );
}

function LegendChip({ color, label }: { color: string; label: string }) {
  return (
    <View style={styles.legendChip}>
      <View style={[styles.legendDot, { backgroundColor: color }]} />
      <Text style={styles.legendText}>{label}</Text>
    </View>
  );
}

/** 单月汇总行：月份 + 类型判读 / TSS·时长·距离·次数 / 强度堆叠条（低绿·中橙·高红）+ 占比 */
function MonthlyRow({ m }: { m: MonthlyItem }) {
  const { t } = useI18n();
  const p = m.intensity_pct;
  return (
    <View style={styles.monthRow}>
      <View style={styles.recentTop}>
        <Text style={styles.recentDate}>{m.month}</Text>
        <Text style={styles.monthType}>
          {m.intensity_type ? t(`month.type.${m.intensity_type}` as never) : ''}
        </Text>
      </View>
      <Text style={styles.monthMetrics}>
        TSS {m.tss} · {m.hours}h · {m.distance_km}km · {m.sessions}
      </Text>
      {p && (
        <>
          <View style={styles.stack}>
            <View style={{ width: `${p.low}%`, backgroundColor: palette.green }} />
            <View style={{ width: `${p.mid}%`, backgroundColor: palette.orange }} />
            <View style={{ width: `${p.high}%`, backgroundColor: palette.red }} />
          </View>
          <Text style={styles.stackPct}>
            {p.low}/{p.mid}/{p.high}%
          </Text>
        </>
      )}
    </View>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metric}>
      <Text style={styles.metricVal}>{value}</Text>
      <Text style={styles.metricLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg, paddingHorizontal: 16 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { color: palette.text, fontSize: 22, fontWeight: '700' },
  glossBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: palette.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glossBtnText: { color: palette.muted, fontSize: 13, fontWeight: '700' },
  sub: { color: palette.muted, fontSize: 12, marginBottom: 2 },
  heroGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  tile: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 4,
    width: '47.5%',
    flexGrow: 1,
    overflow: 'hidden',
  },
  tileFull: { width: '100%' },
  tileBar: { position: 'absolute', top: 0, left: 0, right: 0, height: 3 },
  tileLabel: { color: palette.muted, fontSize: 11, letterSpacing: 0.5, marginTop: 3 },
  tileValue: { fontSize: 36, fontWeight: '700', fontStyle: 'italic', fontVariant: ['tabular-nums'] },
  tileUnit: { fontSize: 14, fontStyle: 'normal', color: palette.muted, fontWeight: '400' },
  tileNote: { color: palette.muted, fontSize: 12 },
  ftpBtn: { borderRadius: 6, borderWidth: 1, borderColor: palette.voltDim, paddingHorizontal: 8, paddingVertical: 4, alignSelf: 'flex-start' },
  ftpBtnText: { color: palette.volt, fontSize: 11, fontWeight: '600' },
  emptyText: { color: palette.muted, textAlign: 'center', lineHeight: 24, paddingVertical: 8 },
  panel: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  panelTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  legend: { flexDirection: 'row', gap: 14 },
  legendChip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 10, height: 3, borderRadius: 1 },
  legendText: { color: palette.muted, fontSize: 11 },
  monthRow: { gap: 6, borderTopWidth: 1, borderTopColor: palette.lineSoft, paddingTop: 10 },
  monthType: { color: palette.muted, fontSize: 12 },
  monthMetrics: { color: palette.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  stack: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    backgroundColor: palette.panel2,
  },
  stackPct: { color: palette.faint, fontSize: 11, fontVariant: ['tabular-nums'] },
  recentRow: {
    borderTopWidth: 1,
    borderTopColor: palette.lineSoft,
    paddingTop: 10,
    gap: 8,
  },
  recentTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  badges: { flexDirection: 'row', gap: 8 },
  recentDate: { color: palette.text, fontSize: 15, fontWeight: '700', fontVariant: ['tabular-nums'] },
  recentSport: { color: palette.muted, fontSize: 12 },
  recentMetrics: { flexDirection: 'row', gap: 18 },
  metric: { gap: 2 },
  metricVal: { color: palette.text, fontSize: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  metricLabel: { color: palette.faint, fontSize: 11 },
});
