import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createVault(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "obsreview-test-"));
}

export async function cleanupVault(vault: string): Promise<void> {
  await rm(vault, { recursive: true, force: true });
}

export async function writeVaultFile(
  vault: string,
  target: string,
  content: string,
): Promise<void> {
  const absolute = path.join(vault, ...target.split("/"));
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
}

export async function readVaultFile(vault: string, target: string): Promise<string> {
  return readFile(path.join(vault, ...target.split("/")), "utf8");
}
