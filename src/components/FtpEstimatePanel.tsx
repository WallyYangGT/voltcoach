/**
 * FtpEstimatePanel.tsx — FTP 科学估算面板（M2 首页 dash.ftp_btn 入口展开）
 *
 * 移植自 Web 版 views/dashboard.js 的 runFtpEstimate / ftpEstimateHtml：取数从
 * /api/ftp-estimate 换成本地 cyclingSummariesSince(42) + estimateFtpFromHistory 纯函数；
 * 「采纳」直接 setAthlete 写训练库（Web 版同款门控：仅高置信且与当前配置有差异时
 * 可写回，50–500W 范围由 db 层校验兜底）。估算结果的 needs/notes/refs 文案已由
 * core 层按 lang 生成，本组件只负责排版。
 */
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { estimateFtpFromHistory, type FtpEstimationResult } from '@/core/ftp';
import { cyclingSummariesSince, getEffectiveAthlete, setAthlete } from '@/db';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export function FtpEstimatePanel({ onApplied }: { onApplied: () => void }) {
  const { t, lang } = useI18n();
  const [phase, setPhase] = useState<'loading' | 'done' | 'error'>('loading');
  const [result, setResult] = useState<FtpEstimationResult | null>(null);
  const [errMsg, setErrMsg] = useState('');
  const [applied, setApplied] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [rides, athlete] = await Promise.all([cyclingSummariesSince(), getEffectiveAthlete()]);
        const r = estimateFtpFromHistory(rides, athlete, undefined, lang);
        if (!alive) return;
        setResult(r);
        setPhase('done');
      } catch (e) {
        if (!alive) return;
        setErrMsg(e instanceof Error ? e.message : String(e));
        setPhase('error');
      }
    })();
    return () => {
      alive = false;
    };
    // lang 变化时面板重算（词条随 core 层生成，需跟随）
  }, [lang]);

  if (phase === 'error') {
    return (
      <View style={styles.panel}>
        <Text style={styles.callout}>{t('ftp.failed', { msg: errMsg })}</Text>
      </View>
    );
  }
  if (phase === 'loading' || !result) {
    return (
      <View style={styles.panel}>
        <Text style={styles.muted}>{t('ftp.analyzing')}</Text>
      </View>
    );
  }

  const e = result.estimate;
  const sampleLine = t('ftp.window', {
    days: result.window_days,
    rides: result.sample.cycling_rides,
    power: result.sample.usable_power_rides,
    hr: result.sample.rides_with_hr,
  });
  const refs = t('ftp.refs') + result.references.join('；');

  if (result.status !== 'ok' || !e) {
    return (
      <View style={styles.panel}>
        <Text style={styles.title}>{t('ftp.insufficient')}</Text>
        <Text style={styles.muted}>{sampleLine}</Text>
        <NeedsAndNotes notes={result} />
        <Text style={styles.refs}>{refs}</Text>
      </View>
    );
  }

  const diffTxt =
    e.diff_w === 0
      ? t('ftp.diff.same')
      : e.diff_w > 0
        ? t('ftp.diff.higher', { w: e.current_ftp_w, d: e.diff_w })
        : t('ftp.diff.lower', { w: e.current_ftp_w, d: -e.diff_w });
  const confColor = e.confidence === 'high' ? palette.green : e.confidence === 'medium' ? palette.orange : palette.red;
  const m = e.methods;
  const zm = m.hr_check.zone_mismatch;
  const canApply = e.diff_w !== 0 && e.confidence === 'high' && !applied;

  const apply = async () => {
    setApplying(true);
    try {
      await setAthlete({ ftp_watts: e.ftp_w }, lang, { source: 'estimate' });
      setApplied(true);
      onApplied();
    } catch (err) {
      Alert.alert(t('ftp.apply_failed', { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setApplying(false);
    }
  };

  return (
    <View style={styles.panel}>
      <Text style={styles.title}>{t('ftp.title')}</Text>
      <Text style={styles.muted}>{sampleLine}</Text>

      {/* 大数字 + 置信度徽章 + 简评 */}
      <View style={styles.resultRow}>
        <Text style={styles.big}>{e.ftp_w}<Text style={styles.bigUnit}> W</Text></Text>
        <View style={{ gap: 4 }}>
          <View style={[styles.confBadge, { backgroundColor: confColor }]}>
            <Text style={styles.confText}>{t(`ftp.conf.${e.confidence}` as never)}</Text>
          </View>
          <Text style={styles.muted}>{e.confidence_note}</Text>
        </View>
      </View>
      <Text style={styles.muted}>{t('ftp.range', { lo: e.range_low, hi: e.range_high, diff: diffTxt })}</Text>

      {/* 采纳：高置信且有差异时可写回（与 Web 版门控一致） */}
      {e.diff_w !== 0 &&
        (canApply ? (
          <Pressable style={styles.applyBtn} disabled={applying} onPress={apply}>
            <Text style={styles.applyText}>{t('ftp.apply', { w: e.ftp_w })}</Text>
          </Pressable>
        ) : (
          !applied && <Text style={styles.muted}>{t('ftp.apply_na')}</Text>
        ))}
      {applied && <Text style={styles.applied}>{t('ftp.applied')}</Text>}

      {/* 三方法明细 */}
      <View style={styles.methods}>
        <MethodRow
          name={t('ftp.method.cp')}
          result={m.cp_model ? `${m.cp_model.ftp_w}W` : '-'}
          detail={
            m.cp_model
              ? t('ftp.method.cp_detail', {
                  p5: m.cp_model.p5.watts,
                  d5: m.cp_model.p5.date,
                  p20: m.cp_model.p20.watts,
                  d20: m.cp_model.p20.date,
                  cp: m.cp_model.cp_w,
                  wp: m.cp_model.w_prime_kj,
                })
              : t('ftp.method.cp_na')
          }
        />
        <MethodRow
          name={t('ftp.method.coggan')}
          result={`${m.coggan_20min.ftp_w}W`}
          detail={t('ftp.method.coggan_detail', { w: m.coggan_20min.peak_20min_w, date: m.coggan_20min.date })}
        />
        <MethodRow
          name={t('ftp.method.hr')}
          result={
            m.hr_check.maximal_effort == null
              ? '-'
              : m.hr_check.maximal_effort
                ? t('ftp.method.hr_maximal')
                : t('ftp.method.hr_not_maximal')
          }
          detail={
            t('ftp.method.hr_detail', {
              hr: m.hr_check.best20_max_hr ?? '-',
              thr: m.hr_check.threshold_hr ?? '-',
            }) +
            (zm ? t('ftp.method.hr_zone', { p: zm.power_high_pct, h: zm.hr_high_pct }) : '') +
            (m.hr_check.median_hr_drift_pct != null
              ? t('ftp.method.hr_drift', { d: m.hr_check.median_hr_drift_pct })
              : '')
          }
        />
      </View>

      <NeedsAndNotes notes={result} />
      <Text style={styles.refs}>{refs}</Text>
    </View>
  );
}

/** 数据收集清单（callout）与质量提示（callout info）两段列表——ok/insufficient 两态共用 */
function NeedsAndNotes({ notes }: { notes: FtpEstimationResult }) {
  const { t } = useI18n();
  return (
    <>
      {notes.data_needs.length > 0 && (
        <View style={[styles.calloutBox, { borderColor: palette.orange }]}>
          <Text style={styles.calloutTitle}>{t('ftp.needs')}</Text>
          {notes.data_needs.map((d, i) => (
            <Text key={i} style={styles.listItem}>
              · {d}
            </Text>
          ))}
        </View>
      )}
      {notes.notes.length > 0 && (
        <View style={[styles.calloutBox, { borderColor: palette.blue }]}>
          <Text style={styles.calloutTitle}>{t('ftp.notes')}</Text>
          {notes.notes.map((n, i) => (
            <Text key={i} style={styles.listItem}>
              · {n}
            </Text>
          ))}
        </View>
      )}
    </>
  );
}

function MethodRow({ name, result, detail }: { name: string; result: string; detail: string }) {
  return (
    <View style={styles.methodRow}>
      <View style={styles.methodTop}>
        <Text style={styles.methodName}>{name}</Text>
        <Text style={styles.methodResult}>{result}</Text>
      </View>
      <Text style={styles.methodDetail}>{detail}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  title: { color: palette.text, fontSize: 14, fontWeight: '700' },
  muted: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  big: { color: palette.volt, fontSize: 40, fontWeight: '700', fontStyle: 'italic', fontVariant: ['tabular-nums'] },
  bigUnit: { fontSize: 16, fontStyle: 'normal', color: palette.muted },
  confBadge: { borderRadius: 4, paddingHorizontal: 8, paddingVertical: 2, alignSelf: 'flex-start' },
  confText: { color: palette.bg, fontSize: 11, fontWeight: '700' },
  applyBtn: { backgroundColor: palette.volt, borderRadius: 6, paddingVertical: 8, alignItems: 'center' },
  applyText: { color: palette.bg, fontSize: 13, fontWeight: '700' },
  applied: { color: palette.green, fontSize: 12 },
  methods: { gap: 0, borderTopWidth: 1, borderTopColor: palette.lineSoft },
  methodRow: { borderBottomWidth: 1, borderBottomColor: palette.lineSoft, paddingVertical: 8, gap: 3 },
  methodTop: { flexDirection: 'row', justifyContent: 'space-between' },
  methodName: { color: palette.text, fontSize: 13, fontWeight: '600' },
  methodResult: { color: palette.volt, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  methodDetail: { color: palette.muted, fontSize: 11, lineHeight: 16 },
  calloutBox: { borderWidth: 1, borderRadius: 6, padding: 10, gap: 3 },
  calloutTitle: { color: palette.text, fontSize: 12, fontWeight: '700' },
  listItem: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  refs: { color: palette.faint, fontSize: 11, lineHeight: 16 },
  callout: { color: palette.orange, fontSize: 13, lineHeight: 19 },
});
