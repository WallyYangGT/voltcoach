/**
 * providerPresets.ts — AI 服务商预设（M5 后打磨）：src/ai/providers.json 是唯一
 * 维护点，常用厂商的接口地址与模型列表随版本更新，设置页下拉只做"快速填充"，
 * 各项仍可手动修改（自定义口径不变）。
 *
 * 口径约束：
 * - baseUrl 必须不带末尾斜杠——src/ai/http.ts 按 `${baseUrl}/chat/completions` 拼
 *   完整端点，带斜杠会出现双斜杠；
 * - 模型列表是"常见可选值"而非完整清单，模型名始终以厂商账号实际可用为准
 *   （设置页 note 已说明），用户可随时手改；
 * - JSON 不被 node:test 直接 import（Node ESM 需要 import attributes，Metro 无此
 *   要求），数据形状由 test/ai-presets.test.mjs 用 fs 读取校验。
 */
import presetsJson from './providers.json';

export interface AiProviderPreset {
  /** 稳定标识（菜单 key / 回显比对用），不参与请求 */
  id: string;
  /** 菜单展示名（品牌名，语言中性） */
  label: string;
  /** OpenAI 兼容接口地址（不带末尾斜杠，拼 /chat/completions 用） */
  baseUrl: string;
  /** 常见模型名建议列表（可手改，不校验） */
  models: string[];
}

export const AI_PROVIDER_PRESETS = presetsJson as AiProviderPreset[];

/** 地址归一化：trim + 去末尾斜杠 + 小写（用户手输大小写/斜杠差异不影响回显比对） */
function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/** 按接口地址匹配预设：设置页回显「当前选中的服务商」用；不匹配即视为自定义 */
export function matchPresetByBaseUrl(baseUrl: string): AiProviderPreset | undefined {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return undefined;
  return AI_PROVIDER_PRESETS.find((p) => normalizeBaseUrl(p.baseUrl) === normalized);
}
