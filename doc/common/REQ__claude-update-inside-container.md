---
type: REQ
status: candidate
created: 2026-09-05
source: user bug report ("claude update가 안된다"), measured on this project's own ccc container
---

# `claude update` inside a ccc container

Running `claude update` inside a ccc container must change the version that
subsequently runs.

## Intent

ccc installs Claude Code into the container and caches it in a named Docker
volume so a new container does not re-download ~200MB. That cache must not cost
the user the ability to update.

Before this requirement existed, it did. ccc wrote the launcher at
`~/.local/bin/claude` as a plain copy of the binary. Claude's native updater
manages that path only when it is a symlink into `<data-dir>/versions/`, so it
installed the new version, printed a warning and `Successfully updated`, and left
the launcher alone. Every later run executed the same stale binary. Measured on
this project's container: launcher at 2.1.241, `versions/2.1.261` present and
unreferenced, volume cache byte-identical to the stale launcher. Because the
cache is a volume shared by every ccc project, one stale binary pinned them all.

## Observable behaviors

1. After `claude update` reports a new version inside a ccc container, a
   subsequent `claude --version` in that container reports the new version.
   `ccc update` — the documented command for this, which runs the tool's
   `updateCommand` inside the container with no copying of its own — is covered
   by the same behavior, and was broken for the same reason.
2. `claude update` does not warn that the launcher was not created by the
   native installer.
3. The updated version survives stopping and restarting the container.
4. The updated version survives `ccc rm` followed by a new `ccc` run — it comes
   back from the volume, not from a re-download.
5. A container created by an older ccc, whose volume holds only the pre-symlink
   single-file cache, adopts that binary as a version rather than downloading
   again.
6. ccc never installs a mise shim as the claude launcher, and never one whose
   `--version` output is not Claude-shaped. "Claude-shaped" is a heuristic on
   the version string, not proof of identity: a bare `1.2.3` from an unrelated
   binary satisfies it. Reaching that requires something already named `claude`
   on PATH, so the guard is a filter against accidents, not an authenticity
   check.
7. When `curl | bash` exits 0 but leaves no usable launcher, `ccc` fails at that
   point with a message naming the installation, rather than later with a
   generic "tool is unavailable after setup".
8. When setup fails, the reason reported from inside the container is included.
   A read-only volume, a full disk, and a bind mount in the way all produce the
   same bare "probe failed" otherwise, and the difference is only on stderr.
9. When ccc reuses an already-installed claude, it says which version. "Why am
   I on an old claude" is the question that line exists to answer, and the
   previous wording ("Restored claude from cache") was also no longer true —
   nothing is copied out of a cache.

## Behavior against a volume other projects are using

`ccc-mise-cache` is one volume mounted into every ccc container on the host, so
the install directory is shared. That makes several things observable:

10. ccc never overwrites a version file that already exists in the volume. One
    container's startup must not disturb a binary another container is
    executing — forcing over it fails with ETXTBSY and takes down a project
    that was working. Version files are named by their content, so an existing
    one is already correct.
11. A version name written by current ccc appears in the volume only when its
    bytes are all there: a copy interrupted partway leaves no published name,
    because nothing would ever replace a truncated file once it existed.
12. Nothing ccc publishes into the volume is a symlink. A link there names a
    path that exists only in the container that wrote it, so every other
    container reads a name pointing at nothing — and no later run can free it.
    ccc reads its own install through symlinks rather than copying them, so a
    data directory that reaches versions/ by a link publishes the same regular
    files as one that does not.
13. A start recovers from a volume entry that no version binary could be.
    Under a *version* name, clearing is safe where overwriting is not:
    `unlink` only unbinds the name, so a process already running that binary
    keeps its inode and cannot be interrupted the way an overwrite interrupts
    it with ETXTBSY. That argument does not extend to other names, and the
    rule below does not either.
    A directory under a version name is junk by construction — ccc refuses to
    create one, skips one when choosing a version, and refuses to seed from
    one — so nothing anyone runs is inside it and it is cleared whole, except
    where a user has put a mount there (behavior 16). Refusing
    it instead left a container with a working local install failing on every
    start with no way back. Every other name is cleared only when it holds
    nothing, because ccc cannot tell its contents from what other projects are
    using, and the refusal says why it could not be cleared. A regular file
    already under a version name is left alone: it may be what another
    container is executing, and version names are content-addressed, so it is
    already correct.
14. ccc never publishes anything over `versions/` itself. That name holds every
    other project's binaries, and a file written there could not be undone by
    any later start: once the data directory is the symlink, the adoption path
    is never entered again. A container whose own layout puts something other
    than a directory at that name fails to start and says so.
15. An entry under the data directory that cannot be read — a link pointing at
    nothing, a socket, a file ccc has no permission for — fails the start
    rather than being published as-is, and the message names the entry. The
    local install is preserved, so the state is repairable by hand, but the
    volume is not left as it was: entries reached before the failing one are
    already published. Adoption is not atomic, and nothing here claims it is.
16. ccc refuses to delete through a mount point — at the data directory, at
    the launcher path, and at a version name it would otherwise clear — and
    says which one it refused. Deleting through a mount empties the other side
    and only then fails on the directory itself, which is a failure ccc cannot
    tell from an ordinary one, so nothing after the fact could report what was
    lost. At the launcher there was not even a failure to read: the removal
    went unchecked, the launcher was written inside the directory that
    survived, and the start reported success.
