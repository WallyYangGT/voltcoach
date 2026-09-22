/**
 * data.tsx — 数据管理页（M4，自「我的」入口进入）：三卡布局
 *  - 顽鹿同步（§10.4）：账号绑定（SecureStore）/ 前台自动同步开关 / 立即同步与结果
 *  - 备份（§7.2）：可选口令导出并系统分享；DocumentPicker 导入（预览确认 + 版本闸门）
 *  - 本地快照：查看/手动创建/删除（auto-latest，导入训练后自动滚动）
 * 错误提示按 BackupError.code / SyncErrorCode 映射双语词条，原始信息随详情透出。
 */
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Button, Divider, Switch, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File } from 'expo-file-system';
import { createLocalSnapshot, deleteLocalSnapshot, exportBackupToCache, readLocalSnapshotInfo, type SnapshotInfo } from '@/backup/export';
import { importBackupFile } from '@/backup/import';
import { BackupError, checkSchemaVersion as gateVersion } from '@/backup/manifest';
import { unpackBackup } from '@/backup/archive';
import { SCHEMA_VERSION, getSyncState, setSyncState, type SyncState } from '@/db';
import { useI18n, type DictKey } from '@/i18n';
import { getOnelapAccount, runOnelapSync, setOnelapAccount, type SyncOutcome } from '@/services/syncOnelap';
import { palette } from '@/theme';

