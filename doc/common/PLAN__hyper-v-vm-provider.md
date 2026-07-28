# Hyper-V VM Provider Plan

Status: Implementation complete; real Windows-host proof pending

Implemented in the current slice:

- `windows-vm` backend discovery and Hyper-V readiness
- owner-scoped Generation 2 differencing-disk creation
- start, stop, status, and delete through the authenticated host broker
- production checkpoint create, restore, and delete through the authenticated host broker
- VM ID, name, owner marker, and disk-path fencing
- checkpoint GUID, owner-prefixed name, and broker-state fencing
- bounded PowerShell Direct guest exec, upload, and download transport
- broker-owned credential-path, local-path, and downloaded-artifact validation
- project-scoped VHDX import, SHA-256 verification, VHD validation, profile cache, and atomic manifest
- offline per-device Windows account/unattend injection with DPAPI host credentials
- bounded PowerShell Direct readiness after start
- host memory, CPU, and disk capacity checks plus owner-scoped definition/running quotas
- CCC-owned internal switch/NAT contract, atomic global IPv4 allocation, guest static-IP setup, and readiness verification
- owner-marker/path-fenced orphan VM and disk reconciliation before recreate
- packaged Level 2 scenario and `windows-vm` durability target covering every advertised capability
- source MCP, CLI schema, state inventory, and unit/broker lifecycle tests
- `linux-vm` Hyper-V profile with cloud-init, owner-scoped SSH, SCP transfer,
  static CCC NAT networking, snapshots, cleanup, and reconciliation
- packaged Linux Hyper-V Level 2 scenario and `linux-vm` durability target
- interrupted lifecycle reconciliation and bounded failure-path coverage
- `ccc devices setup hyper-v [--confirm]` diagnostic and explicit UAC-elevated,
  no-automatic-reboot feature enablement
- official Windows Server 2025 evaluation VHDX and Ubuntu 24.04 LTS VHD automatic
  acquisition, bounded validation, profile caching, and cache-integrity checks
- one-time explicit Windows evaluation license and allowlisted Microsoft source-trust receipt
- VM incarnation fencing on every existing-device lifecycle mutation and
  mutating guest/checkpoint/file operation
- NAT instance-identity fencing and retryable last-allocation cleanup
- bounded single-session guest reads that stop at `maxFileBytes + 1` before
  replacing the host destination for Windows PowerShell Direct and Linux SSH downloads

Still required for completion:

- successful real-host Windows Level 2 and two-cycle durability proof
- successful real-host Linux Level 2 and two-cycle durability proof

## Goal

Add owner-scoped Hyper-V virtual machines to the existing `device-lab` system.
CCC must provision, operate, verify, recover, and delete disposable Windows and
Linux guests without requiring users to operate Hyper-V Manager manually.

## Fixed Architecture

- Keep one public MCP surface: `device-lab`.
- Add the public backend `windows-vm`.
- Keep the public backend `linux-vm`. On supported Windows hosts it uses the
  hidden `hyper-v` provider; on Linux it retains its current provider.
- Keep `windows-sandbox` separate. A Sandbox does not provide the persistence,
  checkpoint, image, and lifecycle guarantees of a full VM.
- Treat `hyper-v` as an implementation provider, not a public guest type.
- Route all mutating host operations through the authenticated device broker.
- Send owner authentication tokens only to the fixed CCC loopback/container-host
  broker candidate set; caller-supplied arbitrary hosts fail before owner
  resolution or authenticated RPC.
- When a verified CCC broker process owns the configured port but no longer
  answers health probes, revalidate that exact process identity before every
  termination signal, verify release, and relaunch it instead of starting a
  second listener on the occupied port.
