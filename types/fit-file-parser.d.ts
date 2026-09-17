/**
 * fit-file-parser@3.0.2 无官方类型，此为最小声明（仅覆盖本项目用到的 API）。
 * 与旧 repo index.js 的用法对齐：force/长度速度单位/mode list + parse(content, cb)。
 * 注意：lengthUnit 'km' 时解析器会把海拔/爬升缩放成 km（老坑），消费侧需 ×1000 换回米。
 */
declare module 'fit-file-parser' {
  export interface FitParserOptions {
    force?: boolean;
    speedUnit?: 'm/s' | 'km/h' | 'mph';
    lengthUnit?: 'm' | 'km' | 'mi';
    temperatureUnit?: 'celsius' | 'fahrenheit';
    elapsedRecordField?: boolean;
    pressureUnit?: 'bar' | 'psi' | 'pa';
    mode?: 'list' | 'object';
  }

  export default class FitParser {
    constructor(options?: FitParserOptions);
    parse(
      content: ArrayBuffer | Uint8Array,
      callback: (error: string | null, data: any) => void,
    ): void;
    parseAsync(content: ArrayBuffer | Uint8Array): Promise<any>;
  }
}
