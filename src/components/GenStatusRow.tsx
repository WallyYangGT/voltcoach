/**
 * GenStatusRow — AI 生成过程状态行（会话气泡与报告正文共用，2026-10）。
 *
 * 数据源：GenProgress（进程内瞬态，页面 1.5s 轮询时同步读取）。按 phase 渲染：
 * - thinking / compacting：菱形图标闪烁；有 reasoning 时单行半透明滚动展示当前轮
 *   思考正文，否则显示预本地化文案（「模型思考中…」/「正在压缩…」）；
 * - tool：放大镜闪烁 +「正在调用 X…」（模型流式产出 tool_calls 时即提前进入，
 *   不等本地工具执行，否则毫秒级执行根本看不见）；
 * - tool_done：勾选图标静态 +「✓ X · N 字符」；
 * - streaming：小圆点呼吸 +「生成中…」。
 *
 * 动效只用 RN 内置 Animated（native driver），不引 reanimated；reasoning 文本不落库、
 * 不打日志，仅内存尾部片段用于展示（口径见 services/aiGenerate 的 GenProgress）。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, View } from 'react-native';
import { Icon, Text } from 'react-native-paper';
import type { GenProgress } from '@/services/aiGenerate';
import { useI18n } from '@/i18n';
import { palette } from '@/theme';

interface Props {
  progress: GenProgress | null;
  /** 生成任务仍在进行：无 progress 时也显示「模型思考中…」默认态 */
  live?: boolean;
}

const ICON_SIZE = 14;

/** 闪烁图标：native driver 的透明度 + 轻微缩放；阶段切换只要 active 不变就不重启循环 */
function BlinkingGlyph({
  name,
  color,
  active,
  period = 620,
  size = ICON_SIZE,
}: {
  name: string;
  color: string;
  active: boolean;
  period?: number;
  size?: number;
}) {
  // Animated.Value 用 useState 持有（不是 ref）：新 react-hooks/refs 规则禁止 render
  // 期间读 ref.current，且 useState 的惰性初值同样保证实例跨渲染稳定
  const [pulse] = useState(() => new Animated.Value(1));
  useEffect(() => {
    if (!active) {
      pulse.stopAnimation();
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.3,
          duration: period,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: period,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, period, pulse]);
  return (
    <Animated.View
      style={{
        opacity: pulse,
        transform: [{ scale: pulse.interpolate({ inputRange: [0.3, 1], outputRange: [0.92, 1.06] }) }],
      }}>
      <Icon source={name} size={size} color={color} />
    </Animated.View>
  );
}

/** 单行思考 ticker：内容增长时滚到最新；不拦截手势、不显示滚动条 */
function ThinkingTicker({ text }: { text: string }) {
  const ref = useRef<ScrollView>(null);
  return (
    <ScrollView
      ref={ref}
      horizontal
      scrollEnabled={false}
      pointerEvents="none"
      showsHorizontalScrollIndicator={false}
      style={styles.ticker}
      contentContainerStyle={styles.tickerContent}
      onContentSizeChange={() => ref.current?.scrollToEnd?.({ animated: true })}
      testID="gen-thinking-ticker">
      <Text numberOfLines={1} style={styles.thinkingText}>
        {text}
      </Text>
    </ScrollView>
  );
}

export function GenStatusRow({ progress, live = false }: Props) {
  const { t } = useI18n();
  if (!progress && !live) return null;

  const phase = progress?.phase ?? 'thinking';
  const label =
    progress?.activity ?? (phase === 'streaming' ? t('session.generating') : t('session.thinking'));
  const thinking = (progress?.thinking ?? '').replace(/\s+/g, ' ').trim();
  const isTool = phase === 'tool' || phase === 'tool_done';
  const icon =
    phase === 'tool'
      ? 'magnify'
      : phase === 'tool_done'
        ? 'check'
        : phase === 'streaming'
          ? 'circle'
          : 'rhombus';
  const color = isTool ? palette.cyan : palette.volt;
  // tool_done 是完成瞬间的静态勾选；thinking/compacting/streaming/tool 都持续闪烁/呼吸
  const blink = phase !== 'tool_done';
  // 有思考正文就让它占满剩余宽度滚动；没有则退回「模型思考中…」文案（用户要的"或"）
  const showTicker = phase === 'thinking' && !!thinking;

  return (
    <View style={styles.row} testID="gen-status">
      <View testID={`gen-status-icon-${phase}`}>
        <BlinkingGlyph
          name={icon}
          color={color}
          active={blink}
          period={phase === 'streaming' ? 900 : 620}
          size={phase === 'streaming' ? 9 : ICON_SIZE}
        />
      </View>
      {showTicker ? (
        <ThinkingTicker text={thinking} />
      ) : (
        <Text numberOfLines={1} style={styles.label}>
          {label}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 18 },
  label: { color: palette.muted, fontSize: 11.5, lineHeight: 17, flexShrink: 1 },
  ticker: { flex: 1, minWidth: 0, maxHeight: 17, overflow: 'hidden' },
  tickerContent: { flexDirection: 'row', alignItems: 'center' },
  // flexShrink: 0：横向 ScrollView 内文本按自然宽度排版，滚动才有意义
  thinkingText: { color: palette.muted, opacity: 0.65, fontSize: 11, lineHeight: 17, flexShrink: 0 },
});
