# GUIDE — an errno's `path` is not the path you asked for

**Status:** current
**Applies to:** any code in `src/` that reports a filesystem failure to an
operator, or asserts on one in a test.

## The trap

`fs.realpathSync` (and `lstatSync` on a multi-component path) walks the path
component by component and reports **the first component that is missing** as
`error.path`. It is not the path passed in.

    /project/definitely-missing-abc/services/x/.git  =>  ENOENT  path "/project/definitely-missing-abc"
    /nosuchroot-zzz/services/x/.git                  =>  ENOENT  path "/nosuchroot-zzz"

Both calls asked about a `.git` file four components deep. Neither error names
it. Which value comes back depends on **which ancestors happen to exist on the
machine running the call** — so the same input produces different output on a
developer's container, on a Windows host, and on a CI runner.

## How it bit us

`warnUnreachableNestedRepository` in `src/worktree.ts` printed a NOTE saying
*"its Git metadata names 'X', which does not exist here"* and filled `X` from
`error.path`. Two failures followed from one mistake:

1. **The operator got the wrong path.** For a worktree registered inside the
   container, the recorded path is
   `/project/<workspace>-<hash>/services/<repo>/.git`. On a host without
   `C:\project` the NOTE collapses to `C:\project` — dropping the
   workspace-and-hash, which is the only part that tells the operator *which*
   worktree to repair. It printed the full path on the reporting operator's
   machine purely because `C:\project` happened to exist there.

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
`terminalSafe` now escapes `\p{Cc}` and `\p{Cf}` to `\uXXXX` — escaped rather
than stripped, since the operator still has to identify the directory. Note
that `\p{Cc}` alone is not enough: the bidi overrides are `\p{Cf}`, and a
mutation dropping `\p{Cf}` is caught by the regression test.

Still open, and deliberately out of the scope that fixed this: the thrown
errors in the same file (`Nested Git repository escapes its parent
repository: ${candidatePath}` and its neighbours) interpolate the same
untrusted paths and are printed by the CLI. They predate this change.

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
