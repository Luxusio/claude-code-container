# Workspace admission and dispatch

`src/application/workspace/dispatch.ts` owns create/remove admission. The public
functions in `src/worktree.ts` compose native observations and the existing
unified or multi-repository applications. Creation validates the branch, resolves
the source and destination, observes/warns about an enclosing repository, then
selects by source Git metadata. It returns the selected callee's result directly.

Removal validates and resolves before checking destination existence and the
requested branch. Its admission check uses `options.force !== true`; this strict
check is separate from later force reads in the selected removal operation. An
unreachable repository causes a refusal assembled from one content observation
per path before identity capture or dispatch. Explicit force skips that inventory
veto. The original options object and captured workspace identity reach the
selected existing callee unchanged, and its mutable result is returned by identity.

The operation ports are explicit and do not supply ambient defaults. Construction
does not inspect port getters or perform effects. The facade retains native path
functions, branch runner and Git/filesystem ownership checks; admission does not
add guards, lock schemas, retries, or a filesystem abstraction. Existing unified
creation, multi-repository creation, removal, and worktree-addition policies remain
their canonical inward operations.

The dispatch tests compare the exact frozen public regions from worktree blob
`4b5d78e4f3878a9b02bbae18b0ff547df65c2c43` with the actual current facade under
synthetic native bindings. They cover effect order, callee/return/identity/options
references, strict force and changing getters, refusal observations, raw throws,
and boundary/type negatives. Private Git regressions exercise the real retained
native authority. The complete emitted facade and its core dependencies also
need root's extracted-package and materialized-installer consumer checks. Portable
source/build/package evidence does not certify every native platform or the full
architecture Goal.
