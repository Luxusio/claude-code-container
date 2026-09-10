# GUIDE — an errno's `path` is not the path you asked for

**Status:** current
**Applies to:** any code in `src/` that reports a filesystem failure to an
operator, or asserts on one in a test.

## The trap

`fs.realpathSync` walks the path component by component in its JS
implementation, and reports **the first component that is missing** as
`error.path`. It is not the path passed in.

This is specific to `realpathSync`. Measured on Node v22.23.1, all four given
the same missing four-component path:

    realpathSync   ENOENT  path "/nosuchroot-zzz"
    lstatSync      ENOENT  path "/nosuchroot-zzz/services/x/.git"
    statSync       ENOENT  path "/nosuchroot-zzz/services/x/.git"
    readFileSync   ENOENT  path "/nosuchroot-zzz/services/x/.git"

So `lstat`, `stat` and `readFile` report the path you asked about and their
`error.path` is exact. Only `realpathSync` truncates, and what it truncates to
depends on **which ancestors happen to exist on the machine running the call**
— so the same input yields different output on a developer's container, on a
Windows host, and on a CI runner. Do not generalise the warning to every
syscall: distrusting an exact value is its own kind of wrong.

## How it bit us

`warnUnreachableNestedRepository` in `src/worktree.ts` printed a NOTE saying
*"its Git metadata names 'X', which does not exist here"* and filled `X` from
`error.path`. Two failures followed from one mistake:

1. **The operator got the wrong path.** For a worktree registered inside the
   container, the recorded path is
   `/project/<workspace>-<hash>/services/<repo>/.git`. On a host without
   `C:\project` the NOTE collapses to `C:\project` — dropping the
   workspace-and-hash, which is the only part that tells the operator *which*
   worktree to repair. The operator's own output is the demonstration — from
   the abort that preceded the NOTE, whose cause line read `ENOENT: lstat
   'C:\project\catchy-secrets--kjkim9-a78536cd7627'`. The walk gave up at the
   workspace component, two of five, dropping `\services\catchy-api\.git`. So
   `C:\project` did exist on that machine, and the recorded path still was not
   the value that surfaced.

2. **The regression test passed only inside a ccc container.** It asserted
   `toContain("/project/unreachable-workspace-abc123")`, which holds because
   `/project` is this container's mount root. CI runs the `test` job on
   `ubuntu-latest`, which has no `/project`, so `error.path` would have been
   `"/project"` and the assertion would have failed on the next push. A green
   local run proved nothing about the machine that would actually run it.

Note that the two failures are the same defect wearing different clothes. The
test could not catch the NOTE bug because both read the same wrong value.

## The rule

When you need to tell someone *what a file recorded*, carry that string from
the place that read it. Do not recover it from the error afterwards.

    // at the failure site, where registeredGitFile is still in scope
    throw Object.assign(
        new Error("worktree registration names a path that cannot be resolved here", { cause: error }),
        { recordedGitPath: registeredGitFile },
    );

Then read `recordedGitPath` off the cause chain. `src/worktree.ts` does this
with `unreachableRecordedGitPath`, which deliberately never falls back to
`error.path` — a wrong-but-plausible path is worse than none, because the
operator cannot tell it is wrong.

## Corollary — diagnoses need their evidence

The same NOTE appended *"a worktree registered inside the container records a
container path, which the host cannot resolve, and the reverse"* to **every**
skip. That sentence is a diagnosis, and it was printed for causes that had
nothing to do with the mount boundary — sending someone with merely malformed
submodule metadata to look for a mount problem they did not have. Print a
diagnosis only on the branch where its evidence exists; otherwise state the
errno and stop.

## Second corollary — the values in an operator message are attacker-controlled

The same NOTE interpolates two repository-controlled strings. Submodule names
reach it from `git ls-files -z`, which is **unquoted by design**, and the
recorded path is the content of a file inside `.git`. Measured end to end: an
ESC sequence, a BEL and U+202E placed in a submodule name all arrived at the
terminal raw.

