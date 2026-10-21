/**
 * db/index.ts — 训练库（expo-sqlite + SQLCipher 加密）· barrel 出口
 *
 * 移植自 fit-reader Web 版 src/db.js：建表/查询 SQL 原样平移，驱动从 node:sqlite
 * （同步 API）换 expo-sqlite（异步 API）。差异：
 *  - SQLCipher 已拍板启用：db key 首次随机生成（expo-crypto）
 *    存 expo-secure-store（Android Keystore），密钥不落盘；
 *  - 从零建库按最新 schema 整体创建（src/db/schema.ts），存量库由
 *    src/db/migrate.ts 按 PRAGMA user_version 走编号迁移链（v3 = 活动 uuid 身份、
 *    AI 报告/对话外键与指纹，decisions §34）；
 *  - 骑手参数不再用"全局可变对象原地合并"（旧版 syncAthleteFromDb 模式），
 *    改 getEffectiveAthlete() 显式返回合并值，由调用方（导入服务）注入 analyzeFile；
 *  - CTL/ATL/TSB 递推在 src/core/form.ts（纯函数），本层只做查询。
 *
 * M3 追加（自 fit-reader Web 版 src/db.js AI 段平移）：ai_reports / ai_chats / ai_chat_messages /
 * ai_memories 四表 CRUD 与 get/setAiConfig。差异：api_key 不入库（旧版明文存 settings 行），
 * 改存 expo-secure-store（Android Keystore，AI_KEY_STORE），get 时合并、set 时分流。
 *
 * 实现按业务域拆分在同级文件（2026-10 架构评审 A2 落地）：连接生命周期在 client.ts，
 * 各域为 athlete（骑手参数与档案）/ activities（训练记录与统计查询）/ prefs（语言/
 * 同步态/披露条锚）/ aiconfig / reports / chats（含滚动摘要）/ memories / dossier /
 * plans。本文件只做 re-export：'@/db' 是历史统一的公共出口（services/UI 与测试 mock
 * 都指它，出口符号集与拆分前等价）；新代码可以直接从域文件导入以获得更窄的依赖面，
 * 域模块函数集合即仓储端口（services 层测试经 jest.mock('@/db') 注入假实现）。
 */

export * from './client';
export * from './notify';
export * from './athlete';
export * from './activities';
export * from './prefs';
export * from './aiconfig';
export * from './reports';
export * from './chats';
export * from './memories';
export * from './dossier';
export * from './plans';
