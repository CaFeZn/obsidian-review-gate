import { readFile } from "node:fs/promises";
import type { ReviewStatus } from "../../core/src/model/review";
import { ReviewError } from "../../core/src/model/errors";
import {
  ReviewService,
  type SubmitOperation,
} from "../../core/src/service/review-service";
import { waitForReview } from "../../core/src/protocol/wait";
import {
  booleanFlag,
  flag,
  integerFlag,
  parseArguments,
  positional,
  rejectUnknownFlags,
  requiredFlag,
  type ParsedArguments,
} from "./args";
import { loadManifest } from "./manifest";
import {
  EXIT,
  exitCodeForError,
  exitCodeForReview,
  failureDocument,
  listDocument,
  printDocument,
  reviewDocument,
} from "./output";

const VERSION = "0.1.0";

export async function run(argv: readonly string[]): Promise<number> {
  const jsonRequested = argv.includes("--json") || argv.some((item) => item.startsWith("--json="));
  let args: ParsedArguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    printDocument(failureDocument(error), jsonRequested);
    return exitCodeForError(error);
  }

  const json = booleanFlag(args, "json");
  if (booleanFlag(args, "version") || args.command === "version") {
    printDocument({ ok: true, version: VERSION }, json);
    return EXIT.success;
  }
  if (booleanFlag(args, "help") || args.command === null || args.command === "help") {
    process.stdout.write(usage());
    return EXIT.success;
  }

  const abortController = new AbortController();
  let interrupted = false;
  const onInterrupt = (): void => {
    interrupted = true;
    abortController.abort(new Error("Interrupted by Ctrl+C."));
  };
  process.once("SIGINT", onInterrupt);

  try {
    const vault = flag(args, "vault") ?? process.env["OBSREVIEW_VAULT"];
    if (vault === undefined || vault.trim().length === 0) {
      throw new ReviewError(
        "INVALID_ARGUMENTS",
        "Missing --vault (or OBSREVIEW_VAULT).",
      );
    }
    const { service, recovery } = await ReviewService.open(vault);
    if (recovery.some((item) => item.action === "left-for-manual-recovery")) {
      throw new ReviewError(
        "IO_ERROR",
        "One or more interrupted transactions require manual recovery.",
        { recovery },
      );
    }

    const result = await dispatch(service, args, abortController.signal);
    printDocument(result.document, json);
    return result.exitCode;
  } catch (error) {
    printDocument(failureDocument(error), json);
    return interrupted ? 130 : exitCodeForError(error);
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

async function dispatch(
  service: ReviewService,
  args: ParsedArguments,
  signal: AbortSignal,
): Promise<{ readonly document: unknown; readonly exitCode: number }> {
  switch (args.command) {
    case "submit":
      return submitCommand(service, args);
    case "update":
      return updateCommand(service, args);
    case "status":
      return statusCommand(service, args);
    case "show":
      return showCommand(service, args);
    case "list":
      return listCommand(service, args);
    case "wait":
      return waitCommand(service, args, signal);
    case "cancel":
      return cancelCommand(service, args);
    case "approve":
      return approveCommand(service, args);
    case "reject":
      return rejectCommand(service, args);
    case "rebase":
      return rebaseCommand(service, args);
    case "hunk":
      return hunkCommand(service, args);
    default:
      throw new ReviewError("INVALID_ARGUMENTS", `Unknown command: ${args.command}`);
  }
}

async function submitCommand(
  service: ReviewService,
  args: ParsedArguments,
): Promise<CommandResult> {
  rejectUnknownFlags(args, [
    "vault",
    "target",
    "file",
    "manifest",
    "agent",
    "session",
    "operation",
    "new-target",
  ]);
  const manifest = flag(args, "manifest");
  let input;
  if (manifest !== undefined) {
    if (flag(args, "target") !== undefined || flag(args, "file") !== undefined) {
      throw new ReviewError(
        "INVALID_ARGUMENTS",
        "--manifest cannot be combined with --target or --file.",
      );
    }
    input = await loadManifest(manifest);
  } else {
    const target = requiredFlag(args, "target");
    const operation = parseOperation(flag(args, "operation"));
    let proposalContent: string | undefined;
    if (operation !== "delete") {
      const filename = requiredFlag(args, "file");
      try {
        proposalContent = await readFile(filename, "utf8");
      } catch (error) {
        throw new ReviewError(
          "INVALID_ARGUMENTS",
          `Proposal file cannot be read: ${filename}`,
          { file: filename },
          { cause: error },
        );
      }
    }
    const source: { agent?: string; session?: string } = {};
    const agent = flag(args, "agent");
    const session = flag(args, "session");
    if (agent !== undefined) source.agent = agent;
    if (session !== undefined) source.session = session;
    const change: {
      operation?: SubmitOperation;
      target: string;
      newTarget?: string;
      proposalContent?: string;
    } = { target };
    if (operation !== undefined) change.operation = operation;
    const newTarget = flag(args, "new-target");
    if (newTarget !== undefined) change.newTarget = newTarget;
    if (proposalContent !== undefined) change.proposalContent = proposalContent;
    input = {
      ...(Object.keys(source).length === 0 ? {} : { source }),
      changes: [change],
    };
  }
  const review = await service.submit(input);
  return { document: reviewDocument(review), exitCode: EXIT.success };
}

async function updateCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "change", "file", "expected-revision"]);
  const reviewId = positional(args, 0, "review id");
  const changeId = requiredFlag(args, "change");
  const filename = requiredFlag(args, "file");
  const proposalContent = await readFile(filename, "utf8").catch((error: unknown) => {
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      `Proposal file cannot be read: ${filename}`,
      { file: filename },
      { cause: error },
    );
  });
  const expectedRevision = integerFlag(args, "expected-revision");
  const review = await service.updateProposal(reviewId, {
    changeId,
    proposalContent,
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
  });
  return { document: reviewDocument(review), exitCode: EXIT.success };
}

