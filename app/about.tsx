/**
 * about.tsx — 关于页（开源维护期新增，自「我的」入口进入）：品牌头（图标/名称/
 * 版本/slogan）、项目简介、仓库与联系入口（GitHub / Issues / 邮箱）、许可与声明
 * （MIT、顽鹿非官方接口）。素材口径与 README 一致；链接经 Linking 打开。
 */
import Constants from 'expo-constants';
import { useRouter } from 'expo-router';
import React from 'react';
import { Image, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Appbar, Divider, Icon, List } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

const REPO_URL = 'https://github.com/WallyYangGT/voltcoach';
const ISSUES_URL = `${REPO_URL}/issues`;
const CONTACT_EMAIL = 'wallys_studio@163.com';

export default function AboutScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  /** 打开外部链接（https / mailto）；失败静默——地址是编译期常量，无需兜底 UI */
  const openLink = (url: string) => {
    void Linking.openURL(url).catch(() => {});
  };

  return (
    <View style={styles.page}>
      <Appbar.Header style={styles.header} statusBarHeight={insets.top}>
        <Appbar.BackAction onPress={() => router.back()} />
        <Appbar.Content title={t('about.title')} titleStyle={styles.headerTitle} />
      </Appbar.Header>
      <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 12 }}>
        {/* 品牌头 */}
        <View style={[styles.card, styles.brandCard]}>
          <Image source={require('../assets/images/icon.png')} style={styles.logo} />
          <Text style={styles.brandName}>VoltCoach</Text>
          <Text style={styles.version}>v{Constants.expoConfig?.version ?? '0.0.0'}</Text>
          <Text style={styles.tagline}>{t('about.tagline')}</Text>
        </View>

        {/* 简介 */}
        <View style={styles.card}>
          <Text style={styles.body}>{t('about.intro')}</Text>
        </View>

        {/* 仓库与联系 */}
        <View style={styles.card}>
          <List.Item
            title={t('about.repo')}
            description={REPO_URL}
            left={(props) => <Icon {...props} size={20} source="github" color={palette.muted} />}
            right={(props) => <Icon {...props} size={18} source="chevron-right" color={palette.faint} />}
            onPress={() => openLink(REPO_URL)}
            titleStyle={{ color: palette.text }}
            descriptionStyle={{ color: palette.faint }}
          />
          <Divider style={styles.divider} />
          <List.Item
            title={t('about.issues')}
            left={(props) => <Icon {...props} size={20} source="bug-outline" color={palette.muted} />}
            right={(props) => <Icon {...props} size={18} source="chevron-right" color={palette.faint} />}
            onPress={() => openLink(ISSUES_URL)}
            titleStyle={{ color: palette.text }}
          />
          <Divider style={styles.divider} />
          <List.Item
            title={t('about.contact')}
            description={CONTACT_EMAIL}
            left={(props) => <Icon {...props} size={20} source="email-outline" color={palette.muted} />}
            right={(props) => <Icon {...props} size={18} source="chevron-right" color={palette.faint} />}
            onPress={() => openLink(`mailto:${CONTACT_EMAIL}`)}
            titleStyle={{ color: palette.text }}
            descriptionStyle={{ color: palette.faint }}
          />
        </View>

        {/* 许可与声明 */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('about.licenseTitle')}</Text>
          <Text style={styles.body}>{t('about.license')}</Text>
          <Text style={styles.note}>{t('about.thirdParty')}</Text>
          <Text style={styles.note}>{t('about.onelapNote')}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg },
  header: { backgroundColor: palette.bg, borderBottomWidth: 1, borderBottomColor: palette.lineSoft },
  headerTitle: { color: palette.text, fontSize: 18, fontWeight: '700' },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  brandCard: { alignItems: 'center', paddingVertical: 20 },
  logo: { width: 72, height: 72, borderRadius: 16 },
  brandName: { color: palette.text, fontSize: 22, fontWeight: '700', marginTop: 8 },
  version: { color: palette.volt, fontSize: 13, fontStyle: 'italic', fontVariant: ['tabular-nums'] },
  tagline: { color: palette.muted, fontSize: 12 },
  cardTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  body: { color: palette.text, fontSize: 13, lineHeight: 20 },
  note: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  divider: { backgroundColor: palette.lineSoft },
});
