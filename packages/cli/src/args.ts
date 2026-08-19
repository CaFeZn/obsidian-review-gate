import { ReviewError } from "../../core/src/model/errors";

export interface ParsedArguments {
  readonly command: string | null;
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
}

const BOOLEAN_FLAGS = new Set([
  "json",
  "force",
  "conflict-context",
  "help",
  "version",
]);

export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  let command: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      const equal = token.indexOf("=");
      const name = (equal >= 0 ? token.slice(2, equal) : token.slice(2)).trim();
      if (name.length === 0) throw badArgs("Empty option name.");
      let value: string;
      if (equal >= 0) {
        value = token.slice(equal + 1);
      } else if (BOOLEAN_FLAGS.has(name)) {
        value = "true";
      } else {
        const next = argv[index + 1];
        if (next === undefined || next.startsWith("--")) {
          throw badArgs(`Option --${name} requires a value.`);
        }
        value = next;
        index += 1;
      }
      const values = flags.get(name) ?? [];
      values.push(value);
      flags.set(name, values);
      continue;
    }
    if (command === null) command = token;
    else positionals.push(token);
  }
  return { command, positionals, flags };
}

export function flag(
  args: ParsedArguments,
  name: string,
): string | undefined {
  const values = args.flags.get(name);
  return values?.[values.length - 1];
}

export function flags(args: ParsedArguments, name: string): readonly string[] {
  return args.flags.get(name) ?? [];
}

export function requiredFlag(args: ParsedArguments, name: string): string {
  const value = flag(args, name);
  if (value === undefined || value.trim().length === 0) {
    throw badArgs(`Missing required option --${name}.`);
  }
  return value;
}

export function booleanFlag(args: ParsedArguments, name: string): boolean {
  return flag(args, name) === "true";
}

export function integerFlag(
  args: ParsedArguments,
  name: string,
): number | undefined {
  const value = flag(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw badArgs(`Option --${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function positional(args: ParsedArguments, index: number, label: string): string {
  const value = args.positionals[index];
  if (value === undefined || value.length === 0) {
    throw badArgs(`Missing ${label}.`);
  }
  return value;
}

export function rejectUnknownFlags(
  args: ParsedArguments,
  allowed: readonly string[],
): void {
  const allow = new Set([...allowed, "json", "help"]);
  for (const name of args.flags.keys()) {
    if (!allow.has(name)) throw badArgs(`Unknown option --${name}.`);
  }
}

export function badArgs(message: string): ReviewError {
  return new ReviewError("INVALID_ARGUMENTS", message);
}
