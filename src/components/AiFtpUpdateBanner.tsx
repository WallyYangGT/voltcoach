/**
 * AiFtpUpdateBanner.tsx — AI 教练 FTP 更新披露条（架构评审 S3「审计追认」入口）。
 *
 * update_ftp 工具对模型零参、执行结果只进会话正文——数值层面的问责与可逆落在
 * FTP 真源处：首页 hero 下方常驻披露「AI 于何时把 FTP 从多少改到多少」，撤销走
 * undoAiFtpUpdate（恢复快照 old 值 + 清快照 + 重建档案）。
 *
 * 数据（快照 + 当前 FTP）由首页经 props 下传（首页 load() 在 useFocusEffect 里
 * 每次回焦点重取）——tab 常驻挂载、组件不因切换重建，若在组件内部自查只在挂载
 * 时跑一次，AI 更新后返回首页将看不到披露条（code-review P1：可逆半边不可达）。
 * 显示条件：快照存在且当前 FTP 仍等于快照 new 值——被后续手动/AI 修改即隐藏，
 * 每笔变更只披露/回滚最近一笔。
 */
import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import dayjs from 'dayjs';
import type { AiFtpUpdateSnapshot } from '@/db';
import { undoAiFtpUpdate } from '@/services/ftp-apply';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export function AiFtpUpdateBanner({
  snapshot,
  currentFtp,
  onChanged,
}: {
  snapshot: AiFtpUpdateSnapshot | null;
  currentFtp: number | null;
  onChanged?: () => void;
}) {
  const { t, lang } = useI18n();
  const [busy, setBusy] = useState(false);

  if (!snapshot || currentFtp !== snapshot.new_ftp_w) return null;

  const undo = () => {
    Alert.alert(t('ftp.ai_update.undo_title'), t('ftp.ai_update.undo_body', { w: snapshot.old_ftp_w }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('ftp.ai_update.undo'),
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          undoAiFtpUpdate(lang)
            .then(() => {
              // 两种结果都回调首页 load() 重取快照与 FTP：成功则条目消失；
              // stale（期间 FTP 被改过）重取后显示条件自然隐藏
              onChanged?.();
            })
            .catch((e) => {
              // 撤销失败（如快照 old 值越界/DB 异常）必须有反馈，静默会让用户以为已撤销
              Alert.alert(t('data.err.generic'), e instanceof Error ? e.message : String(e));
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>
        {t('ftp.ai_update.banner', {
          date: dayjs(snapshot.updated_at).format('YYYY-MM-DD'),
          old: snapshot.old_ftp_w,
          new: snapshot.new_ftp_w,
        })}
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
