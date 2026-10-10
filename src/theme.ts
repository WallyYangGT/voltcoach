/**
 * theme.ts — MD3 暗色主题（volt 荧光黄品牌色）
 *
 * 设计语言延续 Web 版（Web 版 style.css 的 :root 变量）：
 * 深色平面科技风 + volt 荧光黄主色 + 青色辅助，等宽数字大数字排版。
 * 组件形态遵循 Material 3（Paper 5），品牌个性靠色彩与排版。
 */
import { MD3DarkTheme, type MD3Theme } from 'react-native-paper';

/** 品牌调色板（与 Web 版 CSS 变量一一对应，供 SVG 图表/原生 tab 等非 Paper 场景复用） */
export const palette = {
  bg: '#0a0d11',
  bgSoft: '#0e1318',
  panel: '#131920',
  panel2: '#182029',
  line: '#242e38',
  lineSoft: '#1c242d',
  text: '#e9eef4',
  muted: '#8d9aa8',
  faint: '#5c6a78',
  volt: '#d7ff3f',
  voltDim: 'rgba(215, 255, 63, 0.14)',
  cyan: '#3fd6f5',
  blue: '#5aa2ff',
  red: '#ff5d73',
  green: '#3ddc97',
  orange: '#ffb03f',
} as const;

/** Paper 5 的 MD3 自定义暗色 scheme（primary = volt） */
export const md3Dark: MD3Theme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    primary: palette.volt,
    onPrimary: palette.bg,
    primaryContainer: '#2a3213',
    onPrimaryContainer: palette.volt,
    secondary: palette.cyan,
    onSecondary: palette.bg,
    secondaryContainer: '#12333b',
    onSecondaryContainer: palette.cyan,
    tertiary: palette.blue,
    onTertiary: palette.bg,
    background: palette.bg,
    onBackground: palette.text,
    surface: palette.panel,
    onSurface: palette.text,
    surfaceVariant: palette.panel2,
    onSurfaceVariant: palette.muted,
    surfaceDisabled: palette.panel2,
    onSurfaceDisabled: palette.faint,
    outline: palette.line,
    outlineVariant: palette.lineSoft,
    error: palette.red,
    onError: palette.bg,
    errorContainer: '#3d151d',
    onErrorContainer: palette.red,
    inverseSurface: palette.text,
    inverseOnSurface: palette.bg,
    inversePrimary: '#2a3213',
    shadow: palette.bg,
    scrim: palette.bg,
  },
};

/** 原生底部导航（NativeTabs）的配色：未选中灰、选中 volt；激活图标反色为背景色——volt 药丸高亮内呈镂空 */
export const nativeTabsStyle = {
  backgroundColor: palette.bgSoft,
  indicatorColor: palette.volt,
  iconColor: { default: palette.muted, selected: palette.bg } as const,
  labelStyle: {
    default: { color: palette.muted },
    selected: { color: palette.volt },
  } as const,
};
