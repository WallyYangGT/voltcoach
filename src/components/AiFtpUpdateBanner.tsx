/**
 * AiFtpUpdateBanner.tsx — AI 教练 FTP 更新披露条（架构评审 S3「审计追认」入口）。
 *
 * update_ftp 工具对模型零参、执行结果只进会话正文——数值层面的问责与可逆落在
 * FTP 真源处：首页 hero 下方常驻披露「AI 于何时把 FTP 从多少改到多少」，撤销走
 * undoAiFtpUpdate（恢复快照 old 值 + 清快照 + 重建档案）。数据源是 athlete JSON
 * 的 ai_ftp_update 快照（applyAiFtpUpdate 成功时写入）；当前 FTP 不再等于快照
 * new 值（用户后来手动改过/又发生一次 AI 更新）即整条隐藏——每笔变更只披露
 * 最近一笔，旧会话里的历史可到 FTP 估算面板回看。
 */
import React, { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { getAiFtpUpdate, getEffectiveAthlete, type AiFtpUpdateSnapshot } from '@/db';
import { undoAiFtpUpdate } from '@/services/ftp-apply';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** updated_at 截到日期（ISO 串；展示口径与档案/报告一致，不做时区换算） */
const fmtDate = (iso: string) => iso.slice(0, 10);

export function AiFtpUpdateBanner({ onChanged }: { onChanged?: () => void }) {
  const { t, lang } = useI18n();
  const [snap, setSnap] = useState<AiFtpUpdateSnapshot | null>(null);
  const [currentFtp, setCurrentFtp] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [s, athlete] = await Promise.all([getAiFtpUpdate(), getEffectiveAthlete()]);
        if (!alive) return;
        setSnap(s);
        setCurrentFtp(athlete.ftp_watts);
      } catch {
        if (alive) setSnap(null); // 取数失败按无快照处理（披露条是增强项，不阻塞首页）
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 撤销后发现快照失效（期间 FTP 被改过）：重查一次让条件渲染自然收敛
  const refresh = async () => {
    const [s, athlete] = await Promise.all([getAiFtpUpdate(), getEffectiveAthlete()]);
    setSnap(s);
    setCurrentFtp(athlete.ftp_watts);
  };

  if (!snap || currentFtp !== snap.new_ftp_w) return null;

  const undo = () => {
    Alert.alert(t('ftp.ai_update.undo_title'), t('ftp.ai_update.undo_body', { w: snap.old_ftp_w }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('ftp.ai_update.undo'),
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          undoAiFtpUpdate(lang)
            .then((r) => {
              if (r.undone) {
                setSnap(null);
                onChanged?.();
              } else {
                void refresh();
              }
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>
        {t('ftp.ai_update.banner', { date: fmtDate(snap.updated_at), old: snap.old_ftp_w, new: snap.new_ftp_w })}
      </Text>
      <Pressable
        style={styles.undoBtn}
        disabled={busy}
        onPress={undo}
        accessibilityRole="button"
        accessibilityLabel={t('ftp.ai_update.undo')}
      >
        <Text style={styles.undoText}>{t('ftp.ai_update.undo')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: palette.panel,
    borderColor: palette.voltDim,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  text: { color: palette.muted, fontSize: 12, lineHeight: 18, flex: 1 },
  undoBtn: {
    borderRadius: 6,
    borderWidth: 1,
    borderColor: palette.voltDim,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  undoText: { color: palette.volt, fontSize: 12, fontWeight: '600' },
});