That matters more than usual here, because the NOTE exists to tell an operator
*which directory ccc declined to manage*. A right-to-left override reverses the
path they are about to act on; an ESC sequence can rewrite the line entirely.
`terminalSafe` quotes with `JSON.stringify` and then escapes what that leaves
raw — escaped rather than stripped, since the operator still has to identify
the directory. Three separate things had to be right, and escaping control
characters was only the first:

- `\p{Cc}` alone is not enough. The bidi overrides are `\p{Cf}`, and
  `JSON.stringify` does not touch them, nor C1.
- **The delimiter has to be escaped too.** Before `JSON.stringify` was added,
  a name could close the field and open a plausible replacement — `api":
  names "/innocent/path` reads as a second field of the message itself.
- **So does the escape character.** Without escaping the backslash, a
  directory literally *named* `svc\u001b[31m` rendered identically to a real
  ESC that this code had escaped. The operator could not tell which had
  happened — the escaping was honest and unreadable at the same time.

Worth knowing which inputs actually reach it: a tracked path containing `"` is
already refused upstream by `trackedGitlinkPaths`. The **recorded path is the
one with no validation at all** — it is the content of a file — so that is
where the forgery test drives, and where any similar test should.

To be clear about ownership: the forgeable field was **new code**, introduced
by the NOTE this task added, not inherited. What *is* inherited, and still
open: the thrown errors in the same file (`Nested Git repository escapes its
parent repository: ${candidatePath}` and its neighbours) interpolate the same
untrusted paths and are printed by the CLI.

## Third corollary — a repository you decline to manage is not one you may delete

Degrading an abort into a skip moves the candidate out of every set the abort
used to protect. `removeWorkspace` builds its `:(exclude,literal)` pathspecs
from the scan, so a skipped nested repository stopped being excluded and its
contents read as ordinary root content — which `ccc rm --force` then swept,
reporting success while destroying another repository's uncommitted work.
Measured A/B on the same fixture: before the skip, forced removal threw and the
work survived; after it, `{"removed":[...],"errors":[]}` and the work was gone.

`removeWorkspace` collects skipped candidates from the scan and refuses,
naming them — **without `--force`.** The rule is that unmanaged means ccc will
not delete it *silently*, not that ccc will not delete it.

An earlier version of this guard held under `--force` too, on the argument that
`--force` means "delete my modified and untracked files" and not "delete a
repository you could not inspect". That argument was this file's, and the
repository owner overruled it: a command that removes a workspace removes what
is inside it, and `--force` is where the operator says they know. Holding the
veto there left `ccc rm -f` with no way through on a workspace the owner wanted
gone — including one produced by a failed repair, which is how it was found.

So the whole safety story is the no-force path: it must name the repository, it
must say what is at that path, and it must name `-f` as the way through.
Silently deleting is the failure; refusing to delete is a different failure, and
between the two the operator only ever gets one chance to be told.

Do not mistake an incidental throw for a backstop. Removing the guard does not
lose data in *every* shape: where the source-side copy is an ordinary clone and
only the workspace-side one is a registered worktree, a later `gitLinkKind`
call resolves far enough to throw before anything is deleted. That is a
consequence of topology, not a designed second line of defence, and it is
absent from the shape the operator actually hit — there, removing the guard
destroys the work. Two people measured this and got opposite answers from
different fixtures; the guard is what makes the outcome not depend on which.

**Know the guard's reach, and do not overstate it.** It runs
`scanUnifiedNestedRepositories(wsPath, …)`, so it covers the unified removal
path. In multi-repo mode `wsPath` is not a Git repository, that scan yields no
candidates at all, and the guard protects nothing — the below-top-level
deletion there is still open, and is pre-existing rather than caused by the
skip. Counting the *call sites* that delete is not the same as checking which
of them the guard's scan can actually see; the first reading of this said both
modes were covered, and only measuring showed otherwise.

The general lesson: when you turn a failure into a skip, enumerate what the
failure was protecting. The refusals themselves stayed intact here; the set
they policed silently shrank.

## Fourth corollary — key a skip on what it is *for*, not on what it *looks like*

