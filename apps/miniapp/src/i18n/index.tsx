import { createContext, use, useCallback, useMemo, type ReactNode } from "react";

import type { Locale } from "../api";
import { en } from "./en";
import { ru, type Dict, type MessageKey } from "./ru";

const dictionaries: Record<Locale, Dict> = { ru, en };

export type TranslateParams = Record<string, string | number>;
export type Translate = (key: MessageKey, params?: TranslateParams) => string;

type I18nValue = { locale: Locale; t: Translate; setLocale: (locale: Locale) => void };

const I18nContext = createContext<I18nValue | null>(null);

const interpolate = (template: string, params?: TranslateParams): string => {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
};

export const I18nProvider = ({
  locale,
  onLocaleChange,
  children,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
  children: ReactNode;
}) => {
  const t = useCallback<Translate>(
    (key, params) => interpolate(dictionaries[locale][key], params),
    [locale],
  );
  const value = useMemo<I18nValue>(() => ({ locale, t, setLocale: onLocaleChange }), [locale, t, onLocaleChange]);
  return <I18nContext value={value}>{children}</I18nContext>;
};

export const useI18n = (): I18nValue => {
  const value = use(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
};

export type { MessageKey };
