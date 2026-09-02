---
area: device-lab
slug: hyper-v-windows-e2e-session-handoff
status: current
---

# HANDOFF — Hyper-V Windows VM E2E (`npm run test:level3:hyper-v:windows`)

Continuation note for a fresh-session agent. The Linux E2E (`:linux`) already passes end-to-end.
The Windows E2E is **not yet passing** — it now runs cleanly up to the real guest-bring-up step and
fails there. Chronological captures from the latest fresh-broker run prove that Windows Setup still
rejects `D:\unattend.xml`, now explicitly in `oobeSystem`; the later black frame is display idle, not
proof that the schema was accepted. The PowerShell Direct timeout is downstream of that open modal.

## Environment / how this is run
- Real level-3 tests run on the USER's Windows host `C:\Users\Luxus\Project\_Project\claude-code-container`.
  The dev container (Linux) CANNOT run them — we iterate by having the user paste output.
- Package version 1.1.90. Broker is a long-running elevated process (port 17373); it auto-restarts on
  a version bump. Real-test files run via a TS source loader in `run.ts`, BUT the launcher
  `scripts/real-tests/hyper-v.ts` runs WITHOUT that loader (see pitfalls below).
- Every repo-mutating change MUST go through the harness loop:
  `task_start → write_plan → implement → Agent(subagent_type:"harness:qa-cli") → task_verify(reconcile_acs:true) → task_close`.
  Close requires a fresh `runtime_verdict: PASS` + a qa-cli subagent start receipt.
- Within this ongoing Hyper-V E2E bug-fix scope, make technical decisions autonomously from the
  bounded hardware evidence. Do not ask the user to choose implementation details; ask only before a
  destructive action or material scope expansion. The user supplies Windows-host rerun output when requested.

## Fixes landed this session (all tasks closed, PASS)
1. `quiet-attest-and-unmask-pack-filename` — trimmed the ATTEST broker line; unmasked the npm-pack
   filename rejection error (`scripts/real-tests/support/level3-host.ts`, `hyper-v-windows-vm-e2e.ts`).
2. `fix-windows-npm-pack-json-object-shape` — Windows npm returns `pack --json` as an OBJECT (not
   array); `createPackagedCccCandidate` now resolves the filename shape-agnostically + falls back to
   the deterministic tarball name. (`hyper-v-windows-vm-e2e.ts` + `hyper-v-vm-e2e.test.ts`).
3. `surface-windows-guest-ready-diagnostics` — reordered the boot-diagnostic JSON so
   `diagnosticComplete/diagnosticErrors/services` survive the 511-char cap (`device-lab-mcp-client.ts`).
4. `raise-compact-reason-limit-for-diagnostics` — the level-3 reporter re-truncated FAIL reasons at
   300; extracted `compactMessage` to `scripts/real-tests/compact-message.ts` and raised the default
   to 700 so the bounded (≤511) diagnostic is fully shown.
5. `surface-windows-e2e-selected-profile` — FAIL reason now prefixes `profile=windows-11|windows-server`.
6. `prompt-windows-eval-license-at-test-run` — the launcher interactively prompts to accept the
   Microsoft Windows Server evaluation license when missing (no separate command). `ensureWindowsServerEvaluationLicense`
   in `scripts/real-tests/hyper-v.ts`; writes the receipt the broker reads.
7. `fix-launcher-src-import-esm-resolution` — removed a deep `src/device-lab/hyper-v-images.ts` import
   from the launcher (it broke under native ESM on Windows); the launcher now uses only the leaf
   `hyper-v-image-contracts.ts` and inlines receipt read/write.
8. `extract-select-windows-profile-leaf` — moved `selectHyperVWindowsProfile` into a loader-free leaf
   `scripts/real-tests/select-windows-profile.ts` (only fs/os/path + `ownerId`) so the launcher loads
   under native resolution; `hyper-v-windows-vm-e2e.ts` re-exports it.