The first version of the skip keyed on "an ENOENT/ENOTDIR appears anywhere in
the error's cause chain". That is a description of the symptom, and it was much
wider than the situation the skip exists for. `gitLinkKind` establishes
ownership with bare filesystem calls, so an errno can be raised *while a
judgement is still being made*, before the judgement can run. Measured: a
`commondir` naming a repository with no `worktrees` directory makes
`lstat(managementRootPath)` throw at exactly the point where `worktree
management entry is outside its source repository` was about to be decided —
turning an ownership refusal into a silent skip.

The refusal was intact and unreachable, which is the worst combination: it
reads as safe in the source and never runs.

The fix is to key on evidence attached at the one site that knows what the
failure is about. `recordedGitPath` is set only where the registration
back-pointer fails to resolve, so requiring it — *and* an errno meaning
absence, so a symlink loop still aborts — makes the skip exactly as wide as
the portability case. It also made the NOTE's "could not be inspected" branch
unreachable, and it was deleted rather than left as untested prose.

## Fifth corollary — an accurate diagnosis is not automatically a place to abort

`Tracked submodule repository is not initialized` is true when it fires. It was
still wrong to abort on, because it fired on the path that OPENS an existing
workspace, and `ccc` was then the only tool that could have repaired the state
it was complaining about. The operator hit it three times in one session and
every recovery was a `Move-Item` dictated over chat.

The distinction that matters is not skip-versus-abort, it is **create versus
open**:

- Creating a workspace whose branch tracks a submodule that is not initialized
  produces a half checkout the operator would not notice. Keep aborting. There
  is a test that pins this on purpose.
- Opening a workspace that already exists cannot make it any worse, and
  refusing removes the only way back. Skip, and say so.

Ask, of any abort: does the operator have a way out that does not require
somebody else to dictate shell commands? If the answer is no and the state is
repairable, the abort is in the wrong place. Note the state here is also
perfectly ordinary — clone without `--recursive`, or interrupt a `submodule
update` — so this was never only about a bug upstream of it.

**Count what you were asked about, not what is easy to count.** Asked whether
the relaxation flag was absent from every scan that can run during CREATION, the
answer given was "all four flagged scans target the workspace, so none is
creation-reachable". That answers a different question: `src/index.ts:1172` runs
on both arms of the create/open branch, so three of the flagged scans *are*
creation-reachable — they are simply reached with a workspace that already
exists. The half checkout is prevented somewhere else entirely
(`assertWorkspaceOwnership`'s source loop, and `repairWorkspace`'s scan). Twice
in one change the substitute question was the tempting one: callers-instead-of-
control-flow, then target-instead-of-reachability.

**One relaxed call is almost never enough, and a unit test will not tell you.**
Six sites had to move in total. Four sit on the journey a plain `ccc` inside the
workspace takes: the workspace scan `detectWorktreeWorkspaceBranch` reaches
through `branchRepositories`, the tracked-gitlink walk in
`trackedWorktreeGitFiles`, and — both inside `workspaceWorktreeGitFiles` — its
own scan and its metadata check. The other two are the workspace scan in
`assertWorkspaceOwnership`, on the `ccc @<branch>` path, and the removal guard's
own scan.
Relaxing only the first made things *worse* — detection now succeeded, printed
a NOTE promising the workspace would open, and then died in a later function
with a message naming neither the submodule nor a remedy. A test that stopped
at `detectWorktreeWorkspaceBranch` passed the whole time. Drive the test
through the call the caller actually makes next, not the one you changed.

**And check the remedy you print by running it.** The first version of this
NOTE told the operator to run `git submodule update --init`. Measured, that
clones a plain submodule where a linked worktree belongs and leaves a workspace
ccc cannot open at all — the advice was worse than the problem. The remedy that
works is running `ccc` again, which repairs the worktree itself.

Where the line was NOT moved: `branchRepositories` and `assertWorkspaceOwnership`
each scan TWICE — the workspace, which is relaxed, and the source, which is not.
Both names therefore appear on both lists above, and the source scans still
abort. They are create-time
protection — `assertWorkspaceBranch` runs at `src/index.ts:1172`, which sits
after the create/open branch in `prepareWorktreeUnlocked` and therefore executes
on both arms, so `branchRepositories` is reached on the creation path.

