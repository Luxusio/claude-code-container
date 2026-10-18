# Host credential path and directory preparation

The existing credential application owns resolver and directory preparation through eight required synchronous capabilities and explicit Codex package-path data. Public Docker resolver/preparation signatures remain unchanged. Construction performs no native observation or filesystem operation.

Supply a live executionContext callback returning host or container. The native binding translates the established CCC marker, exactly container=docker; application policy has no process environment or test-runner dependency. Both the binding and native utility helpers ignore VITEST/VITEST_* when selecting credential paths. The [execution-context requirement](REQ__credential-execution-context.md) defines the observable host/container and profile behavior.

Retain existing profile helpers and their normalization. The application's raw profile truthiness determines whether it delegates; named Codex profiles stay mounted inside a container while named Claude profiles retain profile-specific paths. Do not reconstruct those paths in the application, cache helper/context results or introduce trimming.

Preparation resolves first, creates private Claude/Codex roots and nested Codex packages with mode0700 creation options, and leaves existing modes intact. Other tool roots use recursive creation without an explicit mode. Callback, getter and filesystem failures propagate; a failed nested creation leaves its already-created root. No retry, fallback or permission reset is implied.

Host-oriented tests select host context explicitly and restore it. Native runner-independence tests keep runner variables present and use synthetic homes; they cover default/named/custom resolution, helper directory/file paths, directory modes and partial failure. Strict consumers prove the semantic callback remains required and synchronous. A genuine compiled facade/helper probe supplies production-path evidence; source-body snapshots and verifier tests are unnecessary.

## Known ceiling

Path preparation does not certify credential copy/refresh, profile migration, mount/UID/ACL authority, installed payloads or native runtime/platform acceptance. A container marker is path-policy input, not proof of mount ownership. Whole-source/reliability/full Goal and formal acceptance remain separate.
