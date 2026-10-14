import { hyperVMemoryFailureReason } from "./hyper-v-memory-diagnostic.ts";
import { TOOLS, publicToolName } from "../../device-lab-mcp/src/tools.mjs";
import assert from "assert";
import { closeSync, constants as fsConstants, copyFileSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { windowsVmBackend } from "#device-lab/providers/backends/windows-vm.mjs";
import { ownerId } from "#device-lab/providers/context.mjs";
import { assertDeviceLabPathWithinRoot } from "#device-lab/device-lab-state-file.js";
import { HYPER_V_NETWORK_PREFIX, HYPER_V_NETWORK_GATEWAY, hyperVReadinessCommand, parseHyperVReadiness } from "#device-lab/host-control/hyper-v/index.js";
import { isHyperVWindowsEvaluationReceipt } from "#device-lab/device-lab/hyper-v-image-contracts.js";
import { hiddenSpawnSync, repoRoot } from "./helpers.ts";
import { brokerRollbackSummary, formatBrokerToolFailure, lifecycleDevice, markExpectedToolError, parseToolPayload, withDeviceLabMcp } from "./device-lab-mcp-client.ts";
import { providerMcpSessionOptions } from "./provider-mcp-matrix.ts";
import { cachedImageManifests, selectHyperVWindowsProfile } from "./select-windows-profile.ts";
import { captureHyperVWindowsConsole, type HyperVWindowsConsoleCaptureResult } from "./hyper-v-windows-console-capture.ts";
import { captureHyperVWindowsSetupDiagnostics, publishHyperVWindowsSetupDiagnostics, type HyperVWindowsSetupDiagnosticsResult } from "./hyper-v-windows-setup-diagnostics.ts";
import { requestElevatedSetupDiagnostics, type ElevatedSetupDiagnosticsOutcome } from "./hyper-v-windows-setup-diagnostics-elevation.ts";
import { runHyperVGuiE2E } from "./hyper-v-gui-e2e.ts";

import { readHyperVFixtureDeviceIds, recordHyperVFixtureDeviceId } from "../durability/real-provider-cycles.mjs";
export const HYPER_V_WINDOWS_CONSOLE_TIMELINE_DELAYS_MS = [120000, 300000, 600000, 900000] as const;
export const HYPER_V_WINDOWS_E2E_REBOOT_OPTIONS = Object.freeze({
    force: true,
    waitForBoot: true,
    bootTimeoutMs: 1200000,
});
export const HYPER_V_WINDOWS_E2E_DELETE_OPTIONS = Object.freeze({
    force: true,
    confirmDestructive: true,
    preserveNetwork: true,
});

export function ensureHyperVWindowsDownloadDestination(root: string, file: string): void {
    let descriptor: number | null = null;
    try {
        assertDeviceLabPathWithinRoot(root, file, "hyper-v-windows-e2e-download-destination");
        const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
        try {
            descriptor = openSync(file, fsConstants.O_WRONLY | noFollow);
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
            descriptor = openSync(
                file,
                fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
                0o600,
            );
        }
        const opened = fstatSync(descriptor);
        const path = lstatSync(file);
        assertDeviceLabPathWithinRoot(root, file, "hyper-v-windows-e2e-download-destination");
        if (!opened.isFile()
            || !path.isFile()
            || path.isSymbolicLink()
            || opened.nlink !== 1
            || path.nlink !== 1
            || (opened.dev !== 0 && path.dev !== 0 && opened.dev !== path.dev)
            || (opened.ino !== 0 && path.ino !== 0 && opened.ino !== path.ino)) {
            throw new Error("hyper-v-windows-e2e-download-destination-invalid");
        }
        ftruncateSync(descriptor, 0);
    } catch (error) {
        if (error instanceof Error && error.message === "hyper-v-windows-e2e-download-destination-invalid") throw error;
        throw new Error("hyper-v-windows-e2e-download-destination-invalid");
    } finally {
        if (descriptor !== null) closeSync(descriptor);
    }
}

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
export function hyperVWindowsToolPayload(result: any) {
    const value = parseToolPayload(result);
    if (value?.ok === false) {
        const error = new Error(formatBrokerToolFailure(value, "Hyper-V broker operation failed"));
        Object.defineProperty(error, "brokerPayload", { value });
        throw error;
    }
    return value;
}
const payload = hyperVWindowsToolPayload;

export function assertHyperVWindowsNetwork(device: any, expected = {
    prefix: HYPER_V_NETWORK_PREFIX, gateway: HYPER_V_NETWORK_GATEWAY,
}): string {
    assert.strictEqual(device.networkPrefix, expected.prefix);
    assert.strictEqual(device.networkGateway, expected.gateway);
    const subnet = expected.prefix.replace(/0\/24$/, "");
    const address = String(device.networkAddress || "");
    assert.ok(address.startsWith(subnet), "VM address must belong to the configured Hyper-V subnet");
    const host = address.slice(subnet.length);
    assert.match(host, /^(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/);
    assert.notStrictEqual(address, expected.gateway, "VM address must not use the gateway");
    return address;
}

export function assertHyperVWindowsDeleted(inventoryResponse: any, deleteResponse: any, deviceId: string): void {
    const inventory = resultValue(payload(inventoryResponse));
    assert.ok(Array.isArray(inventory?.devices), "post-delete inventory must contain devices");
    assert.ok(inventory.devices.every((device: any) => typeof device?.deviceId === "string" && device.deviceId), "post-delete inventory must identify every device");
    assert.ok(!inventory.devices.some((device: any) => device?.deviceId === deviceId), "deleted VM remains in inventory");
    // This call deliberately exercises the public missing-device error contract.
    const missing = parseToolPayload({ ...deleteResponse, isError: false });
    assert.strictEqual(missing?.ok, false);
    assert.strictEqual(missing?.error, "device-not-found");
    assert.strictEqual(missing?.deviceId, deviceId);
    markExpectedToolError(deleteResponse);
}

function resultValue(value: any) {
    return value?.result && typeof value.result === "object" ? value.result : value;
}

export async function hyperVWindowsFailureReason(input: {
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
    elevateSetupDiagnosticsImpl?: typeof requestElevatedSetupDiagnostics;
    publishSetupDiagnosticsImpl?: typeof publishHyperVWindowsSetupDiagnostics;
    allowSetupDiagnosticsElevation?: boolean;
}): Promise<string> {
    const profileTag = `profile=${input.profile}${input.sourceImage ? " sourceImage=set" : ""}`;
    const brokerPayload = (input.error as any)?.brokerPayload;
    const memoryFailure = hyperVMemoryFailureReason(brokerPayload);
    if (memoryFailure) return `${profileTag}; ${input.step}: ${memoryFailure}`;
    const message = `${input.step}: ${(input.error as any)?.message || String(input.error)}`;
    // A failed create never sets `created`, so every create failure returns just below. Its
    // rollback is what says whether the failure left a VM or an allocation behind. The broker
    // message normally carries it; when that message lost it (cut at its cap), it comes back here.
    const rollback = brokerRollbackSummary((input.error as any)?.brokerPayload);
    const originalReason = rollback && !message.includes(rollback) ? `${message}; ${rollback}` : message;
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
    // The mount failed for want of a privilege. Preserve that diagnosis without opening UAC by
    // default. An explicit caller or env opt-in may request one elevated collection for this failed
    // fixture without relaunching the whole test process.
    //
    // Elevation is attempted at most once, only after opt-in, and only for the privilege code.
    if (setupDiagnostics.ok === false
        && setupDiagnostics.code.startsWith("hyper-v-setup-diagnostics-mount-privilege-required[")) {
        const originalSetupDiagnosticsCode = setupDiagnostics.code;
        if (input.allowSetupDiagnosticsElevation !== true) {
            setupDiagnostics = { ok: false, code: `${originalSetupDiagnosticsCode}(elevation=disabled)` };
        } else {
            const elevate = input.elevateSetupDiagnosticsImpl || requestElevatedSetupDiagnostics;
            let outcome: ElevatedSetupDiagnosticsOutcome;
            try {
                // No PowerShell path is sent. The child resolves its own from \\?\GLOBALROOT\SystemRoot:
                // this side's copy comes from `where powershell.exe` on the invoking user's PATH, and
                // handing that to an elevated process means it runs an executable an unelevated user
                // could choose. The digest does not help — it faithfully carries the path this side
                // picked, which is the problem.
                outcome = await elevate({
                    ownerId: input.ownerId || ownerId(process.env, repoRoot),
                    deviceId: input.deviceId,
                    incarnationId: input.incarnationId,
                    vmId: input.vmId || "",
                }, { platform: input.platform || process.platform });
            } catch {
                outcome = { attempted: true, errorCode: "elevation-request-failed" };
            }
            if (outcome.attempted === true && "result" in outcome) {
                if (outcome.result.ok === true) {
                    // The elevated child collected the logs; THIS side writes them, under a repository
                    // root only this side knows. publishHyperVWindowsSetupDiagnostics re-validates and
                    // re-redacts the payload through the same validatedLogs the producer used.
                    const published = (input.publishSetupDiagnosticsImpl || publishHyperVWindowsSetupDiagnostics)(outcome.result.logs);
                    // A failed publish — results/ unwritable, disk full — used to replace the code
                    // outright, so the ONE case where the operator paid for a prompt, approved, and the
                    // elevated read SUCCEEDED was the case that rendered like a build that never asked.
                    // Every other branch here keeps both halves; this one now does too.
                    setupDiagnostics = published.ok === true
                        ? published
                        : { ok: false, code: `${originalSetupDiagnosticsCode}(elevation=approved,published=${published.code})` };
                } else {
                    // Approved, ran elevated, and still failed. Replacing the code outright here — which
                    // is what this did first — rendered that byte-identically to a build that never
                    // asked, and it is the one state the plan says the next run exists to settle: the
                    // mount refused with the operator's full rights. So the original is kept and the
                    // elevated outcome named beside it, by code NAME only. The elevated failure can be
                    // another full privilege bracket, and pasting one bracket inside another would spend
                    // the reporter budget the earlier ACs guard on a field nobody parses.
                    const elevatedName = outcome.result.code.split("[")[0];
                    setupDiagnostics = { ok: false, code: `${originalSetupDiagnosticsCode}(elevation=approved,still=${elevatedName})` };
                }
            } else {
                // The unelevated code is kept, not replaced. It is still what happened, and losing it
                // to report the elevation instead would tell the operator less than before. The reason
                // the retry did not land is appended so the two are distinguishable: "we did not ask"
                // and "we asked and it failed" call for different next steps.
                const detail = outcome.attempted === true ? outcome.errorCode : outcome.reason;
                setupDiagnostics = { ok: false, code: `${originalSetupDiagnosticsCode}(elevation=${detail})` };
            }
        }
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

export async function cleanupPrevious(callTool: (tool: string, args: any) => Promise<any>, ownedDeviceIds: Iterable<string> = []) {
    const inventory = resultValue(payload(await callTool("devices", { view: "available", detail: true, backend: "windows-vm" })));
    assert.ok(Array.isArray(inventory?.devices), "cleanup inventory must contain devices");
    for (const deviceId of new Set(ownedDeviceIds)) {
        try {
            const stopped = await callTool("stop", { detail: true, deviceId, force: true });
            const missing = parseToolPayload({ ...stopped, isError: false });
            if (missing?.ok === false && missing.error === "device-not-found" && missing.deviceId === deviceId) markExpectedToolError(stopped);
        } catch {
            // Deletion is still attempted against the exact owner-scoped VM identity.
        }
        const deleted = await callTool("delete", { detail: true,
            deviceId,
            ...HYPER_V_WINDOWS_E2E_DELETE_OPTIONS,
        });
        const observed = parseToolPayload({ ...deleted, isError: false });
        if (observed?.ok === false && observed.error === "device-not-found" && observed.deviceId === deviceId) {
            const freshInventory = await callTool("devices", { view: "available", detail: true, backend: "windows-vm" });
            assertHyperVWindowsDeleted(freshInventory, deleted, deviceId);
        } else {
            payload(deleted);
        }
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

    let deviceId = "";
    const fixtureDeviceIds = new Set<string>();
    let diagnosticIncarnationId: string | undefined;
    const advertisedCapabilities = [...new Set<string>(windowsVmBackend().capabilities.map(name => publicToolName(name, "windows-vm")))].filter(name => TOOLS.some(tool => tool.name === name));
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
        const direct: Record<string, unknown> = {};
        try {
            if (verifyPackagedCandidate) {
                currentStep = "pack current CCC candidate";
                packagedCandidate = createPackagedCccCandidate(tempDir, options);
            }
            currentStep = "recover previous owner-scoped VM residue";
            await cleanupPrevious(callTool, readHyperVFixtureDeviceIds("windows-vm"));

            currentStep = "create VM";
            const createArgs = {
                name: "Real Hyper-V Windows VM Test",
                profile: capability.profile,
                memoryMb: 4096,
                cpus: 2,
                ...(capability.sourceImage ? { sourceImage: capability.sourceImage } : {}),
            };
            const createdDevice = lifecycleDevice(payload(await callTool("create_windows_vm", { detail: true, ...createArgs })), "create");
            deviceId = createdDevice.deviceId;
            direct.deviceId = deviceId;
            fixtureDeviceIds.add(deviceId);
            created = true;
            recordHyperVFixtureDeviceId("windows-vm", deviceId);
            assert.ok(typeof deviceId === "string" && deviceId, "create must return the generated VM ID");
            assert.strictEqual(createdDevice.guestProvisioned, true);
            assert.strictEqual(createdDevice.switchName, "CCC Device Lab");
            const networkAddress = assertHyperVWindowsNetwork(createdDevice);
            const duplicateDevice = lifecycleDevice(payload(await callTool("create_windows_vm", { detail: true, ...createArgs })), "same-name create");
            fixtureDeviceIds.add(duplicateDevice.deviceId);
            recordHyperVFixtureDeviceId("windows-vm", duplicateDevice.deviceId);
            assert.notStrictEqual(duplicateDevice.deviceId, deviceId, "same-name creation must return a new VM ID");
            assert.strictEqual(duplicateDevice.name, createdDevice.name);
            await cleanupPrevious(callTool, [duplicateDevice.deviceId]);
            fixtureDeviceIds.delete(duplicateDevice.deviceId);

            // Native console/setup diagnostics are opt-in and retain their private generation fence.
            const diagnosticDevice = lifecycleDevice(payload(await callTool("status", { detail: true, deviceId })), "diagnostic status");
            diagnosticIncarnationId = typeof diagnosticDevice.incarnationId === "string" ? diagnosticDevice.incarnationId : undefined;
            createdVmId = String(diagnosticDevice.vmId || "");

            currentStep = "inventory VM";
            const inventory = resultValue(payload(await callTool("devices", { view: "available", detail: true, backend: "windows-vm" })));
            assert.ok(Array.isArray(inventory.devices) && inventory.devices.some((device: any) => device.deviceId === deviceId));

            currentStep = "start and wait for PowerShell Direct";
            const stopConsoleTimeline = diagnosticIncarnationId ? scheduleHyperVWindowsConsoleTimeline({
                captureInput: {
                    ownerId: ownerId(process.env, repoRoot),
                    deviceId,
                    incarnationId: diagnosticIncarnationId,
                    powershell: (capability as any).powershell,
                    platform: options.platform || process.platform,
                },
                captureImpl: options.captureConsoleImpl,
                setTimeoutImpl: options.consoleTimelineSetTimeoutImpl,
                clearTimeoutImpl: options.consoleTimelineClearTimeoutImpl,
            }) : () => {};
            let startResult: any;
            try {
                startResult = await callTool("start", { detail: true, ...direct, waitForBoot: true, bootTimeoutMs: 1200000 });
            } finally {
                stopConsoleTimeline();
            }
            const started = lifecycleDevice(payload(startResult), "start");
            assert.strictEqual(started.status, "running");
            assert.strictEqual(started.bootReady, true);
            const startedAgain = lifecycleDevice(payload(await callTool("start", { detail: true, ...direct, waitForBoot: true, bootTimeoutMs: 1200000 })), "start");
            assert.strictEqual(startedAgain.status, "running");

            currentStep = "verify static guest address and NAT connectivity";
            const networkProbeCommand = [
                `$Expected = '${networkAddress}'`,
                "$AddressPresent = [bool](Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object IPAddress -eq $Expected)",
                "$Outbound = Test-NetConnection -ComputerName 1.1.1.1 -Port 443 -InformationLevel Quiet -WarningAction SilentlyContinue",
                "[ordered]@{ addressPresent = $AddressPresent; outbound = [bool]$Outbound } | ConvertTo-Json -Compress",
            ].join("; ");
            const networkProbe = resultValue(payload(await callTool("exec", { detail: true, ...direct, command: networkProbeCommand })));
            const networkResult = JSON.parse(String(networkProbe.stdout || "").trim());
            assert.deepStrictEqual(networkResult, { addressPresent: true, outbound: true });

            currentStep = "read VM status";
            const status = lifecycleDevice(payload(await callTool("status", { detail: true, ...direct })), "status");
            assert.strictEqual(status.deviceId, deviceId);
            assert.strictEqual(status.status, "running");

            currentStep = "execute guest command";
            const executed = resultValue(payload(await callTool("exec", { detail: true, ...direct, command: "Write-Output ccc-hyper-v-e2e-ok" })));
            assert.strictEqual(executed.provider, "hyper-v-powershell-direct");
            assert.match(executed.stdout || "", /ccc-hyper-v-e2e-ok/);

            currentStep = "prove Windows GUI screenshot and computer input";
            await runHyperVGuiE2E(callTool, direct, "windows");

            currentStep = "reboot VM and wait for PowerShell Direct";
            const rebooted = lifecycleDevice(payload(await callTool("reboot", { detail: true,
                ...direct,
                ...HYPER_V_WINDOWS_E2E_REBOOT_OPTIONS,
            })), "reboot");
            assert.strictEqual(rebooted.status, "running");
            assert.strictEqual(rebooted.bootReady, true);
            const afterReboot = resultValue(payload(await callTool("exec", { detail: true, ...direct, command: "Write-Output ccc-hyper-v-reboot-ok" })));
            assert.match(afterReboot.stdout || "", /ccc-hyper-v-reboot-ok/);

            currentStep = "upload and download guest file";
            const uploadPath = join(tempDir, "upload.txt");
            const downloadPath = join(tempDir, "download.txt");
            const remotePath = "C:\\ccc\\hyper-v-e2e.txt";
            writeFileSync(uploadPath, "ccc-hyper-v-transfer-ok", "utf8");
            resultValue(payload(await callTool("upload", { detail: true, ...direct, localPath: uploadPath, remotePath })));
            ensureHyperVWindowsDownloadDestination(repoRoot, downloadPath);
            const listing = payload(await callTool("list_files", { detail: true, ...direct, path: "C:\\ccc", limit: 500 }));
            assert.ok(listing.entries.some((entry: any) => entry.name === "hyper-v-e2e.txt" && entry.type === "file"));
            resultValue(payload(await callTool("download", { detail: true, ...direct, remotePath, localPath: downloadPath })));
            assert.strictEqual(readFileSync(downloadPath, "utf8"), "ccc-hyper-v-transfer-ok");

            if (packagedCandidate) {
                currentStep = "run packaged CCC candidate inside guest";
                const guestCandidateRoot = "C:\\ccc\\packaged-candidate";
                resultValue(payload(await callTool("exec", { detail: true,
                    ...direct,
                    command: `Remove-Item -LiteralPath '${guestCandidateRoot}' -Recurse -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Path '${guestCandidateRoot}' -Force | Out-Null`,
                })));
                const guestNodePath = `${guestCandidateRoot}\\node.exe`;
                const guestPackagePath = `${guestCandidateRoot}\\candidate.tgz`;
                const stagedNodePath = join(tempDir, "node.exe");
                copyFileSync(process.execPath, stagedNodePath);
                resultValue(payload(await callTool("upload", { detail: true, ...direct, localPath: stagedNodePath, remotePath: guestNodePath, maxFileBytes: 128 * 1024 * 1024 })));
                resultValue(payload(await callTool("upload", { detail: true, ...direct, localPath: packagedCandidate.packagePath, remotePath: guestPackagePath })));
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
                const packagedExecution = resultValue(payload(await callTool("exec", { detail: true, ...direct, command: packageProbe })));
                const packagedResult = JSON.parse(String(packagedExecution.stdout || "").trim());
                assert.deepStrictEqual({ ok: packagedResult.ok, version: packagedResult.version, exitCode: packagedResult.exitCode }, { ok: true, version: packagedCandidate.version, exitCode: 0 });
                const packagedEvidenceRoot = join(repoRoot, "results", "device-lab-real");
                const packagedEvidencePath = join(packagedEvidenceRoot, "hyper-v-windows-packaged-ccc-latest.json");
                mkdirSync(packagedEvidenceRoot, { recursive: true });
                ensureHyperVWindowsDownloadDestination(repoRoot, packagedEvidencePath);
                resultValue(payload(await callTool("download", { detail: true, ...direct, remotePath: guestResultPath, localPath: packagedEvidencePath })));
                const packagedEvidence = JSON.parse(readFileSync(packagedEvidencePath, "utf8").replace(/^\uFEFF/, ""));
                assert.strictEqual(packagedEvidence.version, packagedCandidate.version);
            }

            currentStep = "create production checkpoint";
            const snapshot = resultValue(payload(await callTool("snapshot", { action: "create", detail: true, ...direct, snapshotName: "durability" })));
            const snapshotId = snapshot.snapshot?.id;
            assert.ok(snapshotId);

            currentStep = "list production checkpoints";
            const snapshotList = resultValue(payload(await callTool("snapshot", { action: "list", detail: true, ...direct })));
            assert.ok(Array.isArray(snapshotList.snapshots));
            assert.ok(snapshotList.snapshots.some((candidate: any) => candidate?.id === snapshotId && candidate?.name === "durability"));

            currentStep = "restore production checkpoint";
            resultValue(payload(await callTool("snapshot", { action: "restore", detail: true, ...direct, snapshotId, force: true, confirmDestructive: true })));

            currentStep = "delete production checkpoint";
            resultValue(payload(await callTool("snapshot", { action: "delete", detail: true, ...direct, snapshotId, confirmDestructive: true })));

            currentStep = "stop VM";
            lifecycleDevice(payload(await callTool("stop", { detail: true, ...direct, force: true })), "stop");
            lifecycleDevice(payload(await callTool("stop", { detail: true, ...direct, force: true })), "stop");

            currentStep = "delete VM";
            payload(await callTool("delete", { detail: true, ...direct, ...HYPER_V_WINDOWS_E2E_DELETE_OPTIONS }));
            created = false;
            fixtureDeviceIds.delete(deviceId);
            currentStep = "verify deleted VM is absent";
            const deletedInventory = await callTool("devices", { view: "available", detail: true, backend: "windows-vm" });
            const duplicateDelete = await callTool("delete", { detail: true,
                ...direct,
                ...HYPER_V_WINDOWS_E2E_DELETE_OPTIONS,
            });
            assertHyperVWindowsDeleted(deletedInventory, duplicateDelete, deviceId);

            currentStep = "verify advertised capability coverage";
            assert.deepStrictEqual(advertisedCapabilities.filter((tool) => !calledCapabilities.has(tool)), []);
            return { status: "PASS", deviceId, verifiedCapabilities: [...calledCapabilities].sort() };
        } catch (error: any) {
            return {
                status: "FAIL",
                reason: await hyperVWindowsFailureReason({
                    profile: capability.profile,
                    sourceImage: (capability as any).sourceImage,
                    step: currentStep,
                    error,
                    created,
                    deviceId,
                    incarnationId: diagnosticIncarnationId,
                    vmId: createdVmId || undefined,
                    powershell: (capability as any).powershell,
                    platform: options.platform || process.platform,
                    captureImpl: options.captureConsoleImpl,
                    setupDiagnosticsImpl: options.captureSetupDiagnosticsImpl,
                    elevateSetupDiagnosticsImpl: options.elevateSetupDiagnosticsImpl,
                    publishSetupDiagnosticsImpl: options.publishSetupDiagnosticsImpl,
                    allowSetupDiagnosticsElevation: options.allowSetupDiagnosticsElevation === true
                        || (options.allowSetupDiagnosticsElevation !== false
                            && process.env.CCC_HYPER_V_SETUP_DIAGNOSTICS_ELEVATE === "1"),
                }),
            };
        } finally {
            for (const fixtureDeviceId of fixtureDeviceIds) {
                try { await callTool("stop", { detail: true, deviceId: fixtureDeviceId, force: true }); } catch { /* best effort */ }
                try {
                    await callTool("delete", { detail: true, deviceId: fixtureDeviceId, ...HYPER_V_WINDOWS_E2E_DELETE_OPTIONS });
                } catch { /* exact fixture ID remains recorded for verified recovery */ }
            }
            rmSync(tempDir, { recursive: true, force: true });
        }
    }, providerMcpSessionOptions(options, "ccc-real-hyper-v-windows-vm-e2e"));
}
