# VoltCoach（骑行私教）

**VoltCoach**——数据驱动的骑行私教：纯本地的运动训练分析工具（骑行为主）。导入码表/手表导出的 `.fit` 文件，本地计算逐秒指标与训练负荷（NP/TSS/CTL/ATL/TSB、功率/心率分区、峰功率曲线），并支持自带 Key 的 AI 训练解读。无服务器、无账号，数据全部留在手机上。

由 Docker/Web 版 [fit-reader](../fit-reader)（旧仓库，另行维护）移植而来——fit-reader 是"读 FIT 文件"时代的名字，只描述了底层能力；本 App 的产品本质是**骑行私教**，故更名 VoltCoach（volt 荧光黄品牌色 × 功率/电能隐喻 × Coach 点明品类）。技术栈 React Native + Expo + TypeScript，UI 按 Material 3 暗色规范重构。

> **状态**：M0–M5 已完成（2026-10-04）：解析管线 / 训练库 / 仪表盘 / AI 教练 / 备份迁移 / 顽鹿同步全部落地，tag 即发版。进度看板见 [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) 文首「开发进度看板」。

## 本地开发

```bash
npm install
npx expo start            # Metro 开发服务，用 Expo Go 或 dev client 连接
npx expo start --android  # 直接拉起安卓模拟器/已连接设备
```

要求：Node.js LTS、Android Studio（模拟器）或开启 USB 调试的安卓真机。本机构建注意事项（JDK 17、镜像、模拟器网络等）见 [AGENTS.md](./AGENTS.md)。

## 发版（Release APK）

发版走 [GitHub Actions](./.github/workflows/release.yml)：**打 tag 即自动打包并挂到 GitHub Release**，无需本地打包。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

流水线门禁：`lint` + 单测 + 黄金 diff（真实测试素材不入库，CI 上自动跳过该门禁）→ `expo prebuild` → 签名 → `assembleRelease` → `npm run check:apk`（bundle 端点体检，防联调地址混入发版包）→ 上传 Release。也可在 Actions 页手动触发（workflow_dispatch）做打包演练，产物只进 artifact 不发布。

**正式签名（可选但建议）**：不配置时产物使用 debug 签名（可直接侧载，但不能覆盖安装正式签名包）。配置方法——生成一次 keystore 后，在仓库 Settings → Secrets → Actions 配置四个变量：

```bash
keytool -genkeypair -v -keystore voltcoach.keystore -alias voltcoach \
  -keyalg RSA -keysize 2048 -validity 10000
# macOS/Linux/Git Bash（GitHub Secrets 填 base64 输出；keystore 本体与口令切勿提交入库）
base64 -w0 voltcoach.keystore
# Windows PowerShell 改用：certutil -encode voltcoach.keystore keystore-b64.txt
```

- `ANDROID_KEYSTORE_B64`：keystore 的 base64 内容
- `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD`：口令与别名

所有版本使用同一 keystore，保证覆盖安装不冲突。

## 顽鹿云同步说明

「顽鹿同步」通过社区逆向的非官方接口拉取**你自己账号**的运动记录（登录 / 列表 / 下载 FIT 三组动作），实现码表 → 顽鹿 → 本 App 的全自动数据流。本项目与顽鹿/迈金无任何关联；该接口随时可能变更失效（失效时退回手动导入或分享导入，训练数据不受影响）。请仅用于个人数据导出，登录凭据只存手机本机（Android Keystore），不随备份包迁移。

## 目录导览

- `app/` — Expo Router 页面路由（底部四 tab：首页/训练/AI/我的）
- `src/` — 业务代码（i18n 词典已就位；算法层 M1 起从旧版移植）
- `reference/` — 旧 Docker/Web 版实现的只读快照（移植对照用，全部里程碑完成后移除）
- `docs/sample-fit-files/` — 本地测试用真实 FIT 素材（不入库）
- `MIGRATION_PLAN.md` — 移植路线图、进度看板与技术决策记录

## 相关文档

- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) — 移植计划（进度看板、技术选型、里程碑 M0–M5、决策记录）
- [AGENTS.md](./AGENTS.md) — 项目结构与开发约定（供 AI 编码代理与人阅读）
