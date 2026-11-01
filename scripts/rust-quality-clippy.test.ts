import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkClippyDiagnostics, clippyInventory, stagedClippyArguments, tightenClippyDiagnostics } from "./rust-quality-clippy.ts";
import { RUST_NATIVE_ONLY_PACKAGES } from "./test-scope.ts";

const temporary = mkdtempSync(join(tmpdir(), "uos-clippy-contract-"));
afterAll(() => {
  rmSync(temporary, { recursive: true, force: true });
});
const original = "fn existing() { Some(1).unwrap(); }";
const sourcePath = "rust/crates/fixture/src/lib.rs";
const write = (root: string, path: string, text: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
const index = (root: string, files: Readonly<Record<string, string>>): void => {
  const entries = Object.entries(files).map(([path, source]) => {
    write(root, path, source);
    return [path, { source, contexts: [{ start_line: 1, start_column: 1, end_line: 1, end_column: source.length + 1, tokens: source }] }];
  });
  write(root, "rust/target/quality-contexts.json", JSON.stringify({ root, files: Object.fromEntries(entries) }));
};
const output = (root: string, path = sourcePath, repetitions = 1, lint = "unwrap_used"): string => {
  const target = { src_path: join(root, path) };
  const packageId = `path+file://${join(root, "rust/crates", path.slice("rust/crates/".length).split("/")[0])}#0.1.0`;
  const diagnostic = {
    reason: "compiler-message",
    package_id: packageId,
    target,
    message: {
      code: { code: `clippy::${lint}` },
      level: "warning",
      spans: [{ file_name: path.slice("rust/".length), is_primary: true, line_start: 1, column_start: 17, line_end: 1, column_end: 33 }],
    },
  };
  return [
    JSON.stringify({ reason: "compiler-artifact", target, package_id: packageId }),
    ...Array.from({ length: repetitions }, () => JSON.stringify(diagnostic)),
    JSON.stringify({ reason: "build-finished", success: true }),
  ].join("\n");
};
const fixture = (): string => {
  const root = mkdtempSync(join(temporary, "run-"));
  index(root, { [sourcePath]: original });
  write(root, "rust/Cargo.toml", '[workspace]\nmembers=["crates/fixture","crates/other"]\n[workspace.package]\nversion="0.1.0"\n');
  const inventory = clippyInventory(root, output(root));
  write(root, "rust/quality-baseline.json", JSON.stringify({ clippy: { native: inventory.counts } }));
  return root;
};

test("staged Clippy keeps individually selected force-warn flags and deduplicates repeated lib/test diagnostics", () => {
  const root = fixture();
  const diagnostics = clippyInventory(root, output(root, sourcePath, 2));
  assert.equal(
    Object.values(diagnostics.counts).reduce((sum, count) => sum + count, 0),
    2
  );
  assert.ok(stagedClippyArguments().includes("clippy::unwrap_used"));
  assert.ok(stagedClippyArguments().includes("clippy::excessive_nesting"));
  assert.ok(!stagedClippyArguments().includes("--cap-lints"));
  assert.doesNotThrow(() => checkClippyDiagnostics(root, "native", output(root), ["fixture"]));
});

test("an unchanged function may move between crates while a copied occurrence is rejected", () => {
  const root = fixture();
  const moved = "rust/crates/other/src/lib.rs";
  index(root, { [moved]: original });
  rmSync(join(root, sourcePath));
  assert.doesNotThrow(() => checkClippyDiagnostics(root, "native", output(root, moved), ["other"]));
  index(root, { [sourcePath]: original, [moved]: original });
  assert.throws(() => checkClippyDiagnostics(root, "native", output(root, moved), ["other"]), /debt grew/);
});

test("a changed item context or a new lint cannot spend another diagnostic allowance", () => {
  const root = fixture();
  index(root, { [sourcePath]: original.replace("Some(1)", "Some(2)") });
  assert.throws(() => checkClippyDiagnostics(root, "native", output(root), ["fixture"]), /debt grew/);
  index(root, { [sourcePath]: original });
  assert.throws(() => checkClippyDiagnostics(root, "native", output(root, sourcePath, 1, "expect_used"), ["fixture"]), /debt grew/);
});

test("a selective run preserves allowances for unselected packages and updater refuses partial inventory", () => {
  const root = fixture();
  const before = readFileSync(join(root, "rust/quality-baseline.json"), "utf8");
  assert.doesNotThrow(() => checkClippyDiagnostics(root, "native", output(root), ["fixture"]));
  assert.throws(() => {
    tightenClippyDiagnostics(root, "native", output(root), ["fixture"]);
  }, /complete stage package inventory/);
  assert.equal(readFileSync(join(root, "rust/quality-baseline.json"), "utf8"), before);
});

test("WASM updater uses the shared native-only package inventory", () => {
  const root = fixture();
  const members = ["fixture", ...RUST_NATIVE_ONLY_PACKAGES].map((name) => `crates/${name}`);
  write(root, "rust/Cargo.toml", `[workspace]\nmembers=${JSON.stringify(members)}\n[workspace.package]\nversion="0.1.0"\n`);
  const inventory = clippyInventory(root, output(root));
  write(root, "rust/quality-baseline.json", JSON.stringify({ clippy: { native: inventory.counts, wasm: inventory.counts } }));
  assert.doesNotThrow(() => {
    tightenClippyDiagnostics(root, "wasm", output(root), ["fixture"]);
  });
  assert.throws(() => {
    tightenClippyDiagnostics(root, "native", output(root), ["fixture"]);
  }, /complete stage package inventory/);
});

test("malformed, incomplete, source-mismatched and identity-mismatched diagnostic data fail closed", () => {
  const root = fixture();
  for (const stdout of [
    "garbage",
    output(root).replace('"success":true', '"success":false'),
    output(root).split("\n").slice(0, -1).join("\n"),
    output(root).replace('"is_primary":true', '"is_primary":false'),
  ]) {
    assert.throws(() => checkClippyDiagnostics(root, "native", stdout, ["fixture"]));
  }
  assert.throws(() => checkClippyDiagnostics(root, "native", output(root).replace("#0.1.0", "#wrong@0.1.0"), ["fixture"]), /identity mismatch/);
  assert.throws(() => checkClippyDiagnostics(root, "native", output(root), ["missing"]), /omitted/);
  write(root, sourcePath, original + "// changed");
  assert.throws(() => checkClippyDiagnostics(root, "native", output(root), ["fixture"]), /source changed/);
});
