# Rust quality and compile-performance policy - 2026-10-23

This document records the owner-requested Rust lint, code-quality, and compile-performance program for the Rust port. It is subordinate to the four non-negotiable rules in `AGENTS.md`. The recommendations came from one explicitly authorized GPT Pro submission (`gpt-6-pro`, job `66ca9a42-20cf-4ff8-acd2-e01653d97ea3`) and are applied incrementally.

## Structural gate

- `scripts/rust-quality.ts` launches the locked, offline `gateway-quality` Rust gate. `gateway-quality-syntax` uses pinned `syn` with `full` and `visit`; Rust and TOML parse errors fail closed. The baseline covers first-party production source, separate Cargo targets, visible re-exports, `#[path]`, `include!`, and source suppressions.
- A crate budget is the total physical lines in `rust/crates/<crate>/src/**/*.rs`, including inline tests, comments, and inactive configurations. The cap is 1000.
- A new or renamed crate never inherits an oversized allowance. A reduction lowers the baseline; the entry is removed at or below 1000.
- Re-exports are checked as visible `use` declarations, not just `pub use`: `pub(crate)`, `pub(super)`, `pub(in ...)`, and visible `extern crate` also count.
- `#[path]` checks include direct attributes and `path = ...` inside `cfg_attr`. `include!` checks do not treat `include_str!` or `include_bytes!` as source inclusion.
- A missing `[lints] workspace = true` in a first-party manifest is a policy failure.
- All authored first-party `.rs` files are parsed, including inactive configurations and inline modules. Macro token trees inspect explicit declarations, qualified/raw `include!`, and builtin/explicit-alias operands forwarded through macro parameters. Supported `#[$meta]` and `#[$meta:meta]` attribute forwarding is recognized; actual supplied forbidden attributes are still inspected. Strings, comments, `include_str!`, and `include_bytes!` remain permitted. Arbitrary procedural-macro expansion is not a static source guarantee.

## Lint policy

- Do not enable entire `pedantic`, `restriction`, `nursery`, or `cargo` groups. Select lints individually and keep the set small.
- No `#[allow]` or `#[expect]` suppression is accepted. Existing suppressions are recorded debt and must be removed by fixing the design or the test.
- Keep `clippy::all` and add `clippy::correctness` as fatal. Add only lints that pass the current workspace without source changes. Lints that need a cleanup pass stay staged.
- Staging uses explicit `--force-warn` flags plus a diagnostic baseline. Do not weaken the ordinary `-D warnings` gate, use `--cap-lints`, or mark a job `continue-on-error`.
- `rust/clippy.toml` owns the thresholds: 120 function lines, 7 arguments, type complexity 250, nesting 5, wildcard-import warnings, and unwrap/expect linting in tests.
- Do not copy the TypeScript cognitive-complexity setting of 15 into Clippy. Clippy's cognitive-complexity lint is not equivalent; use function length, nesting, and review of branching instead.
- Rust gates stage `pub_use`, `too_many_lines`, `excessive_nesting`, `wildcard_imports`, `unwrap_used`, and `expect_used` with explicit `--force-warn` arguments and JSON diagnostic baselines. `allow_attributes` is fatal; ordinary `clippy::all`, the 7-argument threshold, and `-D warnings` remain enforced. The lossy-cast family remains unselected.

## Enforcement matrix

| Policy                                                                                                            | Mechanism                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1000 physical production lines and 1000 lines per separate target                                                 | Rust source inventory plus tightening-only `crates`/`targets` baseline maps                                   |
| Visible `use`/`extern crate`, `path` including nested `cfg_attr`, plain source inclusion, source `allow`/`expect` | Full Rust AST and conservative authored macro-token inspection; per-file structural no-growth counts          |
| Every first-party package inherits workspace lints                                                                | Parsed TOML requires `[lints] workspace = true` and explicit workspace membership                             |
| No new ordinary Clippy warnings or source `allow` attributes                                                      | Fatal `-D warnings` and workspace `allow_attributes = "deny"`                                                 |
| 120 function lines, nesting 5, public forwarding, wildcard imports, unwrap/expect                                 | Individually selected real Clippy lints, forced warnings, source-context fingerprints and occurrence ceilings |
| 7 function arguments                                                                                              | Existing real `too_many_arguments` lint under strict warnings, with the configured threshold 7                |
| Release/compile-performance recommendations                                                                       | Measured separately; production release profile unchanged                                                     |

Every selected native or WASM verification plan first runs parser fixtures and the parser on the native host, even when only another crate changed. Both quality tooling crates are excluded from the WASM package graph. CI runs this inside prepared Rust jobs; the scope job does not compile Rust, and ordinary documentation-only changes remain formatting-only.

Clippy diagnostic ingestion requires a successful complete Cargo JSON stream and all selected first-party package artifacts. The parser writes `CARGO_TARGET_DIR/quality-contexts.json`; ingestion verifies its root and every source file before choosing the enclosing parsed item. Fingerprints use lint identity plus SHA-256 of canonical item tokens (including relevant configuration and impl context), with separate whole-source occurrence ceilings. Whitespace/comments and unchanged relocation preserve identity; changed items, new warnings, and copied offending functions cannot spend an unrelated allowance. Repeated library/test diagnostics are deduplicated. Selective runs retain unselected allowances. The Clippy updater accepts only a complete stage package inventory and only drops or lowers recorded counts; the structural updater preserves this diagnostic baseline.

