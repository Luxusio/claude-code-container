---
area: device-lab
slug: hyper-v-windows-e2e-console-capture
status: current
---

# REQ — Preserve a Hyper-V Windows guest-console image on E2E failure

## Requirement

When `npm run test:level3:hyper-v:windows` starts the first blocking Windows VM readiness wait, the
real-test harness MUST schedule bounded best-effort captures of the exact owner-scoped VM console at
2, 5, 10, and 15 minutes. When the E2E fails after creating its Windows VM, the harness MUST also
make the existing bounded best-effort failure-time capture before stop/delete cleanup runs. The
timeline exists because a failure-time frame can be black after the guest display becomes idle and
cannot reconstruct an earlier Setup/OOBE screen.

The capture MUST derive the VM name from `ownerId`, `deviceId`, and `incarnationId`; it MUST NOT accept an arbitrary VM name, scan all VMs, or use prefix matching. The host WMI lookup MUST resolve exactly one `Msvm_ComputerSystem` and exactly one realized current `Msvm_VirtualSystemSettingData` before calling `GetVirtualSystemThumbnailImage`.

The capture MUST:

- request a fixed 640×480 RGB565 frame;
- preserve the native `byte[]` identity of WMI `ImageData` through extraction; it MUST NOT pass the value through a statement-producing conditional or coerce it before the exact type guard;
- accept only the 614400-byte pixel frame or the observed 614404-byte Hyper-V compatibility form; in either case conversion MUST consume exactly 614400 bytes from array offset zero, MUST ignore only the exact four-byte surplus, and MUST NOT use arbitrary truncation, a generic minimum-length check, or an offset-four interpretation;
- support immediate WMI completion and bounded asynchronous job completion;
- enforce internal and host-process timeouts;
- reject missing, oversized, malformed, or wrong-dimension output;
- convert RGB565 with row/stride validation;
- validate the PNG signature and IHDR dimensions before publication; and
- publish validated evidence atomically under `results/device-lab-real/` as both a timestamped PNG and `hyper-v-windows-console-latest.png`.

Every scheduled callback MUST contain capture exceptions locally. All outstanding timers MUST be
cleared when the blocking `device_start` resolves or rejects. Successful scheduled captures retain
their timestamped PNGs for local chronological comparison; their updates to the stable `latest`
path are allowed because the final failure capture remains authoritative for the terminal field.
Scheduling MUST NOT extend the boot deadline, keep the process alive after the request settles, or
change broker/guest behavior.

## Failure and cleanup contract

Console capture is secondary evidence. It MUST NOT replace, shorten, or suppress the original E2E
failure, and an unexpected capture exception MUST be contained locally. The bounded Setup diagnostic
described below MAY stop the exact VM and detach its exact OS drive; the existing `finally` block
remains the sole owner of VM deletion and temporary-directory cleanup.

The compact FAIL reason MUST put one field immediately after `profile=`:

- success: `guestConsole=results/device-lab-real/hyper-v-windows-console-latest.png`
- failure: `guestConsole=unavailable(<allowlisted-bounded-code>)`

For an RGB565 guard failure, the bounded code MAY append a Node-validated layout suffix containing only:

- completion: `sync` or `async`;
- stage: `extract`, `byte-count`, or `bitmap-stride`;
- raw kind: `missing`, `byte-array`, or `other`; and
- bounded nonnegative byte-count or absolute-stride integers where the stage makes them meaningful.

PowerShell MUST return those observations as structured JSON. Node MUST validate the enum combination and integer bounds before formatting the terminal code. A `byte-count` failure at either accepted source size is inconsistent and MUST fail closed; a later `bitmap-stride` failure MAY report either accepted source size. Missing properties, unknown enum values, inconsistent stage/kind combinations, strings, negative/fractional/oversized numbers, and malformed layout objects MUST fail closed as `hyper-v-console-output-invalid`. Expected dimensions and byte counts are Node-owned constants, not trusted PowerShell fields.

The original step and readiness diagnostic follow that field. Raw PowerShell/WMI output, absolute paths, VM names, owner/device/incarnation identifiers, image bytes, CLR type names, and exception messages MUST NOT appear in terminal output.

## Post-failure Windows Setup diagnostics

When the chronological frames show a Windows Setup unattend error, the generic modal is not enough
to select another XML edit. After the failure-time console capture and before normal destructive
cleanup, the harness MUST make one bounded, best-effort attempt to collect the exact guest's Setup
diagnostic lines:

- resolve exactly one case-sensitive VM name from the owner/device/incarnation identity and exactly
  one attached OS VHD;
