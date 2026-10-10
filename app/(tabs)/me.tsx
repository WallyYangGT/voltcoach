/**
 * 「我的」（M2 设置主体 + M3 AI 服务配置）：骑手摘要卡（FTP/最大心率/体重 + 当前
 * form 状态）+ 骑手参数表单 + 身份与训练目标 + AI 服务配置（BYOK，密钥存 Keystore；
 * 服务商预设下拉做快速填充）+ 顽鹿同步卡（OnelapSyncCard，M5 收尾后自数据管理页
 * 挪入）+ 界面语言 + 入口行（AI 记忆/数据管理/关于）。
 * 移植自 Web 版 views/settings.js（骑手参数/身份目标/AI 服务三面板；数据管理属 M4
 * 留入口行）；校验在 db 层（setAthlete/setProfile/setAiConfig 双语 Error，界面 Alert
 * 透传）。未配置骑手参数时顶部 banner 引导（不强制锁定）。
 */
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useRef, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button, Divider, Icon, List, Menu, SegmentedButtons, Switch, TextInput } from 'react-native-paper';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  AI_PROVIDER_PRESETS,
  matchPresetByBaseUrl,
  type AiProviderPreset,
} from '@/ai/providerPresets';
import { OnelapSyncCard } from '@/components/OnelapSyncCard';
import type { FormSnapshot } from '@/core/form';
import type { AthleteParams } from '@/core/settings';
import { computeForm, getAiConfig, getAthleteState, getProfile, setAiConfig, setAthlete, setProfile } from '@/db';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 摘要卡数据包（loading 态 null） */
interface MeData {
  athlete: AthleteParams;
  configured: boolean;
  form: FormSnapshot | null;
}

