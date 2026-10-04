/**
 * data.tsx — 数据管理页（M4，自「我的」入口进入）：备份 / 本地快照 / 重复记录三卡布局
 *  - 备份（§7.2）：可选口令导出并系统分享；DocumentPicker 导入（预览确认 + 版本闸门）
 *  - 本地快照：查看/手动创建/删除（auto-latest，导入训练后自动滚动）
 *  - 重复记录检查（M5）：内容指纹找重 + 人工确认合并
 * 顽鹿同步卡原在此处，M5 收尾后按反馈挪至「我的」页 AI 服务下方（src/components/
 * OnelapSyncCard.tsx，逻辑未动）。错误提示按 BackupError.code 映射双语词条，原始
 * 信息随详情透出。
 */
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Button, Divider, TextInput } from 'react-native-paper';
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
  listActivityRideKeys,
  mergeActivityExtras,
  retargetActivityRefs,
  type ActivityRideKey,
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
        invalidateReportTitles(); // 整库被替换：活动行与 records 全变了，标题缓存必须全清
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

  /** 扫描：全表骑行键 → core/dedupe 分组，只留重复组。silent=true 时不弹「没有重复」（供失败后静默刷新用） */
  const scanDuplicates = async (silent = false) => {
    setScanning(true);
    try {
      const rows = await listActivityRideKeys();
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
