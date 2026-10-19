import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupDeviceLabHyperVBootstrapNetwork, probeDeviceLabHyperVBootstrapNetwork } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/bootstrap-network-adapter.js";
import { hyperVRemainingTimeout } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/deadline.js";
import type { DeviceLabHyperVWindowsClientOptions } from "../../../packages/device-lab/src/device-lab/broker/hyper-v/lifecycle-adapter.js";
import type { HyperVWindowsExecutionRequest } from "@ccc/hyper-v/index.js";
import { createHyperVCreateStartApplication } from "../../../packages/device-lab/src/device-lab/application/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateStartPorts, VmCreationPorts } from "../../../packages/device-lab/src/device-lab/ports/lifecycle/hyper-v-create-start.js";
import type { HyperVCreateStartRequest, HyperVLinuxReadinessObservation, HyperVNativeExecution, VmCreationEffect, VmCreationRequest, VmObservation } from "../../../packages/device-lab/src/device-lab/domain/lifecycle/hyper-v-create-start.js";

type Receipt = { nativeEvidence: string; status?: number; stdout?: string };
type Connection = { providerId: string };
type Ports = HyperVCreateStartPorts<undefined, Connection, Receipt, { media: true }>;
const owner = "owner123";
const connection = { providerId: "powershell" };
const vmId = "12345678-1234-1234-1234-123456789abc";
const fingerprint = `SHA256:${"A".repeat(43)}`;
const evidence: HyperVNativeExecution<Receipt> = {
    required: true, dispatched: true, ok: true, receipt: Object.freeze({ nativeEvidence: "captured", status: 0, stdout: "native output cannot be parsed as JSON" }),
};

