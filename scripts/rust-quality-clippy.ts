/** Real Clippy diagnostics, staged individually without weakening -D warnings. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUST_NATIVE_ONLY_PACKAGES } from "./test-scope.ts";

export const STAGED_CLIPPY_LINTS = ["pub_use", "too_many_lines", "excessive_nesting", "wildcard_imports", "unwrap_used", "expect_used"] as const;
export const stagedClippyArguments = (): string[] => STAGED_CLIPPY_LINTS.flatMap((lint) => ["--force-warn", `clippy::${lint}`]);
type Counts = Readonly<Record<string, number>>;
type DiagnosticInventory = Readonly<{ counts: Counts; packages: ReadonlySet<string> }>;
type Context = Readonly<{ start_line: number; start_column: number; end_line: number; end_column: number; tokens: string }>;
type ContextFile = Readonly<{ source: string; contexts: readonly Context[] }>;
const fingerprint = (tokens: string): string => createHash("sha256").update(tokens).digest("hex");
const contextsFor = (root: string, directory: string): ReadonlyMap<string, ContextFile> => {
  const index = record(JSON.parse(readFileSync(resolve(directory, "quality-contexts.json"), "utf8")));
  if (index.root !== resolve(root)) throw new Error("Parser context root does not match Clippy source");
  const files = new Map<string, ContextFile>();
  for (const [path, raw] of Object.entries(record(index.files))) {
    const file = record(raw);
    const source = text(file.source === "" ? "\n" : file.source);
    if (!path.startsWith("rust/crates/") || relative(root, resolve(root, path)) !== path || readFileSync(resolve(root, path), "utf8") !== file.source) {
      throw new Error("Parser context source changed or escaped its root");
    }
    if (!Array.isArray(file.contexts)) throw new Error("Missing parser item contexts");
    const contexts = file.contexts.map((entry): Context => {
      const context = record(entry);
      for (const key of ["start_line", "start_column", "end_line", "end_column"]) {
        if (typeof context[key] !== "number" || !Number.isSafeInteger(context[key]) || context[key] < 1) throw new Error("Malformed parser item span");
      }
      return {
        start_line: Number(context.start_line),
        start_column: Number(context.start_column),
        end_line: Number(context.end_line),
        end_column: Number(context.end_column),
        tokens: text(context.tokens),
      };
    });
    files.set(path.slice("rust/crates/".length), { source, contexts });
  }
  return files;
};
const contextAt = (files: ReadonlyMap<string, ContextFile>, path: string, line: number, column: number, endLine: number, endColumn: number): string => {
  const file = files.get(path);
  if (!file) throw new Error("Staged diagnostic has no parser-bound source file");
  const candidates = file.contexts.filter(
    (item) =>
      (item.start_line < line || (item.start_line === line && item.start_column <= column)) &&
      (item.end_line > endLine || (item.end_line === endLine && item.end_column >= endColumn))
  );
  candidates.sort(
    (left, right) =>
      left.end_line - left.start_line - (right.end_line - right.start_line) || left.end_column - left.start_column - (right.end_column - right.start_column)
  );
  if (candidates.length === 0) throw new Error("Staged diagnostic has no enclosing parsed item");
  return fingerprint(candidates[0].tokens);
};
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Malformed Clippy JSON object");
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== "string" || value === "") throw new Error("Missing Clippy diagnostic identity");
  return value;
};
const firstParty = (root: string, cwd: string, path: unknown): string => {
  const source = relative(resolve(root, "rust/crates"), resolve(cwd, text(path)));
  if (isAbsolute(source) || source === ".." || source.startsWith("../")) throw new Error("Clippy source is outside first-party crates");
  return source.split("\\").join("/");
};
const countMap = (value: unknown): Record<string, number> => {
  const entries = Object.entries(record(value));
  if (entries.some(([key, count]) => key === "" || typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)) {
    throw new Error("Malformed Clippy baseline count");
  }
  return Object.fromEntries(entries) as Record<string, number>;
};

type Event = Record<string, unknown>;
const cargoEvents = (stdout: string): Event[] => {
  const events = stdout
    .split("\n")
    .filter((value) => value.trim() !== "")
    .map((line) => record(JSON.parse(line)));
  const terminal = events.pop();
  if (terminal?.reason !== "build-finished" || terminal.success !== true) throw new Error("Missing successful Clippy build-finished receipt");
  if (events.some((event) => !["compiler-message", "compiler-artifact", "build-script-executed"].includes(text(event.reason)))) {
    throw new Error("Unsupported or out-of-order Cargo JSON event");
  }
  return events;
};
const packageOwner = (root: string, event: Event, version: string): string => {
  const owner = firstParty(root, resolve(root, "rust"), record(event.target).src_path).split("/")[0];
  const id = text(event.package_id);
  const parts = id.split("#");
  if (parts.length !== 2) throw new Error("Clippy package identity mismatch");
  const [url, suffix] = parts;
  if (!url.startsWith("path+") || ![version, `${owner}@${version}`].includes(suffix)) throw new Error("Clippy package identity mismatch");
  if (fileURLToPath(url.slice("path+".length)) !== resolve(root, "rust/crates", owner)) throw new Error("Clippy package source identity mismatch");
  return owner;
};
const artifactPackage = (root: string, event: Event, version: string): string | undefined => {
  if (event.reason !== "compiler-artifact") return undefined;
  const target = record(event.target);
  // Dependency artifacts are valid Cargo messages but do not own baseline debt.
  if (typeof target.src_path !== "string" || !target.src_path.startsWith(resolve(root, "rust/crates") + "/")) return undefined;
  return packageOwner(root, event, version);
};
const primaryLocations = (root: string, message: Event) => {
  if (!Array.isArray(message.spans)) throw new Error("Clippy diagnostic has no source spans");
  const primary = message.spans.map(record).filter((span) => span.is_primary === true);
  if (primary.length === 0) throw new Error("Clippy diagnostic has no primary source span");
  return primary.map((span) => {
    for (const field of ["line_start", "column_start", "line_end", "column_end"]) {
      if (typeof span[field] !== "number" || !Number.isSafeInteger(span[field]) || span[field] < 1) throw new Error("Invalid Clippy source span");
    }
    return {
      path: firstParty(root, resolve(root, "rust"), span.file_name),
      line: Number(span.line_start),
      column: Number(span.column_start),
      endLine: Number(span.line_end),
      endColumn: Number(span.column_end),
    };
  });
};
const stagedDiagnostic = (
  root: string,
  event: Event,
  version: string,
  contexts: ReadonlyMap<string, ContextFile>
): { key: string; identity: string } | undefined => {
  if (event.reason !== "compiler-message") return undefined;
  const message = record(event.message);
  if (message.code === null) return undefined;
  const code = text(record(message.code).code);
  if (!STAGED_CLIPPY_LINTS.some((lint) => code === `clippy::${lint}`)) return undefined;
  if (message.level !== "warning") throw new Error("Staged Clippy diagnostic has an unexpected level");
  const owner = packageOwner(root, event, version);
  const locations = primaryLocations(root, message);
  const location = locations[0];
  const context = contextAt(contexts, location.path, location.line, location.column, location.endLine, location.endColumn);
  const key = `${code}/${context}`;
  return { key, identity: JSON.stringify([owner, key, locations]) };
};
const contextOccurrences = (counts: Record<string, number>, contexts: ReadonlyMap<string, ContextFile>): void => {
  const used = new Set(Object.keys(counts).map((key) => key.split("/")[1]));
  for (const file of contexts.values())
    for (const context of file.contexts) {
      const hash = fingerprint(context.tokens);
      if (used.has(hash)) counts[`context/${hash}`] = (counts[`context/${hash}`] ?? 0) + 1;
    }
};
export const clippyInventory = (root: string, stdout: string, contextDirectory = resolve(root, "rust/target")): DiagnosticInventory => {
  const contexts = contextsFor(root, contextDirectory);
  const workspace = record(Bun.TOML.parse(readFileSync(resolve(root, "rust/Cargo.toml"), "utf8")));
  const version = text(record(record(workspace.workspace).package).version);
  const counts: Record<string, number> = {};
  const packages = new Set<string>();
  const diagnostics = new Set<string>();
  for (const event of cargoEvents(stdout)) {
    const owner = artifactPackage(root, event, version);
    if (owner) packages.add(owner);
    const diagnostic = stagedDiagnostic(root, event, version, contexts);
    if (!diagnostic) continue;
    if (!diagnostics.has(diagnostic.identity)) counts[diagnostic.key] = (counts[diagnostic.key] ?? 0) + 1;
    diagnostics.add(diagnostic.identity);
  }
  contextOccurrences(counts, contexts);
  return { counts: Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))), packages };
};

export const checkClippyDiagnostics = (
  root: string,
  stage: string,
  stdout: string,
  selected: readonly string[],
  contextDirectory?: string
): DiagnosticInventory => {
  const inventory = clippyInventory(root, stdout, contextDirectory);
  const baseline = record(JSON.parse(readFileSync(resolve(root, "rust/quality-baseline.json"), "utf8")));
  const limits = countMap(record(baseline.clippy)[stage]);
  if (selected.some((name) => !inventory.packages.has(name))) throw new Error("Clippy omitted a selected first-party package artifact");
  const failures = Object.entries(inventory.counts).filter(([key, count]) => count > (limits[key] ?? 0));
  if (failures.length > 0) throw new Error(failures.map(([key, count]) => `${key}: staged Clippy debt grew to ${count} from ${limits[key] ?? 0}`).join("\n"));
  return inventory;
};

export const tightenClippyDiagnostics = (root: string, stage: string, stdout: string, selected: readonly string[], contextDirectory?: string): void => {
  const workspace = record(Bun.TOML.parse(readFileSync(resolve(root, "rust/Cargo.toml"), "utf8")));
  const members = record(workspace.workspace).members;
  if (!Array.isArray(members) || members.some((member) => typeof member !== "string" || !member.startsWith("crates/")))
    throw new Error("Invalid explicit workspace members");
  const expected = members
    .map((member: string) => member.slice("crates/".length))
    .filter((name) => stage === "native" || !RUST_NATIVE_ONLY_PACKAGES.some((nativeOnly) => nativeOnly === name))
    .sort((left, right) => left.localeCompare(right));
  if (JSON.stringify([...selected].sort((left, right) => left.localeCompare(right))) !== JSON.stringify(expected))
    throw new Error("Clippy updater requires the complete stage package inventory");
  const inventory = checkClippyDiagnostics(root, stage, stdout, selected, contextDirectory);
  const path = resolve(root, "rust/quality-baseline.json");
  const baseline = record(JSON.parse(readFileSync(path, "utf8")));
  const stages = record(baseline.clippy);
  stages[stage] = inventory.counts;
  writeFileSync(path, JSON.stringify(baseline, null, 2) + "\n");
};

if (import.meta.main) {
  try {
    const [mode, stage, file, ...selected] = process.argv.slice(2);
    if (mode !== "--update" || !["native", "wasm"].includes(stage) || !file || selected.length === 0) {
      throw new Error("usage: rust-quality-clippy.ts --update native|wasm DIAGNOSTICS_JSONL SELECTED_PACKAGE...");
    }
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    tightenClippyDiagnostics(root, stage, readFileSync(file, "utf8"), selected, process.env.CARGO_TARGET_DIR);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
