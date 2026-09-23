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
import { findDuplicateGroups } from '@/core/dedupe';
import { formatDuration } from '@/core/metrics';
import { copyStoredRecord, deleteStoredRecord } from '@/records-store';
import { invalidateReportTitles } from '@/services/aiTitle';
import {
  SCHEMA_VERSION,
  deleteActivity,
  getSyncState,
  listActivityRideKeys,
  mergeActivityExtras,
  retargetActivityRefs,
  setSyncState,
  type ActivityRideKey,
  type SyncState,
} from '@/db';
import { useI18n, type DictKey } from '@/i18n';
import {
  getOnelapAccount,
  onelapOverrideBase,
  probeOnelapEndpoints,
  runOnelapSync,
  setOnelapAccount,
  type SyncOutcome,
} from '@/services/syncOnelap';
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
  const [pinging, setPinging] = useState(false);
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

  // —— 重复记录检查（M5） ——
  const [dupGroups, setDupGroups] = useState<ActivityRideKey[][] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [merging, setMerging] = useState(false);

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
      // 分享完成后顺手清理 cache 产物（分享面板已拿到内容；删除失败不影响）
      try {
        if (file.exists) file.delete();
      } catch (e) {
        console.warn('导出产物清理失败（忽略）:', e);
      }
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

  // ---------------- 重复记录检查（M5） ----------------

  /** 扫描：全表骑行键 → core/dedupe 分组，只留重复组 */
  const scanDuplicates = async () => {
    setScanning(true);
    try {
      const rows = await listActivityRideKeys();
      const groups = findDuplicateGroups(rows).sort((a, b) => (a[0].date < b[0].date ? 1 : -1));
      setDupGroups(groups);
      if (!groups.length) Alert.alert(t('data.dupe.title'), t('data.dupe.none'));
    } catch (e) {
      Alert.alert(t('data.err.generic'), describeError(e));
    } finally {
      setScanning(false);
    }
  };

  const confirmMerge = () => {
    if (!dupGroups?.length) return;
    const extra = dupGroups.reduce((n, g) => n + g.length - 1, 0);
    Alert.alert(
      t('data.dupe.confirmTitle'),
      t('data.dupe.confirmMsg', { extra }),
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('data.dupe.merge'), style: 'destructive', onPress: () => void mergeDuplicates(extra) },
      ],
    );
  };

  /**
   * 合并：每组保留最早入库的一条（listActivityRideKeys 按 id 升序，g[0] 即保留项），
   * 副本的用户数据与 AI 引用先迁到保留项，再删行 + 删逐秒数据。
   * 不滚本地快照——保留删除前的快照才有误删可恢复性（与导入后滚快照的口径相反）。
   */
  const mergeDuplicates = async (extra: number) => {
    setMerging(true);
    let groups = 0;
    try {
      for (const g of dupGroups ?? []) {
        const keep = g[0];
        for (const drop of g.slice(1)) {
          await mergeActivityExtras(keep.file_name, drop.file_name);
          await retargetActivityRefs(drop.file_name, keep.file_name);
          await copyStoredRecord(drop.file_name, keep.file_name); // 保留项缺逐秒数据时接管
          await deleteActivity(drop.file_name);
          deleteStoredRecord(drop.file_name);
        }
        groups += 1;
      }
      setDupGroups(null);
      Alert.alert(t('data.dupe.title'), t('data.dupe.done', { groups, extra }));
    } catch (e) {
      Alert.alert(t('data.dupe.failed'), describeError(e));
      void scanDuplicates(); // 部分成功时刷新现状，避免界面停留在过期分组
    } finally {
      invalidateReportTitles(); // 保留项可能接管了副本的逐秒数据/引用 → 标题缓存全清
      setMerging(false);
      load();
    }
  };

  const snapshotLine = snapshot
    ? `${snapshot.exported_at.slice(0, 16).replace('T', ' ')} · ${snapshot.counts.activities} · ${snapshot.counts.records}`
    : t('data.snapshot.none');

  const lastSyncLine = syncState?.last_sync_at
    ? `${syncState.last_sync_at.slice(0, 16).replace('T', ' ')} · ${
        syncState.last_result === 'ok' ? '✓' : `✗ ${syncState.last_error ?? ''}`
      }`
    : t('data.sync.never');
  const overrideBase = onelapOverrideBase();

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

        {/* 重复记录检查（M5）：手动导入 × 云同步同一趟骑行会因文件名不同而两条 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('data.dupe.title')}</Text>
          <Text style={styles.note}>{t('data.dupe.desc')}</Text>
          {dupGroups != null && (
            <Text style={dupGroups.length ? styles.warn : styles.note}>
              {dupGroups.length
                ? t('data.dupe.found', {
                    groups: dupGroups.length,
                    extra: dupGroups.reduce((n, g) => n + g.length - 1, 0),
                  })
                : t('data.dupe.none')}
            </Text>
          )}
          {/* 逐组列出重复项：让用户在合并前看清保留谁、删谁 */}
          {dupGroups?.map((g) => (
            <View key={g[0].file_name} style={styles.dupGroup}>
              <Text style={styles.dupGroupHead}>
                {g[0].date} · {formatDuration(g[0].duration_sec)} ·{' '}
                {/* 距离口径与训练列表一致（先按 0.1km 取整再显示，避免列表 18.00 / 此处 17.99 打架） */}
                {g[0].distance_km != null ? `${(Math.round(g[0].distance_km * 10) / 10).toFixed(2)} km` : '—'}
              </Text>
              {g.map((r, i) => (
                <Text key={r.file_name} style={i === 0 ? styles.dupKeep : styles.dupDrop} numberOfLines={1}>
                  {i === 0 ? `✓ ${t('data.dupe.keep')}` : `✗ ${t('common.delete')}`} · {r.file_name}
                </Text>
              ))}
            </View>
          ))}
          <View style={styles.row}>
            <Button mode="outlined" compact onPress={scanDuplicates} disabled={scanning || merging} loading={scanning}>
              {scanning ? t('data.dupe.scanning') : t('data.dupe.scan')}
            </Button>
            {dupGroups != null && dupGroups.length > 0 && (
              <Button mode="contained" compact buttonColor={palette.red} textColor={palette.text} onPress={confirmMerge} disabled={merging} loading={merging}>
                {t('data.dupe.merge')}
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
  dupGroup: { backgroundColor: palette.panel2, borderRadius: 8, padding: 10, gap: 4 },
  dupGroupHead: { color: palette.text, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dupKeep: { color: palette.green, fontSize: 11 },
  dupDrop: { color: palette.muted, fontSize: 11 },
});