9. `windows-guest-oobe-account-provisioning` — moved CCC guest-account creation from the `specialize`
   pass to the `oobeSystem` pass (`<UserAccounts><LocalAccounts>`), see
   [[hyper-v-windows-guest-oobe-account]]. Because the eval VHD is specialized, specialize never
   re-runs.
10. `capture-hyper-v-windows-guest-console-on-e2e-failure` — added a bounded, test-harness-only
    Hyper-V WMI console capture before failure cleanup. Post-create failures now put
    `guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png` (or a bounded
    `unavailable(...)` code) immediately after `profile=` in the compact FAIL reason. A validated
    640×480 PNG is also retained with a timestamped filename. The original readiness failure and
    force-stop/delete cleanup remain authoritative; console images stay local under gitignored
    `results/` and are never uploaded automatically. See
    [[hyper-v-windows-e2e-console-capture]].

## Historical failing observation before the schema correction
```
profile=windows-server; start and wait for PowerShell Direct: hyper-v-guest-not-ready:
boot={... state:"Running", uptimeMs:~1201000 (=bootTimeoutMs 1200000 → 20min), generation:2,
secureBoot:true, heartbeat:null, heartbeatStatus:[null,null], diagnosticComplete:false,
diagnosticErrors:["hyper-v-diagnostic-integration-services-incomplete"],
services:[["VSS",true,null]], disks:1, dvds:1, controllers:["scsi"], boot:["unknown","hard-disk","network"]}
: {port:17373, status:502, durationMs:~1207000}
```
`profile=windows-server` confirms ccc auto-downloaded + used the Microsoft Windows Server 2025
**evaluation VHD** (license accepted; image prepared; VM booted). So it is NOT a cached/non-generalized
windows-11 image and NOT a license/prep issue — it is the guest failing to become PowerShell-Direct-ready.

The first run after fix #10 reached the capture path but returned:

```text
guestConsole=unavailable(hyper-v-console-rgb565-invalid)
```

This proves the exact VM/realized-setting WMI path reached RGB565 extraction or conversion, but the
old code collapsed ImageData extraction, byte-count mismatch, and Bitmap stride into one code. The
follow-up keeps the 640×480 method and PNG contract, reads `ImageData` explicitly as `byte[]`, and
adds a Node-validated suffix containing only `sync|async`, `extract|byte-count|bitmap-stride`, the
allowlisted raw kind, and bounded numeric observations. It deliberately does not change guest boot,
unattend, integration services, or the thumbnail API before the next evidence arrives.

The next Windows-host run returned the decisive suffix:

```text
guestConsole=unavailable(hyper-v-console-rgb565-invalid[c=sync,s=extract,k=other])
```

The WMI call completed synchronously and supplied a non-null value, but the generated PowerShell used
`$ImageValue = if (...) { $ImageProperty.Value }`. A statement-producing conditional sends the native
`byte[]` through PowerShell's success pipeline, enumerating it into an unconstrained `object[]`; the
strict type guard then correctly reported `other`. Preserve the native array identity by initializing
`$ImageValue = $null` and assigning `$ImageProperty.Value` directly inside the `if` branch. Do not
coerce `object[]` or cast before the exact type guard. The next hardware run should produce the PNG or
advance to a later bounded `byte-count`/`bitmap-stride` observation.

That fix was proved on the next Windows-host run, which advanced to:

```text
guestConsole=unavailable(hyper-v-console-rgb565-invalid[c=sync,s=byte-count,k=byte-array,b=614404])
```

The native array identity is now confirmed. A 640×480 RGB565 frame is 614400 bytes, so this Hyper-V
host returned the complete documented raw frame plus an exact four-byte compatibility surplus. The
WMI documentation does not define those four bytes, so do not call them a header or trailer. Accept
only 614400 or 614404 bytes, keep the existing row copy at source offset zero so it consumes exactly
614400 bytes, and reject every other size. Do not use `>=`, arbitrary truncation, array slicing, or an
offset-four copy. Node diagnostic validation must also treat `byte-count` failures at either accepted
size as inconsistent while allowing a later `bitmap-stride` failure to report either accepted size.
The next hardware run should publish the 640×480 PNG; inspect it before changing guest boot or
unattend behavior.

