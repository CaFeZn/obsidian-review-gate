import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ReviewService, installReviewFileSystem } from "../packages/core/src/index";
import {
  ObsidianReviewFileSystem,
  type ObsidianDataAdapter,
  type ObsidianListedFiles,
  type ObsidianStat,
} from "../packages/obsidian-plugin/src/storage/obsidian-file-system";
import { cleanupVault, createVault, writeVaultFile } from "./helpers";

test("Obsidian filesystem completes a review using only vault-relative adapter paths", async () => {
  const vault = await createVault();
  await writeVaultFile(vault, "note.md", "base\n");
  const adapter = new RecordingDataAdapter(vault);
  const restore = installReviewFileSystem(new ObsidianReviewFileSystem(vault, adapter));

  try {
    const service = (await ReviewService.open(vault)).service;
    const review = await service.submit({
      changes: [{ target: "note.md", proposalContent: "approved\n" }],
    });

    assert.deepEqual((await service.list()).map((item) => item.id), [review.id]);
    await service.approve(review.id);

    assert.equal(await readFile(path.join(vault, "note.md"), "utf8"), "approved\n");
    assert.equal((await service.get(review.id)).status, "approved");
    assert.ok(adapter.paths.some((value) => value.startsWith(".obsreview/")));
    assert.ok(
      adapter.paths.every(
        (value) => !path.isAbsolute(value) && !value.includes("\\"),
      ),
    );
  } finally {
    restore();
    await cleanupVault(vault);
  }
});

class RecordingDataAdapter implements ObsidianDataAdapter {
  public readonly paths: string[] = [];

  public constructor(private readonly root: string) {}

  public async exists(relativePath: string): Promise<boolean> {
    this.record(relativePath);
    try {
      await stat(this.absolute(relativePath));
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  public async stat(relativePath: string): Promise<ObsidianStat | null> {
    this.record(relativePath);
    try {
      const info = await stat(this.absolute(relativePath));
      return {
        type: info.isDirectory() ? "folder" : "file",
        mtime: info.mtimeMs,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  public async list(relativePath: string): Promise<ObsidianListedFiles> {
    this.record(relativePath);
    const files: string[] = [];
    const folders: string[] = [];
    for (const entry of await readdir(this.absolute(relativePath), { withFileTypes: true })) {
      const child = [relativePath, entry.name].filter(Boolean).join("/");
      if (entry.isDirectory()) folders.push(child);
      else files.push(child);
    }
    return { files, folders };
  }

  public async read(relativePath: string): Promise<string> {
    this.record(relativePath);
    return readFile(this.absolute(relativePath), "utf8");
  }

  public async write(relativePath: string, data: string): Promise<void> {
    this.record(relativePath);
    await writeFile(this.absolute(relativePath), data, "utf8");
  }

  public async mkdir(relativePath: string): Promise<void> {
    this.record(relativePath);
    await mkdir(this.absolute(relativePath));
  }

  public async rmdir(relativePath: string, recursive: boolean): Promise<void> {
    this.record(relativePath);
    await rm(this.absolute(relativePath), { recursive });
  }

  public async remove(relativePath: string): Promise<void> {
    this.record(relativePath);
    await unlink(this.absolute(relativePath));
  }

  public async rename(source: string, destination: string): Promise<void> {
    this.record(source);
    this.record(destination);
    await rename(this.absolute(source), this.absolute(destination));
  }

  private absolute(relativePath: string): string {
    return path.join(this.root, ...relativePath.split("/").filter(Boolean));
  }

  private record(relativePath: string): void {
    this.paths.push(relativePath);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
