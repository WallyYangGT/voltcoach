# 发版指南（RELEASING）

> **文档地位**：本文是发版流程的**唯一权威入口**——tag 即发版的完整 SOP、签名配置、发版包体检与已知陷阱都在这里；`README.md` 只留摘要指向本文。发布流水线实现在 `.github/workflows/release.yml`。

## 版本纪律

- **版本单一来源是 `package.json` 的 `version`**，`app.json` 的 `expo.version` 是它的镜像——两者由 `node scripts/version.mjs` 同步维护（`bump` 双写、`check` 校验一致），CI 硬闸断言两文件一致。
- **发版 tag 必须等于当前版本**：`vX.Y.Z` tag 打在 `package.json` version = X.Y.Z 的提交上，发版流水线会断言（不一致直接失败）。
- versionName 取 tag（`v1.2.3` → `1.2.3`），versionCode 取 GitHub Actions run number（单调递增）——两者都在打包期由 `scripts/stamp-release-version.mjs` 写入 `app.json`（随后经 prebuild 注入原生工程），**仓库内不手写这两个值**。

## 发版 checklist

| # | 步骤 | 操作 | 要点 |
|---|---|---|---|
| 1 | 前置检查 | `git status` 干净、当前在 main、`git log --oneline -5` 确认在目标提交 | 出包与再开发不并行；多分支时**先确认分支**再打 tag |
| 2 | 本地门禁 | `npm run lint && npx tsc --noEmit && npm test && npm run test:coverage && npm run golden` | 全绿才继续；golden 需本地真实素材（见 [MAINTENANCE](./MAINTENANCE.md)） |
| 3 | 确认版本 | `node scripts/version.mjs check` | version 应已是本次想发的值（合并 PR 时已 bump） |
| 4 | 打 tag | `git tag v1.2.3 && git push origin v1.2.3` | tag == package.json version，否则流水线「版本戳」步骤失败 |
| 5 | 等 CI 门禁 | Actions 页观察 `Release APK` | lint + 单测 + 组件测试 + 黄金 diff（CI 无素材自动跳过 golden） |
| 6 | 自动打包 | prebuild → 签名 → `assembleRelease` → `check:apk` | NDK 版本随 Expo SDK 固定（workflow 内注明） |
| 7 | 产物体检 | `check:apk` 解包断言 | 见下文「发版包体检」；失败即中止发布 |
| 8 | Release 发布 | 自动挂 GitHub Release，附 APK 与自动 release notes | debug 签名回退时 Release 正文自曝（见下） |
| 9 | 验活 | 下载 APK 真机安装冒烟；确认版本号/签名 | 覆盖安装验证签名一致性 |
| 10 | 收尾 | 如发版后发现阻塞缺陷，修复走正常 PR + 新 tag | 已发布 tag 与产物不重传、不覆盖 |

演练不发版：Actions 页手动触发（workflow_dispatch）只构建并上传 artifact，不创建 Release。

## 签名配置（Secrets）

不配置时产物使用 **debug 签名**（可直接侧载体验，但不能覆盖安装正式签名包），且 Release 正文会自动注明；配置后为正式签名。**四个 Secrets 必须要么全配、要么全不配——半配直接失败**（防把 debug 包当正式版发出去）。

生成一次 keystore 并配置（keystore 本体与口令**绝不入库**，已被 `.gitignore` 排除；**建议把 keystore 存放在仓库目录之外**——gitignore 只是防误提交，全文索引/整目录打包/AI 代理盲读等旁路仍可能把工作区内的文件带出去，与「原史备份在仓库外」同等待遇）：

```bash
# <密钥目录> 指仓库之外的安全位置（如 ../secrets/），下同
keytool -genkeypair -v -keystore <密钥目录>/voltcoach.keystore -alias voltcoach \
  -keyalg RSA -keysize 2048 -validity 10000
# base64 内容（GitHub Secrets 填这个）
base64 -w0 <密钥目录>/voltcoach.keystore          # macOS/Linux/Git Bash
certutil -encode <密钥目录>/voltcoach.keystore keystore-b64.txt   # Windows（输出含 PEM 头尾行，流水线已兼容）
```