That next run successfully published:

```text
guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png
```

The synced 640×480 image shows the Hyper-V `Getting ready` splash and this Windows Setup dialog:

```text
Windows could not parse or process unattended answer file [D:\unattend.xml] for pass [specialize].
The answer file is invalid.
```

This is decisive hardware evidence that the DVD, its root `unattend.xml`, and Windows Setup
discovery all work. The former discovery/pre-OS theories are disproved. The answer file itself is
rejected before the guest can become PowerShell-Direct-ready.

The first rerun after the schema-order edit showed the same dialog, but its ATTEST line also exposed
that it was not a valid test of the edit:

```text
ATTEST Hyper-V broker pid=36044 startedAt=2026-08-27T04:32:15.188Z
```

That is the exact broker identity used by every earlier run. The launcher rebuilt `dist`, but package
version remained `1.1.90` and the unattend edit had not advanced a required broker capability, so the
compatibility check reused the already-running Node process. The old generator produced the same old
ISO. Add and require `hyper-v-windows-unattend-oobe-schema-v2`; the next run is valid only if ATTEST
shows a different PID or `startedAt` before the guest result.

## Attempted schema correction (still incomplete)
- `hyperVAcquireBaseImageCommand` (`src/host-control/hyper-v/images.ts`) only DOWNLOADS + hash-validates
  the eval VHDX — it does NOT sysprep/generalize. Microsoft's eval VHD is **specialized**.
- Windows Setup discovered `D:\unattend.xml` and rejected its schema. Two nested Shell-Setup fragments
  were corrected to the ordering in Microsoft's published examples:
  - `SynchronousCommand` used `Order → Description → CommandLine`; the schema order is
    `CommandLine → Description → Order`.
  - `LocalAccount` used `Name → DisplayName → Group → Password`; without Description, the schema order
    is `Password → DisplayName → Group → Name`.
- `SkipMachineOOBE` and `SkipUserOOBE` are absent from the current OOBE child contract; remove them.
  Their individual responsibility for the exact parser error is not claimed until the next run.
- The dialog's `pass [specialize]` text is Windows Setup's processing context, not evidence that the
  generated file contains a specialize settings block. Keep CCC account creation in oobeSystem.
- The next fresh run proves those edits were not sufficient: Setup now names `oobeSystem` in the same
  invalid-answer modal. Do not call this blocker resolved or infer success from a black late frame.
- `services=[["VSS",true,null]]` and heartbeat null remain consequences observed while Windows Setup is
  stopped on the invalid-answer-file dialog; PowerShell Direct cannot become ready in this state.

## Superseded failure-time-only inference (2026-08-29)

The current broker was fresh and therefore exercised the corrected generator:

```text
ATTEST Hyper-V broker pid=14844 startedAt=2026-08-29T12:50:20.554Z
error=powershell-direct-timeout
uptimeMs=1176225
durationMs=1226781
guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png
```

The synced 640×480 failure-time PNG was completely black. It was initially interpreted as schema
acceptance, but the subsequent chronological captures disprove that interpretation. Keep the bounded
probe implementation as a useful transport hardening, but do not treat the outer timeout as the
current guest root cause.

The former `hyperVGuestReadyCommand` called `New-PSSession -VMId` synchronously inside its retry
loop. VMId sessions do not support `-SessionOption`, so one connection attempt could monopolize the
whole 20-minute deadline. The implementation now uses the supported
`Invoke-Command -VMId ... -AsJob` form, followed by a 15-second `Wait-Job`, `Receive-Job` on
completion, and force-removal in `finally`. A timed-out attempt is preserved as
`powershell-direct-attempt-timeout` so the loop continues and returns structured evidence.

