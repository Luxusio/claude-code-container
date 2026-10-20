# Preserve unknown remote session peers

Remote session cleanup preserves indeterminate peer records and returns its
existing busy result instead of treating unreadable, malformed, incomplete,
out-of-range or nonregular records as permission to stop the container. Valid
expired peers still retire under the existing lifecycle guard, and stop still
requires the own token and pinned container ID/name. See the
[requirement](../remote/REQ__session-peer-veto.md). Separately, the QEMU lifecycle
declaration now includes the already-implemented `reboot` method for typed callers.

## Known ceiling

Controlled shell execution and typed consumers do not certify live SSH,
Windows/macOS remote hosts or container-engine reliability. Shared remote sync
naming and reusable remote process completion remain separate follow-up work.
