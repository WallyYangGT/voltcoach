# 维护指南（MAINTENANCE）

> **文档地位**：本文是面向维护者/贡献者的**公开维护入口**——架构分层、测试体系、数据行为口径与构建已知坑都收敛于此。配套文档：[METRICS](./METRICS.md)（指标算法口径）、[BACKUP_FORMAT](./BACKUP_FORMAT.md)（备份包格式）、[RELEASING](./RELEASING.md)（发版 SOP）、[CONTRIBUTING](../CONTRIBUTING.md)（贡献流程）。冲突时以代码为准。

## 架构总览

技术栈：React Native + Expo（新架构）+ Expo Router + TypeScript；UI 用 React Native Paper 5（Material 3）自定义暗色主题（品牌色 volt 荧光黄 `#d7ff3f`，深色底 `#0a0d11` 系，等宽大数字排版）。**纯本地应用**：无自建服务器，训练库 SQLCipher 加密，AI Key 与同步凭据存 `expo-secure-store`（Android Keystore）。

```
app/                    Expo Router 文件路由（底部四 tab + 详情/会话/数据管理/导入等页面）
src/
  core/                 ★ 纯函数算法层：解析、指标、FTP、规划、去重、报告标题——
                        不 import 任何 RN/Expo 模块，node:test 直接覆盖
  db/                   训练库（expo-sqlite + SQLCipher；开库后第一条语句必须是 PRAGMA key）
  records-store.ts      逐秒数据 gzip 文件落盘/读取（不进 SQLite，与库行一一对应）
  services/             编排层：导入管线（解析→查重→入库→落盘→快照）、顽鹿同步编排
  ai/                   BYOK AI 客户端（OpenAI 兼容、SSE 流式、agentic 工具循环）+ 服务商预设
  prompts/              AI 提示词模板 + 技能知识库（skills/*.md 构建期内嵌为 skills.ts）
  tools/                agentic 只读查询与纯计算工具（function calling）
  sync/                 顽鹿云同步客户端（纯函数 + 环境注入，不 import RN，可 node:test 直测）
  backup/               .fitbackup 备份层（manifest/archive 纯函数 + 设备侧导入导出）
  charts/               react-native-svg 自绘图表（计算层复用 core 逻辑，渲染点数抽稀）
  components/           共用 UI 组件
  i18n/                 前端双语词典（zh 默认 / en）
scripts/                守卫与工具脚本（除 fflate——备份层同用的 zip 库——外仅用 Node 内置库）
test/                   node:test 纯函数测试（含合成 FIT 二进制生成器 make_test_fit.mjs）
docs/                   本公开文档体系
assets/brand/           品牌 mark（logo.svg，App 图标由 scripts/make-app-icons.mjs 从它生成）
```

分层纪律：**算法与平台解耦**——`src/core`、`src/sync`、`src/backup` 的 manifest/archive、`src/prompts` 全部是零平台依赖的纯函数，平台能力（文件系统、SQLite、SecureStore）在 services/db 层注入。这保证核心逻辑可以在 Node 里全量测试（`npm test` 不需要模拟器）。新的分析类功能优先写成 core 纯函数 + 单测，再接 UI。

## 关键行为口径

