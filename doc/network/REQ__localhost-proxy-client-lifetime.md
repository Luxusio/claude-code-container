# Retained TypeScript proxy client lifetime

This is a **derived technical repair and compatibility requirement**, based on
the existing [architecture ADR](../common/ADR__ccc-target-architecture.md) and
[application/port contracts](../common/SPEC__ccc-architecture-contracts.md).
The retained public helper needs explicit lifetime policy because its native
operations can terminate a client before deferred close delivery. Preserving
accepted stream facets applies the existing public compatibility constraint.
These are technical consequences of the architecture conversion, not additional
user acceptance criteria or a new product feature.

The public TypeScript `proxyConnection` helper must stop forwarding when its
client closes, errors or is already destroyed, including while a connection
attempt is pending. This requirement concerns the retained TypeScript API;
production container forwarding uses the separate Go daemon.

## Required behavior

- Observe client termination before starting either connection attempt. Release
  pending input immediately when the client terminates.
- If the local attempt fails after client termination, do not start the host
  fallback. If either attempt succeeds after termination, destroy that upstream
  without forwarding pending bytes or installing pipes.
- Native destruction can precede the close event. Honor the optional native
  `destroyed` observation and retain an error observer while deferred native
  error/close events settle.
- Establish counterpart cleanup before forwarding. Healthy connections preserve
  chunk identity and FIFO order, local-first routing, fallback on any local dial
  rejection, nullish host-port selection and bidirectional forwarding.
- Keep existing raw write, pipe and destroy failure behavior. A cleanup failure
  must not be reclassified as a local connection failure or dispatch a fallback.
- Preserve accepted structural streams: observing native destruction is optional;
  callers need not add lifecycle-listener removal methods.

An in-flight native connection may finish within its existing three-second
budget. This contract does not promise immediate dial cancellation, add buffer
limits or change Go routing, server policy or runtime selection.

## Verification

Use deferred local and fallback attempts to prove termination prevents writes,
pipes and unnecessary fallback, while live dual failure releases pending input
and destroys the client. Verify healthy FIFO forwarding and raw fault identity.
With allocated private IPv6 sockets and a controlled dial-settlement barrier,
prove that native client destruction closes the late upstream with zero bytes
forwarded. Check both native Socket/Buffer and previously accepted narrow stream
facets through the existing strict type contracts.

## Related sources

- [Application](../../src/application/localhost-proxy.ts)
- [Stream contract](../../src/ports/localhost-proxy.ts)
- [Routing guide](GUIDE__localhost-proxy.md)
