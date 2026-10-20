# Remote execution owns cancellation and returns completion

The remote application returns explicit execution, sync and termination results
instead of exiting or signalling its host process. Each invocation owns its
pending reader/timer, retains its first interruption and prevents queued work
from dispatching after cancellation. Native questions serialize their shared
console input, route terminal Ctrl+C to the owning invocation, and settle EOF
without leaving a later prompt pending. An SSH error is retained while the child
is joined through close. Exact-token release and other cleanup failures remain
visible without replacing the primary failure; only the native facade projects
CLI errors, status and signals. Existing target identity, sync selection, busy
peer guards and terminal restoration remain in effect. The derived behavior is
specified in [remote execution completion](../remote/REQ__execution-completion.md).

## Known ceiling

Existing synchronous commands and guard acquisition deadlines limit cancellation
responsiveness. No live SSH/Mutagen transport, engine/provider or actual Mac
qualification is inferred from portable fixtures or a Windows build.
