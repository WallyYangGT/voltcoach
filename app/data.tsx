/**
 * data.tsx — 数据管理页（M4，自「我的」入口进入）：备份 / 本地快照 / 重复记录三卡布局
 *  - 备份：可选口令导出——保存到本机（SAF 目录直存）或系统分享；DocumentPicker
 *    选包 → 预检（版本闸门）→ 弹对话框（来源信息 + 可选口令，仅加密包显示口令框）
 *    → 确认执行，口令错误原地重试不重选包
 *  - 本地快照：查看/手动创建/删除（auto-latest，导入训练后自动滚动）
 *  - 重复记录检查（M5）：内容指纹找重 + 人工确认合并
 * 顽鹿同步卡原在此处，M5 收尾后按反馈挪至「我的」页 AI 服务下方（src/components/
 * OnelapSyncCard.tsx，逻辑未动）。错误提示按 BackupError.code 映射双语词条，原始
 * 信息随详情透出。
 */
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { deleteAsync, EncodingType, StorageAccessFramework } from 'expo-file-system/legacy';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Button, Dialog, Divider, Portal, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { File } from 'expo-file-system';
import { createLocalSnapshot, deleteLocalSnapshot, buildBackup, exportBackupToCache, readLocalSnapshotInfo, type SnapshotInfo } from '@/backup/export';
import { importBackupFile } from '@/backup/import';
import { BackupError, checkSchemaVersion as gateVersion, type BackupManifest } from '@/backup/manifest';
import { bytesToBase64, unpackBackup } from '@/backup/archive';
import { findDuplicateGroups } from '@/core/dedupe';
import { formatDuration } from '@/core/metrics';
import { copyStoredRecord, deleteStoredRecord } from '@/records-store';
import { invalidateReportTitles, useRideDateLabels } from '@/services/aiTitle';
import { listRideKeysForDedupe } from '@/services/dedupe';
import {
  SCHEMA_VERSION,
  deleteActivity,
  mergeActivityExtras,
  retargetActivityRefs,
  type ActivityRideKey,
  rebuildDossierQuietly,
} from '@/db';
import { useI18n, type DictKey } from '@/i18n';
import { palette } from '@/theme';

