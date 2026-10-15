# Selected runtime capabilities and cache

`src/container-runtime.ts` owns the public synchronous facade, explicit override and process-local cache. It returns the same mutable cached object before checking environment. A truthy `VITEST` flag with no explicit override publishes the fixed Docker stub. Otherwise it selects the runtime and publishes only after the application returns a complete result. Uncaught collection faults leave the cache empty so the next access retries. Environment changes do not invalidate a cache. Valid explicit overrides do; null/empty overrides are no-ops and invalid overrides fail before mutation. Existing preload/reset hooks remain compatible.

`src/application/runtime-capabilities.ts` collects uncached semantic observations through `src/ports/runtime-capabilities.ts` and derives capabilities using the domain policy. `src/adapters/runtime-capabilities.ts` owns native commands and decoding: version is a string or null, Docker operating system is unavailable/desktop/other, Podman remote and Docker rootless security are booleans, and Podman rootless is true/false/unknown. The native adapter retains existing argv, status handling, version matching, Docker JSON-array security detection and malformed-JSON text fallback. Failed or empty Docker OS evidence is unavailable; successful nonempty non-Desktop evidence is other.

Desktop capability requires Desktop daemon evidence and a local selected endpoint, or the exact Windows Desktop Linux-engine pipe when OS evidence is unavailable. Successful other OS evidence defeats pipe fallback. The existing endpoint resolver retains authority: raw `DOCKER_CONTEXT` takes priority over trimmed `DOCKER_HOST`, contexts are passed after `--`, and failed context selection does not fall back to host. Remote Docker keeps the legacy `docker-desktop` flavor without granting Desktop capability.

Real collection retains selection, version, Desktop, remote, rootless, flavor and socket order. Only the selected provider is probed. Non-Linux hosts retain remote=true/rootless=false defaults. Linux Docker without Desktop capability checks WSL distribution truthiness before observing mirrored loopback. Podman rootless unknown falls back to effective UID and ignores UID faults; explicit true/false skips that fallback. Socket resolution retains runtime socket override, Docker default, rootless Podman XDG path then UID path, and rootful Podman default. Socket UID faults propagate. SELinux and current-container mount caches remain separate and unchanged.

Public types and signatures, `runtimeCli`, `isContainerHostRemote`, `getHostInternalAlias` and `formatRuntimeSummary` remain compatible. Docker lifecycle/readiness/mount/capability consumers, container identity, setup, doctor, CLI commands and Codex/lab/session users keep importing this facade. No TTL, frozen object, asynchronous probe, restart action or resource policy is introduced.

Proof owners are the three runtime-capabilities architecture core/facade/type-contract files, with existing runtime, selection and endpoint caller regressions. Core fixtures supply semantic observations; facade fixtures exercise actual native decoding and public cache behavior with native effects mocked. Root owns independent code/security/QA, strict compilation, whole affected suites, shipping and compiled/extracted public entrypoint qualification. Portable mocks do not certify real Docker/Podman/Colima or Windows/macOS acceptance. Full Goal and separate native/reliability/formal acceptance remain outstanding.

Mount admission is a separate application in
`src/application/container-mount-verification.ts`. It consumes normalized mount
shape and source facts through `src/ports/container-mount-verification.ts`.
`src/adapters/container-mount-observations.ts` owns inspect/tmpfs decoding, native
path aliases, filesystem identities and challenge files, WSL proofs and daemon
observations. `docker.ts` supplies the selected target, image lookup and bounded
retry, and retains the public native helper exports.

Stopped admission checks general path equivalence without target exec. Live
custom Docker sockets require the configured literal source and daemon proof;
a matching Desktop proxy still needs daemon proof. Strict and safe-defer policy,
final-attempt decisions, fresh container ID/label rechecks and cleanup remain in
the application. Proof challenges are scoped to one verification and removed in
finally; existing captured-ID lifecycle compensation remains unchanged. The
mount cutover requires its own combined review/QA; runtime capability acceptance
does not imply that this follow-up or native platform checks have passed.