- **训练唯一业务键**是 `activities.file_name`（详情页路由 id 也用它）；**去重判据是内容指纹**（同一 UTC 日期 + 时长 ±2s + 距离 ±0.05km，任一侧距离为空不判重）。异名同指纹导入跳过（计 duplicates）；**同名仍 upsert 覆盖**。
- **删除训练**只删活动行 + 逐秒数据，**已生成的 AI 报告/对话保留**（松散 `file_name` 引用成为孤儿，报告标题降级显示「训练已删除」）。删除一律二次确认，且**删除后不滚本地快照**（保留误删前的快照才有可恢复性）；相反，**导入成功后滚动快照**。
- **AI 报告标题在渲染侧拼、不落库**（落库会把标题冻结在生成时的语言）；数据源 = 活动行 + records 首帧时间戳 + created_at，带多级降级模板。改动训练数据的三处入口（导入/删除/合并）都必须清标题缓存。
- **顽鹿同步行为口径**：只回溯**最近 90 天**（`SYNC_WINDOW_DAYS`；水位线 = 上次成功同步前移 24h 缓冲、与 90 天窗口取较晚者，列表遇早于窗口起点的记录即停止翻页）；活动之间 300–800ms 随机间隔摊平请求突发（控制对非官方接口的请求强度）；令牌缓存复用到 401 自动重登一次（token 与 AI Key 同级存 `expo-secure-store`、不随备份包迁移）；「测试连接」只探测登录域与数据域可达性（任何 HTTP 状态码都算链路通）；同步侧下载前按文件名预检省流量，入库前再按内容指纹判重（与手动导入同一入库管线）。
- **AI 生成可靠性口径**：传输级失败（空/破损正文、正文读取中断、连接失败、429/5xx）自动重试一次（共用总超时预算、已吐字的流不重试、请求侧 400 不重试）；**无 tools 的请求重试时改走流式**（非流式长请求零字节流动，最易被网关空闲超时掐断）；生成中进程被杀不做前台服务保活，回前台/冷启动自动续跑 30 分钟内的 pending 残留；重试/重新生成按钮状态一律由 db status + 进程内注册表派生，不依赖组件局部 state。
- **记录型数据缺失统一 `null`**，不用 0 或空串充数；时间戳落库一律 UTC。
- AI 提示词语言：zh/en 双语模板，数据（用户自填内容）原样透传不翻译。

## 测试体系

| 层 | 工具 | 范围 | 时机 |
|---|---|---|---|
| L0 静态检查 | ESLint 9（`eslint-config-expo` + react-hooks） | 全部 JS/TS，**0 error 且 0 warning** | 每次提交 |
| L1 单元测试 | Node 内置 `node:test`（原生跑 TS，需 Node ≥23.6） | `src/core` 等全部纯函数层 + 合成 FIT 端到端 | 每次提交 |
| L2 黄金 diff | `npm run golden` | 真实 FIT 的 summary 与既定基准逐字段比对，**防解析管线走样** | 算法口径变更后必跑 |
| L3 冒烟 | 模拟器/真机 | 渲染与交互、logcat 无报错 | 触碰 UI/数据路径时 |
| L4 UI 测试 | （未引入） | 组件与交互 | 后置 |

- **黄金 diff**：基准与真实素材都是个人健康数据、**不入库**（`.gitignore`：素材放 `docs/sample-fit-files/`，基准目录默认 `golden/`，可用 `GOLDEN_DIR` 环境变量覆盖）。CI 上缺失时自动跳过该门禁；本机缺失则硬失败。基准 json 可用旧版 Docker/Web 版 fit-reader 的 summary 输出生成。
- **覆盖率口径**：`src/core` 等纯函数层行覆盖 ≥90% 是提交口径（`npm run test:coverage` 查看），刻意不进 CI 硬闸——避免为凑数字写无意义测试；新增分支必须同步补断言。
- **合成 FIT**：`test/make_test_fit.mjs` 手写 FIT 二进制生成器（可造骑行/跑步/游泳、功率缺失、暂停等场景），端到端测试不依赖真实数据。
- 测试纪律：纯函数层**不得 import 任何 RN/Expo 模块**（node:test 直测的前提）；相对导入带 `.ts` 扩展名。
- **数据路径改动的固定回归项**：涉及备份/导入/records 落盘的改动，冒烟必须包含「导入成功 → 杀进程重启 → 数据仍在」。

## 构建已知坑（踩过的坑清单）

