import { defineI18n } from "@gramio/i18n";
import type { Locale } from "@sku/db";
import { en } from "./en";
import { ru } from "./ru";

export { en, ru };

export const i18n = defineI18n({
  primaryLanguage: "ru",
  languages: { ru, en },
});

export const localeFromLanguageCode = (languageCode: string | undefined): Locale =>
  languageCode === "ru" ? "ru" : "en";
