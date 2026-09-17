/** Metro 资产模块声明：.db 经 metro.config.js assetExts 打包，require 返回资产编号 */
declare module '*.db' {
  const value: number;
  export default value;
}
