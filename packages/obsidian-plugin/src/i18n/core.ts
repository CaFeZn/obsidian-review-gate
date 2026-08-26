import {
  ReviewError,
  type ReviewErrorCode,
} from "../../../core/src/model/errors";
import { EN_MESSAGES, type TranslationKey } from "./en";
import { ZH_MESSAGES } from "./zh";

export type Locale = "en" | "zh";
export type TranslationValues = Readonly<Record<string, string | number>>;
export type Translator = (key: TranslationKey, values?: TranslationValues) => string;

const REVIEW_ERROR_KEYS = {
  INVALID_ARGUMENTS: "errorInvalidArguments",
  INVALID_TARGET_PATH: "errorInvalidTargetPath",
  REVIEW_NOT_FOUND: "errorReviewNotFound",
  CHANGE_NOT_FOUND: "errorChangeNotFound",
  REVIEW_CONFLICT: "errorReviewConflict",
  REVISION_CONFLICT: "errorRevisionConflict",
  INVALID_STATE_TRANSITION: "errorInvalidStateTransition",
  REVIEW_LOCKED: "errorReviewLocked",
  LOCK_TIMEOUT: "errorLockTimeout",
  WAIT_TIMEOUT: "errorWaitTimeout",
  CORRUPTED_REVIEW: "errorCorruptedReview",
  APPLY_FAILED: "errorApplyFailed",
  REBASE_CONFLICT: "errorRebaseConflict",
  IO_ERROR: "errorIo",
  INTERNAL_ERROR: "errorInternal",
} as const satisfies Readonly<Record<ReviewErrorCode, TranslationKey>>;

export function resolveLocale(...languages: readonly (string | undefined)[]): Locale {
  const language = languages.find(
    (candidate) => candidate !== undefined && candidate.trim() !== "",
  );
  return language?.toLowerCase().startsWith("zh") === true ? "zh" : "en";
}

export function createTranslator(locale: Locale): Translator {
  const catalog = locale === "zh" ? ZH_MESSAGES : EN_MESSAGES;
  return (key, values) => {
    const template = catalog[key];
    if (values === undefined) return template;
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/gu, (placeholder, name: string) => {
      const value = values[name];
      return value === undefined ? placeholder : String(value);
    });
  };
}

export function formatUiError(locale: Locale, error: unknown): string {
  if (locale === "en") return error instanceof Error ? error.message : String(error);
  const key = error instanceof ReviewError
    ? REVIEW_ERROR_KEYS[error.code]
    : "unexpectedError";
  return createTranslator(locale)(key);
}
