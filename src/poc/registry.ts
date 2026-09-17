/**
 * PoC 运行器注册表（M0 临时模块，M0 结束后随 app/poc.tsx 一并移除）。
 */
import type { PocRunner } from './types';
import { runFitParserPoc } from './fitParser';
import { runSvgPerfPoc } from './svgPerf';
import { runSsePoc } from './sse';
import { runSqlitePoc } from './sqlite';

export const pocRunners: Record<1 | 2 | 3 | 4, PocRunner> = {
  1: runFitParserPoc,
  2: runSvgPerfPoc,
  3: runSsePoc,
  4: runSqlitePoc,
};
