# Hyper-V VM Provider Plan

Status: Implementation complete; real Windows-host proof pending

Implemented in the current slice:

- package-owned PowerShell command assets with a versioned JSON stdin contract,
  native PowerShell parser validation, pinned Windows PSScriptAnalyzer/Pester
  CI, and npm package inclusion
- migrated Linux bootstrap address discovery and guest boot diagnostics, with
  TypeScript retaining owner identity validation and PowerShell rejecting
  missing or additional contract fields
- `windows-vm` backend discovery and Hyper-V readiness
- owner-scoped, profile-selected VM generation with independent-disk creation
- start, stop, status, and delete through the authenticated host broker
- production checkpoint create, restore, and delete through the authenticated host broker
- VM ID, name, owner marker, and disk-path fencing
- checkpoint GUID, owner-prefixed name, and broker-state fencing
- bounded PowerShell Direct guest exec, upload, and download transport
- broker-owned credential-path, local-path, and downloaded-artifact validation
- project-scoped VHDX import, SHA-256 verification, VHD validation, profile cache, and atomic manifest
- per-device Windows account provisioning from owner-scoped unattend ISO with
  DPAPI host credentials
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
  Hyper-V reboot remains graceful by default. Destructive Linux Level 3 tests
  request `force=true` explicitly because a cloud image may not expose the
  shutdown integration service before CCC readiness. Start and restart failures
  emit distinct allowlisted provider diagnostics before guest polling.
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

The host broker advertises `hyper-v-vm-managed-auto-images-v20`. This capability
revision changes when automatic image acquisition semantics change, even when the
package version is unchanged during local candidate testing.

It is deliberately **not** bumped for every edit to a generated Hyper-V
PowerShell program — an earlier version of this sentence claimed that and a dozen
subsequent commits did not honour it, which is worse than no rule. The asset
chain is covered instead by the capability that owns whatever changed: the pinned
`Invoke-HyperVWindowsOperation.ps1` moves with `hyper-v-windows-library`, and a
manifest entry appearing or disappearing moves with the capability whose feature
added or retired it. Both are what reject a stale broker whose compiled manifest
disagrees with the assets on disk — a mismatch otherwise surfaces as an opaque
sub-second `hyper-v-windows-transport`, or a raw ENOENT from manifest
verification, rather than as a named missing capability. Host CLI and
packaged device-lab MCP compatibility checks reject and replace older broker
runtimes. Readiness failure diagnostics additionally require
`hyper-v-guest-readiness-diagnostics-v24`, so a same-version daemon started
before that contract was added is also replaced instead of silently reused.
v17 additionally requires the Windows readiness script to emit its structured
failure on every exit path rather than only the deadline one, and the not-ready
payload to carry `errorDetail`; a v16 broker answers
`powershell-direct-unavailable` for causes it can now name.
v19 requires readiness to hold the provisioning media until the guest proves
the first-logon program ran, and to refuse the attempt **before** it removes
that media. A v17 broker removed the DVD and deleted the ISO on the first
successful PowerShell Direct probe, which becomes true as soon as the OOBE
account exists; the first-logon program is loaded from that media, so it could
exit 3 and the scrub never ran. Nothing read that exit code, so a guest kept
its autologon password with no signal at all.

Proof is a completion marker, `HKLM\SOFTWARE\ccc\FirstLogonCompleted`, written
as the **last** statement of the first-logon program. Absence of the secrets is
not proof and is not treated as proof: with `LogonCount 1` Windows itself
decrements `AutoLogonCount` to zero and drops `DefaultPassword` and
`AutoAdminLogon` during the autologon — possibly before `FirstLogonCommands`
runs at all — and Setup redacts its own cached answer file. All three absence
signals are therefore reachable without ccc, so a gate built on them alone
could certify a scrub that never happened. Windows cannot produce the marker.

What the marker proves is bounded, and the bound matters: every statement in the
program runs under `SilentlyContinue`, so reaching the marker means each one was
**attempted**, not that it succeeded. A `Remove-ItemProperty` blocked by an ACL
is silent and the marker is still written. The credential material is covered by
the second gate, which re-observes it independently; the marker's own job is the
narrower case this contract exists for — the program never ran at all and
Windows cleared the secrets by itself. Anything holding guest admin can also
write the key, which is why the claim is "Windows cannot", not "only ccc can".

