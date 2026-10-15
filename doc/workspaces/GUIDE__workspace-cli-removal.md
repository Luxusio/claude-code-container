# Workspace CLI removal

`ccc @branch rm [-f|--force]` delegates from `src/index.ts` to the inward
workspace CLI removal application. The exported index helpers retain their
existing signatures and native default arguments as compatibility delegates.
The application owns removal order, session-claim refusal, inventory matching,
identity and duplicate checks, stop and plain removal decisions, result
presentation, recovery advice, and stranded-registration notice formatting.

`src/adapters/workspace-cli-container-runtime.ts` owns runtime argv, name-list
newline/trim decoding, process receipts and native stop/removal errors. The
application receives `listed`/`unavailable` inventory facts and finite synchronous
`stop(id)`/`remove(id)` effects. It selects a native runtime at the original lazy
listing and post-workspace-success batch sites. The public index delegates keep
the existing runner/CLI arguments and defaults outside this inward contract.

Other native ports supply the project-family critical section, raw session
claims, workspace ownership assertion, runtime readiness and managed identity,
canonical workspace removal and terminal escaping. Ignored synchronous effects
return `undefined` in inward contracts. No generic process runner or native
status/output classification crosses the container-removal port.

Workspace path and project identity are computed before the handler's catch.
Inside the real family guard, claims are queried even with force; ownership is
checked before runtime readiness. Container identities are captured before
workspace effects. Containers are removed only when the returned errors length
is exactly zero. A running identity is stopped first; failure prevents removal,
and removal uses plain `rm` with the captured identity object. Reading that
object's ID follows the original call timing, including another read after stop.
Container reports occur inside the guard. Workspace reports, partial-removal
advice, successful completion and stranded-registration reports occur after
release, inside the original catch boundary. Error reporting and exit preserve
raw exception behavior, including exceptions raised by reporting or exit itself.

Original-only controls exercised authentic source and genuine emitted main and
handler behavior, public helpers, real private session claims and shared locks,
result reference identity, callable selection, and strict source/declaration
contracts. Same-process lock contenders prove the private guard's exclusion;
allocated lower-effect fixtures do not establish cross-process native exclusion
or real host container/workspace teardown. Current extraction review and QA,
private current emission, host teardown, integration and shipping are separate
Root-owned gates; this guide does not claim they have passed.
