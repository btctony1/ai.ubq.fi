import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

type OwnerCommand = Readonly<{ argv: readonly string[]; cwd: string; isolated?: boolean }>;
type OwnerResult = Readonly<{ code: number; stdout: string; stderr: string }>;
type OwnerRunner = (command: OwnerCommand, environment: Record<string, string>) => Promise<OwnerResult>;
const MARKER = ".uos-worktree-owner.json";
const CARGO_COMPILERS = new Set(["build", "check", "test", "clippy", "run", "bench", "rustc", "rustdoc"]);
const CARGO_OPTION_VALUES = new Set(["--config", "--color", "--explain", "--manifest-path", "--target-dir", "-C", "-Z"]);
const argumentsBeforeSeparator = (argv: readonly string[]): readonly string[] => {
  const separator = argv.indexOf("--");
  return separator < 0 ? argv.slice(1) : argv.slice(1, separator);
};
const cargoOperation = (args: readonly string[]): string | undefined => {
  let skipValue = false;
  for (const arg of args) {
    if (skipValue) {
      skipValue = false;
      continue;
    }
    if (CARGO_OPTION_VALUES.has(arg)) skipValue = true;
    else if (!arg.startsWith("-") && !arg.startsWith("+")) return arg;
  }
  return undefined;
};

export const isRustCompilerCommand = (argv: readonly string[]): boolean => {
  const tool = basename(argv[0] ?? "");
  const args = argumentsBeforeSeparator(argv);
  if (args.includes("--help") || args.includes("-h")) return false;
  if (tool === "cargo") {
    const operation = cargoOperation(args);
    return (
      (operation !== undefined && CARGO_COMPILERS.has(operation)) ||
      (operation === "install" && args.some((arg) => arg === "--path" || arg.startsWith("--path=")))
    );
  }
  if (!["worker-build", "cargo-clippy", "rustc"].includes(tool)) return false;
  return !args.some((arg) => ["--version", "-V", "-vV"].includes(arg));
};

const option = (args: readonly string[], name: string): string | undefined => {
  const matches = args.flatMap((arg, index) => {
    if (arg.startsWith(`${name}=`)) return [arg.slice(name.length + 1)];
    if (arg !== name) return [];
    const value = args[index + 1];
    if (!value || value.startsWith("-")) throw new Error(`Rust target ownership requires a value for ${name}`);
    return [value];
  });
  if (matches.length > 1 || matches.some((value) => value === "")) throw new Error(`Ambiguous Rust target ownership option: ${name}`);
  return matches[0];
};

const metadataArguments = (command: OwnerCommand): string[] => {
  const args = argumentsBeforeSeparator(command.argv);
  const manifest = option(args, "--manifest-path");
  const localInstall = option(args, "--path");
  const flags = ["metadata", "--no-deps", "--locked", "--offline", "--format-version=1"];
  if (manifest) flags.push("--manifest-path", resolve(command.cwd, manifest));
  else if (localInstall) flags.push("--manifest-path", resolve(command.cwd, localInstall, "Cargo.toml"));
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith("--config=")) flags.push(arg);
    else if (arg === "--config") {
      const value = args[index + 1];
      if (!value) throw new Error("Rust target ownership requires a Cargo configuration value");
      flags.push(arg, value);
    }
  }
  return flags;
};

/** Exclusive creation binds caches to one physical source root, never to a source revision. */
export const claimRustTarget = (source: string, target: string): void => {
  if (!isAbsolute(source) || !isAbsolute(target)) throw new Error("Rust target ownership requires absolute source and target paths");
  const root = realpathSync(source);
  mkdirSync(target, { recursive: true });
  const directory = realpathSync(target);
  const marker = join(directory, MARKER);
  const expected = JSON.stringify({ version: 1, sourceRoot: root }) + "\n";
  const check = (): void => {
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.isSymbolicLink() || readFileSync(marker, "utf8") !== expected)
      throw new Error("Rust target is owned by another source root or has an invalid owner marker");
  };
  if (existsSync(marker)) {
    check();
    return;
  }
  if (readdirSync(directory).length > 0) throw new Error("Unowned nonempty Rust target refused; select a new empty target");
  try {
    writeFileSync(marker, expected, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    check();
  }
};

export const guardRustTarget = async (command: OwnerCommand, environment: Record<string, string>, run: OwnerRunner): Promise<void> => {
  if (!isRustCompilerCommand(command.argv)) return;
  if (basename(command.argv[0]) === "rustc") throw new Error("Standalone rustc compilation has no verified Cargo source owner");
  const cargo = basename(command.argv[0]) === "cargo" ? command.argv[0] : Bun.which("cargo", { PATH: environment.PATH });
  if (!cargo) throw new Error("Pinned Cargo is required to resolve the actual Rust source owner");
  const target = option(argumentsBeforeSeparator(command.argv), "--target-dir");
  const selected = target ? { ...environment, CARGO_TARGET_DIR: resolve(command.cwd, target) } : environment;
  const result = await run({ argv: [cargo, ...metadataArguments(command)], cwd: command.cwd, isolated: command.isolated }, selected);
  if (result.code !== 0) throw new Error(`Cannot resolve Rust target source ownership: ${result.stderr}`);
  const metadata: unknown = JSON.parse(result.stdout);
  if (typeof metadata !== "object" || metadata === null || !("workspace_root" in metadata) || !("target_directory" in metadata))
    throw new Error("Cargo metadata omitted Rust source/target ownership");
  const source = metadata.workspace_root;
  const directory = metadata.target_directory;
  if (typeof source !== "string" || typeof directory !== "string") throw new Error("Cargo metadata has invalid Rust source/target ownership");
  claimRustTarget(source, target ? resolve(command.cwd, target) : directory);
};
