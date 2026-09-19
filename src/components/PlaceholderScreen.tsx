/**
 * 里程碑占位屏（M0 骨架用）：标题 + 说明卡。
 * 各 tab 真实功能在 M1–M3 落地后逐个替换。
 */
import { Card, Text } from 'react-native-paper';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import type { DictKey } from '@/i18n';

export function PlaceholderScreen({ titleKey, bodyKey }: { titleKey: DictKey; bodyKey: DictKey }) {
  const { t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, { paddingTop: insets.top + 16 }]}>
      <Text variant="headlineMedium" style={styles.title}>
        {t(titleKey)}
      </Text>
      <Card style={styles.card}>
        <Card.Content>
          <Text variant="bodyMedium" style={styles.body}>
            {t(bodyKey)}
          </Text>
        </Card.Content>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: palette.bg,
    paddingHorizontal: 16,
    gap: 16,
  },
  title: {
    color: palette.text,
    fontWeight: '700',
  },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
  },
  body: {
    color: palette.muted,
    lineHeight: 22,
  },
});
