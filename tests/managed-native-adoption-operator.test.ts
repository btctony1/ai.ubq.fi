import assert from "node:assert/strict";
import { test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, renameSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKv } from "@deno/kv";
import {
  assertManagedAdoptionHolders,
  assertManagedAdoptionUnit,
  managedAdoptionKvPort,
  PreparedManagedAdoption,
  runManagedNativeAdoptionOperator,
} from "../tools/cloudflare/managed-native-adoption.ts";
import { NativeOwnerObserver, decodeNativeOwnerObservation, type NativeObserverSeal } from "../tools/cloudflare/managed-native-owner-observer.ts";
import {
  boundedOperatorText,
  bytesSha256,
  decodeManagedAdoptionInput,
  readBoundFile,
  PrivateOutputAnchor,
  revalidateManagedAdoptionInput,
} from "../tools/cloudflare/managed-native-operator-io.ts";
import { CODEX_AUTH_POOL_KV_KEY } from "../src/codex/auth.ts";

const input = () => ({
  v: 1,
  expected: { pool_versionstamp: "00000000000000010000", pool_sha256: "a".repeat(64), native_sha256: "b".repeat(64) },
  outputs: { backup: "backup.json", intent: "intent.json", receipt: "receipt.json" },
});
const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from(text));
      controller.close();
    },
  });
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), "uos-adoption-fixture-"));
  chmodSync(path, 0o700);
  return path;
};

test("private stdin is closed, bounded and cannot choose a key, database, home or stopped boolean", async () => {
  assert.equal(decodeManagedAdoptionInput(JSON.stringify(input())).expected.poolVersionstamp, input().expected.pool_versionstamp);
  for (const raw of [
    { ...input(), stopped: true },
    { ...input(), key: ["other"] },
    { ...input(), home: "/other" },
    { ...input(), outputs: { ...input().outputs, backup: "../auth.json" } },
    { ...input(), outputs: { ...input().outputs, intent: "backup.json" } },
  ])
    assert.throws(() => decodeManagedAdoptionInput(JSON.stringify(raw)), /input_schema|output_reference/);
  for (const raw of ["", "{", " ".repeat(4097)]) assert.throws(() => decodeManagedAdoptionInput(raw), /input_schema/);
  await assert.rejects(boundedOperatorText(stream("a".repeat(4097)), 4096), /bound/);
  await assert.rejects(runManagedNativeAdoptionOperator(undefined, stream(JSON.stringify(input()))), /immutable_launcher_required/);
});

test("actual service and holder facts refuse running, wrong-root and foreign-holder states", () => {
  const fields = { WorkingDirectory: "/fixture/source", User: "fixture", ActiveState: "inactive", MainPID: "0" };
  assertManagedAdoptionUnit(fields, "/fixture/source", "fixture");
  for (const change of [{ ActiveState: "active" }, { MainPID: "1" }, { WorkingDirectory: "/other" }, { User: "other" }])
    assert.throws(() => {
      assertManagedAdoptionUnit({ ...fields, ...change }, "/fixture/source", "fixture");
    }, /source_unit_not_stopped/);
  assertManagedAdoptionHolders(1, "", "", false, process.pid);
  assertManagedAdoptionHolders(0, `${process.pid}\n`, "", true, process.pid);
  for (const [code, text, errors, opened] of [
    [0, "", "", true],
    [0, "12345\n", "", true],
    [0, `${process.pid}\n`, "", false],
    [1, "12345", "", true],
    [2, "", "", false],
    [1, "", "diagnostic", false],
  ] as const)
    assert.throws(() => {
      assertManagedAdoptionHolders(code, text, errors, opened, process.pid);
    }, /holder/);
});

