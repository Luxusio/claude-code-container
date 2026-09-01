import { randomBytes } from "crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { hyperVVmName } from "../../src/host-control/hyper-v/index.ts";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";

const WIDTH = 640;
const HEIGHT = 480;
const RGB565_ROW_BYTES = WIDTH * 2;
const RGB565_EXPECTED_BYTES = RGB565_ROW_BYTES * HEIGHT;
const RGB565_COMPATIBILITY_SURPLUS_BYTES = 4;
const MAX_OBSERVED_BYTES = 8 * 1024 * 1024;
const MAX_OBSERVED_STRIDE = 1024 * 1024;
const MAX_PNG_BYTES = 4 * 1024 * 1024;
const LATEST_RELATIVE_PATH = "results/device-lab-real/hyper-v-windows-console-latest.png";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SAFE_CAPTURE_CODES = new Set([
    "hyper-v-console-host-not-windows",
    "hyper-v-console-identity-invalid",
    "hyper-v-console-powershell-unavailable",
    "hyper-v-console-process-timeout",
    "hyper-v-console-process-failed",
    "hyper-v-console-output-invalid",
    "hyper-v-console-output-too-large",
    "hyper-v-console-vm-not-exact",
    "hyper-v-console-setting-not-exact",
    "hyper-v-console-wmi-unavailable",
    "hyper-v-console-wmi-access-denied",
    "hyper-v-console-wmi-job-invalid",
    "hyper-v-console-wmi-job-timeout",
    "hyper-v-console-wmi-job-failed",
    "hyper-v-console-wmi-method-failed",
    "hyper-v-console-rgb565-invalid",
    "hyper-v-console-conversion-failed",
    "hyper-v-console-png-invalid",
    "hyper-v-console-artifact-publish-failed",
]);

type SpawnResult = {
    status?: number | null;
    stdout?: string | Buffer;
    stderr?: string | Buffer;
    error?: NodeJS.ErrnoException;
};

export type HyperVWindowsConsoleCaptureResult =
    | { ok: true; latestRelativePath: string; latestPath: string; timestampedPath: string }
    | { ok: false; code: string };

