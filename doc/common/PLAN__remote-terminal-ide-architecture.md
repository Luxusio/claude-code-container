---
type: PLAN
status: proposed
created: 2026-07-17
scope: long-term remote terminal IDE architecture
---

# Remote Terminal IDE Architecture

## Goal

Turn CCC into a terminal-first remote IDE where source and Git live in an
isolated high-performance remote container or VM, while local terminal and
editor clients attach with low latency. Optional local mirroring may be added
after the remote-authoritative product is reliable.

The design must preserve remote Git and workspace state across disconnects and
compute recreation, expose explicit health states, and avoid coupling the
product to one network, editor, synchronization engine, or container runtime.

## Product sequencing decision (2026-07-19)

The first product release will **not provide local/remote file synchronization**.
Its workspace filesystem and Git repository are authoritative on the remote
host. The local machine is a terminal/editor client, not a second writable
replica.

The MVP access surfaces are:

1. the CCC desktop IDE shell with file explorer, basic text editor, agent panel,
   and durable terminal;
2. standard SSH/SFTP access to the same remote workspace;
3. optional user-initiated VS Code Remote-SSH attachment as an escape hatch; and
4. explicit artifact download/upload for files that must cross the boundary.

This removes synchronization conflict handling, dual Git metadata, offline
merge, local dependency portability, and high-volume delta transfer from the
initial reliability boundary. A session can continue while the local device is
offline because both source and Git state already live remotely.

VS Code integration means generating an SSH target and offering an optional
`Open in VS Code` handoff. It is not the primary CCC UI. CCC must not package or
host Microsoft's VS Code
Server as its own managed service without separate permission: Microsoft's
published VS Code Server documentation says hosting it as a service is not
allowed. The user's licensed VS Code/Remote-SSH client may install its own
matching server on connection. If CCC later ships a browser IDE, evaluate an
appropriately licensed implementation such as OpenVSCode Server separately.

File synchronization remains an optional later companion mode for users who
need local editors, local Git GUIs, or local execution. The sync architecture
below is the target for that later mode, not an MVP dependency. Product status
must label it experimental until conflict, durability, and Git-authority tests
pass.

## Optional future sync contract

1. `ccc remote up <target>` provisions or reuses a workspace and compute unit.
2. When optional sync is enabled, local and remote source edits normally appear
   on the other side within one second on a healthy LAN or tailnet.
3. Every synchronized workspace declares exactly one Git authority. The
   agent-first default remains remote; a later local-authority companion mode is
   explicit rather than inferred.
4. AI and build processes execute on the remote machine. Git history mutations
   execute at the declared Git authority instead of maintaining two
   independently changing `.git` directories.
5. A network loss does not kill the remote PTY or discard work. Reconnection
   resumes the same terminal session and synchronization reconciles changes.
6. Destroying a container or VM does not destroy source state. Workspace data,
   caches, credentials, and compute are separate lifecycle domains.
7. Conflicts, lag, ignored files, and degraded states are visible in the TUI and
   CLI. CCC never reports "synced" solely because the sync process is alive.

## Non-goals

- The first editor does not reproduce IntelliJ/VS Code language intelligence,
  plugin ecosystems, project models, or refactoring engines.
- CCC does not replace Git hosting or use Git commits as its low-latency file
  transport.
- Dependency trees and build caches are not mirrored by default.
- The first release need not support live migration of running compute between
  remote hosts.

## Key invariants

### Git has one authority

`.git` must never participate in general-purpose bidirectional file sync. In the
remote-authoritative MVP, the remote workspace owns the index, refs, object
database, hooks, and commits. A later synchronized workspace declares either
remote or local authority explicitly. This prevents filesystem-specific Git
index churn, concurrent lock races, and two repositories whose working trees
match while their `HEAD`s differ.

Only a future local-authority mode needs a remote **shadow Git view** pinned to
the local repository's baseline. It exists so AI tools can run read operations
such as `git diff`, `git status`, and `git grep`. History-changing commands are
either:

- denied with an actionable message in the initial implementation; or
- sent through a local Git broker after a sync barrier in the complete design.

The broker protocol is request/response and allowlisted. It does not expose an
arbitrary local shell. A commit transaction is:

1. flush remote-to-local source synchronization;
2. verify that neither endpoint has a conflict and record the agreed generation;
3. run the requested Git operation in the local repository;
4. publish the resulting `HEAD`, branch, and status event;
5. refresh the remote shadow Git baseline before releasing the barrier.

### Workspace outlives compute

The remote workspace is owned by the CCC host daemon, not by a container's
writable layer. A compute adapter mounts or exports it as `/workspace`:

- container: bind mount a daemon-managed native filesystem directory;
- Linux VM on the same host: virtiofs when available;
- incompatible or strongly isolated VM: run a CCC guest agent and use the same
  synchronization protocol for the host-to-guest hop.

Package caches and dependency directories use separate named cache stores.
Ephemeral files use tmpfs or the compute writable layer. A container/VM may be
recreated without reseeding the entire local project.

### Synchronization is a state machine

