import { createFetchMock } from "./helpers/fetch-mock.ts";
import { waitForCatalogLeaseRelease } from "./helpers/codex-catalog-refresh.ts";
import { setKvForTest } from "../src/kv.ts";
import { test } from "bun:test";
import { type Kv, type KvEntryMaybe, type KvKey, type KvListSelector } from "#kv";
import assert from "node:assert/strict";

for (const name of [
  "CEREBRAS_API_KEY",
  "DEEPSEEK_API_KEY",
  "LITHOSAI_API_KEY",
  "METERED_API_KEY",
  "OPENROUTER_API_KEY",
  "SURPLUS_API_KEY",
  "OPENLUX_API_KEY",
  "CLAUDE_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
]) {
  Reflect.deleteProperty(process.env, name);
}

const keyToString = (key: KvKey): string => JSON.stringify(key);
const kvStore = new Map<string, { value: unknown; versionstamp: string }>();
let versionCounter = 0;
type AtomicTestOp = { kind: "set" | "delete"; key: KvKey; value?: unknown };
const nextVersion = (): string => String(++versionCounter).padStart(20, "0");
const entryFor = (key: KvKey): KvEntryMaybe<unknown> => {
  const stored = kvStore.get(keyToString(key));
  return stored ? { key, value: stored.value, versionstamp: stored.versionstamp } : { key, value: null, versionstamp: null };
};
const matchesPrefix = (key: KvKey, prefix: KvKey): boolean => prefix.every((part, index) => key[index] === part);
const kvStub = {
  get: (key: KvKey) => Promise.resolve(entryFor(key)),
  set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
    kvStore.set(keyToString(key), { value, versionstamp: nextVersion() });
    return Promise.resolve({ ok: true } as const);
  },
  delete: (key: KvKey) => {
    kvStore.delete(keyToString(key));
    return Promise.resolve();
  },
  list: async function* (selector: KvListSelector) {
    const prefix = "prefix" in selector ? selector.prefix : [];
    await Promise.resolve();
    for (const [encodedKey, stored] of kvStore) {
      const key = JSON.parse(encodedKey) as KvKey;
      if (matchesPrefix(key, prefix)) yield { key, value: stored.value, versionstamp: stored.versionstamp };
    }
  },
  atomic: () => {
    const checks: KvEntryMaybe<unknown>[] = [];
    const ops: AtomicTestOp[] = [];
    const chain = {
      check: (entry: KvEntryMaybe<unknown>) => {
        checks.push(entry);
        return chain;
      },
      set: (key: KvKey, value: unknown, _options?: { expireIn?: number }) => {
        ops.push({ kind: "set", key, value });
        return chain;
      },
      delete: (key: KvKey) => {
        ops.push({ kind: "delete", key });
        return chain;
      },
      commit: () => {
        if (!checks.every((expected) => entryFor(expected.key).versionstamp === expected.versionstamp)) return Promise.resolve({ ok: false } as const);
        for (const op of ops) {
          if (op.kind === "delete") kvStore.delete(keyToString(op.key));
          else kvStore.set(keyToString(op.key), { value: op.value, versionstamp: nextVersion() });
        }
        return Promise.resolve({ ok: true } as const);
      },
    };
    return chain;
  },
  close: () => {},
} as unknown as Kv;

setKvForTest(kvStub);

const { CODEX_CATALOG_AUTH_GENERATION_KEY, CODEX_CATALOG_FRESH_MS, CODEX_CATALOG_LEASE_PREFIX } = await import("../src/catalog/types.ts");
const { resetCodexCatalogMemoForTest, storeCodexCatalog } = await import("../src/catalog/store.ts");
const { handleCodexCatalogModels } = await import("../src/catalog/index.ts");
const { resetCodexAuthCacheForTest } = await import("../src/codex/index.ts");
const { resetRuntimeConfigCacheForTest, RUNTIME_CONFIG_V2_KEY } = await import("../src/runtime-config.ts");
const { setOpenRouterModelsFetchForTest, resetOpenRouterModelsCacheForTest } = await import("../src/models/openrouter-models.ts");

