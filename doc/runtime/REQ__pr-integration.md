# PR integration into the current architecture

Integrate the behavior of PR #9 and PR #10 while retaining current application
policies, native adapters, profile resolution and package layout. Record which
PR #9 behavior is already supplied by current code or PR #10, and test any gap.

Capturing a container ID does not by itself authorize shutdown after failed
setup. An invocation that only joins existing work must release its own claim
without stopping that container or its devices, including guardian cleanup on
parent exit or IPC loss. Host ownership acquisition begins with
`cleanupEnabled:false`. Captured identity
and shutdown permission remain separate in parent state and guardian IPC. A true
grant becomes effective only after the guardian acknowledges that update; changing
the captured ID revokes permission before publishing its replacement. Legacy
unowned `setSession` callers retain their default cleanup permission.

An invocation that starts the container may clean up that exact container after
setup failure: an existing stopped container is captured immediately after a
successful start, while a fresh container is captured only after managed-source
and running-identity verification. Capture happens before setup helpers. An
unauthorized guardian rollback releases its claim without device-stop effects.
A successful launch retains normal
last-session cleanup; other live claims and successor identity still veto it.

Keep owned temporary environment-file disposal through argument construction,
preparation, awaited command execution and ownership restoration. Preserve
the initiating error or command status. Do not replace owned disposal with a
pathname-only unlink or replace interruptible awaited execution with spawnSync.

Preserve profile credential contents, mapped-principal access and existing
ownership fences. ACL file mutation requires a pinned regular single-link file
and no-follow ancestor traversal; unsafe ancestry or substituted identity must
fail before mutation. Default-profile writers use the stable legacy root lock;
named profiles use their resolved config lock. Host access restoration remains
inside that writer lock. Keep selected-tool-only installation and distinguish
absent
cached executables from failed probes. Preserve active clipboard bind users,
host SSH authority changes and runtime-specific cache identity. A failed current
image resolution throws rather than falling through to container startup. Reuse
readiness retains a five-second probe limit, three attempts and one shared
15.15-second deadline; a timeout never authorizes stopping existing work.

Verify combined parent/guardian failure paths, native ACL and retained-state
boundaries, existing architecture/env regressions and both delivered package
forms using private nonsecret fixtures. Linux evidence does not establish native
Windows, macOS, Hyper-V or physical-device acceptance. No live user-state
migration or global installation is part of this task.

After local integration and verification, update and merge the existing GitHub
PRs #9 and #10 so both are recorded as Merged. Their authorized destination is
`feature/device-mcp-squashed`, not master. Preserve original PR branch ancestry
and author attribution; do not force-push or replace a merge with a manual close.
Recheck exact remote heads and base before publishing only verified source.
Remote execution requires authenticated repository access; local validation
does not by itself establish a successful GitHub merge.

## Verification limits

A successful capture/acknowledgement exchange is required for owned cleanup.
This contract does not promise cleanup of an arbitrary container, or of a newly
started container when the parent is forcibly killed before identity capture.
No arbitrary container scan supplies missing authority. File identity checks
and POSIX ACL xattrs are native boundaries: unsupported filesystems refuse
mutation. Linux native tests and fake facade locks do not establish Windows or
macOS filesystem, process, signal, runtime or hardware acceptance. Actual review
and fresh QA are required before publication; neither local source reconciliation
nor prepared merge commands establish that GitHub recorded either PR as Merged.
