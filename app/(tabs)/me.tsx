/**
 * 「我的」占位 — M2 落地设置主体。
 * 当前提供：界面语言切换（验证 i18n 双语链路）+ 未来入口列表。
 */
import { Card, Divider, Icon, List, SegmentedButtons, Text } from 'react-native-paper';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export default function MeScreen() {
  const { lang, setLang, t } = useI18n();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.page, { paddingTop: insets.top + 16 }]}>
      <Text variant="headlineMedium" style={styles.title}>
        {t('me.title')}
      </Text>
      <Card style={styles.card}>
        <Card.Content>
          <Text variant="bodyMedium" style={styles.muted}>
            {t('me.placeholder')}
          </Text>
        </Card.Content>
      </Card>

      <Card style={styles.card}>
        <Card.Content>
          <Text variant="labelLarge" style={styles.label}>
            {t('me.lang')}
          </Text>
          <SegmentedButtons
            value={lang}
            onValueChange={(v) => setLang(v === 'en' ? 'en' : 'zh')}
            buttons={[
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ]}
            style={{ marginTop: 8 }}
          />
        </Card.Content>
      </Card>

      <Card style={styles.card}>
        <List.Item
          title={t('me.memory')}
          left={(props) => <Icon {...props} size={20} source="brain" color={palette.muted} />}
          right={() => <Text style={styles.soon}>{t('me.soon')}</Text>}
          titleStyle={{ color: palette.text }}
        />
        <Divider />
        <List.Item
          title={t('me.data')}
          left={(props) => <Icon {...props} size={20} source="database" color={palette.muted} />}
          right={() => <Text style={styles.soon}>{t('me.soon')}</Text>}
          titleStyle={{ color: palette.text }}
        />
        <Divider />
        <List.Item
          title={t('me.about')}
          left={(props) => <Icon {...props} size={20} source="information-outline" color={palette.muted} />}
          right={() => <Text style={styles.soon}>{t('me.soon')}</Text>}
          titleStyle={{ color: palette.text }}
        />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: palette.bg,
    paddingHorizontal: 16,
    gap: 12,
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
  muted: {
    color: palette.muted,
    lineHeight: 22,
  },
  label: {
    color: palette.muted,
  },
  soon: {
    color: palette.faint,
    fontSize: 12,
  },
});
