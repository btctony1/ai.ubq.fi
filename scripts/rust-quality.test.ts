import { test } from "bun:test";
import assert from "node:assert/strict";
import { rustQualityArguments } from "./rust-quality.ts";

test("Rust quality always delegates to the locked offline parser", () => {
  const expected = ["run", "--locked", "--offline", "--manifest-path", "/task/rust/Cargo.toml", "-p", "gateway-quality", "--", "--check", "/task"];
  assert.deepEqual(rustQualityArguments([], "/task"), expected);
  assert.deepEqual(rustQualityArguments(["--check"], "/task"), expected);
  assert.equal(rustQualityArguments(["--update"], "/task").at(-2), "--update");
  assert.equal(rustQualityArguments(["--init"], "/task").at(-2), "--init");
  for (const args of [["--unknown"], ["--check", "--update"]]) assert.throws(() => rustQualityArguments(args, "/task"));
});
