import type { ReviewErrorCode } from "../model/errors";

export interface ProtocolSuccess<T extends object = Record<string, never>> {
  readonly ok: true;
  readonly data: T;
}

export interface ProtocolFailure {
  readonly ok: false;
  readonly code: ReviewErrorCode | "GENERAL_ERROR";
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ProtocolResult<T extends object = Record<string, never>> =
  | ProtocolSuccess<T>
  | ProtocolFailure;

export function success<T extends object>(data: T): ProtocolSuccess<T> {
  return { ok: true, data };
}

export function failure(
  code: ProtocolFailure["code"],
  message: string,
  details?: Readonly<Record<string, unknown>>,
): ProtocolFailure {
  const value: {
    ok: false;
    code: ProtocolFailure["code"];
    message: string;
    details?: Readonly<Record<string, unknown>>;
  } = { ok: false, code, message };
  if (details !== undefined) value.details = details;
  return value;
}