- Run bounded image acquisition and preparation outside the broker event loop
  so health and owner-resolution endpoints remain responsive throughout the
  operation. One absolute six-hour server deadline covers host-lock and
  image-lock waits, acquisition, chunked copy/hash work, VM creation,
  provisioning, and rollback; every subprocess and file chunk consumes only
  its remaining budget. Create operations reserve the final five minutes for
  identity-fenced rollback instead of allowing provisioning to consume it.
  Start and reboot share one bounded provider-plus-guest-readiness deadline.
  The outer MCP client deadline must exceed the complete broker transport
  budget: host-lock wait, provider lifecycle execution, guest readiness wait,
  and the broker RPC buffer. Caller-supplied lifecycle timeouts cannot shorten
  or extend this transport envelope; provider-specific boot timeout controls
  determine the bounded operation deadline.
- Authenticated lifecycle RPC uses a bounded Node HTTP request transport rather
  than the runtime `fetch` implementation. This avoids Undici's independent
  five-minute response-header timeout while retaining an absolute RPC timer,
  redirect rejection, trusted broker-host fencing, and bounded response
  accumulation.
- Never expose arbitrary PowerShell or host shell execution through MCP.

The intended CLI surface is:

```text
ccc devices create windows-vm <name>
ccc devices create windows-vm <name> --vm-profile windows-server
ccc devices create linux-vm <name>
ccc devices create windows-vm <name> --vm-profile windows-11 --source-image <generalized-vhdx>
ccc devices status <name>
ccc devices reboot <name> --wait-for-boot
ccc devices stop <name>
ccc devices delete <name>
```

Provider selection is automatic. A provider override may exist for diagnostics,
but it is not required for normal use.

The host broker advertises `hyper-v-vm-managed-auto-images-v17`. This capability
revision changes whenever the generated Hyper-V PowerShell programs or automatic
image acquisition semantics change, even when the package version is unchanged
during local candidate testing. Host CLI and
packaged device-lab MCP compatibility checks reject and replace older broker
runtimes. Readiness failure diagnostics additionally require
`hyper-v-guest-readiness-diagnostics-v1`, so a same-version daemon started
before that contract was added is also replaced instead of silently reused.
Version 17 preserves every explicit, allowlisted Windows VM creation failure
code through the redacted broker response. Host capacity, image integrity,
disk construction, VM identity, and network selection failures therefore
remain actionable without exposing raw PowerShell output, command input, or
private host paths.
Version 15 builds provisioning media from a fenced temporary file
tree in the broker-private device root through IMAPI `AddTree`, removing the
nonstandard in-memory COM source stream path. Each source tree has a random
name, a current-user-only ACL, reparse-point checks, and mandatory cleanup on a
successful build. Internal media-build stage markers are also emitted through
the bounded broker diagnostic channel so nested PowerShell failures retain the
specific failed operation after output redaction. ISO/Joliet selection is
applied directly, with the physical-media defaults API used only as a fallback
when the COM property setter is unavailable. Volume labels are normalized to
the ISO9660 uppercase, 15-character subset; the Linux seed therefore uses the
cloud-init-supported `CIDATA` label. It retains PowerShell 5.1-safe IPv4
prefix-mask calculation, bounded long-program loading, deterministic SSH key
generation arguments, and stage-specific guest-provisioning diagnostics.

Level 3 treats missing Hyper-V management access as an explicit
`host-permission` prerequisite skip, not an unknown skip. The test command does
not elevate itself or mutate group membership. Run
`ccc devices setup hyper-v --confirm`, then sign out and back in when setup
reports that a session refresh is required; only a subsequent Level 3 run can
provide Hyper-V VM E2E evidence.

Confirmed setup crosses UAC only through the canonical Windows PowerShell
executable. Both the caller and elevated child replace `PSModulePath` with the
canonical `$PSHOME\Modules` directory, resolve DISM and LocalAccounts only from
module manifests whose absolute paths remain below that directory, and invoke
their cmdlets with module-qualified names. Resolution supports both direct
manifests and Windows' version-subdirectory module layout. This prevents a
user-writable module path from being promoted across the elevation boundary.
When this bounded setup program exceeds Windows' command-line length budget,
CCC passes the base64 program through the child process standard input and uses
only a short fixed encoded loader in argv.

