# Session ownership publication

The [guardian responsibility contract](../common/REQ__session-mutation-lock-lifetime.md#guardian-responsibility-and-orphan-recovery) defines durable cleanup authority. The publication application implements its generation and acknowledgement transitions. This separates those decisions from native construction without changing the guardian protocol, stored observation schema, or cleanup permissions.

Composition resolves the project/profile prefix, captures the receipt and runtime invocation, and supplies the observation store, guardian process-start observation and existing lifecycle guard. The application has no filesystem, process, environment or timer defaults. Store operations retain their native receipt and replacement checks; moving policy does not make a stored snapshot authoritative by itself.

Guardian registration precedes readiness. Each staged update advances the generation and replaces the pending intent before IPC sends it. Acknowledgement publishes only when the current pending update, generation and sequence all match; a stale acknowledgement returns false without writing. A cleanup-disabled or different-container update removes positive own-start responsibility. A matching cleanup-enabled update carries that responsibility into its new generation.

Startup intent invalidates an earlier acknowledgement without granting cleanup authority. A positive own-start publication records the exact container in a new generation. Startup retains the latest pending sequence, then the latest acknowledged sequence, or zero when neither exists. Native failures remain failures: a rejected write does not install its proposed snapshot, and a generation allocated before that write is not reused.

Every mutation uses the caller's already-held lifecycle guard. The publication application exposes the supplied asynchronous guard for callers that do not already hold it; its synchronous transitions never acquire another guard. Current-snapshot checks and the store's compare-before-publication checks remain in force. An unavailable, unreadable or replaced receipt cannot be treated as absent or authorize cleanup.

Verify the transition policy with consumed application behavior and actual native store/guardian callers, including stale acknowledgements, failed publication, own-start preservation/revocation and the held nonreentrant guard. Portable process fixtures do not establish native Docker/Podman shutdown or macOS/Windows acceptance.
