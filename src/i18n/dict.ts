/**
 * dict.ts — 前端双语词典（zh 默认 / en）
 *
 * 移植自 Web 版 reference/web/js/i18n.js 的 DICT，key 命名沿用旧约定
 * （nav.* / common.* / sport.* / cat.* 等），保证 M1/M2 搬运其余词条时口径连续。
 * 新增 App 专属 key：tab.*（底部四 tab）、poc.*（M0 验证页）等。
 * 约定：新增 key 必须同时补 zh 与 en；zh 文案与 Web 版逐字一致的 key 改动需谨慎
 * （与旧版体验一致性），纯新增文案自由。
 */
export type Lang = 'zh' | 'en';

export const LANG_STORAGE_KEY = 'fit-reader.lang';

export const DICT = {
  zh: {
    // ---- 共用（与 Web 版同 key 同文案） ----
    'common.close': '关闭',
    'common.cancel': '取消',
    'common.delete': '删除',
    'common.loading': '加载中…',
    'common.save': '保存',
    'common.retry': '重试',
    'common.copy': '复制',
    'common.copied': '已复制',
    'common.not_now': '暂不',
    'sport.cycling': '骑行',
    'sport.running': '跑步',
    'sport.swimming': '游泳',
    'sport.unknown': '未知',
    'cat.training': '训练',
    'cat.race': '比赛',
    'cat.recovery': '恢复',
    'cat.leisure': '休闲',
    'act.duration': '时长',

    // ---- 底部导航（App 新信息架构 §4.1） ----
    'tab.home': '首页',
    'tab.activities': '训练',
    'tab.ai': 'AI',
    'tab.me': '我的',

    // ---- 占位页（M0 骨架，真实功能后续里程碑落地） ----
    'home.title': '首页',
    'home.placeholder': '训练仪表盘将在 M2 落地：CTL/ATL/TSB 大数字、趋势图、近期训练。',
    'activities.title': '训练',
    'activities.placeholder': '训练列表与 FIT 导入（FAB）将在 M1 落地；分享面板接收同步落地。',
    'ai.title': 'AI',
    'ai.placeholder': 'AI 会话中心将在 M3 落地：四场景报告生成、统一历史列表、追问与直接对话。',
    'me.title': '我的',
    'me.placeholder': '设置页将在 M2 落地：骑手参数、用户背景与目标、AI 服务配置。',
    'me.lang': '界面语言',
    'me.memory': 'AI 记忆',
    'me.data': '数据管理',
    'me.about': '关于',
    'me.soon': '（后续里程碑开放）',

    // ---- M0 PoC 验证页（临时，M0 结束后移除） ----
    'poc.title': 'M0 技术验证',
    'poc.subtitle': '4 项风险前置验证（迁移计划 §8.4），结果仅本地展示',
    'poc.1.title': 'PoC 1 · FIT 解析',
    'poc.1.desc': 'fit-file-parser 在 Metro/Hermes 下解析真实 MAGENE 文件（全计划最大单点风险）',
    'poc.2.title': 'PoC 2 · SVG 图表性能',
    'poc.2.desc': 'react-native-svg 渲染 3 系列 × 1400 点折线的流畅度',
    'poc.3.title': 'PoC 3 · SSE 流式',
    'poc.3.desc': 'expo/fetch 流式读取 chat/completions（本地 mock 服务 + 可选真实接口）',
    'poc.4.title': 'PoC 4 · SQLite 兼容',
    'poc.4.desc': 'node:sqlite 生成的训练库在 expo-sqlite 打开并查询（M1 建库/迁移路径前置验证）',
    'poc.run': '运行',
    'poc.pending': '未运行',
    'poc.running': '运行中…',
    'poc.pass': '通过',
    'poc.fail': '失败',
  },

  en: {
    'common.close': 'Close',
    'common.cancel': 'Cancel',
    'common.delete': 'Delete',
    'common.loading': 'Loading…',
    'common.save': 'Save',
    'common.retry': 'Retry',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.not_now': 'Not now',
    'sport.cycling': 'Cycling',
    'sport.running': 'Running',
    'sport.swimming': 'Swimming',
    'sport.unknown': 'Unknown',
    'cat.training': 'Training',
    'cat.race': 'Race',
    'cat.recovery': 'Recovery',
    'cat.leisure': 'Leisure',
    'act.duration': 'Duration',

    'tab.home': 'Home',
    'tab.activities': 'Training',
    'tab.ai': 'AI',
    'tab.me': 'Me',

    'home.title': 'Home',
    'home.placeholder': 'Dashboard lands in M2: CTL/ATL/TSB headline numbers, trend chart, recent activities.',
    'activities.title': 'Training',
    'activities.placeholder': 'Activity list and FIT import (FAB) land in M1, along with share-sheet intake.',
    'ai.title': 'AI',
    'ai.placeholder': 'AI session hub lands in M3: four report scenarios, unified history, follow-ups and chat.',
    'me.title': 'Me',
    'me.placeholder': 'Settings land in M2: rider params, profile & goals, AI service config.',
    'me.lang': 'Language',
    'me.memory': 'AI Memory',
    'me.data': 'Data',
    'me.about': 'About',
    'me.soon': '(later milestone)',

    'poc.title': 'M0 Tech Validation',
    'poc.subtitle': '4 risk-first proofs of concept (migration plan §8.4), local results only',
    'poc.1.title': 'PoC 1 · FIT parsing',
    'poc.1.desc': 'fit-file-parser parsing a real MAGENE file under Metro/Hermes (top single-point risk)',
    'poc.2.title': 'PoC 2 · SVG chart perf',
    'poc.2.desc': 'react-native-svg rendering 3-series × 1400-point polylines smoothly',
    'poc.3.title': 'PoC 3 · SSE streaming',
    'poc.3.desc': 'expo/fetch streaming chat/completions (local mock server + optional real endpoint)',
    'poc.4.title': 'PoC 4 · SQLite compat',
    'poc.4.desc': 'A node:sqlite-built training DB opened and queried via expo-sqlite (M1 prerequisite)',
    'poc.run': 'Run',
    'poc.pending': 'Not run',
    'poc.running': 'Running…',
    'poc.pass': 'Pass',
    'poc.fail': 'Fail',
  },
} as const;

export type DictKey = keyof typeof DICT.zh;
