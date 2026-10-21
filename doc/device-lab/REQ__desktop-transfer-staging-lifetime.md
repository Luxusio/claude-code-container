# Desktop transfer staging lifetime

Desktop screenshots and guest transfers must finalize ephemeral stages allocated
by the current operation, including native execution throws, invalid native
results, failed artifact validation and destination publication failure.
Finalization uses the allocated handle and existing path/identity fences; it
never grants permission to delete a different generation or unowned path.

macOS remote screenshot cleanup failure must remain visible and must not prevent
an attempt to dispose the operation's local screenshot stage. Remote recovery
evidence and durable journals are distinct from ephemeral local stages and must
not be erased by this rule.

When an operation and cleanup both fail, retain both failures with the original
operation as primary evidence. Cleanup failure after successful destination
publication must retain truthful completed-publication evidence: it cannot claim
that publication was prevented, undone or safe to replay automatically.

**Derived:** The shared-cleanup guarantees below implement the preceding
owned-stage finalization, primary-plus-cleanup failure retention, and truthful
completed-publication requirements; they introduce no new user requirement.
Exposing removal failures lets callers uphold those existing guarantees.

Shared native stage cleanup must expose a failed removal to its operation;
validated discard must not report success after a failed removal. Failed input
staging attempts its own cleanup once, without re-entering the staging catch.
Disposable recording finalization stages follow this rule, while persistent
simulator stages retain their existing recovery lifetime. Confirmed output
publication and recording state clearance remain explicit when later cleanup
fails. See [the cleanup contract](GUIDE__transfer-stage-cleanup.md).

Native transfer observations must match the requested operation before artifact
publication. Unexpected Windows guest actions and malformed Linux download
framing produce failure, followed by owned-stage finalization. Byte limits,
staging validation and destination publication policy remain in the application;
native encoding and decoding belong to adapters.

Resolved iOS app-container paths use the host's native path semantics. An owned
descendant remains valid on Windows and POSIX; sibling, ancestor and resolved
link escapes must be rejected before transferring bytes.

Application tests exercise execution throws, unexpected actions, malformed or
oversized artifacts, remote cleanup throws, combined failures and cleanup failure
after publication. Native file/SDK qualification is separate from these composed
policy tests.
