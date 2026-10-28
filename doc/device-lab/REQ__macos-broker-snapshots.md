# macOS broker snapshot routing

An authenticated owner may invoke `device_snapshot_create`,
`device_snapshot_restore` and `device_snapshot_delete` for its macOS VM through
the host broker. The broker must route these advertised methods to the existing
macOS backend. Explicit and inferred backends use the same owner/device lookup.
Snapshot listing and global base-image methods retain their existing broker
refusals in this change.

Restore and deletion require the literal boolean `confirmDestructive: true`.
Missing, false or differently typed values return HTTP 400 with
`destructive-confirmation-required` before launching the backend child. `force`
does not supply confirmation. Authentication and owner/device isolation continue
to apply.

The backend retains its existing operation lock, Tart eligibility, stopped-or-
force requirement, owned snapshot selection, lifecycle claims, generation
checks, conditional publication, recorder settlement and redacted results.
Routing must not duplicate its lock or substitute a separate snapshot workflow.
Provider failure remains a failure with the existing partial-effect semantics;
successful dispatch alone does not establish snapshot success.

Protocol 12 identifies brokers with this in-memory admission contract. The
existing identity-verified replacement handles an older broker; callers must
not delete runtime files or kill an unverified listener to bypass it. Level 3
continues to use port 17374 and its separate runtime file.

Portable verification covers authenticated HTTP routing through the actual
backend child, confirmation refusal before effects, preserved ownership and
provider guards, and the capability matrix. Actual Tart create/restore/delete
acceptance requires the focused destructive scenario on the Mac host. See
[the snapshot implementation guide](GUIDE__macos-image-snapshots.md).
