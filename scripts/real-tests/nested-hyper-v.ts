import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { setTimeout as delay } from "timers/promises";
import { repoRoot } from "./helpers.ts";
import { lifecycleDevice, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { nestedClaimCommand, nestedCompleteClaimCommand } from "./nested-hyper-v-claim.ts";
import { withExclusiveRealProviderRun } from "./exclusive-real-provider-run.ts";
import { ensureHyperVWindowsDownloadDestination } from "./hyper-v-windows-vm-e2e.ts";
import { buildLevel3Artifacts, ensureHostBrokerReady } from "./support/level3-host.ts";
import { snapshotNestedSource } from "./nested-hyper-v-source.ts";
import { HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE, isHyperVWindowsEvaluationReceipt } from "#device-lab/device-lab/hyper-v-image-contracts.js";

import { nestedProgress, nestedGuestProgress, type NestedProgressSink } from "./nested-hyper-v-progress.ts";

const ROOT = "C:\\ccc-nested-development";
const TASK = "CCC Nested Hyper-V Development";
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
type Call = (name: string, args: Record<string, any>) => Promise<any>;

// Only diagnostic fields are retained; request arguments, commands, stdout, and credentials
// are never serialized. Even selected provider text is bounded and scrubbed line by line.
export function nestedDiagnostic(error: unknown, payload?: unknown) {
    const scrub = (value: string) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .split(/\r?\n/).slice(0, 32)
        .map(line => /password|passwd|secret|token|authorization|bearer|credential|securestring|cookie|api[-_]?key|encodedcommand|\b(?:powershell|cmd)\.exe|(?:^|\s)-(?:command|arguments?)\b|^\s*[+>]|\$\w+\s*=|["']?(?:command|args|arguments|input)["']?\s*[:=]/i.test(line)
            ? "[sensitive diagnostic line omitted]" : line.slice(0, 1024)).join("\n").slice(0, 1024);
    const message = error instanceof Error ? error.message : String(error);
    let source: any = (error as any)?.brokerPayload ?? payload;
    if (!source) { try { source = JSON.parse(message); } catch { source = { error: message }; } }
    const queue = [{ value: source, path: "$", depth: 0 }];
    const visited = new Set<object>();
    const diagnostics: Record<string, unknown>[] = [];
    for (let index = 0; index < queue.length && index < 24; index++) {
        const { value, path, depth } = queue[index];
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        if (visited.has(value)) continue;
        visited.add(value);
        const selected: Record<string, unknown> = {};
        for (const key of ["error", "detail", "stderr", "diagnosticCode", "stage", "status", "signal", "timedOut", "outputRedacted"]) {
            if (typeof value[key] === "string") selected[key] = scrub(value[key]);
            else if (typeof value[key] === "boolean" || (typeof value[key] === "number" && Number.isFinite(value[key]))) selected[key] = value[key];
        }
        if (value.status === null) selected.status = null;
        for (const key of ["ready", "structured", "diagnosticAvailable", "diagnosticComplete", "scrubContainmentFailed", "heartbeatEnabled"]) {
            if (typeof value[key] === "boolean") selected[key] = value[key];
        }
        for (const key of ["attempts", "stdoutBytes", "stderrBytes", "uptimeMs", "heartbeatPrimaryStatus", "heartbeatSecondaryStatus"]) {
            if (Number.isSafeInteger(value[key]) && value[key] >= 0) selected[key] = value[key];
        }
        if (typeof value.diagnosticError === "string" && /^hyper-v-[a-z0-9-]{3,120}$/.test(value.diagnosticError)) {
            selected.diagnosticError = scrub(value.diagnosticError);
        }
        if (["Other", "Running", "Off", "Stopping", "Saved", "Paused", "Starting", "Reset", "Saving", "Pausing", "Resuming", "FastSaved", "FastSaving", "ForceShutdown", "ForceReboot", "Hibernated"].includes(value.state)) {
            selected.state = value.state;
        }
        // Host Start-VM can succeed (status 0) while the separate guest-readiness check
        // fails. Retain their origins and bounded readiness facts, not raw guest output.
        if (Object.keys(selected).length) diagnostics.push({ path, ...selected });
        if (depth >= 8) continue;
        for (const key of ["body", "result", "boot", "guestReadiness", "errorDetail", "diagnostic", "execution", "command", "provisioning", "launch"]) {
            if (queue.length >= 32) break;
            if (value[key] && typeof value[key] === "object" && !Array.isArray(value[key])) {
                queue.push({ value: value[key], path: `${path}.${key}`, depth: depth + 1 });
            }
        }
    }
    const candidate = error instanceof Error && (error as NodeJS.ErrnoException).code === "real-provider-test-already-running"
        ? "real-provider-test-already-running"
        : diagnostics.find(value => typeof value.error === "string")?.error ?? message;
    const code = typeof candidate === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(candidate.split(":", 1)[0])
        ? candidate.split(":", 1)[0] : "nested-development-failed";
    return { code, diagnostics };
}

export function saveNestedFailure(error: unknown, outputRoot: string, stage: string, tool?: string, payload?: unknown) {
    const failure = error instanceof Error ? error : new Error(String(error));
    if ((failure as any).nestedFailure) return failure;
    const record = { stage, ...(tool ? { tool } : {}), ...nestedDiagnostic(error, payload),
        ...((failure as any).cleanupFailure ? { cleanup: (failure as any).cleanupFailure } : {}) };
    try {
        mkdirSync(outputRoot, { recursive: true });
        const diagnosticPath = join(outputRoot, "failure.json");
        writeFileSync(diagnosticPath, JSON.stringify(record, null, 2));
        Object.assign(failure, { nestedFailure: { stage, tool, code: record.code, diagnosticPath } });
    } catch {
        Object.assign(failure, { nestedFailure: { stage, tool, code: record.code, diagnosticSaveFailed: true } });
    }
    return failure;
}

export function nestedExecOutput(payload: any): string {
    const value = payload.result ?? payload;
    const command = value.execution?.command ?? value.command ?? value;
    if (command.status !== 0 || typeof command.stdout !== "string") throw Object.assign(new Error("nested-guest-command-failed"), { diagnosticPayload: payload });
    return command.stdout.replace(/^\uFEFF/, "").trim();
}

export const NESTED_PREPARE_COMMAND = `$ErrorActionPreference='Stop'
if ((Get-CimInstance Win32_ComputerSystem).HypervisorPresent -and (Get-Service vmms -ErrorAction SilentlyContinue)) { @{reboot=$false} | ConvertTo-Json -Compress; return }
if (Get-Command Install-WindowsFeature -ErrorAction SilentlyContinue) {
  $result=Install-WindowsFeature Hyper-V -IncludeManagementTools
  if (-not $result.Success) { throw 'nested-feature-install-failed' }
} else { Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All -All -NoRestart | Out-Null }
@{reboot=$true} | ConvertTo-Json -Compress`;

export function nestedLaunchCommand(runId: string, sourceSha: string, nodeVersion: string, target: string) {
    if (!/^[a-f0-9]{32}$/.test(runId) || !/^[a-f0-9]{64}$/.test(sourceSha) || !/^\d+\.\d+\.\d+$/.test(nodeVersion) || !["linux", "windows"].includes(target)) throw new Error("nested-launch-input-invalid");
    const args = `-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${ROOT}\\${runId}\\job.ps1" -RunId ${runId} -SourceSha ${sourceSha} -NodeVersion ${nodeVersion} -Target ${target}`;
    return `$ErrorActionPreference='Stop'
$existing=Get-ScheduledTask -TaskName ${quote(TASK)} -ErrorAction SilentlyContinue
if ($existing -and $existing.State -eq 'Running') { throw 'nested-development-already-running' }
$action=New-ScheduledTaskAction -Execute "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Argument ${quote(args)}
$principal=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 4) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName ${quote(TASK)} -Action $action -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName ${quote(TASK)}
Write-Output 'started'`;
}

export async function runNestedDevelopment(call: Call, options: {
    target?: string; sourceImage?: string; outputRoot: string; licenseReceiptPath?: string;
    snapshot: () => { archive: string; sha256: string }; jobPath: string;
    sleep?: (ms: number) => Promise<unknown>; pollLimit?: number; progress?: NestedProgressSink;
}) {
    let stage = "validate-input";
    const progress = nestedProgress(options.progress);
    const setStage = (value: string) => { stage = value; progress.stage(value); };
    setStage(stage);
    let tool: string | undefined;
    let payload: unknown;
    let identity: { deviceId: string } | undefined;
    let primaryFailure: unknown;
    let preserveVm = false;
    let cleanupAttempted = false;
    const rawCall = call;
    call = async (name, args) => {
        tool = name;
        payload = undefined;
        const result = await rawCall(name, args);
        payload = parseToolPayload(result);
        if ((payload as any)?.ok === false) throw new Error(JSON.stringify(payload));
        return result;
    };
    const cleanup = async (identity: { deviceId: string }) => {
        cleanupAttempted = true;
        setStage("stop-outer-vm");
        parseToolPayload(await call("stop", identity));
        setStage("delete-outer-vm");
        parseToolPayload(await call("delete", { ...identity, force: true, confirmDestructive: true, preserveNetwork: true }));
    };
    try {
      try {
        const target = options.target || "windows";
        if (!["linux", "windows"].includes(target)) throw new Error("nested-target-invalid");
        let licenseReceipt: unknown;
        if (options.licenseReceiptPath) {
            licenseReceipt = JSON.parse(readFileSync(options.licenseReceiptPath, "utf8"));
            if (!isHyperVWindowsEvaluationReceipt(licenseReceipt)) throw new Error("nested-license-receipt-invalid");
        }
        setStage("create-outer-vm");
        const created = lifecycleDevice(parseToolPayload(await call("create_windows_vm", {
            name: "Nested Hyper-V development", profile: "windows-server", memoryMb: 16384, cpus: 4,
            nestedVirtualization: true, ...(options.sourceImage ? { sourceImage: options.sourceImage } : {}), detail: true,
        })), "nested-create");
        const deviceId = created.deviceId;
        if (typeof deviceId !== "string" || !deviceId) throw new Error("nested-create-device-id-missing");
        identity = { deviceId };
        if (created.nestedVirtualization !== true) throw new Error("outer-broker-nesting-not-confirmed: update the physical host CCC once");
        const selected = identity;
        const command = async (command: string) => nestedExecOutput(parseToolPayload(await call("exec", { ...selected, command, timeoutMs: 300000, detail: true })));
        setStage("start-outer-vm");
        parseToolPayload(await call("start", { ...selected, waitForBoot: true, bootTimeoutMs: 1200000 }));
        const runId = randomBytes(16).toString("hex");
        const remote = `${ROOT}\\${runId}`;
        // An atomic guest directory claim prevents two hosts racing the same scheduled task.
        setStage("claim-guest");
        await command(nestedClaimCommand(runId));
        let launched = false;
        let completed = false;
        try {
            setStage("prepare-nested-hyper-v");
            const prepared = JSON.parse(await command(NESTED_PREPARE_COMMAND));
            if (prepared.reboot === true) {
                setStage("reboot-outer-vm");
                // This dedicated development VM permits Restart-VM's hard reset. Force suppresses
                // its additional confirmation prompt for the unattended feature-install reboot.
                parseToolPayload(await call("reboot", { ...selected, force: true, waitForBoot: true, bootTimeoutMs: 1200000 }));
            }
            setStage("create-guest-run-directory");
            await command(`$ErrorActionPreference='Stop'; New-Item -ItemType Directory -Path ${quote(remote)} | Out-Null; Write-Output 'created'`);
            setStage("snapshot-source"); tool = undefined; payload = undefined;
            const snapshot = options.snapshot();
            for (const [localPath, remoteName] of [[snapshot.archive, "source.tar.gz"], [options.jobPath, "job.ps1"]]) {
                setStage(`upload-${remoteName}`);
                parseToolPayload(await call("upload", { ...selected, localPath, remotePath: `${remote}\\${remoteName}`, maxFileBytes: 134217728, timeoutMs: 300000 }));
            }
            if (licenseReceipt) {
                setStage("upload-license-receipt");
                const localPath = join(options.outputRoot, "license.json");
                writeFileSync(localPath, JSON.stringify(licenseReceipt));
                parseToolPayload(await call("upload", { ...selected, localPath, remotePath: `${remote}\\license.json` }));
            }
            setStage("launch-guest-job");
            launched = true;
            preserveVm = true;
            await command(nestedLaunchCommand(runId, snapshot.sha256, process.versions.node, target));
            const deadline = Date.now() + 4 * 60 * 60 * 1000;
            for (let attempt = 0; attempt < (options.pollLimit ?? 960) && Date.now() < deadline; attempt++) {
                if (stage !== "poll-guest-result") setStage("poll-guest-result");
                const output = await command(`if (Test-Path -LiteralPath ${quote(remote + "\\result.json")}) { Get-Content -Raw -LiteralPath ${quote(remote + "\\result.json")} } elseif (Test-Path -LiteralPath ${quote(remote + "\\progress.json")}) { try { $p=Get-Item -LiteralPath ${quote(remote + "\\progress.json")}; if ($p.Length -gt 1024) { throw 'invalid-progress' }; $v=Get-Content -Raw -LiteralPath $p.FullName | ConvertFrom-Json; if ($v.kind -ne 'progress' -or $v.runId -ne '${runId}' -or $v.stage -notin @('bootstrap','install','build','test','cleanup')) { throw 'invalid-progress' }; @{kind='progress';runId=$v.runId;stage=$v.stage} | ConvertTo-Json -Compress } catch { Write-Output 'pending' } } else { Write-Output 'pending' }`);
                if (output !== "pending") {
                    const result = JSON.parse(output);
                    if (result?.kind === "progress") {
                        const guestStage = nestedGuestProgress(result, runId);
                        if (guestStage) progress.stage(`guest-${guestStage} (last reported)`);
                        await (options.sleep || delay)(15000);
                        continue;
                    }
                    if (result.runId !== runId || result.sourceSha256 !== snapshot.sha256) throw new Error("nested-result-identity-mismatch");
                    if (result.status !== "PASS" && result.status !== "FAIL") throw new Error("nested-result-status-invalid");
                    completed = true;
                    preserveVm = false;
                    mkdirSync(options.outputRoot, { recursive: true });
                    writeFileSync(join(options.outputRoot, "result.json"), JSON.stringify(result, null, 2));
                    setStage("download-guest-log");
                    ensureHyperVWindowsDownloadDestination(options.outputRoot, join(options.outputRoot, "job.log"));
                    parseToolPayload(await call("download", { ...selected, remotePath: `${remote}\\job.log`, localPath: join(options.outputRoot, "job.log"), maxFileBytes: 16777216, timeoutMs: 300000 }));
                    setStage("validate-guest-result"); tool = undefined; payload = result;
                    if (result.status !== "PASS") throw new Error(`nested-development-failed: ${result.stage}: ${result.error || result.status}`);
                    return { ...result, deviceId, guestRunPath: remote };
                }
                await (options.sleep || delay)(15000);
            }
            throw new Error(`nested-development-timeout: inspect ${remote}; VM and job preserved`);
        } catch (error) {
            primaryFailure = error instanceof Error ? error : new Error(String(error));
            throw primaryFailure;
        } finally {
            // Keep the claim through shutdown. Only a later boot may reclaim a completed
            // claim, so another host cannot start a job between completion and stop.
            if (!launched || completed) {
                const primaryContext = { stage, tool, payload };
                setStage("complete-guest-claim");
                try {
                    await command(nestedCompleteClaimCommand(runId));
                    await cleanup(selected);
                }
                catch (error) {
                    if (!primaryFailure) throw error;
                    Object.assign(primaryFailure, { cleanupFailure: { stage, tool, ...nestedDiagnostic(error, payload) } });
                } finally {
                    if (primaryFailure) ({ stage, tool, payload } = primaryContext);
                }
            }
        }
      } catch (error) {
        primaryFailure = error instanceof Error ? error : new Error(String(error));
        throw primaryFailure;
      } finally {
        if (identity && !preserveVm && !cleanupAttempted) {
            const primaryContext = { stage, tool, payload };
            try { await cleanup(identity); }
            catch (error) {
                if (!primaryFailure) throw error;
                Object.assign(primaryFailure, { cleanupFailure: { stage, tool, ...nestedDiagnostic(error, payload) } });
            } finally {
                if (primaryFailure) ({ stage, tool, payload } = primaryContext);
            }
        }
      }
    } catch (error) {
        throw saveNestedFailure(error, options.outputRoot, stage, tool, (error as any)?.diagnosticPayload ?? payload);
    } finally { progress.close(); }
}

export function nestedFailureMessage(error: unknown): string {
    const saved = (error as any)?.nestedFailure;
    if (saved) {
        const operation = `${saved.stage}${saved.tool ? `/${saved.tool}` : ""}`;
        const action = saved.code === "real-provider-test-already-running"
            ? " Another real-provider run holds the lock or its owner could not be verified. Wait for it to finish, then retry." : "";
        return `[ccc] ${operation}: ${saved.code}.${action} ${saved.diagnosticPath ? `Diagnostics: ${saved.diagnosticPath}` : "Could not save failure diagnostics."}`;
    }
    const message = error instanceof Error ? error.message : String(error);
    let code: unknown;
    try { code = JSON.parse(message)?.error; } catch { code = message.split(":", 1)[0]; }
    const safeCode = typeof code === "string" && /^[a-z][a-z0-9-]{0,79}$/.test(code)
        ? code : "nested-development-failed";
    if (safeCode.startsWith("host-broker-") || safeCode === "outer-broker-nesting-not-confirmed") {
        return `[ccc] ${safeCode}. Run 'node dist/index.js devices broker status' on the physical host for the repair action, then retry.`;
    }
    return `[ccc] ${safeCode}. No saved run diagnostics are available.`;
}

export async function prepareNestedHost(repo: string, options: {
    platform?: string; diagnosticPath?: string;
    build?: typeof buildLevel3Artifacts;
    ready?: typeof ensureHostBrokerReady;
} = {}) {
    if ((options.platform ?? process.platform) !== "win32") return;
    // Rebuild the local host entry before the identity-checked broker repair, so npm run
    // tests current sources even when dist and the global installation predate this checkout.
    const diagnostics = { writeError: (message: string) => {
        if (options.diagnosticPath) writeFileSync(options.diagnosticPath, String(message).slice(0, 65536));
    } };
    if ((options.build || buildLevel3Artifacts)(repo, diagnostics) !== 0) throw new Error("nested-host-build-failed");
    if (await (options.ready || ensureHostBrokerReady)(repo, diagnostics) !== 0) throw new Error("host-broker-preflight-failed");
}

export async function main() {
    const target = process.argv[2] || "windows";
    if (!["windows", "linux"].includes(target)) throw new Error("nested-target-invalid");
    const outputRoot = join(repoRoot, "results", "nested-hyper-v", randomBytes(8).toString("hex"));
    mkdirSync(outputRoot, { recursive: true });
    const jobPath = join(outputRoot, "job.ps1");
    writeFileSync(jobPath, readFileSync(join(repoRoot, "scripts/real-tests/nested-hyper-v-job.ps1")));
    let stage = "acquire-run-lock";
    const progress = nestedProgress(message => console.log(message));
    progress.stage(stage);
    try {
        await withExclusiveRealProviderRun("nested development", async () => {
            stage = "host-preflight"; progress.stage(stage);
            await prepareNestedHost(repoRoot, { diagnosticPath: join(outputRoot, "preflight.log") });
            stage = "connect-mcp"; progress.stage(stage);
            return withDeviceLabMcp(async ({ callTool }) => {
                const receipt = process.env.CCC_NESTED_LICENSE_RECEIPT || join(homedir(), ".ccc/device-broker-private/setup", HYPER_V_WINDOWS_EVALUATION_RECEIPT_FILE);
                progress.close();
                const result = await runNestedDevelopment(callTool, { target, outputRoot, jobPath,
                    ...(existsSync(receipt) ? { licenseReceiptPath: receipt } : {}),
                    sourceImage: process.env.CCC_NESTED_SOURCE_IMAGE,
                    snapshot: () => snapshotNestedSource(repoRoot, outputRoot),
                    progress: message => console.log(message),
                });
                console.log(JSON.stringify(result));
            });
        });
    } catch (error) {
        throw saveNestedFailure(error, outputRoot, stage);
    } finally { progress.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(nestedFailureMessage(error)); process.exitCode = 1; });
