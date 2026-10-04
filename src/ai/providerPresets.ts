/**
 * providerPresets.ts — AI 服务商预设（M5 后打磨）：src/ai/providers.json 是唯一
 * 维护点，常用厂商的接口地址与模型列表随版本更新，设置页下拉只做"快速填充"，
 * 各项仍可手动修改（自定义口径不变）。
 *
 * 口径约束：
 * - baseUrl 必须不带末尾斜杠——src/ai/http.ts 按 `${baseUrl}/chat/completions` 拼
 *   完整端点，带斜杠会出现双斜杠；
 * - label 必须是语言中性的拉丁品牌名——JSON 数据不进 i18n 词典，含中文会原样漏给
 *   英文用户；
 * - models[0] 是推荐默认（选预设且模型为空/换厂商时回填它），列表顺序即推荐顺序；
 *   模型名始终以厂商账号实际可用为准（设置页 note 已说明），用户可随时手改；
 * - JSON 不被 node:test 直接 import（Node ESM 需要 import attributes，Metro 无此
 *   要求），本文件因此也进不了 node 的覆盖率报告——匹配纯逻辑拆在 providerMatch.ts
 *   （可被 node:test 直测），数据形状由 test/ai-presets.test.mjs 用 fs 读取校验。
 */
import presetsJson from './providers.json';
import { matchPresetByBaseUrl as matchByList } from './providerMatch.ts';

export interface AiProviderPreset {
  /** 稳定标识（菜单 key / 回显比对用），不参与请求 */
  id: string;
  /** 菜单展示名（语言中性的拉丁品牌名，见文件头口径） */
  label: string;
  /** OpenAI 兼容接口地址（不带末尾斜杠，拼 /chat/completions 用） */
  baseUrl: string;
  /** 常见模型名建议列表（models[0] = 推荐默认；可手改，不校验） */
  models: string[];
}

export const AI_PROVIDER_PRESETS = presetsJson as AiProviderPreset[];

/** 按接口地址找预设（归一化实现与测试覆盖见 providerMatch.ts）；不匹配即自定义 */
export function matchPresetByBaseUrl(baseUrl: string): AiProviderPreset | undefined {
  return matchByList(baseUrl, AI_PROVIDER_PRESETS);
}
