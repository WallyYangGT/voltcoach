/**
 * jest.setup.js — L4 组件测试的全局 mock（jest.config.js setupFiles 引入）。
 *
 * @react-native-async-storage/async-storage：原生模块在 node 环境为 null，
 * import 即抛错（I18nProvider 静态依赖它）——按官方口径整体替换为内存 mock
 * （官方文档 react-native-async-storage/docs/advanced/jest）。
 * expo-* 系模块由 jest-expo preset 自带 mock，无需在此处理。
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// expo-localization：jest-expo 的 mock 返回英文 locale，AsyncStorage mock 又没有
// 持久化值 → I18nProvider 启动检测会把语言翻成 en，断言文案漂移。测试统一钉 zh
// （zh 是 App 默认语言，词典断言全部按 zh 写）。
jest.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'zh' }],
}));
