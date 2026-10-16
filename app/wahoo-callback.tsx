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
import React, { useEffect, useRef } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
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

  useEffect(() => {
    // 深链参数可能分两次到达（先 URL 后 params），但 useEffect 的依赖重跑会重复收尾，
    // 故只跑一次：拿到的 url 为空时也直接回同步卡（pending 还在，用户可手动粘贴）
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        if (url) {
          const creds = await completeWahooAuth(url);
          if (creds) await providerById('wahoo').saveCredentials(creds);
        }
      } catch (e) {
        // 授权失败不在这里打扰用户：回到同步卡看状态，或用手动粘贴 / 重新授权
        console.warn('Wahoo 授权回调收尾失败:', e);
      } finally {
        router.replace('/(tabs)/me');
      }
    })();
  }, [router, url]);

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