17. A start that could not put the launcher where it belongs fails rather than
    reporting success. Removing whatever occupies that path can fail — a mount,
    a read-only parent — and a symlink created inside the survivor is not a
    launcher anyone will run. ccc never places a mount
    there, but a user can, and `rm -rf` across that boundary empties the other
    side.
18. Setup fails rather than reporting success whenever something that needed
    adopting could not be — a read-only or full volume with anything left to
    publish, and a name held by something that could not be removed. A volume
    that already holds everything this container would publish is not such a
    case: there is nothing to write, so a read-only one is a success. That is
    the whole data directory, not only its versions; a real one carries other
    state beside them, and one missing entry is enough to make a read-only
    volume a failure. The caller removes the
    original on success, so a false success destroys a working install;
    existence of the name is not adoption, and the failure message says which
    entry could not be adopted.

## What stopped being pinned

The removed `saveClaudeBinaryToVolume` persisted whatever `command -v claude`
resolved to at session exit, whatever put it there. So an install made by some
other mechanism — `npm i -g @anthropic-ai/claude-code` landing on the mise shims
path, or a binary dropped in by hand — used to be captured and reused by every
project. It no longer is: only versions under `<data-dir>/versions/` survive a
container recreate, and anything else is reinstalled from `install.sh`.

That pinning is exactly what made the original bug permanent, so losing it is
the point. It is recorded here because it is the one thing a user could
experience as a regression.

## Known limitation

`command -v claude` remains a migration donor, and the donor check only rejects
a binary that looks like a mise shim. A different wrapper script on PATH — for
instance one carried in by the `~/.ccc/claude` bind mount at
`/home/ccc/.claude/local/claude` — would pass the check and be published into
the shared volume under a version name. This behavior predates the change; what
is new is that the adopted file reaches other projects. Closing it properly
means requiring the donor to be a native binary, which the current tests cannot
express without shipping a real one.

## Design consequence, stated because it is user-visible

The install directory lives in the shared `ccc-mise-cache` volume, so all
projects on a host share one set of installed versions. Updating from one
project updates the version other projects will pick up on their next container
start. This matches the previous behavior, where all projects shared one cached
binary — the difference is that the shared thing can now be updated.

The updater says it disables its own version cleanup while the launcher is a
foreign file — "automatic version cleanup is disabled on this machine (the
installer cannot tell which version your launcher needs, so it keeps them all)".
That is its own message, not something measured here, and the container observed
during this work held a single version, so no accumulation was actually seen.
Recorded as the updater's stated behavior.

## Diagnosis

`ccc doctor` reports the launcher's shape, not only its version, because the
version alone is what looks fine in the broken state: a real version printed by
a real binary at the right path. What it checks is where the launcher resolves,
not merely whether it is a symlink — a symlink pointing outside `versions/` is
exactly as unmanaged as a plain copy. It reads either

    2.1.261 (Claude Code) (updatable, -> /home/ccc/.local/share/claude/versions/2.1.261)

or

    2.1.241 (Claude Code) (NOT updatable: launcher does not resolve into /home/ccc/.local/share/claude/versions, so claude update cannot replace it)

## Verification

- `src/__tests__/claude-launcher-layout.test.ts` executes the generated setup
  script against a temp directory and asserts the resulting layout: launcher is
  a symlink into `versions/`, newest version wins by version order, a flattened
  regular-file launcher is repaired, a legacy single-file cache is migrated, and
  shims / non-Claude binaries are rejected.
- Behavior 12 is pinned by a case where this container reaches versions/
  through a symlink: the volume's other versions must survive, the new one must
  publish, and nothing under the volume may be a symlink afterwards.
- Behavior 13 is pinned by three consecutive probe runs against a poisoned
  volume, all of which must succeed; by a non-empty junk directory under a
  version name, which must be cleared; by a non-empty directory at a name that
  is *not* a version, which must be refused with the shared file intact; and by
  a read-only volume, which must refuse. The middle two are what separate a
  clear from a delete, and widening either one is caught.
- Behavior 14 is pinned by a regular file at versions/ against a volume that
  holds the shared directory: the start must fail and the directory must
  survive.
- Behavior 16 is pinned at all three sites by a real bind mount, made inside a
  user namespace with `unshare -Umr`, which needs no privileges; the tests skip
  where the kernel or image will not provide one. An earlier version of this
  document claimed such a mount was unobtainable and used that to excuse
  leaving the guards untested. It was not true.
- Behavior 17 is pinned by a read-only parent at the launcher path, which needs
  no mount at all: the start must fail and must not print RESTORED, and no
  symlink may be left inside the directory that survived.
- Behavior 10 is pinned in part by a read-only volume that already holds the
  version: the start must succeed, because a version already there is left
  alone and so nothing needs writing. The test observes a refused write rather
  than a refused copy — it is what keeps the skip from being deleted, not a
  measurement of copying.
- Behaviors 1–4 as stated are host-tier: they need a real Docker daemon whose
  path resolution matches the caller's, which is not satisfiable from inside a
  container (see the header of `src/__tests__/e2e.test.ts`).
