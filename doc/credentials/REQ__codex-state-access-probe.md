# Codex startup access checks on live state

This derived requirement addresses the reported Mac startup failure: the access
probe listed `app-server-daemon/daemon-updater.sock`, then failed because the
socket had disappeared before its metadata was read. It implements the existing
startup readiness check; it introduces no additional ownership repair authority.

The read-only probe must tolerate a descendant disappearing between enumeration,
metadata lookup and access checks. Only `FileNotFoundError` for a path inside the
state root qualifies. An access check returning false must be followed by a
metadata lookup; a still-present entry remains an access failure. Missing walk
error filenames, errors outside the root and other filesystem errors remain fatal.
The rule applies to all descendants, without special-casing socket names.

The state root must remain a directory and must not be a symbolic link, both
before and after traversal. Root disappearance is fatal. Existing read/write
requirements and private-entry ownership checks remain in effect for observed
entries. Skipping one disappeared entry must not skip other siblings.

The probe must not change permissions, owners or state contents, remove sockets,
or restart containers. The separate descriptor-pinned ownership migration and
Windows private-state recovery retain their current behavior. A successful probe
is a readiness observation, not an atomic snapshot or a guarantee against later
filesystem changes.

Verification executes the exported production Python against private filesystem
fixtures with deterministic removal after real enumeration, including a bound
Unix socket, files and child directories. Negative cases retain root, access,
private-owner, sibling and non-ENOENT error refusal. Source and emitted checks
do not establish acceptance on a real Mac host.
