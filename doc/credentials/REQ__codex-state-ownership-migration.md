# Codex ownership migration must use qualified native facts

The public `prepareCodexStateOwnership(previous, imageId, identity, profile?,
proveSource?, bindGuard?)` remains synchronous; the optional sixth argument supplies an already held bind-publication guard. Direct callers acquire the existing bounded standalone guard. Non-host mapping and the
existing nested-Docker gate return before probing previous-container metadata.
Unsupported rootless, Podman-machine, non-Linux or mismatched host principals
retain their existing refusal and effect order.

After host admission, native composition decodes previous mounts/image, old
UID:GID, active IDs and inspected container mounts into finite semantic facts.
Invalid or incomplete prior mount metadata must refuse migration before the
ownership helper. A valid empty mount list, or a valid list without the managed
Codex destination, remains a no-op. An exact single managed bind or the existing
source-proof callback is still required. Getter and native runner failures keep
the original exception; no guessed principal or successful fallback is added.

Core retains positive bounded old-account policy, two full root/ancestor trust
traversals, overlapping active-user refusal, root device/inode identity and final
principal validation. Native helpers retain pinned descriptors, BigInt identity,
exact argv, 300000 ms timeout, 4 MiB output cap, UTF-8 and original error/status
handling. A failure after selective ownership writes can retain partial migration;
there is no new rollback or automatic retry. The caller retains its existing
startup lock across migration and container start. Windows private-state repair remains a separate, qualified native path; it is described below. Unrelated host credential behavior remains unchanged.

Verify malformed native/account/container/mount observations, lazy short circuits,
empty-mount no-op, original getter faults, two traversals/replacement, no helper
on refusal and exact helper dispatch in the existing ownership core/facade/types
and public `src/__tests__/codex-state-ownership.test.ts` suites. Private Python
fixtures do not certify live Docker/Podman ownership migration or host ACLs.

Every prior mount entry must be an object with a nonempty string Destination.
Missing, non-string or empty destinations refuse before producing prior facts,
including when an invalid entry accompanies an otherwise qualified managed bind.
Valid unrelated destinations do not require Type, Source or Image getters.

Every prior Mounts array slot must supply complete mount metadata. Missing sparse slots refuse like undefined entries, alone or beside a qualified managed bind. Preserve ascending getter order and lazy unrelated fields; sparse nonempty arrays never qualify as valid empty metadata.

## Windows private-state repair

After confirming the Windows SID/path, the exact writable Codex bind, target
account and observed same-source users on the captured runtime, selective repair
also admits UID/GID 0 entries created by CCC root setup. Foreign user and group
identities are independently refused. Pinned descriptors, filesystem/entry-kind,
Set-ID, hardlink, identity and membership checks remain in force. The runtime
peer scan is a snapshot, not a global cross-endpoint exclusion guarantee; partial
writes on later failure are not described as atomic rollback.

The short ownership probe does not traverse historical sessions and logs. Runtime
entries disappearing between enumeration and lstat are ignored; permission errors
and observed foreign ownership still refuse. The root itself must remain valid.
Executable Python fixtures model these facts and do not certify real descriptor
races or Windows ACL/native ownership migration.
