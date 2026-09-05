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
9. When ccc removes a version name held by a link, or refuses to remove one
   it cannot, it says so — on any start that succeeds, and by whichever path
   removed it. That removal is the one shared-volume change a user can be
   surprised by: it can move them to a different version, or leave another
   project's launcher pointing at nothing. Clearing an entry that is not a
   file at all — a directory, a fifo, a socket — is reported too at a name
   shaped like a version. At any other name under `versions/` the cautious
   rule applies, and it removes only something holding nothing: an empty
   directory, a fifo, a socket, silently. What it always says is a link it
   removed, and why it refused when it could not. The argument for saying
   nothing was that nothing anyone runs was inside it, which holds for a
   junk directory at a real version name and not for an export named for a
   date, which wears the same shape and cannot be told apart. A clear that
   destroys bytes in a volume every project shares should not be the one
   thing said quietly. A change reported by more than one probe of the same
   start is said once. Every name ccc reads out of the volume and prints —
   in a note, in a reuse line, in an error, in what `ccc doctor` shows — is
   stripped of control and direction-marking characters first, because a
   name is data and can otherwise repaint or reverse the line reporting it.
   In `ccc doctor` that happens where a check is printed rather than where
   each one is built: a rule applied at every call site is a rule the next
   call site forgets. A start that fails carries its reason in the error
   rather than as a note, and that error keeps only the last few lines of
   what the container said.
10. When ccc reuses an already-installed claude, it says which version. "Why am
   I on an old claude" is the question that line exists to answer, and the
   previous wording ("Restored claude from cache") was also no longer true —
   nothing is copied out of a cache.

## Behavior against a volume other projects are using

`ccc-mise-cache` is one volume mounted into every ccc container on the host, so
the install directory is shared. That makes several things observable:

11. ccc never overwrites a version file that already exists in the volume. One
    container's startup must not disturb a binary another container is
    executing — forcing over it fails with ETXTBSY and takes down a project
    that was working. Version files are named by their content, so an existing
    one is already correct.
12. ccc runs a version only when it is a real file under `versions/` that is
    neither hidden nor carries `.tmp.` anywhere in its name. That is wider than
    "not the installer's own staging" — deliberately, since what must not be
    run is any name a staging file could have, and the cost of the extra width
    is a name nobody writes. Beyond those two rules it does not judge the name:
    a file there that answers `--version` like claude is run, whatever it is
    called. Those names sort above the
    version they are becoming, so one left behind by a killed install was
    chosen — and being complete is what made that dangerous, not being partial.
    Nothing else would have reclaimed it either: the installer neither
    overwrites nor removes it, because the name carries a pid and a timestamp.
    ccc collects one once it is old enough to be nobody's install in flight.
    It removes a link found there rather than passing over it. A link may resolve
    to a binary outside the directory the updater manages, which rebuilds the
    original bug — the version works, reports its number correctly, and cannot
    be updated. Passing over it is not enough: the link also holds a name, and
    the installer declines a name that already exists, so a link named for the
    version the installer would produce made every start download and fail
    identically with nothing changed. Freeing the name is what makes the next
    start work. Where the volume cannot be written, ccc still will not run the
    link — it says so and installs instead. ccc never publishes such an entry;
    a shared volume can hold one somebody put there, under any name including a
    hidden one, and adopting over it removes it just as a start finding it
    does. Removing it carries the same inode argument as clearing any version
    name — a process running the
    target is unaffected — but not the rest of it: unlike the junk names in
    behavior 15, a link can be what another container's launcher resolves
    through, and that container's `claude` stops working until its next ccc
    start repairs it. Accepted, because the alternative is every project on the
    host wedged for as long as the link exists.
13. A version name written by current ccc appears in the volume only when its
    bytes are all there: a copy interrupted partway leaves no published name,
    because nothing would ever replace a truncated file once it existed.
14. Nothing ccc publishes into the volume is a symlink. A link there names a
    path that exists only in the container that wrote it, so every other
    container reads a name pointing at nothing — and no later run can free it.
    ccc reads its own install through symlinks rather than copying them, so a
    data directory that reaches versions/ by a link publishes the same regular
    files as one that does not.