async function statusCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault"]);
  const review = await service.get(positional(args, 0, "review id"));
  return { document: reviewDocument(review), exitCode: EXIT.success };
}

async function showCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "conflict-context"]);
  const reviewId = positional(args, 0, "review id");
  const review = await service.get(reviewId);
  const document = {
    ...reviewDocument(review),
    changes: review.changes.map((change) => ({
      id: change.id,
      operation: change.operation,
      target: change.target,
      ...(change.newTarget === undefined ? {} : { newTarget: change.newTarget }),
      baseHash: change.baseHash,
      proposalHash: change.proposalHash,
      baseContent: change.baseContent,
      proposalContent: change.proposalContent,
      hunkDecisions: change.hunkDecisions,
    })),
    ...(booleanFlag(args, "conflict-context")
      ? { conflictContext: await service.conflictContext(reviewId) }
      : {}),
  };
  return { document, exitCode: EXIT.success };
}

async function listCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "status", "location"]);
  const statuses = parseStatuses(flag(args, "status"));
  const location = flag(args, "location");
  if (location !== undefined && location !== "pending" && location !== "history") {
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      "--location must be pending or history.",
    );
  }
  const reviews = await service.list({
    ...(statuses === undefined ? {} : { statuses }),
    ...(location === undefined ? {} : { locations: [location] }),
  });
  return { document: listDocument(reviews), exitCode: EXIT.success };
}

async function waitCommand(
  service: ReviewService,
  args: ParsedArguments,
  signal: AbortSignal,
): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "timeout-ms"]);
  const reviewId = positional(args, 0, "review id");
  await service.get(reviewId);
  const timeoutMs = integerFlag(args, "timeout-ms");
  const review = await waitForReview(service.store, reviewId, {
    signal,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { document: reviewDocument(review), exitCode: exitCodeForReview(review) };
}

async function cancelCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "expected-revision", "actor"]);
  const reviewId = positional(args, 0, "review id");
  const expectedRevision = integerFlag(args, "expected-revision");
  const actor = flag(args, "actor");
  const review = await service.cancel(reviewId, {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actor === undefined ? {} : { actor }),
  });
  return { document: reviewDocument(review), exitCode: EXIT.cancelled };
}

