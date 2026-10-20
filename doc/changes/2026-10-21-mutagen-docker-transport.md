# Remote sync selects the receiving Docker daemon

Remote execution prepares the receiving account's Unix Docker address before
claims or mutations, reuses that address for receiving commands and creates a
stock Mutagen Docker endpoint for the captured container. Complete inventory
must match the prepared authority before reuse or exact-identifier controls;
old SSH filesystem representations remain visible conflicts. Missing local
Docker or unavailable runtime preparation fails without affecting other
sessions. See [sync authority](../remote/REQ__sync-authority.md) and the
[transport guide](../remote/GUIDE__mutagen-docker-transport.md).
Docker Engine 28 and newer need Mutagen 0.18.1 or newer for upstream agent
bootstrap compatibility; this change adds no CCC workaround for older Mutagen.

## Known ceiling

Known ceiling: Captured addresses do not freeze SSH credentials/configuration,
host identity or daemon generation. Controlled container transport proof does
not establish real SSH authentication or macOS recovery. Earlier guide
reconciliation and whole-platform/lifecycle acceptance remain open.