The marker's value is the incarnation's ownership marker
(`ccc-device-lab:<owner>:<device>:<incarnation>`), the same string the prelude
checks against `$Vm.Notes`, not a constant. A constant would be satisfied by any
stale copy of itself, and there is a supported way to make one: `device_create
--source-image` accepts a user-supplied VHDX and does not check for
generalization, so an image captured from an already-provisioned guest would
carry the marker into every device built from it. Keyed to the incarnation, a
stale marker belongs to a different incarnation and cannot satisfy the gate.

The marker is checked alongside, not instead of, the secrets probe, and the two
claims are deliberately different sizes. The marker says the program ran to
completion. The secrets probe says the three signals it re-tests are gone — and
only those three. The scrub clears six things (two Panther paths plus
`DefaultPassword`, `DefaultUserName`, `AutoAdminLogon`, `AutoLogonCount`); a
`Remove-ItemProperty` that failed on one of the last three is not visible to
the gate, though no password survives in that state. Both gates are fail-closed:
the secrets gate via `-isnot [bool]`, the marker gate because an absent property
stringifies to `""` and fails the comparison.

Known gap, deliberately not claimed: `C:\Windows\Panther\setupact.log` and
`Panther\UnattendGC\setupact.log` are neither scrubbed nor probed. "Scrubbed"
here means the six things the scrub clears, not that `Panther` is clean.

A guest that never completes first logon consumes the attempt budget and
surfaces as `hyper-v-guest-ready-timeout` with `reason`
`hyper-v-guest-first-logon-incomplete` or
`hyper-v-guest-provisioning-not-scrubbed`.

Both scrub gates run **ahead of the network check**, and that order is
load-bearing whenever a static address is configured — the default, since
`networking` defaults to true. In that configuration the first-logon program
assigns the address itself, as its first action, before the scrub and long
before the marker, so the network check is causally downstream of both. With
`networking: false` there is no address to check and no network gate to be
downstream of, so the ordering is moot rather than wrong. With the network check first, a launcher that
never ran left the guest on DHCP and threw `hyper-v-guest-network-not-ready` on
every attempt for the whole budget: the scrub gates were unreachable, the
containment switch never matched, and the guest stayed up with the plaintext
answer file mounted. The effect was an exact inversion — a guest whose scrub ran
perfectly got its address, reached the marker check and was contained, while a
guest whose scrub never ran was left running. Reporting a missing address as the
cause when the program that assigns it never ran is also the wrong diagnosis.

Two consequences are deliberate and worth knowing:

- **Every Windows device created under an earlier contract must be recreated —
  healthy ones included.** Provisioning happens only in `device_create`;
  `FirstLogonCommands` fires once ever, and there is no re-provision path on
  `device_start` or `device_reboot`. The capability bump replaces the broker; it
  does not touch the VHDX. So no pre-v20 guest carries a marker and none ever
  will, whether its scrub ran perfectly or never ran at all. On the first
  `device_start` after upgrade each one burns the full boot budget, fails with
  `hyper-v-guest-first-logon-incomplete`, and — since that is a contained reason
  — is powered off. The remedy is `device_delete` and recreate.

  This is fail-closed by choice, and the cost is deliberate: the entire premise
  of this contract is that a pre-v20 guest's absent secrets prove nothing, so
  admitting one on that evidence is precisely the false certification the marker
  exists to prevent. For the duration of the migration the containment path is
  therefore the common case, not the exceptional one.
