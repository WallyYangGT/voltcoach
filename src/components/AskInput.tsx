/**
 * AskInput — 追问问答的输入行（会话详情页底部固定行 / 训练详情页 AI 面板内联行共用）。
 *
 * 发送用显性 Button：Paper 的 TextInput.Icon 在 multiline 下触摸不可靠（M3 冒烟实证）。
 * 草稿状态自持：提交后立即清空，失败由调用方提示（输入内容不丢在输入框里更符合直觉）。
 * ref 指向行容器 View（宿主实例，可 measureInWindow）——训练详情页据此把整行滚出
 * 键盘遮挡；会话页不传。
 */
import React, { useState, type ComponentRef, type Ref } from 'react';
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Button, TextInput } from 'react-native-paper';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

/** 行容器 View 的宿主实例类型（页面侧 useRef 用） */
export type AskInputInstance = ComponentRef<typeof View>;

interface Props {
  placeholder: string;
  sending: boolean;
  onSend: (text: string) => Promise<void> | void;
  style?: StyleProp<ViewStyle>;
  /** 输入框自适应高度上限（会话页 120、内联面板 100） */
  maxHeight?: number;
  /** 挂载即聚焦（AP1：从首页输入卡片进入新对话页时直达可输入态） */
  autoFocus?: boolean;
  /** 初始草稿（今日建议卡「和教练聊聊」深链预填上下文；仅挂载时生效，此后自持） */
  initialDraft?: string;
  /** 聚焦信号透传（训练详情页据此区分备注/追问两路滚动目标，会话页不传） */
  onFocus?: () => void;
  /** 行容器布局回调透传（训练详情页据此在内容长高——回复落地/多行自增——时重滚） */
  onLayout?: (e: LayoutChangeEvent) => void;
  ref?: Ref<AskInputInstance>;
}

export function AskInput({ placeholder, sending, onSend, style, maxHeight = 120, autoFocus, initialDraft, onFocus, onLayout, ref }: Props) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(initialDraft ?? '');

  const submit = () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    void onSend(text);
  };

  return (
    <View ref={ref} onLayout={onLayout} style={[styles.row, style]}>
      <TextInput
        mode="outlined"
        dense
        multiline
        value={draft}
        onChangeText={setDraft}
        placeholder={placeholder}
        style={[styles.input, { maxHeight }]}
        autoFocus={autoFocus}
        onFocus={onFocus}
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
