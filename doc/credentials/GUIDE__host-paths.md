# Host credential path and directory preparation

The application owns both complete resolver/preparation operations through nine
required synchronous ports and explicit Codex package container-path data.
Canonical CredentialMount objects remain mutable and are passed unchanged.
Docker retains the two public names, signatures and arity2, with live native
closures for environment, existing profile helpers, home, host paths, mkdir and
POSIX package paths. Construction observes none of those effects.

Keep the resolver's profile/container/single-VITEST truthiness short circuit.
Truthy profile skips application environment ports only: native utils helpers
have distinct mounted/profile rules and may still read environment. Claude
normalizes profile before its mounted guard; Codex can select mounted mode for
named profiles. Retain those dynamic helpers rather than caching their results.

Read mount.containerDir at each original site; do not snapshot changing getters.
Fallback observes home before hostDir and join. Preparation resolves first,
re-evaluates private ownership comparisons, creates the root, computes POSIX
package parent before the next containerDir read, then conditionally evaluates
basename/host join and creates nested packages. Other tools get recursive-only
options with mode absent; private roots/packages get mode0700. These are creation
options, not chmod/reset of an existing directory's permissions.

Raw callback/getter failures propagate without catch, warning, retry or rollback.
Nested failure leaves the already-created root. The native mkdir port ignores
Node's recursive mkdir return; public operations return the selected host path
only after all required effects succeed. Startup callers retain their subsequent
containerDir getter reads when publishing mount DTOs.

Verify ordered getter/env/profile/path/mkdir faults, canonical mutable source and
emitted contracts, actual synthetic-home/profile directory creation and modes,
retained startup/catalog/package cases and both real shipped payloads. CLI
help/version is separate from module proof. Never read real credential material.

## Known ceiling

This is directory preparation, not credential copy/refresh, profile migration,
mount ownership, runtime startup or full M11 acceptance. Existing inability to
prepare real-host package directories from Docker-outside-Docker remains.
Unavailable native OS/mode/link capabilities remain unverified.