function createFixture(backend: "windows-vm" | "linux-vm" = "windows-vm") {
    const root = join("/owned", backend, "owned");
    const privateRoot = join("/private", backend, "owned");
    const diskPath = join(root, "disks", "root.vhdx");
    const vm: VmObservation = { id: vmId, name: "owned-vm", state: "Off", status: "Operating normally", notes: "owner-incarnation", uptimeMilliseconds: 0, generation: 2, checkpointType: "ProductionOnly" };
    const native = {
        plan: vi.fn((request: VmCreationRequest) => [{ kind: "create-vm" as const, vmName: request.vmName, generation: request.firmware.generation, memoryStartupBytes: request.memoryStartupBytes, vhdPath: request.diskPath, switchName: null }]),
        assertDeadline: () => undefined,
        sameWindowsPath: (left: string | null, right: string) => left === right,
        switchName: (value: string) => value,
        macAddress: (value: string) => value,
        getVM: vi.fn<VmCreationPorts["getVM"]>(async selector => selector.kind === "name" ? [] : [vm]),
        getVMHardDiskDrives: vi.fn(async () => [{ vmId, path: diskPath }]),
        getVMSwitches: vi.fn(async () => []),
        getAllVMNetworkAdapters: vi.fn(async () => []),
        getVMNetworkAdapters: vi.fn(async () => []),
        newVM: vi.fn(async () => vm),
        renameVMNetworkAdapter: vi.fn(async () => undefined),
        setVMNetworkAdapter: vi.fn(async () => undefined),
        addVMNetworkAdapter: vi.fn(async () => undefined),
        setVMProcessor: vi.fn(async () => undefined),
        setVMMemory: vi.fn(async () => undefined),
        setVM: vi.fn(async () => undefined),
        setVMBios: vi.fn(async () => undefined),
        setVMFirmware: vi.fn(async () => undefined),
        getVMFirmware: vi.fn(async () => ({ vmId, firstBootDevicePath: diskPath })),
        getVMBios: vi.fn(async () => ({ vmId, startupOrder: [] })),
    } satisfies VmCreationPorts;
    const prologue: Awaited<ReturnType<Ports["prepareCreateDirectories"]>> = {
        ok: true, observation: { deviceRoot: root, diskDirectory: dirname(diskPath), deviceRootExisted: false, diskDirectoryExisted: false }, partial: null, execution: evidence,
    };
    const provision: Awaited<ReturnType<Ports["provision"]>> = {
        ok: true, observation: { ok: true, vmId, vmName: vm.name, guestUsername: `ccc${owner}`, credentialPath: join(privateRoot, "secrets", "guest.credential.xml"), unattendPath: join(root, "disks", "autounattend.iso") }, execution: evidence,
    };
    const seed: Awaited<ReturnType<ReturnType<Ports["prepareLinuxSeed"]>>> = {
        ok: true, observation: {
            ok: true, vmId, vmName: vm.name, guestUsername: `ccc${owner}`, networkAddress: "172.29.0.10", seedDiskPath: join(root, "disks", "cidata.iso"),
            sshPrivateKeyPath: join(privateRoot, "secrets", "id_ed25519"), sshPublicKeyPath: join(privateRoot, "secrets", "id_ed25519.pub"),
            sshHostPublicKeyPath: join(privateRoot, "secrets", "ssh_host_ed25519_key.pub"), knownHostsPath: join(privateRoot, "secrets", "known_hosts"), sshHostKeyFingerprint: fingerprint,
        }, execution: evidence,
    };
    const seedEffect = vi.fn<ReturnType<Ports["prepareLinuxSeed"]>>(async () => seed);
    const ports = {
        connection: () => connection,
        validIncarnation: (value: unknown): value is string => value === "incarnation",
        deviceRoot: () => root,
        privateRoot: () => privateRoot,
        ownerImageRoot: () => "/images",
        imageRoot: () => "/images",
        assertImagePath: () => undefined,
        exists: () => false,
        vmName: () => vm.name,
        marker: () => vm.notes,
        createSession: () => undefined,
        creationEffects: () => native,
        executionFailed: () => false,
        vhd: vi.fn<Ports["vhd"]>(async (_session, path) => ({ path, vhdFormat: "VHDX", vhdType: "Dynamic", parentPath: null, virtualSizeBytes: 1024, fileSizeBytes: 128 })),
        vhdError: (_kind: "base" | "clone", error: unknown) => error instanceof Error ? error : new Error("invalid-vhd"),
        inspectVhd: () => 1024,
        hostCapacity: () => undefined,
        prepareCreateDirectories: vi.fn<Ports["prepareCreateDirectories"]>(async () => prologue),
        samePath: (left: string, right: string) => left === right,
        sameWindowsPath: (left: string | null, right: string) => left === right,
        directory: dirname,
        windowsDirectory: dirname,
        cloneDisk: vi.fn<Ports["cloneDisk"]>(async (_request, created) => { created(diskPath); }),
        remaining: (_deadline: number, cap: number) => cap,
        assertDeadline: () => undefined,
        deadlineExpired: () => false,
        errorInfo: () => null,
        typedErrorCode: (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback,
        typedErrorOperation: () => null,
        nativeDiagnostics: () => ({}),
        diagnosticCode: (execution: HyperVNativeExecution<Receipt>, fallback?: string) => execution.failureCode || fallback,
        boundedErrorCode: (_error: unknown, fallback: string) => fallback,
        removeCreateArtifact: vi.fn<Ports["removeCreateArtifact"]>(async () => true),
        compensationOrder: vi.fn<Ports["compensationOrder"]>(effects => effects.slice().reverse().map(effect => effect.kind === "vm-created" ? { kind: "remove-vm" as const, vmId: effect.vmId } : { kind: effect.kind === "file-created" ? "delete-file" as const : "delete-directory" as const, path: effect.path })),
        vms: vi.fn(async () => [vm]),
        disks: vi.fn(async () => [{ vmId, path: diskPath }]),
        removeVM: vi.fn(async () => undefined),
        recoverVM: vi.fn(async () => ({ recoveredVm: true, removedDisk: true })),
        releaseNetwork: vi.fn<Ports["releaseNetwork"]>(async () => ({ ok: true, released: true, statePresent: true, remaining: 0 })),
        cleanupArtifacts: vi.fn(() => ({ ok: true, removed: true })),
        planning: vi.fn<Ports["planning"]>(() => ({ kind: "planned", availability: { kind: "available", connection } })),
        ensurePrivateRoot: () => undefined,
        assertPrivateRoot: () => undefined,
        passwordEntropy: () => "password-entropy",
        prepareWindowsProvisionMedia: vi.fn<Ports["prepareWindowsProvisionMedia"]>(() => ({ media: true })),
        provision: vi.fn<Ports["provision"]>(async () => provision),
        readable: vi.fn(() => true),
        now: () => 100000,
        timestamp: () => "2026-10-15T00:00:00.000Z",
        claim: vi.fn<Ports["claim"]>((_owner, _state, device) => ({ ok: true, device })),
        incarnation: () => "incarnation",
        inspectSeed: vi.fn(async () => undefined),
        prepareLinuxSeed: vi.fn<Ports["prepareLinuxSeed"]>(() => seedEffect),
        validateHostIdentity: vi.fn(() => true),
        attachSeed: vi.fn(async () => undefined),
        seedFailureCode: (_error: unknown, fallback: string) => fallback,
        outputLimit: 1024,
    } satisfies Partial<Ports>;
    const request: HyperVCreateStartRequest = {
        ok: true, backend, stateKey: backend, command: "device_create", deviceId: "owned", force: false, dryRun: false,
        create: { incarnationId: "incarnation", image: "/images/base.vhdx", baseImageSha256: "a".repeat(64), baseImageGeneration: 2, diskMaxBytes: 1024, networking: false, networkAddress: "172.29.0.10" },
    };
    // Only the leaves reachable in these concrete journeys are supplied.
    const application = createHyperVCreateStartApplication(ports as unknown as Ports);
    return { ports, native, request, application, prologue, provision, seed, seedEffect, root, privateRoot, diskPath, vm };
}

describe("Hyper-V inward directory and creation facts", () => {
    it("returns the captured typed VM result after non-JSON directory evidence", async () => {
        const f = createFixture();
        const result = await f.application.createVmFromImage(owner, f.request, connection, 200000);
        expect(result).toMatchObject({ ok: true, observation: { vmId, vmName: f.vm.name, diskPath: f.diskPath, generation: 2 } });
        expect(result.execution).not.toHaveProperty("observation");
        expect(result.execution).toMatchObject({ required: true, dispatched: true, ok: true });
        expect(f.ports.cloneDisk).toHaveBeenCalledOnce();
        expect(f.native.newVM).toHaveBeenCalledOnce();
    });

    it("rejects semantic directory failure despite successful-looking native evidence", async () => {
        const f = createFixture();
        f.ports.prepareCreateDirectories.mockResolvedValue({ ...f.prologue, ok: false, execution: { ...evidence, receipt: { nativeEvidence: "success-looking", status: 0, stdout: JSON.stringify({ ok: true, ...f.prologue.observation }) } } });
        expect(await f.application.createVmFromImage(owner, f.request, connection, 200000)).toMatchObject({ ok: false, observation: null, execution: { failureCode: "hyper-v-vm-path-inspection-failed" } });
        expect(f.ports.cloneDisk).not.toHaveBeenCalled();
        expect(f.native.newVM).not.toHaveBeenCalled();
    });

    it.each(["missing", "foreign-root", "foreign-disk-directory"])("rejects %s directory facts before cloning", async mismatch => {
        const f = createFixture();
        f.ports.prepareCreateDirectories.mockResolvedValue({ ...f.prologue, observation: mismatch === "missing" ? null : { ...f.prologue.observation!, ...(mismatch === "foreign-root" ? { deviceRoot: "/foreign" } : { diskDirectory: "/foreign/disks" }) } });
        expect(await f.application.createVmFromImage(owner, f.request, connection, 200000)).toMatchObject({ ok: false, observation: null });
        expect(f.ports.cloneDisk).not.toHaveBeenCalled();
        expect(f.ports.removeCreateArtifact).not.toHaveBeenCalled();
    });

    it.each([
        { rootRemaining: true, diskRemaining: true, foreign: false, expected: ["root", "disks"] },
        { rootRemaining: false, diskRemaining: true, foreign: false, expected: ["disks"] },
        { rootRemaining: true, diskRemaining: true, foreign: true, expected: [] },
    ])("records only matching explicitly remaining directories ($rootRemaining/$diskRemaining/$foreign)", async scenario => {
        const f = createFixture();
        f.ports.prepareCreateDirectories.mockResolvedValue({ ...f.prologue, ok: false, partial: { deviceRoot: scenario.foreign ? "/foreign" : f.root, diskDirectory: dirname(f.diskPath), deviceRootRemaining: scenario.rootRemaining, diskDirectoryRemaining: scenario.diskRemaining } });
        await f.application.createVmFromImage(owner, f.request, connection, 200000);
        const expected: VmCreationEffect[] = scenario.expected.map(path => ({ kind: "directory-created", path: path === "root" ? f.root : dirname(f.diskPath) }));
        expect(f.ports.compensationOrder).toHaveBeenCalledWith(expected);
        expect(f.ports.removeCreateArtifact.mock.calls.map(([, target]) => target.path)).toEqual(expected.map(effect => "path" in effect ? effect.path : "").reverse());
    });

    it("compensates newly created directories without deleting an existing device root", async () => {
        const f = createFixture();
        f.ports.prepareCreateDirectories.mockResolvedValue({ ...f.prologue, observation: { ...f.prologue.observation!, deviceRootExisted: true } });
        f.ports.cloneDisk.mockRejectedValue(new Error("hyper-v-clone-failed"));
        await f.application.createVmFromImage(owner, f.request, connection, 200000);
        expect(f.ports.compensationOrder).toHaveBeenCalledWith([{ kind: "directory-created", path: dirname(f.diskPath) }]);
        expect(f.ports.removeCreateArtifact).toHaveBeenCalledWith(connection, { deviceRoot: f.root, diskPath: f.diskPath, kind: "delete-directory", path: dirname(f.diskPath) }, 30000, 1024);
    });
});

describe("Hyper-V inward creation provisioning facts", () => {
    it.each(["windows-vm", "linux-vm"] as const)("claims %s from captured facts with unusable native output", async backend => {
        const f = createFixture(backend);
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "created", device: { vmId, vmName: f.vm.name, guestProvisioned: true } });
        expect(f.ports.claim).toHaveBeenCalledOnce();
        if (backend === "windows-vm") expect(f.ports.provision).toHaveBeenCalledOnce();
        else expect(f.ports.attachSeed).toHaveBeenCalledOnce();
        expect(outcome.device).not.toHaveProperty("execution");
        expect(outcome.device).not.toHaveProperty("observation");
    });

    it("keeps status-zero invalid provisioning distinct from command failure", async () => {
        const f = createFixture();
        const receipt = Object.freeze({ nativeEvidence: "invalid-provision", status: 0, stdout: "invalid native media response" });
        f.ports.provision.mockResolvedValue({ ok: true, observation: null, execution: { ...evidence, receipt } });
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "operation-failed", error: "hyper-v-guest-provision-invalid-result", provisioning: { ok: true } });
        expect(outcome.provisioning?.receipt).toBe(receipt);
        expect(f.ports.claim).not.toHaveBeenCalled();
        expect(f.ports.recoverVM).toHaveBeenCalledOnce();
    });

    it("refuses semantic provisioning failure despite valid facts and a success-looking receipt", async () => {
        const f = createFixture();
        f.ports.provision.mockResolvedValue({ ...f.provision, ok: false, execution: { ...evidence, receipt: { nativeEvidence: "success-looking", status: 0, stdout: JSON.stringify(f.provision.observation) } } });
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "operation-failed", error: "hyper-v-guest-provision-failed", provisioning: { ok: true } });
        expect(outcome.provisioning).not.toHaveProperty("observation");
        expect(f.ports.claim).not.toHaveBeenCalled();
    });

    it("keeps invalid provisioning primary when provider compensation also fails", async () => {
        const f = createFixture();
        const receipt = Object.freeze({ nativeEvidence: "invalid-provision", status: 0, stdout: "invalid native media response" });
        f.ports.provision.mockResolvedValue({ ok: true, observation: null, execution: { ...evidence, receipt } });
        f.ports.recoverVM.mockRejectedValue(new Error("hyper-v-rollback-command-failed"));
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "operation-failed", error: "hyper-v-guest-provision-invalid-result",
            rollback: { attempted: true, ok: false, reason: "hyper-v-rollback-command-failed" } });
        expect(outcome.provisioning?.receipt).toBe(receipt);
        expect(f.ports.claim).not.toHaveBeenCalled();
    });

    it("refuses semantic seed failure before attachment despite a success-looking receipt", async () => {
        const f = createFixture("linux-vm");
        f.seedEffect.mockResolvedValue({ ...f.seed, ok: false, execution: { ...evidence, receipt: { nativeEvidence: "success-looking", status: 0, stdout: JSON.stringify(f.seed.observation) } } });
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "operation-failed", error: "hyper-v-linux-seed-failed", provisioning: { ok: true } });
        expect(f.ports.attachSeed).not.toHaveBeenCalled();
        expect(f.ports.claim).not.toHaveBeenCalled();
    });

    it("rejects a seed for another VM before attachment or persistence", async () => {
        const f = createFixture("linux-vm");
        f.seedEffect.mockResolvedValue({ ...f.seed, observation: { ...f.seed.observation!, vmId: "87654321-4321-4321-4321-cba987654321" } });
        expect(await f.application.execute(owner, f.request, {}, 200000, 230000)).toMatchObject({ error: "hyper-v-linux-seed-invalid-result" });
        expect(f.ports.attachSeed).not.toHaveBeenCalled();
        expect(f.ports.claim).not.toHaveBeenCalled();
    });
});

