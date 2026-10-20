# Localhost proxy routing and verification

The retained TypeScript API and the production Go daemon have separate inward
routing applications. `createLocalhostProxy` owns the TS pending-byte state,
local-first/fallback decision, flush/pipe order and counterpart cleanup callbacks.
`routeProxyConnection` owns production Go metadata refusal, local-first/fallback,
deferred client/upstream lifetime and relay sequencing. Both bindings are needed
for whole `OP-localhost-proxy` acceptance.

`createLocalhostProxyVerifier` owns `OP-localhost-proxy-setup` decisions. The
existing synchronous facade composes lazy platform/runtime/reach/listener and
diagnostic ports. Fresh Codex/Claude exec invokes it; reused exec skips it.

## Typed native ownership

The TS application accepts a caller-owned forwarding-stream facet and one
connection port. Its native composition instantiates the facet with real
`net.Socket` and `Buffer`, without a cast concealing method incompatibility. Data
chunks and socket objects pass by identity. Native methods retain their socket
receivers. The public async `proxyConnection` is the application's named async
function directly, preserving its await boundaries rather than wrapping another
Promise. Other public functions and port `19999` remain compatible.

The Go application uses type parameters for the concrete client pointer and
upstream interface. Native composition binds `*net.TCPConn` and `net.Conn`
directly, without runtime type assertions or wrapper objects. Three routing
capabilities supply destination metadata, dialing and native relay. Lifecycle
policy stays in application; relay supplies only native copy/half-close mechanics.
The minimal same-package policy, ports and application files are included by the
existing `COPY scripts/localhost-proxy/ .` and `go build .` closure.

## Exact variant behavior

TS observes client error/close before dialing and buffers while the client is
live. A local rejection falls back to the host only while the client remains
live; the optional host port uses nullish fallback. Termination removes the
buffering listener and releases pending chunks. A late successful upstream is
destroyed without forwarding. The optional native `destroyed` observation also
covers destruction before the close event; structural streams need not supply it.
An error observer remains while deferred native error/close events settle.

Healthy success installs counterpart cleanup before flushing original chunks in
FIFO order and piping both directions. Buffered references are released after
flush. Both live dial failures release pending input and destroy the client.
Write, pipe and destroy failures retain their raw behavior; cleanup errors do not
cause a fallback dial. The pending native dial still settles within its existing
budget. TS original-destination port zero is not newly refused. See the
[client lifetime requirement](REQ__localhost-proxy-client-lifetime.md).

Go rejects metadata errors and port zero. It defers client close before metadata,
tries local then host on any error, defers upstream close after successful dialing
and runs the native relay. Close errors remain ignored; defer/panic ordering stays
the existing behavior. Native relay concurrently copies both directions, applies
the two existing `CloseWrite` calls and waits. These policies are not uniformized.

Native JS connection attempts retain their 3000ms timer, connect/error listener
order, timer clearing, destruction and raw error identity. Go native dialing
retains its three-second timeout. Native original-destination syscalls and
getsockopt receivers, server/listener behavior and owned socket cleanup remain
authoritative. TS server errors remain ignored; Go listener failure remains exit1.
The Go daemon retains `proxy:19999` startup stdout. Neither implementation adds a
framing preamble to upstream bytes.

## Selected-runtime verification

Native Linux with a local container host skips without reach or listener probes.
Other cases delegate the existing host-reach observation with a 1500ms budget.
A reachable host skips proxy verification and optionally prints the existing
DEBUG latency diagnostic. Otherwise, native runtime exec reads `/proc/net/tcp`
with the existing 5000ms budget and exact loopback/listener token.

The observation retains raw error/status getters: error truthiness precedes
status-zero success. A missing daemon prints the original two warnings; the
second warning reads the selected Docker/Podman runtime again, lazily. Diagnostic
getter bindings select the current console method before argument interpolation
and preserve its console receiver. Constructor checks do not invoke these getters.
The proc probe makes no recursive TCP connection to the transparent proxy.

Entrypoint iptables, daemon startup, network namespaces, runtime selection and
host-reach implementation remain unchanged. Entry-point/build-file/module bytes
and retained native function bodies require hash proof. This refactor adds no
network feature, retry, cleanup repair, port hardening or resource limit.

## Verification and delivery gate

Freeze actual TS/Go/native/caller/build/entrypoint source before editing. Pair
actual original and candidate policy with identical chunks, objects, faults,
fake timers and ordered native observations. Future runtime fixtures bind only
allocated private loopback ports. Go tests must cover actual original/candidate
policy, nil/error/close/defer/panic behavior and retained native dial/relay; lack
of a Go toolchain is a blocker, not permission to omit the production binding.

Strict source/emitted TS consumers must accept real Socket/Buffer facets and
reject asynchronous or incompatible method carriers. Actual fresh/reuse CLI
fixtures must exercise the verifier rather than only count a mocked outer call.
Independent code/security review and fresh QA follow authoring.

The current npm file list includes the Go source folder and entrypoint script.
Asset inclusion alone does not establish that extracted or installed payloads
build and execute correctly. Whole acceptance still needs the relevant Go
build/proof from npm-extracted and installer-materialized payloads, plus their
actual TS exports and current declarations. Checkout fallback is forbidden.

Known ceiling: source authoring and portable mock/TCP proof do not establish real
Docker Desktop, Podman-machine, iptables/SO_ORIGINAL_DST routing or native
Windows/macOS acceptance. Go execution remains pending where tooling is absent.
Packaging, actual dual shipping and root integration remain separate gates;
this packet alone does not complete the architecture migration.
