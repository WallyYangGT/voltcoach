/**
 * 个人训练档案页（v2）：只读展示 core/dossier 聚合的四组长期基线（峰功率 PB/
 * 爬坡与踏频画像/强度结构/负荷与恢复形态）+ 数据口径披露（样本数/更新时间/被
 * 标记功率不可信的骑行数）+ 手动重建按钮。档案由导入/删除/合并/FTP 变更等
 * 触发点自动重建（db 层 getDossier 指纹自愈），本页仅提供可视性与强制刷新。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Button } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getDossier, rebuildDossierQuietly } from '@/db';
import type { AthleteDossier } from '@/core/dossier';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 档案行（键值对，值缺失显示占位符） */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

export default function DossierScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [dossier, setDossier] = useState<AthleteDossier | null | undefined>(undefined); // undefined=加载中
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setDossier(await getDossier());
    } catch (e) {
      console.warn('档案页加载失败:', e);
      setDossier(null);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const rebuild = () => {
    setRefreshing(true);
    void (async () => {
      try {
        // 强制走一遍重建（指纹必然未变也重算——用户显式要求刷新）
        await rebuildDossierQuietly();
        setDossier(await getDossier());
      } catch (e) {
        // rebuildDossierQuietly 内部吞错不会抛到这里；getDossier 抛错须让用户看见
        Alert.alert(t('set.failed', { msg: e instanceof Error ? e.message : String(e) }));
      } finally {
        setRefreshing(false);
      }
    })();
  };

  const fmtW = (n: number | null | undefined) => (n == null ? '-' : `${n}W`);
  const fmtPct = (n: number | null | undefined) => (n == null ? '-' : `${n}%`);

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={t('dossier.title')} titleStyle={styles.headerTitle} />
        <Appbar.Action icon="refresh" color={palette.text} accessibilityLabel={t('dossier.rebuild')} onPress={rebuild} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 10 }}>
        <Text style={styles.sub}>{t('dossier.sub')}</Text>
        {dossier === null && <Text style={styles.empty}>{t('dossier.empty')}</Text>}
        {dossier && (
          <>
            <View style={styles.metaRow}>
              <Text style={styles.meta}>
                {t('dossier.meta', {
                  date: dossier.anchor_date ?? '-',
                  considered: dossier.cycling.considered,
                  with_power: dossier.cycling.with_power,
                })}
              </Text>
            </View>
            {dossier.cycling.total_flagged > 0 && (
              <View style={styles.flagBox}>
                <Text style={styles.flagText}>
                  {t('dossier.flagged', { n: dossier.cycling.total_flagged })}
                </Text>
              </View>
            )}

            <Card title={t('dossier.peak')}>
              {dossier.peak_power.all_time.length ? (
                <>
                  {dossier.peak_power.all_time.map((e) => (
                    <Row
                      key={`pb-${e.window}`}
                      label={t('dossier.peak.pb', { window: e.window })}
                      value={`${fmtW(e.value_w)} · ${e.date}`}
                    />
                  ))}
                  {dossier.peak_power.last_90d.map((e) => (
                    <Row
                      key={`90-${e.window}`}
                      label={t('dossier.peak.recent', { window: e.window })}
                      value={fmtW(e.value_w)}
                    />
                  ))}
                </>
              ) : (
                <Text style={styles.emptySmall}>{t('dossier.no_power_data')}</Text>
              )}
            </Card>

            <Card title={t('dossier.climb')}>
              <Row label={t('dossier.climb.segments')} value={String(dossier.climb_profile.climbs_analyzed)} />
              <Row label={t('dossier.climb.grade')} value={fmtPct(dossier.climb_profile.median_grade_pct)} />
              <Row label={t('dossier.climb.intensity')} value={fmtPct(dossier.climb_profile.median_pct_ftp)} />
              <Row label={t('dossier.climb.hr')} value={dossier.climb_profile.median_avg_hr == null ? '-' : `${dossier.climb_profile.median_avg_hr} bpm`} />
            </Card>

            <Card title={t('dossier.cadence')}>
              {dossier.cadence_profile.rides_analyzed > 0 ? (
                <>
                  <Row label={t('dossier.cadence.low')} value={fmtPct(Math.round((dossier.cadence_profile.style_counts.low / dossier.cadence_profile.rides_analyzed) * 1000) / 10)} />
                  <Row label={t('dossier.cadence.normal')} value={fmtPct(Math.round((dossier.cadence_profile.style_counts.normal / dossier.cadence_profile.rides_analyzed) * 1000) / 10)} />
                  <Row label={t('dossier.cadence.high')} value={fmtPct(Math.round((dossier.cadence_profile.style_counts.high / dossier.cadence_profile.rides_analyzed) * 1000) / 10)} />
                </>
              ) : (
                <Text style={styles.emptySmall}>{t('dossier.no_data')}</Text>
              )}
            </Card>

            <Card title={t('dossier.intensity')}>
              {dossier.intensity_structure.zone_pct ? (
                <Row
                  label={t('dossier.intensity.zones')}
                  value={Object.entries(dossier.intensity_structure.zone_pct)
                    .map(([z, v]) => `${z} ${v}%`)
                    .join(' / ')}
                />
              ) : (
                <Text style={styles.emptySmall}>{t('dossier.no_power_data')}</Text>
              )}
              {dossier.intensity_structure.intensity_types.map((m) => (
                <Row key={m.month} label={m.month} value={m.type} />
              ))}
            </Card>

            <Card title={t('dossier.load')}>
              {(() => {
                const weeks = dossier.load_shape.weeks;
                const totalRides = weeks.reduce((a, w) => a + w.rides, 0);
                if (!totalRides) return <Text style={styles.emptySmall}>{t('dossier.no_data')}</Text>;
                const avgTss = Math.round(weeks.reduce((a, w) => a + w.tss, 0) / weeks.length);
                const peakTss = Math.max(...weeks.map((w) => w.tss));
                const avgHours = Math.round((weeks.reduce((a, w) => a + w.duration_sec, 0) / weeks.length / 3600) * 10) / 10;
                return (
                  <>
                    <Row label={t('dossier.load.avg_tss')} value={String(avgTss)} />
                    <Row label={t('dossier.load.peak_tss')} value={String(peakTss)} />
                    <Row label={t('dossier.load.avg_hours')} value={`${avgHours} h`} />
                    <Row
                      label={t('dossier.load.drift')}
                      value={
                        dossier.load_shape.hr_drift.median_pct == null
                          ? '-'
                          : `${dossier.load_shape.hr_drift.median_pct}% (${dossier.load_shape.hr_drift.rides})`
                      }
                    />
                  </>
                );
              })()}
            </Card>

            <Text style={styles.meta}>
              {t('dossier.generated_at', { at: String(dossier.generated_at).slice(0, 16).replace('T', ' ') })}
            </Text>
            <Button
              mode="outlined"
              textColor={palette.text}
              onPress={rebuild}
              disabled={refreshing}
              loading={refreshing}>
              {t('dossier.rebuild')}
            </Button>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, borderBottomWidth: 1, borderBottomColor: palette.lineSoft },
  headerTitle: { color: palette.text, fontSize: 15 },
  sub: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  empty: { color: palette.muted, fontSize: 13, textAlign: 'center', marginTop: 32 },
  emptySmall: { color: palette.faint, fontSize: 12 },
  metaRow: { flexDirection: 'row' },
  meta: { color: palette.faint, fontSize: 11.5, lineHeight: 17 },
  flagBox: {
    borderColor: palette.orange,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: palette.panel,
  },
  flagText: { color: palette.orange, fontSize: 12, lineHeight: 17 },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    gap: 8,
  },
  cardTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  rowLabel: { color: palette.muted, fontSize: 12.5, flex: 1 },
  rowValue: { color: palette.text, fontSize: 12.5, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
