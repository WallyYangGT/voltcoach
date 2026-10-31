# 维护指南（MAINTENANCE）

> **文档地位**：本文是面向维护者/贡献者的**公开维护入口**——架构分层、测试体系、数据行为口径与构建已知坑都收敛于此。配套文档：[METRICS](./METRICS.md)（指标算法口径）、[BACKUP_FORMAT](./BACKUP_FORMAT.md)（备份包格式）、[RELEASING](./RELEASING.md)（发版 SOP）、[CONTRIBUTING](../CONTRIBUTING.md)（贡献流程）。冲突时以代码为准。

## 架构总览

技术栈：React Native + Expo（新架构）+ Expo Router + TypeScript；UI 用 React Native Paper 5（Material 3）自定义暗色主题（品牌色 volt 荧光黄 `#d7ff3f`，深色底 `#0a0d11` 系，等宽大数字排版）。**纯本地应用**：无自建服务器，训练库 SQLCipher 加密，AI Key 与同步凭据存 `expo-secure-store`（Android Keystore）。

```
app/                    Expo Router 文件路由（底部四 tab + 详情/计划/会话/数据管理/导入/关于等页面）
src/
  core/                 ★ 纯函数算法层：解析、指标、FTP、规划、去重、报告标题、
                        训练计划（结构化课表校验/周聚合/负荷推演）、骑手档案
                        （教练模式与时间预算校验/合并）、对话滚动摘要形状
                        （chat-summary）——
                        不 import 任何 RN/Expo 模块，node:test 直接覆盖
  db/                   训练库（expo-sqlite + SQLCipher；开库后第一条语句必须是 PRAGMA key）。
                        实现按业务域拆分：client.ts（连接生命周期/密钥/迁移接线）、
                        athlete（骑手参数与档案）、activities（训练记录与统计查询）、
                        prefs（语言/同步态/披露条锚）、aiconfig、reports、chats（含滚动
                        摘要）、memories、dossier、plans；index.ts 只做 re-export barrel
                        （'@/db' 是历史统一出口，域模块函数集合即仓储端口）。
                        域函数的 SQL 行为（滚动清理/事务/守卫/指纹）由 jest 侧真 SQL
                        假库（node:sqlite 适配）覆盖：test/db/*
  records-store.ts      逐秒数据 gzip 文件落盘/读取（不进 SQLite，与库行一一对应）
  services/             编排层：导入管线（解析→查重→入库→落盘→快照）、室内判重
                        起骑时刻补齐（dedupe.ts）、云同步编排
                        （sync.ts）+ 平台注册表（syncProviders.ts）+ Wahoo 授权流
                        （wahooAuth.ts）、AI 报告/对话生成任务（保活接入、
                        plan 报告的结构化计划提取落库、上下文预算与滚动摘要）
  ai/                   BYOK AI 客户端（OpenAI 兼容、SSE 流式、agentic 工具循环）+ 服务商预设
                        + agent 历史压缩（agent-history.ts）
  prompts/              AI 提示词模板 + 技能知识库（skills/*.md 构建期内嵌为 skills.ts）
                        + 上下文装配（context.ts 预算装配 / memory-rank.ts 记忆 top-k /
                        history.ts 对话窗口与 digest；纯函数、node:test 直测）
  tools/                agentic 数据查询、纯计算与低危写工具（function calling）
                        + 工具结果结构化降级（compact.ts，超 16k 恒返回合法 JSON）
  sync/                 云同步协议客户端（onelap / igpsport / wahoo + 平台无关 common.ts
                        + 状态形状 state.ts；纯函数 + 环境注入，不 import RN，可 node:test 直测）
  backup/               .fitbackup 备份层（manifest/archive 纯函数 + 设备侧导入导出）
  charts/               react-native-svg 自绘图表（计算层复用 core 逻辑，渲染点数抽稀）
  components/           共用 UI 组件（含 PlanTable 轻量表格、首页今日建议卡 TodayAdviceCard、
                        多平台云同步卡 SyncCard）
  i18n/                 前端双语词典（zh 默认 / en）
modules/                本地 Expo 原生模块（generation-keepalive：AI 生成保活前台服务
                        + 电池优化白名单 API，android-only，autolinking 自动接入）
plugins/                本地 config plugin（with-generation-keepalive.js：prebuild 时向
                        AndroidManifest 注入 service 声明；gradle 注入仍走 scripts/ 补丁）
scripts/                守卫与工具脚本（除 fflate——备份层同用的 zip 库——外仅用 Node 内置库）
test/                   两套并行：node:test 纯函数测试（*.test.mjs，含合成 FIT 二进制
                        生成器 make_test_fit.mjs）+ jest 组件/服务/db 测试
                        （*.test.ts(x)：components、services、db 真 SQL 假库）
docs/                   本公开文档体系
assets/brand/           品牌 mark（logo.svg，App 图标由 scripts/make-app-icons.mjs 从它生成）
```

