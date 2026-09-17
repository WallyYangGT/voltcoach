/**
 * i18n — 界面双语（zh 默认 / en）
 *
 * 移植自 Web 版 web/js/i18n.js 的机制，平台层替换：
 *  - 语言检测：navigator.language → expo-localization getLocales()（非中文一律 en）
 *  - 持久化：localStorage → AsyncStorage（key 沿用 fit-reader.lang）
 *  - 训练库 settings 表 lang 键的同步在 M1 接入 db 后回填（口径与 Web 版一致：
 *    前端持久化为先，库值供 AI 提示词缺省使用）
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { DICT, LANG_STORAGE_KEY, type DictKey, type Lang } from './dict';

export { DICT, LANG_STORAGE_KEY };
export type { DictKey, Lang };

/** 首次启动检测：系统语言为中文 → zh，其余一律 en（与 Web 版口径一致） */
export function detectLang(): Lang {
  try {
    const code = getLocales()[0]?.languageCode ?? '';
    return code.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'zh';
  }
}

interface I18nContextValue {
  lang: Lang;
  /** 切换语言并持久化 */
  setLang: (lang: Lang) => void;
  /** 取文案并做 {var} 插值 */
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>('zh');

  useEffect(() => {
    // 启动时读持久化值，无记录则按系统语言检测后落盘（与 Web 版首启行为一致）
    AsyncStorage.getItem(LANG_STORAGE_KEY)
      .then((stored) => {
        if (stored === 'en' || stored === 'zh') {
          setLangState(stored);
        } else {
          const detected = detectLang();
          setLangState(detected);
          return AsyncStorage.setItem(LANG_STORAGE_KEY, detected);
        }
      })
      .catch(() => {});
  }, []);

  const setLang = useCallback((next: Lang) => {
    const normalized: Lang = next === 'en' ? 'en' : 'zh';
    setLangState(normalized);
    AsyncStorage.setItem(LANG_STORAGE_KEY, normalized).catch(() => {});
  }, []);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>) => {
      const table = DICT[lang] as Record<string, string>;
      return interpolate(table[key] ?? key, vars);
    },
    [lang],
  );

  return <I18nContext.Provider value={{ lang, setLang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n 必须在 I18nProvider 内使用');
  return ctx;
}
