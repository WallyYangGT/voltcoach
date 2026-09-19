/**
 * 训练详情页（M1）：summary 指标 + 时序多系列图 + 功率/心率分区 + 峰功率曲线
 * + 数据质量与异常标注。数据源：训练库 getActivitySummary + records gzip 落盘文件
 * （thinRecords ≤1400 抽稀口径）。布局对照 Web 版详情页（views/activities.js），
 * 移动端改为系列 chips 切换（默认功率/心率/踏频）。
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Chip } from 'react-native-paper';
import { HR_ZONE_COLORS, POWER_ZONE_COLORS, ZoneBars } from '@/charts/ZoneBars';
import { PeakCurve } from '@/charts/PeakCurve';
import { TimeSeriesChart, type SeriesSpec } from '@/charts/TimeSeriesChart';
import type { Summary } from '@/core/analyze';
import { formatAnomaly } from '@/core/i18n';
import { thinRecords } from '@/core/records';
import { HR_ZONES, POWER_ZONES, type Zone } from '@/core/settings';
import { getActivitySummary } from '@/db';
import { useI18n } from '@/i18n';
import { loadStoredRecords } from '@/records-store';
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

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await getActivitySummary(fileName);
        if (!alive) return;
        setSummary(s);
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

  if (summary === undefined) return <View style={styles.page} />;
  if (!summary) {
    return (
      <View style={styles.page}>
        <Appbar.Header style={styles.header} statusBarHeight={0}>
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
  const fmtDur = (sec: number) => {
    const h = Math.floor(sec / 3600),
      m = Math.round((sec % 3600) / 60);
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}m`;
  };

  const toggle = (key: string) =>
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={0}>
        <Appbar.BackAction color={palette.text} onPress={() => router.back()} />
        <Appbar.Content
          title={`${a.date} · ${t(`sport.${a.sport}` as never)}`}
          titleStyle={{ color: palette.text }}
        />
      </Appbar.Header>
      <ScrollView contentContainerStyle={styles.body}>
        {/* 概览大数字 */}
        <View style={styles.grid}>
          <Big label={t('act.duration')} value={fmtDur(a.duration_sec)} />
          <Big label="km" value={a.distance_km != null ? a.distance_km.toFixed(2) : '—'} />
          <Big label="m↑" value={String(a.elevation_gain_m)} />
          {a.avg_speed_kmh != null && <Big label="km/h" value={a.avg_speed_kmh.toFixed(1)} />}
          {a.total_calories != null && <Big label="kcal" value={String(a.total_calories)} />}
          {p?.normalized_power != null && <Big label="NP" value={`${p.normalized_power}W`} />}
          {p?.tss != null && <Big label="TSS" value={String(p.tss)} />}
          {p?.intensity_factor != null && <Big label="IF" value={p.intensity_factor.toFixed(2)} />}
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
            <TimeSeriesChart series={series} height={200} />
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
              summary.anomalies.map((an, i) => (
                <Text key={i} style={styles.dqLine}>
                  • {formatAnomaly(an, lang)}
                </Text>
              ))
            ) : (
              <Text style={styles.dqLine}>• {t('dq.clean')}</Text>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function Big({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.bigItem}>
      <Text style={styles.bigVal}>{value}</Text>
      <Text style={styles.bigLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bgSoft },
  body: { padding: 16, gap: 12, paddingBottom: 40 },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 14,
  },
  bigItem: { minWidth: 68, gap: 2 },
  bigVal: { color: palette.volt, fontSize: 20, fontWeight: '700', fontVariant: ['tabular-nums'] },
  bigLabel: { color: palette.faint, fontSize: 11 },
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
  empty: { color: palette.muted, textAlign: 'center', marginTop: 48 },
  emptySmall: { color: palette.muted, textAlign: 'center', paddingVertical: 24 },
  dqList: { gap: 4 },
  dqLine: { color: palette.muted, fontSize: 12.5, lineHeight: 19 },
});