The sync controller records both endpoint scans, the last agreed generation,
pending bytes/files, conflicts, and last successful flush. Valid user-facing
states are `seeding`, `watching`, `syncing`, `conflicted`, `offline`, `paused`,
and `error`. PTY attachment is allowed while offline, but Git broker mutations
and destructive lifecycle actions require an explicit safe synchronization
state.

The default source mode is bidirectional and conflict-preserving. CCC must not
silently choose a winner when local and remote modify the same file offline.
Conflict resolution is an explicit `ccc sync resolve` operation.

## System shape

```text
Local machine                              Remote high-performance host

+---------------------------+              +-------------------------------+
| ccc CLI/TUI                |  secure RPC  | cccd host daemon              |
| - lifecycle/status         +------------->| - auth + policy               |
| - PTY client               |              | - workspace registry          |
| - sync controller          |<------------>| - compute adapters            |
| - local Git authority      | source delta | - sync endpoint               |
+-------------+-------------+              | - PTY/session supervisor       |
              |                            | - port/artifact gateway        |
      local checkout                       +---------------+---------------+
      (real .git)                                           |
                                                 persistent workspace
                                                 + caches + runtime
                                                           |
                                            +--------------+--------------+
                                            | container or VM             |
                                            | AI, compiler, tests, app     |
                                            | remote shadow Git view      |
                                            +-----------------------------+
```

The control plane and data plane are separate:

- **Control plane:** authenticated versioned RPC for provisioning, state,
  leases, terminal sessions, sync barriers, Git requests, ports, and logs.
- **Data plane:** SSH initially; later a multiplexed encrypted transport for
  file deltas, PTY streams, port forwarding, and artifact transfer.

Tailscale is the recommended reachability layer, but CCC treats it as a target
resolver. Plain SSH, LAN, WireGuard, and a relay can implement the same
transport interface.

### Connection establishment and topology

Mutagen is not itself a peer discovery, NAT traversal, or relay service. It
requires a transport that already makes the remote endpoint addressable. With
its SSH transport, the local Mutagen process invokes OpenSSH, copies a compatible
agent to the remote endpoint, launches it, and exchanges the sync protocol over
the SSH process's standard input/output streams. The remote host does not need
to initiate a callback connection to the local checkout.

The initial CCC connection sequence is therefore:

1. enroll a target once and pin its host identity;
2. resolve the target to a LAN, Tailscale, or configured SSH address;
3. have the local CCC client initiate one authenticated SSH connection;
4. start or reconnect `cccd`, the PTY channel, and the Mutagen remote agent over
   that path;
5. keep remote workspace and process state durable when the path disappears;
6. reconnect and reconcile from the last agreed sync generation later.

No inbound connection to the laptop is required. With conventional SSH, the
remote host needs a reachable SSH listener, which may mean a public address,
VPN, bastion, or router port forwarding. With Tailscale, both devices join the
same authenticated tailnet and normally make only outbound network connections.
Tailscale attempts a direct peer-to-peer UDP data path; under hard NAT or a
restrictive firewall it transparently falls back to a tailnet peer relay or a
DERP relay. This direct-versus-relayed choice is below SSH and Mutagen and does
not change CCC's synchronization semantics.

CCC should expose the selected path because it affects bulk-sync performance:

```text
connection: direct | peer-relay | derp-relay | ssh-bastion | ccc-relay
latency: 18 ms
estimated-throughput: 420 Mbps
```

For a future zero-network-setup product, add an optional CCC rendezvous/relay
service. **`CCC Relay` is only a proposed architecture label in this plan; no
such service or implementation exists in the current CCC repository.** Both the
local client and `cccd` maintain outbound TLS/QUIC connections
to the service, so neither side needs an open inbound port. The service matches
an enrolled target and forwards opaque end-to-end encrypted streams. CCC may
later attempt an ICE/STUN-style direct upgrade, but a relay-only first version
is operationally simpler. SSH can initially run through a CCC `ProxyCommand` or
local proxy so the existing Mutagen adapter remains usable. Eventually the CCC
data-plane protocol can carry file deltas directly.

The relay is optional because it introduces hosted infrastructure, bandwidth
cost, availability responsibility, abuse controls, and key-recovery design. The
recommended product tiers are:

| Mode | Inbound port | Infrastructure | Path |
|---|---:|---|---|
| LAN/public SSH | SSH on remote | none | client to remote |
| Tailscale | none normally | tailnet coordination and fallback relay | direct when possible |
| CCC relay | none | CCC rendezvous/relay | relayed, optional direct upgrade |

Target enrollment, transport connectivity, and workspace synchronization are
separate states. A target may be enrolled but offline; a transport may be
connected while synchronization is conflicted. CLI/TUI status must not collapse
these into a single boolean.

## Components

### Local CCC supervisor

- Resolves a project identity from repository identity plus local path. A raw
  path hash alone is not stable across machines or directory moves.
- Owns the local half of synchronization and the real Git repository.
- Presents one status model in both CLI and TUI.
- Reconnects to durable remote PTY sessions.
- Starts local preview commands only after an optional sync barrier.

### `cccd` remote host daemon

**`cccd` is a proposed component name in this plan, not a command or daemon that
exists in the current repository.** It denotes the future per-user background
service on a local or remote workspace host. The final product name may differ.

