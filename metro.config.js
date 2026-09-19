/**
 * Metro 配置：在默认 Expo 配置上追加 .db / .gz 为资产扩展名。
 * .gz 备份包导入（M4 .fitbackup 文件选择）与可能的 db 资产分发需要；
 * M0 的 PoC 样例库已随 PoC 页移除，训练库由 App 自建（SQLCipher）。
 */
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('db', 'gz');

module.exports = config;
