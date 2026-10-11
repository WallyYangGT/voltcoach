package expo.modules.generationkeepalive

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * GenerationKeepAlive 模块：AI 生成保活前台服务的启动/停止 + 电池优化白名单查询/申请。
 *
 * 失败口径：start/stop 一律 resolve(false) 而不 reject——保活是增强能力，任何失败
 * （系统限制、reactContext 丢失、部分 ROM 不支持白名单 action 等）都应退回
 * 「无保活」的现状行为，绝不打断生成任务本身。JS 侧封装见 src/ai/keepalive.ts。
 */
class GenerationKeepAliveModule : Module() {

  override fun definition() = ModuleDefinition {
    Name("GenerationKeepAlive")

    /** 启动保活前台服务（须在 App 前台时调用；title/body/channelName 为 i18n 后的文案） */
    AsyncFunction("start") { title: String, body: String, channelName: String, promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      try {
        val intent = Intent(context, GenerationKeepAliveService::class.java)
          .putExtra(GenerationKeepAliveService.EXTRA_TITLE, title)
          .putExtra(GenerationKeepAliveService.EXTRA_BODY, body)
          .putExtra(GenerationKeepAliveService.EXTRA_CHANNEL, channelName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          context.startForegroundService(intent)
        } else {
          context.startService(intent)
        }
        promise.resolve(true)
      } catch (e: Exception) {
        // 典型：App 不在前台时被系统拒（ForegroundServiceStartNotAllowedException）。
        // JS 层只在用户点「生成」/回前台续跑时调用，理论不会命中，仍兜底降级。
        promise.resolve(false)
      }
    }

    /** 停止保活前台服务（移除通知 + 释放 wake lock，见 Service.onDestroy） */
    AsyncFunction("stop") { promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      try {
        context.stopService(Intent(context, GenerationKeepAliveService::class.java))
        promise.resolve(true)
      } catch (e: Exception) {
        promise.resolve(false)
      }
    }

    /** 是否已在电池优化白名单内（Doze 不再限制本应用；同步返回，供设置页状态行） */
    Function("isIgnoringBatteryOptimizations") {
      val context = appContext.reactContext?.applicationContext ?: return@Function false
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      pm?.isIgnoringBatteryOptimizations(context.packageName) ?: false
    }

    /**
     * 申请加入电池优化白名单（系统确认弹窗）：FGS 已解决进程冻结，此白名单兜住
     * 深度 Doze 忽略 wake lock 的极端场景。自分发（GitHub Release）不受 Play 对
     * 该权限的政策限制。已在白名单内或系统拒绝弹窗时 resolve(false)。
     */
    AsyncFunction("requestIgnoreBatteryOptimizations") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(false)
        return@AsyncFunction
      }
      val context = activity.applicationContext
      val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (pm?.isIgnoringBatteryOptimizations(context.packageName) == true) {
        promise.resolve(true)
        return@AsyncFunction
      }
      try {
        activity.startActivity(
          Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${context.packageName}"),
          ),
        )
        promise.resolve(true)
      } catch (e: Exception) {
        // 部分 ROM 未注册该 action
        promise.resolve(false)
      }
    }
  }
}
