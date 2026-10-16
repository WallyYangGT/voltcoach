/**
 * SyncCard — 云同步卡（多平台，2026-10-16 由 OnelapSyncCard 泛化）
 *
 * 形态：平台下拉（默认顽鹿）→ 平台专属凭据表单 → 自动同步开关 / 上次同步 /
 * 立即同步 / 测试连接 / 结果计数。原先内嵌在数据管理页，M5 收尾后按反馈挪到
 * 「我的」页 AI 服务下方——绑定账号属于账号类配置，与 AI 服务同类。
 *
 * 单账户互斥：下拉选中的平台即「当前生效平台」（settings sync 行的 provider 字段），
 * 只有它会自动同步。切到别的平台时**不动**原平台的凭据与水位线（SecureStore 按平台
 * 分键、状态行按平台分槽），切回即恢复、不重拉历史；离开已绑定的平台时弹一次确认，
 * 避免误触停掉正在工作的同步源。
 *
 * 平台差异全部来自 src/services/syncProviders.ts 的适配器：本卡按 authKind 渲染
 * password（账号密码）或 oauth（浏览器授权）表单，不认识任何具体平台的协议。
 * 错误提示按 SyncErrorCode 映射双语词条（data.sync.* 键沿用 M4 命名空间）。
 */
import { useFocusEffect } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, StyleSheet, Text, View } from 'react-native';
import { Button, Divider, Icon, Switch, TextInput, TouchableRipple } from 'react-native-paper';
import { getSyncState, setSyncState, type SyncState } from '@/db';
import { useI18n } from '@/i18n';
import { runSync, type SyncOutcome } from '@/services/sync';
import { allProviders, providerById, type SyncProvider } from '@/services/syncProviders';
import { palette } from '@/theme';

