/**
 * providerMatch.ts — 服务商预设的地址匹配纯逻辑（无 JSON/RN 依赖，node:test 可
 * 直测补覆盖率）。从 providerPresets.ts 拆出的原因：providers.json 的 import 在
 * Node ESM 需要 import attributes，带 JSON import 的文件进不了 node:test 与其
 * 覆盖率报告（Metro 无此限制，providerPresets.ts 仍负责数据与 re-export）。
 */

/** 地址归一化：trim + 去末尾斜杠 + 小写（用户手输大小写/斜杠差异不影响回显比对） */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** 按接口地址匹配预设：设置页回显「当前选中的服务商」用；不匹配即视为自定义 */
export function matchPresetByBaseUrl<T extends { baseUrl: string }>(
  baseUrl: string,
  presets: readonly T[],
): T | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return undefined;
  return presets.find((p) => normalizeBaseUrl(p.baseUrl) === normalized);
}