The canonical executable is first located and validated through the kernel
`GLOBALROOT\SystemRoot` namespace. CCC then resolves that verified file with
the native filesystem `realpath` operation and removes only an extended DOS
drive prefix before passing it to Node process creation. Raw `GLOBALROOT` and
UNC paths are never passed to `spawnSync`; this preserves the trust boundary
without triggering Windows `EINVAL` for an unsupported executable path form.

Automatic image acquisition accepts only the fixed Microsoft Evaluation Center
redirector and Canonical release endpoints plus their explicit redirect
allowlists. The Canonical release URL and SHA256 digest are pinned in source;
changing either requires a reviewed code change. Canonical archives contain
only a bounded number and total size of regular files/directories with relative,
non-traversing, non-duplicate paths. After extraction, CCC rejects reparse
points and requires the regular-file count, each file size, and total extracted
bytes to match the validated archive metadata before converting the VHD. Microsoft
does not publish a digest alongside the mutable evaluation redirect, so this is
explicitly an HTTPS/TOFU trust boundary rather than a pinned image; CCC records
the resulting SHA256 in the cache
manifest and verifies it again before first use and every reuse. Host-side image
and VM disk operations reject symbolic-link or Windows reparse-point ancestors
before mutation. VM creation keeps the verified base VHDX open through
`New-VHD`, recomputes its expected SHA256 from that locked handle, and verifies
that the resulting differencing disk names the same base image as its parent.

## Initial Scope

Initial guest profiles:

- Windows 11
- Windows Server
- Ubuntu LTS

Initial capabilities:

- host readiness and VM inventory
- verified image preparation and caching
- create, start, stop, reboot, status, and delete
- bounded guest command execution
- upload and download
- production checkpoint create, list, restore, and delete
- interrupted-operation recovery and residue cleanup

Deferred capabilities:

- arbitrary operating systems without an explicit CCC profile
- VMConnect GUI automation and host-side console screenshots
- GPU partitioning or passthrough
- remote Hyper-V hosts, clustering, and live migration
- nested virtualization as a baseline requirement

## Host Setup

Readiness is intentionally staged. The non-mutating
`ccc devices setup hyper-v` host diagnostic reports:

- Hyper-V module and hypervisor state
- pending reboot state
- VMMS service state
- available CPU and memory observations

The setup diagnostic does not claim to prove Windows edition eligibility or
firmware virtualization, SLAT, and DEP independently once the Windows
hypervisor is active. Its remediation text tells the operator to verify edition
and firmware support before enabling Hyper-V. Disk capacity is fenced against
the actual image/device root during image import and VM creation. The
CCC-managed virtual switch and NAT are validated or created transactionally
during network provisioning, where the concrete switch, prefix, and ownership
marker are known. `ccc devices backends` is executable discovery only;
`ccc devices smoke --real-provider` runs the provider readiness diagnostic.

An explicit `ccc devices setup hyper-v --confirm` command may request elevation
and enable required Windows features. The same bounded elevated child adds the
invoking Windows identity to the localized built-in `Hyper-V Administrators`
group by its well-known SID. It must report when a reboot or one-time sign-out
and sign-in is required to refresh the caller's access token, and it must never
reboot or sign out the host silently. After this one-time setup and any required
token refresh, normal VM lifecycle operations require no elevation or manual
Hyper-V Manager work. Readiness probes `Get-VM` access explicitly; feature,
hypervisor, and VMMS availability alone are not reported as provider readiness.
The original process queries readiness again, so elevation never writes a result
through a user-controlled path.