function linuxReadiness(ready: boolean): HyperVLinuxReadinessObservation<Receipt> {
    return { backend: "linux-vm", ok: ready, ready, execution: evidence, failureCode: "ssh-unavailable", failureDetail: { evidence: { status: ready ? 0 : 255, timedOut: false, stdoutBytes: 0, stderrBytes: 0 } }, hostKeyFingerprints: [] };
}

function bootstrapFixture() {
    const f = createFixture("linux-vm");
    let now = 100000;
    const device = {
        id: "owned", vmId, vmName: f.vm.name, incarnationId: "incarnation", status: "stopped", runtimeState: "Off", memoryMb: 4096, cpus: 2,
        deviceRoot: f.root, privateRoot: f.privateRoot, sshHostPublicKeyPath: join(f.privateRoot, "secrets", "ssh_host_ed25519_key.pub"),
        sshKnownHostsPath: join(f.privateRoot, "secrets", "known_hosts"), sshPrivateKeyPath: join(f.privateRoot, "secrets", "id_ed25519"),
        sshHostKeyFingerprint: fingerprint, guestUsername: `ccc${owner}`, networkAddress: "172.29.0.10", networkGateway: "172.29.0.1", networkPrefix: "172.29.0.0/24", macAddress: "021122334455",
    };
    const bootstrap: Awaited<ReturnType<Ports["bootstrapProbe"]>> = { diagnostics: { status: 0 }, failureCode: null, observation: { ok: true, addresses: ["172.20.1.8"] }, execution: evidence };
    const cleanup: Awaited<ReturnType<Ports["bootstrapCleanup"]>> = { observation: { ok: true, removed: true, alreadyMissing: false }, execution: evidence };
    const ports = {
        ...f.ports,
        now: () => now,
        sleep: async (milliseconds: number) => { now += milliseconds; },
        planning: vi.fn<Ports["planning"]>((_owner, _params, expected) => { if (expected) expected.device = device; return { kind: "planned", device, availability: { kind: "available", connection } }; }),
        forgetConsole: () => undefined,
        power: vi.fn<Ports["power"]>(async (_connection, _identity, operation) => ({ ok: true, observation: { ok: true, vmId, vmName: f.vm.name, state: operation === "stop" ? "Off" : "Running", status: "Operating normally" }, execution: evidence })),
        reconcileHostIdentity: () => ({ identity: { fingerprint } }),
        probeLinuxReadiness: vi.fn<Ports["probeLinuxReadiness"]>(async (_connection, request) => linuxReadiness(request.networkAddress !== device.networkAddress)),
        bootstrapProbe: vi.fn<Ports["bootstrapProbe"]>(async () => bootstrap),
        finalizeLinuxNetwork: vi.fn<Ports["finalizeLinuxNetwork"]>(async () => ({ ok: true, execution: evidence })),
        bootstrapCleanup: vi.fn<Ports["bootstrapCleanup"]>(async () => cleanup),
        probeLinuxGui: vi.fn<Ports["probeLinuxGui"]>(async () => linuxReadiness(true)),
        prepareLinuxGui: vi.fn<Ports["prepareLinuxGui"]>(async () => linuxReadiness(true)),
        readinessFailure: vi.fn<Ports["readinessFailure"]>((_backend, code, source) => ({ ...linuxReadiness(false), execution: source?.execution || source?.previous?.execution || evidence, failureCode: code })),
        bootDiagnostic: vi.fn<Ports["bootDiagnostic"]>(async () => { throw new Error("diagnostic unavailable"); }),
        publish: vi.fn<Ports["publish"]>((_owner, _state, _id, expected, replace) => { expect(expected).toBe(device); return { found: true, matched: true, device: replace(device) }; }),
        maxBootTimeout: 300000,
        linuxGuiTimeout: 30000,
    } satisfies Partial<Ports>;
    const application = createHyperVCreateStartApplication(ports as unknown as Ports);
    const request: HyperVCreateStartRequest = { ...f.request, command: "device_start", waitForBoot: true, bootTimeoutMs: 1000 };
    return { ...f, device, ports, bootstrap, cleanup, application, request, setNow: (value: number) => { now = value; } };
}

