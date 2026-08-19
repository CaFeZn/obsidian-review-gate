import path from "node:path";
import { ReviewError } from "../model/errors";
import { lstat, realpath, stat, type ReviewFileStat } from "../storage/file-system";

export interface SafeTarget {
  readonly vaultRoot: string;
  readonly target: string;
  readonly absolutePath: string;
  readonly exists: boolean;
}

export async function resolveVaultRoot(vault: string): Promise<string> {
  if (vault.trim().length === 0) {
    throw new ReviewError("INVALID_ARGUMENTS", "Vault path cannot be empty.");
  }
  let root: string;
  try {
    root = await realpath(path.resolve(vault));
    const info = await stat(root);
    if (info === null || !info.isDirectory()) {
      throw new ReviewError("INVALID_ARGUMENTS", "Vault path is not a directory.", {
        vault,
      });
    }
  } catch (error) {
    if (error instanceof ReviewError) throw error;
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      `Vault directory does not exist or is inaccessible: ${vault}`,
      { vault },
      { cause: error },
    );
  }
  return root;
}

export async function resolveSafeTarget(
  vault: string,
  inputTarget: string,
): Promise<SafeTarget> {
  const vaultRoot = await resolveVaultRoot(vault);
  const target = normalizeVaultRelativeTarget(inputTarget);
  const lexicalPath = path.resolve(vaultRoot, ...target.split("/"));
  assertInside(vaultRoot, lexicalPath, target);

  const existing = await lstatOrNull(lexicalPath);
  if (existing !== null) {
    let canonical: string;
    try {
      canonical = await realpath(lexicalPath);
    } catch (error) {
      throw new ReviewError(
        "INVALID_TARGET_PATH",
        `Target resolves through an invalid or broken symbolic link: ${target}`,
        { target },
        { cause: error },
      );
    }
    assertInside(vaultRoot, canonical, target);
    if (existing.isDirectory()) {
      throw new ReviewError(
        "INVALID_TARGET_PATH",
        `Target must be a file path, not a directory: ${target}`,
        { target },
      );
    }
    return { vaultRoot, target, absolutePath: canonical, exists: true };
  }

  const nearest = await nearestExistingAncestor(lexicalPath, vaultRoot);
  let canonicalAncestor: string;
  try {
    canonicalAncestor = await realpath(nearest);
  } catch (error) {
    throw new ReviewError(
      "INVALID_TARGET_PATH",
      `Target parent resolves through an invalid symbolic link: ${target}`,
      { target },
      { cause: error },
    );
  }
  assertInside(vaultRoot, canonicalAncestor, target);
  const remainder = path.relative(nearest, lexicalPath);
  const canonicalCandidate = path.resolve(canonicalAncestor, remainder);
  assertInside(vaultRoot, canonicalCandidate, target);
  return {
    vaultRoot,
    target,
    absolutePath: canonicalCandidate,
    exists: false,
  };
}

export function normalizeVaultRelativeTarget(input: string): string {
  const raw = input.trim();
  if (raw.length === 0) {
    throw invalidPath(input, "Target path cannot be empty.");
  }
  if (raw.includes("\0")) {
    throw invalidPath(input, "Target path contains a NUL byte.");
  }
  if (
    path.isAbsolute(raw) ||
    path.win32.isAbsolute(raw) ||
    /^[A-Za-z]:/u.test(raw) ||
    raw.startsWith("\\\\") ||
    raw.startsWith("//")
  ) {
    throw invalidPath(input, "Target must be relative to the vault.");
  }

  const slashPath = raw.replace(/\\/gu, "/");
  const segments = slashPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw invalidPath(input, "Target contains an empty, current, or parent segment.");
  }
  if (segments.some((segment) => segment.includes(":"))) {
    throw invalidPath(input, "Target contains a colon, which is not portable or safe.");
  }
  const normalized = path.posix.normalize(slashPath);
  const first = normalized.split("/")[0]?.toLocaleLowerCase("en-US");
  if (first === ".obsreview") {
    throw invalidPath(input, "The reserved .obsreview directory cannot be a target.");
  }
  return normalized;
}

export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function assertInside(root: string, candidate: string, target: string): void {
  if (!isPathInside(root, candidate)) {
    throw invalidPath(target, "Target resolves outside the vault.");
  }
}

async function nearestExistingAncestor(candidate: string, root: string): Promise<string> {
  let current = path.dirname(candidate);
  while (true) {
    if ((await lstatOrNull(current)) !== null) return current;
    if (samePath(current, root)) return root;
    const parent = path.dirname(current);
    if (samePath(parent, current)) {
      throw new ReviewError(
        "INVALID_TARGET_PATH",
        "Could not find an existing target ancestor inside the vault.",
        { candidate },
      );
    }
    current = parent;
  }
}

async function lstatOrNull(value: string): Promise<ReviewFileStat | null> {
  return lstat(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

function invalidPath(input: string, message: string): ReviewError {
  return new ReviewError("INVALID_TARGET_PATH", message, { target: input });
}