| Secret | 值 |
|---|---|
| `ANDROID_KEYSTORE_B64` | keystore 的 base64 内容 |
| `ANDROID_KEYSTORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | 别名（如 `voltcoach`） |
| `ANDROID_KEY_PASSWORD` | key 口令 |

所有版本使用**同一 keystore**，保证用户覆盖安装不冲突；keystore 丢失即无法再发同签名更新——务必备份到仓库之外。

## 发版包体检（check:apk）

每次发版构建后流水线自动跑 `npm run check:apk`：解包 APK 内的 JS bundle，断言——

- **不含**联调残留：`10.0.2.2`、`:8791`/`:8792`/`:8793`（顽鹿/迹驰/Wahoo 三个 mock 的默认端口）、`127.0.0.1`、`10./192.168./172.` 私网地址；
- **必须含**三平台四个生产端点特征：`onelap.cn`、`prod.zh.igpsport.com`、`prod.en.igpsport.com`、`api.wahooligan.com`——反向验证 bundle 是生产配置；
- cleartext `http://` 主机**默认拒绝**（白名单外一律算嫌疑，公网联调地址也逃不掉，白名单见脚本）。

背景：`EXPO_PUBLIC_*` 环境变量是打包期内联的，而改环境变量**不会**失效 Metro/Gradle 的 bundle 缓存——曾出现「联调包被当生产包发出」的真实事故，此闸门是防复发手段。

## EXPO_PUBLIC_* 与 bundle 缓存陷阱

`EXPO_PUBLIC_*` 环境变量不在打包任务的输入清单里——换变量后任务 up-to-date 检查照常通过、产物原样复用；Metro 的 transform 缓存（babel 内联结果按文件缓存）同样不感知 env 变化。所以换任何 `EXPO_PUBLIC_*` 前后**必须走完整流程**（2026-10-16 实测口径）：

```bash
cd android && ./gradlew --stop          # 停旧 daemon（防御性，保证干净起点）
rm -rf app/build/generated/assets/react/<variant> \
       app/build/intermediates/assets/<variant>/merge<Variant>Assets/index.android.bundle \
       "$TEMP/metro-cache"               # 产物 + Metro transform 缓存都要清
VOLTCOACH_UNIVERSAL_APK=1 EXPO_PUBLIC_ONELAP_BASE=http://10.0.2.2:8791 \
  ./gradlew assembleBeta -PreactNativeArchitectures=x86_64 --rerun-tasks
# 若启用了 Gradle build cache（org.gradle.caching=true），还须加 --no-build-cache，
# 否则删掉的产物会被缓存原样拉回
```

验证 bundle 内容用 node latin1 检索（`scripts/check-release-bundle.mjs` 同款方法；grep 对 Hermes 字节码可能假阴性）。生产构建不要带任何 `EXPO_PUBLIC_*` 联调变量（不设即用真实端点）。构建后跑 `npm run check:apk` 体检。

## 本地打包（不用 CI 时）

```bash
npx expo prebuild --platform android --no-install
# 以下两步是 prebuild 后的本机惯例（CI 不需要）：
#   1. android/local.properties 手写 sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk（必须正斜杠）
#   2. 国内网络在 android/build.gradle 的 buildscript/allprojects repositories 里
#      google()/mavenCentral() 之前补阿里云三镜像（maven.aliyun.com 的 google/public/gradle-plugin）
node scripts/patch-release-signing.mjs   # env 驱动注入签名；未设 VOLTCOACH_KEYSTORE_* 时回退 debug 签名
cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
cd .. && npm run check:apk
```

⚠️ 本地 `./gradlew assembleRelease` 不带 `-PreactNativeArchitectures` 时产出的是全 ABI 通用包（abiFilters 过滤与 RN 插件的 defaultConfig 过滤是并集，限制不了本地构建）——单 ABI 包务必带参数，与 CI 同口径。

产物在 `android/app/build/outputs/apk/release/app-release.apk`——**交付前把它拷出仓库目录**（Gradle 清理时会把输出目录连外来文件一起删）。

## 产物变体

