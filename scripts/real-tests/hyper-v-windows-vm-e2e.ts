import assert from "assert";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { windowsVmBackend } from "../../device-lab-mcp/src/backends/windows-vm.mjs";
import { ownerId } from "../../device-lab-mcp/src/context.mjs";
import { hyperVReadinessCommand, parseHyperVReadiness } from "../../src/host-control/hyper-v/index.ts";
import { isHyperVWindowsEvaluationReceipt } from "../../src/device-lab/hyper-v-image-contracts.ts";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";
import { formatBrokerToolFailure, lifecycleDevice, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";
import { cachedImageManifests, selectHyperVWindowsProfile } from "./select-windows-profile.ts";
import { captureHyperVWindowsConsole, type HyperVWindowsConsoleCaptureResult } from "./hyper-v-windows-console-capture.ts";
import { captureHyperVWindowsSetupDiagnostics, type HyperVWindowsSetupDiagnosticsResult } from "./hyper-v-windows-setup-diagnostics.ts";

const DEVICE_PREFIX = "windows-vm-real-e2e-";
export const HYPER_V_WINDOWS_CONSOLE_TIMELINE_DELAYS_MS = [120000, 300000, 600000, 900000] as const;

export function scheduleHyperVWindowsConsoleTimeline(input: {
    captureInput: Parameters<typeof captureHyperVWindowsConsole>[0];
    captureImpl?: typeof captureHyperVWindowsConsole;
    setTimeoutImpl?: (callback: () => void, delayMs: number) => unknown;
    clearTimeoutImpl?: (handle: unknown) => void;
}): () => void {
    const capture = input.captureImpl || captureHyperVWindowsConsole;
    const schedule = input.setTimeoutImpl || ((callback, delayMs) => setTimeout(callback, delayMs));
    const clear = input.clearTimeoutImpl || ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let active = true;
    const handles = HYPER_V_WINDOWS_CONSOLE_TIMELINE_DELAYS_MS.map((delayMs) => {
        const handle = schedule(() => {
            if (!active) return;
            try { capture(input.captureInput); } catch { /* timeline evidence is best effort */ }
        }, delayMs);
        if (handle && typeof (handle as { unref?: unknown }).unref === "function") {
            (handle as { unref: () => void }).unref();
        }
        return handle;
    });
    return () => {
        if (!active) return;
        active = false;
        for (const handle of handles) clear(handle);
    };
}

function readHyperVWindowsEvaluationReceipt(setupRoot = join(homedir(), ".ccc", "device-broker-private", "setup")) {
    const receiptPath = join(setupRoot, "hyper-v-windows-evaluation-license.json");
    if (!existsSync(receiptPath)) return null;
    try {
        const value: unknown = JSON.parse(readFileSync(receiptPath, "utf8"));
        return isHyperVWindowsEvaluationReceipt(value) ? value : null;
    } catch {
        return null;
    }
}
function payload(result: any) {
    const value = parseToolPayload(result);
    if (value?.ok === false) {
        throw new Error(formatBrokerToolFailure(value, "Hyper-V broker operation failed"));
    }
    return value;
}

function resultValue(value: any) {
    return value?.result && typeof value.result === "object" ? value.result : value;
}

export function hyperVWindowsFailureReason(input: {
    profile: string;
    sourceImage?: string;
    step: string;
    error: unknown;
    created: boolean;
    deviceId: string;
    incarnationId?: string;
    vmId?: string;
    powershell?: string;
    ownerId?: string;
    platform?: string;
    captureImpl?: typeof captureHyperVWindowsConsole;
    setupDiagnosticsImpl?: typeof captureHyperVWindowsSetupDiagnostics;
}): string {
    const profileTag = `profile=${input.profile}${input.sourceImage ? " sourceImage=set" : ""}`;
    const originalReason = `${input.step}: ${(input.error as any)?.message || String(input.error)}`;
    if (!input.created || !input.incarnationId) return `${profileTag}; ${originalReason}`;
    let capture: HyperVWindowsConsoleCaptureResult;
    try {
        capture = (input.captureImpl || captureHyperVWindowsConsole)({
            ownerId: input.ownerId || ownerId(process.env, repoRoot),
            deviceId: input.deviceId,
            incarnationId: input.incarnationId,
            powershell: input.powershell,
            platform: input.platform || process.platform,
        });
    } catch {
        capture = { ok: false, code: "hyper-v-console-unexpected-failure" };
    }
    const guestConsole = capture.ok === true
        ? capture.latestRelativePath
        : `unavailable(${capture.code})`;
    let setupDiagnostics: HyperVWindowsSetupDiagnosticsResult;
    try {
        setupDiagnostics = (input.setupDiagnosticsImpl || captureHyperVWindowsSetupDiagnostics)({
            ownerId: input.ownerId || ownerId(process.env, repoRoot),
            deviceId: input.deviceId,
            incarnationId: input.incarnationId,
            vmId: input.vmId || "",
            powershell: input.powershell,
            platform: input.platform || process.platform,
        });
    } catch {
        setupDiagnostics = { ok: false, code: "hyper-v-setup-diagnostics-unexpected-failure" };
    }
    const guestSetupDiagnostics = setupDiagnostics.ok === true
        ? setupDiagnostics.latestRelativePath
        : `unavailable(${setupDiagnostics.code})`;
    return `${profileTag}; guestConsole=${guestConsole}; guestSetupDiagnostics=${guestSetupDiagnostics}; ${originalReason}`;
}

export function resolveNpmCliPath(options: any = {}) {
    const nodePath = String(options.nodePath || process.execPath);
    const nodeDir = dirname(nodePath);
    const candidates = [
        join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
        join(dirname(nodeDir), "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    ];
    return candidates
        .map((candidate) => String(candidate || "").trim())
        .find((candidate, index, values) => {
            if (!candidate || values.indexOf(candidate) !== index) return false;
            try {
                return lstatSync(candidate).isFile();
            } catch {
                return false;
            }
        }) || "";
}

function extractPackFilename(report: any): string {
    const entries = Array.isArray(report)
        ? report
        : (report && typeof report === "object" ? [report, ...Object.values(report)] : []);
    for (const entry of entries) {
        if (entry && typeof entry === "object" && typeof (entry as any).filename === "string") {
            const candidate = String((entry as any).filename).trim();
            if (candidate) return candidate;
        }
    }
    return "";
}

export function createPackagedCccCandidate(outputDir: string, options: any = {}) {
    const npmExecPath = resolveNpmCliPath(options);
    if (!npmExecPath || !existsSync(npmExecPath)) throw new Error("npm CLI path is unavailable for packaged CCC probe");
    const packed = (options.spawnSyncImpl || hiddenSpawnSync)(options.nodePath || process.execPath, [
        npmExecPath,
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        outputDir,
    ], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
    });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${String(packed.stderr || packed.error?.message || `exit ${packed.status}`).trim()}`);
    let report: any;
    try {
        report = JSON.parse(String(packed.stdout || "[]"));
    } catch (error: any) {
        throw new Error(`npm pack returned invalid JSON: ${error?.message || String(error)}`);
    }
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const version = String(packageJson.version || "");
    // `npm pack --json` returns an array of { filename, ... } on most npm builds, but some
    // (observed on Windows) emit a single object or an object map — or omit the report from
    // stdout entirely. Resolve the filename shape-agnostically, then fall back to the
    // deterministic tarball name (npm already exited 0 above, so --pack-destination wrote it).
    const reportedFilename = extractPackFilename(report);
    let filename = reportedFilename;
    if (!filename) {
        const sanitizedName = String(packageJson.name || "").replace(/^@/, "").replace(/\//g, "-");
        if (sanitizedName && version) filename = `${sanitizedName}-${version}.tgz`;
    }
    if (!filename || basename(filename) !== filename || !filename.endsWith(".tgz")) {
        const reportShape = Array.isArray(report)
            ? `array(len=${report.length}, entry0Filename=${JSON.stringify(report[0]?.filename)})`
            : `type=${report === null ? "null" : typeof report}, keys=${report && typeof report === "object" ? JSON.stringify(Object.keys(report)) : "n/a"}`;
        throw new Error(`npm pack reported an unsafe package artifact filename: ${JSON.stringify(reportedFilename)} [report ${reportShape}]`);
    }
    const resolvedOutputDir = resolve(outputDir);
    const packagePath = resolve(resolvedOutputDir, filename);
    if (dirname(packagePath) !== resolvedOutputDir) throw new Error("npm pack reported a package artifact outside the output directory");
    let packageStat;
    try {
        packageStat = lstatSync(packagePath);
    } catch {
        throw new Error("npm pack did not produce the reported package artifact");
    }
    if (!packageStat.isFile() || packageStat.isSymbolicLink()) {
        throw new Error("npm pack did not produce a regular package artifact");
    }
    return { packagePath, version };
}

// selectHyperVWindowsProfile / cachedImageManifests now live in the loader-free leaf
// ./select-windows-profile.ts (so the launcher can import them without the source loader).
// Re-exported here to keep existing importers of this module working unchanged.
export { selectHyperVWindowsProfile };

export function hyperVWindowsVmE2ECapability(options: any = {}) {
    if ((options.platform || process.platform) !== "win32") return { available: false, reason: "not a Windows host" };
    const backend = windowsVmBackend();
    const powershell = options.powershell || backend.tools?.powershell;
    if (!powershell) return { available: false, reason: "missing PowerShell" };
    const command = hyperVReadinessCommand(powershell);
    const probe = (options.spawnSyncImpl || hiddenSpawnSync)(command.executable, command.args, {
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
    });
    const readiness = probe.status === 0 ? parseHyperVReadiness(probe.stdout || "") : null;
    if (!readiness?.available) return { available: false, reason: `Hyper-V unavailable${readiness?.missing?.length ? `: ${readiness.missing.join(", ")}` : ""}` };
    const sourceImage = String(options.sourceImage || process.env.CCC_REAL_HYPER_V_WINDOWS_SOURCE_IMAGE || "").trim();
    const profile = selectHyperVWindowsProfile(options);
    if (profile === "windows-server") {
        const receipt = (options.readEvaluationReceiptImpl || readHyperVWindowsEvaluationReceipt)(options.setupRoot);
        if (!receipt) {
            return {
                available: false,
                reason: "Windows evaluation license acceptance not recorded; run ccc devices setup hyper-v --confirm --accept-windows-evaluation-license",
            };
        }
    }
    return { available: true, powershell, sourceImage, profile };
}

async function cleanupPrevious(callTool: (tool: string, args: any) => Promise<any>) {
    const inventory = resultValue(payload(await callTool("device_inventory", { backend: "windows-vm" })));
    const devices = Array.isArray(inventory?.devices) ? inventory.devices : [];
    for (const device of devices.filter((candidate: any) => String(candidate?.id || "").startsWith(DEVICE_PREFIX))) {
        try {
            await callTool("device_stop", { backend: "windows-vm", deviceId: device.id, incarnationId: device.incarnationId, force: true });
        } catch {
            // Deletion is still attempted against the exact owner-scoped VM identity.
        }
        payload(await callTool("device_delete", { backend: "windows-vm", deviceId: device.id, incarnationId: device.incarnationId, force: true, confirmDestructive: true }));
    }
}

export async function runHyperVWindowsVmE2E(options: any = {}) {
    const capability = options.brokerOnly === true
        ? {
            available: true,
            sourceImage: String(options.sourceImage || process.env.CCC_REAL_HYPER_V_WINDOWS_SOURCE_IMAGE || "").trim(),
            profile: selectHyperVWindowsProfile(options),
        }
        : hyperVWindowsVmE2ECapability(options);
    if (!capability.available) return { status: "SKIP", reason: "reason" in capability ? capability.reason : "Hyper-V Windows VM unavailable", capability };

    const deviceId = `${DEVICE_PREFIX}${Date.now()}`;
    const advertisedCapabilities = windowsVmBackend().capabilities;
    const calledCapabilities = new Set<string>();
    const tempParent = join(repoRoot, "results");
    mkdirSync(tempParent, { recursive: true });
    const tempDir = mkdtempSync(join(tempParent, "ccc-hyper-v-windows-e2e-"));
    const verifyPackagedCandidate = options.verifyPackagedCandidate !== false && process.env.CCC_DEVICE_LAB_DURABILITY !== "1";
    let packagedCandidate: ReturnType<typeof createPackagedCccCandidate> | null = null;
    let created = false;
    let createdVmId = "";
    let currentStep = "start MCP session";

    return withDeviceLabMcp(async ({ callTool: rawCallTool }) => {
        const callTool = async (tool: string, args: any) => {
            if (advertisedCapabilities.includes(tool)) calledCapabilities.add(tool);
            return rawCallTool(tool, args);
        };
        const direct: Record<string, unknown> = { backend: "windows-vm", deviceId };
        try {
            if (verifyPackagedCandidate) {
                currentStep = "pack current CCC candidate";
                packagedCandidate = createPackagedCccCandidate(tempDir, options);
            }
            currentStep = "recover previous owner-scoped VM residue";
            await cleanupPrevious(callTool);

            currentStep = "create VM";
            const createArgs = {
                ...direct,
                name: "Real Hyper-V Windows VM Test",
                profile: capability.profile,
                memoryMb: 4096,
                cpus: 2,
                networking: true,
                ...(capability.sourceImage ? { sourceImage: capability.sourceImage } : {}),
            };
            const createdDevice = lifecycleDevice(payload(await callTool("device_create", createArgs)), "device_create");
            direct.incarnationId = createdDevice.incarnationId;
            createdVmId = String(createdDevice.vmId || "");
            created = true;
            assert.strictEqual(createdDevice.id, deviceId);
            assert.strictEqual(createdDevice.guestProvisioned, true);
            assert.strictEqual(createdDevice.switchName, "CCC Device Lab");
            const networkAddress = String(createdDevice.networkAddress || "");
            assert.match(networkAddress, /^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/);
            const duplicateCreate = resultValue(payload(await callTool("device_create", createArgs)));
            assert.strictEqual(duplicateCreate.idempotent, true);
            assert.strictEqual(duplicateCreate.invoked, false);
            assert.strictEqual(duplicateCreate.device?.incarnationId, createdDevice.incarnationId);

            currentStep = "inventory VM";
            const inventory = resultValue(payload(await callTool("device_inventory", { backend: "windows-vm" })));
            assert.ok(Array.isArray(inventory.devices) && inventory.devices.some((device: any) => device.id === deviceId));

            currentStep = "start and wait for PowerShell Direct";
            const stopConsoleTimeline = scheduleHyperVWindowsConsoleTimeline({
                captureInput: {
                    ownerId: ownerId(process.env, repoRoot),
                    deviceId,
                    incarnationId: String(direct.incarnationId),
                    powershell: (capability as any).powershell,
                    platform: options.platform || process.platform,
                },
                captureImpl: options.captureConsoleImpl,
                setTimeoutImpl: options.consoleTimelineSetTimeoutImpl,
                clearTimeoutImpl: options.consoleTimelineClearTimeoutImpl,
            });
            let startResult: any;
            try {
                startResult = await callTool("device_start", { ...direct, waitForBoot: true, bootTimeoutMs: 1200000 });
            } finally {
                stopConsoleTimeline();
            }
            const started = lifecycleDevice(payload(startResult), "device_start");
            assert.strictEqual(started.status, "running");
            assert.strictEqual(started.bootReady, true);
            const startedAgain = lifecycleDevice(payload(await callTool("device_start", { ...direct, waitForBoot: true, bootTimeoutMs: 1200000 })), "device_start");
            assert.strictEqual(startedAgain.status, "running");

            currentStep = "verify static guest address and NAT connectivity";
            const networkProbeCommand = [
                `$Expected = '${networkAddress}'`,
                "$AddressPresent = [bool](Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object IPAddress -eq $Expected)",
                "$Outbound = Test-NetConnection -ComputerName 1.1.1.1 -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue",
                "[ordered]@{ addressPresent = $AddressPresent; outbound = [bool]$Outbound } | ConvertTo-Json -Compress",
            ].join("; ");
            const networkProbe = resultValue(payload(await callTool("device_exec", { ...direct, command: networkProbeCommand })));
            const networkResult = JSON.parse(String(networkProbe.stdout || "").trim());
            assert.deepStrictEqual(networkResult, { addressPresent: true, outbound: true });

            currentStep = "read VM status";
            const status = lifecycleDevice(payload(await callTool("device_status", direct)), "device_status");
            assert.strictEqual(status.id, deviceId);
            assert.strictEqual(status.status, "running");

            currentStep = "execute guest command";
            const executed = resultValue(payload(await callTool("device_exec", { ...direct, command: "Write-Output ccc-hyper-v-e2e-ok" })));
            assert.strictEqual(executed.provider, "hyper-v-powershell-direct");
            assert.match(executed.stdout || "", /ccc-hyper-v-e2e-ok/);

            currentStep = "reboot VM and wait for PowerShell Direct";
            const rebooted = lifecycleDevice(payload(await callTool("device_reboot", { ...direct, waitForBoot: true, bootTimeoutMs: 1200000 })), "device_reboot");
            assert.strictEqual(rebooted.status, "running");
            assert.strictEqual(rebooted.bootReady, true);
            const afterReboot = resultValue(payload(await callTool("device_exec", { ...direct, command: "Write-Output ccc-hyper-v-reboot-ok" })));
            assert.match(afterReboot.stdout || "", /ccc-hyper-v-reboot-ok/);

            currentStep = "upload and download guest file";
            const uploadPath = join(tempDir, "upload.txt");
            const downloadPath = join(tempDir, "download.txt");
            const remotePath = "C:\\ccc\\hyper-v-e2e.txt";
            writeFileSync(uploadPath, "ccc-hyper-v-transfer-ok", "utf8");
            resultValue(payload(await callTool("device_upload", { ...direct, localPath: uploadPath, remotePath })));
            resultValue(payload(await callTool("device_download", { ...direct, remotePath, localPath: downloadPath })));
            assert.strictEqual(readFileSync(downloadPath, "utf8"), "ccc-hyper-v-transfer-ok");

            if (packagedCandidate) {
                currentStep = "run packaged CCC candidate inside guest";
                const guestCandidateRoot = "C:\\ccc\\packaged-candidate";
                resultValue(payload(await callTool("device_exec", {
                    ...direct,
                    command: `Remove-Item -LiteralPath '${guestCandidateRoot}' -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path '${guestCandidateRoot}' -Force | Out-Null`,
                })));
                const guestNodePath = `${guestCandidateRoot}\\node.exe`;
                const guestPackagePath = `${guestCandidateRoot}\\candidate.tgz`;
                const stagedNodePath = join(tempDir, "node.exe");
                copyFileSync(process.execPath, stagedNodePath);
                resultValue(payload(await callTool("device_upload", { ...direct, localPath: stagedNodePath, remotePath: guestNodePath, maxFileBytes: 128 * 1024 * 1024 })));
                resultValue(payload(await callTool("device_upload", { ...direct, localPath: packagedCandidate.packagePath, remotePath: guestPackagePath })));
                const guestResultPath = `${guestCandidateRoot}\\result.json`;
                const packageProbe = [
                    "$ErrorActionPreference = 'Stop'",
                    `tar.exe -xzf '${guestPackagePath}' -C '${guestCandidateRoot}'`,
                    "if ($LASTEXITCODE -ne 0) { throw ('tar-exit-' + $LASTEXITCODE) }",
                    `$VersionOutput = & '${guestNodePath}' '${guestCandidateRoot}\\package\\dist\\index.js' --version`,
                    "$CliExitCode = $LASTEXITCODE",
                    "$Version = ($VersionOutput | Out-String).Trim()",
                    "if ($CliExitCode -ne 0) { throw ('ccc-exit-' + $CliExitCode) }",
                    `$Result = [ordered]@{ ok = $true; version = $Version; exitCode = $CliExitCode; package = '${packagedCandidate.packagePath.split(/[\\/]/).at(-1)?.replaceAll("'", "''") || "candidate.tgz"}' }`,
                    `$Result | ConvertTo-Json -Compress | Set-Content -LiteralPath '${guestResultPath}' -Encoding UTF8`,
                    `$Result | ConvertTo-Json -Compress`,
                ].join("; ");
                const packagedExecution = resultValue(payload(await callTool("device_exec", { ...direct, command: packageProbe })));
                const packagedResult = JSON.parse(String(packagedExecution.stdout || "").trim());
                assert.deepStrictEqual({ ok: packagedResult.ok, version: packagedResult.version, exitCode: packagedResult.exitCode }, { ok: true, version: packagedCandidate.version, exitCode: 0 });
                const packagedEvidenceRoot = join(repoRoot, "results", "device-lab-real");
                const packagedEvidencePath = join(packagedEvidenceRoot, "hyper-v-windows-packaged-ccc-latest.json");
                mkdirSync(packagedEvidenceRoot, { recursive: true });
                resultValue(payload(await callTool("device_download", { ...direct, remotePath: guestResultPath, localPath: packagedEvidencePath })));
                const packagedEvidence = JSON.parse(readFileSync(packagedEvidencePath, "utf8").replace(/^\uFEFF/, ""));
                assert.strictEqual(packagedEvidence.version, packagedCandidate.version);
            }

            currentStep = "create production checkpoint";
            const snapshot = resultValue(payload(await callTool("device_snapshot_create", { ...direct, snapshotName: "durability" })));
            const snapshotId = snapshot.snapshot?.id;
            assert.ok(snapshotId);

            currentStep = "list production checkpoints";
            const snapshotList = resultValue(payload(await callTool("device_snapshot_list", direct)));
            assert.ok(Array.isArray(snapshotList.snapshots));
            assert.ok(snapshotList.snapshots.some((candidate: any) => candidate?.id === snapshotId && candidate?.name === "durability"));

            currentStep = "restore production checkpoint";
            resultValue(payload(await callTool("device_snapshot_restore", { ...direct, snapshotId, force: true, confirmDestructive: true })));

            currentStep = "delete production checkpoint";
            resultValue(payload(await callTool("device_snapshot_delete", { ...direct, snapshotId, confirmDestructive: true })));

            currentStep = "stop VM";
            lifecycleDevice(payload(await callTool("device_stop", { ...direct, force: true })), "device_stop");
            lifecycleDevice(payload(await callTool("device_stop", { ...direct, force: true })), "device_stop");

            currentStep = "delete VM";
            payload(await callTool("device_delete", { ...direct, force: true, confirmDestructive: true }));
            created = false;
            const duplicateDelete = resultValue(payload(await callTool("device_delete", { ...direct, force: true, confirmDestructive: true })));
            assert.strictEqual(duplicateDelete.idempotent, true);
            assert.strictEqual(duplicateDelete.alreadyMissing, true);

            currentStep = "verify advertised capability coverage";
            assert.deepStrictEqual(advertisedCapabilities.filter((tool) => !calledCapabilities.has(tool)), []);
            return { status: "PASS", deviceId, verifiedCapabilities: [...calledCapabilities].sort() };
        } catch (error: any) {
            return {
                status: "FAIL",
                reason: hyperVWindowsFailureReason({
                    profile: capability.profile,
                    sourceImage: (capability as any).sourceImage,
                    step: currentStep,
                    error,
                    created,
                    deviceId,
                    incarnationId: typeof direct.incarnationId === "string" ? direct.incarnationId : undefined,
                    vmId: createdVmId || undefined,
                    powershell: (capability as any).powershell,
                    platform: options.platform || process.platform,
                    captureImpl: options.captureConsoleImpl,
                    setupDiagnosticsImpl: options.captureSetupDiagnosticsImpl,
                }),
            };
        } finally {
            if (created) {
                try { await callTool("device_stop", { ...direct, force: true }); } catch { /* best effort */ }
                try { await callTool("device_delete", { ...direct, force: true, confirmDestructive: true }); } catch { /* evidence remains for the next verified recovery */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-hyper-v-windows-vm-e2e"));
}
