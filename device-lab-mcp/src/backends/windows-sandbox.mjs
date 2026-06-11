import { randomUUID } from "crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { commandPath, run } from "../commands.mjs";
import { ownerId, slug } from "../context.mjs";
import { fail, jsonResult, textResult } from "../responses.mjs";
import { findWindowsDevice, readWindowsDevices, updateWindowsDevice, writeWindowsDevices } from "../state/windows-state.mjs";

export function windowsDiscovery() {
    const wsb = commandPath("wsb");
    const missing = [];
    if (!wsb) missing.push("wsb");
    return {
        wsb,
        available: missing.length === 0,
        missing,
    };
}

export function windowsBackend() {
    const discovery = windowsDiscovery();
    return {
        name: "windows-sandbox",
        host: "windows-host",
        creatable: true,
        available: discovery.available,
        lazy: true,
        status: discovery.available ? "available" : "missing-prerequisites",
        missing: discovery.missing,
        tools: { wsb: discovery.wsb },
        capabilities: [
            "device_inventory",
            "device_create",
            "device_delete",
            "device_start",
            "device_stop",
            "device_status",
            "device_exec",
            "device_screenshot",
            "device_record_video_start",
            "device_record_video_stop",
            "device_record_video_status",
            "device_upload",
            "device_download",
        ],
    };
}

function windowsInventoryDevice(device) {
    return {
        ...device,
        ownerId: ownerId(),
        helper: windowsHelperMetadata(device),
        configPath: wsbConfigPath(device),
    };
}

function windowsDeviceId(name) {
    return `windows-${slug(name)}`;
}

function windowsScratchDir(device) {
    return join(homedir(), ".ccc/devices/owners", ownerId(), "windows", device.id);
}

function windowsToolsDir(device) {
    return join(windowsScratchDir(device), "tools");
}

function windowsRecordingDir(device) {
    return join(windowsScratchDir(device), "recordings");
}

function windowsRecordingLocalPath(device) {
    return join(windowsRecordingDir(device), `recording-${Date.now()}.zip`);
}

function wsbConfigPath(device) {
    return join(windowsScratchDir(device), `${device.id}.wsb`);
}

