# VoltCoach（骑行私教）

**VoltCoach**——数据驱动的骑行私教：纯本地的运动训练分析工具（骑行为主）。导入码表/手表导出的 `.fit` 文件，本地计算逐秒指标与训练负荷（NP/TSS/CTL/ATL/TSB、功率/心率分区、峰功率曲线），并支持自带 Key 的 AI 训练解读。无服务器、无账号，数据全部留在手机上。

**VoltCoach** 是主仓库：本项目自「读 FIT 文件」的 Web 工具起步，产品本质是**数据驱动的骑行私教**，故更名 VoltCoach（volt 荧光黄品牌色 × 功率/电能隐喻 × Coach 点明品类）。原 Docker/Web 版以 **voltcoach-for-docker**（GitHub: Sicheng886/voltcoach-for-docker，原名 fit-reader）继续维护，可视为本 App 的 Docker 桌面版——两者共享同一套指标口径与提示词，功能演进以本 App 为主。

**功能特性**

- **训练导入**：码表/手表 `.fit` 文件（文件导入或系统分享面板接收），逐秒数据本地落盘；同趟骑行异名文件按内容指纹自动去重
- **指标体系**：NP/IF/TSS/VI、Coggan 功率 7 区与心率 5 区、峰功率曲线、心率漂移、爬坡段/间歇识别、FTP 自动估算与历史估算（口径详见 [docs/METRICS.md](./docs/METRICS.md)）
- **长期负荷**：CTL/ATL/TSB 体系、月度汇总与强度分布、未来负荷推演与课表生成
- **AI 教练**（BYOK）：自带 OpenAI 兼容 Key（DeepSeek/Kimi/GLM/OpenAI 预设或自定义端点），训练复盘/规划/减量/对比报告与自由对话，agentic 工具本地查数，训练科学知识库注入
- **数据自主**：SQLCipher 加密训练库、`.fitbackup` 全量备份/迁移（格式见 [docs/BACKUP_FORMAT.md](./docs/BACKUP_FORMAT.md)）、顽鹿云自动同步（见下）
- **双语界面**：中文/English

> **状态**：可用（Android）；iOS 未冒烟验证。<!-- TODO: 补真机截图 -->

## 下载安装

从 [GitHub Releases](../../releases) 下载 APK 安装。正式发版为 release 签名；早期产物可能有 debug 签名版本（Release 正文会注明，不能覆盖安装正式签名包）。Android 版本要求与 ABI 说明见产物页。

## 权限说明

| 权限 | 用途 |
|---|---|
| `INTERNET` | 连接你自配的 AI 端点（BYOK）与顽鹿云同步；无任何自建服务器 |
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` | AI 生成期间的**后台保活前台服务**（仅生成期间存在，结束即停）——退后台/锁屏不断流 |
| `WAKE_LOCK` | 生成期间保持 CPU 唤醒，防止熄屏后 SSE 流断续（15 分钟硬上限） |
| `POST_NOTIFICATIONS` | 显示「AI 生成进行中」常驻通知；**拒绝不影响后台保活**，只是看不到通知 |
| `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` | 可选的电池优化白名单（设置页手动申请），深度省电场景的兜底 |

> **小米/澎湃 OS 提示**：HyperOS 2.0 会把常驻通知自动收纳进通知栏的「更多」折叠区——生成期间看不到那条通知属正常现象，后台保活不受影响（可在设置里查看保活状态）。

## 本地开发

```bash
npm install
npx expo start --android  # Metro 开发服务 + 模拟器/真机
```

要求 Node.js ≥24、JDK 17、Android SDK；测试/门禁/提版号/PR 流程见 [CONTRIBUTING.md](./CONTRIBUTING.md)，构建已知坑与架构说明见 [docs/MAINTENANCE.md](./docs/MAINTENANCE.md)。

## 发版（Release APK）

打 tag 即自动打包并挂到 GitHub Release（`git tag v0.2.0 && git push origin v0.2.0`）。签名 Secrets 配置、发版 checklist、发版包体检与本地打包见 **[docs/RELEASING.md](./docs/RELEASING.md)**。

## 顽鹿云同步说明

「顽鹿同步」通过社区逆向的非官方接口拉取**你自己账号**的运动记录（登录 / 列表 / 下载 FIT 三组动作），实现码表 → 顽鹿 → 本 App 的全自动数据流。本项目与顽鹿/迈金无任何关联；该接口随时可能变更失效（失效时退回手动导入或分享导入，训练数据不受影响）。请仅用于个人数据导出，登录凭据只存手机本机（Android Keystore），不随备份包迁移。如官方对该能力有异议，请通过仓库 Issues 联系，会及时处理（调整或移除同步模块）。

## 文档地图

| 文档 | 内容 | 地位 |
|---|---|---|
| [CONTRIBUTING.md](./CONTRIBUTING.md) | 贡献流程：环境、分支/PR、版本纪律、门禁 | 贡献流程权威 |
| [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) | 架构分层、测试体系、行为口径、构建已知坑 | 维护入口 |
| [docs/METRICS.md](./docs/METRICS.md) | 指标算法口径（NP/TSS/分区/峰功率…） | 公开描述（实现权威在 `src/core`） |
| [docs/BACKUP_FORMAT.md](./docs/BACKUP_FORMAT.md) | `.fitbackup` 备份包格式规范 | 互操作规范（实现权威在 `src/backup`） |
| [docs/RELEASING.md](./docs/RELEASING.md) | 发版 SOP、签名配置、包体检 | 发版流程权威 |
| [SECURITY.md](./SECURITY.md) | 漏洞报告渠道与安全边界 | 安全策略权威 |
| [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) | 随源码移植的第三方组件声明 | 许可证合规 |

## 目录导览

- `app/` — Expo Router 页面路由（底部四 tab：首页/记录/对话/我的）
- `src/` — 业务代码（`core/` 纯函数算法层；`prompts/skills/` AI 技能知识库源文件）
- `modules/` — 本地 Expo 原生模块（`generation-keepalive/`：AI 生成后台保活前台服务，android-only）
- `plugins/` — 本地 config plugin（prebuild 时注入 manifest 声明）
- `scripts/` — 守卫与工具脚本（除 fflate 外仅用 Node 内置库）
- `test/` — node:test 单元测试（含合成 FIT 二进制生成器）
- `docs/` — 公开文档体系（见上方文档地图）
- `assets/brand/` — 品牌 mark（App 图标由 `npm run icons` 从 logo.svg 生成）

## 许可证（License）

本项目以 [MIT](./LICENSE) 许可证开源。

第三方声明：`src/sync/onelap.ts` 顽鹿云同步模块移植自 [OnelapSyncStrava](https://github.com/kermit-r-wood/OnelapSyncStrava)（MIT，Copyright (c) 2026 kermit-r-wood）——依其许可证要求在此保留上述版权声明；其余依赖由 npm 管理，各自的许可证见对应包内声明。