## Latest chronological hardware evidence (2026-08-29)

The newest run used another fresh broker:

```text
ATTEST Hyper-V broker pid=41208 startedAt=2026-08-29T15:36:09.982Z
error=powershell-direct-timeout
guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png
```

The retained 2-, 5-, and 10-minute frames all show:

```text
Windows could not parse or process unattended answer file [D:\unattend.xml] for pass [oobeSystem].
The answer file is invalid.
```

The 15-minute and failure-time frames are black because the display idled while the modal remained
unhandled. DVD discovery is still proven, but schema acceptance is not. Microsoft's current reference
confirms the retained settings and nested examples individually; the modal does not identify the
rejected setting/value. The harness now fixes the exact OS VHD path, stops the already-failing exact
VM, detaches only that verified drive, retries the read-only mount within a bounded window, filters
bounded relevant Panther/UnattendGC Setup lines, redacts secrets twice, conditionally dismounts, and publishes
`results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json`. This is observation only;
offline unattend injection remains forbidden.

## Recommended next steps (in order)
1. Run the bounded-retry build. On failure, use either
   `guestSetupDiagnostics=results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json` or
   the validated `mount-failed[a=...,c=...,h=...]` suffix as the next evidence.
2. If JSON exists, use its exact component/setting/error as the basis for the next minimal XML
   correction. If the suffix appears, diagnose the persistent host mount category/HResult without
   exposing or guessing from raw exception text.
3. Do not inject unattend into Panther: root DVD discovery is already proven. `Mount-VHD` is allowed
   only for the new post-failure read-only log observation.
4. Do not investigate integration-service or PowerShell Direct behavior until the Setup modal is gone
   throughout the 2/5/10/15-minute timeline. A future `.psm1` edit still requires its manifest sha256.

## Latest diagnostic hardware evidence (2026-08-30)

The next fresh-broker run (`pid=13468`, `startedAt=2026-08-30T05:15:33.208Z`) returned:

```text
guestSetupDiagnostics=unavailable(hyper-v-setup-diagnostics-mount-failed)
```

Exact VM identity, the single OS drive, and shutdown completed before this stage. The VHD was still
configured as the VM's `VMHardDiskDrive`, so the failure-only diagnostic now performs a read-only
preflight to fix the exact owned path, repeats GUID/name/Notes/path checks, removes only that drive,
then mounts the file read-only. It deliberately does not reattach: broker `device_delete` permits zero
attached disks and independently removes the canonical VM and disk artifact. Detach-aware secondary
cleanup uses the preflight path so a killed PowerShell cannot lose the host mount.

## Detached-mount convergence evidence (2026-08-31)

The first rerun with exact-drive detach still returned:

```text
guestSetupDiagnostics=unavailable(hyper-v-setup-diagnostics-mount-failed)
```

This is later evidence than the original attached-drive failure. The helper returns that structured
code only after detach-aware recovery succeeds, so the VM had zero remaining hard drives and the
later exact `Get-DiskImage` observation proved the expected VHD was `Attached=false`. The immediate
`Mount-VHD` nevertheless failed. That is consistent with a short Hyper-V handle-release delay, but
does not prove the cause. The next increment keeps every identity/path/detach guard, retries only the
read-only mount up to ten times with nine one-second waits, and emits a Node-validated category/HResult
suffix if all attempts fail. Use that suffix or the published Setup JSON as the next bounded input.

## Root cause found and fixed (2026-09-02) — unattend CommandLine length

The `oobeSystem` rejection is a **length violation**, not a pass or account-model problem. Measured
from the real generator for a network-configured provision:

```text
first-logon program:      1367 chars
UTF-16LE Base64 payload:  3648 chars
generated CommandLine:    3738 chars   (schema maximum: 1024)
```

