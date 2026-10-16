/**
 * wahoo-callback.tsx — Wahoo 授权回调落地页（2026-10-16 多平台化）
 *
 * 为什么需要这个路由：授权完成后浏览器会把 `voltcoach:///wahoo-callback?code=…` 交回
 * 系统，系统再以**深链**形式唤起本 App——expo-router 会尝试按路由匹配它。没有这个文件
 * 时用户看到的是「Unmatched Route」错误页（模拟器冒烟实测），既难看也会盖住同步卡。
 * 因此把回调路径做成一条真实路由：它负责**完成换令牌并保存凭据**，然后立刻回到同步卡。
 *
 * 与卡片内表单的分工：`expo-web-browser` 的「浏览器关闭 vs 深链到达」赛跑可能先被前者
 * 赢掉（Custom Tab 被系统留在后台），所以表单那条快路径拿不到 URL 是正常的；真正的
 * 收尾点在这里。`completeWahooAuth` 以模块级 pending 为锁，两条入口幂等，谁先到谁完成。
 *
 * 失败（state 不匹配、换码被拒、或压根没有进行中的授权=用户手动打开的链接）不弹错：
 * 打日志后回同步卡，卡片里还有「手动粘贴」路径可以兜底。
 */
import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/i18n';
import { providerById } from '@/services/syncProviders';
import { completeWahooAuth, useWahooCallbackUrl } from '@/services/wahooAuth';
import { palette } from '@/theme';

export default function WahooCallbackScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { t } = useI18n();
  const url = useWahooCallbackUrl();
  const started = useRef(false);

  const finish = useCallback(() => {
    router.replace('/(tabs)/me');
  }, [router]);

  // ⚠️ url 为 null 时**不能**置 started：useLinkingURL 虽给同步初值，热启动路径仍可能晚一拍
  // 到达；早退会让收尾彻底失效（评审 P1-1）。等到 url 到达再收尾。
  useEffect(() => {
    if (started.current || !url) return;
    started.current = true;
    void (async () => {
      try {
        const creds = await completeWahooAuth(url);
        if (creds) await providerById('wahoo').saveCredentials(creds);
      } catch (e) {
        // 收尾失败要露一次面：否则用户回到卡片只看到「未绑定」，不知道发生了什么
        console.warn('Wahoo 授权回调收尾失败:', e);
        Alert.alert(t('data.sync.wahoo.failed'), e instanceof Error ? e.message : String(e));
      } finally {
        finish();
      }
    })();
  }, [finish, t, url]);

  // 兜底：没等到 url（用户手动打开该路径/深链被吞）也别把人卡在过渡页
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!started.current) {
        started.current = true;
        finish();
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [finish]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <ActivityIndicator color={palette.volt} />
      <Text style={styles.text}>{t('data.sync.wahoo.callback')}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.bg,
    gap: 14,
  },
  text: { color: palette.muted, fontSize: 14 },
});
