/**
 * 底部导航：首页 / 训练 / AI / 我的（四目的地信息架构）
 *
 * 说明：Expo SDK 57 的 expo-router 已移除 @react-navigation 集成，官方路线是
 * NativeTabs（安卓原生 Material 3 底栏 / iOS UITabBar），比 JS tabs 更贴 MD3，
 * 主题色经 props 注入（nativeTabsStyle，与 Paper 主题同源）。
 */
import { NativeTabs } from 'expo-router/unstable-native-tabs';
import { useI18n } from '@/i18n';
import { nativeTabsStyle } from '@/theme';

export default function TabsLayout() {
  const { t } = useI18n();
  return (
    <NativeTabs {...nativeTabsStyle}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon md="home" sf="house" />
        <NativeTabs.Trigger.Label>{t('tab.home')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activities">
        <NativeTabs.Trigger.Icon md="directions_bike" sf="figure.outdoor.cycle" />
        <NativeTabs.Trigger.Label>{t('tab.activities')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="ai">
        <NativeTabs.Trigger.Icon md="auto_awesome" sf="sparkles" />
        <NativeTabs.Trigger.Label>{t('tab.ai')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="me">
        <NativeTabs.Trigger.Icon md="person" sf="person" />
        <NativeTabs.Trigger.Label>{t('tab.me')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
