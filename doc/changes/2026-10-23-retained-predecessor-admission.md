# Join a running environment while retaining pending recovery

When the only predecessor recovery failures are qualified dead monitored pending requests, CCC can admit a new session to the same freshly verified running managed container. It retains all predecessor evidence and cleanup vetoes, pins the new invocation to that exact target and keeps its cleanup disabled. Normal setup and development commands remain available; native restart, replacement, migration and creation are refused. Exit retires only the new no-obligation session.

## Known ceiling

This does not settle historical pending native requests or start a stopped/missing environment. Actual macOS/Windows acceptance requires host evidence. See [retained predecessor admission](../session/REQ__retained-predecessor-session-admission.md).
