/** Parser-backed structural gate. Cargo inputs must already be prepared offline. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const rustQualityArguments = (args: readonly string[], root: string): string[] => {
  if (args.length > 1 || (args.length === 1 && !["--check", "--update", "--init"].includes(args[0]))) {
    throw new Error("usage: rust-quality.ts [--check|--update|--init]");
  }
  return ["run", "--locked", "--offline", "--manifest-path", resolve(root, "rust/Cargo.toml"), "-p", "gateway-quality", "--", args[0] ?? "--check", root];
};

if (import.meta.main) {
  try {
    if (Bun.version !== "1.4.0") throw new Error("Rust quality requires Bun 1.4.0");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const child = Bun.spawn(["cargo", ...rustQualityArguments(process.argv.slice(2), root)], {
      cwd: resolve(root, "rust"),
      env: process.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    });
    process.exitCode = await child.exited;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
