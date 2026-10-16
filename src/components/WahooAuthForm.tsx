/**
 * WahooAuthForm — 云同步卡的 OAuth 型平台表单（Wahoo）
 *
 * 与账号密码型平台的区别：Wahoo 官方通道要 client_id，而本项目没有服务端、也不该代持
 * 第三方应用凭据，故走 BYOK——用户自己去 Wahoo 开发者门户建一个 **sandbox** 应用
 * （免费、即时可用、只对自己账号有效），把 Client ID 与回调地址填进卡片，再点授权登录。
 *
 * 两条授权路径，共用同一份 PKCE 材料（verifier 换令牌与后续刷新都要用）：
 *  ① 授权登录：打开系统浏览器 → 授权页 → 跳回 voltcoach://wahoo → 自动收码换令牌；
 *  ② 手动粘贴：门户若拒收自定义 scheme 回调（未证实，社区两侧证据都有），用户把地址栏
 *     里的回调链接（或裸授权码）复制回来粘贴——本项目没有服务端，这是唯一不依赖第三方
 *     中转的兜底。
 * 卡片里的回调地址做成了可长按选择复制的文本（不引额外剪贴板 UI）。
 */
import React, { useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button, TextInput } from 'react-native-paper';
import { useI18n } from '@/i18n';
import type { SyncProvider } from '@/services/syncProviders';
import {
  clearPendingWahooAuth,
  completeWahooAuth,
  openWahooAuthorize,
  prepareWahooAuth,
  wahooRedirectUri,
  type PreparedWahooAuth,
} from '@/services/wahooAuth';
import { palette } from '@/theme';

export function WahooAuthForm({
  provider,
  bound,
  disabled,
  onChanged,
}: {
  provider: SyncProvider;
  /** 已完成授权（有令牌）：显示「已授权」态 */
  bound: boolean;
  disabled: boolean;
  /** 授权成功后通知卡片重新读凭据 */
  onChanged: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const [clientId, setClientId] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [busy, setBusy] = useState(false);
  // 本次授权是否已发起（PKCE 真源在 wahooAuth 的模块级 pending：回调路由也要用它换码，
  // 表单 state 只负责界面开关）
  const [pending, setPending] = useState<PreparedWahooAuth | null>(null);
  // 已绑定后回填 client_id（readonly 显示用）
  const [boundClientId, setBoundClientId] = useState('');

  // 组件卸载（换平台/离开同步卡）时放弃未完成的授权：否则回调路由可能拿着旧 PKCE 收尾
  React.useEffect(() => () => clearPendingWahooAuth(), []);

  React.useEffect(() => {
    let alive = true;
    void (async () => {
      const creds = await provider.loadCredentials();
      if (alive && creds?.kind === 'oauth') setBoundClientId(creds.clientId);
    })();
    return () => {
      alive = false;
    };
  }, [provider]);

  const redirectUri = wahooRedirectUri();

  /** 授权（浏览器路径） */
  const authorize = async () => {
    const id = clientId.trim() || boundClientId;
    if (!id) return;
    setBusy(true);
    try {
      const prepared = await prepareWahooAuth(id, redirectUri);
      setPending(prepared);
      setManualOpen(true); // 万一浏览器跳不回来，粘贴框已经就位
      const callbackUrl = await openWahooAuthorize({ authorizeUrl: prepared.authorizeUrl, redirectUri });
      if (!callbackUrl) return; // 取消 / 赛跑被浏览器关闭事件赢掉：收尾交给回调路由或手动粘贴
      const creds = await completeWahooAuth(callbackUrl);
      if (!creds) return; // 回调路由已经完成过这次授权
      await provider.saveCredentials(creds);
      setClientId('');
      setManualInput('');
      setManualOpen(false);
      setPending(null);
      await onChanged();
    } catch (e) {
      Alert.alert(t('data.err.generic'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 授权（手动粘贴路径）：复用同一次「准备」的 PKCE（verifier 与授权 URL 必须成对） */
  const submitManual = async () => {
    const id = clientId.trim() || boundClientId;
    if (!id || !manualInput.trim()) return;
    const prepared = pending;
    if (!prepared) {
      // 没有进行中的授权（例如中途重启了 App）：PKCE 对不上，换令牌只会得到 invalid_grant。
      // 老实让用户先点「授权登录」——那里会准备一份新的 PKCE 并打开授权页
      Alert.alert(t('data.sync.wahoo.pasteHint'));
      return;
    }
    setBusy(true);
    try {
      const creds = await completeWahooAuth(manualInput);
      if (!creds) throw new Error(t('data.sync.wahoo.pasteHint'));
      await provider.saveCredentials(creds);
      setClientId('');
      setManualInput('');
      setManualOpen(false);
      setPending(null);
      await onChanged();
    } catch (e) {
      Alert.alert(t('data.err.generic'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Text style={styles.note}>{t('data.sync.wahoo.howTo')}</Text>
      <TextInput
        label={t('data.sync.wahoo.clientId')}
        value={clientId}
        onChangeText={setClientId}
        placeholder={boundClientId || undefined}
        mode="outlined"
        dense
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <View style={styles.redirectRow}>
        <Text style={styles.note}>{t('data.sync.wahoo.redirect')}</Text>
        <Text style={styles.redirectValue} selectable>
          {redirectUri}
        </Text>
      </View>
      <View style={styles.actions}>
        <Button
          mode="contained"
          compact
          onPress={authorize}
          disabled={disabled || busy || (!clientId.trim() && !boundClientId)}
          loading={busy}
        >
          {busy ? t('data.sync.wahoo.authorizing') : t('data.sync.wahoo.authorize')}
        </Button>
        <Button mode="text" compact onPress={() => setManualOpen((v) => !v)} disabled={busy}>
          {manualOpen ? t('data.sync.wahoo.pasteClose') : t('data.sync.wahoo.pasteOpen')}
        </Button>
      </View>
      {manualOpen && (
        <>
          <TextInput
            label={t('data.sync.wahoo.pasteLabel')}
            value={manualInput}
            onChangeText={setManualInput}
            mode="outlined"
            dense
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={styles.input}
          />
          <Button
            mode="outlined"
            compact
            onPress={submitManual}
            disabled={disabled || busy || !manualInput.trim()}
          >
            {t('data.sync.wahoo.pasteSubmit')}
          </Button>
        </>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  note: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  input: { backgroundColor: palette.panel2 },
  redirectRow: { gap: 2 },
  redirectValue: { color: palette.volt, fontSize: 12, fontFamily: 'monospace' },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
});
