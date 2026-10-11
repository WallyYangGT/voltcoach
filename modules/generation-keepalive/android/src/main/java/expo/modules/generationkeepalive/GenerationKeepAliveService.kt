package expo.modules.generationkeepalive

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * AI 生成保活前台服务（dataSync 类型）。
 *
 * 为什么需要：App 退后台后进程进入 Android「cached」桶，Android 12+ 的 Cached
 * Apps Freezer 会把整个进程冻结（JS 线程与网络全部停摆），LLM 的 SSE 流式响应
 * 随之中断。本服务运行期间进程进入「前台服务」优先级桶，不进 freezer 名单——
 * 生成任务继续跑在主 JS runtime，UI state 全程连续。
 *
 * 口径（Android 14/15 约束）：
 * - foregroundServiceType="dataSync"（manifest 由 plugins/with-generation-keepalive.js
 *   注入），startForeground 必须显式传同类型（API 34+ 的子集规则），配套权限
 *   FOREGROUND_SERVICE / FOREGROUND_SERVICE_DATA_SYNC 在 app.json android.permissions 声明；
 * - Android 15 起 dataSync 类型有 6 小时/天硬额度，超时回调 onTimeout——必须立刻
 *   stopSelf，否则系统强停（ForegroundServiceDidNotStopInTimeException）；
 * - partial wake lock 防熄屏后 CPU 休眠导致 SSE 断续：FGS 只保进程不保 CPU。
 *   15 分钟硬上限防泄漏（生成总超时默认 10 分钟，正常路径由 onDestroy/stop 释放）；
 * - 通知点击回 App；IMPORTANCE_LOW 不响铃不弹横幅。
 *
 * 生命周期：由 GenerationKeepAliveModule.start/stop 驱动（JS 层引用计数，见
 * src/ai/keepalive.ts）；stopWithTask=false，用户从最近任务划掉 App 服务仍存活。
 */
class GenerationKeepAliveService : Service() {

  private var wakeLock: PowerManager.WakeLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // 重复 start（上一条生成尚未 release 又来一条）时刷新通知文案并确保 wake lock 在持。
    // 整体 try/catch：服务跑在主线程同进程，startForeground/通知构造一旦抛错就是
    // 全 App 崩溃——与 JS 侧「保活失败只降级不打断生成」的口径矛盾（code-review P2-2）。
    try {
      startInForeground(
        title = intent?.getStringExtra(EXTRA_TITLE) ?: DEFAULT_TITLE,
        body = intent?.getStringExtra(EXTRA_BODY) ?: "",
        channelName = intent?.getStringExtra(EXTRA_CHANNEL) ?: DEFAULT_CHANNEL_NAME,
      )
      acquireWakeLock()
    } catch (e: Exception) {
      Log.e(TAG, "启动失败，自动停止（保活降级）", e)
      stopSelf()
    }
    return START_NOT_STICKY // 进程被杀后不自动重建：恢复走 30 分钟续跑兜底（决策 #11 口径保留）
  }

  override fun onDestroy() {
    wakeLock?.let { if (it.isHeld) it.release() }
    wakeLock = null
    super.onDestroy()
  }

  /** Android 15（API 35）：dataSync 类型 6h/天额度耗尽时系统回调，必须数秒内停服 */
  override fun onTimeout(startId: Int, fgsType: Int) {
    stopSelf()
  }

  /** Android 14（API 34）：shortService 超时回调（本服务非 shortService，兜底防崩） */
  override fun onTimeout(startId: Int) {
    stopSelf()
  }

  private fun startInForeground(title: String, body: String, channelName: String) {
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW)
      channel.setShowBadge(false)
      manager.createNotificationChannel(channel) // 重复创建同名 channel 无副作用（幂等）
    }

    // 通知点击回 App；个别 ROM 可能返回 null（无 LAUNCHER 入口时），判空兜底
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(
        this, 0, it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
    val builder =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) Notification.Builder(this, CHANNEL_ID)
      else Notification.Builder(this)
    builder
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(R.drawable.ic_generation_keepalive) // 单色剪影（自适应图标会被蒙版成方块）
      .setOngoing(true)
      .setOnlyAlertOnce(true)
    contentIntent?.let { builder.setContentIntent(it) }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) builder.setPriority(Notification.PRIORITY_LOW)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    val notification = builder.build()

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      // API 34+ 必须显式传 type，且须为 manifest 声明类型的子集
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
  }

  private fun acquireWakeLock() {
    if (wakeLock?.isHeld == true) return
    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_LOCK_TAG).also {
      it.setReferenceCounted(false)
      // 15 分钟硬上限：正常路径生成结束即 stop（onDestroy 释放）；此上限兜底
      // 「JS 侧 release 因异常未到达」的泄漏面。超时后 CPU 可休眠，SSE 或断续，
      // 但生成总超时（默认 10 分钟）会先到，用户可自行评估。
      it.acquire(WAKE_LOCK_TIMEOUT_MS)
    }
  }

  companion object {
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_CHANNEL = "channelName"
    private const val CHANNEL_ID = "generation_keepalive"
    private const val NOTIFICATION_ID = 20261011
    private const val WAKE_LOCK_TAG = "voltcoach:ai-generation"
    private const val WAKE_LOCK_TIMEOUT_MS = 15 * 60 * 1000L
    private const val DEFAULT_TITLE = "AI generating"
    private const val DEFAULT_CHANNEL_NAME = "AI generation"
    private const val TAG = "GenerationKeepAlive"
  }
}
