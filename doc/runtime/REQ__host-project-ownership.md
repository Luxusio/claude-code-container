# Host project ownership

CCC must preserve ordinary host access to files created by its project user.
On native rootful Linux, including WSL Linux project directories, `ccc` runs
with the invoking user's effective UID and primary GID. The named account and
HOME remain `ccc` and `/home/ccc`; sudo and supplementary groups remain usable.
Rootless Podman keeps its explicit host-user-to-container-1000 mapping.
Desktop filesystem sharing uses the default 1000 identity. Rootless Docker
cannot use a native host UID directly; reject that unsupported mapping with
an actionable error. Reject root or invalid native host identities.

Default images create ccc explicitly as 1000:1000. Only the known Ubuntu
placeholder account may be removed to free that UID. Runtime customization
uses cached derived images keyed by immutable base image identity, target
UID/GID and contract version. Reconcile image accounts and image-file ownership
only inside an image build without host mounts, without following symlinks or
reowning unrelated files. Retained lab volumes have a separate, bounded migration
described below.
Verify the named user, primary group, HOME and final image user before reuse.
Concurrent builds must serialize and failed builds must not publish valid caches.
An uncached identity build has a 20-minute command budget because changing the
image's owners can require copying and exporting a large filesystem layer.
Identity-lock acquisition waits up to 21 minutes without stealing a live lock.
Other command budgets remain unchanged. A build timeout reports the command
error and a bounded tail of build diagnostics so the failing phase is visible.
Validation containers use the same applicable runtime mapping and cgroup options
as project containers. If no local image exists, image-download failure unwinds
startup and session locks so retrying does not require manually removing a lock.
A failed update download continues with the existing local image when available.

Both image upgrade and mount-contract recreation must refuse to replace a
running container whose identity contract differs. Explain that the user must
finish the work and stop the container before retrying. Refusal must preserve
the existing container and remove only startup state owned by the failed new
session. Stopped legacy containers can transition without deleting projects,
credentials or prior cache volumes. Subsequent starts reuse the resolved image
instead of repeatedly comparing a derived image with its base.

For an already running container with the correct identity and mounts, an
image-only update is deferred: the command continues in the existing container
and prints instructions to stop it after its work finishes. Mount-contract drift
rejects startup while preserving the running container. Failed command execution
in a running or just-restarted container reports a diagnostic and requires
explicit inspection/stopping; it does not automatically kill or recreate it.

Mise and Codex package cache volumes are scoped to the UID/GID and mapping contract. Existing
cache volumes remain intact. Any retained per-container writable state must
become usable by the replacement identity without changing live state or host
credential ownership, except for the bounded CCC-managed Codex state migration
below. Diagnostics must inspect the same cache used by startup.
Forwarded SSH agent sockets keep their host permissions; startup must never
broaden a socket's mode to make the agent accessible to other host users.

Lab-volume migration runs only while that exact named volume has no running
container users. Establish its previous ccc UID/GID from the old container's
image before removal; translate only those owners, without following symlinks,
in a helper that mounts no host directories or credentials. The dedicated volume
root itself is assigned to the target UID/GID, regardless of its previous owner.
An in-use volume,
unknown previous owner, or mismatched detached-volume owner rejects startup and
retains the data. Do not guess an old owner from the volume's root directory.
For recovery, finish the volume's running work, confirm the previous and target
numeric owners and the exact named volume, then repair only verified old-owned
entries in that isolated volume before retrying. Do not use a project-wide or
host-wide ownership command to repair a named volume.

Remote startup selects a separate mise cache by the actual remote image's UID
and GID before creating a container. This permits both old UID1001 images and
new UID1000 images without changing ownership of the legacy shared cache.
Existing remote containers continue to use their existing mounts; this change
does not replace them or change Mutagen synchronization.

## Existing projects

CCC-managed Codex state (the resolved default or named profile, including legacy `~/.ccc/codex`, distinct from host `~/.codex`) must
remain usable after a native host identity transition. Before removing a stopped
legacy container, verify its actual bind source and obtain the old named ccc
UID/GID from its immutable image. Translate only those matching IDs independently
within that exact state directory. Do not guess old IDs from file ownership.
Preserve content, ordinary modes, symlink targets and unrelated owners.

