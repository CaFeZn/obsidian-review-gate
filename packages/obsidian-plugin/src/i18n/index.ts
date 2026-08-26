import { getLanguage } from "obsidian";
import { createTranslator, formatUiError, resolveLocale } from "./core";

const locale = resolveLocale(
  typeof getLanguage === "function" ? getLanguage() : undefined,
  typeof document === "undefined" ? undefined : document.documentElement.lang,
  typeof navigator === "undefined" ? undefined : navigator.language,
);

export const t = createTranslator(locale);
export const localizeError = (error: unknown): string => formatUiError(locale, error);
