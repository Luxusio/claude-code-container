import { randomBytes } from "crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hyperVVmName } from "../../src/host-control/hyper-v/index.ts";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_LOGS = 4;
const MAX_LINES_PER_LOG = 120;
const MAX_LINE_CHARS = 768;
const MOUNT_MAX_ATTEMPTS = 10;
// A flat 1000 ms between attempts gave the VHD handle 10 seconds total to be released after the
// disk was detached, which a real host exhausted on every attempt. Backing off to a 15 s ceiling
// spends longer without unbounding the diagnostic.
const MOUNT_BACKOFF_CEILING_MS = 15000;
// The retry budget must stay a known share of the process budget below. Unbounded, ten backed-off
// attempts sleep 90 s, leaving under 30 s for module autoload, the identity reads, a Stop-VM on a
// VM that is hung — the exact case being diagnosed — the detach, and the mount latency itself.
// Overrunning kills the process, and then the attempts/category/message this whole change exists to
// capture are never read: the result degrades to hyper-v-setup-diagnostics-process-timeout.
const MOUNT_RETRY_BUDGET_MS = 60000;
// Exported so the compact-reporter budget test can derive its widest case from it instead of
// hardcoding a filler length. With the number duplicated by hand, raising this cap left that test
// passing against a frozen snapshot while the actionable half of the real line fell past the
// reporter's cut.
export const MOUNT_MESSAGE_MAX_CHARS = 200;
const DIAGNOSTICS_PROCESS_TIMEOUT_MS = 180000;
const MOUNT_ERROR_CATEGORIES = new Set([
    "NotSpecified", "OpenError", "CloseError", "DeviceError", "DeadlockDetected",
    "InvalidArgument", "InvalidData", "InvalidOperation", "InvalidResult", "InvalidType",
    "MetadataError", "NotImplemented", "NotInstalled", "ObjectNotFound", "OperationStopped",
    "OperationTimeout", "SyntaxError", "ParserError", "PermissionDenied", "ResourceBusy",
    "ResourceExists", "ResourceUnavailable", "ReadError", "WriteError", "FromStdErr",
    "SecurityError", "ProtocolError", "ConnectionError", "AuthenticationError", "LimitsExceeded",
    "QuotaExceeded", "NotEnabled",
]);
const LATEST_RELATIVE_PATH = "results/device-lab-real/hyper-v-windows-setup-diagnostics-latest.json";
const ALLOWED_LOG_PATHS = new Set([
    "Windows\\Panther\\setupact.log",
    "Windows\\Panther\\setuperr.log",
    "Windows\\Panther\\UnattendGC\\setupact.log",
    "Windows\\Panther\\UnattendGC\\setuperr.log",
]);
// Exported so the reporter-budget fixture can derive its widest suffix from the real set instead
// of hand-typing the longest name it happens to know about — which it already got wrong once,
// within one commit of arguing against exactly that.
export const SETUP_DIAGNOSTICS_SAFE_CODES = new Set([
    "hyper-v-setup-diagnostics-host-not-windows",
    "hyper-v-setup-diagnostics-identity-invalid",
    "hyper-v-setup-diagnostics-powershell-unavailable",
    "hyper-v-setup-diagnostics-process-timeout",
    "hyper-v-setup-diagnostics-process-failed",
    "hyper-v-setup-diagnostics-cleanup-failed",
    "hyper-v-setup-diagnostics-output-invalid",
    "hyper-v-setup-diagnostics-vm-not-exact",
    "hyper-v-setup-diagnostics-disk-not-exact",
    "hyper-v-setup-diagnostics-stop-failed",
    "hyper-v-setup-diagnostics-detach-failed",
    "hyper-v-setup-diagnostics-mount-failed",
    "hyper-v-setup-diagnostics-disk-observation-failed",
    "hyper-v-setup-diagnostics-volume-not-exact",
    "hyper-v-setup-diagnostics-read-failed",
    "hyper-v-setup-diagnostics-dismount-failed",
    "hyper-v-setup-diagnostics-artifact-publish-failed",
]);

type SpawnResult = {
    status?: number | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    error?: NodeJS.ErrnoException;
};

export type SetupDiagnosticsLog = { path: string; lines: string[] };

// What the elevated child returns: the validated payload and nothing else. It has nowhere it should
// write, and a failed write there would discard logs already paid for with a UAC prompt and a full
// stop/detach/mount cycle.
export type SetupDiagnosticsCollection =
    | { ok: true; logs: SetupDiagnosticsLog[] }
    | { ok: false; code: string };