- v20 contains that failure rather than leaving it running, but only for the two
  reasons that prove the guest holds a live secret:
  `hyper-v-guest-first-logon-incomplete` and
  `hyper-v-guest-provisioning-not-scrubbed` force-stop the VM. Otherwise the
  guest would sit there refused — so nobody looks at it — with `AutoAdminLogon`
  set, `DefaultPassword` in Winlogon, a desktop session as a local
  Administrator, and `CCC_UNATTEND` still mounted carrying the plaintext answer
  file, until someone ran `device_delete`.

  Containment is deliberately **not** widened to every readiness failure, unlike
  the `linux-vm` lane: powering off an ordinary boot timeout or network mismatch
  destroys the state needed to diagnose it. Both halves are pinned by test — the
  two reasons must leave the guest `Off`, a `powershell-direct-attempt-timeout`
  must leave it `Running`.

  If the force-stop is not confirmed, the readiness reason is preserved
  (replacing it the way the linux lane does would discard the diagnostic that
  selected the path) and `scrubContainmentFailed: true` appears in the failure
  detail and in the persisted `lastBootCheck` — the HTTP response alone is not
  enough, because the caller's own timeout can expire while containment runs.
  "Not confirmed" is deliberately broader than "still running": the stop may
  never have been attempted (the cleanup deadline can throw first), or it may
  have powered the guest off and returned a confirmation that did not parse or
  did not match the expected `vmId`/`vmName`. The flag licenses "go look", not
  "it is definitely still up". It is present only when true.

  Containment runs **after** the boot diagnostic. Taken the other way round,
  every contained case would record a post-mortem of a machine ccc had just
  powered off — the diagnosability this narrow scope exists to preserve. The
  consequence is that on a contained failure the recorded diagnostic reports
  `Running` while `runtimeState` reports `Off`; that pair is the evidence of
  the ordering, not a contradiction to reconcile by moving the capture.

  `windows-vm` also takes `CLEANUP_RESERVE_MS`, as `linux-vm` does. The reserve
  is added to the cleanup deadline and subtracted from the provider deadline, so
  the usable operation budget is unchanged and only the outer window grows.
  Without it, a boot timeout near the residual budget lets the deadline throw
  and replace the readiness result with `hyper-v-operation-deadline-exceeded` —
  the un-scrubbed reason containment switches on is gone before containment
  reads it. The packaged MCP client's automatic RPC timeout carries the same
  reserve, or the reply carrying `scrubContainmentFailed` is dropped in transit.

  `waitForBoot: false` is rejected for `windows-vm`, as it already was for
  `linux-vm`. Readiness is now the only place the provisioning media is removed
  and the only place containment runs, so skipping it returned `200 success`
  with the guest running and `CCC_UNATTEND` still mounted — a DVD carrying the
  local Administrator password in plaintext — with no failure and nothing to
  report. Moving the scrub guarantee onto readiness is what turned that from a
  fast path into an open door.

  Two residuals of this scope, stated rather than implied:

  - **Containment covers proof of un-scrubbed, plus every failure on a guest
    that has never been scrubbed at all.** The two named reasons require the
    PowerShell Direct probe to have landed. When it never lands —
    `powershell-direct-attempt-timeout`,
    `powershell-direct-authentication-failed`,
    `powershell-direct-session-unavailable`, `powershell-direct-unavailable` —
    the reason proves nothing, and scoping containment to proof alone left the
    most likely failure of a fresh VM's first start (a stalled OOBE) running in
    its default state: plaintext answer file on the mounted ISO, live
    `DefaultPassword`.

    The host cannot ask a guest whose probe is down, and does not need to. The
    provisioning ISO is deleted as soon as both scrub gates pass, so the ISO
    still being on disk means no readiness ever got past them — and the ISO is
    itself the plaintext residue. So any readiness failure with the media still
    retained contains. Once the media is gone there is nothing left to contain,
    and an ordinary boot timeout on an already-scrubbed guest stays Running and
    debuggable, which is the point of the narrow scope. An unreadable media path
    counts as present: unreadable is not proof of absence, and `existsSync`
    cannot express that (it answers `false` for every error, including a
    permission failure), so the check uses `statSync` and treats only
    `ENOENT`/`ENOTDIR` as gone.

    Media-presence alone is still not sufficient, because the deletion itself
    can fail — a locked file, an ACL, a rejected reparse path — on a guest that
    is demonstrably clean. Those failures surface under at least three different
    reason codes, so they cannot be recognised by matching reasons. The readiness
    script therefore latches `scrubConfirmed` the moment both scrub gates pass
    and reports it on every failure payload; it vetoes the media-retained arm —
    but only together with `mediaDetached`, a second latch set once the DVD is
    actually gone from the VM. `scrubConfirmed` says the guest's registry and
    Panther are clean; it says nothing about an ISO still mounted inside that
    guest, which carries the local Administrator password in plaintext and is
    readable by any process there. The scrub removes the autologon values, not
    the account. An ambiguous attachment or a failed `Remove-VMDvdDrive` throws
    between the two latches, which is exactly the guest that must still be
    contained. A device provisioned without media counts as detached.
    Without it, a guest whose ISO could not be deleted would be powered off on
    every start forever, since the marker persists and readiness re-runs into the
    same failure. The two named reasons still contain unconditionally — they are
    the proof of un-scrubbed. A broker that omits the field reads as `false`,
    which errs toward containing.

    Containment is also **not** gated on readiness having started. Two exits sit
    between `Start-VM` and readiness — the expired-deadline return and the
    VM-observation identity gate — and `Start-VM` issues its start before it
    re-queries, so both are reachable with the guest already booted and nothing
    contained. `windows-vm` now shares the deadline carve-out that `linux-vm`
    had, so those paths fall through to the containment decision instead of
    returning 504 over a running guest.

    A contained failure reports `mutatesHost: true`. Deriving it from `success`
    alone said the host was unchanged by an operation that had just force-stopped
    a VM. Containment is skipped entirely when the boot diagnostic already
    reports the guest `Off`: the stop command is a no-op on an Off VM but still
    returns success, which otherwise recorded a containment that never happened.

    When containment fails on a path where readiness never ran, the readiness
    execution is synthesised so `scrubContainmentFailed` still reaches the reply
    and the persisted record. Both surfaces hang off that execution, and it is
    null on exactly the paths the removed gate opened — so without this a failed
    containment there was reported nowhere at all, which is the silence this
    whole contract exists to remove.
  - **Containment uses `-TurnOff`, a hard kill.** A first boot that is merely
    slow past the budget is killed mid-script and can then never write the
    marker, because `FirstLogonCommands` fires once ever. That guest is
    unrecoverable by restart and needs `device_delete` and recreate — the same
    remedy as the migration case above, but caused by containment rather than by
    the original fault. Fail-closed, and the reason is accurate, but it is a
    cost the boot budget has to be set with in mind.
