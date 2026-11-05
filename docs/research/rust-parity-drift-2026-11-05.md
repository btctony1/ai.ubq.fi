# Rust port parity drift audit - 2026-11-05

Audited TypeScript source: `development` at `d94fef52ccc76e0d5aa019154f11e47d5e10fba6`. Previous Rust source-currency point: `ba5ef05e74e7684589981c9b2a22518137a964f1` (`rust/crates/gateway-providers/SOURCE-CURRENCY.md`). The TypeScript gateway remains production; this audit lists every non-Sentinel `src/` commit in that range and its Rust status so the `rust-migration` branch can close the gap.

Crate-size note: `rust:quality` counts every `.rs` line under `src/` (in-file tests included). Every owning crate below sits at its recorded ceiling, so each port must free lines (move in-src tests to `tests/` targets or extract a new 600-850 line crate) before it adds any.

## Status legend

- Ported: Rust already implements the behavior (evidence cited by the audit).
- In progress: a `rust-migration` work branch exists (see "Work branches").
- Open: not ported; owner and estimate recorded.
- N/A: Bun/`node:http`/systemd specific, dead-export removal, superseded, or TypeScript fixture-only.
- Decision: parity would change credit, transport or security semantics; owner must confirm.

## Claude provider area

| Commit  | Change                                                                                   | Status            | Owner / notes                                                                                              |
| ------- | ---------------------------------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------- |
| 59af8eb | Direct lane omits hosted `web_search` tool                                               | In progress       | gateway-providers `source_anthropic.rs`, `types.rs`                                                        |
| ec4b326 | Native `output_config.format` from `json_schema`                                         | In progress       | gateway-providers; TS at HEAD rejects every other `text.format`, mirrored as-is (Decision: confirm intent) |
| f20e3d6 | Namespaced tools flatten to `<ns>_<tool>`, reverse map, `concise`, custom tool choice    | In progress       | gateway-providers; late developer text already ported                                                      |
| fc42445 | Header-sourced usage meter (`response_headers` sub-state, point `source`, `usage: null`) | In progress       | gateway-claude-runtime, gateway-observability, gateway-admin chain                                         |
| c21214c | `retry_at_ms` kept only for `rate_limited` and future                                    | In progress       | gateway-claude-runtime `quota.rs` (persisted field only; enforcement superseded)                           |
| 9360a1d | `usage_snapshot`, health `usage` fields, `claude_usage_rollups`                          | In progress       | Rust writes currently drop TS-written fields (data-loss risk), fixed on the quota branch                   |
| e3d9fc7 | OAuth usage client                                                                       | N/A / In progress | Client archived upstream; persisted `usage` shape is ported                                                |
| de76f09 | Recurring usage polling lease                                                            | N/A               | Superseded by fc42445; migration selector gets an Exclude rule for `claude_code_usage` rows                |
| 88ebd29 | `POST /admin/providers/claude-code/quota/refresh` (passive at HEAD)                      | In progress       | gateway-admin routes, gateway-admin-runtime, gateway-worker; `static/` shared, no Rust asset change        |
| b9704ef | Lazy bootstrap reads                                                                     | Ported            | Minor reorder of the legacy-workspace read included on the quota branch                                    |
| 0b9ee3d | Lint only                                                                                | N/A               |                                                                                                            |

## Codex, authority and routing area