- Runs as an unprivileged per-user service where possible.
- Exposes a narrow, versioned API instead of constructing remote shell strings.
- Maintains owner-scoped workspace and compute records in a small transactional
  state database.
- Serializes lifecycle mutations per workspace and uses renewable leases so a
  crashed client cannot leave permanent locks.
- Delegates Docker, Podman, libvirt/QEMU, or another VM backend to adapters.
- Applies CPU, memory, GPU, PID, disk, and network policy to every compute unit.

### Migration from the current CLI to the workspace service

This is an extraction, not a ground-up daemon rewrite. The current source
already contains most container/runtime setup and a smaller detached-service
precedent in the device-lab host broker. However, the main CCC execution path is
still a foreground CLI controller rather than a daemon:

- `src/index.ts:355` owns the complete project setup and execution transaction;
- `src/index.ts:388` creates a session lock tied to the foreground CLI PID;
- `src/index.ts:678` and nearby paths synchronously wait on child tools;
- `src/index.ts:713` cleans the session when the foreground command exits;
- `src/session.ts:161` stops the container when the last CLI session exits; and
- `src/remote.ts:371` directly owns the interactive SSH child process.

The device-lab broker already demonstrates detached launch, readiness probing,
runtime metadata, and process reuse around `src/device-lab-broker.ts:1962`.
Reuse that operational pattern, but do not turn the device-specific broker API
into the general workspace API.

IPC is required because the desktop GUI and CLI are separate processes from the
long-lived service. Use one versioned protocol with three interaction shapes:

```text
request/response  workspace.start, fs.read, fs.write, git.status
server events     lifecycle progress, file watches, process exits, diagnostics
duplex streams    PTY input/output/resize, logs, port forwarding
```

For local IPC, prefer a user-owned Unix domain socket on macOS/Linux and named
pipe on Windows. Do not expose a localhost TCP port by default. A remote SSH
connection can initially run a small `ccc host proxy` command that bridges SSH
stdio to the remote service's private socket. The GUI and CLI therefore use the
same messages locally and remotely without exposing the daemon on the network.

Do not simply move the current `exec()` body behind an HTTP handler. First:

1. extract `WorkspaceManager`, `ComputeManager`, `ProcessManager`, and
   `FileService` from CLI presentation code;
2. replace `process.exit` with typed results/errors and interactive prompts with
   explicit client decisions;
3. replace blocking `spawnSync` on service request paths with bounded async
   children or serialized worker jobs so one build does not freeze every client;
4. replace module-global current-session state with maps keyed by stable
   workspace, operation, and terminal session IDs;
5. separate attachment lifetime from workspace/compute lifetime; closing a GUI
   or CLI attachment must not imply container shutdown; and
6. emit structured progress/events instead of printing prose inside managers.

Migration can preserve the existing CLI behavior:

```text
Stage 1  hidden `ccc host serve` + private IPC + health/status
Stage 2  CLI calls the service for workspace/container lifecycle
Stage 3  PTY ownership moves to the service; CLI becomes attach client
Stage 4  desktop IDE uses the same API
Stage 5  SSH stdio proxy exposes the same service remotely
```

Until Stage 3, foreground `ccc` execution can remain as a compatibility path.
This reduces risk while the service gains concurrency, crash recovery, and
upgrade semantics.

### Workspace manager

Use a stable layout such as:

```text
~/.local/share/ccc/
  workspaces/<owner>/<workspace-id>/source/
  caches/<cache-id>/
  state/<workspace-id>.db
  logs/<workspace-id>/
```

The source directory is backed up or snapshotted independently of compute.
Workspace deletion is a two-step trash-and-expire operation. The daemon refuses
deletion when unsynchronized changes exist unless the user explicitly forces it.

### Sync engine adapter

Keep Mutagen as the first implementation because the current `ccc remote`
already uses it, but place it behind a CCC interface:

```text
createSession, inspect, flush, pause, resume, resolve, terminate, capabilities
```

The adapter must configure a safe bidirectional mode explicitly rather than
depending on a user's global default. It must parse machine-readable output,
track endpoint identity, and recreate a session if host, workspace, container,
or policy identity has changed.

Default classes:

| Class | Examples | Policy |
|---|---|---|
| source | `src/`, manifests, lockfiles, tests | bidirectional, conflict-safe |
| Git metadata | `.git/` | never general-sync |
| dependencies | `node_modules/`, `.venv/`, `vendor/` | endpoint-local cache |
| build output | `dist/`, `target/`, `.next/` | excluded by default, opt-in artifact |
| secrets | `.env`, credentials | explicit secret channel, never inferred |
| artifacts | APKs, binaries, reports | explicit pull/push with size and checksum |

Projects may override this in a committed `.ccc/remote.yaml`. CCC shows the
effective policy and warns when a requested rule includes `.git` or known secret
paths.

### Durable terminal and process supervisor

Remote commands run under a session supervisor rather than the lifetime of an
SSH connection. Each session has a stable ID, ring-buffered output, exit state,
working directory, environment profile, and optional tmux compatibility. The
client can attach, detach, reconnect, and list sessions. Disconnecting never
implicitly stops compute or pauses synchronization.

