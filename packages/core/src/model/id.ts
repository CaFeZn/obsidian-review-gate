import { randomBytes } from "node:crypto";

/**
 * Generates a time-sortable 26-character Crockford Base32 identifier.
 * It has ULID-compatible shape without adding a runtime dependency.
 */
export function createReviewId(now = Date.now()): string {
  const time = encodeBase32(BigInt(now), 10);
  const random = randomBytes(10);
  let value = 0n;
  for (const byte of random) value = (value << 8n) | BigInt(byte);
  return time + encodeBase32(value, 16);
}

export function createChangeId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > 9999) {
    throw new RangeError(`Invalid change index: ${index}`);
  }
  return String(index).padStart(4, "0");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeBase32(input: bigint, width: number): string {
  let value = input;
  let result = "";
  do {
    const digit = Number(value & 31n);
    result = (CROCKFORD[digit] ?? "0") + result;
    value >>= 5n;
  } while (value > 0n);
  if (result.length > width) result = result.slice(-width);
  return result.padStart(width, "0");
}
