import { test } from "bun:test";
import assert from "node:assert/strict";
import { compareAdoptionTargets, validateInventory, type Inventory } from "../scripts/rust-quality-adoption.ts";

const fixture = (): Inventory => ({
  sources: {
    "rust/crates/fixture/tests/a.rs": 2,
    "rust/crates/fixture/tests/support.rs": 1000,
  },
  targets: {
    "fixture/test/a": {
      root: "rust/crates/fixture/tests/a.rs",
      lines: 1002,
      sources: ["rust/crates/fixture/tests/a.rs", "rust/crates/fixture/tests/support.rs"],
    },
  },
});

test("adoption comparison requires the complete immutable target counts", () => {
  const inventory = fixture();
  assert.deepEqual(compareAdoptionTargets(inventory, { "fixture/test/a": 1002 }), { "fixture/test/a": 1002 });
  assert.throws(() => compareAdoptionTargets(inventory, { "fixture/test/a": 1001 }), /exactly the adopted/);
  assert.throws(() => compareAdoptionTargets(inventory, {}), /exactly the adopted/);
  assert.throws(() => compareAdoptionTargets(inventory, { "fixture/test/a": 1002, "fixture/test/missing": 1001 }), /exactly the adopted/);
});

test("adoption inventory refuses incomplete, duplicated or incorrect reachable closures", () => {
  for (const mutate of [
    (inventory: Inventory) => (inventory.targets["fixture/test/a"].sources = ["rust/crates/fixture/tests/support.rs"]),
    (inventory: Inventory) => inventory.targets["fixture/test/a"].sources.push("rust/crates/fixture/tests/support.rs"),
    (inventory: Inventory) => inventory.targets["fixture/test/a"].sources.push("rust/crates/fixture/tests/unowned.rs"),
    (inventory: Inventory) => (inventory.targets["fixture/test/a"].lines = 1003),
  ]) {
    const inventory = fixture();
    mutate(inventory);
    assert.throws(() => {
      validateInventory(inventory);
    });
  }
});

test("adoption inventory refuses unsorted, escaping or invalid source accounting", () => {
  const unsorted = fixture();
  unsorted.sources = Object.fromEntries(Object.entries(unsorted.sources).reverse());
  assert.throws(() => {
    validateInventory(unsorted);
  }, /must be sorted/);
  const escaping = fixture();
  escaping.sources["rust/crates/fixture/../unowned.rs"] = 1;
  assert.throws(() => {
    validateInventory(escaping);
  });
  const invalid = fixture();
  invalid.sources["rust/crates/fixture/tests/a.rs"] = -1;
  assert.throws(() => {
    validateInventory(invalid);
  }, /physical line count/);
});