The Linux readiness contract retains the seeded host key as the only
authoritative identity. Bootstrap SSH limits
host-key negotiation to ed25519 and disables the secondary real-IP lookup only
when a validated managed-address `HostKeyAlias` is present. Strict verification
against the owner-private alias entry remains mandatory.
An SSH listener can become reachable with the image's default key before
cloud-init installs the CCC client key and seeded host key. A mismatched host
key is therefore recorded as a bounded diagnostic and retried with
`StrictHostKeyChecking=yes` until the readiness deadline. CCC never adopts an
observed bootstrap key and never writes a secondary `known_hosts` file.
The owner-private `known_hosts` entry is the single authoritative pin; the
public-key file and device-state fingerprint are derived caches reconciled from
it before validation. An interruption between writes is therefore recoverable
on the next start without trusting a second key source. The guest host private
key is never copied to the host. A failed authentication or malformed/ambiguous
key cannot alter the authoritative pin. Diagnostics retain
only adoption and comparison booleans plus allowlisted error codes; raw keys,
fingerprints, addresses, paths, and command output are discarded.
Host-key comments are metadata, not identity: v15 migration compares the
allocated address, ed25519 algorithm, and validated binary key blob so pins
written by v13 with the `ccc-host` comment reconcile without weakening key
matching.
The diagnostic operation is total after VM ownership validation: failures
from firmware, BIOS, integration-service, disk, or DVD inspection produce a
partial observation plus bounded allowlisted `diagnosticErrors`. One optional
Hyper-V cmdlet can no longer hide all remaining boot evidence or leak its raw
PowerShell error text. The observation includes the bounded UEFI/BIOS boot
entries, controller coordinates, VHD format/type/size/sector metadata, and DVD
attachment state. Host paths, VM names, credentials, endpoints, and raw command
output are excluded. A failed Linux VM real test persists the complete safe
observation to `results/device-lab-real/hyper-v-linux-diagnostic-latest.json`
and a timestamped peer, while keeping the terminal summary bounded.
Version 17 preserves every explicit, allowlisted Windows VM creation failure
code through the redacted broker response. Host capacity, image integrity,
disk construction, VM identity, and network selection failures therefore
remain actionable without exposing raw PowerShell output, command input, or
private host paths.
Version 18 removes the redundant per-VM read-only mount of a newly created VM
disk. Image preparation still derives generation from the base VHD partition
style, while each create validates manifest provenance, file identity,
SHA-256, VHD type, and parent state before using the recorded generation. This
keeps VM creation within ordinary Hyper-V management
permissions on Windows hosts where `Mount-VHD` requires separate disk
management privileges.
Version 19 writes `Autounattend.xml` at the root of an owner-scoped ISO and
attaches that ISO before the generalized guest first boots.
Version 20 requires the Hyper-V Level 3 launcher to verify both the repair
CLI's capability attestation and the capabilities returned directly by the
running loopback broker's `/status` endpoint. Provider execution cannot begin
when an older same-version broker remains on the port or reappears after
repair. The launcher matches the broker PID and start timestamp from the
initial CLI verification, direct response, and a second CLI process-identity
verification. A same-host device-lab MCP performs OS port-owner and command-line
fencing again before provider RPC; a container crossing into another host OS
cannot inspect that host process table and retains the authenticated broker
contract only for an allowlisted non-loopback host address. Container-local
loopback listeners never receive that exception. The direct response stream is
cancelled as soon as it exceeds its byte limit and is also time-bounded; a
mismatch reports only the missing and observed `hyper-v-*` capability names.
On Windows, same-host MCP verification first uses `Get-NetTCPConnection` plus
CIM command-line inspection and falls back to `netstat -ano -p tcp` when that
PowerShell inspection is unavailable. A command-line-redacted listener is
accepted only when the port-owner PID and OS process start token, persisted
broker identity, and `/status` identity all agree. Legacy runtime metadata is
migrated only when its broker start timestamp still matches `/status` and the
OS and `/status` process tokens agree. This preserves process fencing on
hosts where CIM hides command lines without treating an unverified listener as
the broker. The `netstat` parser identifies listeners by TCP local port,
zero-valued remote port, and final PID rather than the localized state label.
New MCP-owned broker launches also fetch `/status`, normalize their persisted
start timestamp and process token to the attested broker values, and apply the
same verification before the first owner RPC. Recovery and shutdown revalidate
the token immediately before signaling. Authenticated owner RPCs use a
generation-bound HMAC over the request body, broker start identity, timestamp,
and one-time nonce instead of transmitting the owner token. Windows shutdown
then acquires the process and descendant handles, compares their start times
with the fenced identity snapshot, and terminates only through those handles so
PID reuse cannot target a successor.
Version 21 reasserts the Microsoft Windows Secure Boot template and enables
Hyper-V integration services before first boot. Provisioning fails immediately
when the firmware or host-side integration-service postcondition is not met
instead of waiting 20 minutes on a VM with a known-invalid boot contract. The
provider retains the owner-scoped unattend ISO and does not mount or modify the
per-device VHD from the host.
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
changing either requires a reviewed code change. Every Canonical catalog update
must verify the downloaded generic QCOW2 without mounting the guest filesystem:

