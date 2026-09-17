/**
 * PoC 运行器约定：每个 PoC 一个无参异步函数，返回 {pass, detail}。
 * detail 用等宽小字展示在卡片下方（结果仅本地内存，不落盘）。
 */
export interface PocResult {
  pass: boolean;
  detail: string;
}

export type PocRunner = () => Promise<PocResult>;