15. A start recovers from a volume entry that no version binary could be, and
    it recovers whether or not this container has an install of its own. That
    was not true once: the clearing lived where a container publishes its own
    install, so a container with nothing to adopt met a directory at the name
    the installer produces, downloaded the whole release, failed on it, and did
    the same on every start after — with the volume shared by every project on
    the host. A version is a regular file, so a directory, a fifo and a socket
    are all cleared alike; the rule is what a version is, not a list of what it
    is not.

    What licenses the clear is that the entry is holding a name the installer
    needs, so it is only ever applied to a name shaped like a version: three
    dot-separated numbers, optionally with the installer's own staging suffix —
    which is `.tmp.` followed by three more numbers, not `.tmp.` followed by
    anything. A directory of somebody's notes, or an export named for a
    date with dashes, is left where it is even though it starts with a digit:
    it blocks nothing, and reaching into it would destroy bytes on a volume
    every project shares for no reason at all. So is a version name carrying
    somebody else's suffix — `2.1.261.backup`, `1.0.0-my-notes` — since the
    installer's only suffix is its staging one. An export named for a date with
    dots — `2026.09.05` — is three dot-separated numbers and is treated as one.
    Something could separate it, a bound on the first component say, but that
    is a rule about what a claude version looks like, maintained here, and
    wrong the day it is not. The cost is recorded rather than traded away.
    Both recursive clears read that same rule — the one that
    frees a blocked name, and the one that runs while publishing, whose licence
    is that it is about to write that exact name and only ever writes
    versions. A link is taken under any name,
    because unlinking one destroys nothing — that asymmetry is the rule, not an
    oversight. A name holding a newline is left alone too, which is a limit of
    reading entries a line at a time rather than a decision.

    Two things stop the clear: a mount at that name, and a volume that will not
    allow the removal. Both are reported even though the start goes on to
    succeed or to install — a refusal that changes what the start will do, with
    nothing said, is how the wedge above stayed invisible. Whether a refusal
    for the second reason is clean depends on where it comes from: a volume
    mounted read-only refuses the first unlink and nothing is lost, while a
    directory ccc cannot remove for any other reason — an unwritable parent,
    one unwritable entry inside — has already lost whatever the delete reached
    before it stopped. Only the mount is checked before anything is touched at
    all; that is why it is the one checked first.

    Under a *version* name, clearing is safe where overwriting is not:
    `unlink` only unbinds the name, so a process already running that binary
    keeps its inode and cannot be interrupted the way an overwrite interrupts
    it with ETXTBSY. That argument does not extend to other names, and the
    rule below does not either.
    A directory under a version name is junk by construction — ccc refuses to
    create one, skips one when choosing a version, and refuses to seed from
    one — so nothing anyone runs is inside it and it is cleared whole, except
    where a user has put a mount there (behavior 18). That holds for a
    version-shaped name under `versions/`; the cautious rule below governs
    every other name, inside `versions/` and out. Refusing
    it instead left a container with a working local install failing on every
    start with no way back. Every other name is cleared only when it holds
    nothing, because ccc cannot tell its contents from what other projects are
    using, and the refusal says why it could not be cleared. A regular file
    already under a version name is left alone: it may be what another
    container is executing, and version names are content-addressed, so it is
    already correct.
16. ccc never publishes anything over `versions/` itself. That name holds every
    other project's binaries, and a file written there could not be undone by
    any later start: once the data directory is the symlink, the adoption path
    is never entered again. A container whose own layout puts something other
    than a directory at that name fails to start and says so.
17. An entry under the data directory that cannot be read — a link pointing at
    nothing, a socket, a file ccc has no permission for — fails the start
    rather than being published as-is, and the message names the entry. The
    local install is preserved, so the state is repairable by hand, but the
    volume is not left as it was: entries reached before the failing one are
    already published. Adoption is not atomic, and nothing here claims it is.
18. ccc refuses to delete through a mount point — at the data directory, at
    the launcher path, and at a version name it would otherwise clear — and
    says which one it refused. Deleting through a mount empties the other side
    and only then fails on the directory itself, which is a failure ccc cannot
    tell from an ordinary one, so nothing after the fact could report what was
    lost. At the launcher there was not even a failure to read: the removal
    went unchecked, the launcher was written inside the directory that
    survived, and the start reported success.
19. A start that could not put the launcher where it belongs fails rather than
    reporting success. Removing whatever occupies that path can fail — a mount,
    a read-only parent — and a symlink created inside the survivor is not a
    launcher anyone will run. ccc never places a mount
    there, but a user can, and `rm -rf` across that boundary empties the other
    side.
20. Setup fails rather than reporting success whenever something that needed
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
It does not prune with the launcher in the right shape either: measured, 2.1.259
was still there after updating to 2.1.261, after a second update, and after a
reinstall. So `versions/` grows, in a volume every project on the host shares,
and nothing here removes an old version — only entries that could never be one.
Recorded as the updater's stated behavior.

## Diagnosis

`ccc doctor` reports the launcher's shape, not only its version, because the
version alone is what looks fine in the broken state: a real version printed by
a real binary at the right path. What it checks is where the launcher resolves,
not merely whether it is a symlink — a symlink pointing outside `versions/` is
exactly as unmanaged as a plain copy. It reads either

    2.1.261 (Claude Code) (updatable, -> /home/ccc/.local/share/mise/.claude-data/versions/2.1.261)

or

    2.1.241 (Claude Code) (NOT updatable: launcher does not resolve into /home/ccc/.local/share/mise/.claude-data/versions, so claude update cannot replace it. Usually an ordinary ccc start repairs it)