Windows installation media comes from the official Windows Server 2025 evaluation
VHDX alias after the user records one-time acceptance with `ccc devices setup
hyper-v --confirm --accept-windows-evaluation-license`. CCC does not silently
accept Microsoft terms. The setup output and receipt identify the Windows source
as HTTPS/TOFU rather than cryptographically pinned. Ubuntu comes from a dated Canonical 24.04 LTS cloud
image release and is verified against a release SHA-256 pinned in CCC source.
Updating the image is an explicit source change with review, not a mutable
same-origin checksum fetch.

## Broker Provider

Implement an allowlisted Hyper-V provider with these constraints:

- use structured JSON between PowerShell and Node rather than parsing display
  text
- accept typed lifecycle operations instead of scripts supplied by MCP callers
- bound execution time, output size, retries, and diagnostics
- launch provider children without interactive console windows
- serialize host-global image, switch, and NAT changes
- serialize mutations per owner and device
- enforce quotas for running VMs, vCPU, memory, and disk
- verify owner ID, device ID, VM ID, generation, path, and runtime identity before
  every destructive operation
- require the current VM incarnation ID before any mutation of an existing
  Hyper-V device; missing or stale IDs fail before provider execution

The provider exposes broker RPC operations for readiness, profiles, images,
lifecycle, checkpoints, guest operations, and cleanup. Source and packaged MCP
paths use the same broker contract.

## Images And Storage

- Store verified base images in a broker-managed shared cache.
- Permit the fixed Microsoft Windows Server redirect chain, including
  `aka.ms` as an intermediate hop only; the final response must remain an
  HTTPS `.vhdx` from the explicit Microsoft download-host allowlist.
- Load `System.Net.Http` explicitly so automatic acquisition also works in
  Windows PowerShell 5.1.
- Preserve a bounded top-level lifecycle diagnostic through the public MCP
  wrapper so image and provider failures remain actionable.
- Keep catalog downloads in the host-global cache, but store user-provided VHDX
  imports below the authenticated owner's state root so one owner cannot seed
  another owner's default image.
- Treat create output as untrusted and run owner-fenced orphan recovery when
  JSON, VM identity, or disk identity validation fails.
- Stage Windows guest downloads below the broker-owned device root, then copy
  them through a descriptor-verified project write after reparse checks.
- Read at most `maxFileBytes + 1` from the guest in one bounded session and
  reject oversized Windows and Linux downloads before replacing the host destination.
- Describe each image with a versioned manifest containing its source, hash,
  guest profile, VM generation, Secure Boot template, and licensing metadata.
- Prepare generalized base VHDX images once.
- Give automatic acquisition a four-hour transfer budget and reserve a separate
  thirty-minute outer RPC window for hashing, VM creation, and guest
  provisioning after the transfer completes.
- Create an owner-scoped differencing VHDX for each disposable VM.
- Use Generation 2 VMs by default.
- Use the Microsoft Windows Secure Boot template for Windows guests.
- Use the Microsoft UEFI Certificate Authority template for supported Linux
  guests.
- Persist owner state atomically and preserve ownership evidence if cleanup
  cannot be proven safe.

Shared image cache state, mutable VM disks, cloud-init media, credentials,
checkpoints, operation journals, and network allocations live under the
host-only broker-private root. Project containers receive only bounded broker
APIs and non-secret owner metadata; they cannot replace authoritative Hyper-V
artifacts on the host.

## Guest Provisioning

Windows guests:

- generate unattended installation data and ephemeral local credentials
- finish provisioning without desktop interaction
- prefer PowerShell Direct for readiness, bounded command execution, and file
  transfer because it does not depend on guest networking
- use Hyper-V Guest Service Interface only where it provides a simpler bounded
  copy path

Linux guests:

- generate cloud-init seed data and ephemeral SSH credentials
- use Hyper-V heartbeat or KVP data for coarse readiness
- use SSH for bounded commands and file transfer
- require CCC-managed networking at create time because the typed Linux guest
  control surface depends on the owner-fenced SSH endpoint; reject
  `networking: false` before image acquisition or host resource allocation