An earlier version of this paragraph asserted the opposite, on the strength of
listing `branchRepositories`' two callers and stopping there. Listing callers is
not tracing control flow: the call that mattered was several frames up and
unconditional after an `if`/`else`. The claim was written into this file as
verified. **A "who calls this" grep answers a different question than "can this
run during X", and only the second one licenses moving a guard.**

The residue: a source-side deinit still reproduces this trap, and blocks opening
as well as creating. That is recorded rather than fixed, because relaxing
creation-time protection is a separate decision needing its own measurement.

And the same pairing applies as in the third corollary: what is skipped is
registered with the removal guard, so it is not deleted without the operator
being told. Told, not stopped — `--force` goes through.
The implemented condition is presence, not content: everything except an absent
path is registered. Absent is excluded because refusing to delete what is
already gone hands the operator a remedy they cannot perform. An EMPTY directory
*is* registered even though it holds nothing — `rmdir` is a remedy they can
perform, and without the guard that shape died later with an unrelated message
about a race that had not happened.

A directory that cannot be READ registers too. The first version of that check
caught every error and returned "nothing here", which is the
errno-swallows-a-judgement mistake yet again, in the one function whose job is
to decide whether there is anything worth protecting. Not knowing is the
strongest reason to refuse.

The decision and the sentence explaining it come from one observation of the
path (`pathContent`). Two functions each reading it separately left room for the
refusal to be decided from one read and described from another, and produced a
message claiming "a nested Git repository ccc could not inspect" for an empty
directory — where there is no repository, and the read that recognised the state
succeeded. That is the first corollary above, broken by a branch added to serve
this one.

## Sixth corollary — the boundary also leaves the branch held

Reading the recorded path correctly was only half of it. The source repository
is the same directory on both sides of the container mount, so it keeps ONE
worktree registration, recorded against whichever path the side that created it
could see. That registration still holds the branch. Git says so plainly:

```
worktree /project/catchy-secrets-415bfb4fdb76/services/catchy-api
branch refs/heads/feature-x
prunable gitdir file points to non-existent location

$ git worktree add <dest> feature-x
fatal: 'feature-x' is already used by worktree at '/project/.../services/catchy-api'
```

So `ccc` printed a NOTE that read the path correctly, offered the repair,
and the repair failed — every time, with `failed to fix (content unchanged)`,
which names no cause.

**The first version of this corollary got the safety argument wrong, and it is
worth keeping the wrong version visible.** It said: git refuses two worktrees on
one branch, so at most one registration holds it, and one whose path does not
resolve cannot be a live checkout on this machine. Both halves are false.

- `git worktree add --force` creates a second worktree on the same branch.
  Measured against git 2.43.0. So "at most one holder" is not an invariant, and
  a second holder is not evidence of corruption — it is evidence that the code
  cannot tell which entry to displace, which is still a reason to refuse, but a
  different one.
- **"Cannot be reached here" is not "is not a live checkout."** An unmounted
  removable volume, a network share that is offline, an autofs mount not yet
  triggered, a path behind a symlink that currently dangles — every one answers
  ENOENT exactly the way a container path does. A review reproduced the
  consequence: the operator's staged index, HEAD, per-worktree refs and reflog
  all live in the management directory being displaced, and deleting it
  destroyed them, took `git worktree lock` with them, and freed the name so the
  new worktree resolved to the same gitdir as the live checkout — two working
  trees sharing one index, a state git never produces.

What replaced it, and why each part is defensible on its own:

