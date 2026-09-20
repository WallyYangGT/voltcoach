/**
 * GlossaryModal.tsx — 首页「指标说明」弹窗（dash 标题旁「?」入口）
 *
 * 移植自 Web 版 views/dashboard.js 的 glossaryHtml + dash.glossary_title：
 * 术语表（gloss.0-10）与核心算法简介（gloss.a0-a4）词条逐字随迁（a4「AI 报告」
 * 随 M3 AI 层落地时补）。Web 用 showModal 弹窗，RN 用核心 Modal 全屏面板 + 滚动。
 */
import React from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 指标术语（gloss.N）与算法简介（gloss.aN）的词条序号 */
const METRIC_IDS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const ALGO_IDS = ['a0', 'a1', 'a2', 'a3', 'a4']; // a4「AI 报告」M3 起生效

export function GlossaryModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.panel} onPress={(e) => e.stopPropagation()}>
          <View style={styles.header}>
            <Text style={styles.title}>{t('gloss.title')}</Text>
            <Pressable hitSlop={12} onPress={onClose}>
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.body}>
            {METRIC_IDS.map((id) => (
              <View key={id} style={styles.entry}>
                <Text style={styles.term}>{t(`gloss.${id}.t` as never)}</Text>
                <Text style={styles.desc}>{t(`gloss.${id}.d` as never)}</Text>
              </View>
            ))}
            <Text style={styles.algoTitle}>{t('gloss.algo')}</Text>
            {ALGO_IDS.map((id) => (
              <View key={id} style={styles.entry}>
                <Text style={styles.term}>{t(`gloss.${id}.t` as never)}</Text>
                <Text style={styles.desc}>{t(`gloss.${id}.d` as never)}</Text>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(6,9,12,0.72)', justifyContent: 'flex-end' },
  panel: {
    backgroundColor: palette.bgSoft,
    borderTopColor: palette.lineSoft,
    borderTopWidth: 1,
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: '85%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 14,
    borderBottomColor: palette.lineSoft,
    borderBottomWidth: 1,
  },
  title: { color: palette.text, fontSize: 15, fontWeight: '700' },
  close: { color: palette.muted, fontSize: 16, padding: 4 },
  body: { padding: 14, gap: 12 },
  entry: { gap: 3 },
  term: { color: palette.volt, fontSize: 13, fontWeight: '700' },
  desc: { color: palette.muted, fontSize: 12.5, lineHeight: 19 },
  algoTitle: {
    color: palette.text,
    fontSize: 15,
    fontWeight: '700',
    marginTop: 6,
    borderTopColor: palette.lineSoft,
    borderTopWidth: 1,
    paddingTop: 14,
  },
});
