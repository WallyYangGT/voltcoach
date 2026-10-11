/**
 * KeepAliveCard — 后台生成保活卡：AI 生成期间由 dataSync 前台服务保进程（机制见
 * src/ai/keepalive.ts 与原生模块 modules/generation-keepalive），本卡只承担用户侧
 * 口径——说明通知的作用、展示电池优化白名单状态并一键申请（兜深度 Doze），附
 * OEM 私有杀后台的引导文案（FGS 管不住小米/华为等的私有策略，只能引导用户设置）。
 * iOS 无对应原生能力（keepalive.ts 在 iOS 上整体 no-op，生成仍须前台），整卡不渲染。
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Platform, Alert, StyleSheet, Text, View } from 'react-native';
import { Button } from 'react-native-paper';
import {
  areNotificationsEnabled,
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
} from '@/ai/keepalive';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export function KeepAliveCard() {
  const { t } = useI18n();
  const [whitelisted, setWhitelisted] = useState(false);
  const [notifEnabled, setNotifEnabled] = useState(false);

  const load = useCallback(async () => {
    const [wl, notif] = await Promise.all([
      isIgnoringBatteryOptimizations(),
      areNotificationsEnabled(),
    ]);
    setWhitelisted(wl);
    setNotifEnabled(notif);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  // Hook 全部在提前 return 之前（react-hooks 铁律）
  if (Platform.OS !== 'android') return null;

  const request = async () => {
    const ok = await requestIgnoreBatteryOptimizations();
    if (!ok && !(await isIgnoringBatteryOptimizations())) {
      // false = 权限缺失或部分 ROM 未注册该 action：给出提示，不留静默失败
      Alert.alert(t('me.keepalive.battery.unavailable'));
    }
    // 系统弹窗异步返回，此刻重查多半还是旧值——用户确认后回本页 focus 会刷新
    await load();
  };

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t('me.keepalive')}</Text>
      <Text style={styles.note}>{t('me.keepalive.desc')}</Text>
      <Text style={[styles.status, { color: notifEnabled ? palette.green : palette.orange }]}>
        {notifEnabled ? t('me.keepalive.notif.ok') : t('me.keepalive.notif.off')}
      </Text>
      <Text style={[styles.status, { color: whitelisted ? palette.green : palette.orange }]}>
        {whitelisted ? t('me.keepalive.battery.ok') : t('me.keepalive.battery.off')}
      </Text>
      {!whitelisted && (
        <Button mode="outlined" textColor={palette.volt} onPress={request} compact>
          {t('me.keepalive.battery.action')}
        </Button>
      )}
      <Text style={styles.note}>{t('me.keepalive.oem')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  cardTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  status: { fontSize: 12, fontWeight: '700' },
  note: { color: palette.faint, fontSize: 11, lineHeight: 16 },
});