Both paths must redact credentials, remove bootstrap secrets during teardown,
and verify guest identity before executing commands.

## Networking

- Create one CCC-managed internal Hyper-V switch and NAT.
- Protect switch and NAT creation with a host-global lock.
- Atomically persist a random bootstrap intent before the first provider call;
  bind its NAT name and switch Notes marker to that token so timeout or malformed
  output remains safely recoverable on the next invocation.
- On retry, permit adoption only when the same persisted random-token intent,
  NAT name, prefix, and switch Notes marker all match; commit the observed
  switch GUID and NAT instance identity before allocating a VM address.
- Treat the atomic network state write as the commit boundary. Once that state
  is valid, unreadable or undeletable stale intent data cannot trigger provider
  compensation or block identity-fenced reuse; stale intent removal is
  best-effort and retryable.
- Allocate owner/device-scoped MAC and IP records.
- Probe deterministic candidate addresses and MACs until an unused allocation is
  found instead of failing on the first collision.
- Persist and verify the concrete switch GUID and NAT instance identity before reuse or removal;
  retain the final allocation record until host cleanup succeeds so cleanup is
  safely retryable.
- Do not create one switch per VM.
- Do not modify external bridges or unrelated host adapters.
- Detect subnet conflicts and return actionable diagnostics.
- Keep inbound host exposure closed unless a typed operation requests an
  allowlisted forwarded port.
- Make outbound internet policy explicit in the guest profile.

## Checkpoints And Recovery

- Use production checkpoints by default.
- Permit standard checkpoints only through an explicit diagnostic override.
- Make create, start, stop, and delete idempotent.
- Treat a provider exit code of zero as insufficient for destructive cleanup:
  VM and snapshot deletion must return a structured `deleted: true` observation
  with the expected provider identity before broker state, journals, or network
  evidence is removed.
- Reconcile broker state with Hyper-V VM IDs, disk paths, locks, and credential
  records before real-provider durability runs.
- Delete only resources carrying matching CCC ownership and generation evidence.
- Recover clearly test-owned resources after crashes, but preserve foreign or
  ambiguous resources for diagnosis.
- Durability recovery requires owner device-state evidence before delegating
  host VM or network cleanup to the provider test. A state-less host VM or
  allocation is reported and preserved rather than labeled recoverable.

## Test Plan

Unit and contract tests:

- PowerShell command plans and structured response parsing
- framed result parsing for long PowerShell programs delivered as Base64 stdin
  to a bounded short `-EncodedCommand` loader, avoiding `-Command -` prompt and
  script echo that can truncate the final observation
- combined stdin framing for long PowerShell programs that also carry secret
  payloads, so the script and credential JSON cannot overwrite each other and
  credentials never enter process arguments
- complete stdout/stderr redaction for secret-bearing provisioning commands,
  including noisy PowerShell hosts that echo streamed stdin
- backend and provider enum compatibility
- image manifest, hash, and path validation
- owner, VM identity, and generation fencing
- lock contention, timeouts, malformed output, partial creation, and rollback
- refusal to mutate foreign VMs or paths
- bounded diagnostics and credential redaction

Broker integration tests:

- authenticated readiness and inventory
- owner isolation
- lifecycle, guest, and checkpoint routing
- concurrent image preparation and VM create/delete
- stale runtime and interrupted cleanup recovery
- source MCP contract coverage plus one packaged real-provider execution (the
  destructive provider scenario is intentionally not run twice)

Real-provider tests:

- Level 1: non-mutating Hyper-V readiness
- Level 2 Windows: prepare, create, boot, guest exec, reboot with guest-ready
  verification, transfer, checkpoint, restore, stop, and delete
- Level 2 Linux on Hyper-V: equivalent lifecycle using cloud-init and SSH,
  including reboot with SSH-ready verification
- Level 3 Windows: install and exercise the packaged CCC candidate in a
  disposable guest and collect artifacts
- optional nested lane: Windows Sandbox or nested Hyper-V only when explicitly
  enabled and supported
