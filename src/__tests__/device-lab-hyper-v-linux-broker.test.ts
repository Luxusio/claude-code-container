// These lifecycle suites simulate VM effects; host capacity must be simulated too.
// Dedicated capacity tests exercise refusal boundaries.
vi.mock("os", async (importOriginal) => ({
    ...await importOriginal<typeof import("os")>(),
    totalmem: () => 64 * 1024 ** 3,
    freemem: () => 48 * 1024 ** 3,
}));
import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { deflateSync } from "zlib";
import { tmpdir } from "os";
import { dirname, join, sep } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    compareHyperVLinuxEd25519HostKeyFingerprint,
    createDeviceBrokerServer as createRawDeviceBrokerServer,
    DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS,
    DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS,
    hyperVLifecycleCleanupTimeoutMs,
    hyperVLinuxGuestSignalDeadlineAt,
    hyperVLinuxGuestSignalTimedOut,
    hyperVLinuxGuestReadyTraceFailureCode,
    hyperVProviderDeadlineAt,
} from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { HYPER_V_IMAGE_CATALOG } from "@ccc/device-lab/device-lab/hyper-v-images.js";
import {
    HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP,
    type HyperVWindowsExecutionRequest,
} from "@ccc/hyper-v/index.js";
import { backendRoot, cleanupOwner, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";
import {
    configureTypedHyperVNetworkOperations,
    withTypedHyperVNetworkOperations,
} from "./helpers/hyper-v-network-operation-simulator.js";

function createDeviceBrokerServer(options: Parameters<typeof createRawDeviceBrokerServer>[0]) {
    const networkRunner = options.commandRunner && withTypedHyperVNetworkOperations(options.commandRunner, {
        stateFile: join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json"),
    });
    const preludeRunner = options.commandRunner && ((command: Parameters<NonNullable<typeof options.commandRunner>>[0], runnerOptions: Parameters<NonNullable<typeof options.commandRunner>>[1]) => {
        const script = providerScript(command);
        const vhdOperation = automaticUbuntuVhdOperation(command);
        if (vhdOperation) return { ...command, ...vhdOperation };
        const nativeRequest = hyperVWindowsOperationRequest(command);
        if (nativeRequest?.operation === "Remove-HostFiles") {
            let removedCount = 0;
            for (const path of nativeRequest.paths) {
                if (existsSync(path)) {
                    unlinkSync(path);
                    removedCount += 1;
                }
            }
            return { ...command, ...hyperVWindowsOperationSuccess("Remove-HostFiles", [{ removedCount }]) };
        }
        if (script.includes("CCC_HYPER_V_STAGE:hyper-v-create-compensation-failed")) {
            const target = powerShellString(script, "Target");
            if (existsSync(target)) {
                if (lstatSync(target).isDirectory()) rmdirSync(target);
                else unlinkSync(target);
            }
            return { ...command, status: 0, stdout: '{"ok":true}', stderr: "" };
        }
        if (script.includes("$DeviceRootExisted = [bool](Test-Path -LiteralPath $DeviceRoot)")) {
            const deviceRoot = powerShellString(script, "DeviceRoot");
            const diskDirectory = dirname(powerShellString(script, "DiskPath"));
            const deviceRootExisted = existsSync(deviceRoot);
            const diskDirectoryExisted = existsSync(diskDirectory);
            mkdirSync(diskDirectory, { recursive: true });
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, deviceRoot, diskDirectory, deviceRootExisted, diskDirectoryExisted }), stderr: "" };
        }
        if (script.includes("$Vhd = Get-VHD -Path $VhdPath") && script.includes("virtualSizeBytes = [long]$Vhd.Size")) {
            const path = powerShellString(script, "VhdPath");
            const base = script.includes("kind = 'base'");
            const manifestPath = join(dirname(path), "manifest.json");
            const manifest = base && existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as { virtualSizeBytes?: number } : null;
            const expectedSize = script.match(/\[long\]\$Vhd.Size -ne \[long\](\d+)/)?.[1];
            const virtualSizeBytes = manifest?.virtualSizeBytes ?? Number(expectedSize || 32 * 1024 * 1024 * 1024);
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, kind: base ? "base" : "clone", virtualSizeBytes }), stderr: "" };
        }
        return networkRunner!(command, runnerOptions);
    });
    return createRawDeviceBrokerServer({
        ...options,
        ...(preludeRunner ? { commandRunner: preludeRunner } : {}),
    });
}

function providerScript(command: { args?: string[]; input?: string }): string {
    if (command.args?.at(-1) === "-" && typeof command.input === "string") return command.input;
    const fileIndex = command.args?.indexOf("-File") ?? -1;
    if (fileIndex >= 0) {
        const file = command.args?.[fileIndex + 1];
        return file ? readFileSync(file, "utf8") : "";
    }
    const encodedCommand = Buffer.from(command.args?.at(-1) || "", "base64").toString("utf16le");
    if (
        typeof command.input === "string"
        && encodedCommand.includes("$E=[Console]::In.ReadToEnd().Trim()")
        && encodedCommand.includes("[Convert]::FromBase64String($E)")
        && encodedCommand.includes("[ScriptBlock]::Create")
    ) {
        return Buffer.from(command.input.trim(), "base64").toString("utf8");
    }
    return encodedCommand;
}

function hyperVWindowsOperationRequest(command: { args?: string[]; input?: string }): HyperVWindowsExecutionRequest | null {
    if (command.args?.at(-1) !== HYPER_V_WINDOWS_POWERSHELL_MEMORY_BOOTSTRAP || typeof command.input !== "string") return null;
    const envelope = JSON.parse(Buffer.from(command.input, "base64").toString("utf8")) as { script?: unknown; input?: unknown };
    expect(envelope.script).toEqual(expect.stringContaining("$global:CccHyperVJsonInput"));
    expect(typeof envelope.input).toBe("string");
    return JSON.parse(String(envelope.input)) as HyperVWindowsExecutionRequest;
}

function hyperVWindowsOperationSuccess(operation: HyperVWindowsExecutionRequest["operation"], items: readonly unknown[] = []) {
    return {
        status: 0,
        stdout: JSON.stringify({ schemaVersion: 1, operation, ok: true, items }),
        stderr: "",
    };
}

function automaticUbuntuVhdOperation(command: { args?: string[]; input?: string }) {
    const request = hyperVWindowsOperationRequest(command);
    if (!request) return null;
    const automaticRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
    const sourcePath = join(automaticRoot, ".acquire-work", "converted.normalized.fixed.vhd");
    const partialPath = join(automaticRoot, "base.partial.vhdx");
    const imagePath = join(automaticRoot, "base.vhdx");
    if (request.operation === "Convert-VHD" && request.sourcePath === sourcePath && request.destinationPath === partialPath) {
        writeFileSync(partialPath, readFileSync(sourcePath));
        return hyperVWindowsOperationSuccess(request.operation);
    }
    if (request.operation === "Resize-VHD" && request.path === partialPath) {
        return hyperVWindowsOperationSuccess(request.operation);
    }
    const ownersRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners");
    const ownerId = typeof request.path === "string" && request.path.startsWith(`${ownersRoot}${sep}`)
        ? request.path.slice(ownersRoot.length + 1).split(sep)[0] : null;
    const ownerImageManifest = ownerId && join(ownersRoot, ownerId, "images", "hyper-v", "ubuntu-lts", "manifest.json");
    const automaticLinuxClone = request.operation === "Get-VHD"
        && typeof request.path === "string"
        && request.path.includes(`${join("linux-vm", "")}`)
        && request.path.endsWith(join("disks", "root.vhdx"))
        && (!ownerImageManifest || !existsSync(ownerImageManifest));
    if (request.operation === "Get-VHD" && (request.path === sourcePath || request.path === partialPath || request.path === imagePath || automaticLinuxClone)) {
        const path = request.path;
        if (!existsSync(path)) return null;
        return hyperVWindowsOperationSuccess(request.operation, [{
            path, vhdFormat: path === sourcePath ? "VHD" : "VHDX",
            vhdType: path === sourcePath ? "Fixed" : "Dynamic", parentPath: null,
            virtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
            fileSizeBytes: readFileSync(path).length,
        }]);
    }
    return null;
}

function automaticUbuntuPrepareOutput(profileRoot: string, imageContents: Buffer | string): string {
    const imagePath = join(profileRoot, "base.vhdx");
    const partialPath = join(profileRoot, "base.partial.vhdx");
    const sourceVhdPath = join(profileRoot, ".acquire-work", "converted.normalized.fixed.vhd");
    mkdirSync(dirname(sourceVhdPath), { recursive: true });
    writeFileSync(sourceVhdPath, imageContents);
    const observation = {
        ok: true, profile: "ubuntu-lts", imagePath, partialPath, sourceVhdPath,
        sourceVhdSha256: createHash("sha256").update(imageContents).digest("hex"),
        sourceVirtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
        qemuSha256: "a".repeat(64),
    };
    return `CCC_HYPER_V_RESULT_B64:${Buffer.from(JSON.stringify(observation)).toString("base64")}`;
}

function automaticUbuntuFinalizeOutput(profileRoot: string, overrides: Record<string, unknown> = {}): string {
    const imagePath = join(profileRoot, "base.vhdx");
    const partialPath = join(profileRoot, "base.partial.vhdx");
    const imageContents = readFileSync(partialPath);
    writeFileSync(imagePath, imageContents);
    const observation = {
        ok: true, profile: "ubuntu-lts", imagePath,
        sha256: createHash("sha256").update(imageContents).digest("hex"),
        sizeBytes: imageContents.length,
        virtualSizeBytes: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes,
        vhdType: "Dynamic", generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, reused: false,
        ...overrides,
    };
    return `CCC_HYPER_V_RESULT_B64:${Buffer.from(JSON.stringify(observation)).toString("base64")}`;
}

function powerShellString(script: string, variable: string): string {
    return script.match(new RegExp(`\\$${variable} = '((?:''|[^'])*)'`))?.[1]?.replaceAll("''", "'") || "";
}

function ed25519PublicKeyBlob(seed: number): Buffer {
    const algorithm = Buffer.from("ssh-ed25519", "ascii");
    const key = Buffer.alloc(32, seed);
    const algorithmLength = Buffer.alloc(4);
    const keyLength = Buffer.alloc(4);
    algorithmLength.writeUInt32BE(algorithm.length);
    keyLength.writeUInt32BE(key.length);
    return Buffer.concat([algorithmLength, algorithm, keyLength, key]);
}

function hyperVNetworkObservation(command: { args?: string[]; input?: string }, overrides: Record<string, unknown> = {}) {
    const script = providerScript(command);
    return {
        ok: true,
        switchName: powerShellString(script, "SwitchName"),
        switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        natName: powerShellString(script, "NatName"),
        natInstanceId: "ccc-nat-instance-1",
        prefix: powerShellString(script, "Prefix"),
        gateway: powerShellString(script, "Gateway"),
        interfaceIndex: 42,
        createdSwitch: true,
        createdNat: true,
        ...overrides,
    };
}

function hyperVNetworkCleanupResult<T extends { args?: string[]; input?: string }>(command: T) {
    const script = providerScript(command);
    if (!script.includes("$RemoveNat =") || !script.includes("Remove-NetNat -InputObject")) return null;
    return {
        ...command,
        status: 0,
        stdout: JSON.stringify({
            ok: true,
            removedSwitch: true,
            removedNat: true,
            removedGateway: true,
            alreadyMissing: false,
        }),
        stderr: "",
    };
}

