# Workspace repair policy and native authority

The three application modules under `src/application/workspace/repair-*.ts` own
the complete existing nested repair, root registration/backpointer recovery, and
confirmed broken-checkout replacement transactions. `src/worktree.ts` retains
native repository, branch/config, parent/destination, registration, quarantine,
path, metadata publication, environment, and content-merge authority. The inward
ports relay these native receipts by reference. The passive repair-authority
constraints describe only facts the policy uses; they do not clone proofs,
interpret index bytes, or supply a general process/filesystem executor.

Nested repair observes the source mode and owner, captures all source identities,
then handles each missing or empty destination in order. Invalid nonempty parents
and their descendants remain untouched. Empty directories and missing stale
registrations are preserved before addition. Failure compensates created entries
in reverse order, restores registrations/empty destinations, and removes newly
created parents with the original guards. Normalization remains part of that
transaction. Preserved-registration notices occur after commit and a notice
failure does not initiate rollback.

Root recovery keeps inspection separate from confirmed publication. Both a
missing registration and an existing stale backpointer use the original source,
path, branch/OID, index, metadata-content and identity proofs. Confirmation-time
preflight callbacks retain their original captured authority. Temporary directory
creation/identity capture precedes the missing-registration try/finally. The
workspace and registration rewritten flags are set before capturing installed
identities. Compensation uses those exact receipts and preserves exceptional
rollback/branch-conflict errors. Native Git argv, environment objects and returned
observations remain in the facade. Metadata read paths are lazy where necessary
to retain the native read callee before nested path/proof evaluation.

Broken replacement requires confirmation before source/path/ownership work. It
quarantines the old checkout and stale registration, then prepares/adds the
replacement. The existing status-only failed-add decision remains distinct from
nested repair's status-or-error decision. Its reversible phase includes exceptional
source/destination observations, addition, receipt qualification and content merge.
Compensation uses only returned native receipts and checks whether restoration
actually succeeded. A fully restored content conflict keeps its native error
class; uncertain recovery instead reports the primary failure and retained data
locations, preserving any successor.

Rollback admission closes before the first registration settlement attempt:
settlement can partly delete old metadata before throwing. Settlement commits
only the destination's stale registration; displaced unreachable registrations
remain preserved with the original notice. A settlement, late notice or backup
cleanup failure never rolls back the authoritative replacement. The custom
cleanup getter remains at its late point and its callback is called bare.

The earlier frozen-source and transaction-replay checks establish the
extraction's historical compatibility baseline for unchanged contracts. They do
not require preserving the dispatch and exception-boundary defects corrected by
the current regression tests. Private Git tests exercise retained native helpers;
strict core types check the application ports. Genuine emitted CLI checks and a
combined affected-owner suite qualify current integration separately. Native
Windows/macOS acceptance and global migration completion remain separate.

Startup workspace detection also uses the recorded-path reachability policy.
A nested gitfile whose recorded Git directory is absent, including a directory
path beneath another `.git` file (`ENOTDIR`), is omitted with the existing
escaped, deduplicated notice. The shared metadata classifier marks only those
recorded-path absence failures, and direct nested classification handles that
marker. A missing `commondir` inside an existing Git directory retains normal
gitlink classification.

This is observation rather than Git repair: detection preserves operator files,
registrations and healthy sibling repositories. An unreachable workspace root,
a still-registered unusable child, valid mixed layouts and other metadata or
ownership failures retain their refusals. The ordinary-root and rootless scans
do not acquire managed-workspace authority from skipping an orphan. See
[the startup detection requirement](../common/REQ__workspace-detection-unreachable-gitdir.md).

For a source checkout, `npm run install:global -- --skip-image` builds the CLI
and installs the new executable without building a container image. Use the
installed `ccc codex` from the affected checkout for host confirmation. The
unchanged package version alone cannot identify which source build is installed.

Real-Git fixtures must not require a developer's signing key. A command-local
`commit.gpgsign=false` override can isolate inherited signing configuration
without changing the developer's global Git configuration.

## Known ceiling

If a native addition changes Git state but throws before returning a registration
receipt, the application cannot safely invent cleanup authority. It preserves
the unqualified replacement and original-content backup, reports recovery
locations and retains the underlying error. It does not claim full restoration
or expose a content-conflict error that would authorize acting on a successor.

Known ceiling: temporary mkdir/identity failure occurs before root recovery's
finally, and publication followed by failed installed-identity capture can lack
rollback authority — upgrade when a separately reviewed recovery change defines
that ownership and compensation behavior.

Reverting the code does not require deleting user checkouts, quarantines, branches
or metadata. Native Windows/macOS and whole-migration acceptance remain separate
from portable private-Git recovery controls.