分层纪律：**算法与平台解耦**——`src/core`、`src/sync`、`src/backup` 的 manifest/archive、`src/prompts` 全部是零平台依赖的纯函数，平台能力（文件系统、SQLite、SecureStore）在 services/db 层注入。这保证核心逻辑可以在 Node 里全量测试（`npm test` 不需要模拟器）。新的分析类功能优先写成 core 纯函数 + 单测，再接 UI。

## 关键行为口径

- **训练实体身份（schema v3，2026-10）**：对外的唯一身份是 `activities.uuid`（32 位小写 hex），详情页路由、逐秒 records 文件名、AI 报告/对话引用、列表 key 与 AI 工具句柄都用它；整数 `id` 仅作内部插入序。`file_name` 是来源元数据、**不再唯一**——同名不同骑行可以并存，不再静默覆盖。**去重判据是内容指纹**（两侧距离都 >0 时：同一 UTC 日期 + 时长 ±2s + 距离 ±0.05km；两侧都无有效距离（null/0，典型室内骑行）时：同一 UTC 日期 + 时长 ±2s + 起骑时刻 ±60s，sport 已知且不同不判，缺起骑时刻或一侧有距离一侧无则保守不判）。导入决策：指纹精确一致或同名同趟 → 更新；异名同趟 → 跳过（计 duplicates）；同名不同趟 → 插入新行。
- **删除训练**只删活动行 + 逐秒数据，**已生成的 AI 报告/对话保留**（外键 `ON DELETE SET NULL` 清 uuid，但活动内容指纹保留；报告标题降级显示「训练已删除」）。重新导入同一趟骑行后，编排层按精确指纹自动把孤儿报告/对比引用/追问重新挂到新活动。合并重复走单事务（用户数据接管 → 引用/指纹重挂 → 删副本）。删除一律二次确认，且**删除后不滚本地快照**（保留误删前的快照才有可恢复性）；相反，**导入成功后滚动快照**。
- **AI 报告标题在渲染侧拼、不落库**（落库会把标题冻结在生成时的语言）；数据源 = 活动行 + records 首帧时间戳 + created_at，带多级降级模板。改动训练数据的三处入口（导入/删除/合并）都必须清标题缓存。
- **个人训练档案（v2）**：`src/core/dossier` 以**最新骑行日为锚**聚合 90 天峰功率 PB/爬坡踏频画像/强度结构/8 周负荷四组基线（确定性计算，零 AI token），缓存于 settings 表 `dossier` 行（指纹 = 活动总数 + FTP，miss 自愈重建）；导入/删除/合并/FTP 变更/功率标记/重算各触发点 fire-and-forget 重建。档案段注入四场景报告与对话（空库整段省略）。
- **结构化训练计划（v2）**：周期规划（plan 场景）报告在正文末尾输出 ```plan-json 围栏块，生成完成后由编排层**提取 → create 档确定性校验 → 落库**（settings 表 `training_plan` 当前 + `training_plan_history` 历史双键，JSON 行带 shape 演进字段，**不动 SCHEMA_VERSION**；历史上限 10 版）。合理性阈值（质量课间隔 ≥48h 日粒度、每周休息日、每 3–4 周减量周）以 `PLAN_VALIDATION` 为代码单源（与技能库 05 周计划节奏口径一致）：**生成时只警告**（随版本存档展示），**会话调整时硬拒**——调整必须经 `update_training_plan` 整体重发并过 adjust 档校验，报告生成场景拒写计划（会话与报告的 source 都可能是 `'plan'`，以显式 chat 标记区分）。**业余模式**（档案 `coach_mode='amateur'`）另有三条软约束（周质量课 ≤2、周课次 ≤5、单课超 `session_max_min`）：**create/adjust/ops 三档都只提示不拦截**（用户可能真的没空），既有结构规则不放松。计划查询是通用工具 `get_training_plan`（任意场景按需调用），会话锚定 `ai_chats.mode='plan'`（不属任何活动、跨版本存活）；有效期判定/过期提示/周聚合/负荷推演全在 `src/core/training-plan` 确定性层，「今天」一律走 `localDay` 本地日历日（不新增 UTC 日口径）。
- **教练模式与时间预算（业余教练模式，2026-10）**：骑手档案除身份/目标外，存 `coach_mode`（未设置 / amateur 业余健康导向 / standard 系统训练）、`weekly_hours` 区间档（<3 / 3–5 / 5–8 / 8h+）、`available_days`（1=周一…7=周日，空=未设置/不限）、`session_max_min`（10–600）；全部在 settings 表 `profile` JSON 行，**不加列、不动 SCHEMA_VERSION**（随备份包整体迁移，旧行缺字段容错为空）。校验/合并单一来源是 `src/core/profile`（设置页与 AI 工具共用）；AI 经 `update_rider_profile` 写入（仅对话放行，须先复述并获用户确认，报告生成场景拒写），`get_athlete_profile` 回读。模式未设置时，plan 场景提示词无条件注入「未设置 + 首次生成计划先询问」，其他场景只写中性的「未设置」；业余口径的知识层在技能 `10-amateur-coach`（时间预算主导、健康成功定义、目标阶梯、活动日减量、单锚点分析），与水平校准（08）两维取交集。**业余模式首页健康瓦片**：`src/core/health-activity` 汇总近 7 天**本地日**活动，按 IF 分档（功率可信时 IF ≥0.9 高强度、0.55–0.9 中等、<0.55 轻松不计入；IF 缺失用 TSS+时长反推；FTP 未校准或该次被标记功率不可信时不采信 IF，race 计高强度、其余按中等；**FTP 已校准判据** = 有溯源戳或当前值非出厂默认（只改过体重/心率仍判未校准），披露分「无功率数据 / FTP 未校准」两态），WHO 高强度 1:2 折算，150 分钟目标/300 分钟额外收益线；仅在 `coach_mode='amateur'` 显示（standard/未设置不叠加健康口径，也不触发额外 records 读取）。
- **记忆分层（v2；失效清除 2026-10 起，schema v4）**：`ai_memories.scope`——`short` 短期记忆**过 14 天或新增 5 次活动先到即失效**（判定与清除阈值单一事实源在 `src/core/memory.ts`）；`long` 默认长期。**失效记忆不永久保留**：过期（短期）或被取代（`superseded_by`/`superseded_at` 落库）即退出注入集合，管理页灰标保留 **5 天宽限期**并显示「N 天后自动清除」倒计时（`MEMORY_PURGE_GRACE_DAYS`），满宽限期由 db 层 `purgeInvalidatedMemories` 物理删除——触发点：`saveMemory` 写入时顺带 + 冷启动/回前台调度（1h 节流静默壳）+ 记忆页打开时顺带；库满 100 条（`MEMORY_KEEP`）的条数兜底按「被取代最早」优先淘汰。报告生成完成后编排层强制跑一次记忆回顾轮（仅 `save_memory` 单工具的小 agent 循环，失败静默不影响报告），不依赖模型在生成中自觉补记。`category='strategy'`（与教练商定的训练策略）单独成「既定结论」权威段置顶注入，规则要求分析以其为前提、修订须显式声明。**注入前按相关度 top-k**（`src/prompts/memory-rank`：strategy 全收置顶 + 类别×场景亲和 + 短期/时效 + 与当前问题/报告尾部的关键词重叠；条数与字符双预算），不再全量注入最近 30 条。
- **功率可信度标记（v2）**：`activities.power_flagged`（详情页开关或 AI `set_power_flag` 工具，可逆）——被标记骑行从档案一切功率派生基线排除（峰功率/分区/爬坡/踏频风格/周 TSS），**心率漂移与时长仍采信**；`recalibrate_activity_power` 工具按系数（夹逼 0.5–1.5）缩放重算单骑全部功率派生指标并写回，逐秒原始数据不改写（重导原 FIT 可回退）。
- **云同步行为口径（多平台，2026-10 起）**：平台适配层在 `src/services/syncProviders.ts`（凭据存 SecureStore、会话缓存/失效自愈、端点探测），协议客户端在 `src/sync/`（`onelap` / `igpsport` / `wahoo` + 平台无关的 `common.ts`），编排层 `src/services/sync.ts` 只认注册表与 `SyncRunner` 动作（start/listSince/getFileRef/download，401/令牌失效自愈在各 runner 内部）。**同一时间只有一个生效平台**（settings 的 `sync` 行 `provider` 字段，单账户互斥）；状态按平台分槽（`providers{<id>: {last_sync_at, last_run_at, last_counts}}`），M4 的单平台扁平行由 `src/sync/state.ts` 的 `normalizeSyncState` 自动归一化到顽鹿槽位（老用户水位线不丢），切换平台再切回不重拉历史。
  共用口径：只回溯**最近 90 天**（`SYNC_WINDOW_DAYS`；窗口起点 = 水位线前移 24h 缓冲、与 90 天窗口取较晚者）；**水位线只在拉到非空窗口时推进**——空窗轮（云端列表为 0 条）冻结、失败轮保位，展示用「上次实际跑过」另存 `last_run_at`（2026-10 顽鹿增量失效事故的防御：列表异常回空时推进水位线会把缺口永久藏住，症状即「同步时间在走、永远 0 新增 0 跳过」）；**列表形状异常（缺字段/方向翻转/截断/新侧丢弃条目）一律显式失败**（UI 报错、水位线冻结不动，服务端恢复后自动补回），绝不静默当空列表；活动之间 300–800ms 随机间隔摊平请求突发；令牌缓存复用到 401 自动重登一次（token 与 AI Key 同级存 `expo-secure-store`、不随备份包迁移）；「测试连接」只探测该平台端点可达性（任何 HTTP 状态码都算链路通）；下载前按文件名预检省流量，入库前再按内容指纹判重（与手动导入同一入库管线，**跨平台换绑天然不产生重复导入**）；**同步期间复用 AI 生成的 dataSync 前台服务保活壳**（引用计数，与 AI 生成并发时共用一次启动/一条通知，未绑定凭据的 fast-fail 不闪通知）。
  平台差异：**顽鹿**（`file_name` 取云端 fileKey 名）云端无文件抛 `no_file` 计失败并锚定水位线重试；**迹驰 iGPSPORT**（国内 `prod.zh` / 国际 `prod.en` 两个独立账号体系，各占一个平台项）带 `beginTime/endTime` 按日过滤、`queryActivityDetail.fitUrl` 失败回退 `getDownloadUrl`、OSS 直链裸 GET、下载校验 `.FIT` 魔数；**Wahoo**（官方通道，BYOK Client ID + OAuth2 PKCE）令牌 2 小时有效且**单次轮换**（到期前 5 分钟刷新并立即写回 Keystore，`code_verifier` 一并持久化供刷新复用），列表滤掉未来计划训练省沙盒配额，手动录入/第三方来源的 summary 403 计跳过、「文件名用云端活动 id」（官方直链名是训练名、重名会漏活动），解绑调 `DELETE /v1/permissions` 撤销授权。
  错误分类对用户处置有语义：`auth`（账号密码/会话被拒 → 核对凭据）、`reauth`（OAuth 授权失效 → 重新授权）、`no_file`（云端无原始文件，可重试）与 `getFileRef` 返回 `null`（该活动根本没有文件，计跳过）。
- **AI 生成可靠性口径**：**生成请求一律走流式**（2026-10 起——增量落库与取消的前置；服务端无视 `stream` 回整段 JSON 时按非流式解析兜底；`tool_calls` 增量帧按 index 聚合；流式收尾校验终止标记，缺失即判截断失败——防止被中间层掐断的正文静默落成完成态）。传输级失败（空/破损正文、正文读取中断、连接失败、429/5xx）自动重试一次（共用总超时预算、已吐字的流不重试、请求侧 400 不重试）；流式被端点拒绝时有降级梯子（agent 循环：非流式保工具→弃工具；单轮：非流式重试一次）。**生成中可实时取消**（报告/对话/追问/计划会话的生成界面均有取消入口；`cancelled` 终态保留已生成的部分正文，不自动复活，重试按钮原行重跑），正文增量节流回写（约 2 秒一次）使生成过程实时可见；**生成过程状态可视化**（2026-10）：每轮模型请求前切「模型思考中」，推理模型（SSE `delta.reasoning_content` / `reasoning` 字符串）的思考正文单行半透明滚动展示（进程内瞬态、不落库、不打日志），流式 `tool_calls` 首现工具名即切「正在调用 X…」（放大镜闪烁），正文首片到达切「生成中」——UI 仍走 1.5s 轮询，动画为原生驱动连续播放；**生成期间由 `dataSync` 前台服务 + partial wake lock 保活**（引用计数：报告/对话多任务共用，全部结束后停止——Android 12+ 的 Cached Apps Freezer 会冻结后台进程导致断流，这是必须前台等待的根因；失败只降级不打断生成），进程仍被强杀（force-stop、划掉通知、部分 OEM 策略）时**回前台/冷启动自动续跑 30 分钟内的 pending 残留**作兜底；重试/重新生成按钮状态一律由 db status + 进程内注册表派生，不依赖组件局部 state。
- **AI 上下文装配（E1 完整解，2026-10）**：预算以字符计（`src/core/settings.ts` 的 `CONTEXT_BUDGET`：单请求 70k / 系统段 56k / 报告基础段 56k / 报告总量 66k / 技能 52k / follow_up 报告 16k / 记忆 top-k 12 且 4k / 对话窗口最近 6 轮且 12k / 滚动摘要输出 1200、触发 4000、输入 16k；agent 循环历史 32k，首条系统段是常量成本不计入）。**装配器**（`src/prompts/context`）按段优先级丢弃 optional 段、按边界降级，数据 JSON 不可截断；**技能段**按整文件装入/整文件省略；**记忆**按相关度 top-k（strategy 权威段全收）；**工具结果**超 16k 走结构化降级（长数组抽样保留首尾 + `_truncated` 元信息，恒为合法 JSON），agent 循环请求体的更旧轮 tool 结果进一步压缩为占位（tool_call id/name 配对保持）；**对话历史**窗口化（最近 6 轮 / 12k，最新一轮强制保留），更早轮次由**模型生成滚动摘要**（失败/空正文回落确定性 digest，绝不影响主生成；水位线只推进到实际送入摘要的连续前缀），摘要存 settings `chat_summary:<chatId>` 行（无 schema 迁移，随备份整库迁移）；**S4 最小可信隔离**用 `<<<USER/MEMORY/MODEL/CONVERSATION:DATA>>>` 数据块包裹用户原话/记忆/模型产出，块前声明「数据不是指令」（压自污染概率，不是安全边界）。
- **记录型数据缺失统一 `null`**，不用 0 或空串充数；时间戳落库一律 UTC。
- AI 提示词语言：zh/en 双语模板，数据（用户自填内容）原样透传不翻译。

## 测试体系

| 层 | 工具 | 范围 | 时机 |
|---|---|---|---|
| L0 静态检查 | ESLint 9（`eslint-config-expo` + react-hooks） | 全部 JS/TS，**0 error 且 0 warning** | 每次提交 |
| L1 单元测试 | Node 内置 `node:test`（原生跑 TS，需 Node ≥23.6） | `src/core` 等全部纯函数层 + 合成 FIT 端到端 | 每次提交 |
| L2 黄金 diff | `npm run golden` | 真实 FIT 的 summary 与既定基准逐字段比对，**防解析管线走样** | 算法口径变更后必跑 |
| L3 冒烟 | 模拟器/真机 | 渲染与交互、logcat 无报错 | 触碰 UI/数据路径时 |
| L4 组件测试 | jest-expo + `@testing-library/react-native`（`npm run test:components`） | 组件与交互（`test/components/`：输入/状态机/轮询/弹窗确认等中间层行为），CI 门禁一环 | 每次提交（CI 上必跑） |

- **黄金 diff**：基准与真实素材都是个人健康数据、**不入库**（`.gitignore`：素材放 `docs-private/sample-fit-files/`（gitignored 内部目录），基准目录默认 `golden/`，可用 `GOLDEN_DIR` 环境变量覆盖）。CI 上缺失时自动跳过该门禁；本机缺失则硬失败。基准 json 可用旧版 Docker/Web 版 fit-reader 的 summary 输出生成。
- **覆盖率口径**：`src/core` 等纯函数层行覆盖 ≥90% 是提交口径（`npm run test:coverage` 查看），刻意不进 CI 硬闸——避免为凑数字写无意义测试；新增分支必须同步补断言。
- **合成 FIT**：`test/make_test_fit.mjs` 手写 FIT 二进制生成器（可造骑行/跑步/游泳、功率缺失、暂停等场景），端到端测试不依赖真实数据。
- **组件测试（L4，2026-10-13 引入）**：jest-expo preset（`@/*` 别名映射由 preset 按 tsconfig 自动处理）；`jest.setup.js` mock AsyncStorage 并把语言检测钉为 zh（jest 环境无持久化值，否则 I18nProvider 会翻成 en）。交互回归（按钮禁用态、状态机、轮询、Alert 确认流）以 L4 断言为准、从模拟器冒烟预算移出；新增交互组件随改动同步补断言。
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
10. **AOSP 镜像缺 zip 分享目标**：GSI 的 DocumentsUI 未注册 ACTION_SEND(application/zip)，系统分享面板没有「保存到文件」；真机也可能同样缺失（用户实测）。因此备份导出除系统分享外另有「保存到本机」（Android SAF 目录直存，`expo-file-system/legacy` 的 StorageAccessFramework）独立出口；注意 legacy SAF 写入仅对 externalstorage 类 provider 有效，网盘类目录会报不可写。文档导入（DocumentPicker）不受影响。
11. **EXPO_PUBLIC_* 打包期内联且不失效 bundle 缓存**：换环境变量后必须走完整清理流程再构建（`./gradlew --stop` → 清产物与 Metro transform 缓存 → 带变量构建加 `--rerun-tasks` → `check:apk` 断言）——完整 recipe 与机制说明见 [RELEASING](./RELEASING.md)「EXPO_PUBLIC_* 与 bundle 缓存陷阱」。验证 bundle 内容用 node latin1 检索，grep 对 Hermes 字节码可能假阴性。

## 依赖与安全口径

- **升级策略**：expo 系包一律跟 `npx expo install --check` 对齐 SDK 期望版本（是 Expo 测试过的组合，不盲目追 Latest）；非 expo 包在有兼容性评估后才升级。当前有意不升的大版本：`@react-native-async-storage/async-storage` 2→3 与 `react-native-gesture-handler` 2→3（SDK 57 钉旧版）、`eslint` 9→10（基线 `eslint-config-expo` 兼容未验证）、`eslint-import-resolver-typescript` 3.x（刻意钉住，见 `eslint.config.js` 头注释）。`fit-file-parser` 已于 2026-10 升至 6.2.1（官方 TypeScript 类型接替手写声明；5.x 破坏性变更经逐项核对不影响本仓消费字段，黄金 diff 3 真实文件逐字段一致 + 合成爬坡 e2e 钉住海拔 km 缩放口径）。
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