export default function MeScreen() {
  const { lang, setLang, t } = useI18n();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [data, setData] = useState<MeData | null>(null);
  // 表单草稿（TextInput 字符串；每次聚焦从库值重灌，保证外部改动可见）
  const [ftp, setFtp] = useState('');
  const [maxhr, setMaxhr] = useState('');
  const [weight, setWeight] = useState('');
  const [identity, setIdentity] = useState('');
  const [goal, setGoal] = useState('');
  const [savedFlash, setSavedFlash] = useState<'athlete' | 'profile' | 'ai' | null>(null);
  const [savingAthlete, setSavingAthlete] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  // AI 服务配置（M3）：草稿为字符串（TextInput），生效值在库/Keystore
  const [aiKey, setAiKey] = useState('');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiTemp, setAiTemp] = useState('');
  const [aiTimeout, setAiTimeout] = useState('');
  const [aiStall, setAiStall] = useState('');
  const [aiStream, setAiStream] = useState(false);
  const [aiAgentic, setAiAgentic] = useState(true);
  const [showAiKey, setShowAiKey] = useState(false);
  const [savingAi, setSavingAi] = useState(false);
  // AI 配置草稿只在首次加载重灌：字段多且含密钥，focus 反复重灌会静默丢弃编辑中的修改
  const aiDraftLoadedRef = useRef(false);
  // 服务商预设下拉（src/ai/providers.json 驱动的快速填充；地址不匹配任何预设即视为自定义）
  const [providerMenu, setProviderMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);

  const load = useCallback(async () => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [state, form, prof, ai] = await Promise.all([
        getAthleteState(),
        computeForm(today, lang),
        getProfile(),
        getAiConfig(),
      ]);
      setData({ athlete: state.athlete, configured: state.configured, form });
      setFtp(String(state.athlete.ftp_watts));
      setMaxhr(String(state.athlete.max_hr));
      setWeight(String(state.athlete.weight_kg));
      setIdentity(prof.identity);
      setGoal(prof.goal);
      if (!aiDraftLoadedRef.current) {
        aiDraftLoadedRef.current = true;
        // AI 表单草稿从生效值重灌（key 回显明文，口径同 Web 版本地单用户应用）
        setAiKey(ai.config.api_key ?? '');
        setAiBaseUrl(ai.config.base_url);
        setAiModel(ai.config.model);
        setAiTemp(ai.config.temperature == null ? '' : String(ai.config.temperature));
        setAiTimeout(String(ai.config.timeout_ms));
        setAiStall(String(ai.config.stall_ms));
        setAiStream(ai.config.stream);
        setAiAgentic(ai.config.agentic);
      }
    } catch (e) {
      console.warn('设置页加载失败:', e);
    }
  }, [lang]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const flashSaved = (which: 'athlete' | 'profile' | 'ai') => {
    setSavedFlash(which);
    setTimeout(() => setSavedFlash(null), 2000);
  };

  const saveAthlete = async () => {
    setSavingAthlete(true);
    try {
      await setAthlete({ ftp_watts: Number(ftp), max_hr: Number(maxhr), weight_kg: Number(weight) }, lang);
      await load();
      flashSaved('athlete');
    } catch (e) {
      Alert.alert(t('set.failed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingAthlete(false);
    }
  };

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      await setProfile({ identity, goal }, lang);
      flashSaved('profile');
    } catch (e) {
      Alert.alert(t('set.failed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingProfile(false);
    }
  };

  // AI 服务配置保存：key 清空 = 清除密钥（退化为复制提示词模式，旧版同语义）
  const saveAi = async () => {
    setSavingAi(true);
    try {
      await setAiConfig(
        {
          api_key: aiKey,
          base_url: aiBaseUrl,
          model: aiModel,
          temperature: aiTemp.trim() === '' ? null : Number(aiTemp),
          timeout_ms: Number(aiTimeout),
          stall_ms: Number(aiStall),
          stream: aiStream,
          agentic: aiAgentic,
        },
        lang,
      );
      await load();
      flashSaved('ai');
    } catch (e) {
      Alert.alert(t('set.failed', { msg: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingAi(false);
    }
  };

  // 当前接口地址命中的预设（回显下拉选中态用；null = 自定义）
  const matchedPreset = matchPresetByBaseUrl(aiBaseUrl);

  // 选中预设：回填接口地址；模型仅在为空、或当前值属于其它预设清单（=换厂商）时
  // 回填本预设推荐默认——用户已手填的自定义模型不被静默覆盖
  const pickProvider = (p: AiProviderPreset) => {
    setProviderMenu(false);
    setAiBaseUrl(p.baseUrl);
    const current = aiModel.trim();
    const shouldFillModel =
      current === '' ||
      AI_PROVIDER_PRESETS.some((x) => x.id !== p.id && x.models.includes(current));
    if (shouldFillModel && p.models.length > 0) setAiModel(p.models[0]);
  };

  const form = data?.form ?? null;
  const formColor = !form
    ? palette.muted
    : form.tsb >= 5
      ? palette.green
      : form.tsb >= -10
        ? palette.text
        : form.tsb >= -20
          ? palette.orange
          : palette.red;

  return (
    <ScrollView
      style={styles.page}
      contentContainerStyle={{ paddingTop: insets.top + 16, paddingBottom: 96, gap: 12 }}>
      <Text style={styles.title}>{t('me.title')}</Text>
      <Text style={styles.sub}>{t('set.sub')}</Text>

      {/* 首开引导 banner：未配置骑手参数时提示（不强制锁定） */}
      {data && !data.configured && (
        <View style={[styles.banner, { borderColor: palette.voltDim }]}>
          <Text style={styles.bannerText}>{t('set.banner')}</Text>
        </View>
      )}

      {/* 骑手摘要卡：三大参数 + 当前 form 状态 */}
      <View style={styles.card}>
        <View style={styles.summaryRow}>
          <SummaryMetric label={t('me.ftp')} value={data ? `${data.athlete.ftp_watts}W` : '—'} />
          <SummaryMetric label={t('me.maxhr')} value={data ? `${data.athlete.max_hr}` : '—'} />
          <SummaryMetric label={t('me.weight')} value={data ? `${data.athlete.weight_kg}kg` : '—'} />
        </View>
        <Divider style={styles.divider} />
        <Text style={styles.formLine}>
          <Text style={styles.formLabel}>{t('me.form')}</Text>
          {form ? (
            <>
              <Text style={[styles.formValue, { color: formColor }]}>
                {' '}
                TSB {form.tsb > 0 ? '+' : ''}
                {form.tsb}
              </Text>
              <Text style={styles.formNote}> · {form.form_note}</Text>
            </>
          ) : (
            <Text style={styles.formNote}> — </Text>
          )}
        </Text>
      </View>

      {/* 骑手参数表单（范围校验在 db 层：FTP 50–500 / 心率 120–230 / 体重 30–200） */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('set.athlete')}</Text>
        <TextInput
          mode="outlined"
          dense
          label={t('set.ftp')}
          value={ftp}
          onChangeText={setFtp}
          keyboardType="numeric"
          style={styles.input}
        />
        <TextInput
          mode="outlined"
          dense
          label={t('set.maxhr')}
          value={maxhr}
          onChangeText={setMaxhr}
          keyboardType="numeric"
          style={styles.input}
        />
        <TextInput
          mode="outlined"
          dense
          label={t('set.weight')}
          value={weight}
          onChangeText={setWeight}
          keyboardType="numeric"
          style={styles.input}
        />
        <View style={styles.saveRow}>
          <Button
            mode="contained"
            buttonColor={palette.volt}
            textColor={palette.bg}
            disabled={savingAthlete}
            onPress={saveAthlete}>
            {t('set.save')}
          </Button>
          {savedFlash === 'athlete' && <Text style={styles.saved}>{t('set.saved')}</Text>}
        </View>
        <Text style={styles.note}>{t('set.athlete.note')}</Text>
      </View>

      {/* 身份与训练目标（AI 报告个性化用，M3 消费；全空视为未配置） */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('set.profile')}</Text>
        <TextInput
          mode="outlined"
          dense
          label={t('set.identity')}
          value={identity}
          onChangeText={setIdentity}
          placeholder={t('set.identity.placeholder')}
          style={styles.input}
        />
        <TextInput
          mode="outlined"
          dense
          multiline
          label={t('set.goal')}
          value={goal}
          onChangeText={setGoal}
          placeholder={t('set.goal.placeholder')}
          style={styles.input}
        />
        <View style={styles.saveRow}>
          <Button
            mode="contained"
            buttonColor={palette.volt}
            textColor={palette.bg}
            disabled={savingProfile}
            onPress={saveProfile}>
            {t('set.save')}
          </Button>
          {savedFlash === 'profile' && <Text style={styles.saved}>{t('set.saved')}</Text>}
        </View>
        <Text style={styles.note}>{t('set.profile.note')}</Text>
      </View>

      {/* AI 服务配置（M3 BYOK：密钥存 Keystore，其余存库；校验在 db 层 setAiConfig） */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('set.ai')}</Text>
        {/* 服务商预设（M5 后打磨）：providers.json 驱动的快速填充——选中即回填地址+模型，
            不匹配任何预设（含手改地址）时自动显示「自定义」；字段始终可手填 */}
        <Menu
          visible={providerMenu}
          onDismiss={() => setProviderMenu(false)}
          anchor={
            <TextInput
              mode="outlined"
              dense
              label={t('set.ai.provider')}
              value={matchedPreset ? matchedPreset.label : aiBaseUrl.trim() ? t('set.ai.provider.custom') : ''}
              showSoftInputOnFocus={false}
              caretHidden
              onPressIn={() => setProviderMenu(true)}
              right={
                <TextInput.Icon
                  icon="menu-down"
                  forceTextInputFocus={false}
                  onPress={() => setProviderMenu(true)}
                />
              }
              style={styles.input}
            />
          }>
          {AI_PROVIDER_PRESETS.map((p) => (
            <Menu.Item
              key={p.id}
              leadingIcon={matchedPreset?.id === p.id ? 'check' : undefined}
              title={p.label}
              onPress={() => pickProvider(p)}
            />
          ))}
          <Divider />
          <Menu.Item
            leadingIcon={!matchedPreset && aiBaseUrl.trim() !== '' ? 'check' : undefined}
            title={t('set.ai.provider.custom')}
            onPress={() => setProviderMenu(false)}
          />
        </Menu>
        <TextInput
          mode="outlined"
          dense
          label={t('set.ai.key')}
          value={aiKey}
          onChangeText={setAiKey}
          secureTextEntry={!showAiKey}
          autoCapitalize="none"
          autoCorrect={false}
          right={
            <TextInput.Icon
              icon={showAiKey ? 'eye-off' : 'eye'}
              onPress={() => setShowAiKey((v) => !v)}
            />
          }
          style={styles.input}
        />
        <TextInput
          mode="outlined"
          dense
          label={t('set.ai.base_url')}
          value={aiBaseUrl}
          onChangeText={setAiBaseUrl}
          placeholder="https://api.moonshot.cn/v1"
          keyboardType="url"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
        />
        {/* 模型名：命中预设时右侧箭头给出该厂商的建议模型；列表始终可手填 */}
        <Menu
          visible={modelMenu}
          onDismiss={() => setModelMenu(false)}
          anchor={
            <TextInput
              mode="outlined"
              dense
              label={t('set.ai.model')}
              value={aiModel}
              onChangeText={setAiModel}
              placeholder="kimi-k2.6"
              autoCapitalize="none"
              autoCorrect={false}
              right={
                matchedPreset ? (
                  <TextInput.Icon
                    icon="menu-down"
                    forceTextInputFocus={false}
                    onPress={() => setModelMenu(true)}
                  />
                ) : undefined
              }
              style={styles.input}
            />
          }>
          {matchedPreset?.models.map((m) => (
            <Menu.Item
              key={m}
              leadingIcon={aiModel === m ? 'check' : undefined}
              title={m}
              onPress={() => {
                setAiModel(m);
                setModelMenu(false);
              }}
            />
          ))}
        </Menu>
        {/* 高级选项折叠区（口径同 Web 版：温度/超时/流式；agentic 工具调用总开关） */}
        <List.Accordion title={t('set.ai.advanced')} titleStyle={{ fontSize: 12, color: palette.muted }}>
          <TextInput
            mode="outlined"
            dense
            label={t('set.ai.temp')}
            value={aiTemp}
            onChangeText={setAiTemp}
            keyboardType="decimal-pad"
            style={styles.input}
          />
          <TextInput
            mode="outlined"
            dense
            label={t('set.ai.timeout')}
            value={aiTimeout}
            onChangeText={setAiTimeout}
            keyboardType="numeric"
            style={styles.input}
          />
          <TextInput
            mode="outlined"
            dense
            label={t('set.ai.stall')}
            value={aiStall}
            onChangeText={setAiStall}
            keyboardType="numeric"
            style={styles.input}
          />
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{t('set.ai.stream')}</Text>
            <Switch value={aiStream} onValueChange={setAiStream} color={palette.volt} />
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>{t('set.ai.agentic')}</Text>
            <Switch value={aiAgentic} onValueChange={setAiAgentic} color={palette.volt} />
          </View>
        </List.Accordion>
        <View style={styles.saveRow}>
          <Button
            mode="contained"
            buttonColor={palette.volt}
            textColor={palette.bg}
            disabled={savingAi}
            onPress={saveAi}>
            {t('set.save')}
          </Button>
          {savedFlash === 'ai' && <Text style={styles.saved}>{t('set.saved')}</Text>}
        </View>
        <Text style={styles.note}>{t('set.ai.note')}</Text>
      </View>

      {/* 顽鹿同步（M5 收尾后自数据管理页挪入：账号绑定与 AI 服务同属账号类配置，原位置太深） */}
      <OnelapSyncCard />

      {/* 界面语言（切换即时生效并写训练库 lang 键，AI 报告语言随动） */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('me.lang')}</Text>
        <SegmentedButtons
          value={lang}
          onValueChange={(v) => setLang(v === 'en' ? 'en' : 'zh')}
          buttons={[
            { value: 'zh', label: '中文' },
            { value: 'en', label: 'English' },
          ]}
          style={{ marginTop: 8 }}
        />
      </View>

      {/* 入口行：AI 记忆（M3 接通）/ 数据管理（M4）/ 关于 */}
      <View style={styles.card}>
        <List.Item
          title={t('me.memory')}
          left={(props) => <Icon {...props} size={20} source="brain" color={palette.muted} />}
          right={(props) => <Icon {...props} size={18} source="chevron-right" color={palette.faint} />}
          onPress={() => router.push('/memory')}
          titleStyle={{ color: palette.text }}
        />
        <Divider />
        <List.Item
          title={t('me.data')}
          left={(props) => <Icon {...props} size={20} source="database" color={palette.muted} />}
          right={(props) => <Icon {...props} size={18} source="chevron-right" color={palette.faint} />}
          onPress={() => router.push('/data')}
          titleStyle={{ color: palette.text }}
        />
        <Divider />
        <List.Item
          title={t('me.about')}
          left={(props) => <Icon {...props} size={20} source="information-outline" color={palette.muted} />}
          right={() => <Text style={styles.soon}>{t('me.soon')}</Text>}
          titleStyle={{ color: palette.text }}
        />
      </View>
    </ScrollView>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text style={styles.summaryVal}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: palette.bg, paddingHorizontal: 16 },
  title: { color: palette.text, fontSize: 22, fontWeight: '700' },
  sub: { color: palette.muted, fontSize: 12 },
  banner: { borderWidth: 1, borderRadius: 10, padding: 12, backgroundColor: palette.panel },
  bannerText: { color: palette.text, fontSize: 12, lineHeight: 19 },
  card: {
    backgroundColor: palette.panel,
    borderColor: palette.lineSoft,
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 10,
  },
  cardTitle: { color: palette.text, fontSize: 14, fontWeight: '700' },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', paddingRight: 12 },
  summaryVal: { color: palette.volt, fontSize: 22, fontWeight: '700', fontStyle: 'italic', fontVariant: ['tabular-nums'] },
  summaryLabel: { color: palette.faint, fontSize: 11 },
  divider: { backgroundColor: palette.lineSoft },
  formLine: { fontSize: 12 },
  formLabel: { color: palette.muted },
  formValue: { fontWeight: '700', fontVariant: ['tabular-nums'] },
  formNote: { color: palette.muted },
  input: { backgroundColor: palette.panel2 },
  saveRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  saved: { color: palette.green, fontSize: 12 },
  note: { color: palette.faint, fontSize: 11, lineHeight: 16 },
  soon: { color: palette.faint, fontSize: 12 },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 4, paddingHorizontal: 4 },
  switchLabel: { color: palette.text, fontSize: 13, flex: 1 },
});
