import { createHash } from "node:crypto";

export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

export function hashEquals(left: string | null, right: string | null): boolean {
  return left === right;
}