- durability: at least two consecutive Windows cycles and two Linux cycles with
  zero VM, disk, lock, credential, switch, NAT, and owner-state residue
- failure injection at image preparation, registration, boot, guest readiness,
  checkpoint, stop, and delete boundaries

## Delivery Order

1. Contracts, readiness, and fake-provider tests.
2. Broker provider core, ownership fencing, switch/NAT, and cleanup.
3. Ubuntu Hyper-V vertical slice to validate image, network, and guest transport.
4. Windows image preparation, unattended provisioning, and PowerShell Direct.
5. Checkpoints, packaged MCP parity, and Level 2/3 coverage.
6. Durability, failure injection, and operator documentation.

## Completion Criteria

- Normal operation requires no manual Hyper-V Manager action.
- Confirmed host setup performs every DISM, local-group, and Hyper-V management
  query inside the elevated child process. The unelevated launcher may determine
  only the caller SID and elevation state. It receives one bounded structured
  observation through a random named pipe restricted to elevated Administrators.
  Before reading, the launcher attests the native pipe client PID against the
  exact `Start-Process` child PID, so an unrelated local process cannot forge a
  successful observation. Elevated setup never writes through a caller-controlled
  filesystem path. The elevated child also owns a bounded watchdog and returns
  categorized errors rather than raw PowerShell records. The watchdog verifies
  both PID and process creation time before termination, preventing stale PID
  reuse from targeting an unrelated process; cleanup applies the same identity
  check to the watchdog process itself. The CLI boundary reduces all remaining
  outer PowerShell failures to an allowlisted `hyper-v-*` category and never
  prints raw CLIXML or local paths. Parsed setup observations
  reject every malformed optional field instead of relying on truthiness. This
  keeps `ccc devices setup hyper-v --confirm` usable from an ordinary terminal
  while preserving the UAC consent boundary.
- The elevated child must connect to the authenticated setup pipe before any
  DISM or account mutation. The launcher bounds this handshake separately from
  the longer feature operation, so broken IPC fails within seconds rather than
  looking like a hung installation. Existing Hyper-V installations are detected
  through `Win32_OptionalFeature`; DISM is invoked only when the feature is not
  already enabled.
- UAC elevation uses ShellExecute and therefore must not depend on transient
  parent environment variables. The validated caller SID and random pipe name
  are substituted into an immutable encoded child-script template before
  `Start-Process -Verb RunAs`; no secret or user-provided script text crosses
  this boundary. CLI error reporting recognizes a fixed allowlist of complete
  setup codes after CLIXML whitespace normalization, requires non-code token
  boundaries on both sides, and never returns partial, embedded, or extended
  matches.
- The existing device-lab surface creates and deletes Windows and Linux VMs.
- Ordinary single-host use requires no environment variables.
- MCP cannot reach a generic host shell.
- Foreign or ambiguously owned VMs are never modified.
- Success and recoverable failure paths leave no test-owned residue.
- Cross-process provider and image-preparation locks persist a process-generation
  identity in addition to the PID. Exact generation matches remain live during
  long image operations, while mismatches are reclaimed as PID reuse. Legacy
  PID-only locks are reclaimed after their stale horizon so upgrades recover
  old Hyper-V lock residue without manual state deletion. Windows identity
  probes in asynchronous provider paths use non-blocking child processes so
  broker health and RPC remain responsive. Concurrent waiters share one
  in-flight observation, and unavailable observations back off for 30 seconds
  instead of spawning an unbounded set of host probes. If identity observation is
  unavailable, live locks receive an eight-hour recovery bound, longer than
  the four-hour image acquisition ceiling but finite after a crashed owner.
- Source and packaged MCP paths behave equivalently.
- Transport failures include only the bounded final broker attempt
  (port, status/error code, duration, and timeout). Hosts, endpoints, request bodies,
  owner tokens, and unbounded process output remain excluded.