export function SyncCard() {
  const { t } = useI18n();

  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [hasAccount, setHasAccount] = useState(false);
  const [syncState, setSyncStateLocal] = useState<SyncState | null>(null);
  const [providerMenu, setProviderMenu] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [pinging, setPinging] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null);
  // 「已保存 ✓」flash 的定时器：组件卸载时清理（否则定时器在卸载后 setState，
  // 且 jest 域里会让 worker 进程挂着定时器无法优雅退出）
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  const providers = allProviders();
  const active: SyncProvider | null = syncState ? providerById(syncState.provider) : null;
  const activeState = syncState && active ? syncState.providers[active.id] : undefined;

  const load = useCallback(async () => {
    try {
      const state = await getSyncState();
      setSyncStateLocal(state);
      const provider = providerById(state.provider);
      const creds = await provider.loadCredentials();
      setHasAccount(Boolean(creds));
      // 只回填账号且仅在输入框为空时（卡片在 tab 页，聚焦频繁，避免覆盖编辑中的草稿）；
      // 密码保持密文位不回显
      if (creds?.kind === 'password') {
        setAccount((cur) => (cur.trim() === '' ? creds.account : cur));
      }
    } catch (e) {
      console.warn('云同步卡加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  /** 选中平台 = 切「当前生效平台」；离开已绑定的平台先确认（避免误触停掉生效中的同步） */
  const pickProvider = (target: SyncProvider) => {
    setProviderMenu(false);
    if (!syncState || target.id === syncState.provider) return;
    const apply = async () => {
      try {
        await setSyncState({ ...syncState, provider: target.id });
        setAccount('');
        setPassword('');
        setLastOutcome(null);
        await load();
      } catch (e) {
        Alert.alert(t('data.err.generic'), String(e));
      }
    };
    if (!hasAccount || !active) {
      void apply();
      return;
    }
    Alert.alert(
      t('data.sync.switchTitle'),
      t('data.sync.switchMsg', { from: t(active.labelKey), to: t(target.labelKey) }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('data.sync.switchOk'), onPress: () => void apply() },
      ],
    );
  };

  const saveAccount = async () => {
    if (!active || !account.trim() || !password) return;
    try {
      await active.saveCredentials({ kind: 'password', account, password });
      setHasAccount(true);
      setPassword('');
      setSavedFlash(true);
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setSavedFlash(false), 2000);
    } catch (e) {
      Alert.alert(t('data.err.generic'), String(e));
    }
  };

  const clearAccount = () => {
    if (!active) return;
    Alert.alert(t('data.sync.clear'), t('data.sync.account'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('data.sync.clear'),
        style: 'destructive',
        onPress: async () => {
          await active.clearCredentials();
          setAccount('');
          setPassword('');
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
      const outcome = await runSync();
      setLastOutcome(outcome);
      if (outcome.error?.code === 'no_account') {
        Alert.alert(t('data.sync.err.no_account'));
      } else if (outcome.error?.code === 'auth') {
        Alert.alert(t('data.sync.err.auth'), outcome.error.message);
      } else if (outcome.error?.code === 'reauth') {
        Alert.alert(t('data.sync.err.reauth'), outcome.error.message);
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
    if (!active) return;
    setPinging(true);
    try {
      const results = await active.probe();
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

  const lastSyncLine = activeState?.last_sync_at
    ? `${activeState.last_sync_at.slice(0, 16).replace('T', ' ')} · ${
        activeState.last_result === 'ok' ? '✓' : `✗ ${activeState.last_error ?? ''}`
      }`
    : t('data.sync.never');
  const overrideBase = active?.overrideBase() ?? null;

  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{t('data.sync.title')}</Text>
      <Text style={styles.note}>{t('data.sync.desc')}</Text>
      {/* 联调构建显式自曝：避免把指向 mock 的包装到真机上用（曾发生过一次） */}
      {overrideBase != null && (
        <Text style={styles.warn}>{t('data.sync.devEndpoint', { url: overrideBase })}</Text>
      )}
      {/* 平台选择（默认顽鹿）：点行展开列表，选中即切换生效平台，其余平台凭据/水位线保留。
          刻意不用 Paper 的 Menu/Portal：平台名很长（「迹驰 iGPSPORT（国内）」）整行更好读，
          且 Portal 的入场渲染在 jest 里跨用例不可靠（L4 断言会假红），内联展开两种环境行为一致 */}
      <TouchableRipple
        onPress={() => setProviderMenu((v) => !v)}
        style={styles.pickerRow}
        testID="platform-picker"
        accessibilityRole="button"
      >
        <View style={styles.pickerInner}>
          <Text style={styles.pickerLabel}>{t('data.sync.platform')}</Text>
          <Text style={styles.pickerValue}>{active ? t(active.labelKey) : ''}</Text>
          <Icon source={providerMenu ? 'menu-up' : 'menu-down'} size={18} color={palette.muted} />
        </View>
      </TouchableRipple>
      {providerMenu && (
        <View style={styles.optionList}>
          {providers.map((p) => (
            <TouchableRipple
              key={p.id}
              onPress={() => pickProvider(p)}
              style={styles.optionRow}
              testID={`platform-option-${p.id}`}
              accessibilityRole="button"
            >
              <View style={styles.optionInner}>
                <Icon
                  source={active?.id === p.id ? 'check' : 'circle-outline'}
                  size={16}
                  color={active?.id === p.id ? palette.volt : palette.muted}
                />
                <Text style={[styles.optionLabel, active?.id === p.id && styles.optionLabelActive]}>
                  {t(p.labelKey)}
                </Text>
              </View>
            </TouchableRipple>
          ))}
        </View>
      )}
      {active && (
        <Text style={styles.note}>
          {hasAccount
            ? t('data.sync.activeBound', { name: t(active.labelKey) })
            : t('data.sync.activeUnbound', { name: t(active.labelKey) })}
        </Text>
      )}
      {active?.authKind === 'password' && (
        <>
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
        </>
      )}
      {/* oauth 型平台（Wahoo）的授权表单随该平台落地后接入此分支 */}
      <View style={styles.row}>
        {active?.authKind === 'password' && (
          <Button
            mode="contained"
            compact
            onPress={saveAccount}
            disabled={!account.trim() || !password || syncing}
          >
            {savedFlash ? t('data.sync.saved') : t('data.sync.save')}
          </Button>
        )}
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
        {/* 测试连接：不需要账号，只验证能否连上该平台服务器（排查网络/被墙/改包问题） */}
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
  // 平台选择（内联展开，不用 Portal——见组件内注释）
  pickerRow: {
    borderColor: palette.lineSoft,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: palette.panel2,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  pickerInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pickerLabel: { color: palette.muted, fontSize: 12 },
  pickerValue: { color: palette.text, fontSize: 13, flex: 1 },
  optionList: {
    borderColor: palette.lineSoft,
    borderRadius: 8,
    borderWidth: 1,
    overflow: 'hidden',
  },
  optionRow: { borderTopColor: palette.lineSoft, borderTopWidth: StyleSheet.hairlineWidth },
  optionInner: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  optionLabel: { color: palette.text, fontSize: 13 },
  optionLabelActive: { color: palette.volt, fontWeight: '700' },
  warn: { color: palette.red, fontSize: 12, lineHeight: 18 },
  input: { backgroundColor: palette.panel2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowLabel: { color: palette.text, fontSize: 13 },
  rowValue: { color: palette.muted, fontSize: 12, flexShrink: 1, textAlign: 'right' },
  divider: { backgroundColor: palette.lineSoft },
});
