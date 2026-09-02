---
area: device-lab
slug: hyper-v-windows-guest-oobe-account
status: current
---

# REQ — Create the Windows guest account in the oobeSystem pass

## Requirement
`hyperVGuestProvisionCommand` (src/host-control/hyper-v/windows-guest.ts) MUST create the CCC
PowerShell-Direct account in the Windows unattend **`oobeSystem`** configuration pass — via
`<UserAccounts><LocalAccounts><LocalAccount wcm:action="add">` (member of the built-in
`Administrators` group, password supplied through the `$PasswordXml` variable, never the literal
password in the generated script). It MUST NOT rely on the `specialize` pass for account creation.

The oobeSystem Shell-Setup component carries, in schema order: `<AutoLogon>` (as the CCC user),
`<FirstLogonCommands>` (bootstrap-secret cleanup), `<OOBE>`, and `<UserAccounts>`. Nested elements
MUST also follow the Windows unattend schema order:

- `SynchronousCommand`: `CommandLine`, `Description`, `Order`.
- `OOBE` retained subset: `HideEULAPage`, `HideLocalAccountScreen`,
  `HideOnlineAccountScreens`, `ProtectYourPC`. It MUST NOT emit `SkipMachineOOBE` or
  `SkipUserOOBE`.
- `LocalAccount` without a Description: `Password`, `DisplayName`, `Group`, `Name`.

### First-logon program delivery

`FirstLogonCommands/SynchronousCommand/CommandLine` is limited to **1024 characters** by the
unattend schema. The generated value MUST stay within that limit after XML decoding and MUST NOT
carry an inline `-EncodedCommand` payload.

The first-logon program (guest network bootstrap + bootstrap-secret cleanup) is therefore carried as
its own fixed-name entry `ccc-first-logon.ps1` on the same `CCC_UNATTEND` ISO as the answer file. The
`CommandLine` holds only a bounded launcher that:

- resolves the provisioning media by **volume label** (`Win32_LogicalDisk` `DriveType=5` where
  `VolumeName -eq 'CCC_UNATTEND'`) and never assumes a drive letter;
- exits **3** when the labeled volume count is not exactly 1, and **4** when
  `ccc-first-logon.ps1` is absent from it — both fail closed;
- runs PowerShell with a process-scoped `-ExecutionPolicy Bypass` only; it MUST NOT call
  `Set-ExecutionPolicy` or otherwise change machine policy.

The launcher and the ISO script MUST contain no credential material. The guest password continues to
travel only through the `$PasswordXml` variable inside the answer file itself.

## Why
The zero-config `windows-server` path auto-downloads the Microsoft Windows Server 2025 **evaluation
VHD**, which `hyperVAcquireBaseImageCommand` stores as-is (download + hash validation, no
sysprep/generalize). That VHD is **specialized** — its `specialize` configuration pass already ran
during Microsoft's image build and does NOT re-run on first boot. The previous design created the
CCC account with a `specialize`-pass RunSynchronous command, so on the specialized eval VHD the
account was never created; the oobeSystem `AutoLogon` then targeted a nonexistent user and the guest
stalled at OOBE — never reaching PowerShell Direct (`hyper-v-diagnostic-integration-services-incomplete`,
only VSS integration service, heartbeat null, 20-min boot timeout).

Creating the account in `oobeSystem` runs on BOTH the specialized evaluation VHD (windows-server
auto path) and a generalized source VHDX (windows-11 `--source-image`), so a single provisioning
flow serves both profiles.

## Invariant / consistency
- The literal guest password never appears in the generated provisioning script (only the
  `$PasswordXml` PowerShell variable, interpolated at runtime); [[[password-non-leak assertions]]]
  in device-lab-hyper-v-provider.test.ts remain green.
- DVD delivery (Autounattend.xml + unattend.xml on the `CCC_UNATTEND` ISO via Add-VMDvdDrive),
  credential Export-Clixml, FirstBootDevice/SecureBoot, and Enable-VMIntegrationService are unchanged.
- The ISO now carries a third entry, `ccc-first-logon.ps1`. Its name satisfies the media writer's
  entry-name contract (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) and the entry count stays within the
  writer's 8-entry / 8 MB bounds.
- Provisioning still requires the VM to be `Off` and stages the media before first boot.
- The host broker MUST advertise `hyper-v-windows-unattend-oobe-schema-v2`, and the Hyper-V level-3
  launcher MUST require that capability before starting the VM E2E. This makes an otherwise
  compatible same-version broker that predates the oobeSystem schema fix fail compatibility and
  enter the existing identity-fenced automatic restart path; rebuilding `dist` alone does not update
  an already-running Node process.

## Regression coverage
- src/__tests__/device-lab-hyper-v-provider.test.ts asserts the oobeSystem `UserAccounts`/`LocalAccount`
  design, canonical nested ordering, retained OOBE settings, absence of both `Skip*OOBE` elements,
  and absence of the old `specialize`/`Microsoft-Windows-Deployment`/RunSynchronous account creation.
- src/__tests__/device-lab-broker.test.ts and scripts/real-tests/hyper-v.test.ts assert advertisement,
  automatic same-version stale-broker replacement, and level-3 attestation of the schema capability.

## History
- v1: account created in the `specialize` pass (RunSynchronous). Worked only for generalized images;
  the specialized Microsoft evaluation VHD never ran specialize, so the guest never provisioned.
  Superseded.
- v2: account created in the `oobeSystem` pass via UserAccounts/LocalAccounts.
- v3: nested Shell-Setup children use current schema order; obsolete `Skip*OOBE`
  elements are omitted, and a dedicated broker capability prevents stale same-version processes from
  silently serving the prior generator.
- v4 (current): the first-logon program moved off the `CommandLine` onto the ISO as
  `ccc-first-logon.ps1`, leaving a 379-character label-resolving launcher in its place. This removes
  the measured 3738-character `CommandLine` that violated the documented 1024-character maximum and
  caused Windows Setup to reject the whole answer file in `oobeSystem`. Capability bumped to
  `hyper-v-windows-unattend-oobe-schema-v2`.

## Hardware evidence and deferred fallback
The real Windows-host console capture shows Windows Setup reporting that it could not parse
`D:\unattend.xml`. `D:` is the drive letter the guest assigned to the attached `CCC_UNATTEND` DVD;
ccc never emits a drive letter. The message therefore proves root-level DVD discovery and
consumption, and localises the blocker to answer-file content, not discovery.

**Root cause identified (v4).** The generated `FirstLogonCommands` `CommandLine` measured **3738
characters** for a network-configured provision (1367-character program → 3648-character UTF-16LE
Base64 → 3738-character command line), against a documented maximum of 1024. That is a schema-invalid
setting value, which is why Setup rejected the file in `oobeSystem` while still reporting successful
discovery. The v4 launcher measures 379 characters. A failure-time-only fresh-broker frame was black and was initially
misread as schema acceptance. The later 2/5/10-minute timeline disproves that inference: each frame
shows the same invalid-answer modal, now explicitly for pass `oobeSystem`; the 15-minute and terminal
black frames are display idle. The ordering edits above remain standards-aligned but are not a complete
hardware fix. The next run collects bounded, secret-redacted Panther Setup errors through a read-only
post-failure VHD mount. Offline injection into `\Windows\Panther\unattend.xml` remains deferred because
DVD discovery is already proven.
