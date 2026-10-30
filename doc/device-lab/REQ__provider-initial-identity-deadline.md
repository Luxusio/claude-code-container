# Provider deadline includes initial process identity

An already spawned provider must not block deadline observation while its initial Windows identity is queried. Install output, exit and error observers and the captured command deadline before starting that asynchronous query. The query consumes the existing command budget; it receives no fresh timeout allowance.

Command expiry preserves the first failure and excludes output delivered after expiry, including while qualified cleanup is pending. Keep initial identity publication and close settlement ordered: a close or timeout while identity is unresolved must not invent identity, drop publication responsibility or report successful process-tree cleanup. Continue to require the captured identity for native tree termination. Do not kill the root early merely to satisfy timing assertions, since that can orphan descendants.

The existing bounded completion grace still governs cleanup. A command deadline is not a promise that every native descendant disappears at that exact millisecond. Verify expiry while initial identity is gated, delayed close and missing or changed identity, retained primary errors, discarded late output, and qualified owned process settlement on Windows as well as portable fixtures.