setOpenRouterModelsFetchForTest(() => Promise.resolve(Response.json({ data: [] })));

const AUTH_GENERATION = "stale-while-revalidate-auth";
const AUTH_KEY = ["ubq_ai", "codex_auth"] as const;
const SNAPSHOT_KEY = ["ubq_ai", "codex_models"] as const;
const catalogBody = (version: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ models: [{ slug: `gpt-${version}`, display_name: `Rich ${version}` }], ...extra });
const request = (version: string): Request =>
  new Request(`https://ai.ubq.fi/v1/models?client_version=${version}`, { headers: { Authorization: "Bearer gateway-client-token" } });

const seed = (): void => {
  kvStore.clear();
  versionCounter = 0;
  resetCodexAuthCacheForTest();
  resetCodexCatalogMemoForTest();
  resetRuntimeConfigCacheForTest();
  resetOpenRouterModelsCacheForTest();
  kvStore.set(keyToString(CODEX_CATALOG_AUTH_GENERATION_KEY), { value: AUTH_GENERATION, versionstamp: nextVersion() });
  kvStore.set(keyToString(AUTH_KEY), {
    value: {
      accounts: [{ access_token: "server-access", refresh_token: "server-refresh", account_id: "server-account", updated_at_ms: Date.now() }],
      updated_at_ms: Date.now(),
    },
    versionstamp: nextVersion(),
  });
  const snapshot = { source: "chatgpt_codex", client_version: "0.170.0", updated_at_ms: Date.now(), models: [{ slug: "snapshot-0.170.0" }] };
  kvStore.set(keyToString(SNAPSHOT_KEY), { value: snapshot, versionstamp: nextVersion() });
  kvStore.set(keyToString(RUNTIME_CONFIG_V2_KEY), {
    value: { version: 2, default_model: "snapshot-0.170.0", default_reasoning_effort: "medium", codex_models: snapshot, updated_at_ms: Date.now() },
    versionstamp: nextVersion(),
  });
};

test("codex catalog: stale cache returns before its background refresh settles", async () => {
  seed();
  const version = "0.170.0";
  await storeCodexCatalog(kvStub, {
    clientVersion: version,
    authGeneration: AUTH_GENERATION,
    body: catalogBody(version),
    fetchedAtMs: Date.now() - CODEX_CATALOG_FRESH_MS - 1,
  });
  const originalFetch = globalThis.fetch;
  let resolveFetch!: (response: Response) => void;
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => (markFetchStarted = resolve));
  const deferredResponse = new Promise<Response>((resolve) => (resolveFetch = resolve));
  globalThis.fetch = createFetchMock(() => {
    markFetchStarted();
    return deferredResponse;
  });
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    resolveFetch(new Response(catalogBody(version, { refreshed: true }), { headers: { "Content-Type": "application/json" } }));
  };
  try {
    const pending = handleCodexCatalogModels(request(version), version);
    await fetchStarted;
    const staleResponse = await Promise.race([
      pending,
      new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, 20);
      }),
    ]);
    assert.ok(staleResponse, "the stale response must return while the upstream refresh is still pending");
    assert.equal(staleResponse.headers.get("x-uos-cache"), "stale");
    assert.equal(((await staleResponse.json()) as { models: { slug: string }[] }).models[0].slug, `gpt-${version}`);

    release();
    await pending;
    await waitForCatalogLeaseRelease(kvStore, keyToString([...CODEX_CATALOG_LEASE_PREFIX, version]));

    const refreshed = await handleCodexCatalogModels(request(version), version);
    assert.equal(refreshed.headers.get("x-uos-cache"), "hit");
    const body = (await refreshed.json()) as { models: { slug: string }[]; refreshed?: boolean };
    assert.equal(body.refreshed, true);
    assert.equal(body.models[0].slug, `gpt-${version}`);
  } finally {
    release();
    globalThis.fetch = originalFetch;
  }
});
