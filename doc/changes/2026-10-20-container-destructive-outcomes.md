# Explicit stop/remove cleanup outcomes

Explicit container stop/remove now returns a reusable application result with the captured initial target, bounded device cleanup counts and separate stop/removal command facts. A returned failed cleanup row or thrown cleanup produces an incomplete/unavailable warning while the authorized container action continues. Only clean native exit zero acknowledges a command; an unconfirmed stop prevents removal, and an unconfirmed removal retains the earlier stop and cleanup facts. Project path and target scalars are captured once so cleanup/report callbacks cannot redirect destruction. Native composition preserves the public void facade, existing cleanup-only exit zero and native-failure error behavior. See [the requirements](../container/REQ__explicit-lifecycle-outcomes.md).

Existing core, type, facade, Docker and direct emitted-consumer tests cover this boundary. A fenced emitted native composition exercises the built code without operating an engine. Old-source controls identify swallowed cleanup reports and mutable target selection through the public facade.

## Known ceiling

Known ceiling: command acknowledgement is not a fresh native state inspection. No automatic retry, rollback or persistent operation receipt is added; unexpected identity, lock, presentation and dispatch exceptions still propagate. Cleanup-only incompleteness remains a warning with exit zero for CLI compatibility.

Known ceiling: portable and emitted fixtures do not certify actual Docker/Podman, Windows/macOS or remote runtime lifecycle behavior. Those acceptance lanes remain separate.
