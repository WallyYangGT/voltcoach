/**
 * wahooAuth.ts — Wahoo 设备侧授权流（多平台化里唯一必须触 RN/浏览器的同步模块）
 *
 * 三步：准备（PKCE + 授权 URL）→ 打开浏览器等回调 → 授权码换令牌。PKCE verifier 必须
 * 在「准备」与「换令牌」之间保持一致（刷新令牌时官方还要求复用），故由本模块用
 * **模块级 pending 状态**持有——不能让表单组件的 state 兜着：回调会以深链形式重新进入
 * App（expo-router 会导航到 `app/wahoo-callback.tsx`），那一刻负责收尾的是回调路由，
 * 不是表单（表单可能尚未重新挂载）。
 *
 * 回调两条路（同一套解析，见 sync/wahoo.parseWahooCallback）：
 *  ① 正常路径：浏览器跳回自定义 scheme `voltcoach:///wahoo-callback`（三斜杠=路径形式，
 *     expo-router 才能稳定匹配到回调路由；两斜杠会被当成 host，落进 Unmatched Route）；
 *  ② 兜底路径：门户若拒收自定义 scheme 回调，用户从浏览器地址栏把回调链接（或裸授权码）
 *     复制回 App 粘贴——本项目没有服务端，这是唯一不依赖第三方中转的可行兜底。
 *
 * 幂等：`completeWahooAuth` 以 pending 为锁，回调路由与表单两条入口谁先到谁完成，
 * 后到的那条拿到 null（不再重复换码）。
 */

import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { parseWahooCallback, WAHOO_DEFAULT_REDIRECT, type WahooPkce } from '@/sync/wahoo';
import { createDeviceWahooClient, type OAuthCredentials } from './syncProviders';

// Expo 官方要求：顶层调用一次，让 web/独立会话形态也能收尾（Android Custom Tab 下无副作用）
WebBrowser.maybeCompleteAuthSession();

/** 门户登记的回调地址（须与 Wahoo 开发者门户里填的完全一致，含 scheme 与斜杠数） */
export function wahooRedirectUri(): string {
  return WAHOO_DEFAULT_REDIRECT;
}

/** 进行中的授权（PKCE 材料 + 目标应用），跨「打开浏览器」与「回调收尾」两步存活 */
interface PendingWahooAuth {
  clientId: string;
  redirectUri: string;
  pkce: WahooPkce;
}

let pendingAuth: PendingWahooAuth | null = null;

/** 是否有进行中的授权（回调路由据此判断要不要收尾） */
export function hasPendingWahooAuth(): boolean {
  return pendingAuth !== null;
}

/** 放弃进行中的授权（用户取消/换平台时清理） */
export function clearPendingWahooAuth(): void {
  pendingAuth = null;
}

export interface PreparedWahooAuth {
  pkce: WahooPkce;
  authorizeUrl: string;
}

/** 准备一次授权（生成 PKCE 与授权页 URL，并登记为进行中） */
export async function prepareWahooAuth(
  clientId: string,
  redirectUri: string = WAHOO_DEFAULT_REDIRECT,
): Promise<PreparedWahooAuth> {
  const client = await createDeviceWahooClient();
  const pkce = await client.newPkce();
  pendingAuth = { clientId: clientId.trim(), redirectUri, pkce };
  return {
    pkce,
    authorizeUrl: client.authorizeUrl({ clientId: clientId.trim(), redirectUri, pkce }),
  };
}

/**
 * 打开授权页并等回调（Android 上是 `expo-web-browser` 的 polyfill：浏览器关闭事件与
 * 「收到以 redirectUri 开头的深链」两路赛跑）。返回回调 URL；用户主动取消返回 null。
 * ⚠️ 这条赛跑**可能先被浏览器关闭事件赢掉**（自定义 scheme 由系统交给 App 时 Chrome
 * 会把 Custom Tab 留在后台），所以拿不到 URL 不代表授权失败——真正的收尾在回调路由，
 * 这里拿到的 URL 只是「顺路先完成」的快路径。
 */
export async function openWahooAuthorize(p: {
  authorizeUrl: string;
  redirectUri: string;
}): Promise<string | null> {
  const result = await WebBrowser.openAuthSessionAsync(p.authorizeUrl, p.redirectUri);
  if (result.type !== 'success' || !('url' in result) || !result.url) return null;
  return result.url;
}

/**
 * 完成授权：解析回调（完整 URL / https 中转链接 / 裸授权码都认）→ 换令牌 → 交出凭据。
 * 返回 null = 没有进行中的授权（已完成/已放弃），调用方不应重复处理。
 */
export async function completeWahooAuth(input: string): Promise<OAuthCredentials | null> {
  const pending = pendingAuth;
  if (!pending) return null;
  const { code } = parseWahooCallback(input, pending.pkce.state);
  const client = await createDeviceWahooClient();
  const tokens = await client.exchangeCode({
    clientId: pending.clientId,
    code,
    codeVerifier: pending.pkce.verifier,
    redirectUri: pending.redirectUri,
  });
  // 换码成功才清 pending（换失败时保留，用户还能再贴一次同一个链接）
  pendingAuth = null;
  return {
    kind: 'oauth',
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeVerifier: pending.pkce.verifier,
    ...tokens,
  };
}

/**
 * 回调路由用：取当前把 App 唤起的深链（无则 null）。用 Linking.useURL 而非路由参数——
 * 回调 URL 的 query 已经过 URL 规范化，直接交给 parseWahooCallback 最不容易出错。
 */
export function useWahooCallbackUrl(): string | null {
  return Linking.useURL();
}