Serialize all host project startup through a shared lock outside Codex state,
covering inspection, migration and container creation/start. Refuse migration
when any running container has an overlapping bind mount, inspection fails,
the root or any ancestor is symlinked or writable by group/others, or the tree contains hardlinks, nested mount
boundaries, set-ID entries or unsupported special files. Detect changed tree
membership and metadata before and after descriptor-relative nofollow ownership
changes. Unsupported mappings must not receive native host-ID repair.
Match the mounted root's device/inode against the validated host root before
traversal. Refuse mismatches rather than assuming a runtime's path translation
preserves identity. Unsafe directory modes produce a diagnostic naming the
directory whose group/other write permission must be removed before retrying;
CCC must not silently change directory modes to enable migration.
A failed migration retains the old container for diagnosis and retry.

Every Codex startup checks traversed directories for read/write/traverse access
and regular files for readability. Top-level files and mutable runtime subtrees
(`app-server-daemon`, `app-server-control`, `tmp`, `sessions`, `archived_sessions`, `log`, `logs`,
`shell_snapshots`, `sqlite`, `memories`) also require file write access. Files
and directories under `app-server-daemon`, `app-server-control` and `tmp` must belong to the runtime
UID, except symlinks. Packaged plugin/Harness files may remain read-only.
If these checks fail, including after the old container has already been
replaced, stop before launching Harness or Codex with a diagnostic naming the
CCC state directory and requiring verified, offline recovery. Never extend
this repair to the user's actual `~/.codex`, project files or other credentials.

### Known ceiling

Known ceiling: Unresolvable active bind sources block migration. On native
Linux WSL with rootful Docker Desktop, a daemon-reported opaque source matching
`/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/<distro>/<64hex>` may
receive a bounded identity proof. A disposable helper from the trusted immutable
base image mounts only that exact source read-only, with no network or Linux
capabilities, and runs `stat` without reading file contents. Its device/inode must
exactly match the trusted host object's identity. The caller revalidates the host
object before and after and retains the normal live mount challenge as a second
check. Unsupported runtimes, failed probes, malformed output or different
identities do not authorize alias acceptance; labels and guessed translations
are insufficient. Only the proof helper's own captured container ID may be
cleaned up after timeout. This proof does not grant ownership migration permission
by itself or replace active-user overlap checks.

Changing the runtime identity prevents recurrence; it does not automatically
change ownership of existing host files. Finish active container work before
repairing a project. Verify host IDs with `id` and project ownership with
`ls -ldn`. For the confirmed old owner 1001:1001, a bounded repair is:

```bash
sudo chown -hR --from=1001:1001 "$(id -u):$(id -g)" ~/projects/project-txt
```

Use the actual old owner and project path. Do not recursively change unrelated
owners or credential directories. Stop the old project container after its
work finishes, then start it with the updated CCC. A live legacy container
continues to use its original identity until that transition.

## Verification

Use disposable bind-mounted projects to prove both host and container can
create and edit files, and inspect numeric ownership for UID1000 and a
non1000 user with a different primary GID. Check HOME, named-user commands,
sudo, mise writes, preserved credential sentinels, concurrent image builds,
cache reuse, and failure cleanup. Lifecycle tests must prove that neither
image-upgrade nor mount-contract drift stops a running legacy container.
Also verify that a compatible running container defers an image-only update,
that mount drift and command-execution failures preserve running work, and that
lab-volume migration failures retain data and provide a repair diagnostic.

For Codex state, use disposable 0700 directories and 0600 files owned by a
verified old UID/GID. Verify target-user reads/writes after migration, independent
UID/GID filtering, unchanged content/modes/inodes, and untouched symlink targets
and unrelated owners. Prove unsafe preflight leaves all ownership unchanged,
detected concurrent additions reject migration, failures preserve the previous
container, and already-replaced unreadable or unwritable state is rejected
before Harness/Codex launch. Read-only packaged files must still pass.