async function approveCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "expected-revision", "actor", "force"]);
  const reviewId = positional(args, 0, "review id");
  const expectedRevision = integerFlag(args, "expected-revision");
  const actor = flag(args, "actor");
  const result = await service.approve(reviewId, {
    force: booleanFlag(args, "force"),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actor === undefined ? {} : { actor }),
  });
  return {
    document: {
      ...reviewDocument(result.review),
      transactionId: result.transactionId,
      ...(result.maintenancePending === true ? { maintenancePending: true } : {}),
    },
    exitCode: EXIT.success,
  };
}

async function rejectCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "expected-revision", "actor"]);
  const reviewId = positional(args, 0, "review id");
  const expectedRevision = integerFlag(args, "expected-revision");
  const actor = flag(args, "actor");
  const review = await service.reject(reviewId, {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actor === undefined ? {} : { actor }),
  });
  return { document: reviewDocument(review), exitCode: EXIT.rejected };
}

async function rebaseCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, ["vault", "expected-revision", "actor"]);
  const expectedRevision = integerFlag(args, "expected-revision");
  const actor = flag(args, "actor");
  const review = await service.rebase(positional(args, 0, "review id"), {
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actor === undefined ? {} : { actor }),
  });
  return { document: reviewDocument(review), exitCode: EXIT.success };
}

async function hunkCommand(service: ReviewService, args: ParsedArguments): Promise<CommandResult> {
  rejectUnknownFlags(args, [
    "vault",
    "change",
    "hunk-id",
    "decision",
    "expected-revision",
    "actor",
  ]);
  const decision = requiredFlag(args, "decision");
  if (decision !== "accept" && decision !== "reject") {
    throw new ReviewError(
      "INVALID_ARGUMENTS",
      "--decision must be accept or reject.",
    );
  }
  const expectedRevision = integerFlag(args, "expected-revision");
  const actor = flag(args, "actor");
  const review = await service.decideHunk(positional(args, 0, "review id"), {
    changeId: requiredFlag(args, "change"),
    hunkId: requiredFlag(args, "hunk-id"),
    decision: decision === "accept" ? "accepted" : "rejected",
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actor === undefined ? {} : { actor }),
  });
  return { document: reviewDocument(review), exitCode: EXIT.success };
}

interface CommandResult {
  readonly document: unknown;
  readonly exitCode: number;
}

function parseOperation(value: string | undefined): SubmitOperation | undefined {
  if (value === undefined) return undefined;
  if (
    value === "auto" ||
    value === "create" ||
    value === "modify" ||
    value === "delete" ||
    value === "rename"
  ) {
    return value;
  }
  throw new ReviewError(
    "INVALID_ARGUMENTS",
    "--operation must be auto, create, modify, delete, or rename.",
  );
}

function parseStatuses(value: string | undefined): readonly ReviewStatus[] | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set<ReviewStatus>([
    "pending",
    "approved",
    "rejected",
    "conflicted",
    "cancelled",
  ]);
  const statuses = value.split(",").map((item) => item.trim()) as ReviewStatus[];
  if (statuses.length === 0 || statuses.some((status) => !allowed.has(status))) {
    throw new ReviewError("INVALID_ARGUMENTS", `Invalid --status value: ${value}`);
  }
  return statuses;
}

function usage(): string {
  return `Obsidian Review Gate CLI ${VERSION}\n\n` +
    `Usage:\n` +
    `  obsreview submit --vault <vault> --target <path> --file <proposal> [--agent <name>] [--json]\n` +
    `  obsreview submit --vault <vault> --manifest <review.json> [--json]\n` +
    `  obsreview update <review-id> --vault <vault> --change <id> --file <proposal> [--expected-revision <n>]\n` +
    `  obsreview status <review-id> --vault <vault> [--json]\n` +
    `  obsreview show <review-id> --vault <vault> [--conflict-context] [--json]\n` +
    `  obsreview list --vault <vault> [--status pending,conflicted] [--json]\n` +
    `  obsreview wait <review-id> --vault <vault> [--timeout-ms <ms>] [--json]\n` +
    `  obsreview cancel <review-id> --vault <vault> [--expected-revision <n>] [--json]\n` +
    `\nAdministrative/UI-equivalent commands: approve, reject, rebase, hunk.\n`;
}

if (require.main === module) {
  void run(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
