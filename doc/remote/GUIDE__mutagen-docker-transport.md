# Remote container synchronization through Docker

This guide describes Docker transport and daemon-address selection. For sync
ownership and execution completion, use [sync authority](REQ__sync-authority.md)
and [execution completion](REQ__execution-completion.md). The earlier
[remote services guide](GUIDE__remote-services.md) contains superseded
descriptions of sync naming, completion and transport; those descriptions are
not the current contract. Its unrelated pending edits are retained separately.

The local computer needs Mutagen and the Docker CLI. The receiving account
needs SSH access, Docker CLI access to a running Linux container daemon and the
existing CCC image. Local Docker presence is checked with `docker --version`;
no local running engine is required for this remote workflow. The existing
setup and check commands report tool availability.
For Docker Engine 28 or newer, use Mutagen 0.18.1 or newer: its
[upstream compatibility fix](https://github.com/mutagen-io/mutagen/releases/tag/v0.18.1)
recognizes Docker's changed missing-agent exit code and enables agent setup.

The native composition captures its invocation environment and working
directory. Before ownership or mutation, it reads the receiving account's
Docker context endpoint with a bounded SSH metadata command. It accepts one
canonical safe absolute Unix socket address, such as
`unix:///run/user/1000/docker.sock`. It caches successful resolution separately
for each configured user/host; failures remain failures and may be retried.
Every later CCC-owned receiving shell program explicitly selects that address
and clears conflicting context, host, TLS and API selectors. Mutagen's upstream
Docker SSH helper also explicitly selects the captured socket. Editing a context
file or ambient selectors after capture therefore does not choose another
socket. The upstream helper does not run CCC's selector-clearing prelude;
receiving login configuration can still cause ordinary initialization failure.

Mutagen receives `docker://<full-container-id>/project/<project-id>` as beta.
For the example above, `MUTAGEN_BETA_DOCKER_HOST` is
`ssh://user@host/run/user/1000/docker.sock`. Other generic and beta-specific
Docker selectors are removed from the create invocation. These are the
upstream [Docker endpoint](https://mutagen.io/documentation/transports/docker/)
and [captured environment](https://github.com/mutagen-io/mutagen/blob/v0.17.0/pkg/url/parse_docker.go)
mechanisms. Mutagen runs local Docker commands, which use SSH `dial-stdio`
against the selected receiving socket. CCC adds no forwarding daemon.

Complete inventory qualification verifies the local path, container ID, project
path and prepared Docker authority before existing exact-identifier controls.
The old `user@host:docker://…` form is an SSH filesystem path in stock Mutagen.
Old records, different sockets, extra selectors, user overrides or ambiguous
records remain visible conflicts; CCC does not silently replace or terminate
them. Inspect such records before manually choosing their disposition.

Missing local Docker prevents execution. Unavailable or unsupported receiving
runtime resolution fails before claims or reservation. Read-only check reports
unknown/unavailable authority; explicit termination fails while preserving
sessions. Neither condition means that another existing session is absent.
The [sync wait budget](REQ__sync-wait-budget.md) still applies independently.

Portable behavior tests exercise all receiving command paths, preparation
failures, captured selectors, complete inventory and exact-identifier controls.
The stateful emitted integration fixture retains separate-process writer and
successor protections. Native transport proof uses stock Mutagen and an owned
real Linux container, checks exact bytes in both directions and joins/removes
only its own sync, container and private daemon resources.

## Known ceiling

Known ceiling: Address capture does not freeze SSH configuration, credentials,
executable contents, remote host identity or the daemon behind a socket. The
existing host/user grammar does not add SSH ports or IPv6 syntax; only safe
Unix daemon endpoints are supported. Rootless mount behavior is separate.
Controlled SSH bridge evidence proves the transport paths it executes, not
real SSH authentication, macOS incident recovery or all lifecycle reliability.
Global reconciliation of the earlier remote services guide remains open.
