# Retained TypeScript proxy stops forwarding after client termination

The public TypeScript proxy previously attached client cleanup after waiting for
an upstream connection. A client could close during that wait and its pending
bytes would still be forwarded when the connection succeeded.

The application now owns client lifetime before dialing, releases buffered input
on termination, suppresses unnecessary fallback and retires late upstreams.
Native `destroyed` state is optional, preserving existing structural callers.
Healthy local/fallback routing, FIFO chunk identity, native connection budgets
and raw write/pipe/destroy faults keep their existing contracts.

Behavioral coverage belongs to the existing core and native Socket owners, with
strict contracts for real sockets and narrow structural streams. The genuine
unchanged emitted baseline reproduced late forwarding after close. The
[requirement](../network/REQ__localhost-proxy-client-lifetime.md) and
[routing guide](../network/GUIDE__localhost-proxy.md) define the intended contract.

## Known ceiling

Production container forwarding uses the separate Go daemon. This TypeScript
repair does not diagnose or change Docker Desktop/Podman routing, iptables,
server policy or Go lifetime behavior. Portable tests do not establish native
macOS/provider or whole architecture acceptance. No persistent migration is
needed.
