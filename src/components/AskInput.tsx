/**
 * AskInput — 追问问答的输入行（会话详情页底部固定行 / 训练详情页 AI 面板内联行共用）。
 *
 * 发送用显性 Button：Paper 的 TextInput.Icon 在 multiline 下触摸不可靠（M3 冒烟实证）。
 * 草稿状态自持：提交后立即清空，失败由调用方提示（输入内容不丢在输入框里更符合直觉）。
 */
import React, { useState } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { Button, TextInput } from 'react-native-paper';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

interface Props {
  placeholder: string;
  sending: boolean;
  onSend: (text: string) => Promise<void> | void;
  style?: StyleProp<ViewStyle>;
  /** 输入框自适应高度上限（会话页 120、内联面板 100） */
  maxHeight?: number;
}

export function AskInput({ placeholder, sending, onSend, style, maxHeight = 120 }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    void onSend(text);
  };

  return (
    <View style={[styles.row, style]}>
      <TextInput
        mode="outlined"
        dense
        multiline
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        style={[styles.input, { maxHeight }]}
      />
      <Button
        mode="contained"
        compact
        buttonColor={palette.volt}
        textColor={palette.bg}
        disabled={sending || !draft.trim()}
        onPress={submit}>
        {t('session.send')}
      </Button>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { backgroundColor: palette.panel, flex: 1 },
});