export type HyperVWindowsSetupDiagnosticsResult =
    // `logs` is the validated, redacted payload that was published. It is carried on the result so
    // the elevated caller can hand the payload back to its unelevated parent and let the PARENT
    // write the artifacts. An elevated process resolving its own output root got that root from
    // `import.meta.url`, which under the staging directory the elevation library uses is two levels
    // below the drive root — so it wrote to C:\results and reported a repo-relative path that never
    // existed. See hyper-v-windows-setup-diagnostics-elevation.ts.
    | { ok: true; latestRelativePath: string; latestPath: string; timestampedPath: string; logs: SetupDiagnosticsLog[] }
    | { ok: false; code: string };

export type HyperVWindowsSetupDiagnosticsInput = {
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    vmId: string;
    powershell?: string;
    platform?: NodeJS.Platform | string;
    outputRoot?: string;
    now?: () => Date;
    spawnSyncImpl?: (command: string, args: string[], options: Record<string, unknown>) => SpawnResult;
};

function psQuote(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

function encodedPowerShell(script: string): string {
    return Buffer.from(script, "utf16le").toString("base64");
}

function ownershipMarker(input: Pick<HyperVWindowsSetupDiagnosticsInput, "ownerId" | "deviceId" | "incarnationId">): string {
    return `ccc-device-lab:${input.ownerId}:${input.deviceId}:${input.incarnationId}`;
}

function preflightProgram(vmName: string, vmId: string, marker: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$VmName = ${psQuote(vmName)}`,
        `$ExpectedId = [Guid]${psQuote(vmId)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        "$Stage = 'hyper-v-setup-diagnostics-vm-not-exact'",
        "try {",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-setup-diagnostics-vm-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-disk-not-exact'",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -ne 1) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  if ([string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  $DiskPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "  if (-not [IO.Path]::IsPathRooted($DiskPath) -or [IO.Path]::GetExtension($DiskPath) -notin @('.vhd','.vhdx')) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  [ordered]@{ ok = $true; diskPath = $DiskPath } | ConvertTo-Json -Compress",
        "} catch {",
        "  $Message = [string]$_.Exception.Message",
        "  if ($Message -match '^hyper-v-setup-diagnostics-[a-z-]+$') { $Code = $Message } else { $Code = $Stage }",
        "  [ordered]@{ ok = $false; code = $Code } | ConvertTo-Json -Compress",
        "}",
    ].join("\n");
}

function diagnosticsProgram(vmName: string, vmId: string, marker: string, expectedDiskPath: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$VmName = ${psQuote(vmName)}`,
        `$ExpectedId = [Guid]${psQuote(vmId)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        `$ExpectedDisk = ${psQuote(expectedDiskPath)}`,
        "$Stage = 'hyper-v-setup-diagnostics-vm-not-exact'",
        "$Mounted = $false",
        "$DiskPath = $null",
        "$Result = $null",
        "$MountAttempts = 0",
        "$MountCategory = $null",
        "$MountHResult = $null",
        "$MountMessage = $null",
        // Initialized with its siblings rather than relying on [bool]$null being $false. That works
        // only while nothing sets strict mode — -NoProfile keeps a profile from doing so today, but
        // one Set-StrictMode anywhere and the catch below throws on an undefined variable, taking
        // the whole a=/c=/h=/m= bracket down to a bare code. This field exists to carry that
        // bracket; it should not be the one variable that can lose it.
        "$MountPrivilege = $null",
        // Probed ONCE, here, and wrapped. Two reasons, both learned the hard way.
        //
        // Wrapped because these are .NET method calls: -ErrorAction does not apply to them, so
        // under $ErrorActionPreference='Stop' a throw escapes to the outer catch, where $Message is
        // a .NET string that fails the mount-failed test, $Code falls back to $Stage and the whole
        // mount object is gone. That is the same bracket collapse `$MountPrivilege = $null` was
        // added to prevent, reintroduced by a different route. Defaulting to $true on failure keeps
        // the message the only signal, which is the pre-probe behaviour.
        //
        // Once because inside the retry loop it re-ran on every attempt for an elevated host — ten
        // identity lookups to answer a question whose answer cannot change mid-loop.
        //
        // No separate initializer for $MountElevated: both branches below assign it, so one would be
        // dead code sitting immediately beside `$MountPrivilege = $null`, which is NOT dead — that
        // one is what a future Set-StrictMode would otherwise break. Two lines that look symmetric
        // when only one carries weight is how the wrong one gets deleted. (Both mentions said
        // `$MountPrivilege = $false` until the field became 'code' | 'unelevated' | $null — a
        // comment naming a value that no longer exists, in the comment whose whole job is telling
        // someone which line not to delete.)
        "try { $MountElevated = (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } catch { $MountElevated = $true }",
        "try {",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-setup-diagnostics-vm-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-disk-not-exact'",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -ne 1) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  if ([string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  $DiskPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "  if (-not [string]::Equals($DiskPath, [IO.Path]::GetFullPath($ExpectedDisk), [StringComparison]::OrdinalIgnoreCase)) { throw 'hyper-v-setup-diagnostics-disk-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-stop-failed'",
        "  if ($Vm.State -ne 'Off') { Stop-VM -VM $Vm -TurnOff -Force -ErrorAction Stop }",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker -or $Vm.State -ne 'Off') { throw 'hyper-v-setup-diagnostics-stop-failed' }",
        "  $Stage = 'hyper-v-setup-diagnostics-detach-failed'",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-detach-failed' }",
        "  $DetachPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "  if (-not [string]::Equals($DetachPath, [IO.Path]::GetFullPath($ExpectedDisk), [StringComparison]::OrdinalIgnoreCase)) { throw 'hyper-v-setup-diagnostics-detach-failed' }",
        "  Remove-VMHardDiskDrive -VMHardDiskDrive $Drives[0] -ErrorAction Stop",
        "  $RemainingDrives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($RemainingDrives.Count -ne 0) { throw 'hyper-v-setup-diagnostics-detach-failed' }",
        "  $Stage = 'hyper-v-setup-diagnostics-mount-failed'",
        "  $MountedImage = $null",
        `  $MountDeadline = [DateTime]::UtcNow.AddMilliseconds(${MOUNT_RETRY_BUDGET_MS})`,
        `  for ($Attempt = 1; $Attempt -le ${MOUNT_MAX_ATTEMPTS}; $Attempt++) {`,
        "    $MountAttempts = $Attempt",
        "    try {",
        "      $MountedImage = Mount-VHD -Path $DiskPath -ReadOnly -PassThru -ErrorAction Stop",
        "      $Mounted = $true",
        "      break",
        "    } catch {",
        "      $MountCategory = [string]$_.CategoryInfo.Category",
        "      $MountHResult = [Math]::Abs([long]$_.Exception.HResult)",
        // The category and HRESULT alone came back as NotSpecified/0x80131500 on a real host, which
        // names no cause. The message is host text; it is bounded here and redacted on the reading
        // side by mountFailureMessage, which is the only path by which this field reaches output.
        //
        // Neither redaction NOR truncation is attempted here — both fragment. A user-profile rule at
        // this stage stopped at the first space, so `C:\Users\Kyeong Jae\disk.vhdx` arrived at the
        // reader already split into `[user-profile] Jae\disk.vhdx`, a fragment with no drive letter
        // for the reader's whole-path rule to match. A length cap does the same thing for a longer
        // message: cutting at 200 chars can land inside the segment after a space and leave `Jae`
        // behind, beside a marker that reads as though redaction had completed.
        //
        // So the stage that redacts is also the stage that bounds. `mountFailureMessage` truncates
        // AFTER redacting, which is the only order that cannot manufacture a fragment. Wire size
        // stays bounded by the MAX_OUTPUT_BYTES check on the whole stdout; a message large enough to
        // breach that fails the diagnostic outright, which loses the diagnosis but leaks nothing.
        "      $MountMessage = [string]$_.Exception.Message",
        // ERROR_PRIVILEGE_NOT_HELD does not become true by waiting. A real host burned 7 attempts
        // with exponential backoff on it, spending the diagnostic's whole budget to re-learn the
        // same answer, and the operator got a mojibake blob instead of "run this elevated".
        //
        // Matched on the message rather than the HResult on purpose: the comment above already
        // records that CategoryInfo/HResult come back generic (NotSpecified/0x80131500) on a real
        // host, and that is what was observed here too — h=2146233088, with the only true cause,
        // (0x80070522), inside the localized message. That substring is ASCII, so it survives a
        // host locale this pipeline otherwise mangles. The match runs here, inside PowerShell, on
        // the pristine exception string — before the stdout encoding step that produces the
        // mojibake — so the mangling is a reader-side artifact and cannot defeat it.
        //
        // Corroborated by an elevation probe rather than resting on the string alone, because the
        // dangerous direction is a FALSE NEGATIVE: a locale or PowerShell version whose message
        // omits the parenthesized code would silently revert to ten retries and the generic label,
        // which is the exact failure this exists to fix, with nothing to say detection missed. The
        // launcher also promises the operator they will get this code; message-matching alone
        // cannot keep that promise. `Mount-VHD failed AND we are not elevated` is the same
        // conclusion reached without depending on host text at all.
        // Two ways to conclude it, and the second one deliberately fires for ANY mount failure on
        // an unelevated host — including a category that names a transient cause such as
        // ResourceBusy. That looks like a contradiction in the emitted code (`elevate` beside
        // `c=ResourceBusy`) and is not one: unelevated, Mount-VHD cannot succeed whatever else is
        // also true, so the retries are wasted and elevation is a real prerequisite. Reporting the
        // busy category and advising elevation are both correct; only elevation is actionable.
        // Which signal fired is carried out, not just that one did. The two are different advice:
        // `code` means Windows named ERROR_PRIVILEGE_NOT_HELD and elevation is the whole fix;
        // `unelevated` means the probe concluded it and the category beside it may be an
        // INDEPENDENT problem that survives elevating. Without the distinction an operator who
        // elevates, re-runs and waits out another boot can hit the same ResourceBusy with nothing
        // in the first output having warned them. The reader's own comment claims this code exists
        // because it is the one failure with a fixed remedy; under the probe fallback that is only
        // true of the `code` derivation, and saying which one applies is what keeps the claim honest.
        "      if ($MountMessage -match '0x80070522') { $MountPrivilege = 'code'; break }",
        "      if (-not $MountElevated) { $MountPrivilege = 'unelevated'; break }",
        // The deadline, not the attempt count, is what keeps the retry budget inside the process
        // budget: a slow mount failure costs wall-clock the sleeps do not account for. The sleep is
        // included in the comparison, so a check passing just under the deadline cannot then add a
        // full ceiling on top of it — the budget is the stated one, not the stated one plus 15 s.
        `      $MountSleep = [Math]::Min(${MOUNT_BACKOFF_CEILING_MS}, 1000 * [Math]::Pow(2, $Attempt - 1))`,
        `      if ($Attempt -lt ${MOUNT_MAX_ATTEMPTS} -and [DateTime]::UtcNow.AddMilliseconds($MountSleep) -lt $MountDeadline) { Start-Sleep -Milliseconds $MountSleep }`,
        `      elseif ($Attempt -lt ${MOUNT_MAX_ATTEMPTS}) { break }`,
        "    }",
        "  }",
        "  if (-not $Mounted) { throw 'hyper-v-setup-diagnostics-mount-failed' }",
        "  $Stage = 'hyper-v-setup-diagnostics-disk-observation-failed'",
        "  $Disk = $MountedImage | Get-Disk -ErrorAction Stop",
        "  $Stage = 'hyper-v-setup-diagnostics-volume-not-exact'",
        "  $Roots = @()",
        "  foreach ($Partition in @(Get-Partition -DiskNumber $Disk.Number -ErrorAction Stop)) {",
        "    $Volume = $Partition | Get-Volume -ErrorAction SilentlyContinue",
        "    if ($null -ne $Volume -and $null -ne $Volume.DriveLetter) {",
        "      $Root = ([string]$Volume.DriveLetter) + ':\\'",
        "      if (Test-Path -LiteralPath ($Root + 'Windows\\Panther') -PathType Container) { $Roots += $Root }",
        "    }",
        "  }",
        "  if ($Roots.Count -ne 1) { throw 'hyper-v-setup-diagnostics-volume-not-exact' }",
        "  $Stage = 'hyper-v-setup-diagnostics-read-failed'",
        "  $RelativePaths = @('Windows\\Panther\\setupact.log','Windows\\Panther\\setuperr.log','Windows\\Panther\\UnattendGC\\setupact.log','Windows\\Panther\\UnattendGC\\setuperr.log')",
        "  $Logs = @()",
        "  foreach ($RelativePath in $RelativePaths) {",
        "    $LogPath = Join-Path $Roots[0] $RelativePath",
        "    if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) { continue }",
        "    $Lines = @(Get-Content -LiteralPath $LogPath -Tail 600 -ErrorAction Stop | Where-Object { $_ -match '(?i)unattend|oobe|shell.setup|error|fail|0x[0-9a-f]+' } | Select-Object -Last 120)",
        "    $SafeLines = @()",
        "    foreach ($LineValue in $Lines) {",
        "      $Line = [string]$LineValue",
        "      $Line = [regex]::Replace($Line, '(?is)<Value>.*?</Value>', '<Value>[redacted]</Value>')",
        "      $Line = [regex]::Replace($Line, '(?i)(password|token|secret)\\s*[:=].*$', '$1=[redacted]')",
        "      $Line = [regex]::Replace($Line, '(?i)[A-Z]:\\\\Users\\\\[^\\\\\\s]+', '[user-profile]')",
        "      if ($Line.Length -gt 768) { $Line = $Line.Substring(0, 768) + '[truncated]' }",
        "      $SafeLines += $Line",
        "    }",
        "    $Logs += [ordered]@{ path = $RelativePath; lines = $SafeLines }",
        "  }",
        "  $Result = [ordered]@{ ok = $true; logs = $Logs }",
        "} catch {",
        "  $Message = [string]$_.Exception.Message",
        "  if ($Message -eq 'hyper-v-setup-diagnostics-mount-failed' -and $MountAttempts -gt 0) {",
        "    $Result = [ordered]@{ ok = $false; code = $Message; mount = [ordered]@{ attempts = $MountAttempts; category = $MountCategory; hresult = $MountHResult; message = $MountMessage; privilege = $MountPrivilege } }",
        "  } else {",
        "    if ($Message -match '^hyper-v-setup-diagnostics-[a-z-]+$') { $Code = $Message } else { $Code = $Stage }",
        "    $Result = [ordered]@{ ok = $false; code = $Code }",
        "  }",
        "} finally {",
        "  if ($Mounted -and $DiskPath) {",
        "    try { Dismount-VHD -Path $DiskPath -ErrorAction Stop } catch { $Result = [ordered]@{ ok = $false; code = 'hyper-v-setup-diagnostics-dismount-failed' } }",
        "  }",
        "}",
        "$Result | ConvertTo-Json -Compress -Depth 5",
    ].join("\n");
}

