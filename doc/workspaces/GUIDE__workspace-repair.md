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
nested repair's status-or-error decision. Preserved-content conflicts compensate
the owned replacement and restore old content/registration. Settlement commits
only the destination's stale registration; displaced unreachable registrations
remain preserved with the original notice. Once replacement/settlement succeeds,
late notice or backup cleanup failure does not roll it back. The custom cleanup
getter is read once at its original late point and its callback is called bare.

The frozen source, native helper/class hashes, public declaration comparison and
self-contained transaction replays establish the extraction's compatibility
baseline. Replays compare actual facade composition with the original regions,
including partial effects, field/receiver/error order, compensation and commit
boundaries. Private Git tests exercise the real retained helpers. Strict core
types and dependency guard mutations prevent native effects from moving inward.
Root integration supplies the complete built/extracted/installer closure and one
combined suite; native Windows/macOS acceptance and global migration completion
remain separate.

## Known ceiling

Known ceiling: original broken-add/registration-receipt throws can escape after
partial quarantine/add effects without the later merge compensation — upgrade
when a separately authorized behavior change adds recovery for that boundary.

Known ceiling: temporary mkdir/identity failure occurs before root recovery's
finally, and publication followed by failed installed-identity capture can lack
rollback authority — upgrade when a separately reviewed recovery change defines
that ownership and compensation behavior.

These existing limits are preserved during extraction. Reverting this code
cutover does not require deleting user checkouts, quarantines, branches or metadata.
