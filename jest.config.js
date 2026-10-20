/**
 * jest.config.js — L4 组件测试（2026-10-13 引入，roadmap「L4：Jest 组件测试引入」销项）
 *
 * preset 用 jest-expo（SDK 57 配套）：自带 react-native 环境、babel 转换
 * （babel-preset-expo）与 moduleNameMapper——`@/*`、`@/assets/*` 别名按根 tsconfig
 * paths 自动映射，无需在此重复配置；transformIgnorePatterns 白名单（react-native/
 * expo/@expo 等）也是 preset 缺省，只在该白名单外的 ESM 包报错时再补。
 *
 * 范围：test/ 下 *.test.ts(x)（test/components/ 组件与 Hook；test/services/ 服务层
 * 编排接线）。纯函数层仍归 node:test
 * （`npm test`，单层 glob 不受本目录影响）；两套并行，覆盖率口径见 AGENTS.md。
 * 根 package.json 是 type: module——测试文件写成 CJS 兼容形态（jest 经 babel
 * 转 CJS 执行）；若出现 ESM 识别报错，兜底方案是 test/components/ 下放
 * {"type":"commonjs"} 的子 package.json（不影响 Metro/tsc）。
 */
export default {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testMatch: ['<rootDir>/test/**/*.test.@(ts|tsx)'],
};
