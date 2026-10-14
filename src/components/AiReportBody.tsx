/**
 * AiReportBody — 报告四态正文（pending / cancelled / failed / completed），会话详情页
 * 与训练详情页的 AI 面板共用，避免两处状态机与文案漂移。
 *
 * pending：生成中提示 + 已等待时长 +（若有）工具调用动态与传输级自动重试进度 +
 * （2026-10 增量落库）已生成部分正文的实时预览 + 取消按钮（Alert 二次确认——
 * token 已在消耗，防误触）；cancelled：已取消横幅 + 部分正文 + 重试（原行重跑，
 * cancelled 不命中任何补跑路径，重试是唯一复活方式）；failed：错误原文 + 重试；
 * completed：Markdown 正文。
 * M5：failed 重试按钮的禁用/文案改用 generating（db 状态 + 进程内注册表派生）——
 * 此前用局部 retrying，任务被注册表挡下时它立即归零，按钮「实际在重试还能点」。
 */
import React from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button } from 'react-native-paper';
import type { AiReportRow } from '@/db';
import type { GenProgress } from '@/services/aiGenerate';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import { AiMarkdown } from './AiMarkdown';

/** 已等待时长：秒 → "m:ss"（超过 1 小时只显示到分） */
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface Props {
  report: AiReportRow | null;
  progress: GenProgress | null;
  elapsedSec: number | null;
  /** 报告生成中（含手动重试/残留补跑的进程内任务）：重试按钮据此禁用 */
  generating: boolean;
  onRetry: () => void;
  /** 取消生成（2026-10）：缺省不显示按钮（报告非 pending 时调用方也可不传） */
  onCancel?: () => void;
}

export function AiReportBody({ report, progress, elapsedSec, generating, onRetry, onCancel }: Props) {
  const { t } = useI18n();
  if (!report) return null;

  // 取消按钮的可达口径（code-review P1-2）：任务在跑（generating 含手动重试/残留
  // 补跑——重试期间库状态仍是 failed/cancelled）就必须能停，这正是本功能要解决的
  // 「疯狂重试停不下来」痛点；不可取消的窗口只有任务已结束后的静止态。
  const confirmCancel = () => {
    Alert.alert(t('ai.cancelConfirmTitle'), t('ai.cancelConfirmBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('ai.cancelGenerate'), style: 'destructive', onPress: onCancel },
    ]);
  };
  const cancelButton = generating && !!onCancel && (
    <Button compact mode="text" textColor={palette.red} onPress={confirmCancel}>
      {t('ai.cancelGenerate')}
    </Button>
  );

  if (report.status === 'pending') {
    return (
      <View style={styles.block}>
        <Text style={styles.pending}>{t('ai.panel.pending_hint')}</Text>
        {elapsedSec != null && (
          <Text style={styles.hint}>{t('ai.elapsed', { t: fmtElapsed(elapsedSec) })}</Text>
        )}
        {/* 工具调用动态（「正在调用 X…」/「✓ X · N 字符」）与重试进度是两个独立字段，
            分别有值时各占一行（增量落库后生成中过程整体可见） */}
        {!!progress?.activity && <Text style={styles.activity}>{progress.activity}</Text>}
        {!!progress?.note && (
          <Text style={styles.hint}>
            {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
          </Text>
        )}
        {/* 增量落库的部分正文实时预览（节流 2s/200 字回写，轮询 1.5s 拉到） */}
        {!!report.markdown && <AiMarkdown markdown={report.markdown} />}
        {cancelButton}
      </View>
    );
  }

  if (report.status === 'cancelled') {
    return (
      <View style={styles.block}>
        <View style={styles.cancelledBox}>
          <Text style={styles.cancelledText}>{t('ai.badge.cancelled')}</Text>
          <Text style={styles.hint}>{t('ai.cancelledNote')}</Text>
          <Button
            compact
            mode="outlined"
            textColor={palette.volt}
            disabled={generating}
            onPress={onRetry}>
            {generating ? t('ai.retrying') : t('session.retry')}
          </Button>
        </View>
        {/* 重试期间库状态仍是 cancelled：活动/重试进度与取消按钮同样要可见（同 failed） */}
        {!!progress?.activity && <Text style={styles.activity}>{progress.activity}</Text>}
        {!!progress?.note && (
          <Text style={styles.hint}>
            {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
          </Text>
        )}
        {cancelButton}
        {!!report.markdown && <AiMarkdown markdown={report.markdown} />}
      </View>
    );
  }

  if (report.status === 'failed') {
    return (
      <View style={styles.block}>
        <View style={styles.failedBox}>
          <Text style={styles.failedText}>{t('session.failed')}</Text>
          {!!report.error && <Text style={styles.failedErr}>{report.error}</Text>}
          <Button
            compact
            mode="outlined"
            textColor={palette.volt}
            disabled={generating}
            onPress={onRetry}>
            {generating ? t('ai.retrying') : t('session.retry')}
          </Button>
        </View>
        {/* 重试期间库状态仍是 failed：自动重试进度必须在这里也可见（用户此刻最需要知道"在补发"） */}
        {!!progress?.activity && <Text style={styles.activity}>{progress.activity}</Text>}
        {!!progress?.note && (
          <Text style={styles.hint}>
            {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
          </Text>
        )}
        {cancelButton}
      </View>
    );
  }

  return <AiMarkdown markdown={report.markdown} />;
}

const styles = StyleSheet.create({
  block: { gap: 4, paddingVertical: 6 },
  pending: { color: palette.text, fontSize: 13, lineHeight: 20 },
  hint: { color: palette.faint, fontSize: 11.5, lineHeight: 17 },
  activity: { color: palette.orange, fontSize: 11.5, lineHeight: 17 },
  failedBox: { borderWidth: 1, borderColor: palette.red, borderRadius: 10, gap: 6, padding: 12 },
  failedText: { color: palette.red, fontSize: 13, fontWeight: '700' },
  failedErr: { color: palette.muted, fontSize: 12 },
  cancelledBox: { borderWidth: 1, borderColor: palette.lineSoft, borderRadius: 10, gap: 6, padding: 12 },
  cancelledText: { color: palette.orange, fontSize: 13, fontWeight: '700' },
});
