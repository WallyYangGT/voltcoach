/**
 * ChartScroller.tsx — 图表横向滚动容器
 *
 * 口径对齐 Web 版窄屏媒体查询（Web 版 style.css：`.chart-wrap{overflow-x:auto}`
 * + `svg.chart{width:900px}`）：图表按 **固定 900px 内容宽**渲染，容器窄于 900px 时
 * 横向滚动查看整段曲线，宽于 900px（平板/横屏）时铺满容器、不做无谓滚动。
 *
 * 容器宽用 onLayout 实测——此前图表按屏宽推算渲染宽，卡片内边距未计入，
 * 导致图表比容器宽出几十像素被裁剪且无法滚动（首页趋势图与详情页时序图）。
 */
import React, { useRef, useState } from 'react';
import { ScrollView, View, type StyleProp, type ViewStyle } from 'react-native';

/** 图表内容宽（px）：Web 版窄屏口径 900px（Web 版 style.css 移动端媒体查询） */
export const CHART_CONTENT_WIDTH = 900;

interface Props {
  /** 渲染图表；width 为内容宽（容器宽与 CHART_CONTENT_WIDTH 的较大者），
   *  containerWidth 为可视区实测宽——时序图缩放态用它铺满屏幕（窗口全可视，
   *  拖到边界即数据边界；画布 900dp 口径下手机视口只显示 ~40%，末段不可达） */
  children: (width: number, containerWidth: number) => React.ReactNode;
  /**
   * 首次布局完成后自动停在内容末端（不带动画）。
   * 用于「最近日期在右端」的趋势图：一进页面先看到当下，向左滑看历史。
   */
  initialScrollToEnd?: boolean;
  /** 外层容器样式：只用于外边距/底色——**不要加 padding**（onLayout 量的是 border-box，
   *  加了内边距会让内容宽再比可视区宽出这一段） */
  style?: StyleProp<ViewStyle>;
  /** 横滚开关覆盖（undefined = 默认口径「内容比容器宽才可滚」）。
   *  时序图缩放态下拖动与横滚是同一根手指，由 TimeSeriesChart.onViewportChange
   *  通知外层传 false 禁滚，复位后传 undefined 交还 */
  scrollEnabledOverride?: boolean;
}

export function ChartScroller({
  children,
  initialScrollToEnd = false,
  style,
  scrollEnabledOverride,
}: Props) {
  // 0 = 尚未测量，此时不渲染图表（避免先按 0 宽画一帧再重画）
  const [containerW, setContainerW] = useState(0);
  const scrollRef = useRef<ScrollView>(null);
  const revealed = useRef(false); // 只自动滚一次，之后保留用户自己的滚动位置
  const contentW = Math.max(containerW, CHART_CONTENT_WIDTH);
  const scrollable = containerW > 0 && contentW > containerW;

  return (
    <View style={style} onLayout={(e) => setContainerW(Math.round(e.nativeEvent.layout.width))}>
      {containerW > 0 && (
        <ScrollView
          ref={scrollRef}
          horizontal
          scrollEnabled={scrollEnabledOverride ?? scrollable}
          showsHorizontalScrollIndicator={scrollable}
          // 内容尺寸落定后才滚得动（在 onLayout 阶段调 scrollToEnd 时布局还没生效）
          onContentSizeChange={() => {
            if (!initialScrollToEnd || revealed.current) return;
            revealed.current = true;
            scrollRef.current?.scrollToEnd({ animated: false });
          }}>
          {children(contentW, containerW)}
        </ScrollView>
      )}
    </View>
  );
}
