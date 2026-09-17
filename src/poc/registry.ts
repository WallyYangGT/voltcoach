/**
 * PoC 运行器注册表（M0 临时模块）。
 * 阶段 C 逐个替换为真实实现（fit-parser / svg / sse / sqlite）。
 */
import type { PocRunner } from './types';

const notImplemented: PocRunner = async () => ({
  pass: false,
  detail: '待实现（阶段 C 接入）',
});

export const pocRunners: Record<1 | 2 | 3 | 4, PocRunner> = {
  1: notImplemented,
  2: notImplemented,
  3: notImplemented,
  4: notImplemented,
};
