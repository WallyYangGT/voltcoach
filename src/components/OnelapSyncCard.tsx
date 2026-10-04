/**
 * OnelapSyncCard — 顽鹿同步卡（§10.4）：账号绑定（SecureStore）/ 前台自动同步开关 /
 * 立即同步与结果 / 测试连接。原先内嵌在数据管理页，M5 收尾后按反馈挪到「我的」页
 * AI 服务下方——绑定账号属于账号类配置，与 AI 服务同类，藏在数据管理里太深。
 * 纯 UI 搬移，编排逻辑不动（runOnelapSync/probeOnelapEndpoints；前台自动同步仍在
 * 根布局 AppState 触发，与本卡挂载位置无关）。错误提示按 SyncErrorCode 映射双语
 * 词条（data.sync.* 键沿用原命名空间，避免词典大面积改名）。
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button, Divider, Switch, TextInput } from 'react-native-paper';
import { getSyncState, setSyncState, type SyncState } from '@/db';
import { useI18n } from '@/i18n';
import {
  getOnelapAccount,
  onelapOverrideBase,
  probeOnelapEndpoints,
  runOnelapSync,
  setOnelapAccount,
  type SyncOutcome,
} from '@/services/syncOnelap';
import { palette } from '@/theme';

export function OnelapSyncCard() {
  const { t } = useI18n();

  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [hasAccount, setHasAccount] = useState(false);
  const [syncState, setSyncStateLocal] = useState<SyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null);

  const load = useCallback(async () => {
    try {
      const [acct, state] = await Promise.all([getOnelapAccount(), getSyncState()]);
      setHasAccount(Boolean(acct));
      // 只回填账号且仅在输入框为空时（卡片在 tab 页，聚焦频繁，避免覆盖编辑中的草稿）；
      // 密码保持密文位不回显
      if (acct) setAccount((cur) => (cur.trim() === '' ? acct.account : cur));
      setSyncStateLocal(state);
    } catch (e) {
      console.warn('顽鹿同步卡加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const saveAccount = async () => {
    if (!account.trim() || !password) return;
    try {
      await setOnelapAccount(account, password);
      setHasAccount(true);
      setPassword('');
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      Alert.alert(t('data.err.generic'), String(e));
    }
  };

  const clearAccount = () => {
    Alert.alert(t('data.sync.clear'), t('data.sync.account'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('data.sync.clear'),
        style: 'destructive',
        onPress: async () => {
          await setOnelapAccount('', null);
          setAccount('');
          setHasAccount(false);
          load();
        },
      },
    ]);
  };

  const toggleAuto = async (value: boolean) => {
    if (!syncState) return;
    const next = { ...syncState, auto: value };
    setSyncStateLocal(next); // 乐观更新
    try {
      await setSyncState(next);
    } catch (e) {
      console.warn('保存同步开关失败:', e);
      load();
    }
  };

  const syncNow = async () => {
    setSyncing(true);
    setLastOutcome(null);
    try {
      const outcome = await runOnelapSync();
      setLastOutcome(outcome);
      if (outcome.error?.code === 'no_account') {
        Alert.alert(t('data.sync.err.no_account'));
      } else if (outcome.error?.code === 'auth') {
        Alert.alert(t('data.sync.err.auth'), outcome.error.message);
      } else if (outcome.error) {
        Alert.alert(t('data.err.generic'), outcome.error.message);
      }
    } catch (e) {
      // 编排层的 db 调用（读状态/写水位线）也可能抛错，不能让它静默逃逸
      Alert.alert(t('data.err.generic'), String(e));
    } finally {
      setSyncing(false);
      load();
    }
  };

  const probeNow = async () => {
    setPinging(true);
    try {
      const results = await probeOnelapEndpoints();
      const lines = results.map((r) => {
        const host = r.url.replace(/^https?:\/\//, '');
        return r.reachable
          ? t('data.sync.pingOk', { host, ms: r.ms, status: r.status ?? 0 })
          : t('data.sync.pingFail', { host, detail: r.detail ?? '' });
      });
      Alert.alert(t('data.sync.pingTitle'), `${lines.join('\n')}\n\n${t('data.sync.pingNoAccount')}`);
    } catch (e) {
      Alert.alert(t('data.err.generic'), String(e));
    } finally {
      setPinging(false);
    }
  };

  const lastSyncLine = syncState?.last_sync_at
    ? `${syncState.last_sync_at.slice(0, 16).replace('T', ' ')} · ${
        syncState.last_result === 'ok' ? '✓' : `✗ ${syncState.last_error ?? ''}`
      }`
    : t('data.sync.never');
  const overrideBase = onelapOverrideBase();

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t('data.sync.title')}</Text>
      <Text style={styles.note}>{t('data.sync.desc')}</Text>
      {/* 联调构建显式自曝：避免把指向 mock 的包装到真机上用（曾发生过一次） */}
      {overrideBase != null && (
        <Text style={styles.warn}>{t('data.sync.devEndpoint', { url: overrideBase })}</Text>
      )}
      <TextInput
        label={t('data.sync.account')}
        value={account}
        onChangeText={setAccount}
        mode="outlined"
        dense
        autoCapitalize="none"
        keyboardType="email-address"
        style={styles.input}
      />
      <TextInput
        label={t('data.sync.password')}
        value={password}
        onChangeText={setPassword}
        mode="outlined"
        dense
        secureTextEntry
        style={styles.input}
      />
      <View style={styles.row}>
        <Button
          mode="contained"
          compact
          onPress={saveAccount}
          disabled={!account.trim() || !password || syncing}
        >
          {savedFlash ? t('data.sync.saved') : t('data.sync.save')}
        </Button>
        {hasAccount && (
          <Button mode="text" compact onPress={clearAccount} disabled={syncing}>
            {t('data.sync.clear')}
          </Button>
        )}
      </View>
      <Divider style={styles.divider} />
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{t('data.sync.auto')}</Text>
        <Switch value={syncState?.auto ?? false} onValueChange={toggleAuto} disabled={!syncState} />
      </View>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>{t('data.sync.last')}</Text>
        <Text style={styles.rowValue}>{lastSyncLine}</Text>
      </View>
      <View style={styles.row}>
        <Button
          mode="outlined"
          compact
          onPress={syncNow}
          disabled={syncing || pinging || !hasAccount}
          loading={syncing}
        >
          {syncing ? t('data.sync.doing') : t('data.sync.now')}
        </Button>
        {/* 测试连接：不需要账号，只验证能否连上顽鹿服务器（排查网络/被墙/改包问题） */}
        <Button
          mode="text"
          compact
          onPress={probeNow}
          disabled={syncing || pinging}
          loading={pinging}
        >
          {pinging ? t('data.sync.pingDoing') : t('data.sync.ping')}
        </Button>
      </View>
      {lastOutcome && !lastOutcome.error && (
        <Text style={styles.note}>
          {[
            t('data.sync.imported', { n: lastOutcome.imported }),
            t('data.sync.skipped', { n: lastOutcome.skipped }),
            ...(lastOutcome.duplicates > 0
              ? [t('data.sync.duplicates', { n: lastOutcome.duplicates })]
              : []),
            t('data.sync.failed', { n: lastOutcome.failed }),
          ].join(' · ')}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  cardTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  note: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  warn: { color: palette.red, fontSize: 12, lineHeight: 18 },
  input: { backgroundColor: palette.panel2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowLabel: { color: palette.text, fontSize: 13 },
  rowValue: { color: palette.muted, fontSize: 12, flexShrink: 1, textAlign: 'right' },
  divider: { backgroundColor: palette.lineSoft },
});
