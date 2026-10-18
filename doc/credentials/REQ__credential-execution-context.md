# Credential paths use execution context

Production credential path selection depends on actual host/container context and the existing profile layout. VITEST, VITEST_* and their values do not change it. The credential application receives a live synchronous host/container callback; the native binding interprets the established CCC marker, exactly container=docker. Other marker values retain host behavior.

On the host, default, legacy and named paths continue through existing Claude/Codex profile helpers. For a falsy raw profile inside CCC, resolving a mount returns its literal containerDir, including a custom mount. A truthy raw profile delegates to existing helpers or host fallback, even when its text is default. Context changes between calls are observed.

Claude's helpers normalize omitted, empty and exact default profiles before selecting mounted paths. In a container they return the current home's .claude and .claude.json for normalized default; named profiles retain their existing profile directories. Codex's helpers retain the current home's .codex and .codex/config.toml inside a container for every profile, including named profiles. Whitespace in a profile is not trimmed by this change.

Public resolver/preparation signatures remain unchanged. Directory preparation retains private creation modes, nested Codex package directory handling, existing-mode preservation, sparse options for other tools and original failure propagation. A failed nested creation leaves the root already created; no retry, fallback, chmod or credential migration is introduced.

Tests that intend host behavior select host context explicitly and restore it. Native path regressions keep runner variables present and verify default/named/custom and helper file paths using synthetic homes. Strict consumed types reject asynchronous or invalid context callbacks. A genuine compiled public facade/helper probe and old-Source behavioral failures qualify this boundary without reading credential material.

## Known ceiling

A container marker selects established path policy; it is not authentication or evidence that a mount exists. This change does not prove credential copy/refresh, mount/UID/ACL authority, native engines/platforms, installed delivery, whole-source/reliability or full architecture Goal acceptance. Formal workflow attestation remains separate from actual scoped results when hooks are absent.
