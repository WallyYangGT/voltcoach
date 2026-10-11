/**
 * GenerationKeepAlive — AI 生成保活前台服务的 TS 接口（本地 Expo 模块，android-only）。
 *
 * 仅应由 src/ai/keepalive.ts 经惰性动态 import 使用（iOS / node:test 环境下
 * requireNativeModule 抛错，由其 try/catch 吞掉整体降级为 no-op）。
 */
import { requireNativeModule } from 'expo-modules-core';

type GenerationKeepAliveModule = {
  /** 启动保活前台服务；false = 启动被拒/失败（调用方降级为无保活行为） */
  start(title: string, body: string, channelName: string): Promise<boolean>;
  /** 停止保活前台服务并移除通知 */
  stop(): Promise<boolean>;
  /** 是否已在电池优化白名单内（同步） */
  isIgnoringBatteryOptimizations(): boolean;
  /** 弹系统确认框申请加入电池优化白名单；false = 已在内/无法弹窗 */
  requestIgnoreBatteryOptimizations(): Promise<boolean>;
};

export default requireNativeModule<GenerationKeepAliveModule>('GenerationKeepAlive');