export default function DataScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // —— 备份 ——
  const [pass1, setPass1] = useState('');
  const [pass2, setPass2] = useState('');
  // 导入对话框：选包并预检通过后弹出（先选包后输口令），含来源信息与可选口令框
  const [pendingImport, setPendingImport] = useState<{ uri: string; manifest: BackupManifest } | null>(null);
  const [dialogPass, setDialogPass] = useState('');
  const [exporting, setExporting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);

  // —— 本地快照 ——
  const [snapshot, setSnapshot] = useState<SnapshotInfo | null>(null);
  const [snapshotting, setSnapshotting] = useState(false);

  // —— 重复记录检查（M5） ——
  const [dupGroups, setDupGroups] = useState<ActivityRideKey[][] | null>(null);
  // 重复组头日期按本地日历日展示（双口径统一，与训练列表同源同口径）
  const dateLabels = useRideDateLabels((dupGroups ?? []).map((g) => g[0]?.file_name));
  const [scanning, setScanning] = useState(false);
  const [merging, setMerging] = useState(false);

  const load = useCallback(async () => {
    try {
      setSnapshot(await readLocalSnapshotInfo());
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

  /**
   * 保存到本机：SAF（存储访问框架）目录选择器直存用户选定的文件夹——分享面板上
   * 没有「保存到文件」目标的设备（用户真机实测）无法经分享落盘，这是独立出口。
   * 先要目录授权再打包：用户取消授权就静默返回，不做无谓的全库打包；包字节经
   * base64 写入 SAF 内容 uri（mime 记 zip，文件名与 cache 导出同一套时间戳规则）。
   * 已知边界：legacy SAF 写入只对 externalstorage 类 provider（本机存储
   * Download/Documents 等）持有写权限，网盘类目录会报不可写——主用途即本机落盘，
   * 接受该边界。仅 Android 提供（iOS 无 SAF，保留系统分享路径）。
   */
  const doSaveLocal = async () => {
    if ((pass1 || pass2) && pass1 !== pass2) {
      Alert.alert(t('data.backup.passMismatch'));
      return;
    }
    const perms = await StorageAccessFramework.requestDirectoryPermissionsAsync().catch((e) => {
      Alert.alert(t('data.err.generic'), describeError(e));
      return null;
    });
    if (!perms?.granted) return;
    setSaving(true);
    let createdUri: string | null = null;
    try {
      const { bytes, manifest } = await buildBackup(pass1 ? pass1 : null);
      const stamp = manifest.exported_at.replace(/[-:T]/g, '').slice(0, 14);
      const name = `voltcoach-backup-${stamp}.fitbackup`;
      createdUri = await StorageAccessFramework.createFileAsync(perms.directoryUri, name, 'application/zip');
      await StorageAccessFramework.writeAsStringAsync(createdUri, bytesToBase64(bytes), { encoding: EncodingType.Base64 });
      Alert.alert(t('data.backup.savedLocal', { name }));
    } catch (e) {
      // 写入失败清理已建出的半截文件（SAF 建文件即落盘，0 字节包会被误当有效备份）
      if (createdUri) {
        try {
          await deleteAsync(createdUri, { idempotent: true });
        } catch (cleanupErr) {
          console.warn('备份包残留清理失败（忽略）:', cleanupErr);
        }
      }
      Alert.alert(t('data.err.generic'), describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const doImport = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({ multiple: false, copyToCacheDirectory: true });
      const asset = res.assets?.[0];
      if (res.canceled || !asset) return;

      // 弹框前先做结构校验与版本闸门（坏包/超前版本在确认前拦下）
      const bytes = await new File(asset.uri).bytes();
      const { manifest } = unpackBackup(bytes);
      gateVersion(manifest, SCHEMA_VERSION);
      setDialogPass('');
      setPendingImport({ uri: asset.uri, manifest });
    } catch (e) {
      Alert.alert(t('data.err.generic'), describeError(e));
    }
  };

  /**
   * 执行导入（口令来自导入对话框）。wrong_key/passphrase_required 时对话框不关、
   * 口令清空——用户原地重试，不必重新选包；其他失败关对话框（包本身有问题，
   * 原地重试无意义）。
   */
  const runImport = (uri: string, pass: string | null) => {
    setImporting(true);
    importBackupFile(uri, pass)
      .then((outcome) => {
        setPendingImport(null);
        invalidateReportTitles(); // 整库被替换：活动行与 records 全变了，标题缓存必须全清
        Alert.alert(t('data.backup.confirmTitle'), t('data.backup.importDone', { acts: outcome.activities, recs: outcome.records }));
      })
      .catch((e) => {
        const retryable = e instanceof BackupError && (e.code === 'wrong_key' || e.code === 'passphrase_required');
        if (retryable) setDialogPass('');
        else {
          setPendingImport(null);
          // 非可重试失败可能发生在整库替换之后（如 records 落盘/迁移中途出错）：
          // 起骑时刻缓存可能已陈旧，照样清掉——室内判重/标题都依赖它
          invalidateReportTitles();
        }
        Alert.alert(t('data.err.generic'), describeError(e));
      })
      .finally(() => {
        setImporting(false);
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

  /** 扫描：全表骑行键（无有效距离的室内行按需补起骑时刻）→ core/dedupe 分组，只留重复组。silent=true 时不弹「没有重复」（供失败后静默刷新用） */
  const scanDuplicates = async (silent = false) => {
    setScanning(true);
    try {
      const rows = await listRideKeysForDedupe();
      const groups = findDuplicateGroups(rows).sort((a, b) => (a[0].date < b[0].date ? 1 : -1));
      setDupGroups(groups);
      if (!groups.length && !silent) Alert.alert(t('data.dupe.title'), t('data.dupe.none'));
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
      // 失败原因先弹（随后静默刷新现状，避免又一个 Alert 把它顶掉）
      Alert.alert(t('data.dupe.failed'), describeError(e));
      void scanDuplicates(true);
    } finally {
      invalidateReportTitles(); // 保留项可能接管了副本的逐秒数据/引用 → 标题缓存全清
      void rebuildDossierQuietly(); // 副本行已删，档案基线随之更新
      setMerging(false);
      load();
    }
  };

  const snapshotLine = snapshot
    ? `${snapshot.exported_at.slice(0, 16).replace('T', ' ')} · ${snapshot.counts.activities} · ${snapshot.counts.records}`
    : t('data.snapshot.none');

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={t('data.title')} titleStyle={styles.headerTitle} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}>
        <Text style={styles.sub}>{t('data.sub')}</Text>

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
          <View style={styles.row}>
            <Button
              mode="contained"
              compact
              style={{ flex: 1 }}
              onPress={doExport}
              disabled={exporting || saving || importing}
              loading={exporting}>
              {exporting ? t('data.backup.exporting') : t('data.backup.export')}
            </Button>
            {/* 保存到本机走 Android SAF（iOS 无此机制，仅保留系统分享） */}
            {Platform.OS === 'android' && (
              <Button
                mode="outlined"
                compact
                style={{ flex: 1 }}
                onPress={() => void doSaveLocal()}
                disabled={exporting || saving || importing}
                loading={saving}>
                {saving ? t('data.backup.saving') : t('data.backup.saveLocal')}
              </Button>
            )}
          </View>
          <Divider style={styles.divider} />
          <Text style={styles.warn}>{t('data.backup.importWarn')}</Text>
          <Button mode="outlined" compact onPress={() => void doImport()} disabled={exporting || saving || importing} loading={importing}>
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
                {dateLabels.get(g[0].file_name) ?? g[0].date} · {formatDuration(g[0].duration_sec)} ·{' '}
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
            <Button mode="outlined" compact onPress={() => void scanDuplicates()} disabled={scanning || merging} loading={scanning}>
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

      {/* 导入确认对话框（先选包后弹）：来源信息 + 口令框（仅口令加密包显示）。
          importing 期间不可关闭（遮罩/返回键/取消全禁）——覆盖式导入进行中"看似
          取消实则继续"的认知落差是数据替换级别，必须锁死 */}
      <Portal>
        <Dialog
          visible={pendingImport != null}
          dismissable={!importing}
          onDismiss={() => {
            if (!importing) setPendingImport(null);
          }}
          style={{ backgroundColor: palette.panel }}
        >
          <Dialog.Title style={{ color: palette.text }}>{t('data.backup.confirmTitle')}</Dialog.Title>
          <Dialog.Content>
            {pendingImport && (
              <Text style={styles.note}>
                {t('data.backup.confirmMsg', {
                  device: pendingImport.manifest.device,
                  time: pendingImport.manifest.exported_at.slice(0, 16).replace('T', ' '),
                  acts: pendingImport.manifest.counts.activities,
                  recs: pendingImport.manifest.counts.records,
                })}
              </Text>
            )}
            {/* db_key 为空 = 包内库由口令加密（manifest 口径），才需要口令；未加密包直接确认 */}
            {pendingImport?.manifest.db_key == null && (
              <TextInput
                label={t('data.backup.importPass')}
                value={dialogPass}
                onChangeText={setDialogPass}
                mode="outlined"
                dense
                secureTextEntry
                style={styles.input}
              />
            )}
          </Dialog.Content>
          <Dialog.Actions>
            <Button onPress={() => setPendingImport(null)} disabled={importing}>
              {t('common.cancel')}
            </Button>
            <Button
              loading={importing}
              disabled={importing}
              textColor={palette.red}
              onPress={() => {
                if (pendingImport) runImport(pendingImport.uri, dialogPass || null);
              }}>
              {t('data.backup.importConfirm')}
            </Button>
          </Dialog.Actions>
        </Dialog>
      </Portal>
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
  rowValue: { color: palette.muted, fontSize: 12, flexShrink: 1, textAlign: 'right' },
  divider: { backgroundColor: palette.lineSoft },
  dupGroup: { backgroundColor: palette.panel2, borderRadius: 8, padding: 10, gap: 4 },
  dupGroupHead: { color: palette.text, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  dupKeep: { color: palette.green, fontSize: 11 },
  dupDrop: { color: palette.muted, fontSize: 11 },
});

// 路由级错误边界（架构评审 T2）：本屏渲染异常在此兜底，不再冒泡到根边界丢失导航位置
export { ErrorScreen as ErrorBoundary } from '@/components/ErrorScreen';