```bash
npm run test:hyper-v:ubuntu-image -- --source <downloaded-qcow2> [--qemu-img <path>]
```

The verifier binds the QCOW2 to the catalog SHA-256, confirms its QEMU format,
converts a private copy through the same fixed-VHD format and back to raw sectors,
then parses the disk's GPT and FAT32 structures
with bounded reads, and requires non-empty `EFI/BOOT/BOOTX64.EFI` and
`EFI/ubuntu/shimx64.efi` files. Microsoft
does not publish a digest alongside the mutable evaluation redirect, so this is
explicitly an HTTPS/TOFU trust boundary rather than a pinned image; CCC records
the resulting SHA256 in the cache
manifest and verifies it again before first use and every reuse. Host-side image
and VM disk operations reject symbolic-link or Windows reparse-point ancestors
before mutation. VM creation verifies the base VHDX, sequentially copies it to
an owner-scoped independent VHDX, flushes and closes both handles, validates
the clone's file length, VHDX format, virtual size, and absence of a parent,
then re-hashes the base before attaching the clone to a VM. This avoids using a
QEMU-created VHDX as a Hyper-V differencing parent.

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
- Create an owner-scoped independent VHDX clone for each disposable VM.
- Use Generation 2 for Windows, the automatic Ubuntu profile, and compatible
  explicit imports. The automatic Ubuntu path uses Canonical's Azure fixed VHD
  cloud image and converts it with Hyper-V's native disk tooling.
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