function cleanupProgram(vmName: string, vmId: string, marker: string, expectedDiskPath: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$VmName = ${psQuote(vmName)}`,
        `$ExpectedId = [Guid]${psQuote(vmId)}`,
        `$ExpectedMarker = ${psQuote(marker)}`,
        `$ExpectedDisk = ${psQuote(expectedDiskPath)}`,
        "try {",
        "  $Vm = Get-VM -Id $ExpectedId -ErrorAction Stop",
        "  if ($Vm.Name -cne $VmName -or [string]$Vm.Notes -cne $ExpectedMarker) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  $Drives = @(Get-VMHardDiskDrive -VM $Vm -ErrorAction Stop)",
        "  if ($Drives.Count -gt 1) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  if ($Drives.Count -eq 1) {",
        "    if ([string]::IsNullOrWhiteSpace([string]$Drives[0].Path)) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "    $AttachedPath = [IO.Path]::GetFullPath([string]$Drives[0].Path)",
        "    if (-not [string]::Equals($AttachedPath, [IO.Path]::GetFullPath($ExpectedDisk), [StringComparison]::OrdinalIgnoreCase)) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "    [ordered]@{ ok = $true; detached = $false } | ConvertTo-Json -Compress",
        "    exit 0",
        "  }",
        "  $DiskImages = @(Get-DiskImage -ImagePath $ExpectedDisk -ErrorAction Stop)",
        "  if ($DiskImages.Count -ne 1) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  if ([bool]$DiskImages[0].Attached) { Dismount-VHD -Path $ExpectedDisk -ErrorAction Stop }",
        "  $VerifiedImages = @(Get-DiskImage -ImagePath $ExpectedDisk -ErrorAction Stop)",
        "  if ($VerifiedImages.Count -ne 1 -or [bool]$VerifiedImages[0].Attached) { throw 'hyper-v-setup-diagnostics-cleanup-failed' }",
        "  [ordered]@{ ok = $true; detached = $true } | ConvertTo-Json -Compress",
        "} catch {",
        "  [ordered]@{ ok = $false; code = 'hyper-v-setup-diagnostics-cleanup-failed' } | ConvertTo-Json -Compress",
        "}",
    ].join("\n");
}

function failure(code: string): HyperVWindowsSetupDiagnosticsResult {
    return { ok: false, code: SETUP_DIAGNOSTICS_SAFE_CODES.has(code) ? code : "hyper-v-setup-diagnostics-output-invalid" };
}

function mountFailureCode(value: unknown): string | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const attempts = (value as { attempts?: unknown }).attempts;
    const category = (value as { category?: unknown }).category;
    const hresult = (value as { hresult?: unknown }).hresult;
    if (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > MOUNT_MAX_ATTEMPTS) return null;
    if (typeof category !== "string" || !MOUNT_ERROR_CATEGORIES.has(category)) return null;
    if (typeof hresult !== "number" || !Number.isSafeInteger(hresult) || hresult < 0 || hresult > 2147483648) return null;
    // Additive: the bracketed a/c/h shape stays exactly as before so existing parsing keeps working,
    // and the message — the only field that ever names the actual cause — is appended when the host
    // supplied one that survives redaction to printable single-line text.
    //
    // `m` is always last and its value may contain `,` and `=`, so read it greedily to the closing
    // `]` rather than splitting the bracket body on `,`.
    const message = mountFailureMessage((value as { message?: unknown }).message);
    // A privilege failure gets its own code because it is the one mount failure with a fixed
    // remedy. Rolled in with the rest it reached the operator as a generic bracket plus a
    // host-locale message this pipeline mangles — on the run that prompted this, an unreadable
    // Korean blob whose only usable content was an HRESULT nobody decodes by eye. `elevate` says
    // what to do; the bracket is kept verbatim beside it so nothing that parsed the old shape
    // loses its fields.
    const detail = `a=${attempts},c=${category},h=${hresult}${message ? `,m=${message}` : ""}`;
    // `p=` says which signal concluded it, because the two carry different next steps. Strict
    // membership rather than a truthiness test: any other value falls through to the generic code,
    // which is the safe direction — under-report, never over-report.
    const privilege = (value as { privilege?: unknown }).privilege;
    if (privilege === "code" || privilege === "unelevated") {
        return `hyper-v-setup-diagnostics-mount-privilege-required[elevate,p=${privilege},${detail}]`;
    }
    return `hyper-v-setup-diagnostics-mount-failed[${detail}]`;
}

// A drive-lettered or UNC path, continuing across spaces while the next few segments still reach
// another separator. Stopping at the first space left a fragment — a surname, for
// `C:\Users\Kyeong Jae\x.vhdx` — beside a marker that read as if redaction had completed, which is
// worse than no marker at all. Looking past more than one segment is what carries
// `C:\Program Files\Virtual Hard Disks\x.vhdx`, the default Hyper-V VHD location, which a
// one-segment form truncated to `(host-path) Hard Disks\x.vhdx`.
//
// The look-ahead is deliberately unbounded, and that is a chosen trade, not an oversight. Bounding
// it by a segment count makes the count a leak boundary: at two, `C:\Users\Jean Luc Marie de
// Vries\vm.vhdx` and `C:\Program Files\Common Shared Virtual Hard Disks\x.vhdx` both terminate early
// and publish the tail — a personal name, in the first — beside a marker asserting redaction
// completed. Unbounded, the cost is the opposite and lesser one: a later backslash anywhere in the
// message pulls the prose between into the match, so `copy C:\a\b.vhdx to D:\c\d.vhdx now` loses its
// verb. Over-redaction costs diagnosis and leaks nothing; under-redaction leaks under a marker that
// says it did not. This field is capped at 200 characters, so the diagnosis at risk is small.
//
// `;` is excluded alongside the quotes so trailing message punctuation is not swallowed into the
// path and can still be mapped to `,` below.
const HOST_PATH_PATTERN = /(?:[A-Za-z]:\\|\\\\)[^\s'";]*(?:(?:\s[^\s'";]*)*?\s[^\s'";]*\\[^\s'";]*)*/g;

function mountFailureMessage(value: unknown): string | null {
    if (typeof value !== "string") return null;
    // Newlines collapse FIRST. `redactLine`'s secret rule is anchored with `$` and no `m` flag, so
    // on a multi-line message it only ever fired on the last line — a secret on any earlier line
    // passed through verbatim.
    //
    // Host paths go next, BEFORE `redactLine`: its user-profile rule stops at the first space, so
    // letting it run first would consume `C:\Users\Kyeong` and leave `Jae\...` with no drive letter
    // for the broader rule to match. Which path the message named is lost — usually the mount target
    // the caller already supplied, but not necessarily — and that is accepted: the cause is carried
    // by the surrounding words, and a message may name a path the caller does not know.
    //
    // Brackets become parentheses rather than being dropped: the code itself is bracketed, so a
    // nested `[` would break its shape, but the redaction markers stay legible as `(redacted)`.
    // `;` becomes `,` for the same reason one level up — the e2e failure line is `;`-separated.
    const collapsed = String(value).replace(/[\r\n\t\u2028\u2029]+/g, " ").replace(HOST_PATH_PATTERN, "[host-path]");
    const redacted = redactLine(collapsed)
        ?.replace(/;/g, ",")
        .replace(/\[/g, "(")
        .replace(/\]/g, ")")
        .trim()
        .slice(0, MOUNT_MESSAGE_MAX_CHARS);
    return redacted || null;
}

function redactLine(value: unknown): string | null {
    if (typeof value !== "string") return null;
    // Collapse FIRST, exactly as mountFailureMessage does and for the same reason — a reason this
    // module already documented for the other field and never applied here. The secret rule is
    // `.*$` with no `m` flag, so `.` stops at a newline and `$` matches end-of-string: one embedded
    // `\n` and `password: hunter2\nrest` passes through VERBATIM. Measured, not reasoned. It matters
    // more now than it did, because this is the function the elevated child's payload goes through
    // and two comments cite it as the reason that payload is safe to accept.
    //
    // Bounding before the regex passes, not after, is the other half. `<Value>[\s\S]*?</Value>` is
    // lazy and quadratic against a long run of unclosed `<Value>`: a 400 000-character line took
    // 3.4 s here with the event loop blocked, and still returned ok. Truncating first makes every
    // pass linear in MAX_LINE_CHARS regardless of what the producer sent.
    const bounded = value.replace(/[\r\n\t\u2028\u2029]+/g, " ").slice(0, MAX_LINE_CHARS);
    return bounded
        .replace(/<Value>[\s\S]*?<\/Value>/gi, "<Value>[redacted]</Value>")
        .replace(/(password|token|secret)\s*[:=].*$/gi, "$1=[redacted]")
        .replace(/[A-Z]:\\Users\\[^\\\s]+/gi, "[user-profile]")
        .slice(0, MAX_LINE_CHARS);
}

function validatedLogs(value: unknown): Array<{ path: string; lines: string[] }> | null {
    if (!Array.isArray(value) || value.length > MAX_LOGS) return null;
    const logs: Array<{ path: string; lines: string[] }> = [];
    for (const candidate of value) {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
        const path = (candidate as { path?: unknown }).path;
        const lines = (candidate as { lines?: unknown }).lines;
        if (typeof path !== "string" || !ALLOWED_LOG_PATHS.has(path) || !Array.isArray(lines) || lines.length > MAX_LINES_PER_LOG) return null;
        const safeLines: string[] = [];
        for (const line of lines) {
            const redacted = redactLine(line);
            if (redacted === null) return null;
            safeLines.push(redacted);
        }
        logs.push({ path, lines: safeLines });
    }
    return logs;
}

function writeExclusiveThenRename(target: string, content: string): void {
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
        writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        const stat = lstatSync(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== Buffer.byteLength(content)) throw new Error("invalid diagnostic artifact");
        renameSync(temporary, target);
        renamed = true;
    } finally {
        if (!renamed) rmSync(temporary, { force: true });
    }
}

