# Home layout migration

`migrateHomeLayout(options)` remains the synchronous host entry point. Its public
options and result types are reexported from `src/home-layout.ts`; the deprecated
clipboard retirement callback remains accepted and unused. The facade resolves
the home first, captures the warning callback, and binds native effects to
`createHomeLayoutMigration` in `src/application/home-layout-migration.ts`.

The application owns pending-work decisions, the reserved default profile suffix,
clipboard preflight, move order, conflict reporting, remote JSON parsing and
merge precedence. `src/ports/home-layout-migration.ts` defines synchronous semantic
observations and effects. Startup receipts are opaque to the application and are
released unchanged in acquisition order. Native filesystem paths, identity
checks, lock acquisition and config publication stay in the facade.

After pending-work detection, the application acquires the migration lock using
a deferred clock read. Live sessions and legacy container mounts defer migration.
Both clipboard startup generations in the legacy and run namespaces are checked
before clipboard file preflight, runtime directory creation and startup claims.
Existing startup locks are never reclaimed by this migration. The migration lock
retains its two-attempt, ten-minute mtime takeover policy.

An unmarked profile named `default` is set aside only when legacy default
credentials exist, using `default-pre-layout`, then `default-pre-layout-2` and
later available suffixes. Credential entries move after `clipboard.port`, followed
by locks, clipboard files and helper binaries. A failed clipboard move stops the
remaining moves. Existing destinations win and retain their legacy counterparts;
conflicts are reported once through `run/layout-conflicts`. New directories and
files retain their `0700` and `0600` creation modes.

Legacy remote `.json` files are parsed in the application. Existing destination
remote entries win; parsed arrays and primitives remain accepted values. Config
publication completes before source files are removed in listing order. Invalid
legacy JSON stays in place, and invalid destination config prevents publication
and source deletion. A later unlink failure preserves earlier deletions and
reports remote failure without adding partial remote names to the moved result.
Neither results nor notices contain remote JSON contents.

Finally, native effects release claimed startup files only when their device and
inode still match, persist new conflict notices best effort, and release the
migration lock last. Existing broad observation fallbacks and warning/catch
boundaries are preserved, including warning callback failures and original thrown
values. Session, mount and runtime directory exceptions still escape after cleanup.

The migration is one-way. Reverting this code does not rename a migrated home
back. Existing per-entry legacy fallback continues to support partial migration;
there is no reverse migration or new storage schema. General home resolution,
profile catalog, clipboard service and remote execution remain outside this
application. Native macOS/Windows acceptance and the remaining architecture
migration slices require separate verification.