- **Honour `git worktree lock`.** Git's manual names this exact case: "a linked
  worktree stored on a portable device or network share which is not always
  mounted". The contract ccc can defend is that it does what `git worktree
  prune` would do to an unlocked prunable entry, and stops where prune stops.
- **Displace, but never delete.** The entry is moved into a quarantine and left
  there, and the operator is told the path. What we cannot reach, we cannot
  prove is dead.
- **An error that is not a clean absence counts as reachable.** EACCES means the
  answer is unavailable, not that the path is gone. This is the load-bearing
  claim in a destructive decision, so it has its own test — a mutation making
  every error read as "absent" passed the entire suite before that test existed.

Two more things follow, and the second is the expensive one:

1. **A failed repair must carry the reason.** git wrote it; discarding it cost
   a round trip through a screenshot to find out that a registration was the
   obstacle.
2. **Relax at a choke point, not at the site that happens to throw next.**
   This abort lived in six places. Each fix removed the one the operator hit,
   and the next attempt died one call further along with a different message —
   `Tracked submodule repository is not initialized`, then `Unable to inspect
   tracked Git link worktree`, then `Managed nested worktree ownership could
   not be verified`, then `Required worktree metadata is invalid`. The sixth
   was fixed by filtering unreachable entries out of
   `workspaceWorktreeGitFiles`' return value, so every consumer downstream may
   now assume what it had each been checking for itself. The workspace's own
   root `.git` stays exempt, and a review measured a seventh site behind that
   exemption: a workspace created *entirely* inside the container still aborts
   with `Required worktree metadata is invalid`. Recorded, not fixed — deciding
   what to mount for a workspace whose own registration is unportable is a
   different question from skipping a nested one.

## Seventh corollary — a refusal that starts deleting is worse than a refusal

Removing a veto moves a path from "returns early" into "begins a destructive
sequence", and those are not the same risk. `ccc rm -f` was made to override an
unmanaged-path refusal. On a nested directory with **no read bit**, the
sequence it then entered could not finish — `rm -rf` cannot enumerate a
directory it cannot list — but it got through the workspace root first. A
review measured the outcome: `.git` gone, tracked files gone, the operator's
uncommitted work in the root gone, `errors` reporting a failure so the run
looked like a no-op, and ccc afterwards refusing to touch the remains at all.
The refusal it replaced had returned before anything was quarantined.

So the rule is not "force overrides refusals". It is:

> Force overrides refusals that are **policy**. It does not override the ones
> that are **arithmetic** — where the operation provably cannot complete, and
> the only thing starting it can do is destroy what it passes on the way.

The unreadable case is arithmetic, and refusing it under `-f` says so:
`ccc cannot delete a directory it cannot read: <path> — make it readable, then
re-run with -f`. That remedy works; the previous behaviour offered none.

An unreadable nested directory is not exotic in this codebase's own domain — a
container/host uid mismatch produces one, which is a thing ccc exists to manage.

## The pattern behind three of these

Three separate defects here were the same mistake: **a list of remembered
characters or symptoms standing in for a category.** The redaction that missed
U+2028; the escaping that covered `Cc`/`Cf` and missed `Zl`/`Zp`; the skip
keyed on errnos rather than on what the errno was about. Each time the list was
right about everything on it. Prefer the category — a Unicode property, a
marker attached at the deciding site — and assert its premise.

## Testing note

A test that asserts on a path is only as portable as the ancestors that path
assumes. Either assert on a value the fixture itself wrote (as the regression
test now does), or run it once against a root that does not exist to prove the
assertion does not depend on the host. The second check takes one edit and
would have caught this immediately.

## Related

- `src/worktree.ts` — `gitLinkKind` (the throw site that attaches
  `recordedGitPath`), `unreachableRecordedGitPath` (the two-condition key),
  `warnUnreachableNestedRepository`, `terminalSafe`
- `src/__tests__/worktree.test.ts` — "skips a nested repository whose Git
  metadata names an unreachable path"
- `doc/harness/tasks/TASK__worktree-nested-gitlink-unreachable-path/PLAN.md`
- `src/worktree.ts` — `unreachableRegistrationPathHoldingBranch` (which
  registration may be displaced), `recordedGitPathUnreachableHere` (the single
  reader the choke-point filter asks), `warnWorktreeRepairFailure`
- `src/__tests__/worktree.test.ts` — "a worktree registered on the other side
  of the container boundary"
- `doc/harness/tasks/TASK__worktree-repair-past-a-container-registration/PLAN.md`
