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
| 2 | 本地门禁 | `npm run lint && npm test && npm run test:coverage && npm run golden` | 全绿才继续；golden 需本地真实素材（见 [MAINTENANCE](./MAINTENANCE.md)） |
| 3 | 确认版本 | `node scripts/version.mjs check` | version 应已是本次想发的值（合并 PR 时已 bump） |
| 4 | 打 tag | `git tag v1.2.3 && git push origin v1.2.3` | tag == package.json version，否则流水线「版本戳」步骤失败 |
| 5 | 等 CI 门禁 | Actions 页观察 `Release APK` | lint+单测+黄金 diff（CI 无素材自动跳过 golden） |
| 6 | 自动打包 | prebuild → 签名 → `assembleRelease` → `check:apk` | NDK 版本随 Expo SDK 固定（workflow 内注明） |
| 7 | 产物体检 | `check:apk` 解包断言 | 见下文「发版包体检」；失败即中止发布 |
| 8 | Release 发布 | 自动挂 GitHub Release，附 APK 与自动 release notes | debug 签名回退时 Release 正文自曝（见下） |
| 9 | 验活 | 下载 APK 真机安装冒烟；确认版本号/签名 | 覆盖安装验证签名一致性 |
| 10 | 收尾 | 如发版后发现阻塞缺陷，修复走正常 PR + 新 tag | 已发布 tag 与产物不重传、不覆盖 |

演练不发版：Actions 页手动触发（workflow_dispatch）只构建并上传 artifact，不创建 Release。

## 签名配置（Secrets）

不配置时产物使用 **debug 签名**（可直接侧载体验，但不能覆盖安装正式签名包），且 Release 正文会自动注明；配置后为正式签名。**四个 Secrets 必须要么全配、要么全不配——半配直接失败**（防把 debug 包当正式版发出去）。

生成一次 keystore 并配置（keystore 本体与口令**绝不入库**，已被 `.gitignore` 排除）：

```bash
keytool -genkeypair -v -keystore voltcoach.keystore -alias voltcoach \
  -keyalg RSA -keysize 2048 -validity 10000
# base64 内容（GitHub Secrets 填这个）
base64 -w0 voltcoach.keystore          # macOS/Linux/Git Bash
certutil -encode voltcoach.keystore keystore-b64.txt   # Windows（输出含 PEM 头尾行，流水线已兼容）
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

- **不含**联调残留：`10.0.2.2`、`:8791`、`127.0.0.1`、`10./192.168./172.` 私网地址；
- **必须含** `onelap.cn`（顽鹿同步生产端点）——反向验证 bundle 是生产配置。

背景：`EXPO_PUBLIC_*` 环境变量是打包期内联的，而改环境变量**不会**失效 Metro/Gradle 的 bundle 缓存——曾出现「联调包被当生产包发出」的真实事故，此闸门是防复发手段。

## EXPO_PUBLIC_* 与 bundle 缓存陷阱

用 `EXPO_PUBLIC_ONELAP_BASE` 等变量做过联调构建后，再打生产包**必须清产物缓存**，否则 Gradle 可能复用上次的产物（包里带着联调地址）：

```bash
rm -rf android/app/build/generated/assets/react/release \
       android/app/build/intermediates/assets/release/mergeReleaseAssets/index.android.bundle \
       "$TEMP/metro-cache"
cd android && ./gradlew assembleRelease
```

生产构建不要带任何 `EXPO_PUBLIC_*` 联调变量（不设即用真实端点）。构建后跑 `npm run check:apk` 体检。

## 本地打包（不用 CI 时）

```bash
npx expo prebuild --platform android --no-install
# 以下两步是 prebuild 后的本机惯例（CI 不需要）：
#   1. android/local.properties 手写 sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk（必须正斜杠）
#   2. 国内网络在 android/build.gradle 的 buildscript/allprojects repositories 里
#      google()/mavenCentral() 之前补阿里云三镜像（maven.aliyun.com 的 google/public/gradle-plugin）
node scripts/patch-release-signing.mjs   # env 驱动注入签名；未设 VOLTCOACH_KEYSTORE_* 时回退 debug 签名
cd android && ./gradlew assembleRelease
cd .. && npm run check:apk
```

产物在 `android/app/build/outputs/apk/release/app-release.apk`——**交付前把它拷出仓库目录**（Gradle 清理时会把输出目录连外来文件一起删）。

## 产物变体

| 变体 | 构建方式 | 差异 |
|---|---|---|
| 通用包（默认发版） | `./gradlew assembleRelease` | 含全部四套 ABI（arm64-v8a / armeabi-v7a / x86 / x86_64），体积大但任意设备可装 |
| arm64 精简包 | `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` | 只含 arm64-v8a，体积小；2018 年后的主流手机与全部模拟器均可用 |

两变体除 ABI 集合外无任何差异；日常自用建议 arm64 包，对外发布默认通用包。
