/** Fresh structural adoption evidence; never rewrites allowances or historical Clippy evidence. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ADOPTION_SOURCE = "7223352101f448dd2ad46e40e285e689a2788435";
export const ADOPTION_REFERENCE = "87bef7d99b4945f1950577316bcbabc766714269";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE = "rust/quality-baseline.json";
type Target = { root: string; lines: number; sources: string[] };
export type Inventory = { sources: Record<string, number>; targets: Record<string, Target> };
type Reference = { targets: Record<string, number>; adoption: Record<string, string> };
const sha256 = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const comparePaths = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

export const validateInventory = (inventory: Inventory): void => {
  const paths = Object.keys(inventory.sources);
  assert(paths.length > 0, "empty source inventory");
  assert.deepEqual(paths, [...paths].sort(comparePaths), "source inventory must be sorted");
  for (const [path, lines] of Object.entries(inventory.sources)) {
    assert(path.startsWith("rust/crates/") && path.endsWith(".rs") && !path.split("/").includes(".."), `invalid source path ${path}`);
    assert(Number.isSafeInteger(lines) && lines >= 0, `invalid physical line count ${path}`);
  }
  const keys = Object.keys(inventory.targets);
  assert.deepEqual(keys, [...keys].sort(comparePaths), "target inventory must be sorted");
  for (const [key, target] of Object.entries(inventory.targets)) {
    assert(target.sources.includes(target.root), `target root absent from closure ${key}`);
    assert.deepEqual(target.sources, [...new Set(target.sources)].sort(comparePaths), `target closure must be sorted and unique ${key}`);
    let lines = 0;
    for (const path of target.sources) {
      assert(Object.hasOwn(inventory.sources, path), `target has unowned source ${key}: ${path}`);
      lines += inventory.sources[path];
    }
    assert.equal(target.lines, lines, `target closure line mismatch ${key}`);
  }
};

export const compareAdoptionTargets = (inventory: Inventory, expected: Record<string, number>): Record<string, number> => {
  validateInventory(inventory);
  for (const lines of Object.values(expected)) assert(Number.isSafeInteger(lines) && lines > 1000, "invalid adopted target count");
  const actual = Object.fromEntries(
    Object.entries(inventory.targets)
      .filter(([, target]) => target.lines > 1000)
      .map(([key, target]) => [key, target.lines])
  );
  assert.deepEqual(actual, expected, "immutable source must reproduce exactly the adopted oversized targets");
  return actual;
};

const offlineEnvironment = (): Record<string, string> => {
  const environment: Record<string, string> = { CARGO_BUILD_JOBS: "2", CARGO_NET_OFFLINE: "true" };
  for (const key of ["PATH", "HOME", "TMPDIR", "CARGO_HOME", "RUSTUP_HOME", "RUSTUP_TOOLCHAIN", "RUSTC", "RUSTDOC", "CARGO_TARGET_DIR", "XDG_CACHE_HOME"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  assert(environment.CARGO_TARGET_DIR, "a prepared CARGO_TARGET_DIR is required");
  assert(environment.RUSTC, "a prepared RUSTC is required");
  return environment;
};

const scannerInputs = (git: (...args: string[]) => string): Record<string, string> => {
  const paths = git("ls-files", "-z", "rust/crates/gateway-quality", "rust/crates/gateway-quality-syntax").split("\0").filter(Boolean);
  paths.push("rust/Cargo.toml", "rust/Cargo.lock", "scripts/rust-quality-adoption.ts");
  for (const path of ["rust-toolchain.toml", ".cargo/config.toml", "rust/rust-toolchain.toml", "rust/.cargo/config.toml"]) {
    if (existsSync(resolve(ROOT, path))) paths.push(path);
  }
  return Object.fromEntries([...new Set(paths)].sort(comparePaths).map((path) => [path, sha256(readFileSync(resolve(ROOT, path)))]));
};

const buildScanner = (run: (argv: string[]) => string): string => {
  const build = run([
    "cargo",
    "build",
    "--locked",
    "--offline",
    "--manifest-path",
    resolve(ROOT, "rust/Cargo.toml"),
    "-p",
    "gateway-quality",
    "--message-format=json",
  ]);
  const artifacts = build
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { reason: string; manifest_path?: string; executable?: string | null });
  const executable = artifacts.find(
    (artifact) =>
      artifact.reason === "compiler-artifact" && artifact.manifest_path === resolve(ROOT, "rust/crates/gateway-quality/Cargo.toml") && artifact.executable
  )?.executable;
  assert(executable, "Cargo did not identify the source-bound scanner executable");
  return executable;
};

const reproduce = (destination: string): void => {
  assert.equal(Bun.version, "1.4.0", "adoption reproduction requires Bun 1.4.0");
  const output = resolve(destination);
  const environment = offlineEnvironment();
  mkdirSync(output); // Existing evidence is never replaced.
  const commands: { argv: string[]; exitCode: number; stdout: string; stderr: string }[] = [];
  const run = (argv: string[]): string => {
    const child = Bun.spawnSync(argv, { cwd: ROOT, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const prefix = `command-${String(commands.length + 1).padStart(2, "0")}`;
    writeFileSync(resolve(output, `${prefix}.stdout`), child.stdout);
    writeFileSync(resolve(output, `${prefix}.stderr`), child.stderr);
    commands.push({ argv, exitCode: child.exitCode, stdout: `${prefix}.stdout`, stderr: `${prefix}.stderr` });
    writeFileSync(resolve(output, "commands.json"), json(commands));
    assert.equal(child.exitCode, 0, `${argv[0]} failed: ${child.stderr.toString()}`);
    return child.stdout.toString();
  };
  const git = (...args: string[]): string => run(["git", ...args]);
  const baselineBefore = sha256(readFileSync(resolve(ROOT, BASELINE)));
  const sourceTree = git("rev-parse", `${ADOPTION_SOURCE}^{tree}`).trim();
  const referenceBytes = git("show", `${ADOPTION_REFERENCE}:${BASELINE}`);
  writeFileSync(resolve(output, "reference-baseline.json"), referenceBytes);
  const reference = JSON.parse(referenceBytes) as Reference;
  assert.equal(reference.adoption.sourceGitSha, ADOPTION_SOURCE);
  assert.equal(reference.adoption.sourceTree, sourceTree);
  assert.equal(Object.keys(reference.targets).length, 14, "immutable reference must contain all 14 adopted targets");
  const source = resolve(output, "source");
  mkdirSync(source);
  const archive = resolve(output, "source.tar");
  git("archive", "--format=tar", `--output=${archive}`, ADOPTION_SOURCE, "rust");
  run(["tar", "-xf", archive, "-C", source]);
  const sourceLock = sha256(readFileSync(resolve(source, "rust/Cargo.lock")));
  const sourceClippyConfig = sha256(readFileSync(resolve(source, "rust/clippy.toml")));
  assert.equal(sourceLock, reference.adoption.sourceLockSha256);
  assert.equal(sourceClippyConfig, reference.adoption.sourceClippyConfigSha256);
  const rustc = run([environment.RUSTC, "--version"]).trim();
  const cargo = run(["cargo", "--version"]).trim();
  assert(rustc.startsWith("rustc 1.98.1 ") && cargo.startsWith("cargo 1.98.1 "), "prepared Rust 1.98.1 is required");
  const scannerSources = scannerInputs(git);
  writeFileSync(resolve(output, "scanner-sources.json"), json(scannerSources));
  const executable = buildScanner(run);
  const executableSha256 = sha256(readFileSync(executable));
  const inventoryBytes = run([executable, "--inventory", source]);
  writeFileSync(resolve(output, "target-closures.json"), inventoryBytes);
  const inventory = JSON.parse(inventoryBytes) as Inventory;
  const matchedTargets = compareAdoptionTargets(inventory, reference.targets);
  const sources = Object.fromEntries(
    Object.entries(inventory.sources).map(([path, lines]) => [path, { lines, sha256: sha256(readFileSync(resolve(source, path))) }])
  );
  writeFileSync(resolve(output, "source-inventory.json"), json(sources));
  writeFileSync(resolve(output, "adopted-targets.json"), json(Object.fromEntries(Object.keys(matchedTargets).map((key) => [key, inventory.targets[key]]))));
  assert.deepEqual(
    scannerSources,
    Object.fromEntries(Object.keys(scannerSources).map((path) => [path, sha256(readFileSync(resolve(ROOT, path)))])),
    "scanner sources changed during reproduction"
  );
  assert.equal(sha256(readFileSync(executable)), executableSha256, "scanner executable changed during reproduction");
  assert.equal(sha256(readFileSync(resolve(ROOT, BASELINE))), baselineBefore, "current allowances changed during reproduction");
  const provenance = {
    schemaVersion: 1,
    sourceGitSha: ADOPTION_SOURCE,
    sourceTree,
    sourceArchivePaths: ["rust"],
    sourceArchiveSha256: sha256(readFileSync(archive)),
    sourceLockSha256: sourceLock,
    sourceClippyConfigSha256: sourceClippyConfig,
    referenceGitSha: ADOPTION_REFERENCE,
    referenceBaselineSha256: sha256(referenceBytes),
    currentBaselineSha256: baselineBefore,
    scanner: {
      gitHead: git("rev-parse", "HEAD").trim(),
      gitTree: git("rev-parse", "HEAD^{tree}").trim(),
      worktreeStatus: git("status", "--porcelain"),
      sourcesSha256: sha256(json(scannerSources)),
      executableSha256,
    },
    runtime: { bun: Bun.version, rustc, cargo, jobs: 2, offline: true, targetDirectory: environment.CARGO_TARGET_DIR },
    measured: { sources: Object.keys(sources).length, targets: Object.keys(inventory.targets).length, adoptedTargets: matchedTargets },
    manifests: Object.fromEntries(
      ["scanner-sources.json", "source-inventory.json", "target-closures.json", "adopted-targets.json"].map((path) => [
        path,
        sha256(readFileSync(resolve(output, path))),
      ])
    ),
    historicalAdoptionMetadata: reference.adoption,
    clippyCaptureStatus: "not reproduced; historical diagnostics, context hashes and receipts are retained metadata only",
  };
  writeFileSync(resolve(output, "provenance.json"), json(provenance));
  console.log(`Reproduced ${Object.keys(matchedTargets).length} adopted targets from ${ADOPTION_SOURCE}; provenance: ${resolve(output, "provenance.json")}`);
};

if (import.meta.main) {
  try {
    const [destination, ...extra] = process.argv.slice(2);
    assert(destination && extra.length === 0, "usage: bun --no-env-file --no-install scripts/rust-quality-adoption.ts NEW_OUTPUT_DIRECTORY");
    reproduce(destination);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
