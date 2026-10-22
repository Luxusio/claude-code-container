---
area: device-lab
slug: container-broker-discovery
status: current
---

# REQ — The in-container MCP must accept the host broker it can actually reach

## Requirement
1. **One shared wire protocol.** `broker.protocolVersion` must exactly equal the
   integer exported by `packages/device-lab/providers/contracts/broker-protocol.mjs`.
   Missing, malformed, older and newer versions are incompatible. Package versions
   are informational and feature patch lists are no longer advertised or matched.
   The MCP (`probeCccHostBrokerProtocol`), host CLI (`probeHostBrokerStatus`) and
   Level 3 (`ensureHostBrokerReady`) use this same contract. Automatic replacement
   still requires verified process identity and never downgrades a newer protocol.
   A saved CCC host or MCP runtime (`managedBy: "ccc-host"` or `"device-lab-mcp"`)
   for a different valid port and PID must not prevent
   replacement of the requested port's broker when its exact trusted entry path,
   OS listener PID, and status/OS start token agree. That unrelated record cannot
   authorize termination or the metadata-only fallback. Conflicting records for
   the same port or PID, and records with an unknown manager, still block replacement.
2. **Forwarded loopback counts as outside the container.** Inside a container
   (`/.dockerenv`), a `managedBy: "ccc-host"` runtime reached at `127.0.0.1`,
   `localhost` or `::1` is accepted as `loopback-forwarded-container-boundary`. Its trust
   equals the `cross-host-container-boundary` path, but only when procfs shows one of
   two things:
   - `absent`: no LISTEN socket on that port in this network namespace; or
   - `outside-pid-namespace`: a LISTEN socket exists and no process in this PID namespace
     holds its inode, after every live process was fully inspected:
     - every thread's fd table is read (`/proc/<pid>/fd` and each
       `/proc/<pid>/task/<tid>/fd`), since a thread that unshared its descriptor table keeps
       sockets only in its own;
     - every fd link could be resolved;
     - `/proc` is listed again until a round finds no pid that was not already scanned (at
       most 8 rounds), so a holder that keeps passing the socket to newly forked children
       is not missed between the listing and the scan. A list that never settles is
       `indeterminate`.

     This is best-effort evidence against a local listener that is not trying to hide. A
     process in the container that deliberately moves its socket between descriptors or
     processes (dup2, SCM_RIGHTS) can still evade the scan. That is acceptable only because
     such a process already holds the owner secret and passwordless sudo.

     A process counts as a zombie, and is skipped, only when it is `Z`/`X` and its task list
     holds no thread but the leader. A `Z` leader whose other threads still run keeps its
     descriptors.

     This state is accepted only when the container's loopback is not shared through a VM,
     which is the case for native-Linux `--network host`. It is refused when any of these is
     set:
     - `CCC_CONTAINER_HOST_REMOTE=1`, set at container creation on VM-backed runtimes whether
       or not the proxy was turned off;
     - `CCC_PROXY_ENABLED=1` (ccc-proxy, Docker Desktop);
     - the host opt-out `CCC_DISABLE_PROXY=1`, forwarded per session, which covers
       containers created before the marker existed.
     Otherwise the host broker lives on another OS and never appears in this netns. A
     listener here that is outside the PID namespace belongs to another container on the
     same VM, and ccc-proxy would route to it before the host. So only `absent` is accepted
     there.

   Otherwise, strict local port-process verification applies as before:
   - `visible-owner`: a process in this container holds the socket.
   - `indeterminate`: some live process's fd table could not be read.
   - `unavailable`: procfs cannot answer.
   - A runtime not written by the host CLI.

   The same rule gates authenticated RPCs (`verifyAuthenticatedBrokerGeneration`). That
   check still binds the runtime's pid, start token and `startedAt` to the broker's
   `/status`. Caller RPC options can never assert a container boundary.

## Why
- Historical context (before the shared protocol replaced feature lists): container
  images routinely lagged the host install. With exact feature matching, every capability
  bump broke every older container. This was seen live: an MCP that required
  `hyper-v-network-failure-diagnostics-v9` (and `-v39`, `x11-type-v1`) refused a host
  broker that advertised `-v10` (`-v40`, `-v2`). Every device tool then failed with
  `host-broker-incompatible`.
- On Docker Desktop, ccc-proxy (iptables `OUTPUT REDIRECT`) sends container loopback to
  the host. It tries `127.0.0.1:<port>` in the container's netns first, then
  `host.docker.internal`. So `127.0.0.1:17373` reaches the Windows broker. That PID
  belongs to another OS, and port-process discovery follows the client's platform
  (Linux `/proc`). Strict verification therefore always failed with
  `broker-reuse-process-unverified`. WSL2 mirrored loopback and native-Linux
  `--network host` hit the same wall.
- The listener table is the evidence, not platform strings. Platform is not necessary:
  native Linux has a linux broker outside the PID namespace. Platform is not sufficient
  either: a local listener wins ccc-proxy's local-first routing, whatever the runtime
  file claims.

## Invariant / consistency
- The shared integer protocol is the only compatibility gate. Equal protocol values
  are compatible across package releases; a missing or different value is rejected.
- A breaking change or a fix requiring replacement of old brokers increments the
  shared protocol once. There are no feature-family counters or duplicated requirement lists.
- Verified older/legacy brokers may be replaced by host CCC. A higher protocol must
  never be downgraded automatically, even when process identity is otherwise valid.
- Termination paths (`terminateVerifiedBrokerRuntime`, `brokerShutdown`) retain local
  process identity checks. Compatibility does not establish permission to signal a PID.
- HTTP and replacement tests cover exact matching, malformed/missing versions,
  cross-package reuse, no-downgrade behavior, and process/generation identity.

