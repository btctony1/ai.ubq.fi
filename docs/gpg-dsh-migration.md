# Signing-helper upgrade quiescence (#1182)

For an upgrade from the shared `$TMPDIR/dsh-gnupg/<uid>` layout, use the enforced installation procedure below.
Do **not** overwrite the installed legacy helper with `install` or invoke the repository helper alongside a running
legacy copy: the repository helper's migration cleanup does not coordinate with that old copy's rebuild lock.
The installer closes that upgrade window without changing the helper's per-user layout or cleanup policy.
Merging this change does not install anything on the owner's Mac, and no patch application is required.

## Owner-authorized installation

1. Identify the canonical absolute installed path already used as `gpg.program`, normally `~/bin/gpg-dsh`.
   The file and its directory must be owned by the installing user. Symlinked files or parent paths are refused.
2. Stop automatic signing jobs during maintenance. All callers must use that canonical installed entrypoint;
   stop callers of other copies, relative paths, or aliases separately. Do not launch `ops/gpg-dsh.sh` directly
   during the upgrade. The installer fences the configured entrypoint, not arbitrary copies elsewhere.
3. Compare the repository helper with the installed helper, then explicitly run the installer as that user:

   ```sh
   diff ops/gpg-dsh.sh "$HOME/bin/gpg-dsh"
   sh scripts/install-gpg-dsh.sh "$HOME/bin/gpg-dsh"
   ```

   A difference is expected; inspect it before authorizing installation. This replaces the direct `install -m`
   step in the older signing-helper installation notes for legacy upgrades. The installer does not change Git
   configuration, credentials, the real GnuPG homedir, or service configuration.
4. Resume signing jobs only after the installer reports success. The existing `gpg.program` path is unchanged.
   The first sandboxed signing call then removes abandoned legacy copies and uses `$TMPDIR/dsh-gnupg-<uid>/seed`.

## Enforced drain and failure behavior

The installer serializes upgrades with `<installed-path>.install-lock`, saves the original helper there, and
atomically replaces the installed entrypoint with a temporary queue. New signing calls at that path wait rather
than executing either helper during the drain. Already-running shells keep their old script inode and continue
untouched. Process enumeration waits for those shells and for this user's GnuPG clients, including a legacy
signer that has already released its rebuild lock and executed `gpg`. A live legacy lock owner also prevents
publication, regardless of the lock's age. A missing owner is not proof of abandonment.

Only after the drain does the installer atomically publish the repository helper and release queued calls.
It neither kills a legacy process nor removes legacy locks, seeds, stages, set-asides, or agents. The helper
continues to enforce ownership checks, refuse seeded configuration files, and remove abandoned key copies.
Stale-lock recovery and publication races inside the helper remain separate work under #1168.

The drain defaults to 60 seconds. `GPG_DSH_INSTALL_WAIT_SECONDS` may explicitly select 1–600 seconds. A timeout,
process-enumeration failure, unsafe legacy lock, or handled signal restores the original helper **before** releasing
queued calls and exits nonzero. Inspect the failure, let legacy calls finish, and retry; do not bypass the drain.
An unpublished legacy owner requires manual investigation with all legacy callers stopped before recovering its
abandoned lock. A symlink or foreign-owned lock is never removed by the installer.

An uncatchable termination or failed rollback can leave the temporary queue and installation barrier in place,
failing closed. Do not delete a live installer's barrier. The owner must first stop all signing callers and prove
that no installer or legacy invocation remains, then restore `<installed-path>.install-lock/original` to the
installed path before removing the barrier and retrying. The saved files are helper scripts, not signing keys.

## Deterministic offline fixture

```sh
sh tests/fixtures/gpg-dsh-migration.sh "$(pwd)/ops/gpg-dsh.sh"
```

Set `TMPDIR` to a writable absolute fixture directory. The local Git object for legacy helper
`ed0ecdda85ee261bc8388558bb26c2c86f5ac9a5` must exist; the fixture performs no fetch or install of dependencies.
It installs scripts only inside its private fixture directory, never at the owner's installed path. All keys
are fixture strings; `gpg`, `gpgconf`, and the real-homedir write probe are replaced.

A copy barrier pauses the exact legacy helper after its lock and staging directory exist. A fake clock makes
its live owner token old without an aging sleep. While paused, the fixture starts the installer and a signing
call through its queue, observes both barriers, and verifies that no legacy directory or agent was touched.
It resumes the old call and requires `install=0 new=0 legacy=0 lock-and-stage-preserved=true`, with legacy signing
preceding new-layout signing. A second paused call with an unpublished owner proves timeout rollback leaves the
old helper and rebuild intact. A paused legacy GnuPG client without a rebuild lock must also drain before
installation succeeds. Abandoned-copy removal, seeded configuration refusal, and legacy lock-symlink
preservation are also checked. Fixture state is removed on exit.

`tests/gpg-dsh.test.ts` invokes this fixture directly, so the existing focused Linux and macOS helper tests exercise
the regression without applying a patch. CI's full-history checkout provides the legacy object. Run that focused
suite, changed-document formatting, shell syntax/lint checks, and the normal strict TypeScript check with the
repository's frozen dependencies; no full verification or live installation is needed for this bounded change.
