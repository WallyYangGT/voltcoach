/**
 * with-generation-keepalive.js — 本地 config plugin：向 AndroidManifest 注入 AI 生成
 * 保活前台服务的 <service> 声明（仓库第一个 config plugin；与 prebuild 后补丁脚本的
 * 分工——gradle 注入仍走 scripts/patch-release-signing.mjs，manifest 声明类统一走
 * plugin，随 `npx expo prebuild` 自动执行，本地与 CI 同路径、幂等由框架+本函数保证）。
 *
 * 服务口径（Android 14/15 约束，决策见 docs-private/decisions.md）：
 * - foregroundServiceType="dataSync"：必须与运行时 startForeground 传入的 type 一致
 *   （子集规则），配套权限 FOREGROUND_SERVICE_DATA_SYNC（在 app.json android.permissions
 *   与 FOREGROUND_SERVICE / WAKE_LOCK / POST_NOTIFICATIONS 一并声明）；
 * - stopWithTask="false"：用户从最近任务划掉 App 时服务存活（生成不被打断）；
 *   force-stop 才会终止——那是 30 分钟续跑兜底管的事；
 * - exported="false"：仅本 App 可达。
 */
const { withAndroidManifest, AndroidConfig } = require('expo/config-plugins');

const SERVICE_NAME = 'expo.modules.generationkeepalive.GenerationKeepAliveService';

const withGenerationKeepAlive = (config) =>
  withAndroidManifest(config, (config) => {
    const application = AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults);
    const existing = Array.isArray(application.service) ? application.service : [];
    // 幂等：先移除同名声明再注入（plugin 在每次 prebuild 都会重跑）
    application.service = [
      ...existing.filter((s) => s?.$?.['android:name'] !== SERVICE_NAME),
      {
        $: {
          'android:name': SERVICE_NAME,
          'android:exported': 'false',
          'android:stopWithTask': 'false',
          'android:foregroundServiceType': 'dataSync',
        },
      },
    ];
    return config;
  });

module.exports = withGenerationKeepAlive;