| Commit                                                                          | Change                                                                               | Status      | Owner / notes                                                                                   |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
| 0231b78                                                                         | Enabled overage is a concurrent serving path, not a probe lease                      | In progress | gateway-authority `routing.rs`, gateway-routing-runtime `attempt.rs`; conformance test replaced |
| b4bfbd8, d108082                                                                | Overage after unsubmitted or shadow reset decisions                                  | In progress | Decline reason carried through `CodexRecovery::Declined`; overage fallback wired                |
| 3878975                                                                         | `Retry-After` capped at 60 s, 429 `codex_quota_blocked`                              | In progress | gateway-routing-runtime errors, gateway-worker inference                                        |
| fab735a                                                                         | `deepseek-forwarded-payload/v2` summary exemption, prompt admission                  | Open        | New crate (about 450-600 lines) plus hooks in gateway-providers `source_chat.rs`                |
| 129d8f4                                                                         | `chat-prompt-admission/v3`; Codex `context_length_exceeded` to `response.failed`     | Open        | Build v3 directly (no pre-summary reduction); SSE mapping in gateway-providers `sse.rs`         |
| 19d9eec                                                                         | Aggregate overflow encoded as `response.created` + `response.failed` on native turns | Open        | Depends on prompt admission crate; waterfall stop rule in gateway-routing-runtime               |
| cfe8458                                                                         | `POST /v1/decisions` decision models                                                 | Open        | New crate (about 550-750 lines) plus catalog, admission and worker hooks                        |
| f552e7a                                                                         | Pre-summary history reduction                                                        | N/A         | Superseded by 129d8f4                                                                           |
| 67dedfe, a9f9b5f                                                                | Automatic banked resets live-only                                                    | Ported      | Rust still parses stored `shadow`/`disabled` modes (optional strict cleanup)                    |
| d99b772                                                                         | Reset identity from current capacity                                                 | Ported      | Minor `>=` vs `>` and probe-lease class differences noted                                       |
| 11199e4                                                                         | Manual banked reset with immediate promotion                                         | Ported      |                                                                                                 |
| 2a48de1, 558a242, 4aacf2b, e81b8bd, 1e64f05, 25c8cf3, 4b48ca5                   | TypeScript-only refactors into shared `native-*` modules                             | N/A         | Rust has its own equivalents                                                                    |
| fda98ea, f75d82e, e14b9da, f424de7, 6c5ed51, dedf928, d9a45e6, 1c0b054, 86e2062 | TypeScript experimental `NativeAuthority`, runtime v3, `src/worker` adapter          | N/A         | Fixture-only; the deployed Worker is the Rust one                                               |

## Runtime, catalog, DeepSeek and auth area

| Commit                             | Change                                            | Status                 | Owner / notes                                                                                                                      |
| ---------------------------------- | ------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 5257a0e                            | Catalog `auto_compact_token_limit` propagation    | In progress            | gateway-schema `catalog_cache.rs`, gateway-catalog-runtime `state.rs`                                                              |
| 077d623                            | Stale-while-revalidate catalog refresh and header | In progress            | gateway-catalog-runtime `versioned.rs`, `host.rs`; worker `wait_until`                                                             |
| 2cb1c45 / 97bcb49                  | Behavior defaults replace env overrides           | Ported, one divergence | Rust `ResetConfig::default()` has `max_per_account_per_day: 0`; TS defaults live, cap 1 (Decision: enables redemption on the port) |
| b179426                            | Passport login returns to `/admin`                | In progress            | gateway-auth `passport.rs`                                                                                                         |
| b538b62                            | Persistent Passport sessions, PKCE, introspection | In progress            | New crate `gateway-passport-session` plus gateway-auth wiring                                                                      |
| e9b1b90                            | Early SSE headers before provider selection       | Decision               | TS limits it to `node:http`; Workers can express it (about 300 lines); needs owner call                                            |
| 7c6ebdb                            | Lithos immediate failover in the waterfall        | Ported                 | Add an explicit synthetic 429/402 test in a new target                                                                             |
| 6c36b82                            | Perl parenthesized credential redaction           | Ported                 |                                                                                                                                    |
| 177eee2                            | Surplus `X-SI-Mask-Secrets`                       | Ported                 |                                                                                                                                    |
| 9e75476, 273626c, 6300fdd, 3bb1962 | `node:http` pause, heartbeat, flush, stop timeout | N/A                    | Transport-specific                                                                                                                 |
| 08191e2, 25ae7e9, 9057030          | Dead export removals                              | N/A                    |                                                                                                                                    |

## Sentinel repair commits with `src/` changes (parity not yet verified)

54cd4cc (metered catalog applies provider wrappers only when enabled), 990ea7c/60a0b1e/2e30700 (OpenRouter Codex rows require an API key), 1227770 and 7fe5848 (authority cleanup map and `commit.prepare()` failure), 959da4a (stream item-id alias keys and terminal dedupe). d1a8b30 is N/A (Rust live mapping retirement is already bounded). 49a469f included its Rust change.

## Baseline repairs on `rust-migration`

`722652d` restored the `rust:quality` ratchet and rustfmt baseline that `development` had broken (gateway-admin grew by three production lines, its contracts target by 26). Workspace Clippy on the pinned 1.98.1 toolchain also failed with 13 `excessive_nesting` errors in gateway-schema, gateway-compaction and gateway-auth; a work branch fixes them without suppressions.

## Work branches

Branches `rust-clippy-nesting`, `rust-claude-native-translator`, `rust-claude-quota-meter`, `rust-catalog-parity`, `rust-passport-parity` and `rust-codex-overage-path` are integrated into `rust-migration` with merge commits. Wave two covers the open prompt-admission, context-failure, decisions and Sentinel-verification items.
