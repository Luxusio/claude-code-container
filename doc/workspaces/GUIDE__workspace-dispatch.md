# Workspace admission and dispatch

`src/application/workspace/dispatch.ts` owns create/remove admission. The public
functions in `src/worktree.ts` compose native observations and the existing
unified or multi-repository applications. Creation validates the branch, resolves
the source and destination, observes/warns about an enclosing repository, then
selects by source Git metadata. It returns the selected callee's result directly.

Removal validates and resolves before checking destination existence and the
requested branch. Its admission check uses `options.force !== true`; this strict
check is separate from later force reads in the selected removal operation. An
unreachable repository produces an `unmanaged` outcome with one opaque content
observation per path in discovery order, before identity capture or dispatch.
Explicit force skips that inventory veto. An absent destination produces a
`missing` outcome carrying its destination path. Otherwise the original options
object and captured workspace identity reach the selected existing callee
unchanged, and a `dispatched` outcome carries its opaque result by identity.

The native facade converts these finite outcomes to public behavior: `missing`
throws the existing path-specific not-found error, `unmanaged` returns no removals
and formats each error with the existing terminal-safe `unmanagedPathRefusal`,
and `dispatched` returns the selected result unchanged. Dispatch neither builds
the public removal result nor formats terminal prose. Observation and callee
exceptions propagate without interception.

The operation ports are explicit and do not supply ambient defaults. The facade
retains native path functions, branch runner and Git/filesystem ownership checks; admission does not
add guards, lock schemas, retries, or a filesystem abstraction. Existing unified
creation, multi-repository creation, removal, and worktree-addition policies remain
their canonical inward operations.

The semantic dispatch suite checks validation before downstream observations or
effects, creation warning/selection order, both removal selections, identity and
options forwarding, strict force admission, refusal path/content observations,
and representative failure propagation. Missing destinations and wrong requested
branches stop before inventory, identity capture or selected removal. The
compile-only `workspace-dispatch-contracts.ts` fixture checks consumed finite
outcome narrowing, opaque selected results, required capabilities and synchronous
observations through the existing architecture TypeScript include.

The whole native worktree suite exercises retained branch and ownership refusals,
dirty-content preservation, stale identity, concurrency and partial results.
Acceptance requires a fresh full build and actual compiled and extracted npm
worktree entry scenarios in private Git roots for both modes and their refusals.
Existing package-consumer, Unix shipping/materialized-installer and compiled CLI
checks cover the emitted facade and dependencies. These checks must qualify the
final runtime snapshot; older build evidence does not qualify a changed seam.
Portable source/build/package evidence does not certify every native platform or
complete the original architecture Goal's remaining native and operation gates.
