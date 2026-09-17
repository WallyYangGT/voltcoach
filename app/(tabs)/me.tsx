/**
 * 「我的」占位 — M2 落地设置主体。
 * M0 阶段提供：界面语言切换（验证 i18n 双语链路）+ 未来入口列表 + PoC 验证页入口。
 */
import { Link } from 'expo-router';
import { Card, Divider, Icon, List, SegmentedButtons, Text } from 'react-native-paper';
import { StyleSheet, View } from 'react-native';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

export default function MeScreen() {
  const { lang, setLang, t } = useI18n();
  return (
    <View style={styles.page}>
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

      {/* M0 临时入口：技术验证页（M0 结束后移除） */}
      <Link href="/poc" asChild>
        <Card style={styles.pocCard}>
          <Card.Content>
            <Text variant="labelLarge" style={{ color: palette.volt }}>
              {t('poc.title')} →
            </Text>
          </Card.Content>
        </Card>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: palette.bg,
    padding: 16,
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
  pocCard: {
    backgroundColor: palette.panel,
    borderColor: palette.voltDim,
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
