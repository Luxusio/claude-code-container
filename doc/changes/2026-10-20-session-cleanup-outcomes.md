# Automatic session cleanup exposes device observations

The native session cleanup adapter now projects canonical device rows to finite
counts. The application returns separate device, container and captured-claim
settlement facts. Ordinary failed rows produce one bounded diagnostic and retain
the established best-effort exact-stop and retirement policy; thrown cleanup has
unknown progress rather than invented successful counts.

The public CLI stays synchronous and void. Recovery and guardian release preserve
captured authority, current-session checks and irreversible retirement. See the
[session exit contract](../common/REQ__session-exit-cleanup.md).

Known ceiling: existing hard exception and unexpected-exception diagnostic behavior
remain; these outcomes do not normalize every native failure. Portable source and
emitted fixtures do not prove real Docker/Podman shutdown or Windows/macOS lifecycle
behavior. Full architecture and native acceptance remain separate.
