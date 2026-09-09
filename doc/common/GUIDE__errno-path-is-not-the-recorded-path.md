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
   worktree to repair. The operator's own output is the demonstration: their
   NOTE named `C:\project\catchy-secrets--kjkim9-a78536cd7627` and stopped
   there — the walk gave up at the workspace component, two of five, dropping
   `\services\catchy-api\.git`. So `C:\project` did exist on that machine, and
   the recorded path still was not what got printed.

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
with `recordedGitPathFromErrorChain`, which deliberately never falls back to
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

Still open, and deliberately out of the scope that fixed this: the thrown
errors in the same file (`Nested Git repository escapes its parent
repository: ${candidatePath}` and its neighbours) interpolate the same
untrusted paths and are printed by the CLI. They predate this change.

## Third corollary — a repository you decline to manage is not one you may delete

Degrading an abort into a skip moves the candidate out of every set the abort
used to protect. `removeWorkspace` builds its `:(exclude,literal)` pathspecs
from the scan, so a skipped nested repository stopped being excluded and its
contents read as ordinary root content — which `ccc rm --force` then swept,
reporting success while destroying another repository's uncommitted work.
Measured A/B on the same fixture: before the skip, forced removal threw and the
work survived; after it, `{"removed":[...],"errors":[]}` and the work was gone.

`removeWorkspace` now collects skipped candidates from the scan and refuses,
naming them, **including under `--force`** — `--force` means "delete my
modified and untracked files", not "delete a repository you could not inspect".

The general lesson: when you turn a failure into a skip, enumerate what the
failure was protecting. The refusals themselves stayed intact here; the set
they policed silently shrank.

## Testing note

A test that asserts on a path is only as portable as the ancestors that path
assumes. Either assert on a value the fixture itself wrote (as the regression
test now does), or run it once against a root that does not exist to prove the
assertion does not depend on the host. The second check takes one edit and
would have caught this immediately.

## Related

- `src/worktree.ts` — `gitLinkKind`, `recordedGitPathFromErrorChain`,
  `warnUnreachableNestedRepository`
- `src/__tests__/worktree.test.ts` — "skips a nested repository whose Git
  metadata names an unreachable path"
- `doc/harness/tasks/TASK__worktree-nested-gitlink-unreachable-path/PLAN.md`
