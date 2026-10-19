# Workspace CLI removal

`ccc @branch rm [-f|--force]` delegates from `src/index.ts` to the inward
workspace CLI removal application. The exported index helpers retain their
existing signatures and explicit runner/CLI injection. Their native defaults
use captured runtime authority instead of dispatching a bare executable name.
The application owns removal order, session-claim refusal, inventory matching,
identity and duplicate checks, stop and plain removal decisions, result
presentation, recovery advice, and stranded-registration notice formatting.

`src/adapters/workspace-cli-container-runtime.ts` owns runtime argv, name-list
newline/trim decoding, process receipts and native stop/removal errors. The
application receives `listed`/`unavailable` inventory facts and finite synchronous
`stop(id)`/`remove(id)` effects. It selects a native runtime at the original
listing and post-workspace-success batch sites. A default native removal object
captures one invocation and binds its executable, endpoint/configuration and
selector environment. Its operations retain that binding even when called later
outside the construction scope. Read-only capture precedes use of that default;
it never authorizes stop or removal before application checks. Explicit injected
runner/CLI arguments remain outside the inward contract. A conflicting CLI-only
override cannot replace an already captured runtime.

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

Verify the actual CLI through a private executable discovered by real native
capture, private context metadata and validated bound transport prefixes.
Unknown or bare runtime calls must not escape to a developer's engine. Cover
successful inventory and unavailable-inventory refusal before Git removal, plus
emitted default listing/stop/removal with ambient selectors changed after capture.
Keep explicit-runner and inward ordering controls. Fixture results do not
establish real host teardown, native platform or whole-architecture acceptance;
current review, QA, integration and shipping remain separate gates.
