import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    compareHyperVLinuxEd25519HostKeyFingerprint,
    createDeviceBrokerServer,
    DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS,
    DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS,
    DEVICE_BROKER_HYPER_V_GUEST_SIGNAL_TIMEOUT_MS,
    hyperVLifecycleCleanupTimeoutMs,
    hyperVLinuxGuestSignalDeadlineAt,
    hyperVLinuxGuestSignalTimedOut,
    hyperVLinuxGuestReadyTraceFailureCode,
    hyperVProviderDeadlineAt,
} from "../device-lab-broker.js";
import { deviceLabOwnerId } from "../device-lab-owner.js";
import { HYPER_V_IMAGE_CATALOG } from "../device-lab/hyper-v-images.js";
import { backendRoot, cleanupOwner, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

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

    it("reserves containment time for Linux start and reboot deadlines", () => {
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
        expect(hyperVProviderDeadlineAt("windows-vm", "device_start", cleanupDeadlineAt))
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
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-hyper-v-linux-test-home-"));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
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

    it("reconciles a stable singleton network intent after an indeterminate provider failure", async () => {
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
                detail: "hyper-v-network-pipe-handshake-timeout",
                execution: expect.objectContaining({
                    provider: "hyper-v",
                    status: 1,
                    timedOut: true,
                    stdoutPresent: true,
                    stderrPresent: true,
                    outputRedacted: true,
                    diagnosticCode: "hyper-v-network-pipe-handshake-timeout",
                    inputConfigured: true,
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
                natName: "CCCDeviceLab",
                marker: "ccc-device-lab:hyper-v-network:v1",
                token: expect.stringMatching(/^[a-f0-9]{24}$/),
            }));
            const second = await invoke();
            expect(second.status).toBe(502);
            const secondBody = await second.json();
            expect(secondBody).toEqual(expect.objectContaining({ error: "provider-command-failed", detail: "hyper-v-provider-command-failed" }));
            expect(secondBody.result.execution).not.toHaveProperty("command");
            expect(JSON.stringify(secondBody)).not.toContain('"privateRoot"');
            expect(JSON.stringify(secondBody)).not.toContain("-EncodedCommand");
            expect(networkScripts).toHaveLength(2);
            expect(powerShellString(networkScripts[1], "NatName")).toBe(powerShellString(networkScripts[0], "NatName"));
            expect(powerShellString(networkScripts[1], "Marker")).toBe(powerShellString(networkScripts[0], "Marker"));
            expect(networkScripts[1]).toContain("$AllowExistingNat = $false");
            expect(networkScripts[1]).toContain("$AllowExistingNat -or $ExistingSwitchOwned");
            expect(existsSync(intentPath)).toBe(false);
            const reconciledState = JSON.parse(readFileSync(
                join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json"),
                "utf8",
            ));
            expect(reconciledState).toMatchObject({
                marker: "ccc-device-lab:hyper-v-network:v1",
                natName: "CCCDeviceLab",
                managedNat: false,
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
            expect(cleanupCalls).toBe(1);
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
            expect(networkReached).toBe(true);
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
            expect(commandRunner.mock.calls.some(([command]) => providerScript(command).includes("$CreatedVm = New-VM"))).toBe(true);
            expect(recoveryCalls).toBe(1);
            expect(existsSync(join(process.env.HOME!, ".ccc", "devices", "owners", ownerId, "linux-vm", "deadline-e2e"))).toBe(false);
            const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
            expect(existsSync(networkStatePath)).toBe(false);
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
            expect(recoveryCalls).toBe(1);
            const networkStatePath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json");
            expect(existsSync(networkStatePath)).toBe(false);
        } finally {
            nowSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it.each([
        ["linux-vm", "ubuntu-lts", "$SeedDisk ="],
        ["windows-vm", "windows-11", "hyper-v-guest-provision-requires-stopped-vm"],
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
            expect(recoveryCalls).toBe(1);
            expect(existsSync(join(process.env.HOME!, ".ccc", "devices", "owners", ownerId, backend, deviceId))).toBe(false);
        } finally {
            nowSpy.mockRestore();
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("removes incomplete automatic image artifacts when acquisition exceeds the operation deadline", async () => {
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
                writeFileSync(join(profileRoot, "base.vhdx"), "uncommitted-base");
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
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });

    it("removes an uncommitted image when the deadline expires during Node-side hashing", async () => {
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
                writeFileSync(imagePath, imageContents);
                hashing = true;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, profile: "ubuntu-lts", imagePath, sha256: createHash("sha256").update(imageContents).digest("hex"), sizeBytes: imageContents.length, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, reused: false }), stderr: "" };
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
            expect(existsSync(imagePath)).toBe(false);
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
    ])("removes automatic image artifacts after $name", async ({ observation, detail }) => {
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
                writeFileSync(imagePath, imageContents);
                return { ...command, status: 0, stdout: observation(imagePath, imageContents), stderr: "" };
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
            expect(existsSync(imagePath)).toBe(false);
            expect(existsSync(join(profileRoot, "manifest.json"))).toBe(false);
            expect(existsSync(join(profileRoot, ".acquire-work"))).toBe(false);
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
                writeFileSync(imagePath, imageContents);
                return {
                    ...command,
                    status: 0,
                    stdout: JSON.stringify({
                        ok: true,
                        profile: "ubuntu-lts",
                        imagePath,
                        sha256: "a".repeat(64),
                        sizeBytes: Buffer.byteLength(imageContents),
                        virtualSizeBytes: 32 * 1024 * 1024 * 1024,
                        vhdType: "Dynamic",
                        generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                        reused: false,
                    }),
                    stderr: "",
                };
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
            expect(existsSync(imagePath)).toBe(false);
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
        const imageContents = "prepared-image-bytes";
        writeFileSync(sourceImagePath, "source-image-bytes");
        const nestedSourceImagePath = join(cwd, "nested", "ubuntu-source.vhdx");
        mkdirSync(dirname(nestedSourceImagePath), { recursive: true });
        writeFileSync(nestedSourceImagePath, "nested-source-image-bytes");
        const commandRunner = vi.fn((command: { args?: string[] }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("hyper-v-base-image-profile-conflict")) {
                mkdirSync(imageProfileRoot, { recursive: true });
                writeFileSync(imagePath, imageContents);
                return {
                    ...command,
                    status: 0,
                    stdout: JSON.stringify({
                        ok: true,
                        profile: "ubuntu-lts",
                        imagePath,
                        sha256: "b".repeat(64),
                        sizeBytes: Buffer.byteLength(imageContents),
                        virtualSizeBytes: 32 * 1024 * 1024 * 1024,
                        vhdType: "Dynamic",
                        generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation,
                        reused: false,
                    }),
                    stderr: "",
                };
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

    it("recovers an owner-marked Linux VM when seed provisioning fails before the seed disk is attached", async () => {
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
                writeFileSync(imagePath, imageBytes);
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, profile: "ubuntu-lts", imagePath, sha256: imageSha256, sizeBytes: imageBytes.length, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, reused: false }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            if (script.includes("Write-CccIso $IsoFiles $SeedDisk 'cidata'")) {
                return { ...command, status: 1, stdout: seedSecretEcho, stderr: `hyper-v-provisioning-media-copy-incomplete: ${seedSecretEcho}` };
            }
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId, vmName, generation: HYPER_V_IMAGE_CATALOG["ubuntu-lts"].generation, state: "Off", status: "Operating normally", diskPath, switchName: "CCC Device Lab" }), stderr: "" };
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
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-linux-seed-failed", rollback: expect.objectContaining({ ok: true }) }));
            expect(JSON.stringify(body)).not.toContain(seedSecretEcho);
            expect(JSON.stringify(body)).not.toContain(rollbackSecretEcho);
            expect(body.provisioning).toEqual(expect.objectContaining({
                stdoutPresent: true,
                stderrPresent: true,
                outputRedacted: true,
                diagnosticCode: "hyper-v-provisioning-media-copy-incomplete",
            }));
            expect(recoveryCalls).toBe(1);
            const recoveryScripts = commandRunner.mock.calls.map(([command]) => providerScript(command)).filter((script) => script.includes("hyper-v-orphan-vm-ownership-mismatch"));
            expect(recoveryScripts.at(-1)).toContain("$ExpectedPaths -notcontains $_");
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
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-linux-seed-failed", rollback: expect.objectContaining({ ok: false, reason: "hyper-v-rollback-invalid-result" }) }));
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
            expect(body).toEqual(expect.objectContaining({ error: "hyper-v-recovery-cleanup-failed", detail: expect.stringContaining("hyper-v-network-allocation-incarnation-conflict") }));
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

    it("reports failed provider compensation when the initial network state cannot be committed", async () => {
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
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, platform: "win32", providerPaths: { "powershell.exe": "/fake/powershell.exe" }, commandRunner });
        try {
            const baseUrl = await listen(server);
            const response = await fetch(ownerRpcEndpoint(baseUrl, ownerId), {
                method: "POST",
                headers: ownerRpcHeaders(ownerId),
                body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "linux-vm", command: "device_create", deviceId, name: "Network commit failure", profile: "ubuntu-lts" } }),
            });
            const body = await response.json();
            expect(response.status, JSON.stringify(body)).toBe(502);
            expect(JSON.stringify(body)).toContain("hyper-v-network-allocation-cleanup-failed");
            expect(body).toEqual(expect.objectContaining({
                detail: "hyper-v-network-cleanup-failed",
            }));
            expect(JSON.stringify(body)).not.toContain("simulated compensation failure");
            expect(JSON.stringify(body)).not.toContain(profileRoot);
            expect(cleanupCalls).toBe(1);
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
        const uploadPath = join(cwd, "upload.txt");
        const downloadPath = join(cwd, "download.txt");
        const imageSha256 = createHash("sha256").update("fake-vhdx").digest("hex");
        const expectedNetworkAddress = `172.29.0.${10 + (createHash("sha256").update(`${ownerId}\0${deviceId}\0address`).digest().readUInt32BE(0) % 241)}`;
        writeFileSync(uploadPath, "upload");
        let vmState = "Off";
        let bootDiagnosticState: string | null = null;
        let bootDiagnosticFailure: "command" | "invalid" | "identity" | null = null;
        let snapshotExists = false;
        let sshFailure = false;
        let readinessFailure = false;
        let managedReadinessFailure = false;
        let bootstrapAddressAvailable = false;
        let bootstrapAddresses = ["172.20.1.8"];
        let bootstrapSshFailure = false;
        let bootstrapHostKeyRejectionsRemaining = 0;
        let bootstrapHostKeyRejectedPersistently = false;
        let bootstrapObservedHostKey = ed25519PublicKeyBlob(7);
        let bootstrapSshMarkerMissing = false;
        let networkFinalizeFailure = false;
        let managedReadinessRemainsFailedAfterFinalize = false;
        let bootstrapNetworkFinalizations = 0;
        let scpFailure: "upload" | "download" | null = null;
        let pendingElevatedNetwork: "setup" | "cleanup" | null = null;
        let standardNetworkCommand: { args?: string[]; input?: string } | null = null;
        let elevatedNetworkSetups = 0;
        let elevatedNetworkCleanups = 0;
        let bootstrapNetworkCleanups = 0;
        let bootstrapCleanupFailure = false;
        let providerLifecycleFailure = false;
        const rebootScripts: string[] = [];

        const commandRunner = vi.fn((command: { mode: string; provider: string; executable?: string; args?: string[] }) => {
            if (command.provider === "hyper-v-ssh") {
                const ready = command.args?.at(-1)?.includes("ccc-hyper-v-linux-ready");
                const target = command.args?.at(-2) || "";
                expect(command.args).not.toContain("StrictHostKeyChecking=accept-new");
                const encodedCommand = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash/.exec(command.args?.at(-1) || "")?.[1];
                const guestCommand = encodedCommand ? Buffer.from(encodedCommand, "base64").toString("utf8") : "";
                const download = guestCommand.includes("head -c") && guestCommand.includes("base64 -w0");
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
                return { ...command, status: 0, stdout: ready ? "ccc-hyper-v-linux-ready\n" : download ? Buffer.from("output").toString("base64") : "linux-exec-ok\n", stderr: "" };
            }
            if (command.provider === "hyper-v-scp") {
                const destination = command.args?.at(-1) || "";
                const download = !destination.includes(":");
                if (download) writeFileSync(destination, scpFailure === "download" ? "partial-output" : "output");
                if (scpFailure === (download ? "download" : "upload")) return { ...command, status: 1, stdout: "", stderr: "scp failed" };
                return { ...command, status: 0, stdout: "", stderr: "" };
            }
            const script = providerScript(command);
            if (script.includes("Get-CccLinuxBootstrapNetworkResult $Vm")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, addresses: bootstrapAddressAvailable ? bootstrapAddresses : [] }), stderr: "" };
            }
            if (script.includes("Remove-VMNetworkAdapter -VMNetworkAdapter $BootstrapAdapters[0]")) {
                bootstrapNetworkCleanups += 1;
                if (bootstrapCleanupFailure) return { ...command, status: 1, stdout: "", stderr: "cleanup failed" };
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, removed: bootstrapNetworkCleanups === 1, alreadyMissing: bootstrapNetworkCleanups > 1 }), stderr: "" };
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
            if (script.includes("New-VM @VmArgs")) vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
            const imagePrepare = script.includes("hyper-v-base-image-profile-conflict");
            const imageAcquire = script.includes("function Save-BoundedDownload");
            const imageSetup = imagePrepare || imageAcquire;
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
        let activeIncarnationId: string | undefined;
        const tool = (name: string, params: Record<string, unknown> = {}) => fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ method: "broker.device.tool.invoke", params: { tool: name, backend: "linux-vm", deviceId, ...(activeIncarnationId ? { incarnationId: activeIncarnationId } : {}), ...params } }) });
        try {
            const backends = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify({ method: "broker.backends" }) });
            expect(await backends.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ backends: expect.arrayContaining([expect.objectContaining({ name: "linux-vm", provider: "hyper-v", guestTransport: "ssh" })]) }) }));

            const created = await invoke({ backend: "linux-vm", command: "device_create", deviceId, name: "Ubuntu Hyper-V", memoryMb: 2048, cpus: 2 });
            expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
            expect(elevatedNetworkSetups).toBe(1);
            expect(commandRunner.mock.calls.some(([command]) => {
                const script = providerScript(command);
                return script.includes("function Save-BoundedDownload") && script.includes("$Profile = 'ubuntu-lts'");
            })).toBe(true);
            const createdBody = await created.json();
            activeIncarnationId = createdBody.result.device.incarnationId as string;
            const allocatedAddress = createdBody.result.device.networkAddress as string;
            const allocatedMac = createdBody.result.device.macAddress as string;
            expect(createdBody).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ backend: "linux-vm", platform: "linux", provider: "hyper-v", guestProvisioned: true, guestTransport: "ssh", sshHostKeyFingerprint: hostKeyFingerprint, networkAddress: expect.stringMatching(/^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/) }) }) }));
            expect(createdBody.result.device).not.toHaveProperty("seedDiskPath");
            expect(createdBody.result.device).not.toHaveProperty("sshHostPublicKeyPath");
            expect(createdBody.result.device).not.toHaveProperty("sshKnownHostsPath");
            const vmCreateScript = commandRunner.mock.calls
                .map(([command]) => providerScript(command))
                .find((script) => script.includes("New-VM @VmArgs"));
            expect(vmCreateScript).toContain("$BootstrapDhcp = $true");
            expect(vmCreateScript).toContain("Get-VMSwitch -Name 'Default Switch'");
            expect(vmCreateScript).toContain("Rename-VMNetworkAdapter -VMNetworkAdapter $BootstrapAdapters[0] -NewName 'CCC Bootstrap DHCP'");
            expect(vmCreateScript).toContain("Add-VMNetworkAdapter -VM $CreatedVm -SwitchName $ResolvedSwitch.Name -Name 'CCC Device Network'");
            const seedScript = commandRunner.mock.calls
                .map(([command]) => providerScript(command))
                .find((script) => script.includes("Write-CccIso $IsoFiles $SeedDisk 'cidata'"));
            expect(seedScript).toContain("$_.Name -eq 'CCC Bootstrap DHCP' -and $_.SwitchName -eq 'Default Switch'");
            expect(seedScript).toContain("'  bootstrap0:'");
            expect(seedScript).toContain("'    set-name: bootstrap0'");
            expect(seedScript).toContain("'    dhcp4: true'");
            expect(seedScript).not.toContain("'  ccc0:'");
            expect(seedScript).not.toContain(`macaddress: '${allocatedMac}'`);
            expect(seedScript).not.toContain("/etc/netplan/99-ccc-static.yaml");
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
            expect([
                "ssh-unavailable",
                "hyper-v-operation-deadline-exceeded",
                "hyper-v-bootstrap-address-unavailable",
            ]).toContain(readinessError);
            expect(readinessError).not.toBe("hyper-v-guest-boot-signal-timeout");
            expect(exhaustedBody).toEqual(expect.objectContaining({
                error: "hyper-v-guest-not-ready",
                result: expect.objectContaining({
                    boot: {
                        ready: false,
                        provider: "hyper-v-ssh",
                        error: readinessError,
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
            expect(exhaustedBody.result.boot.diagnostic).not.toHaveProperty("vmId");
            expect(exhaustedBody.result.boot.diagnostic).not.toHaveProperty("vmName");
            expect(exhaustedBody.result.device).toEqual(expect.objectContaining({ status: "stopped", runtimeState: "Off", bootReady: false }));
            expect(exhaustedBody.result.execution.command).toEqual(expect.objectContaining({
                guestReadiness: {
                    provider: "hyper-v-ssh",
                    error: readinessError,
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
            const bootstrapHostKeyClientFailure = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(bootstrapHostKeyClientFailure.status).toBe(502);
            const bootstrapHostKeyClientFailureBoot = (await bootstrapHostKeyClientFailure.json()).result.boot;
            expect(bootstrapHostKeyClientFailureBoot.error).toBe("ssh-host-key-rejected");
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
            const bootstrapMarkerMissing = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(bootstrapMarkerMissing.status, JSON.stringify(await bootstrapMarkerMissing.clone().json())).toBe(502);
            const bootstrapMarkerMissingBoot = (await bootstrapMarkerMissing.json()).result.boot;
            expect(bootstrapMarkerMissingBoot.error).toBe("ssh-readiness-marker-missing");
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

            bootstrapNetworkFinalizations = 0;
            bootstrapNetworkCleanups = 0;
            managedReadinessFailure = true;
            const started = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(started.status, JSON.stringify(await started.clone().json())).toBe(200);
            expect(await started.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "running", bootReady: true }), boot: expect.objectContaining({ provider: "hyper-v-ssh", ready: true }) }) }));
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
            const rebooted = await invoke({ backend: "linux-vm", command: "device_reboot", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(rebooted.status, JSON.stringify(await rebooted.clone().json())).toBe(200);
            expect(await rebooted.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "running", bootReady: true }), boot: expect.objectContaining({ provider: "hyper-v-ssh", ready: true }) }) }));
            expect(rebootScripts.at(-1)).toContain("$Force = $false");
            expect(bootstrapNetworkCleanups).toBe(2);
            const forcedReboot = await invoke({ backend: "linux-vm", command: "device_reboot", deviceId, incarnationId: activeIncarnationId, force: true, waitForBoot: true });
            expect(forcedReboot.status, JSON.stringify(await forcedReboot.clone().json())).toBe(200);
            expect(rebootScripts.at(-1)).toContain("$Force = $true");
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
            writeFileSync(downloadPath, "preserve-existing-output");
            const oversizedDownload = await tool("device_download", { remotePath: "/tmp/download.txt", localPath: downloadPath, maxFileBytes: 4 });
            expect(oversizedDownload.status).toBe(413);
            expect(await oversizedDownload.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-guest-download-source-too-large" }));
            expect(readFileSync(downloadPath, "utf8")).toBe("preserve-existing-output");
            expect(readdirSync(transferRoot)).toEqual([]);
            const externalDownloadRoot = mkdtempSync(join(tmpdir(), "ccc-hyper-v-linux-external-"));
            const linkedDownloadRoot = join(cwd, "linked-download");
            symlinkSync(externalDownloadRoot, linkedDownloadRoot, "dir");
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

            expect((await invoke({ backend: "linux-vm", command: "device_stop", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            expect((await tool("device_snapshot_create", { snapshotName: "baseline" })).status).toBe(200);
            expect((await tool("device_snapshot_delete", { snapshotName: "baseline", confirmDestructive: true })).status).toBe(200);
            expect((await invoke({ backend: "linux-vm", command: "device_delete", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            expect(elevatedNetworkCleanups).toBe(1);
            expect(existsSync(deviceRoot)).toBe(false);
            expect(existsSync(privateRoot)).toBe(false);

            writeFileSync(imagePath, "bad-vhdxx");
            const recreated = await invoke({ backend: "linux-vm", command: "device_create", deviceId, name: "Ubuntu Hyper-V rebuilt", memoryMb: 2048, cpus: 2 });
            expect(recreated.status, JSON.stringify(await recreated.clone().json())).toBe(200);
            expect(elevatedNetworkSetups).toBe(2);
            activeIncarnationId = (await recreated.clone().json()).result.device.incarnationId as string;
            expect(commandRunner.mock.calls.filter(([command]) => {
                const script = providerScript(command);
                return script.includes("function Save-BoundedDownload");
            })).toHaveLength(2);
            expect((await invoke({ backend: "linux-vm", command: "device_delete", deviceId, incarnationId: activeIncarnationId })).status).toBe(200);
            expect(elevatedNetworkCleanups).toBe(2);
            expect(existsSync(privateRoot)).toBe(false);
        } finally {
            await close(server);
            cleanupOwner(ownerId);
        }
    });
});