describe("Hyper-V inward bootstrap facts", () => {
    it("retains completed discovery and SSH evidence when a later native dispatch has only a fractional allowance", async () => {
        const f = bootstrapFixture();
        const requests: HyperVWindowsExecutionRequest[] = [];
        const ownedVm = { vmId, vmName: f.vm.name, ownershipMarker: f.vm.notes };
        const guestAdapter = { vmId, vmName: f.vm.name, name: "CCC Bootstrap DHCP", switchId: null, switchName: "Default Switch",
            status: "Ok", managementOperatingSystem: false, macAddress: "06:11:22:33:44:55", ipAddresses: ["172.20.1.8"] };
        const options = (deadlineAt: number): DeviceLabHyperVWindowsClientOptions => ({
            executable: "powershell.exe", now: f.ports.now,
            timeoutMilliseconds: () => hyperVRemainingTimeout(deadlineAt, 30000, f.ports.now),
            run: command => {
                const memory = JSON.parse(Buffer.from(command.input || "", "base64").toString("utf8")) as { input: string };
                const request = JSON.parse(memory.input) as HyperVWindowsExecutionRequest;
                requests.push(request);
                let items: readonly unknown[] = [];
                switch (request.operation) {
                    case "Get-VM": items = [{ id: vmId, name: f.vm.name, notes: f.vm.notes }]; break;
                    case "Get-VMNetworkAdapter": items = "managementSwitchName" in request
                        ? [{ ...guestAdapter, vmId: null, vmName: null, managementOperatingSystem: true, ipAddresses: ["172.20.1.1"] }]
                        : [guestAdapter]; break;
                    case "Get-NetIPAddress": items = [{ interfaceIndex: 12, address: "172.20.1.1", prefixLength: 24,
                        prefixOrigin: "Dhcp", suffixOrigin: "Dhcp", addressState: "Preferred", interfaceAlias: "vEthernet (Default Switch)" }]; break;
                    case "Get-NetNeighbor": break;
                    // Even the independent cleanup allowance is not proof that removal completed.
                    case "Remove-VMNetworkAdapter": return { status: null, stdout: "", timedOut: true };
                    default: throw new Error(`unexpected-native-operation:${request.operation}`);
                }
                return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, operation: request.operation, ok: true, items }) };
            },
        });
        f.ports.bootstrapProbe.mockImplementation(async (_connection, identity) => {
            const result = await probeDeviceLabHyperVBootstrapNetwork(options(identity.deadlineAt), ownedVm);
            return { diagnostics: { status: result.execution.status }, failureCode: null, observation: result.observation,
                execution: { ...evidence, ok: result.execution.status === 0 } };
        });
        f.ports.bootstrapCleanup.mockImplementation(async (_connection, identity) => {
            const result = await cleanupDeviceLabHyperVBootstrapNetwork(options(identity.deadlineAt), ownedVm, "02:11:22:33:44:55");
            return { observation: result.observation, execution: { ...evidence, ok: result.execution.status === 0 } };
        });
        f.ports.probeLinuxReadiness.mockResolvedValue(linuxReadiness(false));
        let pauses = 0;
        f.ports.sleep = async () => { f.setNow(++pauses === 1 ? 100999.5 : 101000); };

        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "operation-failed", device: { bootReady: false, runtimeState: "Off" }, boot: {
            ready: false, error: "ssh-unavailable", readiness: {
                managedSshAttempts: 2, bootstrapProbeAttempts: 2, bootstrapProbeSuccesses: 1,
                bootstrapProbeEvidence: { status: 0 }, bootstrapProbeLastError: null,
                bootstrapAddressCount: 1, bootstrapSshAttempts: 1,
                bootstrapSshEvidence: { status: 255, timedOut: false }, bootstrapSshLastError: "ssh-unavailable",
                networkFinalizeAttempts: 0, networkFinalizeSucceeded: false,
            },
        } });
        // The refused second probe never reaches native Get-VM; the second inventory is containment.
        expect(requests.filter(request => request.operation === "Get-VM")).toHaveLength(2);
        expect(f.ports.bootstrapCleanup).toHaveBeenCalledWith(connection, expect.objectContaining({ deadlineAt: 230000 }), f.device.macAddress);
        expect(f.ports.power).toHaveBeenLastCalledWith(connection, expect.objectContaining({ vmId, vmName: f.vm.name }), "stop", 230000, 30000, { force: true });
        expect(f.ports.finalizeLinuxNetwork).not.toHaveBeenCalled();
        expect(f.ports.probeLinuxGui).not.toHaveBeenCalled();
    });

    it("carries supplied trace evidence and diagnostic without reclassifying native evidence", async () => {
        const f = bootstrapFixture();
        const diagnostics = Object.freeze({ status: 23 });
        f.ports.bootstrapProbe.mockResolvedValue({ diagnostics, failureCode: "hyper-v-bootstrap-neighbor-inspection-failed", observation: null, execution: { ...evidence, receipt: { nativeEvidence: "success-looking", status: 0, stdout: '{"ok":true,"addresses":[]}' } } });
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome.boot).toMatchObject({ ready: false, error: "hyper-v-bootstrap-neighbor-inspection-failed", readiness: { bootstrapProbeLastError: "hyper-v-bootstrap-neighbor-inspection-failed", bootstrapProbeSuccesses: 0 } });
        expect(outcome.boot?.readiness?.bootstrapProbeEvidence).toBe(diagnostics);
        expect(f.ports.finalizeLinuxNetwork).not.toHaveBeenCalled();
    });

    it("processes captured bootstrap addresses while retaining a separate trace diagnostic", async () => {
        const f = bootstrapFixture();
        f.ports.bootstrapProbe.mockResolvedValue({ ...f.bootstrap, failureCode: "hyper-v-bootstrap-neighbor-inspection-failed" });
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(f.ports.finalizeLinuxNetwork).toHaveBeenCalledWith(connection, expect.objectContaining({
            networkAddress: "172.20.1.8", hostKeyAlias: f.device.networkAddress,
            managedNetworkAddress: f.device.networkAddress, managedMacAddress: f.device.macAddress,
        }), 15000, 1024);
        expect(outcome.boot?.readiness).toMatchObject({ bootstrapProbeLastError: "hyper-v-bootstrap-neighbor-inspection-failed", bootstrapProbeSuccesses: 1, bootstrapAddressCount: 1, bootstrapSshAttempts: 1, networkFinalizeSucceeded: true });
        expect(outcome.boot?.ready).toBe(false);
    });

    it("refuses semantic finalization failure despite a zero-status receipt", async () => {
        const f = bootstrapFixture();
        f.ports.finalizeLinuxNetwork.mockResolvedValue({ ok: false, execution: { ...evidence, receipt: { nativeEvidence: "success-looking", status: 0, stdout: "ccc-hyper-v-linux-ready" } } });
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome.boot).toMatchObject({ ready: false, readiness: { networkFinalizeSucceeded: false, networkFinalizeAttempts: 1 } });
        expect(f.ports.probeLinuxReadiness.mock.calls.filter(([, request]) => request.networkAddress === f.device.networkAddress)).toHaveLength(1);
        expect(f.ports.probeLinuxGui).not.toHaveBeenCalled();
    });

    it("requires a later managed-network readiness probe after accepted finalization", async () => {
        const f = bootstrapFixture();
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "operation-failed", boot: { ready: false, readiness: { networkFinalizeSucceeded: true, managedSshAttempts: 2 } } });
        expect(f.ports.finalizeLinuxNetwork).toHaveBeenCalledOnce();
        expect(f.ports.probeLinuxGui).not.toHaveBeenCalled();
    });

    it("accepts finalization facts with unusable evidence then waits for managed readiness", async () => {
        const f = bootstrapFixture();
        let managedAttempts = 0;
        f.ports.probeLinuxReadiness.mockImplementation(async (_connection, request) => linuxReadiness(request.networkAddress !== f.device.networkAddress || ++managedAttempts > 1));
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "started", device: { bootReady: true }, boot: { ready: true, readiness: { networkFinalizeSucceeded: true, managedSshAttempts: 2 } } });
        expect(f.ports.bootstrapCleanup).toHaveBeenCalledOnce();
        expect(f.ports.power).toHaveBeenCalledOnce();
    });

    it("contains a null cleanup observation after readiness and refuses a running publication", async () => {
        const f = bootstrapFixture();
        f.ports.probeLinuxReadiness.mockResolvedValue(linuxReadiness(true));
        f.ports.bootstrapCleanup.mockResolvedValue({ ...f.cleanup, observation: null, execution: { ...evidence, receipt: { nativeEvidence: "success-looking", status: 0, stdout: '{"ok":true,"removed":true}' } } });
        const outcome = await f.application.execute(owner, f.request, {}, 200000, 230000);
        expect(outcome).toMatchObject({ kind: "operation-failed", boot: { ready: false, error: "hyper-v-bootstrap-network-cleanup-failed" }, device: { bootReady: false, runtimeState: "Off" } });
        expect(f.ports.bootstrapCleanup).toHaveBeenCalledTimes(2);
        expect(f.ports.power.mock.calls.map(([, , operation]) => operation)).toEqual(["start", "stop"]);
        expect(f.ports.probeLinuxGui).not.toHaveBeenCalled();
    });
});