| 变体 | 构建方式 | 差异 |
|---|---|---|
| arm64 包（**CI 发版默认**，2026-10-11 起） | `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` | 只含 arm64-v8a，约 24MB（2026-10-16 起，体积优化批后实测）；现代安卓手机均可装 |
| 通用包（逃生口） | `VOLTCOACH_UNIVERSAL_APK=1 ./gradlew assembleRelease` | 含全部四套 ABI，约 52MB（2026-10-16 实测）；老 32 位 ARM 设备与 x86 模拟器等特殊场景用。2026-10-14 起 release 构建默认经补丁脚本强制 arm64（见下），通用包须显式用本环境变量跳过 |

release 的 arm64-only 由 `scripts/patch-release-signing.mjs` 在 prebuild 后注入（`ndk.abiFilters`），CI 的 `-PreactNativeArchitectures=arm64-v8a` 与其同口径双保险；debug 构建不受影响（模拟器 x86_64 冒烟可用）。⚠️ 注入的 `ndk.abiFilters` 与 RN 插件写进 defaultConfig 的 `reactNativeArchitectures` 过滤是**并集**语义，本地不带 `-P` 构建时仍是全 ABI（CI 不受影响）——单 ABI 包务必带 `-PreactNativeArchitectures` 参数。

## 体积口径（2026-10-16 优化批后）

R8 压缩（`enableMinifyInReleaseBuilds` + `enableShrinkResourcesInReleaseBuilds`）与 `.so` 压缩打包（`useLegacyPackaging`，写在模板的 `android.packagingOptions.jniLibs`——**全局，不分变体**：debug 包同样压缩存储 .so 且清单带 `android:extractNativeLibs="true"`，只影响安装形态，功能无影响）经 app.json 的 `expo-build-properties` 配置（prebuild 写入 gradle.properties，不丢）；`expo-image` 则从 package.json 卸载（全仓零引用）。实测 arm64 包 53.0MB → 24.1MB（−54.6%），通用包 52.2MB（实测；旧口径估算约 140MB）。`useLegacyPackaging` 的代价：安装阶段解压 `.so`（arm64 约 28MB 副本，设备总占用与改前基本持平）——省的是下载/传输体积，运行时/启动无可感知影响（冷启动实测无回归）。

R8 出问题时的兜底口分两类：**代码/反射裁剪**用 `expo-build-properties` 的 `extraProguardRules` 字段（追加进 `proguard-rules.pro`，带标记段自动去重重放，prebuild 不丢）；**资源误删**走 keep 列表（Expo 资源管线自动生成的 `res/raw/keep.xml` 的 `tools:keep`）或单独关掉 `enableShrinkResourcesInReleaseBuilds`。开启 R8 后 release/beta 的崩溃堆栈是混淆态，反混淆用 `android/app/build/outputs/mapping/<variant>/mapping.txt`（本地构建产物，CI 不归档——同 tag 重跑 CI 可复现同一 mapping）。

## 本地测试包（beta 变体，2026-10-14 起）

单机用户要在**正常使用正式版的同时**侧载测试预发版：`buildTypes.beta`（`scripts/patch-release-signing.mjs` 注入）提供独立包名 `net.wallygood.voltcoach.app.beta`（桌面名「VoltCoach β」，`src/beta/res` 覆盖 app_name），与正式版**并存共存**——签名冲突、versionCode、数据（训练库/AI Key 均独立沙箱）互不影响，debug 签名即可（独立包名无需正式证书）。

```bash
npx expo prebuild --platform android --no-install
node scripts/patch-release-signing.mjs
cd android && ./gradlew assembleBeta -PreactNativeArchitectures=arm64-v8a
```

产物 `android/app/build/outputs/apk/beta/app-beta.apk`（release 同款运行时：JS 内联、非 debuggable、minify 同 release）。**beta 的 versionCode 由补丁脚本按 package.json 版本推导**（major×100000 + minor×1000 + patch，如 0.4.2 → 4002；只作用于 beta 变体，正式包的 run-number 口径归 CI），因此提版后需重新 prebuild（默认 clean）+ 重跑脚本——脚本幂等跳过前会校验已烘焙值与当前版本一致，不一致报错退出。注意：beta 沙箱是全新的——AI Key 与同步账号需在 β 应用内单独配置；想用真实数据测试可从正式版导出 `.fitbackup` 再导入 β。模拟器冒烟用 x86_64：`VOLTCOACH_UNIVERSAL_APK=1 ./gradlew assembleBeta -PreactNativeArchitectures=x86_64`。