function recoverDiagnosticMount(input: HyperVWindowsSetupDiagnosticsInput, vmName: string, marker: string, diskPath: string): boolean {
    let cleanup: SpawnResult;
    try {
        cleanup = (input.spawnSyncImpl || hiddenSpawnSync)(String(input.powershell), [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedPowerShell(cleanupProgram(vmName, input.vmId, marker, diskPath)),
        ], {
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
        });
    } catch {
        return false;
    }
    if (cleanup.error || cleanup.status !== 0) return false;
    try {
        const parsed = JSON.parse(String(cleanup.stdout || "").trim());
        return parsed?.ok === true && typeof parsed.detached === "boolean";
    } catch {
        return false;
    }
}

// The three programs this module emits, for the PowerShell parse gate. They are PowerShell built by
// joining a TypeScript string array, so they sit on no disk path the gate's walker can find — the
// same shape as the session bootstrap, which that gate already special-cases and reads out of dist
// for exactly this reason. Nothing else parses them: PSScriptAnalyzer walks a directory and finds
// no file either. String-containment tests were the only surface, and a containment assertion
// cannot see an unterminated string or a stray brace.
//
// Placeholder arguments: the parser checks syntax, and syntax does not depend on which VM name or
// path is interpolated. They only need to be shaped like the real ones — a GUID that parses, a path
// with a drive letter — so the emitted quoting is representative.
export function hyperVWindowsSetupDiagnosticsPrograms(): string[] {
    const vmName = "ccc-parse-check";
    const vmId = "00000000-0000-0000-0000-000000000000";
    const marker = "ccc-device-lab:parse:check:0";
    const diskPath = "C:\\ccc\\parse-check.vhdx";
    return [
        preflightProgram(vmName, vmId, marker),
        diagnosticsProgram(vmName, vmId, marker, diskPath),
        cleanupProgram(vmName, vmId, marker, diskPath),
    ];
}