`FirstLogonCommands/SynchronousCommand/CommandLine` is capped at 1024 characters, so the whole answer
file was invalid — which is exactly what Setup reported while still proving it had discovered and read
the file.

Fix landed in `src/host-control/hyper-v/windows-guest.ts`:
- the first-logon program is now a third ISO entry, `ccc-first-logon.ps1` (bytes unchanged from the
  previous inline program; no password, no credential material);
- `CommandLine` holds a **379-character** launcher that resolves the media by volume label
  (`Win32_LogicalDisk` `DriveType=5`, `VolumeName -eq 'CCC_UNATTEND'`), exits 3 on a non-unique match
  and 4 on a missing script, then runs it. No drive letter is ever assumed;
- broker capability bumped `hyper-v-windows-unattend-oobe-schema-v1` → `-v2`, so an already-running
  same-version broker fails compatibility and takes the identity-fenced restart path.

Local evidence: rendered answer file parses as well-formed XML; decoded `CommandLine` = 379 chars, no
`-EncodedCommand`; account/AutoLogon/OOBE/ordering unchanged; `npm run build` (includes
`test:hyper-v:static` + `typecheck:real-tests`), `eslint`, provider and broker suites green.

**Next hardware proof:** rerun `npm run test:level3:hyper-v:windows` on the Windows host. Expect the
invalid-answer modal to be gone from the 2/5/10/15-minute console timeline. If the guest still stalls,
the next bounded input is the Panther Setup JSON or the mount category/HResult suffix — not another
schema edit.

## Pitfalls / invariants for the next agent
- The launcher `scripts/real-tests/hyper-v.ts` runs WITHOUT the source loader (package.json:
  `node scripts/real-tests/hyper-v.ts`). It may import ONLY natively-resolvable modules — NO TS
  `.js`-style imports of `src/` modules (they fail with `ERR_MODULE_NOT_FOUND` on Windows). Use leaf
  modules (e.g. `hyper-v-image-contracts.ts`, `select-windows-profile.ts`).
- `.psm1` edits ⇒ update `powershell-manifest.ts` sha256. Inline `jsonScript` PowerShell (e.g. in
  `windows-guest.ts`, `lifecycle.ts`) does NOT need a manifest update.
- The unattend password must stay as the `$PasswordXml` PowerShell VARIABLE in the generated script —
  the literal password must never appear (asserted by device-lab-hyper-v-provider.test.ts).
- Provider unattend structure is spec-locked in `src/__tests__/device-lab-hyper-v-provider.test.ts`
  in two adjacent tests — "delivers the first-logon program as an ISO file so the answer file stays
  within the 1024-character CommandLine limit" and "provisions a per-device Windows guest account
  without putting its password on the command line". Update both whenever the unattend changes.
- The first-logon program is no longer inline in the answer file. It lives on the ISO as
  `ccc-first-logon.ps1`; only the bounded launcher constant
  `HYPER_V_FIRST_LOGON_LAUNCHER` goes into `CommandLine`, and it must stay ≤ 1024 characters
  (`hyperVGuestProvisionCommand` throws `hyper-v-guest-first-logon-launcher-too-long` otherwise).
- Ignore these pre-existing, env-only full-suite failures (unrelated to this work): 3 in
  `src/__tests__/chrome-devtools-integration.test.ts` (needs Chrome DevTools MCP), 2 in
  `claudep/test/{index,runner}.test.ts` (fake claude binary / PATH).
- After each real-hardware change, tell the user to re-run `npm run test:level3:hyper-v:windows`; the
  broker auto-restarts on a version mismatch or a missing required capability; a source-loader-only
  harness change needs no broker restart.

## Fastest way to resume
Run `npm run test:level3:hyper-v:windows` on the user's Windows host with the locally verified bounded
mount retry. Paste the full SUMMARY/FAIL line and, if present, the contents of
`results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json`. Use the filtered Panther
error or validated mount category/HResult suffix to select the next fix. Do not add Panther injection
based on the disproved discovery theory.
