import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeviceBrokerServer, DEVICE_BROKER_HYPER_V_CLEANUP_RESERVE_MS, DEVICE_BROKER_HYPER_V_CREATE_RPC_TIMEOUT_MS } from "../device-lab-broker.js";
import { deviceLabOwnerId } from "../device-lab-owner.js";
import { HYPER_V_IMAGE_CATALOG } from "../device-lab/hyper-v-images.js";
import { backendRoot, cleanupOwner, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "./helpers/host-broker-test-fixture.js";

function providerScript(command: { args?: string[]; input?: string }): string {
    if (command.args?.at(-1) === "-" && typeof command.input === "string") return command.input;
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
            expect(await repeated.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ idempotent: true }) }));
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

    it("reconciles a token-fenced network intent after an indeterminate provider failure", async () => {
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
            licenseId: null,
            generation: 2,
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
                if (networkScripts.length === 1) return { ...command, status: null, stdout: "", stderr: "", error: "simulated timeout", timedOut: true };
                expect(script).toContain("$AllowExistingNat = $true");
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
            expect(await first.json()).toEqual(expect.objectContaining({ error: "hyper-v-network-setup-failed" }));
            const intentPath = join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v-intent.json");
            const intent = JSON.parse(readFileSync(intentPath, "utf8"));
            expect(intent).toEqual(expect.objectContaining({
                natName: expect.stringMatching(/^CCCDeviceLab-[a-f0-9]{24}$/),
                marker: expect.stringMatching(/^ccc-device-lab:hyper-v-network:[a-f0-9]{24}$/),
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
            expect(networkScripts[1]).toContain("$AllowExistingNat = $true");
            expect(existsSync(intentPath)).toBe(false);
            expect(existsSync(join(process.env.HOME!, ".ccc", "device-broker-private", "network", "hyper-v.json"))).toBe(false);
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
            licenseId: null,
            generation: 2,
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
            licenseId: null,
            generation: 2,
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
            licenseId: catalog.licenseId,
            generation: 2,
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
            licenseId: null,
            generation: 2,
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
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", vmName, diskPath, switchName: "CCC Device Lab" }), stderr: "" };
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
            licenseId: null,
            generation: 2,
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
            licenseId: null,
            generation: 2,
            secureBootTemplate: profile === "ubuntu-lts" ? "MicrosoftUEFICertificateAuthority" : "MicrosoftWindows",
            preparationVersion: 1,
            imagePath,
            sha256: createHash("sha256").update(imageContents).digest("hex"),
            sizeBytes: Buffer.byteLength(imageContents),
            virtualSizeBytes: 64 * 1024 * 1024 * 1024,
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
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", vmName, diskPath, switchName: "CCC Device Lab" }), stderr: "" };
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
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, profile: "ubuntu-lts", imagePath: join(profileRoot, "base.vhdx"), sha256: "a".repeat(64), sizeBytes: 16, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", reused: false }), stderr: "" };
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
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, profile: "ubuntu-lts", imagePath, sha256: createHash("sha256").update(imageContents).digest("hex"), sizeBytes: imageContents.length, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", reused: false }), stderr: "" };
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
        let recoveryCalls = 0;
        const commandRunner = vi.fn((command: { args?: string[] }) => {
            const networkCleanup = hyperVNetworkCleanupResult(command);
            if (networkCleanup) return networkCleanup;
            const script = providerScript(command);
            if (script.includes("New-VM @VmArgs")) vmName = script.match(/\$VmName = '((?:''|[^'])*)'/)?.[1]?.replaceAll("''", "'") || "";
            if (script.includes("hyper-v-orphan-vm-ownership-mismatch")) {
                recoveryCalls += 1;
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, recoveredVm: recoveryCalls > 1, removedDisk: recoveryCalls > 1 }), stderr: "" };
            }
            if (script.includes("function Save-BoundedDownload")) {
                mkdirSync(imageProfileRoot, { recursive: true });
                writeFileSync(imagePath, imageBytes);
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, profile: "ubuntu-lts", imagePath, sha256: imageSha256, sizeBytes: imageBytes.length, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", reused: false }), stderr: "" };
            }
            if (script.includes("New-NetNat -Name $NatName")) {
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command)), stderr: "" };
            }
            if (script.includes("Write-CccIso $IsoFiles $SeedDisk 'cidata'")) {
                return { ...command, status: 1, stdout: seedSecretEcho, stderr: `hyper-v-provisioning-media-copy-incomplete: ${seedSecretEcho}` };
            }
            return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId, vmName, state: "Off", status: "Operating normally", diskPath, switchName: "CCC Device Lab" }), stderr: "" };
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
            expect(body.provisioning).toEqual(expect.objectContaining({
                stdout: "[redacted]",
                stderr: "[redacted]",
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
            licenseId: null,
            generation: 2,
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
            if (script.includes("New-NetNat -Name $NatName")) {
                return { ...command, status: 0, stdout: JSON.stringify(hyperVNetworkObservation(command, { createdSwitch: false, createdNat: false })), stderr: "" };
            }
            if (script.includes("New-VM @VmArgs")) {
                vmName = powerShellString(script, "VmName");
                const diskPath = powerShellString(script, "DiskPath");
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, vmId, vmName, state: "Off", status: "Operating normally", diskPath, switchName: "CCC Device Lab" }), stderr: "" };
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

    it("rejects a reused Hyper-V NAT whose observed instance identity changed", async () => {
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
            licenseId: null,
            generation: 2,
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
            allocations: [],
        }));
        const commandRunner = vi.fn((command: { args?: string[]; input?: string }) => {
            const script = providerScript(command);
            if (script.includes("Get-Service -Name vmms")) {
                return { ...command, status: 0, stdout: JSON.stringify({ ok: true, available: true, platform: "win32", moduleAvailable: true, hypervisorPresent: true, vmmsRunning: true, rebootPending: false, totalMemoryMb: 32768, freeMemoryMb: 16384, logicalProcessors: 8, missing: [] }), stderr: "" };
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
                allocations: [],
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
            licenseId: null,
            generation: 2,
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
            expect(JSON.stringify(body)).toContain("simulated compensation failure");
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
        const hostKeyBytes = Buffer.from("ccc-test-host-key");
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
        let snapshotExists = false;
        let sshFailure = false;
        let readinessFailure = false;
        let scpFailure: "upload" | "download" | null = null;
        let pendingElevatedNetwork: "setup" | "cleanup" | null = null;
        let standardNetworkCommand: { args?: string[]; input?: string } | null = null;
        let elevatedNetworkSetups = 0;
        let elevatedNetworkCleanups = 0;
        let bootstrapNetworkCleanups = 0;

        const commandRunner = vi.fn((command: { mode: string; provider: string; executable?: string; args?: string[] }) => {
            if (command.provider === "hyper-v-ssh") {
                const ready = command.args?.at(-1)?.includes("ccc-hyper-v-linux-ready");
                const encodedCommand = /printf %s ([A-Za-z0-9+/=]+) \| base64 -d \| bash/.exec(command.args?.at(-1) || "")?.[1];
                const guestCommand = encodedCommand ? Buffer.from(encodedCommand, "base64").toString("utf8") : "";
                const download = guestCommand.includes("head -c") && guestCommand.includes("base64 -w0");
                if (sshFailure || (ready && readinessFailure) || (download && scpFailure === "download")) {
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
            if (script.includes("Remove-VMNetworkAdapter -VMNetworkAdapter $BootstrapAdapters[0]")) {
                bootstrapNetworkCleanups += 1;
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
            const bootDiagnostic = script.includes("bootDeviceTypes = $BootDeviceTypes");
            const networkAddress = expectedNetworkAddress;
            const snapshot = script.includes("Checkpoint-VM") || script.includes("Restore-VMSnapshot") || script.includes("Remove-VMSnapshot");
            const deleting = script.includes("Remove-VM -VM $Vm");
            if (script.includes("Start-VM") || script.includes("Restart-VM")) vmState = "Running";
            if (script.includes("Stop-VM")) vmState = "Off";
            if (script.includes("Checkpoint-VM")) snapshotExists = true;
            if (script.includes("Remove-VMSnapshot")) snapshotExists = false;
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
                ? { ok: true, vmId, vmName, state: bootDiagnosticState || vmState, uptimeMs: 1000, heartbeatEnabled: true, heartbeatPrimaryStatus: 2, heartbeatSecondaryStatus: 0, hardDiskCount: 1, dvdCount: 1, bootDeviceTypes: ["hard-disk", "dvd"] }
                : imageSetup
                ? { ok: true, profile: "ubuntu-lts", imagePath, sha256: imageSha256, sizeBytes: 9, virtualSizeBytes: 32 * 1024 * 1024 * 1024, vhdType: "Dynamic", reused: false }
                : networkSetup
                    ? hyperVNetworkObservation(command)
                    : recovery
                        ? { ok: true, recoveredVm: false, removedDisk: false }
                        : seed
                            ? { ok: true, vmId, vmName, seedDiskPath, sshPrivateKeyPath: privateKeyPath, sshPublicKeyPath: publicKeyPath, sshHostPublicKeyPath: hostPublicKeyPath, sshHostKeyFingerprint: hostKeyFingerprint, knownHostsPath, guestUsername: `ccc${ownerId.slice(0, 8)}`, networkAddress }
                            : snapshot
                                ? { ok: true, snapshotId, snapshotName: `ccc-${ownerId}-baseline`, snapshotType: "Recovery", state: vmState, ...(script.includes("Remove-VMSnapshot") ? { deleted: true } : {}) }
                                : { ok: true, vmId, vmName, state: vmState, status: "Operating normally", diskPath, snapshots: snapshotExists ? [{ snapshotId, snapshotName: `ccc-${ownerId}-baseline`, snapshotType: "Recovery" }] : [], ...(deleting ? { deleted: true } : {}) };
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
            expect(createdBody).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ backend: "linux-vm", platform: "linux", provider: "hyper-v", guestProvisioned: true, guestTransport: "ssh", seedDiskPath, sshHostPublicKeyPath: hostPublicKeyPath, sshHostKeyFingerprint: hostKeyFingerprint, sshKnownHostsPath: knownHostsPath, networkAddress: expect.stringMatching(/^172\.29\.0\.(?:[1-9]\d?|1\d\d|2[0-4]\d|250)$/) }) }) }));
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
            const networkBase64 = seedScript?.match(/\$NetworkBase64 = '([^']+)'/)?.[1];
            expect(networkBase64).toBeTruthy();
            expect(Buffer.from(networkBase64!, "base64").toString("utf8")).toContain(`macaddress: '${allocatedMac}'`);
            expect(createdBody.result.device).not.toHaveProperty("privateRoot");
            expect(createdBody.result.device).not.toHaveProperty("sshPrivateKeyPath");
            expect(JSON.stringify(createdBody)).not.toContain('"sshPrivateKeyPath"');

            const repeatedCreate = await invoke({ backend: "linux-vm", command: "device_create", deviceId, name: "Ubuntu Hyper-V", memoryMb: 2048, cpus: 2 });
            expect(repeatedCreate.status, JSON.stringify(await repeatedCreate.clone().json())).toBe(200);
            const repeatedCreateBody = await repeatedCreate.json();
            expect(repeatedCreateBody).toEqual(expect.objectContaining({ result: expect.objectContaining({ idempotent: true, invoked: false }) }));
            expect(repeatedCreateBody.result.device).not.toHaveProperty("privateRoot");
            expect(repeatedCreateBody.result.device).not.toHaveProperty("sshPrivateKeyPath");
            expect(JSON.stringify(repeatedCreateBody)).not.toContain('"sshPrivateKeyPath"');

            writeFileSync(knownHostsPath, `${allocatedAddress} ssh-ed25519 ${Buffer.from("tampered-host-key").toString("base64")} attacker\n`);
            const sshCallsBeforeTamper = commandRunner.mock.calls.filter(([command]) => command.provider === "hyper-v-ssh").length;
            const tamperedIdentity = await tool("device_exec", { command: "uname -a" });
            expect(tamperedIdentity.status).toBe(409);
            expect(await tamperedIdentity.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-ssh-host-identity-invalid" }));
            expect(commandRunner.mock.calls.filter(([command]) => command.provider === "hyper-v-ssh")).toHaveLength(sshCallsBeforeTamper);
            writeFileSync(knownHostsPath, `${allocatedAddress} ssh-ed25519 ${hostKeyBase64} ccc-host\n`);

            readinessFailure = true;
            bootDiagnosticState = "OffCritical";
            const exhausted = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(exhausted.status).toBe(502);
            const exhaustedBody = await exhausted.json();
            expect(exhaustedBody).toEqual(expect.objectContaining({
                error: "hyper-v-guest-not-ready",
                result: expect.objectContaining({
                    boot: {
                        ready: false,
                        provider: "hyper-v-ssh",
                        error: "ssh-unavailable",
                        diagnosticAvailable: true,
                        diagnostic: expect.objectContaining({
                            state: "OffCritical",
                            hardDiskCount: 1,
                            bootDeviceTypes: ["hard-disk", "dvd"],
                        }),
                    },
                }),
            }));
            expect(exhaustedBody.result.boot.diagnostic).not.toHaveProperty("vmId");
            expect(exhaustedBody.result.boot.diagnostic).not.toHaveProperty("vmName");
            expect(exhaustedBody.result.device).toEqual(expect.objectContaining({ status: "stopped", runtimeState: "OffCritical", bootReady: false }));
            expect(exhaustedBody.result.execution.command).toEqual(expect.objectContaining({
                guestReadiness: {
                    provider: "hyper-v-ssh",
                    error: "ssh-unavailable",
                    diagnosticAvailable: true,
                },
            }));
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("args");
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("input");
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("stdout");
            expect(exhaustedBody.result.execution.command).not.toHaveProperty("stderr");
            expect(exhaustedBody.result.providerCommand).toEqual({ mode: "exec", provider: "hyper-v" });
            expect(exhaustedBody.detail).toBe("ssh-unavailable");
            readinessFailure = false;
            bootDiagnosticState = null;

            const started = await invoke({ backend: "linux-vm", command: "device_start", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(started.status, JSON.stringify(await started.clone().json())).toBe(200);
            expect(await started.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "running", bootReady: true }), boot: expect.objectContaining({ provider: "hyper-v-ssh", ready: true }) }) }));
            expect(bootstrapNetworkCleanups).toBe(1);

            sshFailure = true;
            const failedExec = await tool("device_exec", { command: "uname -a" });
            expect(failedExec.status).toBe(502);
            expect(await failedExec.json()).toEqual(expect.objectContaining({ error: "hyper-v-linux-guest-provider-failed" }));
            sshFailure = false;
            expect((await tool("device_exec", { command: "uname -a" })).status).toBe(200);
            const rebooted = await invoke({ backend: "linux-vm", command: "device_reboot", deviceId, incarnationId: activeIncarnationId, waitForBoot: true });
            expect(rebooted.status, JSON.stringify(await rebooted.clone().json())).toBe(200);
            expect(await rebooted.json()).toEqual(expect.objectContaining({ result: expect.objectContaining({ device: expect.objectContaining({ status: "running", bootReady: true }), boot: expect.objectContaining({ provider: "hyper-v-ssh", ready: true }) }) }));
            expect(bootstrapNetworkCleanups).toBe(2);
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