- Windows guests use production-only checkpoints. Linux guests use Hyper-V's
  production-first policy with standard-checkpoint fallback because generic
  Ubuntu images do not guarantee a running Hyper-V VSS daemon. If Hyper-V does
  not perform that fallback itself, CCC removes any partial checkpoint, retries
  once with `Standard`, and restores the VM's `Production` policy. A failed
  retry or policy restoration removes the candidate checkpoint and fails the
  operation. Snapshot creation rejects any VM already outside the managed
  `Production` or `ProductionOnly` policy, and policy restoration is confirmed
  by re-reading the VM before success is returned. If restoration cannot be
  confirmed, CCC sets and confirms `Disabled` as a fail-closed quarantine;
  inability to quarantine is reported as a distinct bounded failure.
  Before snapshot mutation the broker durably records the expected checkpoint
  policy. Provider timeout or termination triggers a separate owner-fenced
  repair command; the journal is retained until `Production`/`ProductionOnly`
  restoration is confirmed, or `Disabled` quarantine is confirmed. Ambiguous
  exact-name checkpoint candidates are preserved and block reconciliation for
  operator diagnosis. Every subsequent Hyper-V device command checks and reconciles
  this journal before touching the VM, rather than waiting for another snapshot
  command.
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
- The automatic Ubuntu profile uses Canonical's pinned generic Ubuntu Server
  QCOW2 image. Canonical explicitly documents its Azure VHD artifacts as unable
  to run on on-premises Hyper-V, so those artifacts are rejected. CCC verifies
  the dated release SHA-256, uses the Google-signed Android SDK `qemu-img` to
  convert QCOW2 sectors into a fixed VHD, normalizes that file, and then uses
  Hyper-V's native `Convert-VHD` to create the dynamic VHDX. The source URL,
  checksum, and format are
  bound into the cache manifest. The automatic Linux profile remains a
  Generation 2 UEFI VM, but
  disables Hyper-V Secure Boot because Microsoft documents that some Linux
  Generation 2 guests fail to boot while it is enabled. Windows profiles keep
  Secure Boot enabled with the Microsoft Windows template. The persisted and
  public create configuration records this decision as `secureBootEnabled`.
  Request-provided templates cannot override either backend-owned policy.
  A Secure-Boot-enabled VM requires Generation 2, so Windows Generation 1
  images are rejected before a provider command is emitted.
  Acquisition reserves the source virtual size twice, the final 32 GiB virtual
  disk size, and an 8 GiB conversion margin because the fixed VHD and its
  ordinary normalized copy overlap temporarily. Interrupted
  `.acquire-work` state is removed under the image preparation lock before a
  retry while the checksum-bound QCOW2 cache is retained.
  The catalog fences the generic QCOW2 format and Generation 2 boot contract. The
  provisioning media contains only the generic NoCloud `meta-data`,
  `network-config`, and `user-data` files. It deliberately omits
  `ovf-env.xml`: advertising the Azure datasource on the generic image can
  preempt NoCloud and leave the CCC user, authorized client key, and pinned
  host key unapplied. Cloud-config is emitted as a schema-shaped PowerShell
  object serialized to JSON (valid YAML syntax), rather than concatenated YAML;
  in particular it does not emit the invalid scalar top-level `user` field,
  whose schema requires an object. Its first NIC uses Hyper-V's
  `Default Switch` for bootstrap DHCP discovery. A second NIC uses the CCC NAT
  switch. VM creation assigns that adapter a static `06:*` locally administered
  MAC derived from the collision-fenced managed `02:*` MAC. Initial cloud-init
  networking matches only the named bootstrap adapter by that assigned MAC and
  rejects host-wide MAC conflicts or an observed identity mismatch both after
  adapter assignment and immediately before seed completion.
  It enables DHCP on that adapter and deliberately
  leaves the managed NIC unconfigured. After SSH succeeds through the bootstrap
  address, the broker writes the deterministic static `ccc0` netplan for the
  owner-assigned managed MAC, validates the generated netplan, flushes the
  configuration file to durable storage before applying it, waits for that
  address, and removes the named
  `Default Switch` adapter using the owner-fenced VM identity. This ordering
  prevents an explicit managed-only cloud-init network document from disabling
  DHCP on the very adapter needed to bootstrap SSH. Any readiness or transition
  failure removes the bootstrap NIC; if removal cannot be verified, the broker
  force-stops the VM and verifies the resulting `Off` observation so DHCP-backed
  SSH cannot remain exposed. Linux start and reboot reject `waitForBoot=false`
  because the bootstrap-to-managed transition is part of the required start
  transaction rather than optional readiness polling. Their cleanup deadline
  extends the normal provider and boot budget by a separate five-minute
  containment reserve. Cleanup identifies the adapter by its deterministic MAC,
  then verifies that no host adapter retains that MAC.
  Broker compatibility requires `hyper-v-azure-bootstrap-dhcp-v1`,
  `hyper-v-bootstrap-nic-cleanup-v1`, and the provider image finalization
  contract. The latter fences the NoCloud-only seed used by the generic
  Canonical QCOW2 image; obsolete Azure OVF seed capabilities are not
  advertised. These compatibility requirements prevent same-version daemons
  with the old single-NIC startup deadlock or
  managed-NIC `eth0` collision from being reused. First-boot readiness requests
  remain bounded at 20 minutes end to end, but Linux boot fails after five
  minutes with `hyper-v-guest-boot-signal-timeout` when neither managed SSH nor
  a bootstrap address has ever been observed. Bootstrap discovery first accepts
  Hyper-V KVP addresses and also consults the Default Switch neighbor table,
  matching only the VM's owner-fenced static bootstrap MAC and the host switch
  prefix and interface index. This permits first boot when the guest DHCP stack
  is active before the Linux KVP daemon reports addresses without accepting an
  entry observed on another host interface. The bounded failure payload records
  managed SSH attempts, bootstrap probe and address counts, the last probe
  status and allowlisted diagnostic code, bootstrap SSH attempts, and
  static-network finalization state without exposing addresses, paths, command
  output, or credentials.
  `hyper-v-provider-image-finalization-v39` additionally prevents reuse of a
  broker that enables Secure Boot for the automatic Linux profile, mixes an
  Azure OVF datasource into the generic NoCloud seed, emits the invalid scalar
  `user` cloud-config field, or blocks SSH activation behind online package
  updates. The Linux `CIDATA` medium contains ISO9660 and Joliet only; it omits
  UDF so cloud-init's NoCloud block-device scan identifies the attached medium
  as the required ISO9660 datasource. Windows unattend media retains the shared
  writer's ISO9660, Joliet, and UDF compatibility set.
  The pinned Ubuntu Server image already contains OpenSSH, so cloud-init
  disables package updates on the first boot, writes the owner-scoped host
  keys and bootstrap DHCP network, then enables the local SSH service without
  waiting for an archive mirror. The broker applies the static managed network
  only after bootstrap SSH is reachable. Cloud-init installs the owner-scoped
  ED25519 pair with Base64 `write_files` entries, explicit root ownership and
  `0600`/`0644` modes, validates the resulting daemon configuration, and then
  restarts SSH. Windows-generated OpenSSH private keys are normalized from
  CRLF to LF before Base64 encoding so Linux OpenSSH can parse the installed
  key. It disables automatic host-key generation instead of deleting
  keys before replacement, so a cloud-config parsing or key-installation error
  cannot leave the daemon permanently without a host key. The same contract
  rejects brokers that still acquire
  an interactive desktop VHDX or report every unexpected VM creation preflight
  failure as the initial generic stage. VM
  creation must update both its public stage marker and loader-visible stage
  state before host capacity, storage, path, VM identity, network, disk, and VM
  configuration operations. Parent-image integrity is checked immediately
  before and after creating the owner-scoped disk. The VM disk is a sequential,
  flushed clone of the verified base rather than a Hyper-V differencing disk;
  CCC closes all copy handles before `Get-VHD` or `New-VM`, then requires the
  clone to have the expected SHA-256, matching file length and virtual size,
  VHDX format, and no parent.
  The fixed VHD output is normalized into a newly created ordinary file.
  CCC rejects Sparse, Compressed, Encrypted, and ReparsePoint filesystem
  attributes, converts it once with native `Convert-VHD`, expands the resulting
  VHDX with `Resize-VHD`, and verifies it with `Get-VHD` before publication.
  It then uses the attested `qemu-img compare` implementation to compare the
  fixed VHD and final VHDX guest-visible sectors. QEMU's non-strict comparison
  permits only the resized VHDX's zero-filled tail; any changed source sector
  fails acquisition before a VM is created. Read-only source and converted-image
  handles deny writes and deletion during comparison; the converted-image handle
  remains open while CCC copies it into a newly created, similarly guarded final
  VHDX and completes final hash and `Get-VHD` validation. This binds the compared
  bytes to the file actually published to the image cache.
  The checksum-pinned Canonical QCOW2 is verified to contain both
  `EFI/BOOT/BOOTX64.EFI` and `EFI/ubuntu/shimx64.efi`. Native conversion preserves
  that guest filesystem, so acquisition
  does not mount or mutate the EFI partition and does not require Storage
  cmdlet elevation. Generation 2 VM creation passes `BootDevice=VHD` to
  `New-VM` and disables dynamic memory. The exact checksum-pinned QCOW2 and its
  fixed-VHD conversion both complete a UEFI boot under OVMF, while host
  diagnostics showed Hyper-V placing an unknown firmware file entry before the
  attached OS disk. CCC therefore sets the unique owner disk as
  `FirstBootDevice` after VM creation and again after provisioning-media
  attachment, then reads the firmware order back and rejects a path mismatch
  before starting the VM. The v30 broker contract fences out the Azure-only
  VHD source, direct QEMU VHDX generation, and brokers that leave this boot
  order nondeterministic or publish a native VHDX without content-equivalence
  verification. Broker compatibility also requires
  `hyper-v-guest-readiness-diagnostics-v24` for the bounded readiness trace.
  Linux bootstrap discovery treats the Hyper-V management-adapter view as an
  optional source: if that view fails, the provider may use only IPv4 prefixes
  from the exact `vEthernet (Default Switch)` host interface. Neighbor-table
  fallback remains fenced to that interface, the VM bootstrap adapter's exact
  MAC address, and allowlisted neighbor states.
  Bootstrap SSH retries retain only the last numeric process status and an
  allowlisted SSH failure class (`timeout`, `refused`, `unreachable`, host-key,
  authentication, missing readiness marker, or unavailable). Raw SSH output
  and the discovered bootstrap address remain outside public diagnostics.
  Cloud-init still restarts `sshd` after installing the seeded host key. While
  the running guest presents the image's earlier key, v16 keeps retrying the
  strict owner-pinned identity and never adopts the transient key.
  This revision classifies bootstrap VM-adapter, management-adapter, host-prefix,
  neighbor-table, and address-selection failures independently. The PowerShell
  operation emits only an allowlisted stage code, and the durable diagnostic
  records that code with the exit status instead of raw command output.
  Linux readiness failures classify no guest signal, failed bootstrap
  inspection, missing bootstrap addresses, unavailable bootstrap SSH, and
  failed static-network finalization separately. The compact failure and the
  durable Level 3 diagnostic retain only attempt counters, status values,
  allowlisted diagnostic codes, booleans, and elapsed time; guest addresses and
  command output remain excluded.
- Linux guest downloads to nested project directories require the destination
  file to exist before transfer. The broker opens that file without following
  links and revalidates its identity and every ancestor before writing; it does
  not create through caller-controlled intermediate directories.
- Windows provisioning media contains both `specialize` and `oobeSystem`
  passes. The first pass makes a generalized evaluation VHD accept and cache
  the answer file during its actual first configuration pass and creates the
  disposable local administrator before PowerShell Direct probes begin. The
  answer file is present on the attached owner-scoped ISO. The second pass
  performs automatic login and secret cleanup. Broker compatibility requires
  `hyper-v-windows-specialize-seed-v1`,
  `hyper-v-windows-specialize-account-v1`, and
  `hyper-v-windows-boot-contract-v1`.
- Windows and Linux Hyper-V durability each pass two consecutive cycles.
- The focused Level 3 launcher allows up to three minutes for the packaged CCC
  CLI to import, inspect, repair, and attest the host broker before provider
  execution. The broker process itself receives a separate 30-second startup
  readiness window. A failed preflight reports the bounded child status,
  signal, spawn error, and timeout instead of a generic no-output message.
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
- Canonical public image artifact compatibility:
  https://documentation.ubuntu.com/public-images/public-images-reference/artifacts/