export default function DataScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // —— 顽鹿同步 ——
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [hasAccount, setHasAccount] = useState(false);
  const [syncState, setSyncStateLocal] = useState<SyncState | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<SyncOutcome | null>(null);

  // —— 备份 ——
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  const [importPass, setImportPass] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);

  // —— 本地快照 ——
  const [snapshot, setSnapshot] = useState<SnapshotInfo | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [acct, state, snap] = await Promise.all([getOnelapAccount(), getSyncState(), readLocalSnapshotInfo()]);
      setHasAccount(Boolean(acct));
      if (acct) setAccount(acct.account); // 只回填账号，密码保持密文位不回显
      setSyncStateLocal(state);
      setSnapshot(snap);
    } catch (e) {
      console.warn('数据管理页加载失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const describeError = (e: unknown): string => {
    if (e instanceof BackupError) {
      return t(`data.err.${e.code}` as DictKey) + (e.message && e.code !== e.message ? `\n${e.message}` : '');
    }
    return e instanceof Error ? e.message : String(e);
  };

  // ---------------- 顽鹿同步 ----------------

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
    } finally {
      setSyncing(false);
      load();
    }
  };

  // ---------------- 备份导出 / 导入 ----------------

  const doExport = async () => {
    if ((pass1 || pass2) && pass1 !== pass2) {
      Alert.alert(t('data.backup.passMismatch'));
      return;
    }
    setExporting(true);
    try {
      const { file } = await exportBackupToCache(pass1 ? pass1 : null);
      await Sharing.shareAsync(file.uri, { mimeType: 'application/zip', dialogTitle: t('data.backup.export') });
      Alert.alert(t('data.backup.exportDone'));
    } catch (e) {
      Alert.alert(t('data.err.generic'), describeError(e));
    } finally {
      setExporting(false);
    }
  };

  const doImport = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      const asset = res.assets?.[0];
      if (res.canceled || !asset) return;

      // 预览阶段先做结构校验与版本闸门（坏包/超前版本在确认前拦下）
      const bytes = await new File(asset.uri).bytes();
      const { manifest } = unpackBackup(bytes);
      gateVersion(manifest, SCHEMA_VERSION);
      Alert.alert(
        t('data.backup.confirmTitle'),
        t('data.backup.confirmMsg', {
          device: manifest.device,
          time: manifest.exported_at.slice(0, 16).replace('T', ' '),
          acts: manifest.counts.activities,
          recs: manifest.counts.records,
        }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          {
            text: t('data.backup.import'),
            style: 'destructive',
            onPress: () => {
              runImport(asset.uri);
            },
          },
        ],
      );
    } catch (e) {
      Alert.alert(t('data.err.generic'), describeError(e));
    }
  };

  const runImport = (uri: string) => {
    setImporting(true);
    importBackupFile(uri, importPass || null)
      .then((outcome) => {
        Alert.alert(t('data.backup.confirmTitle'), t('data.backup.importDone', { acts: outcome.activities, recs: outcome.records }));
      })
      .catch((e) => {
        Alert.alert(t('data.err.generic'), describeError(e));
      })
      .finally(() => {
        setImporting(false);
        setImportPass('');
        load();
      });
  };

  // ---------------- 本地快照 ----------------

  const makeSnapshot = async () => {
    setSnapshotting(true);
    try {
      await createLocalSnapshot();
      load();
    } catch (e) {
      Alert.alert(t('data.err.generic'), describeError(e));
    } finally {
      setSnapshotting(false);
    }
  };

  const removeSnapshot = () => {
    Alert.alert(t('data.snapshot.delete'), t('data.snapshot.desc'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () => {
          deleteLocalSnapshot();
          setSnapshot(null);
        },
      },
    ]);
  };

  const snapshotLine = snapshot
    ? `${snapshot.exported_at.slice(0, 16).replace('T', ' ')} · ${snapshot.counts.activities} · ${snapshot.counts.records}`
    : t('data.snapshot.none');
  const lastSyncLine = syncState?.last_sync_at
    ? `${syncState.last_sync_at.slice(0, 16).replace('T', ' ')} · ${
        syncState.last_result === 'ok' ? '✓' : `✗ ${syncState.last_error ?? ''}`
      }`
    : t('data.sync.never');

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={t('data.title')} titleStyle={styles.headerTitle} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}>
        <Text style={styles.sub}>{t('data.sub')}</Text>

        {/* 顽鹿同步 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('data.sync.title')}</Text>
          <Text style={styles.note}>{t('data.sync.desc')}</Text>
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
          <Button
            mode="outlined"
            compact
            onPress={syncNow}
            disabled={syncing || !hasAccount}
            loading={syncing}
          >
            {syncing ? t('data.sync.doing') : t('data.sync.now')}
          </Button>
          {lastOutcome && !lastOutcome.error && (
            <Text style={styles.note}>
              {[t('data.sync.imported', { n: lastOutcome.imported }), t('data.sync.skipped', { n: lastOutcome.skipped }), t('data.sync.failed', { n: lastOutcome.failed })].join(' · ')}
            </Text>
          )}
        </View>

        {/* 备份 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('data.backup.title')}</Text>
          <Text style={styles.note}>{t('data.backup.desc')}</Text>
          <TextInput
            label={t('data.backup.pass')}
            value={pass1}
            onChangeText={setPass1}
            mode="outlined"
            dense
            secureTextEntry
            style={styles.input}
          />
          <Text style={styles.hint}>{t('data.backup.passHint')}</Text>
          <TextInput
            label={t('data.backup.pass2')}
            value={pass2}
            onChangeText={setPass2}
            mode="outlined"
            dense
            secureTextEntry
            style={styles.input}
          />
          <Button mode="contained" compact onPress={doExport} disabled={exporting || importing} loading={exporting}>
            {exporting ? t('data.backup.exporting') : t('data.backup.export')}
          </Button>
          <Divider style={styles.divider} />
          <Text style={styles.warn}>{t('data.backup.importWarn')}</Text>
          <TextInput
            label={t('data.backup.importPass')}
            value={importPass}
            onChangeText={setImportPass}
            mode="outlined"
            dense
            secureTextEntry
            style={styles.input}
          />
          <Button mode="outlined" compact onPress={doImport} disabled={exporting || importing} loading={importing}>
            {importing ? t('data.backup.importing') : t('data.backup.import')}
          </Button>
        </View>

        {/* 本地快照 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('data.snapshot.title')}</Text>
          <Text style={styles.note}>{t('data.snapshot.desc')}</Text>
          <Text style={styles.rowValue}>{snapshotLine}</Text>
          <View style={styles.row}>
            <Button mode="outlined" compact onPress={makeSnapshot} disabled={snapshotting} loading={snapshotting}>
              {snapshotting ? t('data.snapshot.doing') : t('data.snapshot.create')}
            </Button>
            {snapshot && (
              <Button mode="text" compact onPress={removeSnapshot} disabled={snapshotting}>
                {t('data.snapshot.delete')}
              </Button>
            )}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, elevation: 0 },
  headerTitle: { color: palette.text, fontSize: 18, fontWeight: '700' },
  sub: { color: palette.muted, fontSize: 12 },
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
  hint: { color: palette.faint, fontSize: 11, lineHeight: 16, marginTop: -4 },
  warn: { color: palette.red, fontSize: 12, lineHeight: 18 },
  input: { backgroundColor: palette.panel2 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  rowLabel: { color: palette.text, fontSize: 13 },
  rowValue: { color: palette.muted, fontSize: 12, flexShrink: 1, textAlign: 'right' },
  divider: { backgroundColor: palette.lineSoft },
});
