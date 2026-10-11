# 贡献指南（CONTRIBUTING）

> **文档地位**：本文是贡献流程的权威说明——环境搭建、分支与 PR 流程、版本纪律、提交格式、门禁清单。工程细节见 [docs/MAINTENANCE.md](./docs/MAINTENANCE.md)。

## 环境搭建

要求：**Node.js ≥24**（单测直接跑 TypeScript 需要 Node ≥23.6 的原生 type stripping）、JDK 17、Android Studio / Android SDK（模拟器或真机调试）。

```bash
npm install
npx expo start            # Metro 开发服务，Expo Go 或 dev client 连接
npx expo start --android  # 直接拉起安卓模拟器/已连接设备
```

常用命令：

| 命令 | 用途 |
|---|---|
| `npm run lint` | ESLint（门槛 0 error **且 0 warning**） |
| `npm test` | 单元测试（node:test，纯函数层，无需模拟器） |
| `npm run test:coverage` | 单测 + 覆盖率报告（纯函数层行覆盖 ≥90% 为口径） |
| `npm run golden` | 黄金 diff（需本地自备素材，见下） |
| `node scripts/version.mjs bump` | 提版号（patch，可选 minor/major） |

## 分支与 PR 流程

main 分支受保护：**所有修改在分支上完成，提交 PR，CI（`gate` check）全绿后合并**——包括维护者本人（单人开发可将 required approvals 设为 0 自合，但 CI 必须绿）。保护规则建议同时勾选 **Require branches to be up to date before merging**：否则两个并行 PR 可能各自通过「版本领先」校验、却合出相同的版本号。

```bash
git checkout -b feat/xxx main    # 或 fix/xxx、docs/xxx
# …开发、提交…
node scripts/version.mjs bump    # ← 合并前最后一步：提版号
git add package.json app.json && git commit -m "chore: 提版号至 0.2.0"
git push -u origin feat/xxx      # 开 PR
```

**提版号是合并前最后一步的固定动作**：CI 对每个 PR 断言「PR 的版本 > main 的版本」，忘提必红。修复类升 PATCH、新功能升 MINOR、破坏性改动升 MAJOR（`node scripts/version.mjs bump minor`）。

## 提交格式

中文提交信息，一行标题：**`<范围>: <做了什么>——<为什么/关键细节>`**。

- 范围用模块名（`core` / `db` / `ui` / `build` / `docs` / `ci`）或动作词（`整理` / `重构`）；
- 同一逻辑单元的代码与其测试放同一提交；
- 纯重构（不改行为）单独提交并在标题标注 `重构`。

## 门禁清单（合并前自查）

1. `npm run lint` 0 error 且 0 warning；
2. `npm test` 全绿；
3. `npm run test:coverage` 纯函数层行覆盖 ≥90%（新增分支必须补断言）；
4. 涉及解析/指标代码时 `npm run golden` 全绿；
5. 新增用户可见文案已补 zh/en 双语 key；
6. PR 已提版号（CI 会校验）。

## 黄金 diff 的本地素材

真实码表 FIT 文件属个人健康数据，**不入库**。本地自备：`.fit` 文件放 `docs-private/sample-fit-files/`（gitignored 内部目录），summary 基准放 `golden/`（目录均可被忽略规则覆盖，基准路径可用 `GOLDEN_DIR` 环境变量改）。CI 上无素材会自动跳过该门禁，因此**涉及解析/指标的 PR 请在本地跑一次 golden 并在 PR 描述里注明结果**。

## 代码约定速览

- 注释与文档用简体中文，说明口径（公式、单位、rounding）；
- 算法与平台解耦：分析类逻辑写进 `src/core` 纯函数 + 单测，不 import RN/Expo；
- 算法阈值集中 `src/core/settings.ts`，文案走 `src/i18n` 双语词典；
- FIT 文件视为不可信输入，容错解析；
- 更多架构与行为口径见 [docs/MAINTENANCE.md](./docs/MAINTENANCE.md)。

## 报告问题

- 缺陷请附：设备/系统版本、App 版本、复现步骤、logcat 片段（**勿附真实训练数据**）；
- FIT 解析类问题可附脱敏后的最小复现文件或 `test/make_test_fit.mjs` 造数描述；
- 行为口径疑问先查 [docs/](./docs/) 四份文档，确认文档与实现不符属 bug。