test("observer DTO proves only pinned peer/home metadata and preserves masked custom-provider behavior", () => {
  const seal: NativeObserverSeal = { path: "/fixture/probe", sha256: "a".repeat(64), home: "/fixture/home", uid: 1, pid: 2 };
  const row = { v: 1, codex_home: seal.home, peer_uid: 1, peer_pid: 2, account_kind: "chatgpt", requires_openai_auth: true };
  for (const required of [true, false]) assert.equal(decodeNativeOwnerObservation({ ...row, requires_openai_auth: required }, seal).account_kind, "chatgpt");
  assert.equal(decodeNativeOwnerObservation({ ...row, account_kind: "masked", requires_openai_auth: false }, seal).account_kind, "masked");
  for (const change of [
    { peer_pid: 3 },
    { peer_uid: 2 },
    { codex_home: "/other" },
    { token: "synthetic-sensitive" },
    { account_kind: "apiKey" },
    { account_kind: "masked", requires_openai_auth: true },
    { requires_openai_auth: null },
  ])
    assert.throws(() => decodeNativeOwnerObservation({ ...row, ...change }, seal), /observer/);
});

test("synthetic owned helper process receives only closed stdin and is hash-fenced; failures redact raw output", async () => {
  const directory = temporary();
  try {
    const path = join(directory, "synthetic-probe");
    const source = `#!${process.execPath}\nconst x=await new Response(Bun.stdin.stream()).json();if(Object.keys(x).sort().join(',')!=='codex_home,expected_uid,v')process.exit(9);console.log(JSON.stringify({v:1,codex_home:x.codex_home,peer_uid:x.expected_uid,peer_pid:77,account_kind:'masked',requires_openai_auth:false}));`;
    writeFileSync(path, source, { mode: 0o500 });
    const seal: NativeObserverSeal = {
      path,
      sha256: bytesSha256(Buffer.from(source)),
      home: directory,
      uid: process.getuid?.() ?? -1,
      pid: 77,
      timeoutMs: 3000,
    };
    const observer = NativeOwnerObserver.fromLauncher(seal);
    const receipt = await observer.observe();
    assert.equal(receipt.account_kind, "masked");
    assert.ok(!JSON.stringify(receipt).includes("tokens"));
    chmodSync(path, 0o700);
    writeFileSync(path, source + "\n");
    chmodSync(path, 0o500);
    await assert.rejects(observer.observe(), /observer_binary/);
    const bad = join(directory, "synthetic-bad");
    const badSource = `#!${process.execPath}\nconsole.error('synthetic-sensitive-refresh');console.log('synthetic-sensitive-token');`;
    writeFileSync(bad, badSource, { mode: 0o500 });
    const failed = NativeOwnerObserver.fromLauncher({ ...seal, path: bad, sha256: bytesSha256(Buffer.from(badSource)) });
    try {
      await failed.observe();
      assert.fail("observer must reject");
    } catch (error) {
      assert.match(String(error), /observer_failed/);
      assert.ok(!String(error).includes("synthetic-sensitive"));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("private backup is exclusive and private; file races are visible to its caller", () => {
  const directory = temporary();
  const task = join(directory, ".data", "task");
  mkdirSync(task, { recursive: true, mode: 0o700 });
  const anchor = PrivateOutputAnchor.open(directory, task);
  try {
    const path = join(task, "backup.json");
    anchor.write("backup.json", { synthetic_private_value: "fixture-only" });
    const before = readBoundFile(path, 1024, true);
    assert.throws(() => {
      anchor.write("backup.json", {});
    }, /EEXIST/);
    writeFileSync(path, '{"changed":true}\n');
    const after = readBoundFile(path, 1024, true);
    assert.notEqual(before.identity, after.identity);
    chmodSync(path, 0o644);
    assert.throws(() => readBoundFile(path, 1024, true), /file_owner_or_bound/);
    assert.ok(readFileSync(path).length > 0);
  } finally {
    anchor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("output capability pins its directory inode/mode and never follows a substituted path or file symlink", () => {
  const root = temporary();
  const data = join(root, ".data");
  const task = join(data, "task");
  mkdirSync(task, { recursive: true, mode: 0o700 });
  const anchor = PrivateOutputAnchor.open(root, task);
  try {
    for (const name of ["releases", "runtimes"]) {
      const path = join(data, name, "task");
      mkdirSync(path, { recursive: true, mode: 0o700 });
      assert.throws(() => PrivateOutputAnchor.open(root, path), /output_scope/);
    }
    assert.throws(() => PrivateOutputAnchor.open(root, data), /output_scope/);
    assert.throws(() => PrivateOutputAnchor.open(root, root), /output_scope/);
    const kv = join(data, "kv-bun.sqlite3");
    writeFileSync(kv, "fixture", { mode: 0o600 });
    assert.throws(() => PrivateOutputAnchor.open(root, kv), /directory_owner/);
    const target = join(root, "not-created.json");
    symlinkSync(target, join(task, "symlink.json"));
    assert.equal(anchor.exists("symlink.json"), true);
    assert.throws(() => {
      anchor.write("symlink.json", {});
    }, /EEXIST|ELOOP/);
    assert.equal(existsSync(target), false);
    assert.throws(() => {
      anchor.write("../escape.json", {});
    }, /output_reference/);
    chmodSync(task, 0o755);
    assert.throws(() => {
      anchor.assert();
    }, /output_directory_private/);
    chmodSync(task, 0o700);
    const moved = join(data, "original");
    renameSync(task, moved);
    mkdirSync(task, { mode: 0o700 });
    assert.throws(() => {
      anchor.write("misdirected.json", {});
    }, /output_anchor_changed/);
    assert.equal(existsSync(join(task, "misdirected.json")), false);
    assert.equal(existsSync(join(moved, "misdirected.json")), false);
  } finally {
    anchor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct execute revalidates input before touching a binding or lease", async () => {
  const valid = decodeManagedAdoptionInput(JSON.stringify(input()));
  assert.deepEqual(revalidateManagedAdoptionInput(valid), valid);
  for (const invalid of [
    { ...valid, stopped: true },
    { ...valid, outputs: { ...valid.outputs, backup: "../escape.json" } },
    { ...valid, expected: { ...valid.expected, arbitraryKey: true } },
  ]) {
    assert.throws(() => revalidateManagedAdoptionInput(invalid), /input_schema|output_reference/);
    // Deliberately forged capability: invalid data must fail before private-field access.
    const forged = {} as unknown as PreparedManagedAdoption;
    await assert.rejects(PreparedManagedAdoption.prototype.execute.call(forged, invalid), /input_schema|output_reference/);
  }
});

test("fixed-key KV adapter cannot mutate unrelated rows and reports stale CAS conflicts", async () => {
  const kv = await openKv(undefined, { implementation: "in-memory" });
  try {
    await kv.set(CODEX_AUTH_POOL_KV_KEY, { source: true });
    await kv.set(["unrelated"], { paid_limit: 3 });
    const port = managedAdoptionKvPort(kv, {
      assertOwned: () => Promise.resolve(),
      native: () => Promise.resolve({ raw: {}, sha256: "a".repeat(64) }),
      proveNative: () => Promise.resolve(),
      backup: () => Promise.resolve(),
      intent: () => Promise.resolve(),
    });
    const row = await port.read();
    assert.equal(await port.commit(row.versionstamp, { accounts: [], updated_at_ms: 1 }), true);
    assert.equal(await port.commit(row.versionstamp, { accounts: [], updated_at_ms: 2 }), false);
    assert.deepEqual((await kv.get(["unrelated"])).value, { paid_limit: 3 });
  } finally {
    kv.close();
  }
});

test("untrusted launcher facts and direct CLI cannot create an operator binding or echo private stdin", async () => {
  assert.throws(
    () =>
      PreparedManagedAdoption.fromLauncher({
        root: "/absent",
        home: "/absent",
        accountSha256: "a".repeat(64),
        sourceSha: "a".repeat(40),
        sourceManifestSha256: "a".repeat(64),
        outputDirectory: "/absent",
        observer: { path: "/absent", sha256: "a".repeat(64), home: "/absent", uid: 0, pid: 1 },
      }),
    /binding_invalid/
  );
  const child = Bun.spawn([process.execPath, "--no-env-file", "--no-install", "tools/cloudflare/managed-native-adoption.ts"], {
    env: {},
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  await child.stdin.write("synthetic-sensitive-stdin");
  await child.stdin.end();
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  assert.equal(code, 78);
  assert.equal(output, "");
  assert.match(errors, /immutable private launcher/);
  assert.ok(!errors.includes("synthetic-sensitive"));
});
