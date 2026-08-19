import { readFile } from "node:fs/promises";
import path from "node:path";
import { ReviewError } from "../../core/src/model/errors";
import type {
  SubmitChangeInput,
  SubmitReviewInput,
  SubmitOperation,
} from "../../core/src/service/review-service";

interface RawManifestChange {
  readonly operation?: SubmitOperation;
  readonly target: string;
  readonly newTarget?: string;
  readonly file?: string;
  readonly content?: string;
}

interface RawManifest {
  readonly agent?: string;
  readonly session?: string;
  readonly changes: readonly RawManifestChange[];
}

export async function loadManifest(filename: string): Promise<SubmitReviewInput> {
  const absolute = path.resolve(filename);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(absolute, "utf8"));
  } catch (error) {
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      `Manifest cannot be read as JSON: ${filename}`,
      { manifest: filename },
      { cause: error },
    );
  }
  if (!isRawManifest(parsed)) {
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      `Manifest does not match the obsreview schema: ${filename}`,
      { manifest: filename },
    );
  }

  const changes: SubmitChangeInput[] = [];
  for (const change of parsed.changes) {
    let proposalContent: string | undefined;
    if (change.content !== undefined) proposalContent = change.content;
    else if (change.file !== undefined) {
      const source = path.resolve(path.dirname(absolute), change.file);
      try {
        proposalContent = await readFile(source, "utf8");
      } catch (error) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `Manifest proposal file cannot be read: ${change.file}`,
          { manifest: filename, file: change.file },
          { cause: error },
        );
      }
    }
    const input: {
      operation?: SubmitOperation;
      target: string;
      newTarget?: string;
      proposalContent?: string;
    } = { target: change.target };
    if (change.operation !== undefined) input.operation = change.operation;
    if (change.newTarget !== undefined) input.newTarget = change.newTarget;
    if (proposalContent !== undefined) input.proposalContent = proposalContent;
    changes.push(input);
  }

  const source: { agent?: string; session?: string } = {};
  if (parsed.agent !== undefined) source.agent = parsed.agent;
  if (parsed.session !== undefined) source.session = parsed.session;
  return {
    ...(Object.keys(source).length === 0 ? {} : { source }),
    changes,
  };
}

function isRawManifest(value: unknown): value is RawManifest {
  if (!isRecord(value) || !Array.isArray(value["changes"])) return false;
  if (value["agent"] !== undefined && typeof value["agent"] !== "string") return false;
  if (value["session"] !== undefined && typeof value["session"] !== "string") return false;
  return value["changes"].length > 0 && value["changes"].every(isRawChange);
}

function isRawChange(value: unknown): value is RawManifestChange {
  if (!isRecord(value) || typeof value["target"] !== "string") return false;
  if (
    value["operation"] !== undefined &&
    value["operation"] !== "auto" &&
    value["operation"] !== "create" &&
    value["operation"] !== "modify" &&
    value["operation"] !== "delete" &&
    value["operation"] !== "rename"
  ) {
    return false;
  }
  return (
    (value["newTarget"] === undefined || typeof value["newTarget"] === "string") &&
    (value["file"] === undefined || typeof value["file"] === "string") &&
    (value["content"] === undefined || typeof value["content"] === "string") &&
    !(value["file"] !== undefined && value["content"] !== undefined)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
