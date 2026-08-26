import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { NodeReviewFileSystem } from "../packages/core/src/storage/file-system";

const projectRoot = path.resolve(__dirname, "..", "..");

test("Node filesystem renames a file across different devices", async (context) => {
  const sourceDirectory = await mkdtemp(path.join(tmpdir(), "obsreview-node-fs-source-"));
  const destinationDirectory = await mkdtemp(
    path.join(projectRoot, ".obsreview-node-fs-target-"),
  );
  try {
    const sourceDevice = await stat(sourceDirectory);
    const destinationDevice = await stat(destinationDirectory);
    const differentDevices =
      process.platform === "win32"
        ? path.parse(sourceDirectory).root.toLowerCase() !==
          path.parse(destinationDirectory).root.toLowerCase()
        : sourceDevice.dev !== destinationDevice.dev;
    if (!differentDevices) {
      context.skip("requires source and destination directories on different devices");
      return;
    }

    const source = path.join(sourceDirectory, "proposal.new");
    const destination = path.join(destinationDirectory, "note.md");
    await writeFile(source, "cross-device proposal\n", "utf8");

    await new NodeReviewFileSystem().rename(source, destination);

    assert.equal(await readFile(destination, "utf8"), "cross-device proposal\n");
    await assert.rejects(access(source));
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
    await rm(destinationDirectory, { recursive: true, force: true });
  }
});