1. **Java toolchain 17**：RN gradle 插件要求 JDK 17；用 `~/.gradle/gradle.properties` 的 `org.gradle.java.installations.paths` 注册本机 JDK，删掉它会触发 Gradle 自动下载（极慢）。
2. **`android/local.properties` 每次 prebuild 后需手写**：`sdk.dir=C:/Users/<you>/AppData/Local/Android/Sdk`——**必须正斜杠**（properties 的反斜杠转义会吞分隔符，报错堆栈只指向 SdkLocator，极难定位）。`android/`、`ios/` 是 prebuild 生成物，不入库。
3. **国内网络镜像**：prebuild 重新生成 `android/build.gradle` 后要在 google()/mavenCentral() 前补阿里云三镜像（CI 海外网络无需）。
4. **SQLCipher**：app.json 插件 `useSQLCipher: true`；Expo Go 里不可用，必须 dev client / release 构建。运行时开库后第一条语句必须是 `PRAGMA key`（`src/db/index.ts` 已处理）。
5. **明文 HTTP**：`android.usesCleartextTraffic: true` 有意保留——BYOK 场景允许用户自配 `http://` 局域网 AI 端点；发版包体检（check:apk）会确保 bundle 不含联调地址。
6. **模拟器网络**：访问宿主机服务用 `http://10.0.2.2:<port>`（adb reverse 在 Windows 上会假死）。Git Bash 下 adb push 远端路径要写 `//sdcard/...` 防 MSYS 路径转换。
7. **模拟器图形**：部分 AVD 需 `-gpu swiftshader_indirect` 启动（默认 gfxstream 会崩）。
8. **EBUSY 目录锁**：prebuild/gradlew 清目录报 EBUSY = 有进程占着（资源管理器停在输出目录、终端 cwd 在其中）；Gradle daemon 残留句柄用 `./gradlew --stop` 释放。
9. **release 包不可 inspect 私有目录**：非 debuggable 构建下 `adb shell run-as` 不可用，验证 db 内容要走 UI 路径或临时 debuggable 变体。
10. **AOSP 镜像缺 zip 分享目标**：GSI 的 DocumentsUI 未注册 ACTION_SEND(application/zip)，系统分享面板没有「保存到文件」；真机通常正常。文档导入（DocumentPicker）不受影响。
11. **EXPO_PUBLIC_* 打包期内联且不失效 bundle 缓存**：换环境变量后必须清 bundle 缓存再构建，发版必跑 `check:apk`——详见 [RELEASING](./RELEASING.md)。

## 依赖与安全口径

- **升级策略**：expo 系包一律跟 `npx expo install --check` 对齐 SDK 期望版本（是 Expo 测试过的组合，不盲目追 Latest）；非 expo 包在有兼容性评估后才升级。当前有意不升的大版本：`fit-file-parser` 3→6（解析 API 有变，types 手写适配 3.x 且黄金 diff 钉住输出口径，升级需专门回归一轮）、`@react-native-async-storage/async-storage` 2→3 与 `react-native-gesture-handler` 2→3（SDK 57 钉旧版）、`eslint` 9→10（基线 `eslint-config-expo` 兼容未验证）、`eslint-import-resolver-typescript` 3.x（刻意钉住，见 `eslint.config.js` 头注释）。
- **`react-native-keyboard-controller` 有意停在 1.22.5**（expo check 期望 1.21.9 是降级）——键盘避让方案建在该库上，降级需真机回归，无对应收益。
- **npm audit 残余的接受口径**（`npm audit fix` 后约 37 条，audit 不进 CI 硬闸）：
  - **构建工具链类**（metro/braces、@expo/cli/node-forge、@expo/config-plugins 链）——只在开发/CI 机器上运行，不进 APK，随 Expo SDK 升级自然消解；
  - **运行时类两条**：`linkify-it`/`sprintf-js`（`react-native-markdown-display` → `markdown-it`，上游无修复版）——输入是本地 AI 报告 markdown，无远程攻击面，最坏表现为渲染卡顿，接受；`decode-uri-component`（expo-router → query-string）——官方修复随 Expo SDK 58，本地 App 无公开 URL 攻击面，接受；
  - `npm audit fix --force` 的建议（如降级 react-native）一律不采纳。
- **凭据边界**：AI Key 与同步凭据只在 `expo-secure-store`；依赖不带任何密钥，npm 镜像用国内源（audit 用官方源跑，镜像不支持 audit 端点）。

## 开发约定

- 注释与文档用简体中文；函数级注释说明口径（公式、单位换算、rounding）。
- 算法阈值集中在 `src/core/settings.ts`，不在组件里硬编码；骑手参数等「会变的数据」走训练库 settings 表，不做文件型配置。
- 用户可见文案一律走 `src/i18n` 词典，**新增控件同时补 zh/en 两个 key**（zh 默认）。
- 图表用 react-native-svg 自绘；渲染点数超限走抽稀口径，不在 UI 层砍数据。
- FIT 文件视为不可信输入，解析容错运行；新的设备字段/异常场景先补合成 FIT 用例再改解析。
- 版本与提交纪律见 [CONTRIBUTING](../CONTRIBUTING.md)；发版见 [RELEASING](./RELEASING.md)。
