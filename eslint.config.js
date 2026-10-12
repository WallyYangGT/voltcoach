/**
 * eslint.config.js — ESLint 扁平配置（工具链，2026-09-20 引入）
 *
 * 基线用 Expo 官方 `eslint-config-expo`（含 @typescript-eslint / react / import /
 * eslint-plugin-expo，以及关键的 **eslint-plugin-react-hooks**——提前 return 后调 Hook、
 * 条件 Hook 这类 tsc 查不出的运行时崩溃由 rules-of-hooks 拦住；此类事故在 M3 收尾后
 * 真实发生过一次，此前只靠人工审查与冒烟兜底）。
 *
 * 基线的 settings 已够用，本文件**不覆盖**它：`import/resolver` 同时配了 node 与
 * typescript（前者含 .android/.ios/.web/.native 平台后缀，后者按根 tsconfig 的
 * paths 解析 `@/*` 别名）——若在这里补 settings 块只会把基线的解析配置整键替换掉。
 *
 * 本文件只做两件事：忽略 native 工程与生成物（android/ ios/ 为 prebuild 产物；
 * docs/ 为纯文档；reference/ 为本地保留的旧版快照、不入库），以及给 test/ 与
 * scripts/ 的 .mjs 补 node globals（node:test / process / Buffer 等）。
 */
import expoConfig from 'eslint-config-expo/flat.js';
import globals from 'globals';

export default [
  {
    ignores: [
      'android/**',
      'ios/**',
      'reference/**',
      'docs/**',
      'node_modules/**',
      '.expo/**',
      'dist/**',
    ],
  },
  ...expoConfig,
  {
    files: ['test/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  // L4 组件测试（jest-expo preset，2026-10-13 引入）：describe/it/expect/jest 走隐式
  // globals（RNTL 的 afterEach 自动清理依赖全局 afterEach 存在，不用 @jest/globals
  // 显式 import 的原因）；匹配器来自 RNTL 自动 extend-expect，无需额外配置
  {
    files: ['test/components/**/*.{ts,tsx}', 'jest.setup.js'],
    languageOptions: { globals: { ...globals.jest } },
  },
];
