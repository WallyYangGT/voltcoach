/**
 * wahooAuth.ts — Wahoo 设备侧授权流（多平台化里唯一必须触 RN/浏览器的同步模块）
 *
 * 三步：准备（PKCE + 授权 URL）→ 打开浏览器等回调 → 授权码换令牌。PKCE verifier 必须
 * 在「准备」与「换令牌」之间保持一致（刷新令牌时官方还要求复用），故由调用方（卡片）
 * 持有本次授权的 pkce 材料，换完令牌连同 clientId/redirectUri 一起存进 SecureStore。
 *
 * 回调两条路（同一套解析，见 sync/wahoo.parseWahooCallback）：
 *  ① 正常路径：浏览器跳回自定义 scheme `voltcoach://wahoo`（app.json 的 scheme 已具备，
 *    无需再动原生工程）；
 *  ② 兜底路径：门户若拒收自定义 scheme 回调，用户从浏览器地址栏把回调链接（或裸授权码）
 *    复制回 App 粘贴——本项目没有服务端，这是唯一不依赖第三方中转的可行兜底。
 */

import * as WebBrowser from 'expo-web-browser';
import { parseWahooCallback, WAHOO_DEFAULT_REDIRECT, type WahooPkce } from '@/sync/wahoo';
import { createDeviceWahooClient, type OAuthCredentials } from './syncProviders';

// Expo 官方要求：顶层调用一次，让 web/独立会话形态也能收尾（Android Custom Tab 下无副作用）
WebBrowser.maybeCompleteAuthSession();

/** 门户登记的回调地址（须与 Wahoo 开发者门户里填的完全一致，含 scheme） */
export function wahooRedirectUri(): string {
  return WAHOO_DEFAULT_REDIRECT;
}

export interface PreparedWahooAuth {
  pkce: WahooPkce;
  authorizeUrl: string;
}

/** 准备一次授权（生成 PKCE 与授权页 URL；材料由调用方持有到换令牌完成） */
export async function prepareWahooAuth(
  clientId: string,
  redirectUri: string = WAHOO_DEFAULT_REDIRECT,
): Promise<PreparedWahooAuth> {
  const client = await createDeviceWahooClient();
  const pkce = await client.newPkce();
  return {
    pkce,
    authorizeUrl: client.authorizeUrl({ clientId: clientId.trim(), redirectUri, pkce }),
  };
}

/**
 * 打开授权页并等回调。返回授权码；**用户主动取消返回 null**（不是错误，界面静默即可）。
 * 自定义 scheme 被门户拒绝时浏览器会停在错误页，这里同样落到 null → 界面提示走手动粘贴。
 */
export async function openWahooAuthorize(p: {
  authorizeUrl: string;
  redirectUri: string;
  state: string;
}): Promise<{ code: string } | null> {
  const result = await WebBrowser.openAuthSessionAsync(p.authorizeUrl, p.redirectUri);
  if (result.type !== 'success' || !('url' in result) || !result.url) return null;
  return parseWahooCallback(result.url, p.state);
}

/** 授权码 → 完整凭据（clientId/redirectUri/verifier 一并带上，供刷新令牌复用） */
export async function exchangeWahooCode(p: {
  clientId: string;
  redirectUri: string;
  pkce: WahooPkce;
  code: string;
}): Promise<OAuthCredentials> {
  const client = await createDeviceWahooClient();
  const tokens = await client.exchangeCode({
    clientId: p.clientId.trim(),
    code: p.code,
    codeVerifier: p.pkce.verifier,
    redirectUri: p.redirectUri,
  });
  return {
    kind: 'oauth',
    clientId: p.clientId.trim(),
    redirectUri: p.redirectUri,
    codeVerifier: p.pkce.verifier,
    ...tokens,
  };
}

/** 手动粘贴路径：解析用户贴回来的回调链接（或裸授权码）再换令牌 */
export async function completeWahooAuthFromInput(p: {
  clientId: string;
  redirectUri: string;
  pkce: WahooPkce;
  input: string;
}): Promise<OAuthCredentials> {
  const { code } = parseWahooCallback(p.input, p.pkce.state);
  return exchangeWahooCode({ clientId: p.clientId, redirectUri: p.redirectUri, pkce: p.pkce, code });
}
