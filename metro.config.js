/**
 * Metro 配置：在默认 Expo 配置上追加 .db 为资产扩展名，
 * 使 require('../assets/poc/fitness.db') 可打包分发（PoC 4 用，M0 后视情况保留——
 * M1 起训练库由 App 自建，不再随包携带样例库）。
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('db');

module.exports = config;
