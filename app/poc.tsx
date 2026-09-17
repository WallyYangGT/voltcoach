/**
 * M0 技术验证页（临时开发页，M0 结束后移除）。
 * 四项 PoC 各一张卡片：运行 → 状态徽章 + 明细（等宽小字）。
 */
import { Stack } from 'expo-router';
import { Button, Card, Chip, Text } from 'react-native-paper';
import { useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';
import { pocRunners } from '@/poc/registry';
import type { DictKey } from '@/i18n';
import type { PocResult } from '@/poc/types';

type Status = 'pending' | 'running' | 'pass' | 'fail';

const POCS: { id: 1 | 2 | 3 | 4; titleKey: DictKey; descKey: DictKey }[] = [
  { id: 1, titleKey: 'poc.1.title', descKey: 'poc.1.desc' },
  { id: 2, titleKey: 'poc.2.title', descKey: 'poc.2.desc' },
  { id: 3, titleKey: 'poc.3.title', descKey: 'poc.3.desc' },
  { id: 4, titleKey: 'poc.4.title', descKey: 'poc.4.desc' },
];

interface PocState {
  status: Status;
  detail: string;
}

const initial: PocState = { status: 'pending', detail: '' };

export default function PocScreen() {
  const { t } = useI18n();
  const [states, setStates] = useState<Record<1 | 2 | 3 | 4, PocState>>({
    1: initial,
    2: initial,
    3: initial,
    4: initial,
  });

  async function run(id: 1 | 2 | 3 | 4) {
    setStates((s) => ({ ...s, [id]: { status: 'running', detail: '' } }));
    let result: PocResult;
    try {
      result = await pocRunners[id]();
    } catch (err) {
      result = { pass: false, detail: `异常: ${String(err)}` };
    }
    setStates((s) => ({ ...s, [id]: { status: result.pass ? 'pass' : 'fail', detail: result.detail } }));
  }

  return (
    <ScrollView style={styles.page} contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 40 }}>
      <Stack.Screen options={{ headerShown: true, title: t('poc.title'), headerStyle: { backgroundColor: palette.bgSoft }, headerTintColor: palette.text }} />
      <Text variant="bodySmall" style={styles.subtitle}>
        {t('poc.subtitle')}
      </Text>
      {POCS.map(({ id, titleKey, descKey }) => {
        const state = states[id];
        return (
          <Card key={id} style={styles.card}>
            <Card.Content>
              <View style={styles.head}>
                <Text variant="titleSmall" style={styles.title}>
                  {t(titleKey)}
                </Text>
                <Chip
                  compact
                  textStyle={{ fontSize: 11 }}
                  style={[
                    styles.chip,
                    state.status === 'pass' && { borderColor: palette.green },
                    state.status === 'fail' && { borderColor: palette.red },
                    state.status === 'running' && { borderColor: palette.orange },
                  ]}>
                  {t(`poc.${state.status}` as DictKey)}
                </Chip>
              </View>
              <Text variant="bodySmall" style={styles.desc}>
                {t(descKey)}
              </Text>
              {state.detail ? (
                <Text variant="bodySmall" style={styles.detail} selectable>
                  {state.detail}
                </Text>
              ) : null}
              <Button
                mode="contained"
                compact
                onPress={() => run(id)}
                loading={state.status === 'running'}
                disabled={state.status === 'running'}
                style={{ alignSelf: 'flex-start', marginTop: 8 }}>
                {t('poc.run')}
              </Button>
            </Card.Content>
          </Card>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  subtitle: {
    color: palette.faint,
  },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
  },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  title: {
    color: palette.text,
    flex: 1,
  },
  chip: {
    backgroundColor: 'transparent',
    borderColor: palette.line,
    height: 26,
  },
  desc: {
    color: palette.muted,
    marginTop: 4,
  },
  detail: {
    color: palette.text,
    fontFamily: 'monospace',
    fontSize: 11,
    marginTop: 8,
    lineHeight: 16,
  },
});