Both lines name the same directory, resolved, because the data directory is
itself a symlink into the shared volume and the two spellings of one place read
as two places. When there is no `versions/` directory to resolve, the line
falls back to the unresolved path. Reaching that needs a launcher that answers
`--version` while the data directory does not exist — a claude installed by
something other than ccc. In a container where nothing has been set up there is
no launcher either, and the check prints no line at all. The warning says what
to do because an ordinary `ccc` start is
what repairs the states a user reaches by accident. It says "usually" because
one state that prints it — a launcher resolving through a link on a volume ccc
cannot write — is repaired by nothing, and a warning that promised otherwise
would be wrong precisely where it is permanent.

## Verification

- `src/__tests__/claude-launcher-layout.test.ts` executes the generated setup
  script against a temp directory and asserts the resulting layout: launcher is
  a symlink into `versions/`, newest version wins by version order, a flattened
  regular-file launcher is repaired, a legacy single-file cache is migrated, and
  shims / non-Claude binaries are rejected.
- Behavior 14 is pinned by a case where this container reaches versions/
  through a symlink: the volume's other versions must survive, the new one must
  publish, and nothing under the volume may be a symlink afterwards.
- Behavior 15 is pinned by three consecutive probe runs against a poisoned
  volume, all of which must succeed; by a non-empty junk directory under a
  version name, which must be cleared; by a non-empty directory at a name that
  is *not* a version, which must be refused with the shared file intact; and by
  a read-only volume, which must refuse. The middle two are what separate a
  clear from a delete, and widening either one is caught.
- Behavior 16 is pinned by a regular file at versions/ against a volume that
  holds the shared directory: the start must fail and the directory must
  survive.
- Behavior 18 is pinned at all three sites by a real bind mount, made inside a
  user namespace with `unshare -Umr`, which needs no privileges; the tests skip
  where the kernel or image will not provide one. An earlier version of this
  document claimed such a mount was unobtainable and used that to excuse
  leaving the guards untested. It was not true.
- Behavior 19 is pinned by a read-only parent at the launcher path, which needs
  no mount at all: the start must fail and must not print RESTORED, and no
  symlink may be left inside the directory that survived.
- Behavior 9 is pinned on each success path a start can take — nothing else
  needed, a reuse, and an install — at every place that removes a link: the
  pass that frees a blocked name, and both branches of the publishing pass, and for
  once-per-start reporting, the tools' own stderr staying out of it, and all
  four channels that print a name: the note, the reuse line, the error, and
  `ccc doctor`'s own output on both of its branches.
- ccc never runs a staging file a killed start left under `versions/`. There
  are two kinds and they are protected differently: ccc's own are hidden, and
  the selection does not look at hidden names; the installer's are not hidden
  and are skipped by name. Both are pinned, and so is collecting the
  installer's once it is old enough — it is the one that can be 215MB. Removals
  from `versions/` are announced except in two cases: where ccc is collecting
  its own garbage, which is that reaper and the `.seed.*` ones, and where the
  cautious rule succeeds, which takes only an entry holding no bytes at a name
  that could not be a version. That
  collector reads the same shape rule as the clears, so a name the installer
  would not write is not swept; ccc's own two are name-globs on a prefix only
  ccc writes. A directory wearing a staging name is not swept by any of them,
  but the clear takes it, because a staging name is version-shaped.
- Behavior 15's recovery is pinned with nothing to adopt as well as with a
  local install, for a directory and for a fifo, and its two refusals — a mount
  at that name, and a name that could not be cleared — are pinned separately,
  because the clear reached from this side is a second recursive delete and
  needs the same guard as the first. A refusal is also pinned where it reaches
  the user, not only where the container prints it: these refusals do not fail
  the start, so nothing carries them into an error, and a test on the script's
  own stderr cannot tell whether anybody is told.
- That neither recursive clear reaches a name the installer would not write is
  pinned: a hidden directory, a dash-dated export, somebody's notes and a
  dotted name that is not three numbers on the pass that frees a blocked name,
  and a plain non-version name on the publishing pass — where what is pinned is
  also that removing a link there is still announced, which narrowing that
  pass's licence had silently taken away. So is
  the volume root's half of the staging reaper, which collects a stale entry of
  any type where the `versions/` half takes only files. So is the mount guard on
  the check that runs first, before staging: guarding only the later one left
  the case it was written for — a link whose target is a mount — refusing every
  start on a message that was false.
- Behavior 12 is pinned three ways: a symlinked version alongside a real one
  (the real one is chosen and the link is gone); a link named for the version
  the installer produces (the name must be free afterwards, or INSTALL cannot
  do anything); and a link on a volume that cannot be written (it must still
  not be run, and must say why).
- Behavior 11 is pinned in part by a read-only volume that already holds the
  version: the start must succeed, because a version already there is left
  alone and so nothing needs writing. The test observes a refused write rather
  than a refused copy — it is what keeps the skip from being deleted, not a
  measurement of copying.
- Behaviors 1–4 as stated are host-tier: they need a real Docker daemon whose
  path resolution matches the caller's, which is not satisfiable from inside a
  container (see the header of `src/__tests__/e2e.test.ts`).
