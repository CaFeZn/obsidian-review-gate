import { homedir } from "node:os";
import path from "node:path";
import { sha256 } from "../model/hash";

export function userDataReviewStorageBase(vaultRoot: string): string {
  const resolvedVault = path.resolve(vaultRoot);
  const identity = process.platform === "win32" ? resolvedVault.toLowerCase() : resolvedVault;
  return path.join(reviewHome(), "vaults", sha256(identity).slice(0, 24));
}

function reviewHome(): string {
  const configured = process.env["OBSREVIEW_HOME"];
  if (configured !== undefined && configured.trim().length > 0) {
    return path.resolve(configured);
  }
  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"];
    return path.join(local ?? path.join(homedir(), "AppData", "Local"), "ObsidianReviewGate");
  }
  if (process.platform === "darwin") {
    return path.join(homedir(), "Library", "Application Support", "ObsidianReviewGate");
  }
  const dataHome = process.env["XDG_DATA_HOME"];
  return dataHome === undefined || dataHome.trim().length === 0
    ? path.join(homedir(), ".local", "share", "obsidian-review-gate")
    : path.join(path.resolve(dataHome), "obsidian-review-gate");
}