The initial native and WASM diagnostic inventories come from the pristine adoption commit above, with pinned Rust 1.98.1 and exact locked dependencies. `rust/quality-baseline.json` records adoption source and receipt provenance. Structural updates use `bun --no-env-file scripts/rust-quality.ts --update`. Diagnostic updates use `bun --no-env-file scripts/rust-quality-clippy.ts --update native|wasm DIAGNOSTICS_JSONL SELECTED_PACKAGE...` with the matching current parser context directory and complete stage inventory.

Native diagnostic adoption was observed on `aarch64-apple-darwin`; the separate WASM capture targets `wasm32-unknown-unknown`. This record does not assert a Linux native capture. Unobserved platform diagnostics remain unbaselined and fail closed. Capture-tool source SHA/tree, binary hash, and successful capture receipt are separate from the immutable adoption source SHA/tree; a metadata-only follow-up commit binds the final gate to its exact capture tool without a self-reference.

Pinned Clippy 1.98.1 `disallowed_macros` was tested with actual aliased builtin `include!` and a `println!` positive control: it rejects the latter but permits the builtin alias. The gate therefore does not claim that compiler lint as inclusion enforcement; authored aliases and forwarded include operands are checked by the parser, and unrestricted generated expansion remains outside static proof.

## Compile performance

- The 1000-line crate cap is an architectural review constraint, not proof of a compile-speed improvement. Track structural compliance and build performance separately.
- Keep the production `[profile.release]` unchanged until the complete Worker build is measured. The measured candidate is a separate `release-candidate` profile: inherits release, `lto = "thin"`, `codegen-units = 16`.
- Development and test profiles use `opt-level = 0`, `debug = "line-tables-only"`, and `incremental = true`. The verification launcher may still force debug off for reproducible CI.
- Do not set development codegen units globally; rustc already chooses a parallel default. Lower debug information at generation time rather than stripping afterward.
- Remove the duplicate `cargo check` immediately before `cargo clippy`; Clippy performs the type check. Keep a single developer `cargo check` for fast feedback.
- Measure fresh-target, no-change, private-body edit, public-signature edit, fixture-only edit, and complete Worker-build cases separately. Record median, spread, peak memory, rebuilt units, and artifact bytes over at least five paired warm trials.
- Proposed acceptance: 20 percent lower median edit-to-check or edit-to-test; investigate a repeatable regression over 10 percent and one second. Adopt a release candidate only after a material full-pipeline improvement with unchanged parity and no more than 5 percent deployment-size, startup, or request-CPU regression.
- Keep native/OS dependencies out of the WASM graph. Check the shipped Worker feature set, not only `--all-features`. Use `cargo tree` for duplicates and a pinned `cargo-machete` report before removing dependencies.
- Test targets are separate crates. Keep each integration-test target at or below 1000 lines, consolidate related tests only while the target stays under the cap, and use a real bounded dev-only helper crate for shared support instead of `#[path]` or `include!`.

## Crate extraction

- Extract one coherent responsibility with a narrow interface, no dependency back-edge, independent tests, and change independence from consumers.
- Prefer 600-850 lines for a newly extracted crate so maintenance has headroom. Do not create one ubiquitous `gateway-common` crate or a chain of forwarding/re-export modules.
- Move genuine public-behavior tests to a bounded integration target; keep private invariant tests near the implementation. Do not widen visibility solely to relocate a test.
- Preserve parity evidence for status/error mapping, headers, serialized output, streaming framing and termination, cancellation, retry behavior, and observability fields. A stable test count alone is insufficient.

## Migration order

1. Establish accurate source, dependency, test, and timing baselines.
2. Block new structural violations while grandfathering existing ones individually.
3. Remove source inclusion and path indirection, then re-exports.
4. Relocate genuine test data and public-behavior tests.
5. Extract small coherent crates and keep the adapters thin.
6. Tune release compilation only after measuring the complete Worker build.

## Caveats

- Production budgets sum physical `src/**/*.rs` lines. Separate test, example, benchmark, binary, and build-script targets follow authored conventional modules and literal path alternatives, count shared files once per target, and include inactive alternatives. Targets cannot escape authored first-party source; missing, ambiguous, linked, or cyclic graphs fail closed. Existing oversized target ceilings were generated from pristine adoption commit `7223352101f448dd2ad46e40e285e689a2788435` (tree `04a107dae9f43cd12c7f2dbbd1ba30f171b80c5a`); new or growing target debt cannot be recorded.
- Re-exports are normal Rust API practice. Under the owner rule, the defining module path is the supported API; do not add aliases, facades, or compatibility re-exports to evade the check.
- A 1000-line crate cap can add interfaces and compilation boundaries. The compliant resolution is small capability crates with narrow interfaces, not hiding code in macros or generated strings.

## Provenance

GPT Pro job `66ca9a42-20cf-4ff8-acd2-e01653d97ea3`, submitted 2026-10-23T13:32Z, completed 2026-10-23T13:48Z. The owner explicitly authorized one submission with the invocation `$gpt-pro`. The full answer is retained for the current session at `/tmp/ai-rust-gpt-pro-answer-20261023.md`; this document is the durable policy summary. No provider or deployment credentials were included in the prompt.
