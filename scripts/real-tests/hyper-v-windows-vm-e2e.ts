import assert from "assert";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { windowsVmBackend } from "../../device-lab-mcp/src/backends/windows-vm.mjs";
import { ownerId } from "../../device-lab-mcp/src/context.mjs";
import { hyperVReadinessCommand, parseHyperVReadiness } from "../../src/device-lab/providers/hyper-v.ts";
import { isHyperVWindowsEvaluationReceipt } from "../../src/device-lab/hyper-v-image-contracts.ts";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";
import { formatBrokerToolFailure, lifecycleDevice, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";

const DEVICE_PREFIX = "windows-vm-real-e2e-";

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
    const filename = Array.isArray(report) && typeof report[0]?.filename === "string" ? report[0].filename : "";
    if (!filename || basename(filename) !== filename || !filename.endsWith(".tgz")) {
        throw new Error("npm pack reported an unsafe package artifact filename");
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
    const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    return { packagePath, version: String(packageJson.version || "") };
}

function cachedImageManifests(options: any = {}) {
    const currentOwner = String(options.ownerId || ownerId());
    return [
        join(homedir(), ".ccc", "device-broker-private", "owners", currentOwner, "images", "hyper-v", "windows-11", "manifest.json"),
        join(homedir(), ".ccc", "device-broker-private", "images", "hyper-v", "windows-11", "manifest.json"),
    ];
}

export function selectHyperVWindowsProfile(options: any = {}) {
    const sourceImage = String(options.sourceImage || process.env.CCC_REAL_HYPER_V_WINDOWS_SOURCE_IMAGE || "").trim();
    const manifestPaths = options.cachedManifestPaths || (options.cachedManifestPath ? [options.cachedManifestPath] : cachedImageManifests(options));
    const manifestExists = options.existsSyncImpl || existsSync;
    let cachedWindows11 = false;
    for (const manifestPath of manifestPaths) {
        if (!manifestExists(manifestPath)) continue;
        try {
            const manifest = JSON.parse(String((options.readFileSyncImpl || readFileSync)(manifestPath, "utf8")));
            cachedWindows11 = manifest?.version === 3
                && manifest?.profile === "windows-11"
                && typeof manifest?.imagePath === "string"
                && manifest.imagePath.length > 0
                && manifestExists(manifest.imagePath);
        } catch {
            // Invalid or stale manifests are ignored so official automatic acquisition remains available.
        }
        if (cachedWindows11) break;
    }
    return sourceImage || cachedWindows11 ? "windows-11" : "windows-server";
}

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
            const started = lifecycleDevice(payload(await callTool("device_start", { ...direct, waitForBoot: true, bootTimeoutMs: 600000 })), "device_start");
            assert.strictEqual(started.status, "running");
            assert.strictEqual(started.bootReady, true);
            const startedAgain = lifecycleDevice(payload(await callTool("device_start", { ...direct, waitForBoot: true, bootTimeoutMs: 600000 })), "device_start");
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
            const rebooted = lifecycleDevice(payload(await callTool("device_reboot", { ...direct, waitForBoot: true, bootTimeoutMs: 600000 })), "device_reboot");
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
            return { status: "FAIL", reason: `${currentStep}: ${error?.message || String(error)}` };
        } finally {
            if (created) {
                try { await callTool("device_stop", { ...direct, force: true }); } catch { /* best effort */ }
                try { await callTool("device_delete", { ...direct, force: true, confirmDestructive: true }); } catch { /* evidence remains for the next verified recovery */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-hyper-v-windows-vm-e2e"));
}