### Port and preview gateway

Remote services bind inside the isolated compute unit. CCC discovers declared
or observed ports and establishes authenticated local forwards. The TUI shows
`remote 3000 -> localhost:<allocated-port>`. Reverse forwarding is a separate,
explicit capability. Ports are not exposed on the public remote host by default.

Local preview is a distinct workflow:

```text
ccc run-local --after-sync <command>
```

It flushes the source generation, then runs with local dependencies and OS. CCC
does not mirror remote `node_modules`, virtual environments, or platform build
products and pretend that they are portable.

## Identity and state model

Primary resources are `Target`, `Workspace`, `Compute`, `SyncSession`,
`TerminalSession`, `PortForward`, and `Artifact`.

- `workspace-id`: stable random ID stored in local CCC metadata and remote
  registry; human-readable project name is only a label.
- `compute-id`: replaceable instance attached to one workspace generation.
- `sync-session-id`: binds exact local root, target, remote workspace, policy
  hash, and engine version.
- `terminal-session-id`: survives client connections and may survive compute
  restart only when its process still exists.

Every mutation carries an idempotency key and expected resource generation.
Status responses include protocol version, component health, last transition,
and actionable recovery text.

## Security model

- Authenticate client and daemon mutually. With Tailscale, still enforce CCC
  owner/workspace authorization; network membership alone is not sufficient.
- Prefer rootless containers. Do not mount the host Docker socket inside the
  development container. The daemon performs allowlisted runtime operations.
- Scope credentials per workspace/profile and inject them at process start or
  through read-only secret mounts. Do not copy all host environment variables.
- Encrypt transport, redact secrets from logs, and record lifecycle/Git broker
  audit events.
- Default-deny privileged containers, host filesystem mounts, raw devices, and
  public port exposure. GPU and nested virtualization are named capabilities.
- Pin image identity by digest and record the environment specification used to
  create compute.

## Failure behavior

| Failure | Required behavior |
|---|---|
| local network disappears | remote PTY/process continues; sync becomes `offline` |
| both sides edit one file | retain both changes; enter `conflicted`; no auto-winner |
| container is removed | workspace remains; replacement mounts the same source |
| local client crashes during mutation | lease expires; idempotent retry reports result |
| remote disk approaches quota | stop accepting large deltas/artifacts before corruption |
| sync daemon/session disappears | detect from state, verify endpoints, recreate safely |
| host reboots | daemon restores metadata, compute policy decides auto-start, PTY state is honest |
| local Git branch/HEAD changes | sync source, refresh shadow baseline under barrier |
| deletion requested with pending remote edits | refuse by default and report pending generation |

## Client surfaces

### Desktop GUI is the product

Connection management is too stateful for a CLI-only product. CCC should ship a
desktop control panel that manages target enrollment, workspace lifecycle,
connection health, durable sessions, ports, and editor handoff. More
importantly, the default workspace view is a deliberately small agent-first IDE:
a file tree, text editor, agent surface, and terminal. VS Code remains optional.

The desktop window must not own background connections or workspace processes.
A local CCC background service owns credentials, tunnels, retries, operation
queues, and cached state. CLI and GUI are peers over the same versioned local
API:

```text
ccc CLI ---------+
                 +--> local ccc service --> SSH/relay --> remote cccd
CCC desktop -----+
```

Closing or upgrading the GUI therefore does not disconnect remote terminals,
cancel agents, or stop compute. CLI actions appear immediately in the GUI and
GUI actions remain inspectable through `ccc status --json`.

The repository README currently describes a Tauri 2 desktop application, but
no Tauri/Rust desktop source or manifest is tracked in the inspected tree as of
2026-07-19. Before extending that implementation, reconcile the packaging
documentation and restore or explicitly replace the missing desktop source.

### One IDE model for local and remote workspaces

The desktop application must not implement separate local and remote editors.
Both are instances of the same `WorkspaceBackend` contract:

```text
WorkspaceBackend
  identity/capabilities
  list/stat/read/write/rename/delete/watch/search
  openPty/attachPty/resizePty/signalProcess
  gitStatus/gitDiff
  listPorts/forwardPort

LocalWorkspaceBackend  -> local CCC service -> local filesystem/processes
RemoteWorkspaceBackend -> local CCC service -> transport -> remote cccd
```

Run the same workspace service locally, over loopback, instead of letting the UI
call arbitrary native filesystem and process APIs. This keeps permissions,
auditing, cancellation, path validation, and behavior consistent. The user sees
only a `Local` or `Remote · gpu-box · 18 ms` badge; open, save, search, terminal,
Git status, and agent controls behave the same.

Every open resource uses a stable URI such as
`ccc-workspace://<workspace-id>/<path>`, not a host path embedded in UI state.
Editor tabs, recent files, diagnostics, agent references, and restore state can
therefore survive a workspace move or compute recreation.

### Agent-first IDE shell

The MVP layout is intentionally smaller than IntelliJ or VS Code:

