# Immutable Rust quality adoption reproduction

This is a fresh structural reproduction of immutable source `7223352101f448dd2ad46e40e285e689a2788435`, compared with the 14 target allowances retained at `87bef7d99b4945f1950577316bcbabc766714269:rust/quality-baseline.json`. It does not recover the vanished original generator or Clippy captures, replace historical receipt identities, change a baseline, or authorize new debt.

The existing `gateway-quality` module traversal now retains each target's visited sources as well as its physical line total. Its tooling-only `--inventory REPOSITORY_ROOT` mode emits source counts and target roots, counts and reachable file closures in deterministic UTF-8 lexical order. Paths are sorted after conversion to normalized repository-relative strings, so same-stem files and directories have the same order in Rust and Bun without a locale-dependent comparison. This mode neither reconciles a baseline nor writes diagnostic contexts. Existing check, update, init and report behavior is retained, including report-mode context output.

## Reproduction

Use the already prepared Bun 1.4.0 and Rust 1.98.1 artifacts, offline Cargo dependencies, a writable task directory, a lane-private target directory and the existing host compiler lock. Both immutable Git objects must already be available locally; the exporter never fetches. Shared first-party Cargo artifacts can retain diagnostics from another lane and must not be reused. No install, automatic dotenv discovery, provider call or application runtime is involved. On the resumed Mac, after the coordinator prepares the private target, the exact invocation is:

```sh
. /tmp/rust-quality-resume-20261024/compiler-env.sh
export PATH=/Users/nv/repos/ubiquity/ai.ubq.fi/.data/runtimes/bun/darwin-arm64/1.4.0-539598c775882420b9d8deb7dc14d845f20f7d26f5600c50ab067dde6ac3f3bf:$PATH
export CARGO_TARGET_DIR=/tmp/rust-quality-resume-20261024/prepared/lane-targets/m23-a33b18d6b30
python3 /tmp/rust-quality-resume-20261024/compiler-lock.py \
  bun --no-env-file --no-install scripts/rust-quality-adoption.ts \
  /tmp/rust-quality-resume-20261024/m23-adoption-proof-r4
```

The output directory must not already exist. The exporter archives only `rust/` from the exact immutable commit, verifies its tree and stored lock/config hashes, builds the current source-bound scanner with locked offline Cargo and two jobs, runs its inventory mode against that archive, checks every reachable file sum, and requires exact equality with all 14 adopted oversized target counts. It preserves the current baseline bytes. The current baseline may subsequently tighten; the comparison always reads the immutable reference commit.

`commands.json` and numbered stdout/stderr files retain actual argv and statuses. `source-inventory.json` retains sorted immutable source paths, physical lines and SHA-256 values. `target-closures.json` retains every discovered target and its full sorted file closure; `adopted-targets.json` selects the 14 adopted targets. `scanner-sources.json` binds the scanner, syntax parser, exporter, manifests, lock and available Cargo/toolchain configuration to exact file hashes. `provenance.json` binds these manifests, source commit/tree/archive, executable hash, actual compiler/runtime versions and measured comparison. Its scanner Git head/tree and worktree status distinguish a working-tree build from a clean committed build.

## Published representation

The tracked manifests under `rust-quality-adoption-2026-10-24/` are prepared from the five raw JSON manifests with the repository's existing pinned Prettier. Raw captures remain unchanged in the task artifact directory. `publication.json` records each raw SHA-256, each formatted published SHA-256, the formatter version and tool manifest/lock hashes, and successful equality of the decoded JSON content. Hashes inside the copied `provenance.json` identify raw captures; use `publication.json` to map those bytes to the published representation. Formatting is preparation, not an additional runtime dependency of the exporter.

## Fresh result

The 2026-10-24 reproduction measured 765 Rust source files and 163 separate targets. All 14 oversized target counts exactly matched the immutable reference, every recorded closure summed to its target count, and the current baseline retained SHA-256 `cecc4c55dd8e01d2a59bb7ac5b84980ad797f96a208c7bfa2d962b08d276b4f7`. The [source inventory](rust-quality-adoption-2026-10-24/source-inventory.json), [complete target closures](rust-quality-adoption-2026-10-24/target-closures.json), [adopted target closures](rust-quality-adoption-2026-10-24/adopted-targets.json), [scanner input hashes](rust-quality-adoption-2026-10-24/scanner-sources.json), [raw provenance metadata](rust-quality-adoption-2026-10-24/provenance.json) and [publication mapping](rust-quality-adoption-2026-10-24/publication.json) are retained together.

The immutable source tree is `04a107dae9f43cd12c7f2dbbd1ba30f171b80c5a`. The fresh scanner executable SHA-256 is `1df6087987faa58f145dd4e5753f1796d1a27abd9316dd6431e4536277daad20`; its input manifest SHA-256 is `52435aabbefcace4161089813a9259f30d42cc86c102dffcfdebf6b9d0aba47a`. Raw source-inventory and target-closure SHA-256 values are `71b135ab496171b08b11dd319b9bc69d2db258a18f076f2aa36705043e34cb5e` and `b199fea52b0298a533432e8303837b409c2de3ad343d83607f943dfea19d0964`; published byte hashes and decoded equality are recorded separately in the publication mapping.

Fresh executed evidence reference `591bceabb6cc0ae63ee09ee9914b02c17ad0b9b53f9be3f4389670cde15755a5/f7009d9a-55b8-4574-89f8-e6d66ebc35f8` passed the combined final-source capture with exit 0: changed-file ESLint, strict TypeScript, three affected Bun tests behind the committed fixture boundary, all 17 parser fixtures, selected native staged Clippy with its no-growth comparator, exact Rust formatting, and the immutable reproduction. The scanner was built in the lane-private target with pinned Bun 1.4.0 and Rust 1.98.1, offline Cargo and two jobs. Source hashes identify the tested working-tree build; the recorded Git head/tree are its pre-commit ancestry, not a claim that uncommitted scanner changes were present in that old tree.

## Evidence boundary

The historical `adoption` metadata remains unchanged. Native/WASM diagnostic hashes, original parser context hash, original capture-tool identity and evidence references are recorded metadata; this reproduction does not establish their original bytes or rerun the old Clippy capture process. New structural manifests and command/evidence receipts have fresh identities. Complete historical Clippy reproducibility remains unproven until its actual generator and captures are recovered or a separately authorized diagnostic reproduction is completed.

Passing this comparison proves that the 14 adopted target allowances describe debt already present at the immutable source. It does not prove the current Rust port complies with the 1000-line rule or establish compile-performance improvement.
