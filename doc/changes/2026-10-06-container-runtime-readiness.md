# Container runtime readiness policy and native presentation

`src/application/container-runtime-readiness.ts` owns the readiness decision.
Its only ports are synchronous `isRunning(): boolean` and
`runtimeInfo(): { runtime: RuntimeName; flavor: string }`, declared in
`src/ports/container-runtime-readiness.ts`. A successful running observation
returns `{ kind: "ready" }` without an additional runtime-info observation.
Otherwise the application observes runtime info once and returns
`{ kind: "refused", runtime, repairCategory }`.

The finite repair categories are `docker-desktop`, `docker-service`,
`podman-machine`, `podman-rootless` and `podman-service`. Selection preserves
the established runtime-first policy: Docker uses its Desktop hint only for
`docker-desktop` flavor and otherwise uses the Docker service hint; Podman
uses machine or rootless hints for those flavors and otherwise uses the
Podman service hint. Unknown, arbitrary and cross-runtime flavor strings
retain these fallbacks. Runtime selection and capability policy remain in
the runtime boundary; readiness does not select or start an engine.

The native `src/docker.ts` facade keeps `ensureDockerRunning(): void` and
composes the application with the existing observations. On refusal it renders
exactly `Error: RUNTIME is not running.` followed by the existing hint for the
returned repair category, then calls `process.exit(1)`. The facade renders
facts; the application contains no terminal text, reporting or exit effects.
There are no lazy message suppliers or capture/descriptor/arity validation.
Synchronous observation, native reporting and exit faults propagate unchanged
and prevent later effects. Recovery commands are printed guidance only.

`isDockerRunning` retains the selected runtime's exact `info` argv, UTF-8
encoding, pipe stdio and status-zero readiness. When DEBUG is truthy, a failed
probe reports trimmed nonempty stderr before readiness refusal. Runtime fact
collection and caching belong to `container-runtime.ts`; the readiness
application has no cache or native transport knowledge. Existing index, clean
and lifecycle callers continue to use the same public wrapper.

Verification anchors are the readiness core, facade and strict type-contract
suites plus selected-runtime caller regressions. Core checks cover the ready
fast path, all five repair categories, arbitrary/cross-runtime fallbacks and
synchronous observation failures. Native facade checks cover exact messages,
exit code, probe arguments, DEBUG stderr and reporting/exit failures. Joint
compiler, build, packaging, independent review and CLI QA remain acceptance
gates; source changes alone do not establish those results.

## Known ceiling

Known ceiling: a readiness observation does not guarantee readiness for later
operations — upgrade when an approved runtime protocol supplies authority
across that interval. This extraction adds no atomicity guarantee or retry.

Known ceiling: portable fixtures cannot certify native macOS/Windows, real
Docker/Podman, rootless UID/SELinux or remote behavior — upgrade when retained
native acceptance gates execute against actual source and artifact hashes.
The unavailable native PowerShell parser check remains SKIP.

This readiness boundary does not certify whole-Goal completion. Remaining
composition, native acceptance and source-wide closure obligations retain
their separate evidence requirements.