- run a non-mutating preflight that resolves the VM by its broker-returned GUID, verifies the derived
  name and ownership Notes, and fixes the exact single attached OS VHD path before any mutation;
- re-verify the same identity and path, turn off only that VM, remove only the exact
  `VMHardDiskDrive`, prove no hard disks remain attached, then make at most ten attempts to mount the
  fixed path with `Mount-VHD -ReadOnly -PassThru`, backing off between failed attempts to a 15-second
  ceiling and stopping once the next wait would cross a 60-second retry deadline; after a successful
  or possibly partial host mount, locate exactly one volume containing `Windows\Panther` and attempt
  `Dismount-VHD` before emitting a result;
- inspect only bounded tails of `Panther` and `Panther\UnattendGC` `setupact.log` / `setuperr.log`;
- retain only bounded lines related to unattend, OOBE, Shell-Setup, errors, failures, or HRESULTs;
- redact XML `Value` contents, password/token/secret assignments, and host paths before atomic
  mode-0600 publication; and
- publish a versioned timestamped JSON plus
  `results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json`.

This read-only observation is not authorization to inject `Windows\Panther\unattend.xml` or change
the guest disk contents. The failure-only harness MUST NOT reattach the drive: the broker delete path
allows zero attached hard disks and independently deletes its canonical owned VHD path. After a
post-preflight timeout or malformed result, reconciliation MUST use the fixed path and exact VM
identity. One matching still-attached drive proves detach did not complete; zero drives requires a
bounded host-mount observation, conditional dismount, and a second `Attached=false` proof. Ambiguous
drive counts, path mismatches, and failed mount observations MUST fail closed. Diagnostic failure
MUST remain secondary, MUST NOT replace the original E2E error, and MUST compose with the existing
idempotent stop/delete cleanup. The compact reason reports either
`guestSetupDiagnostics=<stable-relative-path>` or an allowlisted bounded `unavailable(...)` code.
If every mount attempt fails, that code MAY contain only a Node-validated attempt count from 1 to 10,
an allowlisted PowerShell `ErrorCategory`, an absolute .NET HResult from 0 to 2147483648, and a
redacted bounded exception message. Raw exception messages, paths, identities, and arbitrary category
strings MUST remain private. Missing, unknown, out-of-range, or inconsistent mount observations MUST
fail closed as output-invalid.

The mount message earns its place because category and HResult alone proved useless in practice: a
real host reported `NotSpecified` / `0x80131500`, which names no cause. It carries a hard constraint —
**exactly one stage may transform it, and that stage MUST redact before it truncates.** Splitting the
work is what makes a partial redaction look like a finished one: a guest-side rule that stopped at the
first space, and later a guest-side length cap, each handed the reader a path fragment with no drive
letter, leaving a user's name beside a marker reading as though redaction had completed. The guest
therefore performs no substitution and no truncation on this field; Node redacts, then bounds.

### Known gap — the log-line path still redacts in two stages

The `Panther` log lines have the same structural defect and it is not yet fixed. PowerShell applies a
user-profile rule to each line and Node applies the identical rule again, with no whole-path rule
between them, so `C:\Users\<first> <last>\...` reaches the artifact as `[user-profile] <last>\...`.
The blast radius is larger than the mount message, because these lines are written to a persisted
file under `results/device-lab-real/` rather than appearing once in a failure line. Fixing it means
giving the log-line path the same single-stage treatment; it was left out of the diagnostics-restoration
task deliberately, as pre-existing and out of that task's scope.

## Privacy and retention

Console images and filtered Setup diagnostics can contain guest-visible identifiers. They remain local in the gitignored `results/` tree and MUST NOT be automatically uploaded, printed as base64, embedded in documentation, or committed. Routine output advertises only stable relative `latest` paths; timestamped files are retained for local comparison and may be removed manually.

## Verification

Linux-runnable tests MUST cover command construction, exact identity and realized-setting guards, synchronous/asynchronous WMI paths, timeouts, malformed/oversized/wrong-dimension output, atomic publication, stale-latest protection, the exact timeline schedule, timer cancellation, capture exception containment, capture-before-cleanup ordering, read-only VHD mounting, guaranteed dismount-before-output ordering, diagnostic path allowlisting, defense-in-depth redaction, and preservation of the original compact failure fields.

The user's Windows host provides the hardware proof: rerun `npm run test:level3:hyper-v:windows`; on failure, confirm that the printed PNG exists, opens as 640×480, and shows the live guest console. If capture is unavailable, return the full FAIL line so its bounded code can guide the next change.