```text
+-----------------------------------------------------------------------+
| workspace / branch       Local or Remote · health          Run Agent   |
+----------------+-----------------------------------+------------------+
| Files          | Editor tabs                       | Agent            |
|                |                                   | task / status    |
| src/           | basic text editing                | tool activity    |
| tests/         | syntax colors / find / diff       | approvals        |
| README.md      |                                   | changed files    |
+----------------+-----------------------------------+------------------+
| Terminal · Logs · Ports · Problems                                    |
+-----------------------------------------------------------------------+
```

MVP editor features:

- open/save, multiple tabs, undo/redo, find/replace, line numbers, syntax
  highlighting, dirty state, keyboard shortcuts, and large-file guardrails;
- file tree create/rename/delete, fuzzy file open, recent files, and external
  change watching;
- diff viewer for agent changes and save conflicts;
- no plugin ecosystem, refactoring engine, debugger framework, project model,
  or bundled language servers in the first release.

CodeMirror 6 is the recommended first editor component because CCC wants a
small, extensible text editor rather than a VS Code-compatible workbench.
Keep an internal `EditorAdapter` boundary so Monaco can be evaluated later if
built-in language providers, richer multi-model behavior, or LSP integration
becomes a product priority. Use xterm.js only as the terminal renderer; PTY and
process state remain owned by the local/remote workspace service.

### Embedded terminal reliability gate

The embedded terminal is a high-risk subsystem and must be proven in a small
standalone harness before it is integrated with the IDE layout. Do not implement
terminal escape parsing, cursor rendering, IME composition, selection, or mouse
protocols in CCC. Use xterm.js public APIs and keep the terminal DOM instance
stable across UI state updates.

There is no truly turnkey terminal widget because a complete integrated
terminal crosses four separately evolving boundaries: WebView input/rendering,
terminal escape emulation, the host OS PTY/ConPTY API, and the product's
process/transport/lifecycle model. Existing libraries intentionally cover only
parts of that stack:

```text
xterm.js   terminal emulator and browser interaction
node-pty or equivalent   OS PTY/ConPTY adapter
CCC        transport, persistence, reconnect, policy, shortcuts, layout
shell/TUI  application-specific escape and mouse behavior
```

Mature products are stable primarily because they isolate the PTY host from the
UI, constrain supported combinations, retain external-terminal recovery, and
run large regression matrices over many releases. They still receive platform
terminal bugs. CCC should target containment and recovery in addition to
correctness: a terminal renderer or PTY-host failure must not crash the IDE,
lose the remote process, or require workspace recreation.

#### Reuse VS Code's architecture, not its workbench internals

Terminology: **PTY** means *pseudoterminal* and is unrelated to the PuTTY SSH
client. `node-pty` is the reusable backend library. **CCC PTY Host** is the
proposed small CCC-owned helper process that loads `node-pty`; it is not an
importable VS Code service or an existing CCC binary.

Do not fork Code-OSS and do not import files from `vs/workbench/contrib/terminal`
or other VS Code internal paths. VS Code's workbench modules depend on its
internal dependency injection, contribution registry, configuration, Electron
utility processes, lifecycle, and platform services. Those paths are not a
supported embeddable SDK, so tracking them creates nearly the same upstream
compatibility burden as maintaining a fork.

Depend only on intentionally published boundaries and reproduce the proven
process shape:

```text
CCC WebView
  @xterm/xterm + supported addons
          |
          | typed terminal protocol
          v
CCC Workspace Service
  session registry, sequencing, replay, policy
          |
          | private IPC
          v
CCC PTY Host
  node-pty or another maintained PTY/ConPTY adapter
          |
          v
shell / tmux / container exec / agent TUI
```

The PTY Host is a replaceable, crash-isolated helper rather than UI code. The
Workspace Service owns logical terminal IDs and client attachments. For agent
sessions that must survive PTY-host replacement, run the command under a
workspace-side session supervisor such as tmux initially, or implement an
equivalent durable process supervisor later.

Use `@xterm/headless` plus serialization, or an equivalently tested snapshot
model, to restore screen state on client reconnect. A raw byte ring alone is not
sufficient if replay begins in the middle of an alternate-screen or escape
sequence. Pin public package versions and upgrade them through the terminal
matrix; never chase VS Code's internal source layout release by release.

The ownership boundary is:

```text
xterm.js       rendering, cursor, selection, composition UI, mouse encoding
CCC transport  ordered bytes, flow control, reconnect sequence, resize messages
workspace svc  PTY creation/lifetime, rows/cols, process tree, exit state
```

For local PTY creation, select one maintained cross-platform PTY implementation
and test its native packaging separately. A plain `child_process` pipe is not a
terminal and will break interactive programs. Remote containers must also be
entered with a real PTY, not a pair of ordinary stdout/stdin pipes.

#### Korean and other IME input

- Let xterm.js own its hidden textarea and browser `compositionstart`,
  `compositionupdate`, and `compositionend` handling.