- Hyper-V provider failures preserve the last allowlisted operation stage
  (`download`, `hash`, `archive`, `extract`, `normalize`, `inspect`, `finalize`,
  VM disk creation/inspection, VM creation, or VM configuration) while
  redacting raw PowerShell input, stdout, stderr, paths, and host-local error
  text. Automatic image preparation reports that bounded stage through the
  broker instead of concatenating localized command output into the public
  error. Operation stages are accepted only from exact
  `CCC_HYPER_V_STAGE:<allowlisted-code>` stdout records; incidental text cannot
  impersonate a stage marker.
- Public redacted provider results retain only mode, provider, exit status,
  signal/timeout state, input/output-presence flags, and the bounded diagnostic
  code. Executable paths, arguments, encoded programs, raw errors, cleanup
  records, process identity, and stdout/stderr content are not returned;
  literal `[redacted]` placeholders may preserve the existing response shape.
- Hyper-V network, recovery, snapshot, delete, and state reconciliation
  failures use the same bounded diagnostic selection so rollback payloads do
  not expose localized PowerShell output or host paths.
- Guest-readiness failures use fixed PowerShell Direct or SSH reason codes and
  include only owner-fenced, bounded Hyper-V observations: VM state and uptime,
  heartbeat numeric status, attached disk/media counts, and categorical boot
  device types. They never expose VM names, disk paths, credentials, raw
  PowerShell/SSH output, or localized host errors. Failed lifecycle state follows
  the observed VM state instead of assuming a started VM remained running.
- The automatic Ubuntu profile uses Canonical's Azure VHD, so its provisioning
  media includes an Azure-compatible UDF `ovf-env.xml` with base64 cloud-config
  in addition to the generic NoCloud files. Its first NIC uses Hyper-V's
  `Default Switch` only for the Azure datasource's mandatory bootstrap DHCP
  discovery. A second NIC uses the CCC NAT switch, and cloud-init matches that
  NIC by its owner-assigned static MAC before applying the deterministic CCC IP.
  The managed NIC uses the unique guest name `ccc0`, avoiding a first-boot
  collision with the bootstrap adapter that initially owns `eth0`.
  After SSH succeeds through that address, the broker removes the named
  `Default Switch` adapter using the owner-fenced VM identity.
  Broker compatibility requires both `hyper-v-azure-ovf-seed-v2` and
  `hyper-v-azure-bootstrap-dhcp-v1`, `hyper-v-azure-local-ovf-v1`, and
  `hyper-v-bootstrap-nic-cleanup-v1`,
  preventing same-version daemons with the old single-NIC startup deadlock or
  managed-NIC `eth0` collision from being reused. First-boot readiness requests
  are bounded at 20 minutes end to end for both PowerShell Direct and SSH.
- Windows provisioning media contains both `specialize` and `oobeSystem`
  passes. The first pass makes a generalized evaluation VHD accept and cache
  the removable answer file during its actual first configuration pass and
  creates the disposable local administrator before PowerShell Direct probes
  begin. The second pass performs automatic login and secret cleanup. Broker
  compatibility requires `hyper-v-windows-specialize-seed-v1` and
  `hyper-v-windows-specialize-account-v1`.
- Windows and Linux Hyper-V durability each pass two consecutive cycles.
- Unsupported hosts return short, categorized readiness diagnostics.

## References

- Hyper-V installation and supported Windows editions:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/get-started/install-hyper-v
- Hyper-V hardware requirements:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/host-hardware-requirements
- Generation 1 and Generation 2 selection:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/plan/should-i-create-a-generation-1-or-2-virtual-machine-in-hyper-v
- Generation 2 Secure Boot templates:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/generation-2-virtual-machine-security-features
- Hyper-V integration services and PowerShell Direct:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/integration-services
- Hyper-V checkpoints:
  https://learn.microsoft.com/en-us/windows-server/virtualization/hyper-v/checkpoints