export type HyperVWindowsConsoleCaptureInput = {
    ownerId: string;
    deviceId: string;
    incarnationId: string;
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

function captureProgram(vmName: string): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$VmName = ${psQuote(vmName)}`,
        `$Width = ${WIDTH}`,
        `$Height = ${HEIGHT}`,
        `$CompatibilitySurplusBytes = ${RGB565_COMPATIBILITY_SURPLUS_BYTES}`,
        "$Completion = 'sync'",
        "$RgbStage = 'extract'",
        "$RawKind = 'missing'",
        "[long]$ObservedBytes = 0",
        "[long]$ObservedStride = 0",
        "$Stage = 'hyper-v-console-wmi-unavailable'",
        "try {",
        "  $Scope = [System.Management.ManagementScope]::new('\\\\.\\root\\virtualization\\v2')",
        "  $Scope.Connect()",
        "  $Query = [System.Management.ObjectQuery]::new(\"SELECT * FROM Msvm_ComputerSystem WHERE ElementName = '$VmName'\")",
        "  $Searcher = [System.Management.ManagementObjectSearcher]::new($Scope, $Query)",
        "  $Vms = @($Searcher.Get())",
        "  if ($Vms.Count -ne 1) { throw 'hyper-v-console-vm-not-exact' }",
        "  $Vm = $Vms[0]",
        "  $Stage = 'hyper-v-console-setting-not-exact'",
        "  $SettingsQuery = [System.Management.ObjectQuery]::new(\"ASSOCIATORS OF {$($Vm.Path.RelativePath)} WHERE AssocClass=Msvm_SettingsDefineState ResultClass=Msvm_VirtualSystemSettingData Role=ManagedElement ResultRole=SettingData\")",
        "  $SettingsSearcher = [System.Management.ManagementObjectSearcher]::new($Scope, $SettingsQuery)",
        "  $Settings = @($SettingsSearcher.Get() | Where-Object { [string]$_.VirtualSystemType -eq 'Microsoft:Hyper-V:System:Realized' })",
        "  if ($Settings.Count -ne 1) { throw 'hyper-v-console-setting-not-exact' }",
        "  $ServiceClass = [System.Management.ManagementClass]::new($Scope, [System.Management.ManagementPath]::new('Msvm_VirtualSystemManagementService'), $null)",
        "  $Services = @($ServiceClass.GetInstances())",
        "  if ($Services.Count -ne 1) { throw 'hyper-v-console-wmi-unavailable' }",
        "  $Service = $Services[0]",
        "  $Input = $Service.GetMethodParameters('GetVirtualSystemThumbnailImage')",
        "  $Input['TargetSystem'] = $Settings[0].Path.Path",
        "  $Input['WidthPixels'] = [uint16]$Width",
        "  $Input['HeightPixels'] = [uint16]$Height",
        "  $Stage = 'hyper-v-console-wmi-method-failed'",
        "  $Output = $Service.InvokeMethod('GetVirtualSystemThumbnailImage', $Input, $null)",
        "  $ReturnValue = [uint32]$Output['ReturnValue']",
        "  if ($ReturnValue -eq 4096) {",
        "    $Completion = 'async'",
        "    $Stage = 'hyper-v-console-wmi-job-invalid'",
        "    $JobPath = [string]$Output['Job']",
        "    if ([string]::IsNullOrWhiteSpace($JobPath)) { throw 'hyper-v-console-wmi-job-invalid' }",
        "    $Job = [System.Management.ManagementObject]::new($Scope, [System.Management.ManagementPath]::new($JobPath), $null)",
        "    $Deadline = [DateTime]::UtcNow.AddSeconds(10)",
        "    while ($true) {",
        "      $Job.Get()",
        "      $JobState = [uint16]$Job['JobState']",
        "      if ($JobState -eq 7) { break }",
        "      if ($JobState -in @(8,9,10)) { throw 'hyper-v-console-wmi-job-failed' }",
        "      if ([DateTime]::UtcNow -ge $Deadline) { throw 'hyper-v-console-wmi-job-timeout' }",
        "      Start-Sleep -Milliseconds 100",
        "    }",
        "    if ($null -ne $Job['ErrorCode'] -and [uint32]$Job['ErrorCode'] -ne 0) { throw 'hyper-v-console-wmi-job-failed' }",
        "  } elseif ($ReturnValue -ne 0) {",
        "    throw 'hyper-v-console-wmi-method-failed'",
        "  }",
        "  $Stage = 'hyper-v-console-rgb565-invalid'",
        "  $ImageProperty = $Output.Properties['ImageData']",
        "  $ImageValue = $null",
        "  if ($null -ne $ImageProperty) {",
        "    $ImageValue = $ImageProperty.Value",
        "  }",
        "  if ($null -eq $ImageValue) { throw 'hyper-v-console-rgb565-invalid' }",
        "  if ($ImageValue -isnot [byte[]]) {",
        "    $RawKind = 'other'",
        "    throw 'hyper-v-console-rgb565-invalid'",
        "  }",
        "  $RawKind = 'byte-array'",
        "  [byte[]]$Raw = $ImageValue",
        "  $ObservedBytes = [long]$Raw.LongLength",
        "  $RowBytes = $Width * 2",
        "  $ExpectedBytes = $RowBytes * $Height",
        "  $RgbStage = 'byte-count'",
        "  if ($Raw.Length -ne $ExpectedBytes -and $Raw.Length -ne ($ExpectedBytes + $CompatibilitySurplusBytes)) { throw 'hyper-v-console-rgb565-invalid' }",
        "  $Stage = 'hyper-v-console-conversion-failed'",
        "  Add-Type -AssemblyName System.Drawing",
        "  $Bitmap = [System.Drawing.Bitmap]::new($Width, $Height, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)",
        "  $Rectangle = [System.Drawing.Rectangle]::new(0, 0, $Width, $Height)",
        "  $BitmapData = $null",
        "  $Stream = $null",
        "  try {",
        "    $BitmapData = $Bitmap.LockBits($Rectangle, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format16bppRgb565)",
        "    $RgbStage = 'bitmap-stride'",
        "    $ObservedStride = [long][Math]::Abs([int]$BitmapData.Stride)",
        "    if ($ObservedStride -lt $RowBytes) { throw 'hyper-v-console-rgb565-invalid' }",
        "    for ($Row = 0; $Row -lt $Height; $Row++) {",
        "      $Destination = [IntPtr]::Add($BitmapData.Scan0, $Row * [int]$BitmapData.Stride)",
        "      [Runtime.InteropServices.Marshal]::Copy($Raw, $Row * $RowBytes, $Destination, $RowBytes)",
        "    }",
        "    $Bitmap.UnlockBits($BitmapData)",
        "    $BitmapData = $null",
        "    $Stream = [IO.MemoryStream]::new()",
        "    $Bitmap.Save($Stream, [System.Drawing.Imaging.ImageFormat]::Png)",
        "    $PngBase64 = [Convert]::ToBase64String($Stream.ToArray())",
        "  } finally {",
        "    if ($null -ne $BitmapData) { $Bitmap.UnlockBits($BitmapData) }",
        "    if ($null -ne $Stream) { $Stream.Dispose() }",
        "    $Bitmap.Dispose()",
        "  }",
        "  [ordered]@{ ok = $true; pngBase64 = $PngBase64 } | ConvertTo-Json -Compress",
        "} catch {",
        "  $Message = [string]$_.Exception.Message",
        "  $HResult = [int64]$_.Exception.HResult",
        "  if ($Message -in @('hyper-v-console-vm-not-exact','hyper-v-console-setting-not-exact','hyper-v-console-wmi-job-invalid','hyper-v-console-wmi-job-timeout','hyper-v-console-wmi-job-failed','hyper-v-console-wmi-method-failed','hyper-v-console-rgb565-invalid')) { $Code = $Message }",
        "  elseif ($_.Exception -is [UnauthorizedAccessException] -or $HResult -eq -2147217405) { $Code = 'hyper-v-console-wmi-access-denied' }",
        "  else { $Code = $Stage }",
        "  $Failure = [ordered]@{ ok = $false; code = $Code }",
        "  if ($Code -eq 'hyper-v-console-rgb565-invalid') {",
        "    $Layout = [ordered]@{ completion = $Completion; stage = $RgbStage; rawKind = $RawKind }",
        "    if ($RgbStage -ne 'extract') { $Layout['observedBytes'] = $ObservedBytes }",
        "    if ($RgbStage -eq 'bitmap-stride') { $Layout['observedStride'] = $ObservedStride }",
        "    $Failure['layout'] = $Layout",
        "  }",
        "  $Failure | ConvertTo-Json -Compress -Depth 3",
        "}",
    ].join("\n");
}

function captureFailure(code: string): HyperVWindowsConsoleCaptureResult {
    return { ok: false, code: SAFE_CAPTURE_CODES.has(code) ? code : "hyper-v-console-output-invalid" };
}

function boundedInteger(value: unknown, maximum: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function acceptedRgb565ByteCount(value: number): boolean {
    return value === RGB565_EXPECTED_BYTES || value === RGB565_EXPECTED_BYTES + RGB565_COMPATIBILITY_SURPLUS_BYTES;
}

function rgb565LayoutFailureCode(layout: unknown): string | null {
    if (!layout || typeof layout !== "object" || Array.isArray(layout)) return null;
    const value = layout as Record<string, unknown>;
    const completion = value.completion;
    const stage = value.stage;
    const rawKind = value.rawKind;
    const observedBytes = value.observedBytes;
    const observedStride = value.observedStride;
    if (completion !== "sync" && completion !== "async") return null;
    if (stage === "extract") {
        if ((rawKind !== "missing" && rawKind !== "other") || observedBytes !== undefined || observedStride !== undefined) return null;
    } else if (stage === "byte-count") {
        if (!boundedInteger(observedBytes, MAX_OBSERVED_BYTES)) return null;
        if (rawKind !== "byte-array" || acceptedRgb565ByteCount(observedBytes) || observedStride !== undefined) return null;
    } else if (stage === "bitmap-stride") {
        if (!boundedInteger(observedBytes, MAX_OBSERVED_BYTES)) return null;
        if (rawKind !== "byte-array" || !acceptedRgb565ByteCount(observedBytes)) return null;
        if (!boundedInteger(observedStride, MAX_OBSERVED_STRIDE) || observedStride >= RGB565_ROW_BYTES) return null;
    } else {
        return null;
    }

    const bytes = stage === "extract" ? "" : `,b=${observedBytes}`;
    const stride = stage === "bitmap-stride" ? `,t=${observedStride}` : "";
    return `hyper-v-console-rgb565-invalid[c=${completion},s=${stage},k=${rawKind}${bytes}${stride}]`;
}

function parsePng(stdout: string | Buffer | undefined): Buffer | null {
    const text = String(stdout || "").trim();
    if (!text || text.length > (MAX_PNG_BYTES * 2)) return null;
    let parsed: any;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }
    if (parsed?.ok !== true) return null;
    const encoded = typeof parsed?.pngBase64 === "string" ? parsed.pngBase64 : "";
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
    const png = Buffer.from(encoded, "base64");
    if (png.length < 33 || png.length > MAX_PNG_BYTES || png.toString("base64") !== encoded) return null;
    if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
    if (png.subarray(12, 16).toString("ascii") !== "IHDR") return null;
    if (png.readUInt32BE(16) !== WIDTH || png.readUInt32BE(20) !== HEIGHT) return null;
    return png;
}

function writeExclusiveThenRename(target: string, content: Buffer): void {
    const temporary = `${target}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    let renamed = false;
    try {
        writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        const stat = lstatSync(temporary);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== content.length) throw new Error("hyper-v-console-artifact-publish-failed");
        renameSync(temporary, target);
        renamed = true;
    } finally {
        if (!renamed) rmSync(temporary, { force: true });
    }
}