- CCC/global shortcuts must ignore keyboard events while `isComposing` is true
  (and the platform's composition sentinel such as key code 229). Never send
  intermediate Korean jamo as completed PTY input.
- Do not recreate the terminal component, move its hidden textarea into a portal,
  or wrap it in CSS transforms during composition. Those can move or dismiss the
  native candidate window, especially across WebView DPI/zoom boundaries.
- Keep the remote locale UTF-8 and test font fallback and cell width for Hangul,
  combining characters, emoji, CJK, and ambiguous-width glyphs.
- Encode user data to UTF-8 once at the transport boundary and preserve message
  order. Never split or reconstruct input using JavaScript character indexing.

#### Click, drag, selection, and terminal mouse mode

- Use xterm.js selection APIs; do not place a transparent gesture layer over the
  terminal.
- Preserve single-click focus/cursor behavior, double-click word selection,
  triple-click line selection, drag outside viewport with autoscroll, right-click
  context menu, and platform clipboard conventions.
- When an application enables mouse reporting (for example vim, tmux, less, or
  fzf), forward xterm.js mouse sequences unchanged. Provide and document the
  standard Shift modifier to force local text selection.
- Do not let window drag regions, split-pane resize handles, or agent-panel
  shortcuts consume pointer events that begin inside the terminal.
- Keep selection stable while background output arrives unless the terminal
  application's behavior requires otherwise.

#### Resize, flow control, and reconnect

- Use `ResizeObserver` on a stable terminal container, fit only after layout is
  measurable, coalesce resize bursts, and send exact `{rows, cols}` to the PTY.
- Bound client and service buffers. Pause or acknowledge output under pressure;
  an unbounded build log must not freeze the WebView or exhaust memory.
- Sequence output frames. On reconnect, request missing frames from a bounded
  ring buffer or send a serialized headless terminal snapshot plus subsequent
  frames. Never replay an unknown prefix twice.
- A hidden tab may stop rendering but must not stop draining the PTY through the
  service-side buffer policy.

#### Required test matrix

Before the embedded terminal becomes the only access path, test:

| Area | Required coverage |
|---|---|
| OS/WebView | macOS/WKWebView, Windows/WebView2, Linux/WebKitGTK |
| Korean IME | 2-set composition, backspace during composition, candidates, paste |
| terminal apps | bash/zsh, tmux, vim/neovim, less, fzf, Claude Code, Codex |
| pointer | click focus, drag, double/triple click, Shift-select, mouse reporting |
| layout | split resize, DPI change, zoom, maximize, sleep/wake, reconnect |
| data | fast logs, binary-looking bytes, Unicode, long lines, alternate screen |

Automate PTY ordering, resize, replay, and selection regressions where possible,
but keep real OS IME tests because synthetic browser key events do not reproduce
native composition behavior reliably. Until this matrix passes, always provide
`Open in system terminal` and `Copy SSH command` recovery actions.

#### macOS WebView and desktop-shell exit criterion

Do not commit the product to Tauri solely for bundle size. On macOS, Tauri/Wry
uses the system WKWebView and does not currently offer a supported switch to an
embedded Chromium engine. The installed macOS/WebKit version therefore becomes
part of CCC's terminal compatibility matrix.

Diagnose composition failures with a strict three-step reduction:

1. test the current xterm.js demo in standalone Safari with the same Korean IME;
2. test an otherwise empty Tauri window containing one stable xterm.js instance
   connected to a local PTY; and
3. test the full CCC layout and global shortcut layer.

This distinguishes xterm.js/WebKit behavior from Tauri integration and CCC UI
bugs. Common symptom mapping is:

| Symptom | Likely integration fault |
|---|---|
| separated jamo | keydown data sent before composition completion |
| duplicated syllable | both composition/input and custom key handler send data |
| final consonant lost or moved | trusting event data instead of final textarea value |
| Enter or Backspace acts twice | global shortcut runs during composition |
| candidate window jumps | hidden textarea moved by remount, portal, transform, zoom, or DPI |

Use a current pinned xterm.js release because its composition helper contains
specific handling for Korean final-consonant movement and delayed textarea
updates. CCC shortcut handlers must allow xterm.js to receive events when
`isComposing` is true or the platform reports key code 229. They must not call
`preventDefault`, send input, or execute commands in that state.

If the minimal Tauri harness still fails on any supported macOS version and no
bounded upstream fix exists, use Electron/Chromium for the desktop shell rather
than maintaining a private xterm.js or WebKit IME fork. For this product, correct
terminal input is more important than Tauri's smaller bundle and memory profile.
A native macOS terminal view is another possible fallback, but it creates a
second frontend implementation and is not the preferred MVP path.

### Concurrent human and agent edits

An agent can modify a file while it is open in the editor, so last-writer-wins is
not acceptable. `read` returns content plus a revision token. `write` supplies
the expected revision:

```text
read(path) -> { content, revision }
write(path, content, expectedRevision) -> saved | revision-conflict
watch(path) -> { newRevision, source: user | agent | external }
```

If the editor buffer is clean, an external agent change reloads automatically
while preserving cursor intent. If the buffer is dirty, CCC freezes automatic
save and presents `Compare`, `Keep mine`, `Accept agent`, and `Merge`. Agent
operations publish the files and revision range they changed so the UI can show
a reliable change set instead of inferring it only from timestamps.

### Information architecture

The infrastructure management view remains available outside the workspace.
Use a compact developer-infrastructure layout rather than a marketing-style
dashboard:

```text
+-------------------------------------------------------------------+
| CCC Remote                 connection health       account/settings|
+----------------+--------------------------------------------------+
| Workspaces     | Workspace: api-service         [Open] [Terminal]  |
| Hosts          | Host: gpu-box · Online · Direct · 18 ms           |
| Activity       | Runtime: container · Running · 8 CPU · 24 GB      |
|                +--------------------------------------------------+
|                | Overview | Sessions | Ports | Git | Logs          |
|                |                                                  |
|                | durable sessions / recent activity / diagnostics |
+----------------+--------------------------------------------------+
```

Primary views:

1. **Workspaces:** searchable list with host, runtime, Git branch, state, active
   agent/session, last activity, and primary `Open` action.
2. **Workspace detail:** overview plus sessions, forwarded ports, remote Git
   status, logs, resource usage, stop/rebuild/destroy actions.
3. **Hosts:** connectivity path, latency, daemon/runtime versions, CPU/RAM/GPU,
   disk pressure, capabilities, assigned workspaces, update and diagnose.
4. **Activity center:** durable operation queue for provision, start, rebuild,
   reconnect, download, and failure history. Long operations must remain visible
   after navigation.
5. **Settings:** identity, connection preference, SSH keys/device certificates,
   editor choice, update channel, telemetry, and advanced diagnostics.

The default workspace action opens the CCC IDE. Its adjacent menu offers
`CCC Terminal`, `VS Code`, `Copy SSH command`, and `Open forwarded app`.
Destructive actions never occupy the primary action position.

### Host enrollment wizard

The GUI should turn manual network and agent setup into one guided transaction:

1. choose `This machine`, `Existing remote machine`, or later `Managed host`;
2. enter an SSH/Tailscale address or redeem a one-time enrollment code;
3. verify host identity and show the fingerprint before trust is persisted;
4. inspect OS, architecture, container runtime, KVM, GPU, disk, and ports;
5. install or upgrade `cccd` with explicit user approval;
6. run a health check and explain any degraded capability;
7. create the first remote-authoritative workspace from a Git URL or empty
   directory; and
8. open CCC Terminal or hand off to VS Code.

Each completed step is resumable and idempotent. A failure appears beside the
step with `Retry`, `View details`, and a concrete manual recovery command. The
wizard must never reduce host-key mismatch, authentication failure, daemon
version mismatch, and runtime failure to the same generic "connection failed".

### Status model and interaction rules

Host transport state and workspace state are separate:

```text
Host:       enrolled -> resolving -> connecting -> authenticating -> online
                         |              |                |
                         +---------- offline/degraded/action-required

Workspace: absent -> provisioning -> starting -> ready -> stopping -> stopped
                         |             |
                         +--------- failed/recovering
```

- Show text and icon in addition to color for every state.
- Show whether the path is direct, peer relay, hosted relay, or bastion because
  it explains latency and throughput.
- Operations over 300 ms show progress; uncertain completion is `verifying`,
  not success.
- Errors are announced accessibly and always include a recovery action.
- All core actions are keyboard reachable with visible focus states.
- Use stable resource IDs as UI keys and virtualize large workspace/log lists.
- Prefer restrained dark/light developer themes, high contrast, and a single
  green accent for healthy/running actions; do not use decorative motion or
  color alone as operational feedback.

### CLI and TUI parity

```text
ccc target add gpu-box ssh://user@gpu-box
ccc remote up gpu-box [--container|--vm] [--profile NAME]
ccc remote attach [SESSION]
ccc remote status [--json]
ccc sync status|flush|pause|resume|resolve
ccc git status|diff|commit       # brokered when invoked remotely
ccc port list|forward|close
ccc artifact pull|push
ccc remote stop                 # stops compute, preserves workspace
ccc remote destroy              # guarded workspace deletion
```

The always-visible TUI status strip should show target/latency, compute state,
Git branch/dirty count, active PTY, and port forwards. Optional sync state is
shown only when that later feature is enabled. `--json` schemas are versioned so
the GUI and automation do not parse prose.

## Evolution from the current implementation

The current `src/remote.ts` is a useful prototype, but it couples orchestration,
SSH shell construction, Docker, Mutagen, config, PTY, and cleanup in one client
process. It also synchronizes directly into the container writable layer and
identifies a session primarily by a local path-derived name.

Evolve it without a rewrite:

### Phase 0: remote-authoritative MVP

- Restore or create the desktop application and implement the shared
  `WorkspaceBackend`, basic editor/file tree, agent panel, and xterm.js terminal.
- Do not start Mutagen in the default product flow. Retain the existing command
  only as a clearly experimental compatibility path.
- Create or clone the Git repository into a persistent remote host workspace and
  bind-mount it into compute. Remote source and `.git` are authoritative.
- Generate a standard SSH target that works for terminal, SFTP, and a
  user-installed VS Code Remote-SSH extension.
- Provide durable terminal attach/detach, initially backed by tmux if needed.
- Add explicit artifact upload/download instead of implicit directory sync.
- Store and verify remote host, workspace, compute, image, and tool identities;
  do not reuse resources based on a path-derived name alone.
- Replace ping reachability with an authenticated SSH/agent health check.
- Add non-interactive JSON status and tests for abrupt disconnect, host reboot,
  container recreation, workspace persistence, and unauthorized attachment.

### Phase 1: daemon and durable sessions

- Introduce `cccd` with versioned authenticated RPC and transactional registry.
- Move runtime commands and workspace lifecycle to the daemon.
- Add durable PTY attach/detach, port forwarding, quotas, and rootless policy.
- Keep SSH as the initial data transport and add managed relay fallback later.

### Phase 2: optional local companion and sync

- Put Mutagen behind the sync adapter, explicitly select conflict-safe mode, and
  expose lag, flush, and conflict state.
- Add the local Git broker, remote/local Git authority modes, shadow Git view,
  and generation barriers. Never silently maintain two writable `.git` stores.
- Define `.ccc/remote.yaml` for image, resources, sync rules, setup command,
  ports, caches, and secrets by reference.
- Add reproducible image digest and environment drift reporting.

### Phase 3: VM and multi-host support

- Implement a compute adapter contract shared by containers and VMs.
- Add virtiofs/guest-agent workspace transports, GPU and KVM capability
  scheduling, snapshots, and warm pools.
- Add target selection based on declared capabilities and load without changing
  workspace/sync semantics.

### Phase 4: product polish and scale

- Optional relay transport, multi-client read-only attaches, telemetry that is
  opt-in and secret-safe, artifact retention, workspace backup/restore, and
  migration between compatible hosts.

## Remote-authoritative MVP acceptance tests

1. Open equivalent local and remote workspaces in the CCC IDE and prove file
   tree, editing, terminal, Git status, and agent controls behave consistently.
2. Create or clone a project remotely, edit and commit through the CCC IDE
   without creating a local source replica.
3. Let an agent change a dirty open file and prove revision conflict handling
   preserves both the editor buffer and agent version until the user resolves it.
4. Pass the embedded-terminal OS/WebView matrix for Korean IME, selection,
   application mouse mode, resize, high-volume output, sleep, and reconnect.
5. Open the same workspace with a user-installed VS Code Remote-SSH client and
   prove it remains a functional optional escape hatch.
6. Drop the client connection during a long AI/test command; reconnect to the
   same PTY and recover its output and exit state.
7. Kill and recreate the container; prove the remote source and Git repository
   remain intact.
8. Reboot the remote host; prove status and recovery are honest and repeatable.
9. Upload/download an explicit artifact with size limits and checksum
   verification.
10. Attempt cross-user workspace attachment, public port exposure, host mounts,
   or privileged compute without policy; prove default denial.
11. Connect without VS Code installed and prove the CCC editor, agent, and
    terminal workflow remains complete.

## Later sync-mode acceptance tests

1. Edit locally and observe the remote file; edit remotely and observe local
   `git diff`, each within the latency target.
2. Modify the same file on both sides while disconnected; reconnect and prove
   neither version is silently lost.
3. Kill and recreate the container; prove workspace content and sync identity
   remain valid.
4. Drop SSH during a long AI/test command; reconnect to the same PTY and exit
   result.
5. Change local branch and commit under a sync barrier; prove the remote shadow
   view and working tree agree.
6. Generate a multi-gigabyte dependency/build tree remotely; prove it neither
   saturates source sync nor appears locally unless pulled as an artifact.
7. Attempt to sync `.git`, expose a public port, mount a host path, or request a
   privileged container without policy; prove default denial.
8. Run local preview after a flush and prove it uses the same source generation
   reported by the remote session.

## Decision summary

Build CCC first as an agent-first desktop IDE plus local and remote workspace
services. A shared backend contract makes file editing, agent work, terminal,
and Git feel the same locally and remotely; only a location/health badge changes.
The remote-authoritative workspace persists independently of replaceable
compute, while VS Code Remote-SSH remains an optional escape hatch. Add local
mirroring only as a later mode with an explicit Git-authority contract. Keep
Tailscale, SSH, Mutagen, Docker, and Podman as replaceable adapters rather than
product-level assumptions.

## External references

- [Mutagen synchronization modes](https://mutagen.io/documentation/synchronization/)
- [Mutagen guidance for version control systems](https://mutagen.io/documentation/synchronization/version-control-systems/)
- [Docker storage and persistent volumes](https://docs.docker.com/engine/storage/)
- [Tailscale SSH authentication and authorization](https://tailscale.com/docs/features/tailscale-ssh)
- [Tailscale connection types and relay fallback](https://tailscale.com/docs/reference/connection-types)
- [Mutagen SSH transport and remote agent](https://mutagen.io/documentation/transports/ssh/)
- [CodeMirror 6 editor architecture](https://codemirror.net/docs/)
- [Monaco Editor models and providers](https://github.com/microsoft/monaco-editor)
- [xterm.js terminal component](https://github.com/xtermjs/xterm.js/)
- [VS Code integrated terminal and PTY architecture](https://code.visualstudio.com/docs/terminal/advanced)
- [node-pty OS pseudoterminal adapter](https://github.com/microsoft/node-pty)
