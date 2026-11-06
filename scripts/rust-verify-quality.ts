import { resolve } from "node:path";
import type { CommandResult, RustCommand, RustStage } from "./rust-verify.ts";
import { checkClippyDiagnostics, stagedClippyArguments } from "./rust-quality-clippy.ts";

export const rustQualityCommands = (root: string, cwd: string): RustCommand[] => [
  { argv: ["cargo", "test", "--locked", "--offline", "-p", "gateway-quality"], cwd, isolated: true, testRun: true },
  { argv: ["cargo", "run", "--locked", "--offline", "-p", "gateway-quality", "--", "--check", root], cwd, isolated: true },
];
export const rustClippyCommand = (stage: RustStage, cwd: string, cargo: readonly string[], names: readonly string[]): RustCommand => ({
  argv: [
    "cargo",
    "clippy",
    ...cargo,
    "--message-format=json",
    ...(stage === "native" ? ["--all-targets"] : ["--lib"]),
    "--",
    "-D",
    "warnings",
    ...stagedClippyArguments(),
  ],
  cwd,
  isolated: true,
  clippyStage: stage,
  clippyPackages: names,
});

export const observeRustCommandResult = (command: RustCommand, result: CommandResult, environment: Record<string, string> = {}): number => {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.code !== 0) throw new Error(`Rust command failed (${result.code}): ${command.argv.join(" ")}`);
  if (command.clippyStage)
    checkClippyDiagnostics(resolve(command.cwd, ".."), command.clippyStage, result.stdout, command.clippyPackages ?? [], environment.CARGO_TARGET_DIR);
  const tests = command.testListing ? result.stdout.split("\n").filter((line) => /: test\s*$/.test(line)).length : 0;
  if (command.testListing && tests === 0) throw new Error("Selected Rust test package listed zero tests");
  if (command.testRun && !/^test result: ok\..* [1-9]\d* passed;/m.test(result.stdout))
    throw new Error("Selected Rust test package executed zero passing tests");
  return tests;
};