## Known limits
- The check runs before the RPC connects, so there is a window between the two. The
  attacker that matters here is a process sharing this network namespace but outside the
  container's trust, for example another `--network host` container on the same VM. If
  it binds the port in that window, it receives the signed RPC. It can then:
  - read the request body in plaintext;
  - drop or delay the request;
  - return a forged response, because responses are not authenticated.

  It cannot:
  - learn the owner secret or the HMAC key;
  - forge or replay a request (HMAC plus the broker's nonce check).

  With Docker's default NET_RAW, such a process can already sniff and inject plaintext
  loopback and `host.docker.internal` traffic, so the window adds little. Closing it for
  real would need authenticated responses, which is out of scope.

  A `ccc` process inside the container is not a new threat. It already has passwordless
  sudo, NET_ADMIN and read access to the mounted owner secret.
- A VM-backed container created before `CCC_CONTAINER_HOST_REMOTE` existed has no marker,
  and the run contract does not recreate containers for an env change. If such a container
  was created with `CCC_DISABLE_PROXY=1`, it counts as a shared VM netns only in sessions
  that still set that variable. Recreate it once (`ccc rm`) or keep setting the opt-out.
  Containers with the proxy on are covered by `CCC_PROXY_ENABLED=1`.
- Podman containers (`/run/.containerenv`) are not yet detected as a container boundary.

## Regression coverage
- `src/__tests__/device-lab-broker-capabilities.test.ts`: exact protocol validation, actual HTTP probing,
  cross-package CLI reuse, and refusal to downgrade a newer protocol.
- `scripts/real-tests/hyper-v.test.ts`: Level 3 protocol and process identity attestation.
- `src/__tests__/device-lab-mcp.broker-container-boundary.test.ts`: the decision matrix,
  the RPC generation check, and the procfs inspector against a fake and the live `/proc`.
- `src/__tests__/device-lab-mcp.broker.test.ts`: `device_broker_status` end to end reuses
  a matching-protocol broker with a different package version. The container-local listener case is still rejected.
# Isolated owner credential discovery

Managed Device Lab MCP configuration explicitly supplies the fixed read-only
owner credential path. If an MCP launcher omits the environment variable, the
client discovers `/run/ccc-device-broker-auth/owner.json` directly. An explicit
path has precedence; legacy storage is considered only if the conventional
isolated credential is absent. Present invalid or inaccessible isolated files
fail closed. Owner matching, nofollow, single-link, bounded-read and file
identity checks remain mandatory. No secret is embedded in MCP configuration.

Readiness must not report RPC readiness when the resolved owner's credential
cannot be read and validated. Health success alone does not establish working
authenticated backend/inventory calls.

## Backend discovery timeout

Backend discovery RPCs use a separate 30-second default execution budget for
`device_backends` and implicit Hyper-V provider selection. The short health
probe timeout remains unchanged; a reachable broker may need longer to inspect
its host providers. An explicit `rpcTimeoutMs` overrides the discovery default
within the existing RPC timeout limit. Public operation `timeoutMs` controls
the device helper or wait; public translation supplies a separate internal
`brokerProbeTimeoutMs` of 1000 ms for discovery and broker identity checks.
Thus a 1 ms operation deadline does not become a 1 ms broker handshake.
Low-level broker callers that do not supply this internal override retain
their explicit `timeoutMs` probe budget. Neither probe setting shortens the
default backend discovery RPC budget; an Appium request's remaining overall
wait budget still bounds its identity check.

# One publisher for an MCP-supervised broker runtime

The MCP parent launches its real broker entry with the internal
`--runtime-managed-by-parent` flag. Only that launch skips the child serve
listener's runtime publication: the parent remains the sole publisher of the
`managedBy: "device-lab-mcp"` record. Standalone serve without the flag still
publishes its normal `managedBy: "ccc-host"` runtime. Host/port parsing, endpoint
shape, protocol and public authentication do not change.

Parent initial/final exact-record compare-and-swap, listener/start-token checks,
successor preservation and identity-bound shutdown stay authoritative. The child
must not overwrite either its parent's record or a concurrent successor. The flag
changes record publication only; it does not authorize signaling or bypass
ownership admission.

Verify actual source and built broker entries, not only the fake entry fixture,
through `src/__tests__/device-lab-broker.attach-cli.test.ts` and
`src/__tests__/device-lab-mcp.broker.test.ts`. Cover standalone publication,
parent-owned absent/existing records, initial/final CAS races, reuse, shutdown and
unchanged successor bytes. Controlled child tests do not certify host service
installation or device-provider operation.

# Parent ownership, request lifetime and qualified child profile
A healthy fully attested MCP-managed broker is reusable by host callers at its
saved port, including omitted-port discovery. Reuse preserves the parent-owned
runtime record; it never adopts that process as ccc-host. Unknown or conflicting
records still refuse, and trusted command/listener/start-token checks remain.
An accepted signed request's nonce remains reserved through the entire signed
timestamp validity window, including the existing positive client clock-skew
allowance. Timestamp checks and eviction use one captured current time. Replays
remain rejected without changing the wire format or allowed clock-skew bounds.
A broker provider child uses the authenticated registration's qualified profile.
The native child overrides or clears inherited CCC_PROFILE without changing the
parent environment. Equal device IDs in other profile stores grant no authority.
Source and built cleanup qualification executes the matching lifecycle binding;
Source API-worker cleanup alone does not qualify a built parent lifecycle.

Healthy reuse qualification grants no automatic replacement authority over a matching MCP-managed child. Incompatible protocol or required-bind mismatch preserves the prior refusal to signal or replace that child. Its parent and any concurrently published successor runtime evidence remain intact; existing ccc-host recovery stays supported.
