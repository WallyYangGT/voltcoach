/**
 * GenerationKeepAlive — AI 生成保活前台服务的 TS 接口（本地 Expo 模块，android-only）。
 *
 * 仅应由 src/ai/keepalive.ts 经惰性动态 import 使用（iOS / node:test 环境下
 * requireNativeModule 抛错，由其 try/catch 吞掉整体降级为 no-op）。
 *
 * 通知运行时权限也收在本文件（ensureNotificationPermission）：它依赖 react-native
 * 的 PermissionsAndroid——放 src/ai 会把 node:test 不可 import 的分支拖进覆盖率
 * 门槛文件；本文件不在 src/ 门槛内，且「Android 13+ 才请求、只请求一次、拒绝
 * 不影响 FGS 运行」的口径见函数注释。
 *
 * react-native 取**静态导入**：node:test 下本模块求值即抛 SyntaxError（flow 语法），
 * keepalive.ts 的 try/catch 走「整体 no-op」分支——若改惰性导入，node 里
 * expo-modules-core 能加载到未注册原生的惰性代理，no-op 口径会被悄悄绕过。
 */
import { Platform, PermissionsAndroid } from 'react-native';
import { requireNativeModule } from 'expo-modules-core';

type GenerationKeepAliveNativeModule = {
  /** 启动保活前台服务；false = 启动被拒/失败（调用方降级为无保活行为） */
  start(title: string, body: string, channelName: string): Promise<boolean>;
  /** 停止保活前台服务并移除通知 */
  stop(): Promise<boolean>;
  /** 是否已在电池优化白名单内（同步） */
  isIgnoringBatteryOptimizations(): boolean;
  /** 弹系统确认框申请加入电池优化白名单；false = 已在内/无法弹窗 */
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
  /** 通知权限是否已授予（同步） */
  areNotificationsEnabled(): boolean;
};

const native = requireNativeModule<GenerationKeepAliveNativeModule>('GenerationKeepAlive');

let notificationPermissionRequested = false;

/**
 * Android 13+（API 33）通知运行时权限：fire-and-forget、只申请一次。拒绝时
 * FGS 照常运行（只是通知不展示，用户仍能在任务管理区域看到前台服务图标）；
 * 由 keepalive.ts 在首个 acquire 时调用、不 await，绝不阻塞生成。
 */
async function ensureNotificationPermissionOnce(): Promise<void> {
  if (notificationPermissionRequested) return;
  notificationPermissionRequested = true;
  try {
    if (Platform.OS !== 'android' || Number(Platform.Version) < 33 || !PermissionsAndroid) return;
    await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  } catch {
    // 权限申请失败不构成任何错误：无通知权限 FGS 仍有效
  }
}

export default {
  start: (title: string, body: string, channelName: string) => native.start(title, body, channelName),
  stop: () => native.stop(),
  isIgnoringBatteryOptimizations: () => native.isIgnoringBatteryOptimizations(),
  requestIgnoreBatteryOptimizations: () => native.requestIgnoreBatteryOptimizations(),
  areNotificationsEnabled: () => native.areNotificationsEnabled(),
  ensureNotificationPermission: ensureNotificationPermissionOnce,
};
