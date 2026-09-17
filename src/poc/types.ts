/**
 * PoC 运行器约定：每个 PoC 一个异步函数，可选接收字符串参数
 * （PoC 3 用它传 base_url/api_key/model），返回 {pass, detail}。
 * detail 用等宽小字展示在卡片下方（结果仅本地内存，不落盘）。
 */
export interface PocResult {
  pass: boolean;
  detail: string;
}

export interface PocOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

export type PocRunner = (opts?: PocOptions) => Promise<PocResult>;
