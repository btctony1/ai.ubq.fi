import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimRustTarget, guardRustTarget, isRustCompilerCommand } from "./rust-target-owner.ts";
import { runCommand } from "./rust-verify.ts";

const fixture = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "uos-rust-owner-")));
  const source = join(directory, "source");
  const foreign = join(directory, "foreign");
  const target = join(directory, "target");
  for (const path of [source, foreign, target]) mkdirSync(path);
  return {
    directory,
    source,
    foreign,
    target,
    remove: () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
};
const marker = (target: string) => join(target, ".uos-worktree-owner.json");
const metadata = (source: string, target: string) => ({ code: 0, stdout: JSON.stringify({ workspace_root: source, target_directory: target }), stderr: "" });
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const fakeCargo = (directory: string, source: string, target: string) => {
  const executable = join(directory, "cargo");
  const sentinel = join(directory, "compiler-started");
  writeFileSync(
    executable,
    `#!/bin/sh\nif [ "$1" = metadata ]; then\n  printf '%s\\n' ${quote(metadata(source, target).stdout)}\n  exit 0\nfi\n/usr/bin/touch ${quote(sentinel)}\n`,
    { mode: 0o700 }
  );
  return { executable, sentinel };
};

test("one physical source root keeps its compiler target across edits", () => {
  const f = fixture();
  try {
    claimRustTarget(f.source, f.target);
    writeFileSync(join(f.target, "artifact.rmeta"), "source-owned artifact");
    claimRustTarget(f.source, f.target);
    assert.throws(() => {
      claimRustTarget(f.foreign, f.target);
    }, /another source root/);
  } finally {
    f.remove();
  }
});

test("unowned artifacts and malformed or linked markers fail without adoption", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.target, "foreign.rmeta"), "unowned");
    assert.throws(() => {
      claimRustTarget(f.source, f.target);
    }, /Unowned nonempty/);
    assert.equal(existsSync(marker(f.target)), false);
    rmSync(join(f.target, "foreign.rmeta"));
    writeFileSync(marker(f.target), "malformed");
    assert.throws(() => {
      claimRustTarget(f.source, f.target);
    }, /invalid owner marker/);
    assert.equal(readFileSync(marker(f.target), "utf8"), "malformed");
    rmSync(marker(f.target));
    const elsewhere = join(f.directory, "external-owner.json");
    writeFileSync(elsewhere, "{}");
    symlinkSync(elsewhere, marker(f.target));
    assert.throws(() => {
      claimRustTarget(f.source, f.target);
    }, /invalid owner marker/);
  } finally {
    f.remove();
  }
});

test("workspace metadata unifies subcrate and archive manifests without Git", async () => {
  const f = fixture();
  try {
    const manifests = [join(f.source, "Cargo.toml"), join(f.source, "subcrate/Cargo.toml")];
    for (const manifest of manifests) {
      await guardRustTarget({ argv: ["cargo", "check", `--manifest-path=${manifest}`], cwd: f.foreign }, {}, (command) => {
        assert.ok(command.argv.includes(manifest));
        assert.equal(command.cwd, f.foreign);
        return Promise.resolve(metadata(f.source, f.target));
      });
    }
    assert.equal(existsSync(join(f.source, ".git")), false);
    assert.equal(JSON.parse(readFileSync(marker(f.target), "utf8")).sourceRoot, f.source);
  } finally {
    f.remove();
  }
});

test("an explicit foreign manifest is refused before the compiler can spawn", async () => {
  const f = fixture();
  try {
    claimRustTarget(f.source, f.target);
    const cargo = fakeCargo(f.directory, f.foreign, f.target);
    await assert.rejects(
      runCommand({ argv: [cargo.executable, "check", "--manifest-path", join(f.foreign, "Cargo.toml")], cwd: f.source }, { PATH: "/usr/bin:/bin" }),
      /another source root/
    );
    assert.equal(existsSync(cargo.sentinel), false);
  } finally {
    f.remove();
  }
});

test("both target-dir forms guard the actual override before compiler spawn", async () => {
  const f = fixture();
  try {
    claimRustTarget(f.source, f.target);
    const foreignTarget = join(f.directory, "foreign-target");
    claimRustTarget(f.foreign, foreignTarget);
    const cargo = fakeCargo(f.directory, f.source, f.target);
    for (const flags of [["--target-dir", foreignTarget], [`--target-dir=${foreignTarget}`]]) {
      await assert.rejects(
        runCommand({ argv: [cargo.executable, "check", ...flags], cwd: f.source }, { PATH: "/usr/bin:/bin", CARGO_TARGET_DIR: f.target }),
        /another source root/
      );
      assert.equal(existsSync(cargo.sentinel), false);
    }
  } finally {
    f.remove();
  }
});

test("distinct source processes racing for one target produce one owner", async () => {
  const f = fixture();
  try {
    const module = new URL("./rust-target-owner.ts", import.meta.url).href;
    const script = `import {claimRustTarget} from ${JSON.stringify(module)}; claimRustTarget(process.argv[1],process.argv[2]);`;
    const children = [f.source, f.foreign].map((source) =>
      Bun.spawn([process.execPath, "--no-env-file", "--no-install", "-e", script, source, f.target], { stdout: "ignore", stderr: "ignore" })
    );
    const exits = await Promise.all(children.map((child) => child.exited));
    assert.deepEqual(
      [...exits].toSorted((left, right) => left - right),
      [0, 1]
    );
    assert.equal(JSON.parse(readFileSync(marker(f.target), "utf8")).sourceRoot, exits[0] === 0 ? f.source : f.foreign);
  } finally {
    f.remove();
  }
});

test("configuration values cannot turn read-only metadata into recursive compilation", async () => {
  assert.equal(isRustCompilerCommand(["cargo", "metadata", "--config", "test"]), false);
  assert.equal(isRustCompilerCommand(["cargo", "--config", "check", "metadata"]), false);
  assert.equal(isRustCompilerCommand(["cargo", "--config", "metadata", "check"]), true);
  const f = fixture();
  try {
    const cargo = fakeCargo(f.directory, f.source, f.target);
    const result = await runCommand({ argv: [cargo.executable, "check", "--config", "test"], cwd: f.source }, { PATH: "/usr/bin:/bin" });
    assert.equal(result.code, 0);
    assert.equal(existsSync(cargo.sentinel), true);
  } finally {
    f.remove();
  }
});

test("only compiler operations claim ownership; program arguments cannot select a manifest", async () => {
  for (const argv of [
    ["cargo", "fmt"],
    ["cargo", "metadata"],
    ["cargo", "--version"],
    ["rustc", "-vV"],
    ["worker-build", "--version"],
    ["cargo", "install", "worker-build", "--version", "=0.8.7"],
  ])
    assert.equal(isRustCompilerCommand(argv), false);
  const f = fixture();
  try {
    await guardRustTarget({ argv: ["cargo", "run", "--", "--manifest-path", "/foreign/Cargo.toml"], cwd: f.source }, {}, (command) => {
      assert.equal(command.argv.includes("/foreign/Cargo.toml"), false);
      return Promise.resolve(metadata(f.source, f.target));
    });
  } finally {
    f.remove();
  }
});