export function captureHyperVWindowsConsole(input: HyperVWindowsConsoleCaptureInput): HyperVWindowsConsoleCaptureResult {
    if ((input.platform || process.platform) !== "win32") return captureFailure("hyper-v-console-host-not-windows");
    if (!String(input.powershell || "").trim()) return captureFailure("hyper-v-console-powershell-unavailable");
    let vmName: string;
    try {
        vmName = hyperVVmName(input.ownerId, input.deviceId, input.incarnationId);
    } catch {
        return captureFailure("hyper-v-console-identity-invalid");
    }
    const runner = input.spawnSyncImpl || hiddenSpawnSync;
    let spawned: SpawnResult;
    try {
        spawned = runner(String(input.powershell), [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-EncodedCommand",
            encodedPowerShell(captureProgram(vmName)),
        ], {
            encoding: "utf8",
            timeout: 30000,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
        });
    } catch {
        return captureFailure("hyper-v-console-process-failed");
    }
    if (spawned.error?.code === "ETIMEDOUT") return captureFailure("hyper-v-console-process-timeout");
    if (spawned.error?.code === "ENOBUFS") return captureFailure("hyper-v-console-output-too-large");
    if (spawned.error || spawned.status !== 0) return captureFailure("hyper-v-console-process-failed");
    const stdout = String(spawned.stdout || "").trim();
    if (!stdout) return captureFailure("hyper-v-console-output-invalid");
    if (stdout.length > (MAX_PNG_BYTES * 2)) return captureFailure("hyper-v-console-output-too-large");
    let parsed: any;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return captureFailure("hyper-v-console-output-invalid");
    }
    if (parsed?.ok === false) {
        const code = typeof parsed.code === "string" ? parsed.code : "";
        if (code === "hyper-v-console-rgb565-invalid") {
            const layoutCode = rgb565LayoutFailureCode(parsed.layout);
            return layoutCode ? { ok: false, code: layoutCode } : captureFailure("hyper-v-console-output-invalid");
        }
        return captureFailure(code);
    }
    const png = parsePng(stdout);
    if (!png) return captureFailure("hyper-v-console-png-invalid");

    const outputRoot = input.outputRoot || join(repoRoot, "results", "device-lab-real");
    const generatedAt = (input.now || (() => new Date()))().toISOString();
    const timestamp = generatedAt.replace(/[:.]/g, "-");
    const timestampedPath = join(outputRoot, `hyper-v-windows-console-${timestamp}.png`);
    const latestPath = join(outputRoot, "hyper-v-windows-console-latest.png");
    try {
        mkdirSync(outputRoot, { recursive: true });
        writeExclusiveThenRename(timestampedPath, png);
        writeExclusiveThenRename(latestPath, png);
    } catch {
        return captureFailure("hyper-v-console-artifact-publish-failed");
    }
    return { ok: true, latestRelativePath: LATEST_RELATIVE_PATH, latestPath, timestampedPath };
}

export const HYPER_V_WINDOWS_CONSOLE_CAPTURE_DIMENSIONS = { width: WIDTH, height: HEIGHT } as const;
