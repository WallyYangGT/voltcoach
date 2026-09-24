/**
 * AiReportBody — 报告三态正文（pending / failed / completed），会话详情页与训练
 * 详情页的 AI 面板共用，避免两处状态机与文案漂移。
 *
 * pending：生成中提示 + 已等待时长 +（若有）传输级自动重试进度——长报告要等几分钟，
 * 用户需要看到"还在动、动到哪一步了"；failed：错误原文 + 重试；completed：Markdown 正文。
 * M5：failed 重试按钮的禁用/文案改用 generating（db 状态 + 进程内注册表派生）——
 * 此前用局部 retrying，任务被注册表挡下时它立即归零，按钮「实际在重试还能点」。
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
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
  /** 报告生成中（含手动重试/残留补跑的进程内任务）：failed 重试按钮据此禁用 */
  generating: boolean;
  onRetry: () => void;
}

export function AiReportBody({ report, progress, elapsedSec, generating, onRetry }: Props) {
  const { t } = useI18n();
  if (!report) return null;

  if (report.status === 'pending') {
    return (
      <View style={styles.block}>
        <Text style={styles.pending}>{t('ai.panel.pending_hint')}</Text>
        {elapsedSec != null && (
          <Text style={styles.hint}>{t('ai.elapsed', { t: fmtElapsed(elapsedSec) })}</Text>
        )}
        {!!progress && (
          <Text style={styles.hint}>
            {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
          </Text>
        )}
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
        {!!progress && (
          <Text style={styles.hint}>
            {t('ai.retryNote', { n: progress.attempt })} · {progress.note}
          </Text>
        )}
      </View>
    );
  }

  return <AiMarkdown markdown={report.markdown} />;
}

const styles = StyleSheet.create({
  block: { gap: 4, paddingVertical: 6 },
  pending: { color: palette.text, fontSize: 13, lineHeight: 20 },
  hint: { color: palette.faint, fontSize: 11.5, lineHeight: 17 },
  failedBox: { borderWidth: 1, borderColor: palette.red, borderRadius: 10, gap: 6, padding: 12 },
  failedText: { color: palette.red, fontSize: 13, fontWeight: '700' },
  failedErr: { color: palette.muted, fontSize: 12 },
});