describe("device-lab Hyper-V broker", () => {
    it("compares bounded OpenSSH ed25519 fingerprints without retaining host data", () => {
        const expected = `SHA256:${"A".repeat(43)}`;
        expect(compareHyperVLinuxEd25519HostKeyFingerprint(expected, `debug1: Server host key: ssh-ed25519 ${expected}\n`))
            .toEqual({ observed: true, matchesExpected: true });
        expect(compareHyperVLinuxEd25519HostKeyFingerprint(expected, `The fingerprint for the ED25519 key sent by the remote host is\nSHA256:${"B".repeat(43)}.\n`))
            .toEqual({ observed: true, matchesExpected: false });
        expect(compareHyperVLinuxEd25519HostKeyFingerprint(expected, "Host key verification failed.\n"))
            .toEqual({ observed: false, matchesExpected: null });
        expect(compareHyperVLinuxEd25519HostKeyFingerprint("invalid", `debug1: Server host key: ssh-ed25519 ${expected}\n`))
            .toEqual({ observed: false, matchesExpected: null });
    });

    it("reserves containment time for Linux and Windows start and reboot deadlines", () => {
        const operationTimeoutMs = 17 * 60 * 1000;
        expect(hyperVLifecycleCleanupTimeoutMs("linux-vm", "device_start", operationTimeoutMs))
            .toBe(operationTimeoutMs + DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        expect(hyperVLifecycleCleanupTimeoutMs("linux-vm", "device_reboot", operationTimeoutMs))
            .toBe(operationTimeoutMs + DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        const cleanupDeadlineAt = 1_000_000;
        expect(hyperVProviderDeadlineAt("linux-vm", "device_start", cleanupDeadlineAt))
            .toBe(cleanupDeadlineAt - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        expect(hyperVProviderDeadlineAt("linux-vm", "device_reboot", cleanupDeadlineAt))
            .toBe(cleanupDeadlineAt - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        // windows-vm needs the same reserve now that it has containment of its own to run after
        // readiness. Without it, a boot timeout near the residual budget lets the deadline throw
        // and replace the readiness result with hyper-v-operation-deadline-exceeded — the
        // un-scrubbed reason containment switches on is gone before containment reads it, so a
        // guest with a live autologon is left running and nothing reports it.
        expect(hyperVLifecycleCleanupTimeoutMs("windows-vm", "device_start", operationTimeoutMs))
            .toBe(operationTimeoutMs + DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        expect(hyperVLifecycleCleanupTimeoutMs("windows-vm", "device_reboot", operationTimeoutMs))
            .toBe(operationTimeoutMs + DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        expect(hyperVProviderDeadlineAt("windows-vm", "device_start", cleanupDeadlineAt))
            .toBe(cleanupDeadlineAt - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        expect(hyperVProviderDeadlineAt("windows-vm", "device_reboot", cleanupDeadlineAt))
            .toBe(cleanupDeadlineAt - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS);
        // Backends without a containment path keep the undiminished budget.
        expect(hyperVProviderDeadlineAt("android-emulator", "device_start", cleanupDeadlineAt))
            .toBe(cleanupDeadlineAt);
    });

    it("classifies missing guest signals only after the independent five-minute threshold", () => {
        const startedAt = 10_000;
        const callerDeadline = startedAt + 1_000;
        expect(hyperVLinuxGuestSignalDeadlineAt(startedAt))
            .toBe(startedAt + DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS);
        expect(hyperVLinuxGuestSignalTimedOut(startedAt, callerDeadline, false)).toBe(false);
        expect(hyperVLinuxGuestSignalTimedOut(
            startedAt,
            startedAt + DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS - 1,
            false,
        )).toBe(false);
        expect(hyperVLinuxGuestSignalTimedOut(
            startedAt,
            startedAt + DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS,
            false,
        )).toBe(true);
        expect(hyperVLinuxGuestSignalTimedOut(
            startedAt,
            startedAt + DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS,
            true,
        )).toBe(false);
    });

    it("classifies Linux readiness traces without masking a shorter caller deadline", () => {
        const trace = {
            managedSshAttempts: 2,
            bootstrapProbeAttempts: 2,
            bootstrapProbeSuccesses: 2,
            bootstrapAddressCount: 0,
            bootstrapSshAttempts: 0,
            networkFinalizeAttempts: 0,
            networkFinalizeSucceeded: false,
            guestSignalObserved: false,
            elapsedMs: 1000,
        };
        expect(hyperVLinuxGuestReadyTraceFailureCode(trace, "ssh-unavailable"))
            .toBe("hyper-v-bootstrap-address-unavailable");
        expect(hyperVLinuxGuestReadyTraceFailureCode({
            ...trace,
            bootstrapProbeSuccesses: 0,
            elapsedMs: DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS - 1,
        }, "ssh-unavailable")).toBe("hyper-v-bootstrap-network-probe-failed");
        expect(hyperVLinuxGuestReadyTraceFailureCode({
            ...trace,
            bootstrapProbeSuccesses: 0,
            elapsedMs: DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS,
        }, "ssh-unavailable")).toBe("hyper-v-guest-boot-signal-timeout");
        expect(hyperVLinuxGuestReadyTraceFailureCode({
            ...trace,
            bootstrapAddressCount: 1,
            bootstrapSshAttempts: 2,
            bootstrapSshLastStatus: null,
            bootstrapSshLastError: "ssh-connection-timeout",
            guestSignalObserved: true,
        }, "ssh-connection-timeout")).toBe("ssh-connection-timeout");
        expect(hyperVLinuxGuestReadyTraceFailureCode({
            ...trace,
            bootstrapProbeLastError: "hyper-v-bootstrap-network-probe-failed",
            bootstrapAddressCount: 1,
            bootstrapSshAttempts: 2,
            bootstrapSshLastError: "ssh-host-key-rejected",
            guestSignalObserved: true,
        }, "ssh-unavailable")).toBe("ssh-host-key-rejected");
        expect(hyperVLinuxGuestReadyTraceFailureCode({
            ...trace,
            bootstrapAddressCount: 1,
            bootstrapSshAttempts: 1,
            networkFinalizeAttempts: 1,
            guestSignalObserved: true,
        }, "ssh-connection-timeout")).toBe("hyper-v-bootstrap-network-finalize-failed");
        expect(hyperVLinuxGuestReadyTraceFailureCode(trace, "hyper-v-operation-deadline-exceeded"))
            .toBe("hyper-v-operation-deadline-exceeded");
        expect(hyperVLinuxGuestReadyTraceFailureCode(trace, "hyper-v-bootstrap-network-containment-failed"))
            .toBe("hyper-v-bootstrap-network-containment-failed");
    });

    it.each([
        "hyper-v-bootstrap-address-selection-failed",
        "hyper-v-bootstrap-host-prefix-inspection-failed",
        "hyper-v-bootstrap-management-adapter-inspection-failed",
        "hyper-v-bootstrap-neighbor-inspection-failed",
        "hyper-v-bootstrap-network-adapter-ambiguous",
        "hyper-v-bootstrap-network-adapter-identity-mismatch",
        "hyper-v-bootstrap-network-command-failed",
        "hyper-v-bootstrap-network-probe-failed",
        "hyper-v-bootstrap-network-response-invalid",
        "hyper-v-bootstrap-vm-adapter-inspection-failed",
    ])("preserves bootstrap stage failure %s after the guest-signal deadline", (diagnosticCode) => {
        expect(hyperVLinuxGuestReadyTraceFailureCode({
            managedSshAttempts: 2,
            bootstrapProbeAttempts: 2,
            bootstrapProbeSuccesses: 0,
            bootstrapProbeLastStatus: 0,
            bootstrapProbeLastError: diagnosticCode,
            bootstrapAddressCount: 0,
            bootstrapSshAttempts: 0,
            networkFinalizeAttempts: 0,
            networkFinalizeSucceeded: false,
            guestSignalObserved: false,
            elapsedMs: DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS,
        }, "hyper-v-guest-boot-signal-timeout")).toBe(diagnosticCode);
    });
    let originalHomeRestore: (() => void) | undefined;
    let fixtureHome: string | undefined;

    beforeEach(() => {
        fixtureHome = mkdtempSync(join(tmpdir(), "ccc-hyper-v-linux-test-home-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(fixtureHome);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (fixtureHome) rmSync(fixtureHome, { recursive: true, force: true });
        originalHomeRestore?.();
    });

    it("routes a screenshot and screenshot pixels only to the exact owned Hyper-V VM", async () => {
        const cwd = join(process.env.HOME!, "console-project");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "console-vm";
        const incarnationId = "1".repeat(32);
        const vmId = "12345678-1234-1234-1234-123456789abc";
        const vmName = `ccc-${ownerId}-console-vm`;
        writeBrokerDevices(ownerId, "windows-vm", [{ id: deviceId, ownerId, backend: "windows-vm", incarnationId, vmId, vmName, diskPath: join(process.env.HOME!, "disk.vhdx") }]);
        const chunk = (type: string, body: Buffer) => {
            const bytes = Buffer.alloc(12 + body.length);
            bytes.writeUInt32BE(body.length, 0);
            bytes.write(type, 4, "ascii");
            body.copy(bytes, 8);
            return bytes;
        };
        const header = Buffer.alloc(13);
        header.writeUInt32BE(640, 0);
        header.writeUInt32BE(480, 4);
        header[8] = 8;
        const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.alloc(480 * 641))), chunk("IEND", Buffer.alloc(0))]);
        const requests: HyperVWindowsExecutionRequest[] = [];
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const request = hyperVWindowsOperationRequest(command);
            if (!request) throw new Error("unexpected provider command");
            requests.push(request);
            if (request.operation === "Capture-VMConsole") return hyperVWindowsOperationSuccess(request.operation, [{ pngBase64: png.toString("base64"), width: 640, height: 480, nativeWidth: 1280, nativeHeight: 960 }]);
            if (request.operation === "Send-VMConsoleInput") return hyperVWindowsOperationSuccess(request.operation);
            throw new Error("unexpected native operation");
        });
        const server = createRawDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const invoke = async (tool: string, params: Record<string, unknown> = {}) => {
                const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                    method: "POST", headers: ownerRpcHeaders(ownerId),
                    body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool, backend: "windows-vm", deviceId, ...params } }),
                });
                return { status: response.status, body: await response.json() as any };
            };
            expect(await invoke("device_click", { incarnationId, x: 20, y: 20 })).toMatchObject({ status: 409, body: { error: "hyper-v-console-screenshot-required" } });
            const screenshot = await invoke("device_screenshot");
            expect(screenshot).toMatchObject({ status: 200, body: { result: { width: 640, height: 480, incarnationId } } });
            expect(screenshot.body.result.mcpResult.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
            expect(await invoke("device_click", { incarnationId: "2".repeat(32), x: 20, y: 20 })).toMatchObject({ status: 409, body: { error: "hyper-v-incarnation-conflict" } });
            expect(await invoke("device_click", { incarnationId, x: 640, y: 20 })).toMatchObject({ status: 400, body: { error: "hyper-v-console-pixel-invalid" } });
            for (const direction of ["left", "right"]) {
                expect(await invoke("device_scroll", { incarnationId, x: 20, y: 30, direction })).toMatchObject({ status: 400, body: { error: "hyper-v-console-scroll-unsupported" } });
            }
            expect(await invoke("device_scroll", { incarnationId, x: 20, y: 30, direction: "up", amount: 11 })).toMatchObject({ status: 400, body: { error: "hyper-v-console-scroll-amount-invalid" } });
            expect(await invoke("device_click", { incarnationId, x: 20, y: 30 })).toMatchObject({ status: 200, body: { result: { applied: true } } });
            expect(requests.map((request) => request.operation)).toEqual(["Capture-VMConsole", "Send-VMConsoleInput"]);
            expect(requests[1]).toMatchObject({ selector: { kind: "id", id: vmId }, expectedName: vmName,
                expectedNotes: `ccc-device-lab:${ownerId}:${deviceId}:${incarnationId}`, x: 20, y: 30,
                width: 640, height: 480, nativeWidth: 1280, nativeHeight: 960, action: "click", button: "left" });
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("publishes backend-owned Secure Boot policies despite request overrides", async () => {
        const cwd = join(process.env.HOME!, "project-secure-boot-plan");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner: vi.fn(),
        });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: {
                        backend: "linux-vm",
                        command: "device_create",
                        deviceId: "secure-boot-plan",
                        incarnationId: "0123456789abcdef0123456789abcdef",
                        name: "Secure Boot plan",
                        profile: "ubuntu-lts",
                        sourceImage: "C:\\images\\ubuntu.vhdx",
                        secureBootTemplate: "MicrosoftWindows",
                    },
                }),
            });
            expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
            expect(await response.json()).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    create: expect.objectContaining({
                        secureBootEnabled: false,
                        secureBootTemplate: "MicrosoftUEFICertificateAuthority",
                    }),
                    device: expect.objectContaining({ secureBootEnabled: false }),
                }),
            }));

            const windowsResponse = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.plan",
                    params: {
                        backend: "windows-vm",
                        command: "device_create",
                        deviceId: "secure-boot-windows-plan",
                        incarnationId: "fedcba9876543210fedcba9876543210",
                        name: "Windows Secure Boot plan",
                        profile: "windows-11",
                        sourceImage: "C:\\images\\windows.vhdx",
                        secureBootTemplate: "MicrosoftUEFICertificateAuthority",
                    },
                }),
            });
            expect(windowsResponse.status, JSON.stringify(await windowsResponse.clone().json())).toBe(200);
            expect(await windowsResponse.json()).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    create: expect.objectContaining({
                        secureBootEnabled: true,
                        secureBootTemplate: "MicrosoftWindows",
                    }),
                    device: expect.objectContaining({ secureBootEnabled: true }),
                }),
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects a duplicate Hyper-V create that names a different source image", async () => {
        const cwd = join(process.env.HOME!, "project-source-conflict");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        writeBrokerDevices(ownerId, "linux-vm", [{
            id: "source-conflict",
            name: "Source conflict",
            backend: "linux-vm",
            ownerId,
            profile: "ubuntu-lts",
            sourceImage: "first.vhdx",
            memoryMb: 4096,
            cpus: 2,
            networking: true,
            secureBootTemplate: "MicrosoftUEFICertificateAuthority",
            secureBootEnabled: false,
        }]);
        const commandRunner = vi.fn();
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", commandRunner });
        try {
            const baseUrl = await listen(server);
            const invoke = (sourceImage: string) => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.plan", params: { backend: "linux-vm", command: "device_create", deviceId: "source-conflict", name: "Source conflict", profile: "ubuntu-lts", sourceImage } }),
            });
            const repeated = await invoke("first.vhdx");
            expect(repeated.status, JSON.stringify(await repeated.clone().json())).toBe(200);
            const repeatedBody = await repeated.json();
            expect(repeatedBody).toEqual(expect.objectContaining({ result: expect.objectContaining({ idempotent: true }) }));
            expect(JSON.stringify(repeatedBody)).not.toContain("first.vhdx");
            const conflicting = await invoke("second.vhdx");
            expect(conflicting.status, JSON.stringify(await conflicting.clone().json())).toBe(409);
            expect(await conflicting.json()).toEqual(expect.objectContaining({
                error: "hyper-v-create-configuration-conflict",
                conflicts: expect.arrayContaining(["sourceImage"]),
            }));
            expect(commandRunner).not.toHaveBeenCalled();
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("reconciles a token-scoped network intent after an indeterminate provider failure", async () => {
        const cwd = join(process.env.HOME!, "project-network-intent-retry");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const networkScripts: string[] = [];
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const script = providerScript(command);
            if (script.includes("Get-Service -Name vmms")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 8, missing: [] }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                networkScripts.push(script);
                if (networkScripts.length === 1) return {
                    ...command,
                    status: 1,
                    stdout: "sensitive-network-output",
                    stderr: "hyper-v-network-pipe-handshake-timeout sensitive-network-error",
                    error: "provider command failed",
                    timedOut: true,
                    input: "sensitive-network-input",
                };
                expect(script).toContain("$AllowExistingNat = $false");
                expect(script).toContain("$AllowExistingNat -or $ExistingSwitchOwned");
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command, { createdSwitch: false, createdNat: false })), stderr: "" };
            }
            const cleanup = hyperVNetworkCleanupResult(command);
            if (cleanup) return cleanup;
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
            }
            if (script.includes("$CreatedVm = New-VM @VmArgs")) {
                expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v-intent.json"))).toBe(false);
                expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json"))).toBe(true);
            }
            return { ...command, status: 1, stdout: "", stderr: "stop after network setup" };
        });
        let typedNetworkMutationAttempts = 0;
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            beforeOperation(request) {
                if (request.operation === "New-VM") return { status: 1, stdout: "", stderr: "stop after network setup" };
                if (request.operation !== "New-VMSwitch" || typedNetworkMutationAttempts++ > 0) return null;
                return {
                    status: null,
                    stdout: "",
                    stderr: "",
                    error: "hyper-v-network-elevation-handshake-timeout",
                };
            },
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const invoke = () => fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId: "network-intent-retry", name: "Network intent retry", profile: "ubuntu-lts" } }),
            });
            const first = await invoke();
            expect(first.status, JSON.stringify(await first.clone().json())).toBe(502);
            const firstBody = await first.json();
            expect(firstBody).toEqual(expect.objectContaining({
                error: "hyper-v-network-setup-failed",
                detail: "hyper-v-network-elevation-handshake-timeout",
                execution: expect.objectContaining({
                    provider: "hyper-v",
                    status: null,
                    stdoutPresent: false,
                    stderrPresent: false,
                    outputRedacted: true,
                    diagnosticCode: "hyper-v-network-elevation-handshake-timeout",
                }),
            }));
            expect(firstBody.execution).not.toHaveProperty("command");
            expect(firstBody.execution).not.toHaveProperty("args");
            expect(firstBody.execution).not.toHaveProperty("input");
            expect(firstBody.execution).not.toHaveProperty("stdout");
            expect(firstBody.execution).not.toHaveProperty("stderr");
            expect(JSON.stringify(firstBody)).not.toContain("sensitive-network");
            const intentPath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v-intent.json");
            const intent = JSON.parse(readFileSync(intentPath, "utf8"));
            expect(intent).toEqual(expect.objectContaining({
                natName: expect.stringMatching(/^CCCDeviceLab-[a-f0-9]{24}$/),
                marker: expect.stringMatching(/^ccc-device-lab:hyper-v-network:[a-f0-9]{24}$/),
                token: expect.stringMatching(/^[a-f0-9]{24}$/),
            }));
            expect(intent.natName).toBe(`CCCDeviceLab-${intent.token}`);
            expect(intent.marker).toBe(`ccc-device-lab:hyper-v-network:${intent.token}`);
            const second = await invoke();
            expect(second.status).toBe(502);
            const secondBody = await second.json();
            expect(secondBody).toEqual(expect.objectContaining({
                error: "provider-command-failed",
                detail: "hyper-v-windows-protocol-response-malformed",
                operation: "New-VM",
            }));
            expect(JSON.stringify(secondBody)).not.toContain("stop after network setup");
            expect(secondBody.result.execution).not.toHaveProperty("command");
            expect(JSON.stringify(secondBody)).not.toContain('"privateRoot"');
            expect(JSON.stringify(secondBody)).not.toContain("-EncodedCommand");
            expect(networkScripts).toEqual([]);
            expect(typedNetworkMutationAttempts).toBe(2);
            expect(existsSync(intentPath)).toBe(false);
            // The failed create's rollback releases its allocation but keeps the shared fabric.
            expect(JSON.parse(readFileSync(join(
                process.env.HOME!,
                ".ccc",
                "device-broker-private",
                "network",
                "hyper-v.json",
            ), "utf8"))).toMatchObject({
                managedSwitch: true,
                managedGateway: true,
                managedNat: true,
                allocations: [],
            });
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects a Linux VM without networking before allocating host resources", async () => {
        const cwd = join(process.env.HOME!, "project-linux-network-disabled");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const commandRunner = vi.fn();
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId: "offline-linux", name: "Offline Linux", profile: "ubuntu-lts", networking: false } }),
            });
            expect(response.status).toBe(400);
            expect(await response.json()).toEqual(expect.objectContaining({ ok: false, error: "linux-vm-networking-required" }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "network"))).toBe(false);
            expect(existsSync(backendRoot(ownerId, "linux-vm"))).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("keeps committed network state when intent unlink fails", async () => {
        const cwd = join(process.env.HOME!, "project-network-intent-unlink");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const intentPath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v-intent.json");
        const statePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
        let createReached = false;
        let cleanupCalls = 0;
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const script = providerScript(command);
            if (script.includes("Get-Service -Name vmms")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 8, missing: [] }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                rmSync(intentPath, { force: true });
                mkdirSync(intentPath);
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            const cleanup = hyperVNetworkCleanupResult(command);
            if (cleanup) {
                cleanupCalls += 1;
                return cleanup;
            }
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
            }
            if (script.includes("$CreatedVm = New-VM @VmArgs")) {
                createReached = true;
                expect(existsSync(statePath)).toBe(true);
                expect(cleanupCalls).toBe(0);
            }
            return { ...command, status: 1, stdout: "", stderr: "stop after committed network" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            beforeOperation(request) {
                if (request.operation !== "New-VM") return null;
                createReached = true;
                expect(existsSync(statePath)).toBe(true);
                expect(cleanupCalls).toBe(0);
                return { status: 1, stdout: "", stderr: "stop after committed network" };
            },
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId: "network-intent-unlink", name: "Network intent unlink", profile: "ubuntu-lts" } }),
            });
            expect(response.status).toBeGreaterThanOrEqual(400);
            const body = await response.json();
            expect(createReached, JSON.stringify(body)).toBe(true);
            // The injected typed simulator owns host-fabric cleanup; the legacy composite
            // command runner must not receive a cleanup program.
            expect(cleanupCalls).toBe(0);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("reuses committed network state when a stale intent is unreadable", async () => {
        const cwd = join(process.env.HOME!, "project-network-stale-intent");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const networkRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "network");
        const intentPath = join(networkRoot, "hyper-v-intent.json");
        const token = "a".repeat(24);
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(join(networkRoot, "hyper-v.json"), JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            marker: `ccc-device-lab:hyper-v-network:${token}`,
            natName: `CCCDeviceLab-${token}`,
            natInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            outboundPolicy: "nat",
            managedNat: false,
            allocations: [],
        }));
        mkdirSync(intentPath);
        let networkReached = false;
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const script = providerScript(command);
            if (script.includes("Get-Service -Name vmms")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 8, missing: [] }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                networkReached = true;
                expect(existsSync(intentPath)).toBe(false);
                expect(script).toContain("$AllowExistingNat = $true");
                expect(script).toContain("$ExpectedSwitchId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'");
                expect(script).toContain("$ExpectedNatInstanceId = 'ccc-nat-instance-1'");
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command, { createdSwitch: false, createdNat: false })), stderr: "" };
            }
            const cleanup = hyperVNetworkCleanupResult(command);
            if (cleanup) return cleanup;
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "stop after stale intent recovery" };
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId: "stale-intent", name: "Stale intent", profile: "ubuntu-lts" } }),
            });
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(networkReached).toBe(false);
            expect(existsSync(intentPath)).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("requires evaluation-license acceptance when reusing a cached Windows Server image", async () => {
        const cwd = join(process.env.HOME!, "project");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const imageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "windows-server");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        const manifestPath = join(imageProfileRoot, "manifest.json");
        const imageContents = "cached-windows-server-vhdx";
        const catalog = HYPER_V_IMAGE_CATALOG["windows-server"];
        mkdirSync(imageProfileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(manifestPath, JSON.stringify({
            version: 3,
            profile: "windows-server",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: null,
            licenseId: catalog.licenseId,
            generation: HYPER_V_IMAGE_CATALOG["windows-server"].generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const commandRunner = vi.fn((command: { mode: string; provider: string; executable?: string; args?: string[] }) => ({
            ...command,
            status: 0,
            stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }),
            stderr: "",
        }));
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: {
                    backend: "windows-vm",
                    command: "device_create",
                    deviceId: "windows-server-e2e",
                    name: "Windows Server E2E",
                    memoryMb: 4096,
                    cpus: 2,
                },
            }),
        });
        try {
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(409);
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-windows-evaluation-license-not-accepted",
            }));
            expect(existsSync(imagePath)).toBe(true);
            expect(existsSync(manifestPath)).toBe(true);
            expect(commandRunner).not.toHaveBeenCalled();
            expect(commandRunner.mock.calls.some(([command]) => {
                const script = providerScript(command);
                return script.includes("function Save-BoundedDownload") || script.includes("New-VM -Name");
            })).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("reserves cleanup time when the create deadline expires after VM creation", async () => {
        const cwd = join(process.env.HOME!, "project-deadline");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const imageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(imageProfileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(imageProfileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        let now = 1_000_000;
        let recoveryCalls = 0;
        let typedVmCreateReached = false;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const commandRunner = vi.fn((command: { mode: string; provider: string; args?: string[]; input?: string }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                recoveryCalls += 1;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: recoveryCalls > 1, removedDisk: recoveryCalls > 1 }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                return {
                    ...command,
                    status: 0,
                    stdout: JSON.stringify(hyperVNetworkObservation(command)),
                    stderr: "",
                };
            }
            if (script.includes("$CreatedVm = New-VM")) {
                const vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                const diskPath = script.match(/\$DiskPath = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                mkdirSync(dirname(diskPath), { recursive: true });
                writeFileSync(diskPath, "partial-root-vhdx");
                now += DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS + 1;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", vmName, generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, diskPath, switchName: "CCC Device Lab" }), stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            onOperation(request) {
                if (request.operation === "New-VM") {
                    typedVmCreateReached = true;
                    now += DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS + 1;
                }
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "linux-vm", command: "device_create", deviceId: "deadline-e2e", name: "Deadline E2E", profile: "ubuntu-lts", memoryMb: 2048, cpus: 2 },
                }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(504);
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-operation-deadline-exceeded", rollback: expect.objectContaining({ ok: true }) }));
            expect(typedVmCreateReached).toBe(true);
            expect(recoveryCalls).toBe(0);
            expect(existsSync(join(process.env.HOME!, ".ccc", "devices", "owners", ownerId, "linux-vm", "deadline-e2e"))).toBe(false);
            const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
            expect(JSON.parse(readFileSync(networkStatePath, "utf8"))).toMatchObject({
                managedSwitch: true,
                managedGateway: true,
                managedNat: true,
                allocations: [],
            });
        } finally {
            nowSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rolls back create state when the deadline expires immediately before provider invocation", async () => {
        const cwd = join(process.env.HOME!, "project-pre-provider-deadline");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const imageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        const catalog = HYPER_V_IMAGE_CATALOG["ubuntu-lts"];
        mkdirSync(imageProfileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(imageProfileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: catalog.catalogId,
            sourceUrl: catalog.sourceUrl,
            sourceFormat: catalog.sourceFormat,
            sourceSha256: catalog.sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: catalog.secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        let now = 1_500_000;
        let deadlineChecksBeforeExpiry = Number.POSITIVE_INFINITY;
        let recoveryCalls = 0;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
            if (Number.isFinite(deadlineChecksBeforeExpiry)) {
                if (deadlineChecksBeforeExpiry <= 0) return now + DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS + 1;
                deadlineChecksBeforeExpiry -= 1;
            }
            return now;
        });
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const nativeRequest = hyperVWindowsOperationRequest(command);
            if (nativeRequest?.operation === "Get-VM") {
                return { ...command, ...hyperVWindowsOperationSuccess("Get-VM", []) };
            }
            const script = providerScript(command);
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                recoveryCalls += 1;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: recoveryCalls > 1, removedDisk: recoveryCalls > 1 }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                deadlineChecksBeforeExpiry = 1;
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            if (script.includes("$CreatedVm = New-VM")) throw new Error("provider must not run after the operation deadline");
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        let typedNatCreated = false;
        configureTypedHyperVNetworkOperations(commandRunner, {
            onOperation(request) {
                if (request.operation === "New-NetNat") {
                    typedNatCreated = true;
                } else if (typedNatCreated && request.operation === "Get-NetNat") {
                    typedNatCreated = false;
                    deadlineChecksBeforeExpiry = 1;
                }
            },
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId: "pre-provider-deadline", name: "Pre-provider deadline", profile: "ubuntu-lts", memoryMb: 2048, cpus: 2 } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(504);
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-operation-deadline-exceeded",
                rollback: expect.objectContaining({ ok: true, releasedAddress: true }),
            }));
            expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("$CreatedVm = New-VM"))).toBe(false);
            expect(recoveryCalls).toBe(0);
            const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
            expect(JSON.parse(readFileSync(networkStatePath, "utf8"))).toMatchObject({
                managedSwitch: true,
                managedGateway: true,
                managedNat: true,
                allocations: [],
            });
        } finally {
            nowSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each([
        ["linux-vm", "ubuntu-lts", "$SeedDisk ="],
        ["windows-vm", "windows-11", "Write-CccIso $IsoFiles $ProvisioningMedia 'CCC_UNATTEND'"],
    ] as const)("rolls back %s when provisioning exceeds the operation deadline", async (backend, profile, provisioningMarker) => {
        const cwd = join(process.env.HOME!, `project-${backend}-provision-deadline`);
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = profile === "windows-11"
            ? join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", profile)
            : join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", profile);
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = `${profile}-cached-vhdx`;
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile,
            catalogId: profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG["ubuntu-lts"].catalogId : "user-provided-vhdx",
            sourceUrl: profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceUrl : null,
            sourceFormat: profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceFormat : "vhdx",
            sourceSha256: profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceSha256 : null,
            licenseId: null,
            generation: profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation : 2,
            secureBootTemplate: profile === "ubuntu-lts" ? "MicrosoftUEFICertificateAuthority" : "MicrosoftWindows",
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG["ubuntu-lts"].virtualSizeBytes : 64 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        let now = 3_000_000;
        let recoveryCalls = 0;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                recoveryCalls += 1;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: recoveryCalls > 1, removedDisk: recoveryCalls > 1 }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            if (script.includes("$CreatedVm = New-VM")) {
                const vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                const diskPath = script.match(/\$DiskPath = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                mkdirSync(dirname(diskPath), { recursive: true });
                writeFileSync(diskPath, "partial-root-vhdx");
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", vmName, generation: profile === "ubuntu-lts" ? HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation : 2, diskPath, switchName: "CCC Device Lab" }), stderr: "" };
            }
            if (script.includes(provisioningMarker)) {
                now += DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS + 1;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            beforeOperation(request) {
                if (request.operation === "Get-VMDvdDrive") {
                    return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items: [] }) };
                }
                return null;
            },
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe", ssh: "/fake/ssh", scp: "/fake/scp" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const deviceId = `${backend}-provision-deadline`;
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend, command: "device_create", deviceId, name: "Provision Deadline", profile, memoryMb: 2048, cpus: 2 } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(504);
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-operation-deadline-exceeded", rollback: expect.objectContaining({ ok: true }) }));
            expect(recoveryCalls).toBe(0);
            expect(existsSync(join(process.env.HOME!, ".ccc", "devices", "owners", ownerId, backend, deviceId))).toBe(false);
        } finally {
            nowSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves unknown automatic image artifacts when acquisition exceeds the operation deadline", async () => {
        const cwd = join(process.env.HOME!, "project-acquire-deadline");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        let now = 2_000_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
            }
            if (script.includes("function Save-BoundedDownload")) {
                mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
                writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial");
                now += DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS + 1;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, profile: "ubuntu-lts", imagePath: join(profileRoot, "base.vhdx"), sha256: "a".repeat(64), sizeBytes: 16, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, reused: false }), stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId: "acquire-deadline", name: "Acquire Deadline", profile: "ubuntu-lts", memoryMb: 2048, cpus: 2 } }),
            });
            expect(response.status, JSON.stringify(await response.clone().json())).toBe(504);
            expect(await response.json()).toEqual(expect.objectContaining({ error: "hyper-v-operation-deadline-exceeded" }));
            expect(existsSync(join(profileRoot, "base.partial.vhdx"))).toBe(false);
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
            expect(readdirSync(profileRoot).filter((name) => name.includes("-uncertain-"))).toHaveLength(2);
            expect(existsSync(join(profileRoot, "base.vhdx"))).toBe(false);
        } finally {
            nowSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("returns only a bounded automatic image acquisition stage", async () => {
        const cwd = join(process.env.HOME!, "project-acquire-redaction");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const hostSecret = "automatic-image-host-secret";
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("function Save-BoundedDownload")) {
                mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
                writeFileSync(join(profileRoot, "base.partial.vhdx"), "partial");
                return {
                    ...command,
                    executable: `C:\\host-secret\\${hostSecret}\\powershell.exe`,
                    args: ["-EncodedCommand", hostSecret],
                    status: 1,
                    stdout: "CCC_HYPER_V_STAGE:hyper-v-base-image-download-failed",
                    stderr: `hyper-v-powershell-execution-failed at C:\\host-secret\\${hostSecret}`,
                    error: `spawn failed at C:\\host-secret\\${hostSecret}`,
                };
            }
            return {
                ...command,
                status: 0,
                stdout: JSON.stringify({
                    ok: true,
                    recoveredVm: false,
                    removedDisk: false,
                }),
                stderr: "",
            };
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: {
                        backend: "linux-vm",
                        command: "device_create",
                        deviceId: "acquire-redaction",
                        name: "Acquire Redaction",
                        profile: "ubuntu-lts",
                        memoryMb: 2048,
                        cpus: 2,
                    },
                }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(422);
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-base-image-prepare-failed",
                detail: "hyper-v-base-image-acquire-failed:hyper-v-base-image-download-failed",
            }));
            expect(JSON.stringify(body)).not.toContain(hostSecret);
            expect(JSON.stringify(body)).not.toContain("EncodedCommand");
            expect(existsSync(join(profileRoot, "base.partial.vhdx"))).toBe(false);
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
            expect(readdirSync(profileRoot).filter((name) => name.includes("-uncertain-"))).toHaveLength(2);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("withholds the manifest and retains an uncertain image when the deadline expires during Node-side hashing", async () => {
        const cwd = join(process.env.HOME!, "project-hash-deadline");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = Buffer.alloc(10 * 1024 * 1024, 1);
        const operationBudget = DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS - DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS;
        let now = 4_000_000;
        let hashing = false;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => {
            if (hashing) now += Math.ceil(operationBudget / 8);
            return now;
        });
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
            }
            if (script.includes("function Save-BoundedDownload")) {
                mkdirSync(profileRoot, { recursive: true });
                return { ...command, status: 0, stdout: automaticUbuntuPrepareOutput(profileRoot, imageContents), stderr: "" };
            }
            if (script.includes("$ExpectedPartialHash =")) {
                const stdout = automaticUbuntuFinalizeOutput(profileRoot);
                hashing = true;
                return { ...command, status: 0, stdout, stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId: "hash-deadline", name: "Hash Deadline", profile: "ubuntu-lts", memoryMb: 2048, cpus: 2 } }),
            });
            expect(response.status, JSON.stringify(await response.clone().json())).toBe(504);
            expect(await response.json()).toEqual(expect.objectContaining({ error: "hyper-v-operation-deadline-exceeded" }));
            expect(existsSync(imagePath)).toBe(true);
            expect(existsSync(join(profileRoot, "manifest.json"))).toBe(false);
        } finally {
            nowSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each([
        {
            name: "invalid provider observation",
            observation: () => JSON.stringify({ ok: true, profile: "wrong-profile" }),
            detail: "hyper-v-base-image-acquire-invalid-result",
        },
        {
            name: "reported size mismatch",
            observation: (imagePath: string, imageContents: string) => JSON.stringify({
                ok: true,
                profile: "ubuntu-lts",
                imagePath,
                sha256: createHash("sha256").update(imageContents).digest("hex"),
                sizeBytes: Buffer.byteLength(imageContents) + 1,
                virtualSizeBytes: 32 * 1024 * 1024 * 1024,
                vhdType: "Dynamic",
                generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                reused: false,
            }),
            detail: "hyper-v-base-image-size-mismatch",
        },
    ])("withholds an automatic image manifest after $name", async ({ observation, detail }) => {
        const cwd = join(process.env.HOME!, `project-${detail}`);
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = "uncommitted-image";
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("function Save-BoundedDownload")) {
                mkdirSync(join(profileRoot, ".acquire-work"), { recursive: true });
                return { ...command, status: 0, stdout: detail === "hyper-v-base-image-acquire-invalid-result"
                    ? observation(imagePath, imageContents)
                    : automaticUbuntuPrepareOutput(profileRoot, imageContents), stderr: "" };
            }
            if (script.includes("$ExpectedPartialHash =")) {
                const reported = JSON.parse(observation(imagePath, imageContents)) as Record<string, unknown>;
                return { ...command, status: 0, stdout: automaticUbuntuFinalizeOutput(profileRoot, reported), stderr: "" };
            }
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({
                    method: "broker.command.invoke",
                    params: { backend: "linux-vm", command: "device_create", deviceId: `cleanup-${detail}`, name: "Cleanup validation", profile: "ubuntu-lts", memoryMb: 2048, cpus: 2 },
                }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(422);
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-base-image-prepare-failed", detail }));
            expect(existsSync(imagePath)).toBe(detail !== "hyper-v-base-image-acquire-invalid-result");
            expect(existsSync(join(profileRoot, "manifest.json"))).toBe(false);
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
            if (detail === "hyper-v-base-image-acquire-invalid-result") {
                expect(readdirSync(profileRoot).some((name) => name.startsWith(".work-uncertain-"))).toBe(true);
            }
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects an automatically acquired image whose file hash changed before first use", async () => {
        const cwd = join(process.env.HOME!, "project");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const imageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        const imageContents = "acquired-image-bytes";
        const commandRunner = vi.fn((command: { args?: string[] }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("function Save-BoundedDownload")) {
                mkdirSync(imageProfileRoot, { recursive: true });
                return { ...command, status: 0, stdout: automaticUbuntuPrepareOutput(imageProfileRoot, imageContents), stderr: "" };
            }
            if (script.includes("$ExpectedPartialHash =")) {
                return { ...command, status: 0, stdout: automaticUbuntuFinalizeOutput(imageProfileRoot, { sha256: "a".repeat(64) }), stderr: "" };
            }
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: {
                    backend: "linux-vm",
                    command: "device_create",
                    deviceId: "linux-image-hash-e2e",
                    name: "Linux hash E2E",
                    profile: "ubuntu-lts",
                    memoryMb: 2048,
                    cpus: 2,
                },
            }),
        });
        try {
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(422);
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-base-image-prepare-failed",
                detail: "hyper-v-base-image-hash-mismatch",
            }));
            expect(existsSync(join(imageProfileRoot, "manifest.json"))).toBe(false);
            expect(existsSync(imagePath)).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects an imported image whose prepared bytes do not match the reported hash", async () => {
        const cwd = join(process.env.HOME!, "project");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const sourceImagePath = join(cwd, "ubuntu-source.vhdx");
        const imageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        writeFileSync(sourceImagePath, "source-image-bytes");
        const nestedSourceImagePath = join(cwd, "nested", "ubuntu-source.vhdx");
        mkdirSync(dirname(nestedSourceImagePath), { recursive: true });
        writeFileSync(nestedSourceImagePath, "nested-source-image-bytes");
        const commandRunner = vi.fn((command: { args?: string[] }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            beforeOperation(request) {
                if (request.operation === "Dismount-VHD" && request.path) {
                    // Change the staged bytes after their initial hash. The detached copy must
                    // still be checked before it can become an owner base image.
                    writeFileSync(request.path, "tampered-image-bytes");
                }
                return null;
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const nestedResponse = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: {
                    backend: "linux-vm",
                    command: "device_create",
                    deviceId: "linux-nested-import-e2e",
                    name: "Linux nested import E2E",
                    profile: "ubuntu-lts",
                    sourceImage: nestedSourceImagePath,
                    memoryMb: 2048,
                    cpus: 2,
                },
            }),
        });
        const nestedBody = await nestedResponse.json();
        expect(nestedResponse.status, JSON.stringify(nestedBody)).toBe(422);
        expect(nestedBody).toEqual(expect.objectContaining({
            error: "hyper-v-base-image-prepare-failed",
            detail: "hyper-v-base-image-source-must-be-project-root-file",
        }));
        expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("hyper-v-base-image-profile-conflict"))).toBe(false);
        const externalSourceImagePath = join(process.env.HOME!, "outside-source.vhdx");
        const hardlinkedSourceImagePath = join(cwd, "hardlinked-source.vhdx");
        writeFileSync(externalSourceImagePath, "outside-source-image-bytes");
        linkSync(externalSourceImagePath, hardlinkedSourceImagePath);
        const hardlinkResponse = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: {
                    backend: "linux-vm",
                    command: "device_create",
                    deviceId: "linux-hardlink-import-e2e",
                    name: "Linux hardlink import E2E",
                    profile: "ubuntu-lts",
                    sourceImage: hardlinkedSourceImagePath,
                    memoryMb: 2048,
                    cpus: 2,
                },
            }),
        });
        expect(hardlinkResponse.status).toBe(422);
        expect(await hardlinkResponse.json()).toEqual(expect.objectContaining({
            error: "hyper-v-base-image-prepare-failed",
            detail: "hyper-v-base-image-source-invalid",
        }));
        expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("hyper-v-base-image-profile-conflict"))).toBe(false);
        const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
            method: "POST",
            headers: ownerRpcHeaders(ownerId),
            body: JSON.stringify({
                method: "broker.command.invoke",
                params: {
                    backend: "linux-vm",
                    command: "device_create",
                    deviceId: "linux-import-hash-e2e",
                    name: "Linux import hash E2E",
                    profile: "ubuntu-lts",
                    sourceImage: sourceImagePath,
                    memoryMb: 2048,
                    cpus: 2,
                },
            }),
        });
        try {
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(422);
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-base-image-prepare-failed",
                detail: "hyper-v-base-image-hash-mismatch",
            }));
            expect(existsSync(join(imageProfileRoot, "manifest.json"))).toBe(false);
            expect(existsSync(imagePath)).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each(["command", "invalid-result"] as const)("recovers an owner-marked Linux VM when seed provisioning fails before the seed disk is attached (%s)", async (failureMode) => {
        const cwd = join(process.env.HOME!, "project");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "linux-seed-failure-e2e";
        const vmId = "12345678-1234-1234-1234-123456789abc";
        let vmName = "";
        const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "linux-vm", deviceId);
        const deviceRoot = join(privateRoot, "artifacts");
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        const imageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        const imageBytes = Buffer.from("valid-image");
        const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
        const seedSecretEcho = "linux-seed-secret-echo";
        const rollbackSecretEcho = "linux-rollback-secret-echo";
        let recoveryCalls = 0;
        let typedAttachCalls = 0;
        const commandRunner = vi.fn((command: { args?: string[] }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("New-VM @VmArgs")) vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                recoveryCalls += 1;
                return {
                    ...command,
                    executable: `C:\\host-secret\\${rollbackSecretEcho}\\powershell.exe`,
                    args: ["-EncodedCommand", rollbackSecretEcho],
                    status: 0,
                    stdout: JSON.stringify({ ok: true, recoveredVm: recoveryCalls > 1, removedDisk: recoveryCalls > 1 }),
                    stderr: "",
                };
            }
            if (script.includes("function Save-BoundedDownload")) {
                mkdirSync(imageProfileRoot, { recursive: true });
                return { ...command, status: 0, stdout: automaticUbuntuPrepareOutput(imageProfileRoot, imageBytes), stderr: "" };
            }
            if (script.includes("$ExpectedPartialHash =")) {
                return { ...command, status: 0, stdout: automaticUbuntuFinalizeOutput(imageProfileRoot), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            if (script.includes("Write-CccIso $IsoFiles $SeedDisk 'cidata'")) {
                if (failureMode === "invalid-result") {
                    return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId,
                        vmName: "foreign-vm", seedDiskPath: join(deviceRoot, "disks", "cidata.iso") }), stderr: "" };
                }
                return { ...command, status: 1, stdout: seedSecretEcho, stderr: `hyper-v-provisioning-media-copy-incomplete: ${seedSecretEcho}` };
            }
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId, vmName, generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, state: "Off", status: "Operating normally", diskPath, switchName: "CCC Device Lab" }), stderr: "" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            onOperation(request) {
                if (request.operation === "New-VM") vmName = request.name || "";
                if (request.operation === "Configure-VMGuestBoot") typedAttachCalls += 1;
            },
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId, name: "Linux seed failure", profile: "ubuntu-lts", memoryMb: 2048, cpus: 2 } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(502);
            expect(body).toEqual(expect.objectContaining({ error: failureMode === "command"
                ? "hyper-v-linux-seed-failed" : "hyper-v-linux-seed-invalid-result",
            rollback: expect.objectContaining({ ok: true }) }));
            expect(JSON.stringify(body)).not.toContain(seedSecretEcho);
            expect(JSON.stringify(body)).not.toContain(rollbackSecretEcho);
            if (failureMode === "command") {
                expect(body.provisioning).toEqual(expect.objectContaining({
                    stdoutPresent: true,
                    stderrPresent: true,
                    outputRedacted: true,
                    diagnosticCode: "hyper-v-provisioning-media-copy-incomplete",
                }));
            }
            expect(typedAttachCalls).toBe(0);
            expect(recoveryCalls).toBe(0);
            const recoveryScripts = commandRunner.mock.calls.map(([command]) => providerScript(command)).filter((script) => script.includes("hyper-v-orphan-vm-ownership-mismatch"));
            expect(recoveryScripts).toEqual([]);
            expect(existsSync(deviceRoot)).toBe(false);
            expect(existsSync(privateRoot)).toBe(false);
            const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
            const allocations = existsSync(networkStatePath) ? JSON.parse(readFileSync(networkStatePath, "utf8")).allocations : [];
            expect(allocations).not.toEqual(expect.arrayContaining([expect.objectContaining({ ownerId, deviceId })]));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves a failed VM allocation when provisioning rollback cannot verify VM removal", async () => {
        const cwd = join(process.env.HOME!, "project-rollback-allocation");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "linux-rollback-failure";
        const incarnationIdPattern = /^[a-f0-9]{32}$/;
        const vmId = "12345678-1234-1234-1234-123456789abc";
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].catalogId,
            sourceUrl: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceUrl,
            sourceFormat: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceFormat,
            sourceSha256: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const networkRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "network");
        const networkStatePath = join(networkRoot, "hyper-v.json");
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(networkStatePath, JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            marker: "ccc-device-lab:hyper-v-network:v1",
            natName: "CCCDeviceLab",
            natInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            outboundPolicy: "nat",
            managedNat: true,
            allocations: [{ ownerId, deviceId: "existing-vm", incarnationId: "1".repeat(32), address: "172.29.0.20", macAddress: "02:11:22:33:44:55", allocatedAt: new Date().toISOString() }],
        }));
        let vmName = "";
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const script = providerScript(command);
            if (script.includes("Get-Service -Name vmms")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 8, missing: [] }), stderr: "" };
            }
            if (script.includes("$Observations = @()")) {
                const observedIncarnationId = "1".repeat(32);
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, allocations: [{ ownerId, deviceId: "existing-vm", incarnationId: observedIncarnationId, vmName: `ccc-${ownerId}-existing-vm-${observedIncarnationId}`, present: true, vmId }] }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command, { createdSwitch: false, createdNat: false })), stderr: "" };
            }
            if (script.includes("New-VM @VmArgs")) {
                vmName = powerShellString(script, "VmName");
                const diskPath = powerShellString(script, "DiskPath");
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId, vmName, generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, state: "Off", status: "Operating normally", diskPath, switchName: "CCC Device Lab" }), stderr: "" };
            }
            if (script.includes("Write-CccIso $IsoFiles $SeedDisk 'cidata'")) return { ...command, status: 1, stdout: "", stderr: "seed failed" };
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) return { ...command, status: 0, stdout: "malformed recovery output", stderr: "" };
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: true,
            onOperation(request) { if (request.operation === "New-VM") vmName = request.name || ""; },
            beforeOperation(request) {
                if (request.operation === "Remove-VM") {
                    return {
                        status: 1,
                        stdout: JSON.stringify({ schemaVersion: 1, operation: "Remove-VM", ok: false, errorCode: "vm-identity-mismatch" }),
                        stderr: "",
                    };
                }
                return null;
            },
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId, name: "Rollback failure", profile: "ubuntu-lts" } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(502);
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-linux-seed-failed", rollback: expect.objectContaining({ ok: false, reason: "hyper-v-rollback-command-failed" }) }));
            expect(vmName).toContain(deviceId);
            const state = JSON.parse(readFileSync(networkStatePath, "utf8"));
            expect(state.allocations).toHaveLength(2);
            const failed = state.allocations.find((allocation: { deviceId: string }) => allocation.deviceId === deviceId);
            expect(failed).toEqual(expect.objectContaining({ ownerId, deviceId, incarnationId: expect.stringMatching(incarnationIdPattern) }));
            const incarnationPath = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "linux-vm", deviceId, "incarnation.json");
            expect(existsSync(incarnationPath)).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("refuses stale network-allocation cleanup without the matching VM incarnation", async () => {
        const cwd = join(process.env.HOME!, "project");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "stale-network-allocation";
        const staleIncarnationId = "1".repeat(32);
        const networkRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "network");
        const networkStatePath = join(networkRoot, "hyper-v.json");
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(networkStatePath, JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            natName: "CCCDeviceLab",
            natInstanceId: "ccc-nat-instance-1",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            outboundPolicy: "nat",
            managedNat: true,
            allocations: [{ ownerId, deviceId, incarnationId: staleIncarnationId, address: "172.29.0.20", macAddress: "02:11:22:33:44:55", allocatedAt: new Date().toISOString() }],
        }));
        const commandRunner = vi.fn();
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        const baseUrl = await listen(server);
        try {
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId, name: "Stale network allocation", profile: "ubuntu-lts" } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(502);
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-recovery-cleanup-failed", stage: "network-release", detail: expect.stringContaining("hyper-v-network-allocation-incarnation-conflict") }));
            expect(commandRunner).not.toHaveBeenCalled();
            expect(JSON.parse(readFileSync(networkStatePath, "utf8")).allocations).toEqual([
                expect.objectContaining({ ownerId, deviceId, incarnationId: staleIncarnationId }),
            ]);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("rejects a reused Hyper-V NAT whose observed instance identity changed while allocated", async () => {
        const cwd = join(process.env.HOME!, "project-nat-identity");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "nat-identity-conflict";
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].catalogId,
            sourceUrl: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceUrl,
            sourceFormat: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceFormat,
            sourceSha256: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const networkRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "network");
        const networkStatePath = join(networkRoot, "hyper-v.json");
        mkdirSync(networkRoot, { recursive: true });
        writeFileSync(networkStatePath, JSON.stringify({
            version: 1,
            switchName: "CCC Device Lab",
            switchId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            natName: "CCCDeviceLab",
            natInstanceId: "ccc-nat-instance-original",
            prefix: "172.29.0.0/24",
            gateway: "172.29.0.1",
            outboundPolicy: "nat",
            managedNat: true,
            allocations: [{
                ownerId,
                deviceId: "existing-network-user",
                incarnationId: "b".repeat(32),
                address: "172.29.0.10",
                macAddress: "02:11:22:33:44:55",
                allocatedAt: new Date().toISOString(),
            }],
        }));
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const script = providerScript(command);
            if (script.includes("Get-Service -Name vmms")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 8, missing: [] }), stderr: "" };
            }
            if (script.includes("$Observations = @()")) {
                const observedIncarnationId = "b".repeat(32);
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, allocations: [{ ownerId, deviceId: "existing-network-user", incarnationId: observedIncarnationId, vmName: `ccc-${ownerId}-existing-network-user-${observedIncarnationId}`, present: true, vmId: "12345678-1234-1234-1234-123456789abc" }] }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                expect(script).toContain("$ExpectedNatInstanceId = 'ccc-nat-instance-original'");
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command, { natInstanceId: "ccc-nat-instance-replaced", createdSwitch: false, createdNat: false })), stderr: "" };
            }
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            natInstanceIdOverride: "ccc-nat-instance-replaced",
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId, name: "NAT identity conflict", profile: "ubuntu-lts" } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(409);
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-network-allocation-failed", detail: "hyper-v-network-nat-identity-conflict" }));
            expect(JSON.parse(readFileSync(networkStatePath, "utf8"))).toEqual(expect.objectContaining({
                natInstanceId: "ccc-nat-instance-original",
                allocations: [expect.objectContaining({ deviceId: "existing-network-user" })],
            }));
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("preserves typed ownership receipts when the initial network state cannot be committed", async () => {
        const cwd = join(process.env.HOME!, "project-network-commit-failure");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "network-commit-failure";
        const profileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(profileRoot, "base.vhdx");
        const imageContents = "cached-ubuntu-vhdx";
        mkdirSync(profileRoot, { recursive: true });
        writeFileSync(imagePath, imageContents);
        writeFileSync(join(profileRoot, "manifest.json"), JSON.stringify({
            version: 3,
            profile: "ubuntu-lts",
            catalogId: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].catalogId,
            sourceUrl: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceUrl,
            sourceFormat: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceFormat,
            sourceSha256: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].sourceSha256,
            licenseId: null,
            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
            secureBootTemplate: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].secureBootTemplate,
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 32 * 1024 * 1024 * 1024,
            vhdType: "Dynamic",
            preparedAt: new Date().toISOString(),
        }));
        const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
        let cleanupCalls = 0;
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const script = providerScript(command);
            if (script.includes("Get-Service -Name vmms")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 8, missing: [] }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                mkdirSync(networkStatePath, { recursive: true });
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command, { natInstanceId: "ccc-nat-instance-new" })), stderr: "" };
            }
            if (script.includes("$RemoveNat =") && script.includes("Remove-NetNat -InputObject")) {
                cleanupCalls += 1;
                return { ...command, status: 1, stdout: "", stderr: "simulated compensation failure" };
            }
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: false, removedDisk: false }), stderr: "" };
            }
            return { ...command, status: 1, stdout: "", stderr: "unexpected provider command" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            onOperation(request) {
                if (request.operation === "New-NetNat") mkdirSync(networkStatePath, { recursive: true });
            },
        });
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId, name: "Network commit failure", profile: "ubuntu-lts" } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(409);
            expect(body).toEqual(expect.objectContaining({
                error: "hyper-v-network-allocation-failed",
            }));
            expect(JSON.stringify(body)).not.toContain("simulated compensation failure");
            expect(JSON.stringify(body)).not.toContain(profileRoot);
            expect(cleanupCalls).toBe(0);
            expect(body).toEqual(expect.objectContaining({ artifactCleanup: expect.objectContaining({ preserved: true }) }));
            const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "linux-vm", deviceId);
            expect(existsSync(join(privateRoot, "incarnation.json"))).toBe(true);
            expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v-intent.json"))).toBe(true);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("runs create, cloud-init, SSH, transfer, snapshot, and cleanup through one owner-fenced backend", async () => {
        const consolePngChunk = (type: string, body: Buffer) => {
            const bytes = Buffer.alloc(12 + body.length);
            bytes.writeUInt32BE(body.length, 0);
            bytes.write(type, 4, "ascii");
            body.copy(bytes, 8);
            return bytes;
        };
        const consolePngHeader = Buffer.alloc(13);
        consolePngHeader.writeUInt32BE(640, 0);
        consolePngHeader.writeUInt32BE(480, 4);
        consolePngHeader[8] = 8;
        const consolePng = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
            consolePngChunk("IHDR", consolePngHeader), consolePngChunk("IDAT", deflateSync(Buffer.alloc(480 * 641))), consolePngChunk("IEND", Buffer.alloc(0))]);
        const consoleInputs: HyperVWindowsExecutionRequest[] = [];
        const cwd = join(process.env.HOME!, "project");
        mkdirSync(cwd, { recursive: true });
        const ownerId = deviceLabOwnerId(cwd);
        const deviceId = "linux-hyperv-e2e";
        const vmId = "12345678-1234-1234-1234-123456789abc";
        const snapshotId = "87654321-4321-4321-4321-cba987654321";
        let vmName = "";
        const privateRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "linux-vm", deviceId);
        const deviceRoot = join(privateRoot, "artifacts");
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        const seedDiskPath = join(deviceRoot, "disks", "cidata.iso");
        const privateKeyPath = join(privateRoot, "secrets", "id_ed25519");
        const publicKeyPath = `${privateKeyPath}.pub`;
        const hostPrivateKeyPath = join(privateRoot, "secrets", "ssh_host_ed25519_key");
        const hostPublicKeyPath = `${hostPrivateKeyPath}.pub`;
        const knownHostsPath = join(privateRoot, "secrets", "known_hosts");
        const hostKeyBytes = ed25519PublicKeyBlob(5);
        const hostKeyBase64 = hostKeyBytes.toString("base64");
        const hostKeyFingerprint = `SHA256:${createHash("sha256").update(hostKeyBytes).digest("base64").replace(/=+$/, "")}`;
        const imageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "images", "hyper-v", "ubuntu-lts");
        const imagePath = join(imageProfileRoot, "base.vhdx");
        const ownerImageProfileRoot = join(process.env.HOME!, ".ccc", "device-broker-private", "owners", ownerId, "images", "hyper-v", "ubuntu-lts");
        const ownerImagePath = join(ownerImageProfileRoot, "base.vhdx");
        const sourceImagePath = join(cwd, "ubuntu-source.vhdx");
        const uploadPath = join(cwd, "upload.txt");
        const downloadPath = join(cwd, "download.txt");
        const imageSha256 = createHash("sha256").update("fake-vhdx").digest("hex");
        writeFileSync(sourceImagePath, "fake-vhdx");
        const expectedNetworkAddress = `172.29.0.${10 + (createHash("sha256").update(`${ownerId}\0${deviceId}\0address`).digest().readUInt32BE(0) % 241)}`;
        writeFileSync(uploadPath, "upload");
        let vmState = "Off";
        let vmExists = false;
        let seedMediaAttached = false;
        let activeIncarnationId: string | undefined;
        let bootDiagnosticState: string | null = null;
        let bootDiagnosticFailure: "command" | "invalid" | "identity" | null = null;
        let snapshotExists = false;
        let snapshotProviderName = "";
        let sshFailure = false;
        let readinessFailure = false;
        let managedReadinessFailure = false;
        let bootstrapAddressAvailable = false;
        let bootstrapAddresses = ["172.20.1.8"];
        let bootstrapMacAddress = "";
        let bootstrapSshFailure = false;
        let bootstrapHostKeyRejectionsRemaining = 0;
        let bootstrapHostKeyRejectedPersistently = false;
        let bootstrapObservedHostKey = ed25519PublicKeyBlob(7);
        let bootstrapSshMarkerMissing = false;
        let networkFinalizeFailure = false;
        let managedReadinessRemainsFailedAfterFinalize = false;
        let bootstrapNetworkFinalizations = 0;
        let scpFailure: "upload" | "download" | null = null;
        let invalidDownloadEncoding = false;
        let foreignVmObservation = false;
        let afterNativeStop: (() => void) | null = null;
        let duringVmObservation: (() => void) | null = null;
        let pendingElevatedNetwork: "setup" | "cleanup" | null = null;
        let standardNetworkCommand: { args?: string[]; input?: string } | null = null;
        let elevatedNetworkSetups = 0;
        const typedCreateSteps: Array<{ operation: string; name?: string; newName?: string; switchName?: string; staticMacAddress?: string }> = [];
        const typedVhdPaths: string[] = [];
        const typedMountPaths: string[] = [];
        let elevatedNetworkCleanups = 0;
        let bootstrapNetworkCleanups = 0;
        let bootstrapAdapterRemoved = false;
        let bootstrapAdapterMissing = false;
        let hostWidePostCreateReads = 0;
        let bootstrapCleanupFailure = false;
        let providerLifecycleFailure = false;
        let guiReady = false;
        let guiProvisionCalls = 0;
        let guiFailure = false;
        const rebootForces: boolean[] = [];

        const commandRunner = vi.fn((command: { mode: string; provider: string; executable?: string; args?: string[]; input?: string }) => {
            if (command.provider === "hyper-v-ssh") {
                const ready = command.args?.at(-1)?.includes("ccc-hyper-v-linux-ready");
                const target = command.args?.at(-2) || "";
                expect(command.args).not.toContain("StrictHostKeyChecking=accept-new");
                const encodedCommand = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash/.exec(command.args?.at(-1) || "")?.[1];
                const guestCommand = encodedCommand ? Buffer.from(encodedCommand, "base64").toString("utf8") : "";
                const download = guestCommand.includes("head -c") && guestCommand.includes("base64 -w0");
                if (guestCommand.includes("CCC_HYPER_V_GUI_READY")) {
                    const provisioning = guestCommand.includes("apt-get -o Acquire::Retries=2");
                    if (provisioning) {
                        guiProvisionCalls += 1;
                        if (guiFailure) return { ...command, status: 1, stdout: "", stderr: "Permission denied: package cache\nhyper-v-linux-gui-apt-install-failed\n" };
                        guiReady = true;
                    }
                    return guiReady
                        ? { ...command, status: 0, stdout: "CCC_HYPER_V_GUI_READY\n", stderr: "" }
                        : { ...command, status: 1, stdout: "", stderr: "hyper-v-linux-gui-ready-failed\n" };
                }
                if (guestCommand.includes("/etc/netplan/99-ccc-static.yaml")) {
                    expect(command.args).toContain(`HostKeyAlias=${expectedNetworkAddress}`);
                    expect(target).toMatch(/@172\.20\.1\.(?:8|9)$/);
                    expect(guestCommand).toContain("netplan apply");
                    bootstrapNetworkFinalizations += 1;
                    if (networkFinalizeFailure) {
                        return { ...command, status: 1, stdout: "", stderr: "network finalize failed" };
                    }
                    if (!managedReadinessRemainsFailedAfterFinalize) managedReadinessFailure = false;
                }
                if (ready && bootstrapSshMarkerMissing && target.endsWith("@172.20.1.8")) {
                    return { ...command, status: 0, stdout: "unexpected-output\n", stderr: "" };
                }
                if (ready
                    && target.endsWith("@172.20.1.8")
                    && (bootstrapHostKeyRejectedPersistently || bootstrapHostKeyRejectionsRemaining > 0)) {
                    bootstrapHostKeyRejectionsRemaining = Math.max(0, bootstrapHostKeyRejectionsRemaining - 1);
                    expect(command.args).toContain("-v");
                    const observedFingerprint = `SHA256:${createHash("sha256").update(bootstrapObservedHostKey).digest("base64").replace(/=+$/, "")}`;
                    return { ...command, status: 255, stdout: "", stderr: `debug1: Server host key: ssh-ed25519 ${observedFingerprint}\nHost key verification failed.` };
                }
                if (sshFailure
                    || (ready && readinessFailure)
                    || (ready && bootstrapSshFailure && target.endsWith("@172.20.1.8"))
                    || (ready && managedReadinessFailure && target.endsWith(`@${expectedNetworkAddress}`))
                    || (download && scpFailure === "download")) {
                    return { ...command, status: 255, stdout: "", stderr: "ssh failed" };
                }
                const windowList = guestCommand.includes("XAUTHORITY=/home/ccc-desktop/.Xauthority bash");
                return { ...command, status: 0, stdout: guestCommand.includes("xdotool windowactivate --sync") ? '{"ok":true}' : windowList ? "42\t123\tR3Vlc3QgTm90ZXM=\n" : ready ? "ccc-hyper-v-linux-ready\n" : download ? invalidDownloadEncoding ? "not-base64!" : Buffer.from("output").toString("base64") : "linux-exec-ok\n", stderr: "" };
            }
            if (command.provider === "hyper-v-scp") {
                const destination = command.args?.at(-1) || "";
                const download = !destination.includes(":");
                if (download) writeFileSync(destination, scpFailure === "download" ? "partial-output" : "output");
                if (scpFailure === (download ? "download" : "upload")) return { ...command, status: 1, stdout: "", stderr: "scp failed" };
                return { ...command, status: 0, stdout: "", stderr: "" };
            }
            const operationRequest = hyperVWindowsOperationRequest(command);
            if (operationRequest) {
                if (providerLifecycleFailure && (operationRequest.operation === "Start-VM" || operationRequest.operation === "Restart-VM")) {
                    return { ...command, status: 1, stdout: "", stderr: "provider lifecycle failed" };
                }
                if (operationRequest.operation === "Restart-VM") rebootForces.push(operationRequest.force === true);
                const virtualMachine = {
                    id: vmId,
                    name: vmName,
                    state: vmState,
                    status: "Operating normally",
                    notes: foreignVmObservation ? "foreign-owner" : `ccc-device-lab:${ownerId}:${deviceId}:${activeIncarnationId || "missing-incarnation"}`,
                    uptimeMilliseconds: vmState === "Running" ? 1000 : 0,
                    generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                    checkpointType: "Production",
                };
                if (operationRequest.operation === "Get-VMDiagnostic") {
                    if (bootDiagnosticFailure === "command") {
                        return { ...command, status: 1, stdout: JSON.stringify({ schemaVersion: 1, operation: "Get-VMDiagnostic", ok: false, errorCode: "hyper-v-guest-boot-diagnostic-command-failed" }) };
                    }
                    if (bootDiagnosticFailure === "invalid") {
                        return { ...command, status: 0, stdout: "{}" };
                    }
                    const diagnostic = {
                        ok: true, vmId, vmName: bootDiagnosticFailure === "identity" ? "wrong-vm" : vmName,
                        generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                        state: bootDiagnosticState || vmState, uptimeMs: 1000,
                        secureBootEnabled: null, heartbeatEnabled: true,
                        heartbeatPrimaryStatus: 2, heartbeatSecondaryStatus: 0,
                        integrationServices: [{ name: "Heartbeat", enabled: true, primaryStatus: 2, secondaryStatus: 0 }],
                        hardDiskCount: 1, dvdCount: 1, hardDiskControllers: ["scsi"],
                        bootDeviceTypes: ["hard-disk", "dvd"],
                        bootEntries: [{ bootType: "Drive", deviceType: "Vhd", controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0 }],
                        hardDisks: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 0, vhdFormat: "VHDX", vhdType: "Dynamic", sizeBytes: 34359738368, fileSizeBytes: 4294967296, minimumSizeBytes: 3221225472, logicalSectorSize: 512, physicalSectorSize: 4096 }],
                        dvdDrives: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 1, mediaAttached: true }],
                        diagnosticComplete: true, diagnosticErrors: [],
                    };
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, [diagnostic]) };
                }
                if (operationRequest.operation === "Capture-VMConsole") {
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, [{ pngBase64: consolePng.toString("base64"), width: 640, height: 480, nativeWidth: 1280, nativeHeight: 960 }]) };
                }
                if (operationRequest.operation === "Send-VMConsoleInput") {
                    consoleInputs.push(operationRequest);
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation) };
                }
                if (operationRequest.operation === "Get-VM") {
                    duringVmObservation?.();
                    const selectorMatches = operationRequest.selector.kind === "id"
                        ? operationRequest.selector.id.toLowerCase() === vmId
                        : operationRequest.selector.name === vmName;
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, vmExists && selectorMatches ? [virtualMachine] : []) };
                }
                // The bootstrap adapter as this host reports it. It exists for as long as the
                // VM does, which is what the program this replaced modelled: each scenario
                // drives the guest's reachability through bootstrapAddressAvailable, not
                // through whether a previous teardown ran.
                const bootstrapAdapter = {
                    vmId,
                    vmName,
                    name: "CCC Bootstrap DHCP",
                    switchId: null,
                    switchName: "Default Switch",
                    status: "Ok",
                    managementOperatingSystem: false,
                    macAddress: bootstrapMacAddress ? bootstrapMacAddress.replaceAll(":", "").toUpperCase() : null,
                    ipAddresses: bootstrapAddressAvailable ? bootstrapAddresses : [],
                };
                if (operationRequest.operation === "Get-VMNetworkAdapter") {
                    if (operationRequest.managementSwitchName) {
                        return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, [{
                            ...bootstrapAdapter,
                            vmId: null,
                            vmName: null,
                            name: "Default Switch",
                            managementOperatingSystem: true,
                            macAddress: "00155D000001",
                            ipAddresses: ["172.20.0.1"],
                        }]) };
                    }
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, vmExists && !bootstrapAdapterMissing ? [bootstrapAdapter] : []) };
                }
                if (operationRequest.operation === "Get-NetNeighbor") {
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, []) };
                }
                if (operationRequest.operation === "Remove-VMNetworkAdapter") {
                    bootstrapNetworkCleanups += 1;
                    if (bootstrapCleanupFailure) return { ...command, status: 1, stdout: "", stderr: "cleanup failed" };
                    bootstrapAdapterRemoved = true;
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation) };
                }
                if (operationRequest.operation === "Get-VMHardDiskDrive") {
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, vmExists ? [{
                        vmId,
                        vmName,
                        path: diskPath,
                        controllerType: "SCSI",
                        controllerNumber: 0,
                        controllerLocation: 0,
                        diskNumber: null,
                    }] : []) };
                }
                if (operationRequest.operation === "Get-VMDvdDrive") {
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, vmExists && seedMediaAttached ? [{
                        vmId,
                        vmName,
                        path: seedDiskPath,
                        controllerType: "SCSI",
                        controllerNumber: 0,
                        controllerLocation: 1,
                    }] : []) };
                }
                const snapshotItem = (name: string) => ({
                    id: snapshotId,
                    name,
                    vmId,
                    vmName,
                    snapshotType: "Production",
                    parentSnapshotId: null,
                    parentSnapshotName: null,
                    creationTimeMilliseconds: 1_700_000_000_000,
                });
                if (operationRequest.operation === "Checkpoint-VM") {
                    // Echo back the owner-scoped name the adapter asked for; the naming convention
                    // is Device Lab's, so the host never invents one.
                    snapshotProviderName = operationRequest.snapshotName;
                    snapshotExists = true;
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, [snapshotItem(snapshotProviderName)]) };
                }
                if (operationRequest.operation === "Get-VMSnapshot") {
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, snapshotExists ? [snapshotItem(snapshotProviderName)] : []) };
                }
                if (operationRequest.operation === "Repair-VMSnapshotState") {
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, [{
                        checkpointPolicy: "Production", candidateCount: snapshotExists ? 1 : 0,
                    }]) };
                }
                if (operationRequest.operation === "Get-VHD") {
                    return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation, [{
                        path: operationRequest.path,
                        vhdFormat: "VHDX",
                        vhdType: "Dynamic",
                        parentPath: null,
                        virtualSizeBytes: 64 * 1024 * 1024 * 1024,
                        fileSizeBytes: 1024,
                    }]) };
                }
                if (operationRequest.operation === "Remove-VMSnapshot") snapshotExists = false;
                if (operationRequest.operation === "Restore-VMSnapshot") vmState = "Off";
                if (operationRequest.operation === "Configure-VMGuestBoot") seedMediaAttached = true;
                if (operationRequest.operation === "Start-VM") vmState = "Running";
                if (operationRequest.operation === "Stop-VM") { vmState = "Off"; afterNativeStop?.(); }
                if (operationRequest.operation === "Remove-VM") { vmExists = false; vmState = "Off"; seedMediaAttached = false; }
                return { ...command, ...hyperVWindowsOperationSuccess(operationRequest.operation) };
            }
            const script = providerScript(command);
            if (script.includes("function Save-BoundedDownload")) {
                return { ...command, status: 0, stdout: automaticUbuntuPrepareOutput(imageProfileRoot, "fake-vhdx"), stderr: "" };
            }
            if (script.includes("$ExpectedPartialHash =")) {
                return { ...command, status: 0, stdout: automaticUbuntuFinalizeOutput(imageProfileRoot), stderr: "" };
            }
            if (script.includes("CccHyperVNetworkPipeNative")) {
                expect(pendingElevatedNetwork).not.toBeNull();
                if (pendingElevatedNetwork === "setup") {
                    elevatedNetworkSetups += 1;
                    pendingElevatedNetwork = null;
                    return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(standardNetworkCommand!)), stderr: "" };
                }
                elevatedNetworkCleanups += 1;
                pendingElevatedNetwork = null;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, removedSwitch: true, removedNat: true, removedGateway: true, alreadyMissing: false }), stderr: "" };
            }
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) {
                pendingElevatedNetwork = "cleanup";
                return { ...command, status: 1, stdout: "", stderr: "hyper-v-network-elevation-required" };
            }
            if (script.includes("New-VM @VmArgs")) {
                vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
                vmExists = true;
                // The create program is where the bootstrap address is assigned, so this is the
                // only place this host learns it. Everything the typed bootstrap path asks
                // about afterwards is keyed on it.
                bootstrapMacAddress = powerShellString(script, "BootstrapMacAddress");
            }
            const imagePrepare = script.includes("hyper-v-base-image-profile-conflict");
            const imageSetup = imagePrepare;
            const networkSetup = script.includes("New-NetNat -Name $NatName");
            if (networkSetup) expect(existsSync(join(privateRoot, "incarnation.json"))).toBe(true);
            if (networkSetup) {
                standardNetworkCommand = command;
                pendingElevatedNetwork = "setup";
                return { ...command, status: 1, stdout: "", stderr: "New-NetIPAddress: PermissionDenied (Windows System Error 5)" };
            }
            const recovery = script.includes("hyper-v-orphan-vm-ownership-mismatch");
            const seed = script.includes("Write-CccIso $IsoFiles $SeedDisk 'cidata'");
            const bootDiagnostic = script.includes("Get-CccGuestBootDiagnosticResult $Vm");
            if (bootDiagnostic && bootDiagnosticFailure === "command") {
                return { ...command, status: 1, stdout: "", stderr: "hyper-v-guest-boot-diagnostic-command-failed: host detail" };
            }
            if (bootDiagnostic && bootDiagnosticFailure === "invalid") {
                return { ...command, status: 0, stdout: "{}", stderr: "" };
            }
            const networkAddress = expectedNetworkAddress;
            const snapshotCreate = script.includes("Checkpoint-VM") || script.includes("New-CccVmSnapshot");
            const snapshotRepair = script.includes("Repair-CccVmSnapshotState");
            const snapshotDelete = script.includes("snapshotId = [string]$Snapshot.Id") && script.includes("deleted = $true");
            const snapshot = snapshotCreate || script.includes("Restore-VMSnapshot") || snapshotDelete;
            const deleting = script.includes("Remove-VM -VM $Vm");
            if (providerLifecycleFailure && (script.includes("Start-VM") || script.includes("Restart-VM"))) {
                return { ...command, status: 1, stdout: "", stderr: "provider lifecycle failed" };
            }
            if (script.includes("Restart-VM")) rebootScripts.push(script);
            if (script.includes("Start-VM") || script.includes("Restart-VM")) vmState = "Running";
            if (script.includes("Stop-VM")) vmState = "Off";
            if (deleting) { vmExists = false; vmState = "Off"; }
            if (snapshotCreate) snapshotExists = true;
            if (snapshotDelete) snapshotExists = false;
            if (imageSetup) {
                mkdirSync(imageProfileRoot, { recursive: true });
                writeFileSync(imagePath, "fake-vhdx");
            }
            if (seed) {
                mkdirSync(dirname(seedDiskPath), { recursive: true });
                mkdirSync(dirname(privateKeyPath), { recursive: true });
                writeFileSync(seedDiskPath, "seed");
                writeFileSync(privateKeyPath, "private-key");
                writeFileSync(publicKeyPath, "ssh-ed25519 AAAATEST ccc\n");
                writeFileSync(hostPrivateKeyPath, "host-private-key");
                writeFileSync(hostPublicKeyPath, `ssh-ed25519 ${hostKeyBase64} ccc-host\n`);
                writeFileSync(knownHostsPath, `${networkAddress} ssh-ed25519 ${hostKeyBase64} ccc-host\n`);
            }
            const result = bootDiagnostic
                ? { ok: true, vmId, vmName: bootDiagnosticFailure === "identity" ? "wrong-vm" : vmName, generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, state: bootDiagnosticState || vmState, uptimeMs: 1000, secureBootEnabled: null, heartbeatEnabled: true, heartbeatPrimaryStatus: 2, heartbeatSecondaryStatus: 0, integrationServices: [{ name: "Heartbeat", enabled: true, primaryStatus: 2, secondaryStatus: 0 }], hardDiskCount: 1, dvdCount: 1, hardDiskControllers: ["scsi"], bootDeviceTypes: ["hard-disk", "dvd"], bootEntries: [{ bootType: "Drive", deviceType: "Vhd", controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0 }], hardDisks: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 0, vhdFormat: "VHDX", vhdType: "Dynamic", sizeBytes: 34359738368, fileSizeBytes: 4294967296, minimumSizeBytes: 3221225472, logicalSectorSize: 512, physicalSectorSize: 4096 }], dvdDrives: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 1, mediaAttached: true }], diagnosticComplete: true, diagnosticErrors: [] }
                : imageSetup
                ? { ok: true, profile: "ubuntu-lts", imagePath, sha256: imageSha256, sizeBytes: 9, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, reused: false }
                : networkSetup
                    ? hyperVNetworkObservation(command)
                    : recovery
                        ? { ok: true, recoveredVm: false, removedDisk: false }
                        : seed
                            ? { ok: true, vmId, vmName, seedDiskPath, sshPrivateKeyPath: privateKeyPath, sshPublicKeyPath: publicKeyPath, sshHostPublicKeyPath: hostPublicKeyPath, sshHostKeyFingerprint: hostKeyFingerprint, knownHostsPath, guestUsername: `ccc${ownerId.slice(0, 8)}`, networkAddress }
                            : snapshotRepair
                                ? { ok: true, checkpointPolicy: "Production", candidateCount: snapshotExists ? 1 : 0 }
                            : snapshot
                                ? { ok: true, snapshotId, snapshotName: `ccc-${ownerId}-baseline`, snapshotType: "Recovery", state: vmState, ...(snapshotDelete ? { deleted: true } : {}) }
                                : { ok: true, vmId, vmName, generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, state: vmState, status: "Operating normally", diskPath, checkpointPolicy: "Production", snapshots: snapshotExists ? [{ snapshotId, snapshotName: `ccc-${ownerId}-baseline`, snapshotType: "Recovery" }] : [], ...(deleting ? { deleted: true } : {}) };
            return { ...command, status: 0, stdout: JSON.stringify(result), stderr: "" };
        });
        configureTypedHyperVNetworkOperations(commandRunner, {
            simulateVmCreate: "until-readback",
            // The device's own VM is this test's to model: the fabric simulator only knows the
            // VMs that hold network allocations, and the bootstrap path proves ownership
            // against this one by name, id and marker.
            beforeOperation(request) {
                if (request.operation === "Get-VMNetworkAdapter" && !request.selector
                    && !request.managementSwitchName) {
                    if (!vmExists || bootstrapAdapterRemoved || bootstrapAdapterMissing) return hyperVWindowsOperationSuccess("Get-VMNetworkAdapter", []);
                    if (typedCreateSteps.length >= 5 && ++hostWidePostCreateReads > 1) {
                        return hyperVWindowsOperationSuccess("Get-VMNetworkAdapter", [{
                            vmId, vmName, name: "CCC Bootstrap DHCP", switchId: null,
                            switchName: "Default Switch", status: "Ok", managementOperatingSystem: false,
                            macAddress: bootstrapMacAddress, ipAddresses: [],
                        }]);
                    }
                }
                if (request.operation !== "Get-VM" || !request.names) return null;
                const named = vmExists && request.names.includes(vmName)
                    ? [{
                        id: vmId,
                        name: vmName,
                        notes: `ccc-device-lab:${ownerId}:${deviceId}:${activeIncarnationId || "missing-incarnation"}`,
                    }]
                    : [];
                return hyperVWindowsOperationSuccess("Get-VM", named);
            },
            onOperation(request) {
                if (request.operation === "Get-VHD" && request.path) typedVhdPaths.push(request.path);
                if (request.operation === "Mount-VHD" && request.path) typedMountPaths.push(request.path);
                if (["New-VM", "Rename-VMNetworkAdapter", "Add-VMNetworkAdapter", "Set-VMNetworkAdapter"].includes(request.operation)) {
                    typedCreateSteps.push({ operation: request.operation, name: request.name, newName: request.newName, switchName: request.switchName, staticMacAddress: request.staticMacAddress });
                }
                if (request.operation === "New-VMSwitch") elevatedNetworkSetups += 1;
                if (request.operation === "Remove-NetNat") elevatedNetworkCleanups += 1;
                if (request.operation === "New-VM") {
                    vmName = request.name || "";
                    vmExists = true;
                    seedMediaAttached = false;
                    bootstrapAdapterRemoved = false;
                    hostWidePostCreateReads = 0;
                }
                if (request.operation === "Set-VM" && request.notes) {
                    activeIncarnationId = request.notes.split(":").at(-1);
                }
                if (request.operation === "Set-VMNetworkAdapter" && request.adapter?.name === "CCC Bootstrap DHCP") {
                    bootstrapMacAddress = request.staticMacAddress || "";
                }
            },
        });
        const server = createDeviceBrokerServer({
            cwd,
            host: "127.0.0.1",
            port: 0,
            platform: "win32",
            providerPaths: { "powershell.exe": "/fake/powershell.exe", "ssh.exe": "/fake/ssh.exe", "scp.exe": "/fake/scp.exe" },
            commandRunner,
        });
        const baseUrl = await listen(server);
        const endpoint = ownerRpcEndpoint(baseUrl, ownerId);
        const headers = ownerRpcHeaders(ownerId);
        const invoke = (params: Record<string, unknown>) => fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ method: "broker.command.invoke", params }) });
        const tool = (name: string, params: Record<string, unknown> = {}) => fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool: name, backend: "linux-vm", deviceId, ...(activeIncarnationId ? { incarnationId: activeIncarnationId } : {}), ...params } }) });
        try {
            const backends = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ method: "broker.backends" }) });
            expect(await backends.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ backends: expect.arrayContaining([expect.objectContaining({ name: "linux-vm", provider: "hyper-v", guestTransport: "ssh" })]) }) }));

            const created = await invoke({ backend: "linux-vm", command: "device_create", deviceId, name: "Ubuntu Hyper-V", sourceImage: sourceImagePath, memoryMb: 2048, cpus: 2 });
            expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
            expect(elevatedNetworkSetups).toBe(1);
            expect(commandRunner.mock.calls.some(([command]) => {
                const script = providerScript(command);
                return script.includes("function Save-BoundedDownload") && script.includes("$Profile = 'ubuntu-lts'");
            })).toBe(false);
            const createdBody = await created.json();
            activeIncarnationId = createdBody.result.device.incarnationId as string;
            const allocatedAddress = createdBody.result.device.networkAddress as string;
            const allocatedMac = createdBody.result.device.macAddress as string;
            expect(createdBody).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ backend: "linux-vm", platform: "linux", provider: "hyper-v", guestProvisioned: true, guestTransport: "ssh", sshHostKeyFingerprint: hostKeyFingerprint, networkAddress: expect.stringMatching(/^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/) }) }) }));
            expect(createdBody.result.device).not.toHaveProperty("seedDiskPath");
            expect(createdBody.result.device).not.toHaveProperty("sshHostPublicKeyPath");
            expect(createdBody.result.device).not.toHaveProperty("sshKnownHostsPath");
            expect(typedMountPaths).toHaveLength(1);
            expect(typedMountPaths[0]).toMatch(/\.source-[a-f0-9]{24}\.vhdx$/);
            expect(typedVhdPaths[0]).toBe(typedMountPaths[0]);
            expect(typedVhdPaths).toContain(ownerImagePath);
            expect(typedVhdPaths).toContain(diskPath);
            expect(JSON.parse(readFileSync(join(ownerImageProfileRoot, "manifest.json"), "utf8"))).toEqual(expect.objectContaining({
                catalogId: "user-provided-vhdx", imagePath: ownerImagePath, sha256: imageSha256,
            }));
            expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("$Vhd = Get-VHD -Path $VhdPath"))).toBe(false);
            expect(typedCreateSteps.map((step) => step.operation)).toEqual([
                "New-VM", "Rename-VMNetworkAdapter", "Set-VMNetworkAdapter", "Add-VMNetworkAdapter", "Set-VMNetworkAdapter",
            ]);
            expect(typedCreateSteps[0]).toMatchObject({ switchName: "Default Switch" });
            expect(typedCreateSteps[1]).toMatchObject({ newName: "CCC Bootstrap DHCP" });
            expect(typedCreateSteps[3]).toMatchObject({ name: "CCC Device Network", switchName: "CCC Device Lab" });
            expect(typedCreateSteps[4]).toMatchObject({ staticMacAddress: allocatedMac.replaceAll(":", "").toUpperCase() });
            expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("New-VM @VmArgs"))).toBe(false);
            const seedScript = commandRunner.mock.calls
                .map(([command]) => providerScript(command))
                .find((script) => script.includes("Write-CccIso $IsoFiles $SeedDisk 'cidata'"));
            expect(seedScript).not.toContain("Get-VMNetworkAdapter");
            expect(seedScript).not.toContain("Add-VMDvdDrive");
            expect(seedScript).toContain("'  bootstrap0:'");
            expect(seedScript).toContain("'    set-name: bootstrap0'");
            expect(seedScript).toContain("'    dhcp4: true'");
            expect(seedScript).not.toContain("'  ccc0:'");
            expect(seedScript).not.toContain(`macaddress: '${allocatedMac}'`);
            expect(seedScript).not.toContain("/etc/netplan/99-ccc-static.yaml");
            const typedSeedAttach = commandRunner.mock.calls
                .map(([command]) => hyperVWindowsOperationRequest(command))
                .find((request) => request?.operation === "Configure-VMGuestBoot");
            expect(typedSeedAttach).toMatchObject({ guestKind: "linux", expectedName: vmName,
                expectedBootstrapMacAddress: `06${allocatedMac.replaceAll(":", "").slice(2)}`.toUpperCase(),
                bootSettings: { generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                    secureBoot: { enabled: false } } });
            expect(createdBody.result.device).not.toHaveProperty("privateRoot");
            expect(createdBody.result.device).not.toHaveProperty("sshPrivateKeyPath");
            expect(JSON.stringify(createdBody)).not.toContain('"sshPrivateKeyPath"');

            const callsAfterCreate = commandRunner.mock.calls.length;
            const repeatedCreate = await invoke({ backend: "linux-vm", command: "device_create", deviceId, name: "Ubuntu Hyper-V", memoryMb: 2048, cpus: 2 });
            expect(repeatedCreate.status, JSON.stringify(await repeatedCreate.clone().json())).toBe(200);
            const repeatedCreateBody = await repeatedCreate.json();
            expect(repeatedCreateBody).toEqual(expect.objectContaining({ result: expect.objectContaining({ idempotent: true, invoked: false }) }));
            expect(commandRunner).toHaveBeenCalledTimes(callsAfterCreate);
            expect(repeatedCreateBody.result.device).not.toHaveProperty("privateRoot");
            expect(repeatedCreateBody.result.device).not.toHaveProperty("sshPrivateKeyPath");
            expect(JSON.stringify(repeatedCreateBody)).not.toContain('"sshPrivateKeyPath"');

            const callsBeforeUnsafeStart = commandRunner.mock.calls.length;
            const unsafeStart = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: false });
            expect(unsafeStart.status).toBe(400);
            expect(await unsafeStart.json()).toEqual(expect.objectContaining({ error: "linux-vm-bootstrap-requires-boot-wait" }));
            expect(commandRunner).toHaveBeenCalledTimes(callsBeforeUnsafeStart);

            providerLifecycleFailure = true;
            bootstrapCleanupFailure = true;
            const providerFailedStart = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(providerFailedStart.status).toBe(502);
            expect(await providerFailedStart.json()).toEqual(expect.objectContaining({
                result: expect.objectContaining({
                    device: expect.objectContaining({ status: "stopped", runtimeState: "Off", bootReady: false }),
                }),
            }));
            expect(vmState).toBe("Off");
            providerLifecycleFailure = false;
            bootstrapCleanupFailure = false;

            writeFileSync(knownHostsPath, `${allocatedAddress} ssh-ed25519 ${Buffer.from("tampered-host-key").toString("base64")} attacker\n`);
            const sshCallsBeforeTamper = commandRunner.mock.calls.filter(([command]) => command.provider === "hyper-v-ssh").length;
            const tamperedIdentity = await tool("device_exec", { command: "uname -a" });
            expect(tamperedIdentity.status).toBe(409);
            expect(await tamperedIdentity.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-ssh-host-identity-invalid" }));
            expect(commandRunner.mock.calls.filter(([command]) => command.provider === "hyper-v-ssh")).toHaveLength(sshCallsBeforeTamper);
            writeFileSync(knownHostsPath, `${allocatedAddress} ssh-ed25519 ${hostKeyBase64} ccc-host\n`);

            readinessFailure = true;
            bootDiagnosticFailure = "command";
            const diagnosticFailure = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(diagnosticFailure.status).toBe(502);
            const diagnosticFailureBody = await diagnosticFailure.json();
            expect(diagnosticFailureBody.result, JSON.stringify(diagnosticFailureBody)).toBeDefined();
            expect(diagnosticFailureBody.result.boot).toEqual(expect.objectContaining({
                ready: false,
                provider: "hyper-v-ssh",
                diagnosticAvailable: false,
                diagnosticError: "hyper-v-guest-boot-diagnostic-command-failed",
            }));
            expect(diagnosticFailureBody.result.boot).not.toHaveProperty("diagnostic");
            expect(JSON.stringify(diagnosticFailureBody)).not.toContain("host detail");
            bootDiagnosticFailure = "invalid";
            const invalidDiagnostic = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect((await invalidDiagnostic.json()).result.boot).toEqual(expect.objectContaining({
                diagnosticAvailable: false,
                diagnosticError: "hyper-v-guest-boot-diagnostic-invalid",
            }));
            bootDiagnosticFailure = "identity";
            const mismatchedDiagnostic = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect((await mismatchedDiagnostic.json()).result.boot).toEqual(expect.objectContaining({
                diagnosticAvailable: false,
                diagnosticError: "hyper-v-guest-boot-diagnostic-identity-mismatch",
            }));
            bootDiagnosticFailure = null;
            bootDiagnosticState = "OffCritical";
            bootstrapCleanupFailure = true;
            const exhausted = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(exhausted.status).toBe(502);
            const exhaustedBody = await exhausted.json();
            const readinessError = exhaustedBody.result.boot.error;
            expect(typeof readinessError).toBe("string");
            expect(readinessError.length).toBeGreaterThan(0);
            expect(readinessError).not.toBe("hyper-v-guest-boot-signal-timeout");
            expect(exhaustedBody).toEqual(expect.objectContaining({
                error: "hyper-v-guest-not-ready",
                result: expect.objectContaining({
                    boot: {
                        ready: false,
                        provider: "hyper-v-ssh",
                        error: readinessError,
                        // Additive detail that discriminates a readiness failure the bare code
                        // cannot explain. Byte counts, never the output itself. `structured` is a
                        // windows-vm signal and must not appear on this lane.
                        errorDetail: expect.objectContaining({
                            timedOut: expect.any(Boolean),
                            stdoutBytes: expect.any(Number),
                            stderrBytes: expect.any(Number),
                        }),
                        readiness: expect.objectContaining({
                            managedSshAttempts: expect.any(Number),
                            bootstrapProbeAttempts: expect.any(Number),
                            bootstrapProbeSuccesses: expect.any(Number),
                            bootstrapAddressCount: 0,
                            bootstrapSshAttempts: 0,
                            networkFinalizeAttempts: 0,
                            networkFinalizeSucceeded: false,
                            guestSignalObserved: false,
                            elapsedMs: expect.any(Number),
                        }),
                        diagnosticAvailable: true,
                        diagnostic: expect.objectContaining({
                            state: "OffCritical",
                            generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                            secureBootEnabled: null,
                            hardDiskCount: 1,
                            hardDiskControllers: ["scsi"],
                            bootDeviceTypes: ["hard-disk", "dvd"],
                            bootEntries: [{ bootType: "Drive", deviceType: "Vhd", controllerType: "SCSI", controllerNumber: 0, controllerLocation: 0 }],
                            hardDisks: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 0, vhdFormat: "VHDX", vhdType: "Dynamic", sizeBytes: 34359738368, fileSizeBytes: 4294967296, minimumSizeBytes: 3221225472, logicalSectorSize: 512, physicalSectorSize: 4096 }],
                            dvdDrives: [{ controllerType: "scsi", controllerNumber: 0, controllerLocation: 1, mediaAttached: true }],
                        }),
                    },
                }),
            }));
            expect(exhaustedBody.result.boot.errorDetail).not.toHaveProperty("structured");
            expect(exhaustedBody.result.boot.diagnostic).not.toHaveProperty("vmId");
            expect(exhaustedBody.result.boot.diagnostic).not.toHaveProperty("vmName");
            expect(exhaustedBody.result.device).toEqual(expect.objectContaining({ status: "stopped", runtimeState: "Off", bootReady: false }));
            expect(exhaustedBody.result.execution.command).toEqual(expect.objectContaining({
                guestReadiness: {
                    provider: "hyper-v-ssh",
                    error: readinessError,
                    errorDetail: expect.objectContaining({
                        stdoutBytes: expect.any(Number),
                        stderrBytes: expect.any(Number),
                    }),
                    readiness: expect.objectContaining({
                        guestSignalObserved: false,
                        bootstrapAddressCount: 0,
                    }),
                    diagnosticAvailable: true,
                },
            }));
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("args");
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("input");
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("stdout");
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("stderr");
            expect(exhaustedBody.result.providerCommand).toEqual({ mode: "exec", provider: "hyper-v" });
            expect(exhaustedBody.detail).toBe(readinessError);
            expect(vmState).toBe("Off");
            bootstrapCleanupFailure = false;
            readinessFailure = false;
            bootDiagnosticState = null;

            expect(bootstrapNetworkCleanups).toBeGreaterThan(0);
            bootstrapNetworkCleanups = 0;
            bootstrapAddressAvailable = true;

            managedReadinessFailure = true;
            bootstrapSshFailure = true;
            const bootstrapSshFailed = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(bootstrapSshFailed.status).toBe(502);
            const bootstrapSshReadiness = (await bootstrapSshFailed.json()).result.boot.readiness;
            expect(bootstrapSshReadiness).toEqual(expect.objectContaining({
                bootstrapAddressCount: 1,
                networkFinalizeAttempts: 0,
                networkFinalizeSucceeded: false,
                guestSignalObserved: true,
            }));
            expect(bootstrapSshReadiness.bootstrapProbeSuccesses).toBeGreaterThan(0);
            expect(bootstrapSshReadiness.bootstrapSshAttempts).toBeGreaterThan(0);
            expect(bootstrapSshReadiness.bootstrapSshLastStatus).toBe(255);
            expect(bootstrapSshReadiness.bootstrapSshLastError).toBe("ssh-unavailable");
            bootstrapSshFailure = false;

            bootstrapHostKeyRejectedPersistently = true;
            bootstrapAddresses = ["172.20.1.8", "172.20.1.9"];
            managedReadinessFailure = true;
            const staleBootstrapCandidate = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 60000 });
            expect(staleBootstrapCandidate.status, JSON.stringify(await staleBootstrapCandidate.clone().json())).toBe(200);
            const staleBootstrapCandidateBody = await staleBootstrapCandidate.json();
            expect(staleBootstrapCandidateBody.result.device.sshHostKeyFingerprint).toBe(hostKeyFingerprint);
            expect(staleBootstrapCandidateBody.result.boot.readiness).toEqual(expect.objectContaining({
                bootstrapSshAttempts: 2,
                bootstrapHostKeyAdopted: false,
                bootstrapHostKeyObserved: true,
                bootstrapHostKeyMatchesExpected: true,
                networkFinalizeSucceeded: true,
            }));

            bootstrapHostKeyRejectedPersistently = false;
            bootstrapAddresses = ["172.20.1.8"];
            bootstrapHostKeyRejectionsRemaining = 1;
            managedReadinessFailure = true;
            const transitionStartedAt = Date.now();
            const bootstrapHostKeyTransition = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 60000 });
            expect(Date.now() - transitionStartedAt).toBeLessThan(5000);
            expect(bootstrapHostKeyTransition.status, JSON.stringify(await bootstrapHostKeyTransition.clone().json())).toBe(200);
            const bootstrapHostKeyTransitionBody = await bootstrapHostKeyTransition.json();
            expect(bootstrapHostKeyTransitionBody.result.device.sshHostKeyFingerprint).toBe(hostKeyFingerprint);
            expect(bootstrapHostKeyTransitionBody.result.boot.readiness).toEqual(expect.objectContaining({
                bootstrapHostKeyObserved: true,
                bootstrapHostKeyMatchesExpected: true,
                bootstrapHostKeyAdopted: false,
                bootstrapSshAttempts: expect.any(Number),
                networkFinalizeSucceeded: true,
            }));
            expect(bootstrapHostKeyTransitionBody.result.boot.readiness.bootstrapSshAttempts).toBeGreaterThanOrEqual(2);
            expect(readFileSync(hostPublicKeyPath, "utf8")).toContain(hostKeyBase64);
            expect(readFileSync(knownHostsPath, "utf8")).toContain(hostKeyBase64);
            expect(existsSync(join(privateRoot, "secrets", "bootstrap_known_hosts"))).toBe(false);

            bootstrapObservedHostKey = ed25519PublicKeyBlob(8);
            bootstrapHostKeyRejectedPersistently = true;
            managedReadinessFailure = true;
            const bootstrapHostKeyClientFailure = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 10000 });
            expect(bootstrapHostKeyClientFailure.status).toBe(502);
            const bootstrapHostKeyClientFailureBoot = (await bootstrapHostKeyClientFailure.json()).result.boot;
            expect(bootstrapHostKeyClientFailureBoot.error, JSON.stringify(bootstrapHostKeyClientFailureBoot)).toBe("ssh-host-key-rejected");
            expect(bootstrapHostKeyClientFailureBoot.readiness).toEqual(expect.objectContaining({
                bootstrapHostKeyObserved: true,
                bootstrapHostKeyMatchesExpected: false,
                bootstrapHostKeyAdopted: false,
            }));
            expect(readFileSync(hostPublicKeyPath, "utf8")).toContain(hostKeyBase64);
            expect(readFileSync(knownHostsPath, "utf8")).toContain(hostKeyBase64);
            bootstrapHostKeyRejectedPersistently = false;
            managedReadinessFailure = true;

            bootstrapSshMarkerMissing = true;
            const bootstrapMarkerMissing = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 5000 });
            expect(bootstrapMarkerMissing.status, JSON.stringify(await bootstrapMarkerMissing.clone().json())).toBe(502);
            const bootstrapMarkerMissingBoot = (await bootstrapMarkerMissing.json()).result.boot;
            expect(bootstrapMarkerMissingBoot.error, JSON.stringify(bootstrapMarkerMissingBoot)).toBe("ssh-readiness-marker-missing");
            expect(bootstrapMarkerMissingBoot.readiness).toEqual(expect.objectContaining({
                bootstrapSshLastStatus: 0,
                bootstrapSshLastError: "ssh-readiness-marker-missing",
            }));
            bootstrapSshMarkerMissing = false;

            networkFinalizeFailure = true;
            const finalizeFailed = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(finalizeFailed.status).toBe(502);
            const finalizeReadiness = (await finalizeFailed.json()).result.boot.readiness;
            expect(finalizeReadiness).toEqual(expect.objectContaining({
                bootstrapAddressCount: 1,
                networkFinalizeSucceeded: false,
                guestSignalObserved: true,
            }));
            expect(finalizeReadiness.bootstrapSshAttempts).toBeGreaterThan(0);
            expect(finalizeReadiness.networkFinalizeAttempts).toBeGreaterThan(0);
            networkFinalizeFailure = false;

            managedReadinessRemainsFailedAfterFinalize = true;
            const managedSshFailed = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 3000 });
            expect(managedSshFailed.status).toBe(502);
            const managedSshReadiness = (await managedSshFailed.json()).result.boot.readiness;
            expect(managedSshReadiness).toEqual(expect.objectContaining({
                bootstrapAddressCount: 1,
                networkFinalizeSucceeded: true,
                guestSignalObserved: true,
            }));
            expect(managedSshReadiness.networkFinalizeAttempts).toBeGreaterThan(0);
            expect(managedSshReadiness.managedSshAttempts).toBeGreaterThanOrEqual(2);
            managedReadinessRemainsFailedAfterFinalize = false;

            // A previously removed bootstrap adapter is an idempotent cleanup success. The
            // probe has no address to offer, and teardown must not remove another adapter.
            bootstrapAdapterMissing = true;
            managedReadinessFailure = true;
            const cleanupsBeforeMissingAdapter = bootstrapNetworkCleanups;
            const missingAdapterStart = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 10000 });
            expect(missingAdapterStart.status).toBe(502);
            const missingAdapterBody = await missingAdapterStart.json();
            expect(missingAdapterBody.result.boot.readiness).toEqual(expect.objectContaining({
                bootstrapProbeSuccesses: expect.any(Number),
                bootstrapAddressCount: 0,
                networkFinalizeAttempts: 0,
            }));
            expect(missingAdapterBody.result.boot.readiness.bootstrapProbeSuccesses).toBeGreaterThan(0);
            expect(bootstrapNetworkCleanups).toBe(cleanupsBeforeMissingAdapter);
            expect(missingAdapterBody.result.device).toEqual(expect.objectContaining({ runtimeState: "Running", bootReady: false }));
            bootstrapAdapterMissing = false;

            bootstrapNetworkFinalizations = 0;
            bootstrapNetworkCleanups = 0;
            managedReadinessFailure = true;
            const started = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(started.status, JSON.stringify(await started.clone().json())).toBe(200);
            expect(await started.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "running", bootReady: true }), boot: expect.objectContaining({ provider: "hyper-v-ssh", ready: true }) }) }));
            expect(guiProvisionCalls).toBe(1);
            expect(bootstrapNetworkFinalizations).toBe(1);
            expect(bootstrapNetworkCleanups).toBe(1);

            sshFailure = true;
            const failedExec = await tool("device_exec", { command: "uname -a" });
            expect(failedExec.status).toBe(502);
            const failedExecBody = await failedExec.json();
            expect(failedExecBody).toEqual(expect.objectContaining({
                error: "hyper-v-linux-guest-provider-failed",
                execution: expect.objectContaining({
                    provider: "hyper-v-ssh",
                    status: 255,
                    outputRedacted: true,
                    stderrPresent: true,
                }),
            }));
            expect(failedExecBody.execution).not.toHaveProperty("args");
            expect(failedExecBody.execution).not.toHaveProperty("stderr");
            sshFailure = false;
            expect((await tool("device_exec", { command: "uname -a" })).status).toBe(200);
            const focus = await tool("device_focus_window", {handle:"42"});
            expect(focus.status, JSON.stringify(await focus.clone().json())).toBe(200);
            expect(await focus.json()).toMatchObject({result:{tool:"device_focus_window",ok:true}});
            const windows = await tool("device_window_list", {});
            expect(windows.status, JSON.stringify(await windows.clone().json())).toBe(200);
            expect(await windows.json()).toMatchObject({result:{tool:"device_window_list",windows:[{handle:"42",title:"Guest Notes",processId:123}]}});
            sshFailure = true;
            const unavailableFocus = await tool("device_focus_window", {handle:"42"});
            expect(unavailableFocus.status).toBe(502);
            expect(await unavailableFocus.json()).toMatchObject({ok:false,tool:"device_focus_window"});
            const unavailableWindows = await tool("device_window_list", {});
            expect(unavailableWindows.status).toBe(502);
            expect(await unavailableWindows.json()).toMatchObject({ok:false,tool:"device_window_list"});
            sshFailure = false;
            const beforeGuiType = commandRunner.mock.calls.length;
            const guiType = await tool("device_type", { text: "touch /tmp/ccc-gui-input" });
            expect(guiType.status, JSON.stringify(await guiType.clone().json())).toBe(200);
            expect(await guiType.json()).toMatchObject({ result: { tool: "device_type", provider: "hyper-v-ssh-x11", applied: true } });
            const guiTypeCalls = commandRunner.mock.calls.slice(beforeGuiType).map(([command]) => command);
            const guiTypeSsh = guiTypeCalls.find((command) => command.provider === "hyper-v-ssh" &&
                command.args?.at(-1)?.includes("base64 -d | bash"));
            expect(guiTypeSsh).toBeTruthy();
            const guiTypeEnvelope = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash/.exec(guiTypeSsh?.args?.at(-1) || "");
            const guiTypeScript = Buffer.from(guiTypeEnvelope?.[1] || "", "base64").toString("utf8");
            expect(guiTypeScript).toContain("xdotool type --clearmodifiers --delay 10 --file -");
            expect(guiTypeScript).not.toContain("touch /tmp/ccc-gui-input");
            expect(guiTypeCalls.some((command) => hyperVWindowsOperationRequest(command)?.operation === "Send-VMConsoleInput")).toBe(false);
            expect((await tool("device_screenshot", {})).status).toBe(200);
            const beforeGuiScroll = commandRunner.mock.calls.length;
            const guiScroll = await tool("device_scroll", { x: 320, y: 240, direction: "up", amount: 3 });
            expect(guiScroll.status, JSON.stringify(await guiScroll.clone().json())).toBe(200);
            expect(await guiScroll.json()).toMatchObject({ result: { tool: "device_scroll", provider: "hyper-v-ssh-x11", applied: true } });
            // The pointer still moves through the console; only the wheel goes through X11.
            expect(consoleInputs.at(-1)).toMatchObject({ action: "cursor", x: 320, y: 240 });
            expect(consoleInputs.some((input) => (input as { action?: string }).action === "scroll")).toBe(false);
            const guiScrollSsh = commandRunner.mock.calls.slice(beforeGuiScroll).map(([command]) => command)
                .find((command) => command.provider === "hyper-v-ssh" && command.args?.at(-1)?.includes("base64 -d | bash"));
            const guiScrollEnvelope = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash/.exec(guiScrollSsh?.args?.at(-1) || "");
            expect(Buffer.from(guiScrollEnvelope?.[1] || "", "base64").toString("utf8")).toContain("xdotool click --repeat 3 --delay 40 4");
            sshFailure = true;
            const failedScroll = await tool("device_scroll", { x: 320, y: 240, direction: "down", amount: 1 });
            expect(failedScroll.status).toBe(502);
            expect(await failedScroll.json()).toEqual(expect.objectContaining({ tool: "device_scroll", error: "hyper-v-linux-guest-provider-failed" }));
            sshFailure = false;
            const rebooted = await invoke({ backend: "linux-vm", command: "device_reboot", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(rebooted.status, JSON.stringify(await rebooted.clone().json())).toBe(200);
            expect(await rebooted.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "running", bootReady: true }), boot: expect.objectContaining({ provider: "hyper-v-ssh", ready: true }) }) }));
            expect(guiProvisionCalls).toBe(1);
            expect(rebootForces.at(-1)).toBe(false);
            expect(bootstrapNetworkCleanups).toBe(2);
            const bootstrapCalls = commandRunner.mock.calls.map(([command]) => ({
                operation: hyperVWindowsOperationRequest(command)?.operation,
                script: providerScript(command),
            }));
            expect(bootstrapCalls.some(({ operation }) => operation === "Get-VMNetworkAdapter")).toBe(true);
            expect(bootstrapCalls.some(({ operation }) => operation === "Remove-VMNetworkAdapter")).toBe(true);
            expect(bootstrapCalls.some(({ script }) => script.includes("Get-CccLinuxBootstrapNetworkResult $Vm")
                || script.includes("Remove-VMNetworkAdapter -VMNetworkAdapter $BootstrapAdapters[0]"))).toBe(false);
            expect(commandRunner.mock.calls.filter(([command]) => ["Get-VMNetworkAdapter", "Get-NetNeighbor", "Remove-VMNetworkAdapter"]
                .includes(hyperVWindowsOperationRequest(command)?.operation || ""))
                .every(([command]) => command.executable === "/fake/powershell.exe")).toBe(true);
            const forcedReboot = await invoke({ backend: "linux-vm", command: "device_reboot", deviceId, incarnationId: activeIncarnationId, force: true, waitForBoot: true });
            expect(forcedReboot.status, JSON.stringify(await forcedReboot.clone().json())).toBe(200);
            expect(rebootForces.at(-1)).toBe(true);
            const transferRoot = join(privateRoot, "transfers");
            scpFailure = "upload";
            const failedUpload = await tool("device_upload", { localPath: uploadPath, remotePath: "/tmp/upload.txt" });
            expect(failedUpload.status).toBe(502);
            expect(await failedUpload.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-guest-provider-failed" }));
            expect(readdirSync(transferRoot)).toEqual([]);
            scpFailure = null;
            expect((await tool("device_upload", { localPath: uploadPath, remotePath: "/tmp/upload.txt" })).status).toBe(200);
            writeFileSync(downloadPath, "original-output");
            scpFailure = "download";
            const failedDownload = await tool("device_download", { remotePath: "/tmp/download.txt", localPath: downloadPath });
            expect(failedDownload.status).toBe(502);
            expect(await failedDownload.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-guest-provider-failed" }));
            expect(readFileSync(downloadPath, "utf8")).toBe("original-output");
            expect(readdirSync(transferRoot)).toEqual([]);
            scpFailure = null;
            expect((await tool("device_download", { remotePath: "/tmp/download.txt", localPath: downloadPath })).status).toBe(200);
            expect(readFileSync(downloadPath, "utf8")).toBe("output");
            invalidDownloadEncoding = true;
            writeFileSync(downloadPath, "retain-current-output");
            const invalidDownload = await tool("device_download", { remotePath: "/tmp/download.txt", localPath: downloadPath });
            expect(invalidDownload.status).toBe(502);
            expect(await invalidDownload.json()).toMatchObject({ ok: false, error: "hyper-v-linux-guest-download-invalid-artifact" });
            expect(readFileSync(downloadPath, "utf8")).toBe("retain-current-output");
            expect(readdirSync(transferRoot)).toEqual([]);
            invalidDownloadEncoding = false;
            writeFileSync(downloadPath, "preserve-existing-output");
            const oversizedDownload = await tool("device_download", { remotePath: "/tmp/download.txt", localPath: downloadPath, maxFileBytes: 4 });
            expect(oversizedDownload.status).toBe(413);
            expect(await oversizedDownload.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-guest-download-source-too-large" }));
            expect(readFileSync(downloadPath, "utf8")).toBe("preserve-existing-output");
            expect(readdirSync(transferRoot)).toEqual([]);
            const externalDownloadRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-linux-external-"));
            const linkedDownloadRoot = join(cwd, "linked-download");
            directorySymlink(externalDownloadRoot, linkedDownloadRoot);
            const rejectedDownload = await tool("device_download", {
                remotePath: "/tmp/rejected.txt",
                localPath: join(linkedDownloadRoot, "escaped.txt"),
            });
            expect(rejectedDownload.status).toBe(400);
            expect(await rejectedDownload.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-guest-transfer-path-invalid" }));
            expect(existsSync(join(externalDownloadRoot, "escaped.txt"))).toBe(false);
            rmSync(linkedDownloadRoot, { force: true });
            rmSync(externalDownloadRoot, { recursive: true, force: true });
            const scpCalls = commandRunner.mock.calls.map(([command]) => command).filter((command) => command.provider === "hyper-v-scp");
            expect(scpCalls).toHaveLength(2);
            expect(scpCalls.every((command) => !(command.args || []).includes(uploadPath) && !(command.args || []).includes(downloadPath))).toBe(true);
            expect(scpCalls.every((command) => (command.args || []).some((argument) => argument.includes(join(privateRoot, "transfers"))))).toBe(true);

            const ownerDevicesPath = join(backendRoot(ownerId, "linux-vm"), "devices.json");
            const stopJournalPath = join(deviceRoot, "operation.json");
            const beforeForeignStop = readFileSync(ownerDevicesPath, "utf8");
            foreignVmObservation = true;
            const foreignStop = await invoke({ backend: "linux-vm", command: "device_stop", deviceId, incarnationId: activeIncarnationId });
            expect(foreignStop.status).toBe(502);
            expect(await foreignStop.json()).toMatchObject({ ok: false, error: "provider-command-failed", detail: "hyper-v-vm-ownership-mismatch" });
            expect(vmState).toBe("Running");
            expect(readFileSync(ownerDevicesPath, "utf8")).toBe(beforeForeignStop);
            expect(existsSync(diskPath)).toBe(true);
            expect(JSON.parse(readFileSync(stopJournalPath, "utf8"))).toMatchObject({ command: "device_stop", deviceId, incarnationId: activeIncarnationId });
            foreignVmObservation = false;
            // Each fault below starts an ordinary stop, independently of retained replay state.
            rmSync(stopJournalPath, { force: true });
            const realNow = Date.now;
            let stopClockOffset = 0;
            const stopClock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + stopClockOffset);
            afterNativeStop = () => { stopClockOffset = DEVICE_BROKER_HYPER_V_LIFECYCLE_TIMEOUT_MS + 1; };
            try {
                const expiredStop = await invoke({ backend: "linux-vm", command: "device_stop", deviceId, incarnationId: activeIncarnationId });
                expect(expiredStop.status).toBe(504);
                expect(await expiredStop.json()).toMatchObject({ ok: false, error: "hyper-v-operation-deadline-exceeded" });
                expect(vmState).toBe("Off");
                expect(readFileSync(ownerDevicesPath, "utf8")).toBe(beforeForeignStop);
                expect(existsSync(diskPath)).toBe(true);
                expect(JSON.parse(readFileSync(stopJournalPath, "utf8"))).toMatchObject({ command: "device_stop", deviceId, incarnationId: activeIncarnationId });
            } finally {
                afterNativeStop = null;
                stopClock.mockRestore();
            }
            rmSync(stopJournalPath, { force: true });
            let successorBytes: string | null = null;
            duringVmObservation = () => {
                duringVmObservation = null;
                const state = JSON.parse(readFileSync(ownerDevicesPath, "utf8")) as { devices: Array<Record<string, unknown>> };
                state.devices = state.devices.map(device => device.id === deviceId ? { ...device, incarnationId: "f".repeat(32), name: "successor" } : device);
                successorBytes = JSON.stringify(state);
                writeFileSync(ownerDevicesPath, successorBytes);
            };
            try {
                const supersededStop = await invoke({ backend: "linux-vm", command: "device_stop", deviceId, incarnationId: activeIncarnationId });
                expect(supersededStop.status).toBe(409);
                expect(await supersededStop.json()).toMatchObject({ ok: false, error: "owner-device-state-conflict" });
                expect(successorBytes).not.toBeNull();
                expect(readFileSync(ownerDevicesPath, "utf8")).toBe(successorBytes);
                expect(vmState).toBe("Off");
                expect(existsSync(diskPath)).toBe(true);
            } finally {
                duringVmObservation = null;
                // Reset this allocated fixture definition for the independent snapshot cases below.
                writeFileSync(ownerDevicesPath, beforeForeignStop);
                rmSync(stopJournalPath, { force: true });
            }
            expect((await invoke({ backend: "linux-vm", command: "device_stop", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            const callsBeforeSnapshotCreate = commandRunner.mock.calls.length;
            const createdSnapshotResponse = await tool("device_snapshot_create", { snapshotName: "baseline" });
            expect(createdSnapshotResponse.status).toBe(200);
            const snapshotCreateCalls = commandRunner.mock.calls.slice(callsBeforeSnapshotCreate) as unknown as Array<[
                { input?: string }, { timeoutMs?: number },
            ]>;
            const checkpointIndex = snapshotCreateCalls.findIndex(([command]) =>
                hyperVWindowsOperationRequest(command)?.operation === "Checkpoint-VM");
            expect(checkpointIndex).toBeGreaterThanOrEqual(0);
            const confirmationCall = snapshotCreateCalls.slice(checkpointIndex + 1).find(([command]) =>
                hyperVWindowsOperationRequest(command)?.operation === "Get-VMSnapshot");
            expect(confirmationCall).toBeDefined();
            expect(confirmationCall?.[1].timeoutMs).toBeGreaterThan(0);
            expect(confirmationCall?.[1].timeoutMs).toBeLessThanOrEqual(10000);
            const createdSnapshotId = (await createdSnapshotResponse.json()).result.snapshot.id as string;
            const snapshotJournalPath = join(deviceRoot, "snapshot-operation.json");
            const devicesFile = join(backendRoot(ownerId, "linux-vm"), "devices.json");
            const readSnapshotDevice = () => (JSON.parse(readFileSync(devicesFile, "utf8")) as { devices: Array<Record<string, unknown>> })
                .devices.find(device => device.id === deviceId);
            const expectedSnapshot = { id: createdSnapshotId, name: "baseline", providerName: `ccc-${ownerId}-baseline` };
            expect(createdSnapshotId).toBe(snapshotId);
            expect(existsSync(snapshotJournalPath)).toBe(false);

            const beforeSnapshotList = readSnapshotDevice();
            const listedSnapshotResponse = await tool("device_snapshot_list");
            expect(listedSnapshotResponse.status, JSON.stringify(await listedSnapshotResponse.clone().json())).toBe(200);
            expect(await listedSnapshotResponse.json()).toMatchObject({ ok: true, result: {
                ownerId, backend: "linux-vm", deviceId, tool: "device_snapshot_list",
                snapshots: [expectedSnapshot], startsDevices: false,
            } });
            expect(readSnapshotDevice()).toEqual(beforeSnapshotList);
            expect(readSnapshotDevice()).toMatchObject({ vmId, vmName, incarnationId: activeIncarnationId, snapshots: [expectedSnapshot] });
            expect(existsSync(snapshotJournalPath)).toBe(false);

            const callsBeforeSnapshotRestore = commandRunner.mock.calls.length;
            const restoredSnapshotResponse = await tool("device_snapshot_restore", { snapshotId: createdSnapshotId, confirmDestructive: true });
            expect(restoredSnapshotResponse.status, JSON.stringify(await restoredSnapshotResponse.clone().json())).toBe(200);
            expect(await restoredSnapshotResponse.json()).toMatchObject({ ok: true, result: {
                ownerId, backend: "linux-vm", deviceId, tool: "device_snapshot_restore", snapshot: expectedSnapshot,
                device: { vmId, vmName, incarnationId: activeIncarnationId, activeSnapshotId: createdSnapshotId,
                    status: "running", runtimeState: "Running", bootReady: true, snapshots: [expectedSnapshot] },
            } });
            const restoreCommands = commandRunner.mock.calls.slice(callsBeforeSnapshotRestore).map(([command]) => command);
            const restoredCheckpoint = restoreCommands.map(command => hyperVWindowsOperationRequest(command))
                .find(request => request?.operation === "Restore-VMSnapshot");
            expect(restoredCheckpoint).toMatchObject({ operation: "Restore-VMSnapshot", selector: { kind: "id", id: vmId },
                snapshot: { kind: "id", id: createdSnapshotId } });
            expect(restoreCommands.map(command => hyperVWindowsOperationRequest(command))).toContainEqual(
                expect.objectContaining({ operation: "Start-VM", selector: { kind: "id", id: vmId } }));
            expect(restoreCommands.some(command => command.provider === "hyper-v-ssh"
                && command.args?.at(-1)?.includes("ccc-hyper-v-linux-ready"))).toBe(true);
            expect(readSnapshotDevice()).toMatchObject({ vmId, vmName, incarnationId: activeIncarnationId,
                activeSnapshotId: createdSnapshotId, status: "running", runtimeState: "Running", bootReady: true,
                snapshots: [expectedSnapshot] });
            expect(vmState).toBe("Running");
            expect(existsSync(snapshotJournalPath)).toBe(false);
            // The following recovery/start scenarios begin with the VM stopped.
            expect((await invoke({ backend: "linux-vm", command: "device_stop", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            const stagedCreateJournal = {
                version: 1, operationId: vmId, ownerId, deviceId, incarnationId: activeIncarnationId,
                tool: "device_snapshot_create", snapshotName: "baseline",
                providerName: `ccc-${ownerId}-baseline`, confirmationRequired: true,
                startedAt: new Date().toISOString(),
            };
            writeFileSync(snapshotJournalPath, JSON.stringify({ ...stagedCreateJournal, snapshotId: "99999999-8888-7777-6666-555555555555" }));
            const wrongIdRepair = await invoke({ backend: "linux-vm", command: "device_status", deviceId, incarnationId: activeIncarnationId });
            expect(wrongIdRepair.status).toBe(409);
            expect(await wrongIdRepair.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-create-outcome-indeterminate" }));
            expect(existsSync(snapshotJournalPath)).toBe(true);
            writeFileSync(snapshotJournalPath, JSON.stringify(stagedCreateJournal));
            const unknownIdRepair = await invoke({ backend: "linux-vm", command: "device_status", deviceId, incarnationId: activeIncarnationId });
            expect(unknownIdRepair.status).toBe(409);
            expect(await unknownIdRepair.json()).toEqual(expect.objectContaining({ error: "hyper-v-snapshot-create-outcome-indeterminate" }));
            expect(existsSync(snapshotJournalPath)).toBe(true);
            writeFileSync(snapshotJournalPath, JSON.stringify({ ...stagedCreateJournal, snapshotId: createdSnapshotId }));
            expect((await invoke({ backend: "linux-vm", command: "device_status", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            expect(existsSync(snapshotJournalPath)).toBe(false);
            writeFileSync(snapshotJournalPath, JSON.stringify({
                version: 1, operationId: vmId, ownerId, deviceId, incarnationId: activeIncarnationId,
                tool: "device_snapshot_create", snapshotName: "baseline",
                providerName: `ccc-${ownerId}-baseline`, startedAt: new Date().toISOString(),
            }));
            const callsBeforeRepair = commandRunner.mock.calls.length;
            expect((await invoke({ backend: "linux-vm", command: "device_status", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            expect(existsSync(snapshotJournalPath)).toBe(false);
            const repairCalls = commandRunner.mock.calls.slice(callsBeforeRepair)
                .map(([command]) => hyperVWindowsOperationRequest(command))
                .filter((request) => request?.operation === "Repair-VMSnapshotState");
            expect(repairCalls).toHaveLength(1);
            expect(repairCalls[0]).toEqual(expect.objectContaining({ expectedCheckpointPolicy: "Production" }));
            expect((await tool("device_snapshot_delete", { snapshotName: "baseline", confirmDestructive: true })).status).toBe(200);
            guiReady = false;
            guiFailure = true;
            const guiFailedStart = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(guiFailedStart.status).toBe(502);
            const guiFailurePayload = await guiFailedStart.json();
            expect(guiFailurePayload, JSON.stringify(guiFailurePayload)).toEqual(expect.objectContaining({
                detail: "hyper-v-linux-gui-apt-install-failed",
                result: expect.objectContaining({
                    device: expect.objectContaining({ bootReady: false }),
                    boot: expect.objectContaining({ ready: false, error: "hyper-v-linux-gui-apt-install-failed" }),
                }),
            }));
            expect((await invoke({ backend: "linux-vm", command: "device_delete", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            expect(elevatedNetworkCleanups).toBe(1);
            expect(existsSync(deviceRoot)).toBe(false);
            expect(existsSync(privateRoot)).toBe(false);

            rmSync(ownerImageProfileRoot, { recursive: true, force: true });
            mkdirSync(imageProfileRoot, { recursive: true });
            writeFileSync(imagePath, "bad-vhdxx");
            const unmanaged = await invoke({ backend: "linux-vm", command: "device_create", deviceId, name: "Ubuntu Hyper-V rebuilt", memoryMb: 2048, cpus: 2 });
            expect(unmanaged.status).toBe(409);
            expect(await unmanaged.json()).toEqual(expect.objectContaining({ error: "hyper-v-base-image-profile-conflict", detail: "hyper-v-base-image-unmanaged-existing" }));
            expect(readFileSync(imagePath, "utf8")).toBe("bad-vhdxx");
            rmSync(imagePath, { force: true });
            const recreated = await invoke({ backend: "linux-vm", command: "device_create", deviceId, name: "Ubuntu Hyper-V rebuilt", memoryMb: 2048, cpus: 2 });
            expect(recreated.status, JSON.stringify(await recreated.clone().json())).toBe(200);
            expect(elevatedNetworkSetups).toBe(2);
            activeIncarnationId = (await recreated.clone().json()).result.device.incarnationId as string;
            expect(commandRunner.mock.calls.filter(([command]) => {
                const script = providerScript(command);
                return script.includes("function Save-BoundedDownload");
            })).toHaveLength(1);
            expect((await invoke({ backend: "linux-vm", command: "device_delete", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            expect(elevatedNetworkCleanups).toBe(2);
            expect(existsSync(privateRoot)).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    }, 120000);
});
