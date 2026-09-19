# VoltCoach（骑行私教）

**VoltCoach**——数据驱动的骑行私教：纯本地的运动训练分析工具（骑行为主）。导入码表/手表导出的 `.fit` 文件，本地计算逐秒指标与训练负荷（NP/TSS/CTL/ATL/TSB、功率/心率分区、峰功率曲线），并支持自带 Key 的 AI 训练解读。无服务器、无账号，数据全部留在手机上。

由 Docker/Web 版 [fit-reader](../fit-reader)（旧仓库，另行维护）移植而来——fit-reader 是"读 FIT 文件"时代的名字，只描述了底层能力；本 App 的产品本质是**骑行私教**，故更名 VoltCoach（volt 荧光黄品牌色 × 功率/电能隐喻 × Coach 点明品类）。技术栈 React Native + Expo + TypeScript，UI 按 Material 3 暗色规范重构。

> **状态**：M0 已完成（骨架 + 4 项风险前置 PoC 全过），M1 未开始。进度看板见 [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) 文首「开发进度看板」。

## 本地开发

```bash
npm install
npx expo start            # Metro 开发服务，用 Expo Go 或 dev client 连接
npx expo start --android  # 直接拉起安卓模拟器/已连接设备
```

要求：Node.js LTS、Android Studio（模拟器）或开启 USB 调试的安卓真机。本机构建注意事项（JDK 17、镜像、模拟器网络等）见 [AGENTS.md](./AGENTS.md)。

## 目录导览

- `app/` — Expo Router 页面路由（底部四 tab：首页/训练/AI/我的）
- `src/` — 业务代码（i18n 词典已就位；算法层 M1 起从旧版移植）
- `reference/` — 旧 Docker/Web 版实现的只读快照（移植对照用，全部里程碑完成后移除）
- `docs/sample-fit-files/` — 本地测试用真实 FIT 素材（不入库）
- `MIGRATION_PLAN.md` — 移植路线图、进度看板与技术决策记录

## 相关文档

- [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) — 移植计划（进度看板、技术选型、里程碑 M0–M5、决策记录）
- [AGENTS.md](./AGENTS.md) — 项目结构与开发约定（供 AI 编码代理与人阅读）
