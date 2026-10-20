# Remote sync belongs to one project and host authority

Derived technical requirement: this specializes the existing
[RemoteSession/Sync and SessionStore contracts](../common/SPEC__ccc-architecture-contracts.md#required-ports).
It replaces the project-only sync limitation described in the older remote
services guide and corrects the existing Docker transport representation. It
does not add a remote IDE or a transport framework.

Each operation resolves its local project and configured SSH user/host once.
Before creating a local claim, reserving a container or qualifying sync controls,
resolve that receiving account's effective Docker daemon address. Require a
bounded, successful metadata observation of one canonical absolute Unix socket
endpoint. Unsupported or ambiguous addresses, failed commands, invalid output
and unavailable hosts authorize no Docker or sync mutation. Failed resolution
may be retried; successful resolution stays fixed for that native composition
and configured user/host. Different configured targets retain independent
addresses. Execution also requires a local Docker CLI because Mutagen uses it;
presence checks must not contact a local daemon.

Every subsequent receiving-host Docker command, including reservation refresh,
release and interactive execution, explicitly uses that captured Unix address.
Changing ambient selectors or the contents of a context file after preparation
must not redirect those commands. Preserve the existing configuration grammar;
this correction does not add SSH ports, IPv6 host syntax or non-Unix daemons.

Sync naming separates these authorities. Successful complete native inventory
must prove absence before creation. Query failures, timeouts, invalid output
and incompatible records remain unknown and authorize no mutation. A legacy
unscoped name or ambiguous/foreign scoped record blocks creating another writer.
Identity-bearing names and endpoints must satisfy their native invariants;
valid unrelated transports remain accounted for as unqualified records.

Reuse requires one exact local/remote binding. Only a changed container ID
within that same binding permits checked replacement of the old sync. Creation
must be checked and its unique native identifier established before use; an
unknown post-create result never authorizes guessed cleanup or another create.

Mutagen names are nonunique. Resume, wait, termination and cleanup retain the
verified identifier and binding; they never substitute a same-name successor.
Use the existing project sync guard to serialize admission and mutations with
consistent container-guard ordering. Concurrent admission for one binding must
create at most one writer. Busy container cleanup still preserves sync.
Reservation and final cleanup acquire the project sync guard before the
container guard. Sync qualification immediately precedes pause after an
independently authorized exact-container stop; unavailable sync inventory does
not revoke the separate container lease. It does prevent any guessed pause.

Public check distinguishes missing from unknown or conflicting state. Public
termination requires valid saved configuration and qualified scope, preserves
legacy/foreign/ambiguous records, and reports success only after checked native
completion. Existing monotonic wait and native timeout limits remain.
Inventory queries have a 30-second default native budget; polling clips that
budget to the remaining deadline. Each public operation captures the Mutagen
environment and working directory through its fresh native composition.
Read-only check reports unknown/unavailable sync authority if runtime preparation
fails. Explicit termination returns a finite preparation failure and preserves
all sessions in that case; it must not infer that the sync is inactive. The
legacy raw status renderer remains read-only and needs no mutation authority.

Verify actual emitted code with a stateful instrumented Mutagen executable,
including two independent processes using the real existing guard. Assert exact
identifier controls, host isolation, unknown/legacy/conflict refusal, replacement
preservation and truthful failure reporting. These portable tests prove
ownership and failure policy. Actual Docker transport acceptance additionally
requires stock Mutagen, a uniquely owned real Linux container, and observed
file bytes in both directions at its exact full container ID. A manufactured
`watching` state is insufficient. Clean up only the created sync identifier,
container and private daemon/fixture namespace.

## Native format and known ceiling

The adapter uses Mutagen's [public JSON session model](https://github.com/mutagen-io/mutagen/blob/v0.17.0/pkg/api/models/synchronization/session.go)
and [template listing](https://github.com/mutagen-io/mutagen/blob/v0.17.0/cmd/mutagen/sync/list.go).
[Names do not uniquely select sessions](https://mutagen.io/documentation/introduction/names-labels-identifiers/).
Native protocol/path parsing stays outside application policy.

Create the beta endpoint as `docker://<full-container-id>/project/<project-id>`.
Its endpoint-specific Docker host is the receiving account and captured socket,
for example `ssh://user@host/run/user/1000/docker.sock`. Mutagen's
[Docker URL parser](https://github.com/mutagen-io/mutagen/blob/v0.17.0/pkg/url/parse_docker.go)
captures Docker environment variables at creation. Clear conflicting generic
and beta-specific host, context, config, TLS, certificate and API selectors
before setting the intended beta host. Docker's
[SSH helper](https://github.com/docker/cli/blob/v24.0.9/cli/connhelper/connhelper.go)
uses that URL's socket path for receiving-host daemon selection. Paths must
round-trip exactly and contain no shell metacharacters, whitespace, controls,
encoded ambiguity, query/fragment or dot segments.

Qualification requires an exact local alpha, Docker beta with full container ID
and project path, no container-user override, port or connection parameters,
and precisely the supported stored Docker authority matching a successfully
prepared target. Old `user@host:docker://…` records are SSH filesystem endpoints,
not container bindings. Keep them visible but unqualified. Different sockets,
conflicting selectors and otherwise incompatible records must not authorize
reuse, replacement or control. Do not migrate or delete them automatically.

See [the Docker transport guide](GUIDE__mutagen-docker-transport.md). Capturing
an address does not freeze SSH configuration, credentials, executable contents,
host identity or the daemon generation behind a socket. A controlled SSH
`dial-stdio` bridge can prove stock Docker/container convergence, but cannot
certify real SSH authentication or macOS incidents. Those platform and
reliability obligations remain separate.