function windowsHelperMetadata(device) {
    const scratchDir = windowsScratchDir(device);
    const toolsDir = windowsToolsDir(device);
    const inboxDir = join(scratchDir, "inbox");
    const outboxDir = join(scratchDir, "outbox");
    const uploadsDir = join(scratchDir, "uploads");
    const downloadsDir = join(scratchDir, "downloads");
    return {
        scratchDir,
        toolsDir,
        inboxDir,
        outboxDir,
        uploadsDir,
        downloadsDir,
        hostHelperScript: join(toolsDir, "ccc-guest-helper.ps1"),
        guestScratchDir: "C:\\ccc\\scratch",
        guestToolsDir: "C:\\ccc\\tools",
        guestInboxDir: "C:\\ccc\\scratch\\inbox",
        guestOutboxDir: "C:\\ccc\\scratch\\outbox",
        guestUploadsDir: "C:\\ccc\\scratch\\uploads",
        guestDownloadsDir: "C:\\ccc\\scratch\\downloads",
        status: "file-channel",
        requiredFor: ["device_exec", "device_screenshot", "device_record_video_start", "device_record_video_stop", "device_upload", "device_download"],
    };
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

function windowsHelperScript(helper) {
    return [
        "$ErrorActionPreference = 'Stop'",
        `$Inbox = '${helper.guestInboxDir}'`,
        `$Outbox = '${helper.guestOutboxDir}'`,
        `$Uploads = '${helper.guestUploadsDir}'`,
        `$Downloads = '${helper.guestDownloadsDir}'`,
        "$Recordings = @{}",
        "New-Item -ItemType Directory -Force -Path $Inbox,$Outbox,$Uploads,$Downloads | Out-Null",
        "while ($true) {",
        "  Get-ChildItem -Path $Inbox -Filter '*.json' -ErrorAction SilentlyContinue | ForEach-Object {",
        "    $RequestPath = $_.FullName",
        "    $Request = $null",
        "    try {",
        "      $Request = Get-Content -Raw -Path $RequestPath | ConvertFrom-Json",
        "      $Response = [ordered]@{ id = $Request.id; ok = $true; type = $Request.type }",
        "      switch ($Request.type) {",
        "        'exec' {",
        "          $StdoutPath = Join-Path $Downloads ($Request.id + '.stdout.txt')",
        "          $StderrPath = Join-Path $Downloads ($Request.id + '.stderr.txt')",
        "          $Process = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-Command',$Request.command) -RedirectStandardOutput $StdoutPath -RedirectStandardError $StderrPath -Wait -PassThru",
        "          $Response.stdout = if (Test-Path $StdoutPath) { Get-Content -Raw -Path $StdoutPath } else { '' }",
        "          $Response.stderr = if (Test-Path $StderrPath) { Get-Content -Raw -Path $StderrPath } else { '' }",
        "          $Response.status = $Process.ExitCode",
        "        }",
        "        'screenshot' {",
        "          Add-Type -AssemblyName System.Windows.Forms",
        "          Add-Type -AssemblyName System.Drawing",
        "          $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "          $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height",
        "          $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)",
        "          $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)",
        "          $OutputPath = Join-Path $Downloads ($Request.id + '.png')",
        "          $Bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "          $Graphics.Dispose(); $Bitmap.Dispose()",
        "          $Response.imagePath = $OutputPath",
        "        }",
        "        'upload' {",
        "          Copy-Item -Force -Path $Request.uploadPath -Destination $Request.remotePath",
        "          $Response.uploaded = @{ remotePath = $Request.remotePath }",
        "        }",
        "        'download' {",
        "          $OutputPath = Join-Path $Downloads ($Request.id + '-' + [IO.Path]::GetFileName($Request.remotePath))",
        "          Copy-Item -Force -Path $Request.remotePath -Destination $OutputPath",
        "          $Response.downloadPath = $OutputPath",
        "        }",
        "        'record_start' {",
        "          $SessionId = if ($Request.sessionId) { $Request.sessionId } else { $Request.id }",
        "          if ($Recordings.ContainsKey($SessionId)) { throw \"Recording already active: $SessionId\" }",
        "          $FrameDir = Join-Path $Downloads ($SessionId + '-frames')",
        "          New-Item -ItemType Directory -Force -Path $FrameDir | Out-Null",
        "          $IntervalMs = if ($Request.intervalMs) { [int]$Request.intervalMs } else { 1000 }",
        "          $TimeLimitSec = if ($Request.timeLimitSec) { [int]$Request.timeLimitSec } else { 0 }",
        "          $Job = Start-Job -ArgumentList $FrameDir,$IntervalMs,$TimeLimitSec -ScriptBlock {",
        "            param($FrameDir,$IntervalMs,$TimeLimitSec)",
        "            Add-Type -AssemblyName System.Windows.Forms",
        "            Add-Type -AssemblyName System.Drawing",
        "            $Index = 0",
        "            $StopAt = if ($TimeLimitSec -gt 0) { [DateTime]::UtcNow.AddSeconds($TimeLimitSec) } else { $null }",
        "            while ($true) {",
        "              if ($StopAt -and [DateTime]::UtcNow -ge $StopAt) { break }",
        "              $Bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
        "              $Bitmap = New-Object System.Drawing.Bitmap $Bounds.Width, $Bounds.Height",
        "              $Graphics = [System.Drawing.Graphics]::FromImage($Bitmap)",
        "              $Graphics.CopyFromScreen($Bounds.Location, [System.Drawing.Point]::Empty, $Bounds.Size)",
        "              $FramePath = Join-Path $FrameDir ('frame-{0:D6}.png' -f $Index)",
        "              $Bitmap.Save($FramePath, [System.Drawing.Imaging.ImageFormat]::Png)",
        "              $Graphics.Dispose(); $Bitmap.Dispose()",
        "              $Index += 1",
        "              Start-Sleep -Milliseconds $IntervalMs",
        "            }",
        "          }",
        "          $Recordings[$SessionId] = @{ job = $Job; frameDir = $FrameDir; timeLimitSec = $TimeLimitSec; startedAt = (Get-Date).ToString('o') }",
        "          $Response.recording = @{ sessionId = $SessionId; frameDir = $FrameDir; timeLimitSec = $TimeLimitSec; provider = 'windows-helper-frame-archive' }",
        "        }",
        "        'record_status' {",
        "          $SessionId = $Request.sessionId",
        "          if ($SessionId -and $Recordings.ContainsKey($SessionId)) {",
        "            $Entry = $Recordings[$SessionId]",
        "            if ($Entry.job.State -eq 'Running') {",
        "              $Response.recording = @{ sessionId = $SessionId; active = $true; state = $Entry.job.State; frameDir = $Entry.frameDir; provider = 'windows-helper-frame-archive' }",
        "            } else {",
        "              $ArchivePath = Join-Path $Downloads ($SessionId + '.zip')",
        "              if (Test-Path $ArchivePath) { Remove-Item -Force -Path $ArchivePath }",
        "              if (-not (Get-ChildItem -Path $Entry.frameDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {",
        "                @{ sessionId = $SessionId; provider = 'windows-helper-frame-archive'; note = 'No frames captured before completion.' } | ConvertTo-Json | Set-Content -Path (Join-Path $Entry.frameDir 'metadata.json') -Encoding UTF8",
        "              }",
        "              Compress-Archive -Path (Join-Path $Entry.frameDir '*') -DestinationPath $ArchivePath -Force",
        "              Remove-Job -Job $Entry.job -Force -ErrorAction SilentlyContinue | Out-Null",
        "              $Recordings.Remove($SessionId)",
        "              $Response.recording = @{ sessionId = $SessionId; active = $false; state = $Entry.job.State; archivePath = $ArchivePath; provider = 'windows-helper-frame-archive' }",
        "            }",
        "          } else {",
        "            $Response.recording = $null",
        "          }",
        "        }",
        "        'record_stop' {",
        "          $SessionId = $Request.sessionId",
        "          if (-not $SessionId -or -not $Recordings.ContainsKey($SessionId)) { throw \"No recording active: $SessionId\" }",
        "          $Entry = $Recordings[$SessionId]",
        "          Stop-Job -Job $Entry.job -ErrorAction SilentlyContinue | Out-Null",
        "          Wait-Job -Job $Entry.job -Timeout 3 -ErrorAction SilentlyContinue | Out-Null",
        "          Remove-Job -Job $Entry.job -Force -ErrorAction SilentlyContinue | Out-Null",
        "          $ArchivePath = Join-Path $Downloads ($SessionId + '.zip')",
        "          if (Test-Path $ArchivePath) { Remove-Item -Force -Path $ArchivePath }",
        "          if (-not (Get-ChildItem -Path $Entry.frameDir -ErrorAction SilentlyContinue | Select-Object -First 1)) {",
        "            @{ sessionId = $SessionId; provider = 'windows-helper-frame-archive'; note = 'No frames captured before stop.' } | ConvertTo-Json | Set-Content -Path (Join-Path $Entry.frameDir 'metadata.json') -Encoding UTF8",
        "          }",
        "          Compress-Archive -Path (Join-Path $Entry.frameDir '*') -DestinationPath $ArchivePath -Force",
        "          $Recordings.Remove($SessionId)",
        "          $Response.recording = @{ sessionId = $SessionId; active = $false; archivePath = $ArchivePath; provider = 'windows-helper-frame-archive' }",
        "        }",
        "        default { throw \"Unknown request type: $($Request.type)\" }",
        "      }",
        "    } catch {",
        "      $RequestId = if ($Request -and $Request.id) { $Request.id } else { [IO.Path]::GetFileNameWithoutExtension($RequestPath) }",
        "      $Response = [ordered]@{ id = $RequestId; ok = $false; error = $_.Exception.Message }",
        "    }",
        "    $Response | ConvertTo-Json -Depth 8 | Set-Content -Path (Join-Path $Outbox ($Response.id + '.json')) -Encoding UTF8",
        "    Remove-Item -Force -Path $RequestPath",
        "  }",
        "  Start-Sleep -Milliseconds 250",
        "}",
        "",
    ].join("\n");
}

function ensureHelperWorkspace(device) {
    const helper = windowsHelperMetadata(device);
    for (const dir of [helper.scratchDir, helper.toolsDir, helper.inboxDir, helper.outboxDir, helper.uploadsDir, helper.downloadsDir, windowsRecordingDir(device)]) {
        mkdirSync(dir, { recursive: true });
    }
    writeFileSync(helper.hostHelperScript, windowsHelperScript(helper), { mode: 0o600 });
    return helper;
}

function writeWsbConfig(device) {
    const helper = ensureHelperWorkspace(device);
    const scratch = helper.scratchDir;
    const tools = helper.toolsDir;
    const networking = device.networking === true ? "Enable" : "Disable";
    const clipboard = device.clipboard === true ? "Enable" : "Disable";
    const vgpu = device.vgpu === true ? "Enable" : "Disable";
    const memoryMb = device.memoryMb || 4096;
    const config = [
        "<Configuration>",
        `  <VGpu>${vgpu}</VGpu>`,
        `  <Networking>${networking}</Networking>`,
        `  <ClipboardRedirection>${clipboard}</ClipboardRedirection>`,
        `  <MemoryInMB>${memoryMb}</MemoryInMB>`,
        "  <MappedFolders>",
        "    <MappedFolder>",
        `      <HostFolder>${escapeXml(scratch)}</HostFolder>`,
        `      <SandboxFolder>${escapeXml(helper.guestScratchDir)}</SandboxFolder>`,
        "      <ReadOnly>false</ReadOnly>",
        "    </MappedFolder>",
        "    <MappedFolder>",
        `      <HostFolder>${escapeXml(tools)}</HostFolder>`,
        `      <SandboxFolder>${escapeXml(helper.guestToolsDir)}</SandboxFolder>`,
        "      <ReadOnly>true</ReadOnly>",
        "    </MappedFolder>",
        "  </MappedFolders>",
        "  <LogonCommand>",
        `    <Command>powershell.exe -ExecutionPolicy Bypass -File ${escapeXml(helper.guestToolsDir)}\\ccc-guest-helper.ps1</Command>`,
        "  </LogonCommand>",
        "</Configuration>",
        "",
    ].join("\n");
    const path = wsbConfigPath(device);
    writeFileSync(path, config, { mode: 0o600 });
    return path;
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function windowsHelperRequest(device, type, payload = {}, timeoutMs = 5000) {
    const helper = ensureHelperWorkspace(device);
    const id = randomUUID();
    const requestPath = join(helper.inboxDir, `${id}.json`);
    const responsePath = join(helper.outboxDir, `${id}.json`);
    writeFileSync(requestPath, JSON.stringify({ id, type, ...payload }, null, 2), { mode: 0o600 });

    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() <= deadline) {
        if (existsSync(responsePath)) {
            const response = JSON.parse(readFileSync(responsePath, "utf-8"));
            return { helper, response };
        }
        await sleep(100);
    }
    return { helper, error: `Windows Sandbox helper did not respond within ${timeoutMs}ms. Inbox: ${helper.inboxDir}` };
}

function windowsPathBasename(value) {
    return String(value || "").split(/[\\/]/).filter(Boolean).pop() || "";
}

function helperOutputPath(helper, responseValue, fallbackName) {
    if (!responseValue) return join(helper.downloadsDir, fallbackName);
    if (existsSync(responseValue)) return responseValue;
    return join(helper.downloadsDir, windowsPathBasename(responseValue));
}

async function reconcileWindowsRecording(device, helperTimeoutMs = 1000) {
    if (!device?.recording?.active) return { device, statusCheck: null };
    const result = await windowsHelperRequest(device, "record_status", { sessionId: device.recording.sessionId }, helperTimeoutMs);
    if (result.error || !result.response?.ok) return {
        device,
        statusCheck: result.error || result.response?.error || "Windows helper recording status failed",
    };
    if (!result.response.recording?.active) {
        if (result.response.recording?.archivePath && device.recording?.localPath) {
            const hostArchivePath = result.response.recording.hostArchivePath || helperOutputPath(result.helper, result.response.recording.archivePath, `${device.recording.sessionId}.zip`);
            mkdirSync(dirname(device.recording.localPath), { recursive: true });
            if (existsSync(hostArchivePath)) copyFileSync(hostArchivePath, device.recording.localPath);
        }
        const updated = updateWindowsDevice(device.id, (item) => ({
            ...item,
            recording: null,
            updatedAt: new Date().toISOString(),
        }));
        return { device: updated || { ...device, recording: null }, statusCheck: result.response.recording || null };
    }
    return { device, statusCheck: result.response.recording };
}

export function listWindowsDevices() {
    return readWindowsDevices().map((device) => ({ ...device, ownerId: ownerId() }));
}

export async function handleWindowsTool(name, args) {
    switch (name) {
        case "device_inventory": {
            const { backend = "windows-sandbox" } = args;
            if (backend !== "windows-sandbox") return undefined;
            const discovery = windowsDiscovery();
            return jsonResult({
                ownerId: ownerId(),
                backend,
                devices: readWindowsDevices().map(windowsInventoryDevice),
                discovery,
                hostSandboxes: {
                    provider: "wsb",
                    available: discovery.available,
                    command: discovery.wsb,
                    missing: discovery.missing,
                    lazy: true,
                    note: "Windows Sandbox does not expose a stable all-sandbox inventory through the baseline wsb CLI; owner definitions are listed without starting sandboxes.",
                },
            });
        }

        case "device_create": {
            const { backend, name: deviceName, deviceId, networking = false, clipboard = false, vgpu = false, memoryMb = 4096 } = args;
            if (backend !== "windows-sandbox") return undefined;

            const id = deviceId || windowsDeviceId(deviceName);
            const devices = readWindowsDevices();
            if (devices.some((device) => device.id === id)) {
                return textResult(false, `Device already exists for this owner: ${id}`);
            }

            const device = {
                id,
                name: deviceName,
                backend,
                kind: "desktop",
                platform: "windows",
                ownerId: ownerId(),
                networking: Boolean(networking),
                clipboard: Boolean(clipboard),
                vgpu: Boolean(vgpu),
                memoryMb,
                helper: ensureHelperWorkspace({ id }),
                recording: null,
                status: "stopped",
                creatable: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
            };
            devices.push(device);
            writeWindowsDevices(devices);
            return jsonResult({ device });
        }

        case "device_delete": {
            const { deviceId, force = false } = args;
            const devices = readWindowsDevices();
            const device = devices.find((item) => item.id === deviceId);
            if (!device) return undefined;
            if (!force && device.status !== "stopped") {
                return textResult(false, `Refusing to delete ${deviceId} while status is ${device.status}`);
            }
            writeWindowsDevices(devices.filter((item) => item.id !== deviceId));
            return jsonResult({ deleted: deviceId });
        }

        case "device_status": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            return jsonResult({ device: { ...device, helper: windowsHelperMetadata(device) }, backend: windowsBackend() });
        }

        case "device_start": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;

            const discovery = windowsDiscovery();
            if (!discovery.available) {
                return textResult(false, `Windows Sandbox backend missing prerequisites: ${discovery.missing.join(", ")}`);
            }

            const configPath = writeWsbConfig(device);
            const r = run(discovery.wsb, ["start", configPath]);
            if (r.status !== 0) return fail(r);

            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                status: "running",
                configPath,
                helper: windowsHelperMetadata(item),
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_stop": {
            const { deviceId } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;

            const discovery = windowsDiscovery();
            if (discovery.available) run(discovery.wsb, ["stop"]);

            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                status: "stopped",
                recording: null,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ device: updated });
        }

        case "device_exec": {
            const { deviceId, command, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "exec", { command }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper exec failed");
            return jsonResult({
                stdout: result.response.stdout || "",
                stderr: result.response.stderr || "",
                status: result.response.status ?? 0,
                provider: "windows-helper",
            });
        }

        case "device_screenshot": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "screenshot", {}, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper screenshot failed");
            const imagePath = result.response.hostImagePath || helperOutputPath(result.helper, result.response.imagePath, `${result.response.id}.png`);
            if (!existsSync(imagePath)) return textResult(false, `Windows helper screenshot output missing: ${imagePath}`);
            return { content: [{ type: "image", data: readFileSync(imagePath).toString("base64"), mimeType: "image/png" }] };
        }

        case "device_record_video_status": {
            const { deviceId, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const reconciled = await reconcileWindowsRecording(device, helperTimeoutMs || 1000);
            return jsonResult({
                deviceId,
                recording: reconciled.device.recording || null,
                provider: "windows-helper-frame-archive",
                helper: reconciled.statusCheck || null,
            });
        }

        case "device_record_video_start": {
            const { deviceId, localPath, timeLimitSec, helperTimeoutMs } = args;
            let device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (device.recording?.active) {
                const reconciled = await reconcileWindowsRecording(device, helperTimeoutMs || 1000);
                device = reconciled.device;
                if (device.recording?.active) return textResult(false, `Windows Sandbox recording already active for ${deviceId}`);
            }
            const sessionId = `recording-${randomUUID()}`;
            const resolvedLocalPath = localPath || windowsRecordingLocalPath(device);
            mkdirSync(dirname(resolvedLocalPath), { recursive: true });
            const intervalMs = timeLimitSec && timeLimitSec < 30 ? 500 : 1000;
            const result = await windowsHelperRequest(device, "record_start", { sessionId, intervalMs, timeLimitSec: timeLimitSec || 0 }, helperTimeoutMs || 5000);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper recording start failed");
            const recording = {
                active: true,
                provider: "windows-helper-frame-archive",
                sessionId,
                localPath: resolvedLocalPath,
                remotePath: result.response.recording?.frameDir || null,
                timeLimitSec: timeLimitSec || null,
                startedAt: new Date().toISOString(),
            };
            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                recording,
                updatedAt: new Date().toISOString(),
            }));
            return jsonResult({ deviceId, recording: updated.recording, helper: result.response.recording || null });
        }

        case "device_record_video_stop": {
            const { deviceId, localPath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            if (!device.recording?.active) return textResult(false, `No Windows Sandbox recording active for ${deviceId}`);
            const result = await windowsHelperRequest(device, "record_stop", { sessionId: device.recording.sessionId }, helperTimeoutMs || 10000);
            const previous = device.recording;
            const updated = updateWindowsDevice(deviceId, (item) => ({
                ...item,
                recording: null,
                updatedAt: new Date().toISOString(),
            }));
            if (result.error) return textResult(false, `${result.error}. Windows Sandbox recording state cleared for ${deviceId}.`);
            if (!result.response.ok) return textResult(false, `${result.response.error || "Windows helper recording stop failed"}. Windows Sandbox recording state cleared for ${deviceId}.`);
            const hostArchivePath = result.response.recording?.hostArchivePath || helperOutputPath(result.helper, result.response.recording?.archivePath, `${previous.sessionId}.zip`);
            const resolvedLocalPath = localPath || previous.localPath || windowsRecordingLocalPath(device);
            mkdirSync(dirname(resolvedLocalPath), { recursive: true });
            if (existsSync(hostArchivePath)) copyFileSync(hostArchivePath, resolvedLocalPath);
            if (!existsSync(resolvedLocalPath)) return textResult(false, `Windows helper recording output missing: ${hostArchivePath}. Windows Sandbox recording state cleared for ${deviceId}.`);
            return jsonResult({
                deviceId,
                stopped: true,
                provider: "windows-helper-frame-archive",
                recording: { ...previous, active: false, localPath: resolvedLocalPath, stoppedAt: new Date().toISOString() },
                device: updated,
                helper: result.response.recording || null,
            });
        }

        case "device_upload": {
            const { deviceId, localPath, remotePath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const helper = ensureHelperWorkspace(device);
            const uploadId = randomUUID();
            const uploadName = `${uploadId}-${basename(localPath).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
            const hostUploadPath = join(helper.uploadsDir, uploadName);
            copyFileSync(localPath, hostUploadPath);
            const result = await windowsHelperRequest(device, "upload", {
                uploadPath: `${helper.guestUploadsDir}\\${uploadName}`,
                remotePath,
            }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper upload failed");
            return jsonResult({ uploaded: { localPath, remotePath }, provider: "windows-helper", response: result.response });
        }

        case "device_download": {
            const { deviceId, remotePath, localPath, helperTimeoutMs } = args;
            const device = findWindowsDevice(deviceId);
            if (!device) return undefined;
            const result = await windowsHelperRequest(device, "download", { remotePath }, helperTimeoutMs);
            if (result.error) return textResult(false, result.error);
            if (!result.response.ok) return textResult(false, result.response.error || "Windows helper download failed");
            const hostDownloadPath = result.response.hostDownloadPath || helperOutputPath(result.helper, result.response.downloadPath, `${result.response.id}-${windowsPathBasename(remotePath)}`);
            if (!existsSync(hostDownloadPath)) return textResult(false, `Windows helper download output missing: ${hostDownloadPath}`);
            copyFileSync(hostDownloadPath, localPath);
            return jsonResult({ downloaded: { remotePath, localPath }, provider: "windows-helper", response: result.response });
        }

        default:
            return undefined;
    }
}