export function collectHyperVWindowsSetupDiagnostics(input: HyperVWindowsSetupDiagnosticsInput): SetupDiagnosticsCollection {
    if ((input.platform || process.platform) !== "win32") return failure("hyper-v-setup-diagnostics-host-not-windows");
    if (!String(input.powershell || "").trim()) return failure("hyper-v-setup-diagnostics-powershell-unavailable");
    let vmName: string;
    let marker: string;
    try {
        vmName = hyperVVmName(input.ownerId, input.deviceId, input.incarnationId);
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.vmId)) throw new Error("invalid vm id");
        marker = ownershipMarker(input);
    } catch {
        return failure("hyper-v-setup-diagnostics-identity-invalid");
    }
    let preflight: SpawnResult;
    try {
        preflight = (input.spawnSyncImpl || hiddenSpawnSync)(String(input.powershell), [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedPowerShell(preflightProgram(vmName, input.vmId, marker)),
        ], {
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 64 * 1024,
            windowsHide: true,
        });
    } catch {
        return failure("hyper-v-setup-diagnostics-process-failed");
    }
    if (preflight.error?.code === "ETIMEDOUT") return failure("hyper-v-setup-diagnostics-process-timeout");
    if (preflight.error || preflight.status !== 0) return failure("hyper-v-setup-diagnostics-process-failed");
    let preflightResult: any;
    try {
        const text = String(preflight.stdout || "").trim();
        if (!text || Buffer.byteLength(text) > 64 * 1024) return failure("hyper-v-setup-diagnostics-output-invalid");
        preflightResult = JSON.parse(text);
    } catch {
        return failure("hyper-v-setup-diagnostics-output-invalid");
    }
    if (preflightResult?.ok === false) return failure(typeof preflightResult.code === "string" ? preflightResult.code : "");
    const diskPath = typeof preflightResult?.diskPath === "string" ? preflightResult.diskPath : "";
    if (preflightResult?.ok !== true || diskPath.length < 4 || diskPath.length > 4096 || diskPath.includes("\0") || !/^[A-Za-z]:\\/.test(diskPath) || !/\.vhdx?$/i.test(diskPath)) {
        return failure("hyper-v-setup-diagnostics-output-invalid");
    }

    let spawned: SpawnResult;
    try {
        spawned = (input.spawnSyncImpl || hiddenSpawnSync)(String(input.powershell), [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedPowerShell(diagnosticsProgram(vmName, input.vmId, marker, diskPath)),
        ], {
            encoding: "utf8",
            timeout: DIAGNOSTICS_PROCESS_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true,
        });
    } catch {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-process-failed" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (spawned.error?.code === "ETIMEDOUT") {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-process-timeout" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (spawned.error || spawned.status !== 0) {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-process-failed" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    const stdout = String(spawned.stdout || "").trim();
    if (!stdout || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    let parsed: any;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (parsed?.ok === false) {
        const code = typeof parsed.code === "string" ? parsed.code : "";
        if (code === "hyper-v-setup-diagnostics-mount-failed") {
            const observedCode = mountFailureCode(parsed.mount);
            if (!recoverDiagnosticMount(input, vmName, marker, diskPath)) return failure("hyper-v-setup-diagnostics-cleanup-failed");
            return observedCode ? { ok: false, code: observedCode } : failure("");
        }
        return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? code : "hyper-v-setup-diagnostics-cleanup-failed");
    }
    if (parsed?.ok !== true) return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");
    const logs = validatedLogs(parsed.logs);
    if (!logs) return failure(recoverDiagnosticMount(input, vmName, marker, diskPath) ? "hyper-v-setup-diagnostics-output-invalid" : "hyper-v-setup-diagnostics-cleanup-failed");
    return { ok: true, logs };
}

// Collect and publish, for the ordinary unelevated path. The elevated child calls
// `collectHyperVWindowsSetupDiagnostics` directly and never publishes: it has nowhere it should
// write, and a failed write there would discard logs it had already paid a UAC prompt and a full
// stop/detach/mount cycle to read.
export function captureHyperVWindowsSetupDiagnostics(input: HyperVWindowsSetupDiagnosticsInput): HyperVWindowsSetupDiagnosticsResult {
    const collected = collectHyperVWindowsSetupDiagnostics(input);
    if (collected.ok !== true) return collected;
    return publishHyperVWindowsSetupDiagnostics(collected.logs, { outputRoot: input.outputRoot, now: input.now });
}

// The publish half on its own, so the unelevated parent can write artifacts for logs an elevated
// child collected. Same code both ways: two implementations of "where the artifacts go" is how the
// elevated one ended up writing to the drive root without anybody noticing.
export function publishHyperVWindowsSetupDiagnostics(
    logs: SetupDiagnosticsLog[],
    options: { outputRoot?: string; now?: () => Date } = {},
): HyperVWindowsSetupDiagnosticsResult {
    const validated = validatedLogs(logs);
    if (!validated) return failure("hyper-v-setup-diagnostics-output-invalid");
    const outputRoot = options.outputRoot || join(repoRoot, "results", "device-lab-real");
    const generatedAt = (options.now || (() => new Date()))().toISOString();
    const timestamp = generatedAt.replace(/[:.]/g, "-");
    const timestampedPath = join(outputRoot, `hyper-v-windows-setup-diagnostics-${timestamp}.json`);
    const latestPath = join(outputRoot, "hyper-v-windows-setup-diagnostics-latest.json");
    const content = `${JSON.stringify({ version: 1, generatedAt, logs: validated }, null, 2)}\n`;
    try {
        mkdirSync(outputRoot, { recursive: true });
        writeExclusiveThenRename(timestampedPath, content);
        writeExclusiveThenRename(latestPath, content);
    } catch {
        return failure("hyper-v-setup-diagnostics-artifact-publish-failed");
    }
    return { ok: true, latestRelativePath: LATEST_RELATIVE_PATH, latestPath, timestampedPath, logs: validated };
}
