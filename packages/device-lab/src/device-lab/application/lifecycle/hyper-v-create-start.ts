import type {HyperVWindowsGuestBootDiagnostic} from '@ccc/hyper-v/index.js';
import type {HyperVGuestReadyObservation,HyperVGuestReadinessFailureDetail,HyperVLinuxGuestReadyTrace} from '../../domain/lifecycle/hyper-v-create-start.js';
import type {HyperVPublication} from '../../domain/lifecycle/hyper-v-stop-delete.js';
import {hyperVCreateUniqueFields,hyperVDeviceDefinition,hyperVCreateField,hyperVCreateNumber,hyperVLinuxGuestReadyTraceFailureCode,hyperVLinuxGuestSignalDeadlineAt,hyperVLinuxGuestSignalTimedOut,compareHyperVLinuxEd25519HostKeyFingerprint} from '../../domain/lifecycle/hyper-v-create-start.js';
import type { SnapshotJournal } from '../../domain/lifecycle/hyper-v-snapshots.js';
import { hyperVSelectedDevice } from '../../domain/lifecycle/hyper-v-stop-delete.js';
import { hyperVCreateRecord, hyperVQuotaResource, hyperVQuotaProjection, type HyperVQuotaUsage, type HyperVLifecycleResponse } from '../../domain/lifecycle/hyper-v-create-start.js';
import { parseWindowsReadinessProbe, windowsProbeFingerprint, windowsReadinessReason, type WindowsReadinessRequest, type WindowsReadinessIdentity, type WindowsReadinessOutcome } from '../../domain/lifecycle/hyper-v-create-start.js';
import type { WindowsReadinessPorts } from '../../ports/lifecycle/hyper-v-create-start.js';
class ReadinessRetry extends Error {
    constructor(readonly reason: string) { super(reason); }
}
async function inspectDetached(ports: WindowsReadinessPorts, identity: WindowsReadinessIdentity, path: string, deadline: number, now: () => number, remainingTimeout: () => number): Promise<boolean> {
    try {
        if (now() >= deadline)
            return false;
        const machines = await ports.machines(identity, remainingTimeout());
        if (machines.length !== 1 || machines[0].name !== identity.expectedName
            || machines[0].notes !== identity.expectedNotes)
            return false;
        if (now() >= deadline)
            return false;
        const drives = await ports.media(identity, remainingTimeout());
        return drives.every((drive) => drive.path?.toLowerCase() !== path.toLowerCase());
    }
    catch {
        return false;
    }
}
export async function waitHyperVWindowsGuestReadiness(options: WindowsReadinessRequest, ports: WindowsReadinessPorts): Promise<WindowsReadinessOutcome> {
    if (!Number.isSafeInteger(options.timeoutMilliseconds) || options.timeoutMilliseconds < 1000
        || options.timeoutMilliseconds > 20 * 60 * 1000
        || (options.noProgressTimeoutMilliseconds !== undefined
            && (!Number.isSafeInteger(options.noProgressTimeoutMilliseconds)
                || options.noProgressTimeoutMilliseconds < 1000
                || options.noProgressTimeoutMilliseconds > options.timeoutMilliseconds))) {
        return { ok: false, error: "hyper-v-guest-ready-failed", reason: "hyper-v-guest-ready-precondition-failed", attempts: 0, scrubConfirmed: false, mediaDetached: false };
    }
    const now = () => ports.now();
    const sleep = (milliseconds: number) => ports.sleep(milliseconds);
    const deadline = now() + options.timeoutMilliseconds;
    let stableObservationFingerprint: string | null = null;
    let stableObservationDeadline: number | null = null;
    const remainingTimeout = () => {
        const observedAt = now();
        return Math.max(1, Math.min(15000, deadline - observedAt, stableObservationDeadline === null ? Number.POSITIVE_INFINITY : stableObservationDeadline - observedAt));
    };
    let attempts = 0;
    let reason = "powershell-direct-unavailable";
    let scrubConfirmed = false;
    let mediaDetached = false;
    while (true) {
        const attemptStartedAt = now();
        if (attemptStartedAt >= deadline
            || (stableObservationDeadline !== null && attemptStartedAt >= stableObservationDeadline))
            break;
        attempts += 1;
        let currentObservationFingerprint: string | null = null;
        try {
            const output = await ports.probe(options.identity, remainingTimeout());
            if (output.action !== "job")
                throw new Error("guest-probe-result-invalid");
            const probe = parseWindowsReadinessProbe(output.output);
            if (!probe)
                throw new ReadinessRetry("hyper-v-guest-probe-invalid");
            currentObservationFingerprint = `probe:${windowsProbeFingerprint(probe)}`;
            if (options.noProgressTimeoutMilliseconds !== undefined
                && currentObservationFingerprint !== stableObservationFingerprint) {
                stableObservationFingerprint = currentObservationFingerprint;
                stableObservationDeadline = now() + options.noProgressTimeoutMilliseconds;
            }
            if (probe.firstLogonCompleted !== options.identity.expectedNotes) {
                throw new ReadinessRetry("hyper-v-guest-first-logon-incomplete");
            }
            if (probe.provisioningSecretsPresent) {
                throw new ReadinessRetry("hyper-v-guest-provisioning-not-scrubbed");
            }
            scrubConfirmed = true;
            if (now() >= deadline)
                throw new ReadinessRetry("hyper-v-guest-ready-deadline-exceeded");
            if (!mediaDetached) {
                try {
                    await ports.detachMedia(options.identity, options.provisioningMediaPath, remainingTimeout());
                    mediaDetached = true;
                }
                catch (error) {
                    mediaDetached = await inspectDetached(ports, options.identity, options.provisioningMediaPath, deadline, now, remainingTimeout);
                    if (!mediaDetached) {
                        return {
                            ok: false, error: "hyper-v-guest-ready-failed", reason: windowsReadinessReason(ports.errorInfo(error)),
                            attempts, scrubConfirmed, mediaDetached,
                        };
                    }
                }
            }
            if (now() >= deadline)
                throw new ReadinessRetry("hyper-v-guest-ready-deadline-exceeded");
            try {
                await ports.removeMedia();
            }
            catch {
                throw new ReadinessRetry("hyper-v-guest-provisioning-media-delete-failed");
            }
            if (now() >= deadline)
                throw new ReadinessRetry("hyper-v-guest-ready-deadline-exceeded");
            if (options.expectedNetworkAddress && !probe.addresses.includes(options.expectedNetworkAddress)) {
                throw new ReadinessRetry("hyper-v-guest-network-not-ready");
            }
            return {
                ok: true, vmId: options.identity.selector.id.toLowerCase(), vmName: options.identity.expectedName,
                computerName: probe.computerName, attempts, networkAddress: options.expectedNetworkAddress,
            };
        }
        catch (error) {
            reason = error instanceof ReadinessRetry ? error.reason : windowsReadinessReason(ports.errorInfo(error));
            if (ports.errorInfo(error) !== null)
                currentObservationFingerprint = `transport:${reason}`;
        }
        const observedAt = now();
        let noProgressRemaining = Number.POSITIVE_INFINITY;
        if (currentObservationFingerprint !== null && options.noProgressTimeoutMilliseconds !== undefined) {
            if (currentObservationFingerprint !== stableObservationFingerprint) {
                stableObservationFingerprint = currentObservationFingerprint;
                stableObservationDeadline = observedAt + options.noProgressTimeoutMilliseconds;
            }
            noProgressRemaining = (stableObservationDeadline ?? observedAt) - observedAt;
            if (noProgressRemaining <= 0)
                break;
        }
        else {
            // Malformed or unclassified output is not a stable bounded observation.
            stableObservationFingerprint = null;
            stableObservationDeadline = null;
        }
        const remaining = deadline - observedAt;
        if (remaining > 0)
            await sleep(Math.min(2000, remaining, noProgressRemaining));
    }
    return { ok: false, error: "hyper-v-guest-ready-timeout", reason, attempts, scrubConfirmed, mediaDetached };
}
import type { VmCreationRequest, VmCreationEffect, VmCreationObservation } from '../../domain/lifecycle/hyper-v-create-start.js';
import type { VmCreationPorts } from '../../ports/lifecycle/hyper-v-create-start.js';
export async function executeHyperVVmCreation(request: VmCreationRequest, ports: VmCreationPorts, effects: VmCreationEffect[], deadlineAt: number, onNewVmAttempt: () => undefined): Promise<VmCreationObservation> {
    // Every native call recomputes the broker deadline. The injected transport applies its own
    // per-call cap; this guard prevents a sequence of individually bounded calls overrunning it.
    const call = async <Result>(operation: () => Promise<Result>): Promise<Result> => {
        ports.assertDeadline(deadlineAt);
        return operation();
    };
    const plan = ports.plan(request);
    const firstMutation = plan.findIndex((step) => step.kind === "create-vm");
    if (firstMutation < 0 || plan.slice(0, firstMutation).some((step) => step.kind !== "ensure-directory" && step.kind !== "copy-base-image")) {
        throw new Error("hyper-v-create-plan-invalid");
    }
    const existing = await call(() => ports.getVM({ kind: "name", name: request.vmName }));
    if (existing.length !== 0)
        throw new Error("hyper-v-vm-already-exists");
    const network = request.network;
    let switchName: string | null = null;
    let switchId: string | null = null;
    let bootstrapSwitchName: string | null = null;
    let bootstrapSwitchId: string | null = null;
    if (network.kind !== "none") {
        const switches = await call(() => ports.getVMSwitches({ kind: "name", name: ports.switchName(network.switchName) }));
        if (switches.length !== 1 || switches[0]?.name !== network.switchName)
            throw new Error("hyper-v-network-switch-not-found");
        switchName = switches[0].name;
        switchId = switches[0].id;
        if (network.kind === "managed-and-bootstrap") {
            const bootstrap = await call(() => ports.getVMSwitches({ kind: "name", name: ports.switchName(network.bootstrapSwitchName) }));
            if (bootstrap.length !== 1 || bootstrap[0]?.name !== network.bootstrapSwitchName) {
                throw new Error("hyper-v-bootstrap-dhcp-switch-unavailable");
            }
            if (bootstrap[0].id === switches[0].id)
                throw new Error("hyper-v-bootstrap-network-switch-conflict");
            bootstrapSwitchName = bootstrap[0].name;
            bootstrapSwitchId = bootstrap[0].id;
            const bootstrapMac = ports.macAddress(`06${network.macAddress.slice(2)}`);
            const hostAdapters = await call(() => ports.getAllVMNetworkAdapters());
            if (hostAdapters.some((adapter) => adapter.macAddress === bootstrapMac)) {
                throw new Error("hyper-v-bootstrap-mac-address-conflict");
            }
        }
    }
    let vmId: string | null = null;
    let createdState = "Unknown";
    for (const step of plan.slice(firstMutation)) {
        if (step.kind === "create-vm") {
            const created = await call(() => {
                onNewVmAttempt();
                return ports.newVM({
                    name: step.vmName,
                    generation: step.generation,
                    memoryStartupBytes: step.memoryStartupBytes,
                    vhdPath: step.vhdPath,
                    ...(step.switchName === null ? {} : { switchName: step.switchName }),
                });
            });
            if (created.name !== request.vmName || created.generation !== request.firmware.generation) {
                throw new Error("hyper-v-create-invalid-result");
            }
            // Record only a result with the expected name and generation. A malformed response
            // might name someone else's ID; that case is left to name/disk-fenced recovery.
            vmId = created.id;
            effects.push({ kind: "vm-created", vmId });
            createdState = created.state;
            continue;
        }
        if (vmId === null)
            throw new Error("hyper-v-create-plan-invalid");
        const selector: {
            kind: "id";
            id: string;
        } = { kind: "id", id: vmId };
        switch (step.kind) {
            case "rename-adapter":
                await call(() => ports.renameVMNetworkAdapter({ selector, adapter: step.adapter, newName: step.to }));
                break;
            case "set-adapter-mac":
                await call(() => ports.setVMNetworkAdapter({ selector, adapter: step.adapter, staticMacAddress: step.macAddress }));
                break;
            case "add-adapter":
                await call(() => ports.addVMNetworkAdapter({ selector, name: step.adapterName, switchName: step.switchName }));
                break;
            case "set-processor-count":
                await call(() => ports.setVMProcessor({ selector, count: step.count,
                    ...(step.exposeVirtualizationExtensions !== undefined ? { exposeVirtualizationExtensions: step.exposeVirtualizationExtensions } : {}),
                }));
                break;
            case "disable-dynamic-memory":
                await call(() => ports.setVMMemory({ selector, dynamicMemoryEnabled: false }));
                break;
            case "set-vm-settings":
                await call(() => ports.setVM({ selector, notes: step.notes, checkpointType: step.checkpointType, automaticCheckpointsEnabled: step.automaticCheckpointsEnabled }));
                break;
            case "set-bios-startup-order":
                await call(() => ports.setVMBios({ selector, startupOrder: step.startupOrder }));
                break;
            case "configure-firmware":
                await call(() => ports.setVMFirmware({ selector, secureBoot: step.secureBoot, firstBootDiskPath: step.firstBootDiskPath }));
                break;
            default:
                throw new Error("hyper-v-create-plan-invalid");
        }
    }
    if (vmId === null)
        throw new Error("hyper-v-create-plan-invalid");
    const selector: {
        kind: "id";
        id: string;
    } = { kind: "id", id: vmId };
    const observedVm = await call(() => ports.getVM(selector));
    const hardDisks = await call(() => ports.getVMHardDiskDrives(selector));
    if (observedVm.length !== 1 || observedVm[0]?.id !== vmId || observedVm[0].name !== request.vmName
        || observedVm[0].notes !== request.notes || observedVm[0].generation !== request.firmware.generation) {
        throw new Error("hyper-v-create-invalid-result");
    }
    if (hardDisks.length !== 1 || hardDisks[0]?.vmId !== vmId
        || !ports.sameWindowsPath(hardDisks[0].path, request.diskPath)) {
        throw new Error("hyper-v-created-disk-attachment-mismatch");
    }
    if (request.firmware.generation === 2) {
        const firmware = await call(() => ports.getVMFirmware(selector));
        if (firmware.vmId !== vmId || !ports.sameWindowsPath(firmware.firstBootDevicePath, request.diskPath)) {
            throw new Error("hyper-v-created-disk-boot-order-mismatch");
        }
    }
    else {
        const expectedStartupOrder = request.firmware.startupOrder;
        const bios = await call(() => ports.getVMBios(selector));
        if (bios.vmId !== vmId || bios.startupOrder.length !== expectedStartupOrder.length
            || bios.startupOrder.some((device, index) => device !== expectedStartupOrder[index])) {
            throw new Error("hyper-v-created-disk-boot-order-mismatch");
        }
    }
    if (network.kind !== "none") {
        const adapters = await call(() => ports.getVMNetworkAdapters({ selector }));
        const managed = adapters.filter((adapter) => adapter.name === network.adapterName
            && adapter.vmId === vmId && adapter.switchId === switchId && adapter.switchName === switchName);
        if (managed.length !== 1 || (network.macAddress !== null
            && managed[0]?.macAddress !== ports.macAddress(network.macAddress))) {
            throw new Error("hyper-v-managed-network-adapter-unavailable");
        }
        if (network.kind === "managed-and-bootstrap") {
            const bootstrapMac = ports.macAddress(`06${network.macAddress.slice(2)}`);
            const bootstrap = adapters.filter((adapter) => adapter.name === network.bootstrapAdapterName
                && adapter.vmId === vmId && adapter.switchId === bootstrapSwitchId
                && adapter.switchName === bootstrapSwitchName && adapter.macAddress === bootstrapMac);
            if (bootstrap.length !== 1 || adapters.length !== 2)
                throw new Error("hyper-v-bootstrap-network-adapter-unavailable");
            const hostAdapters = await call(() => ports.getAllVMNetworkAdapters());
            const assigned = hostAdapters.filter((adapter) => adapter.macAddress === bootstrapMac);
            if (assigned.length !== 1 || assigned[0]?.vmId !== vmId || assigned[0].name !== network.bootstrapAdapterName) {
                throw new Error("hyper-v-bootstrap-mac-address-conflict");
            }
        }
        else if (adapters.length !== 1) {
            throw new Error("hyper-v-managed-network-adapter-unavailable");
        }
    }
    ports.assertDeadline(deadlineAt);
    return {
        vmId,
        vmName: request.vmName,
        state: observedVm[0].state || createdState,
        generation: request.firmware.generation,
        diskPath: request.diskPath,
        switchName,
    };
}
import { join } from 'path';
import { hyperVCreateSucceeded, type HyperVNativeCommand,type HyperVScriptCommand,type HyperVCreateStartRequest,type HyperVLifecycleRequest, type HyperVNativeExecution, type HyperVCreateRecovery } from '../../domain/lifecycle/hyper-v-create-start.js';
import type { HyperVCreateStartPorts } from '../../ports/lifecycle/hyper-v-create-start.js';
export function createHyperVCreateStartApplication<Session>(ports: HyperVCreateStartPorts<Session>) {
    async function createVmFromImage(ownerId: string, parsed: HyperVLifecycleRequest, executable: string, deadlineAt: number): Promise<HyperVNativeExecution> {
        const create = parsed.create || {};
        const effects: VmCreationEffect[] = [];
        let newVmAttempted = false;
        let typedVhdInvalidResult = false;
        const deviceRoot = ports.deviceRoot(ownerId, parsed.backend, parsed.deviceId);
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        let expectedVmName: string | null = null;
        let expectedMarker: string | null = null;
        const imagePath = typeof create.image === "string" ? create.image : "";
        const expectedSha256 = typeof create.baseImageSha256 === "string" ? create.baseImageSha256.toLowerCase() : "";
        const generation = create.baseImageGeneration;
        const memoryMb = typeof create.memoryMb === "number" ? create.memoryMb : 4096;
        const cpus = typeof create.cpus === "number" ? create.cpus : 2;
        const diskMaxBytes = create.diskMaxBytes;
        const incarnationId = create.incarnationId;
        const ownerImageRoot = ports.ownerImageRoot(ownerId);
        const imageRoot = [ownerImageRoot, ports.imageRoot()].find((candidate) => {
            try {
                ports.assertImagePath(candidate, imagePath);
                return true;
            }
            catch {
                return false;
            }
        });
        const session = ports.createSession(executable, deadlineAt);
        const readCreateVhd = async (kind: "base" | "clone", path: string) => {
            try {
                return await ports.vhd(session, path);
            }
            catch (error) {
                if (!ports.executionFailed(session) && ports.errorInfo(error)?.category === "protocol") {
                    typedVhdInvalidResult = true;
                }
                throw ports.vhdError(kind, error);
            }
        };
        try {
            if (!imageRoot || !/^[a-f0-9]{64}$/.test(expectedSha256)
                || (generation !== 1 && generation !== 2)
                || typeof diskMaxBytes !== "number" || !ports.validIncarnation(incarnationId)) {
                throw new Error("hyper-v-vm-preflight-failed");
            }
            expectedVmName = ports.vmName(ownerId, parsed.deviceId, incarnationId);
            expectedMarker = ports.marker(ownerId, parsed.deviceId, incarnationId);
            ports.hostCapacity(memoryMb, cpus);
            const prologueCommand = ports.prologue(executable, imageRoot, imagePath, deviceRoot, diskPath);
            ports.assertDeadline(deadlineAt);
            const prologue = await ports.execute(prologueCommand, ports.remaining(deadlineAt, 120000), ports.outputLimit);
            if (!hyperVCreateSucceeded(prologue)) {
                const partial = ports.parsePrologueFailure(prologue.stdout || "");
                if (partial && ports.samePath(partial.deviceRoot, deviceRoot)
                    && ports.samePath(partial.diskDirectory, ports.directory(diskPath))) {
                    if (partial.deviceRootRemaining)
                        effects.push({ kind: "directory-created", path: deviceRoot });
                    if (partial.diskDirectoryRemaining)
                        effects.push({ kind: "directory-created", path: ports.directory(diskPath) });
                }
                throw new Error(ports.diagnosticCode(prologue, "hyper-v-vm-path-inspection-failed") || "hyper-v-vm-path-inspection-failed");
            }
            ports.assertDeadline(deadlineAt);
            const prepared = ports.parsePrologue(prologue.stdout || "");
            if (!prepared || !ports.samePath(prepared.deviceRoot, deviceRoot)
                || !ports.samePath(prepared.diskDirectory, ports.directory(diskPath))) {
                throw new Error("hyper-v-vm-path-inspection-failed");
            }
            if (!prepared.deviceRootExisted)
                effects.push({ kind: "directory-created", path: deviceRoot });
            if (!prepared.diskDirectoryExisted)
                effects.push({ kind: "directory-created", path: ports.directory(diskPath) });
            ports.assertDeadline(deadlineAt);
            const baseVirtualSizeBytes = ports.inspectVhd({ kind: "base", path: imagePath }, await readCreateVhd("base", imagePath));
            ports.assertDeadline(deadlineAt);
            await ports.cloneDisk({
                baseImageRoot: imageRoot,
                baseImagePath: imagePath,
                expectedSha256,
                deviceRoot,
                diskPath,
                deadlineAt,
            }, path => { effects.push({ kind: "file-created", path }); return undefined; });
            ports.assertDeadline(deadlineAt);
            ports.inspectVhd({ kind: "clone", path: diskPath, expectedVirtualSizeBytes: baseVirtualSizeBytes }, await readCreateVhd("clone", diskPath));
            ports.assertDeadline(deadlineAt);
            const networking = create.networking !== false;
            const switchName = typeof create.switchName === "string" ? create.switchName : "";
            const macAddress = typeof create.macAddress === "string" ? create.macAddress.toUpperCase() : null;
            if (networking && !switchName)
                throw new Error("hyper-v-network-switch-not-found");
            if (parsed.backend === "linux-vm" && networking && !macAddress) {
                throw new Error("hyper-v-bootstrap-mac-address-missing");
            }
            let network: VmCreationRequest['network'];
            if (!networking)
                network = { kind: 'none' };
            else if (parsed.backend === 'linux-vm') {
                if (!macAddress)
                    throw new Error('hyper-v-bootstrap-mac-address-missing');
                network = { kind: 'managed-and-bootstrap', switchName, adapterName: 'CCC Device Network', macAddress, bootstrapSwitchName: 'Default Switch', bootstrapAdapterName: 'CCC Bootstrap DHCP' };
            }
            else
                network = { kind: 'managed', switchName, adapterName: 'CCC Device Network', macAddress };
            const firmware: VmCreationRequest["firmware"] = generation === 1
                ? { generation: 1, startupOrder: ["IDE", "CD", "LegacyNetworkAdapter", "Floppy"] }
                : {
                    generation: 2,
                    secureBoot: parsed.backend === "linux-vm"
                        ? { enabled: false }
                        : { enabled: true, template: "MicrosoftWindows" },
                };
            const request: VmCreationRequest = {
                vmName: expectedVmName,
                firmware,
                memoryStartupBytes: memoryMb * 1024 * 1024,
                processorCount: cpus,
                ...(create.nestedVirtualization === true ? { nestedVirtualization: true } : {}),
                notes: expectedMarker,
                checkpointType: parsed.backend === "linux-vm" ? "Production" : "ProductionOnly",
                deviceRoot,
                diskPath,
                baseImagePath: imagePath,
                baseImageSha256: expectedSha256,
                network,
            };
            const observation = await executeHyperVVmCreation(request, ports.creationEffects(session), effects, deadlineAt, () => { newVmAttempted = true; return undefined; });
            return { mode: "exec", provider: "hyper-v", status: 0, stdout: JSON.stringify({ ok: true, ...observation }), stderr: "" };
        }
        catch (error) {
            // Classify the triggering failure before cleanup performs further provider calls.
            const primaryTypedCommandFailed = ports.executionFailed(session);
            // A lost New-VM response leaves a VM with an unknown ID. The outer broker recovery
            // checks the owner-scoped name, marker and disk before deleting either VM or disk.
            if (!newVmAttempted || (expectedVmName && expectedMarker && effects.some((effect) => effect.kind === "vm-created"))) {
                await compensate(effects, {
                    removePath: async (compensation) => {
                        const cleanup = ports.compensationCommand(executable, deviceRoot, diskPath, compensation.kind, compensation.path);
                        const result = await ports.execute(cleanup, ports.remaining(deadlineAt, 30000), ports.outputLimit);
                        if (!hyperVCreateSucceeded(result))
                            throw new Error("hyper-v-create-compensation-failed");
                    },
                    removeVM: async (vmId) => {
                        const observed = await ports.vms(session, vmId);
                        const disks = await ports.disks(session, vmId);
                        if (observed.length !== 1 || observed[0]?.id !== vmId
                            || observed[0].name !== expectedVmName
                            || (observed[0].notes !== "" && observed[0].notes !== expectedMarker)
                            || disks.length !== 1 || disks[0]?.vmId !== vmId
                            || disks[0].path === null
                            || !ports.sameWindowsPath(disks[0].path, diskPath)) {
                            throw new Error("hyper-v-create-compensation-identity-mismatch");
                        }
                        await ports.removeVM(session, { selector: { kind: "id", id: vmId }, force: true, guard: {
                                expectedName: expectedVmName || "",
                                expectedNotes: observed[0].notes,
                                expectedDiskPaths: [diskPath],
                                ownedDiskDirectory: ports.windowsDirectory(diskPath),
                                expectedDvdPaths: [join(deviceRoot, "disks", parsed.backend === "linux-vm" ? "cidata.iso" : "autounattend.iso")],
                                ...(observed[0].notes === "" ? { unmarkedRootDiskPath: diskPath } : {}),
                            } });
                    },
                });
            }
            // The typed code and the primitive that raised it. The category alone (what
            // hyperVBoundedErrorCode keeps) left a failed Windows create undiagnosable.
            const code = ports.typedErrorCode(error, "hyper-v-vm-create-failed");
            const typedCreateOperation = ports.typedErrorOperation(error);
            const typedCreateInvalidResult = typedVhdInvalidResult
                || (!primaryTypedCommandFailed && ports.errorInfo(error)?.category === "protocol")
                || [
                    "hyper-v-create-invalid-result",
                    "hyper-v-created-disk-attachment-mismatch",
                    "hyper-v-created-disk-boot-order-mismatch",
                    "hyper-v-managed-network-adapter-unavailable",
                    "hyper-v-bootstrap-network-adapter-unavailable",
                ].includes(code);
            return {
                mode: "exec", provider: "hyper-v", status: 1, stdout: "", stderr: "", error: code, typedCreateInvalidResult,
                ...(typedCreateOperation ? { typedCreateOperation } : {}),
                typedCreateNativeDiagnostics: ports.nativeDiagnostics(error),
            };
        }
    }
    async function compensate(effects: readonly VmCreationEffect[], actions: {
        removePath(step: {
            kind: 'delete-file' | 'delete-directory';
            path: string;
        }): Promise<void>;
        removeVM(id: string): Promise<void>;
    }) { for (const step of ports.compensationOrder(effects)) {
        try {
            if (step.kind === 'remove-vm')
                await actions.removeVM(step.vmId);
            else
                await actions.removePath(step);
        }
        catch {
            if (step.kind === 'remove-vm')
                break;
        }
    } }
    async function recoverCreateResidue(ownerId: string, backend: string, deviceId: string, deadlineAt = Number.POSITIVE_INFINITY, incarnationId?: string | null): Promise<HyperVCreateRecovery> {
        const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
        if (!powershell)
            return { ok: false, status: 503, error: "missing-provider-command", detail: "powershell" };
        if (backend !== "windows-vm" && backend !== "linux-vm")
            return { ok: false, status: 400, error: "hyper-v-backend-invalid" };
        const privateRoot = ports.privateRoot(ownerId, backend, deviceId);
        let expectedIncarnationId = ports.validIncarnation(incarnationId) ? incarnationId : null;
        if (!expectedIncarnationId) {
            try {
                expectedIncarnationId = ports.incarnationRecord(ownerId, backend, deviceId)?.incarnationId || null;
            }
            catch (error) {
                return {
                    ok: false,
                    status: 409,
                    error: "hyper-v-incarnation-record-invalid",
                    detail: ports.boundedErrorCode(error, "hyper-v-incarnation-record-invalid"),
                };
            }
        }
        if (!expectedIncarnationId) {
            if (ports.exists(privateRoot))
                return { ok: false, status: 409, error: "hyper-v-incarnation-record-missing" };
            const allocation = await ports.releaseNetwork(ownerId, deviceId, null, deadlineAt, false);
            return allocation.ok
                ? { ok: true, recoveredVm: false, removedDisk: false, releasedAddress: allocation.released }
                : {
                    ok: false,
                    status: 502,
                    error: "hyper-v-recovery-cleanup-failed",
                    stage: "network-release",
                    detail: typeof allocation.error === "string"
                        && /^hyper-v-[a-z0-9-]{3,128}$/.test(allocation.error)
                        ? allocation.error
                        : "hyper-v-network-cleanup-failed",
                };
        }
        const deviceRoot = ports.deviceRoot(ownerId, backend, deviceId);
        const diskPath = join(deviceRoot, "disks", "root.vhdx");
        let observation: {
            recoveredVm: boolean;
            removedDisk: boolean;
        };
        try {
            observation = await ports.recoverVM(powershell, { vmName: ports.vmName(ownerId, deviceId, expectedIncarnationId), ownershipNotes: ports.marker(ownerId, deviceId, expectedIncarnationId), deviceRoot, diskPath, auxiliaryMediaPaths: [join(deviceRoot, 'disks', backend === 'linux-vm' ? 'cidata.iso' : 'autounattend.iso')] }, deadlineAt);
            ports.assertDeadline(deadlineAt);
        }
        catch (error) {
            return {
                ok: false,
                status: 502,
                error: "hyper-v-recovery-failed",
                detail: ports.typedErrorCode(error, "hyper-v-recovery-failed"),
            };
        }
        // Create compensation keeps the shared fabric. The incarnation-less branch above stays
        // destructive: preservation there would only turn into an incarnation conflict.
        const allocation = await ports.releaseNetwork(ownerId, deviceId, expectedIncarnationId, deadlineAt, true);
        // A failed release leaves the artifacts untouched, so it is reported as itself: the network
        // code, named by its stage, rather than an artifact cleanup that was never attempted.
        if (!allocation.ok) {
            return {
                ok: false,
                status: 502,
                error: "hyper-v-recovery-cleanup-failed",
                stage: "network-release",
                detail: typeof allocation.error === "string"
                    && /^hyper-v-[a-z0-9-]{3,128}$/.test(allocation.error)
                    ? allocation.error
                    : "hyper-v-network-cleanup-failed",
            };
        }
        const artifacts = ports.cleanupArtifacts(ownerId, backend, deviceId);
        if (!artifacts.ok) {
            return {
                ok: false,
                status: 502,
                error: "hyper-v-recovery-cleanup-failed",
                detail: "hyper-v-artifact-cleanup-failed",
            };
        }
        return { ok: true, recoveredVm: observation.recoveredVm, removedDisk: observation.removedDisk, releasedAddress: allocation.released };
    }
    function quotaUsage(devices: unknown[]): HyperVQuotaUsage {
        const usage: HyperVQuotaUsage = { definedVms: 0, configuredMemoryMb: 0, configuredCpus: 0, configuredDiskBytes: 0, runningVms: 0, runningMemoryMb: 0, runningCpus: 0 };
        for (const device of devices) {
            if (!hyperVCreateRecord(device))
                throw new Error('hyper-v-owner-quota-device-invalid');
            const memory = hyperVQuotaResource(device, 'memoryMb');
            const cpus = hyperVQuotaResource(device, 'cpus');
            let disk: number;
            const stored = device.diskMaxBytes;
            if (Number.isSafeInteger(stored) && Number(stored) > 0)
                disk = Number(stored);
            else {
                const profile = ports.imageProfile(device.profile);
                if (!profile)
                    throw new Error('hyper-v-owner-quota-diskMaxBytes-invalid');
                disk = ports.imageVirtualSize(profile);
            }
            usage.definedVms++;
            usage.configuredMemoryMb += memory;
            usage.configuredCpus += cpus;
            usage.configuredDiskBytes += disk;
            if (String(device.status || '').toLowerCase() === 'running' || String(device.runtimeState || '').toLowerCase() === 'running') {
                usage.runningVms++;
                usage.runningMemoryMb += memory;
                usage.runningCpus += cpus;
            }
        }
        return usage;
    }
    function checkQuota(ownerId: string, parsed: HyperVLifecycleRequest): HyperVLifecycleResponse | null {
        if (parsed.command !== "device_create" && parsed.command !== "device_start" && parsed.command !== "device_reboot")
            return null;
        let devices: unknown[];
        let targetDevices: unknown[];
        let usage: HyperVQuotaUsage;
        try {
            targetDevices = ports.read(ownerId, parsed.stateKey);
            devices = [...ports.read(ownerId, "windows-vm"), ...ports.read(ownerId, "linux-vm")];
            usage = quotaUsage(devices);
        }
        catch (error) {
            const stateCode = ports.stateErrorCode(error);
            if (stateCode)
                return ports.stateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
            return {
                status: 409,
                payload: {
                    ok: false,
                    error: "hyper-v-owner-quota-state-invalid",
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    detail: ports.boundedErrorCode(error, "hyper-v-owner-quota-state-invalid"),
                },
            };
        }
        const requested = { definedVms: 0, configuredMemoryMb: 0, configuredCpus: 0, configuredDiskBytes: 0, runningVms: 0, runningMemoryMb: 0, runningCpus: 0 };
        if (parsed.command === "device_create") {
            const memoryMb = typeof parsed.create?.memoryMb === "number" ? parsed.create.memoryMb : 4096;
            const cpus = typeof parsed.create?.cpus === "number" ? parsed.create.cpus : 2;
            const diskMaxBytes = typeof parsed.create?.diskMaxBytes === "number" ? parsed.create.diskMaxBytes : 0;
            if (!Number.isSafeInteger(memoryMb) || memoryMb < 1024 || memoryMb > 131072
                || !Number.isSafeInteger(cpus) || cpus < 1 || cpus > 64
                || !Number.isSafeInteger(diskMaxBytes) || diskMaxBytes < 0)
                return null;
            requested.definedVms = 1;
            requested.configuredMemoryMb = memoryMb;
            requested.configuredCpus = cpus;
            requested.configuredDiskBytes = diskMaxBytes;
        }
        else {
            const target = hyperVSelectedDevice(targetDevices, parsed.deviceId);
            if (!target)
                return null;
            const alreadyRunning = String(target.status || "").toLowerCase() === "running"
                || String(target.runtimeState || "").toLowerCase() === "running";
            if (!alreadyRunning && (parsed.command !== "device_reboot" || parsed.startIfStopped === true)) {
                requested.runningVms = 1;
                requested.runningMemoryMb = hyperVQuotaResource(target, "memoryMb");
                requested.runningCpus = hyperVQuotaResource(target, "cpus");
            }
        }
        const projected = hyperVQuotaProjection(usage, requested);
        const quota = ports.quota;
        const violations = [
            projected.definedVms > quota.maxDefinedVms ? "defined-vms" : null,
            projected.configuredMemoryMb > quota.maxConfiguredMemoryMb ? "configured-memory-mb" : null,
            projected.configuredCpus > quota.maxConfiguredCpus ? "configured-cpus" : null,
            projected.configuredDiskBytes > quota.maxConfiguredDiskBytes ? "configured-disk-bytes" : null,
            projected.runningVms > quota.maxRunningVms ? "running-vms" : null,
            projected.runningMemoryMb > quota.maxRunningMemoryMb ? "running-memory-mb" : null,
            projected.runningCpus > quota.maxRunningCpus ? "running-cpus" : null,
        ].filter((value): value is string => Boolean(value));
        if (violations.length === 0)
            return null;
        return {
            status: 409,
            payload: {
                ok: false,
                error: "hyper-v-owner-quota-exceeded",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                violations,
                usage,
                requested,
                projected,
                quota,
            },
        };
    }
    async function invoke(ownerId: string, params: unknown, parsed: HyperVCreateStartRequest, deadlineAt = Number.POSITIVE_INFINITY, cleanupDeadlineAt = deadlineAt): Promise<HyperVLifecycleResponse> {
        ports.assertDeadline(deadlineAt);
        if(parsed.dryRun&&parsed.command!=="device_create")return execute(ownerId,parsed,params,deadlineAt,cleanupDeadlineAt);
        if (!parsed.dryRun && (parsed.command==="device_start"||parsed.command==="device_reboot")) {
            ports.forgetConsole(ownerId, parsed.backend, parsed.deviceId);
        }
        if (parsed.command !== "device_create") {
            if (!parsed.dryRun) {
                let expectedIncarnationId: string | null = null;
                try {
                    const current = hyperVSelectedDevice(ports.read(ownerId, parsed.stateKey), parsed.deviceId);
                    expectedIncarnationId = current ? ports.incarnation(current) : null;
                    if (!expectedIncarnationId)
                        expectedIncarnationId = ports.readJournal(ownerId, parsed.backend, parsed.deviceId)?.incarnationId || null;
                }
                catch (error) {
                    const stateCode = ports.stateErrorCode(error);
                    if (stateCode)
                        return ports.stateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
                    return {
                        status: 409,
                        payload: {
                            ok: false,
                            error: "hyper-v-operation-journal-invalid",
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                            detail: ports.boundedErrorCode(error, "hyper-v-operation-journal-invalid"),
                        },
                    };
                }
                if (expectedIncarnationId) {
                    if (!ports.validIncarnation(parsed.expectedIncarnationId)) {
                        return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-required", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
                    }
                    if (parsed.expectedIncarnationId !== expectedIncarnationId) {
                        return { status: 409, payload: { ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
                    }
                }
            }
            // Only an explicit device_delete may tear the shared fabric down. Replaying a pending
            // delete journal ahead of any other command is compensation and keeps it.
            const reconciliation = await ports.reconcileOperation(ownerId, parsed.backend, parsed.deviceId, deadlineAt, true);
            if (!reconciliation.ok)
                return { status: reconciliation.status, payload: { ok: false, error: reconciliation.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, ...(reconciliation.detail ? { detail: reconciliation.detail } : {}) } };
            if (!parsed.dryRun) {
                let snapshotJournal: SnapshotJournal | null;
                try {
                    snapshotJournal = ports.readSnapshotJournal(ownerId, parsed.backend, parsed.deviceId);
                }
                catch (error) {
                    return { status: 409, payload: { ok: false, error: "hyper-v-snapshot-journal-invalid", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, detail: ports.boundedErrorCode(error, "hyper-v-snapshot-journal-invalid") } };
                }
                if (snapshotJournal) {
                    const current = hyperVSelectedDevice(ports.read(ownerId, parsed.stateKey), parsed.deviceId);
                    if (!current)
                        return { status: 409, payload: { ok: false, error: "hyper-v-snapshot-reconciliation-metadata-invalid", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
                    const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
                    if (!powershell)
                        return { status: 400, payload: { ok: false, error: "missing-provider-command", missing: ["powershell"], backend: parsed.backend, deviceId: parsed.deviceId } };
                    const snapshotReconciliation = await ports.repairSnapshots(ownerId, parsed.backend, parsed.deviceId, current, powershell);
                    if (!snapshotReconciliation.ok) {
                        return { status: snapshotReconciliation.status, payload: { ok: false, error: snapshotReconciliation.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, ...(snapshotReconciliation.detail ? { detail: snapshotReconciliation.detail } : {}) } };
                    }
                }
            }
            const quotaFailure = checkQuota(ownerId, parsed);
            if (quotaFailure)
                return quotaFailure;
            if (parsed.dryRun)
                return await execute(ownerId, parsed, params, deadlineAt, cleanupDeadlineAt);
            const plan = ports.planning(ownerId, params);
            if (plan.response.status !== 200)
                return plan.response;
            if (plan.result?.idempotent) {
                return await execute(ownerId, parsed, params, deadlineAt, cleanupDeadlineAt);
            }
            const journal = ports.writeJournal(ownerId, parsed);
            if (!journal.ok)
                return { status: 409, payload: { ok: false, error: "hyper-v-operation-journal-write-failed", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, detail: journal.error } };
            const result = await execute(ownerId, parsed, params, deadlineAt, cleanupDeadlineAt);
            if (result.status >= 200 && result.status < 300) {
                ports.clearJournal(ownerId, parsed.backend, parsed.deviceId);
            }
            else if (result.status < 500) {
                ports.clearJournal(ownerId, parsed.backend, parsed.deviceId);
            }
            return result;
        }
        const preImportQuotaFailure = checkQuota(ownerId, parsed);
        if (preImportQuotaFailure)
            return preImportQuotaFailure;
        let existing: unknown[];
        try {
            existing = ports.read(ownerId, parsed.stateKey);
        }
        catch (error) {
            return ports.stateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
        }
        if (!parsed.dryRun && (existing.some((candidate) => hyperVCreateRecord(candidate) && candidate.id === parsed.deviceId)
            || ports.exists(ports.journalPath(ownerId, parsed.backend, parsed.deviceId)))) {
            // Journal replay ahead of a create is compensation, so it keeps the shared fabric.
            const operationReconciliation = await ports.reconcileOperation(ownerId, parsed.backend, parsed.deviceId, deadlineAt, true);
            if (!operationReconciliation.ok)
                return { status: operationReconciliation.status, payload: { ok: false, error: operationReconciliation.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, ...(operationReconciliation.detail ? { detail: operationReconciliation.detail } : {}) } };
            existing = ports.read(ownerId, parsed.stateKey);
        }
        if (!parsed.dryRun && ports.exists(ports.snapshotJournalPath(ownerId, parsed.backend, parsed.deviceId))) {
            const current = hyperVSelectedDevice(existing, parsed.deviceId);
            if (!current)
                return { status: 409, payload: { ok: false, error: "hyper-v-snapshot-reconciliation-metadata-invalid", ownerId, backend: parsed.backend, deviceId: parsed.deviceId } };
            const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
            if (!powershell)
                return { status: 400, payload: { ok: false, error: "missing-provider-command", missing: ["powershell"], backend: parsed.backend, deviceId: parsed.deviceId } };
            const snapshotReconciliation = await ports.repairSnapshots(ownerId, parsed.backend, parsed.deviceId, current, powershell);
            if (!snapshotReconciliation.ok)
                return { status: snapshotReconciliation.status, payload: { ok: false, error: snapshotReconciliation.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, ...(snapshotReconciliation.detail ? { detail: snapshotReconciliation.detail } : {}) } };
            existing = ports.read(ownerId, parsed.stateKey);
        }
        if (existing.some((candidate) => hyperVCreateRecord(candidate) && candidate.id === parsed.deviceId)) {
            return await execute(ownerId, parsed, params, deadlineAt, cleanupDeadlineAt);
        }
        const siblingBackend = parsed.backend === "windows-vm" ? "linux-vm" : "windows-vm";
        if (ports.read(ownerId, siblingBackend).some((candidate) => hyperVCreateRecord(candidate) && candidate.id === parsed.deviceId)) {
            return { status: 409, payload: { ok: false, error: "hyper-v-device-id-conflict", ownerId, backend: parsed.backend, conflictingBackend: siblingBackend, deviceId: parsed.deviceId } };
        }
        try {
            if (!parsed.dryRun) {
                const recovery = await recoverCreateResidue(ownerId, parsed.backend, parsed.deviceId, deadlineAt);
                if (!recovery.ok)
                    return { status: recovery.status, payload: { ok: false, error: recovery.error, ownerId, backend: parsed.backend, deviceId: parsed.deviceId, ...(recovery.detail ? { detail: recovery.detail } : {}), ...(recovery.stage ? { stage: recovery.stage } : {}) } };
            }
            const image = await ports.resolveImage(ownerId, parsed, params, deadlineAt);
            if (!image.ok) {
                return {
                    status: image.status,
                    payload: {
                        ok: false,
                        error: image.error,
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        ...(image.detail ? { detail: image.detail } : {}),
                        ...(image.remedy ? { remedy: image.remedy } : {}),
                    },
                };
            }
            const parsedImage = ports.parse(image.params);
            if (!parsedImage.ok)
                return parsedImage.response;
            const resolved = parsedImage.request;
            const quotaFailure = checkQuota(ownerId, resolved);
            if (quotaFailure)
                return quotaFailure;
            if (resolved.dryRun)
                return await execute(ownerId, resolved, image.params, deadlineAt, cleanupDeadlineAt);
            const incarnationId = ports.newIncarnation();
            const withIncarnation = (base: unknown) => ({
                ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
                incarnationId,
            });
            try {
                ports.writeIncarnation(ownerId, resolved.backend, resolved.deviceId, incarnationId);
            }
            catch (error) {
                return {
                    status: 409,
                    payload: {
                        ok: false,
                        error: "hyper-v-incarnation-record-write-failed",
                        ownerId,
                        backend: resolved.backend,
                        deviceId: resolved.deviceId,
                        detail: ports.boundedErrorCode(error, "hyper-v-incarnation-record-write-failed"),
                    },
                };
            }
            if (resolved.create?.networking === false) {
                return await executeParsed(ownerId, withIncarnation(image.params), deadlineAt, cleanupDeadlineAt);
            }
            const allocation = await ports.allocateNetwork(ownerId, resolved.deviceId, incarnationId, deadlineAt);
            if (!allocation.ok) {
                const artifactCleanup = allocation.preserveEvidence
                    ? { ok: true, removed: false, preserved: true, reason: "hyper-v-network-state-indeterminate" }
                    : ports.cleanupArtifacts(ownerId, resolved.backend, resolved.deviceId);
                return {
                    status: artifactCleanup.ok ? allocation.status : 502,
                    payload: {
                        ok: false,
                        error: artifactCleanup.ok ? allocation.error : "hyper-v-allocation-failure-artifact-cleanup-failed",
                        ownerId,
                        backend: resolved.backend,
                        deviceId: resolved.deviceId,
                        ...(allocation.detail ? { detail: allocation.detail } : {}),
                        ...(allocation.execution ? { execution: allocation.execution } : {}),
                        artifactCleanup: ports.publicArtifacts(artifactCleanup),
                    },
                };
            }
            const networkParams = {
                ...withIncarnation(image.params),
                switchName: allocation.switchName,
                networkAddress: allocation.address,
                macAddress: allocation.macAddress,
                networkGateway: allocation.gateway,
                networkPrefix: allocation.prefix,
                outboundPolicy: allocation.outboundPolicy,
            };
            const result = await executeParsed(ownerId, networkParams, deadlineAt, cleanupDeadlineAt);
            if (result.status < 200 || result.status >= 300) {
                const lifecyclePayload = hyperVCreateRecord(result.payload)
                    ? result.payload
                    : null;
                const lifecycleRollback = lifecyclePayload && hyperVCreateRecord(lifecyclePayload.rollback)
                    ? lifecyclePayload.rollback
                    : null;
                if (lifecycleRollback)
                    return result;
                const reconciliation = await recoverCreateResidue(ownerId, resolved.backend, resolved.deviceId, cleanupDeadlineAt, incarnationId);
                if (!reconciliation.ok) {
                    return {
                        status: 502,
                        payload: {
                            ok: false,
                            error: "hyper-v-create-allocation-cleanup-failed",
                            ownerId,
                            backend: resolved.backend,
                            deviceId: resolved.deviceId,
                            detail: reconciliation.detail || reconciliation.error,
                            ...(reconciliation.stage ? { stage: reconciliation.stage } : {}),
                            lifecycleFailure: result.payload,
                        },
                    };
                }
            }
            return result;
        }
        catch (error) {
            const deadlineError = ports.deadlineError(error);
            if (!deadlineError)
                throw error;
            const rollback = await recoverCreateResidue(ownerId, parsed.backend, parsed.deviceId, cleanupDeadlineAt);
            if (!rollback.ok) {
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-create-deadline-cleanup-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        deadlineError: deadlineError,
                        rollback,
                    },
                };
            }
            return {
                status: 504,
                payload: {
                    ok: false,
                    error: deadlineError,
                    ownerId,
                    backend: parsed.backend,
                    deviceId: parsed.deviceId,
                    rollback,
                },
            };
        }
    }
function hyperVGuestReadinessFailureDetail(
    backend: "windows-vm" | "linux-vm",
    result: HyperVNativeExecution,
): HyperVGuestReadinessFailureDetail {
    const diagnosticCode = ports.diagnosticCode(result);
    return {
        ...(backend === "windows-vm"
            ? { structured: Boolean(ports.parseReadyFailure(result.stdout || "")) }
            : {}),
        status: typeof result.status === "number" ? result.status : null,
        timedOut: result.timedOut === true,
        stdoutBytes: Buffer.byteLength(String(result.stdout || ""), "utf8"),
        stderrBytes: Buffer.byteLength(String(result.stderr || ""), "utf8"),
        ...(diagnosticCode ? { diagnosticCode } : {}),
    };
}

function hyperVGuestReadinessFailureCode(backend: "windows-vm" | "linux-vm", result: HyperVNativeExecution): string {
    if (backend === "windows-vm") {
        const observation = ports.parseReadyFailure(result.stdout || "");
        if (observation) return observation.reason;
        const error = String(result.error || "");
        if (error.length <= 128 && /^hyper-v-[a-z0-9-]+$/.test(error)) return error;
        return result.timedOut ? "powershell-direct-timeout" : "powershell-direct-unavailable";
    }
    const error = String(result.error || "");
    if (/^hyper-v-linux-gui-(?:(?:privilege|apt-update|apt-install|configure|start|ready)-failed|timeout)$/.test(error)) return error;
    const diagnostic = `${error}\n${result.stderr || ""}`.toLowerCase();
    if (diagnostic.includes("connection refused")) return "ssh-connection-refused";
    if (diagnostic.includes("connection timed out") || diagnostic.includes("operation timed out") || result.timedOut) return "ssh-connection-timeout";
    if (diagnostic.includes("no route to host") || diagnostic.includes("host is down")) return "ssh-host-unreachable";
    if (diagnostic.includes("host key verification failed") || diagnostic.includes("remote host identification has changed")) return "ssh-host-key-rejected";
    if (diagnostic.includes("permission denied") || diagnostic.includes("authentication failed")) return "ssh-authentication-failed";
    if (error.length <= 128 && /^hyper-v-[a-z0-9-]+$/.test(error)) return error;
    return "ssh-unavailable";
}

    function createRecord(ownerId:string,parsed:HyperVLifecycleRequest):Record<string,unknown>{const create=parsed.create||{};const timestamp=ports.timestamp();const name=String(create.name||parsed.deviceId);const incarnation=String(create.incarnationId||'');const vmName=ports.vmName(ownerId,parsed.deviceId,incarnation);const deviceRoot=ports.deviceRoot(ownerId,parsed.backend,parsed.deviceId);const privateRoot=ports.privateRoot(ownerId,parsed.backend,parsed.deviceId);return hyperVDeviceDefinition(ownerId,parsed,{name,timestamp,vmName,deviceRoot,privateRoot,validIncarnation:ports.validIncarnation(create.incarnationId)});}

    async function rollbackCreate(parsed: HyperVLifecycleRequest, device: Record<string, unknown>, existing: Record<string, unknown> | null, hyperVDeadlineAt: number) {
        if (existing?.vmId === device.vmId || existing?.vmName === device.vmName || existing?.diskPath === device.diskPath) {
            return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
        }
        const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
        const incarnationId = device && typeof device === "object" && !Array.isArray(device)
            ? ports.incarnation(device)
            : null;
        if (!powershell || !incarnationId || typeof device.vmName !== "string" || typeof device.diskPath !== "string" || typeof device.deviceRoot !== "string") {
            return { attempted: false, ok: false, reason: "created-hyper-v-vm-identity-missing" };
        }
        try {
            const observation = await ports.recoverVM(powershell, {
                vmName: device.vmName,
                ownershipNotes: ports.marker(String(device.ownerId), String(device.id), incarnationId),
                deviceRoot: device.deviceRoot,
                diskPath: device.diskPath,
                auxiliaryMediaPaths: [
                    join(device.deviceRoot, "disks", parsed.backend === "linux-vm" ? "cidata.iso" : "autounattend.iso"),
                ],
            }, hyperVDeadlineAt);
            ports.assertDeadline(hyperVDeadlineAt);
            const result: HyperVNativeExecution = {
                mode: "exec", provider: "hyper-v", status: 0,
                stdout: JSON.stringify({ ok: true, recoveredVm: observation.recoveredVm, removedDisk: observation.removedDisk }),
            };
            const publicResult = redactExecution(result, true, "hyper-v-rollback-command-failed");
            // Compensation, not a delete request: keep the shared fabric so a failed create never
            // needs Administrator to tear it down.
            const allocation = await ports.releaseNetwork(String(device.ownerId), String(device.id), incarnationId, hyperVDeadlineAt, true);
            // A failed release leaves the artifacts untouched, so it is reported as itself: the
            // network code, named by its stage, beside artifacts that were never attempted.
            if (!allocation.ok) {
                return {
                    attempted: true,
                    ok: false,
                    stage: "network-release",
                    result: publicResult,
                    artifacts: { ok: false, attempted: false, removed: false },
                    allocation: {
                        ok: false,
                        released: allocation.released,
                        error: typeof allocation.error === "string"
                            && /^hyper-v-[a-z0-9-]{3,128}$/.test(allocation.error)
                            ? allocation.error
                            : "hyper-v-network-cleanup-failed",
                    },
                };
            }
            const artifacts = ports.cleanupArtifacts(String(device.ownerId), parsed.backend, String(device.id));
            if (!artifacts.ok) {
                return {
                    attempted: true,
                    ok: false,
                    result: publicResult,
                    artifacts: { ok: false, removed: artifacts.removed, error: "hyper-v-artifact-cleanup-failed" },
                    allocation: { ok: true, released: allocation.released },
                };
            }
            return {
                attempted: true,
                ok: true,
                result: publicResult,
                observation: {
                    recoveredVm: observation.recoveredVm,
                    removedDisk: observation.removedDisk,
                },
                artifacts: { ok: true, removed: artifacts.removed },
                allocation: {
                    ok: true,
                    released: allocation.released,
                },
            };
        }
        catch (error) {
            // Typed, like create-residue recovery: a native Remove-VM failure keeps its id.
            const code = ports.typedErrorCode(error, "hyper-v-rollback-command-failed");
            return {
                attempted: true,
                ok: false,
                reason: ports.errorInfo(error)?.category === "protocol"
                    ? "hyper-v-rollback-invalid-result" : "hyper-v-rollback-command-failed",
                result: redactExecution({ mode: "exec", provider: "hyper-v", status: 1, error: code }, true, "hyper-v-rollback-command-failed"),
            };
        }
    }
    function redactExecution(execution: HyperVNativeExecution, _redact: boolean, fallback?: string) { return ports.redactExecution(execution, fallback); }
    function publishStarted(owner: string, request: HyperVLifecycleRequest, expected: unknown, execution: HyperVNativeExecution, ready: HyperVGuestReadyObservation | null) { return ports.publish(owner, request.stateKey, request.deviceId, expected, current => { const observation = ports.parseVm(execution.stdout || ''); return { ...current, status: 'running', ...(observation ? { vmId: observation.vmId, vmName: observation.vmName, runtimeState: observation.state, hyperVStatus: observation.status } : {}), bootReady: Boolean(ready), lastBootCheck: ready ? { ready: true, provider: request.backend === 'linux-vm' ? 'hyper-v-ssh' : 'hyper-v-powershell-direct', computerName: ready.computerName, attempts: ready.attempts } : null, updatedAt: ports.timestamp() }; }); }
    async function execute(ownerId: string, parsed: HyperVCreateStartRequest, params: unknown, hyperVDeadlineAt: number, hyperVCleanupDeadlineAt: number): Promise<HyperVLifecycleResponse> {
        const expectedObservation: {
            device?: unknown;
        } = {};
        const planned = ports.planning(ownerId, params, expectedObservation);
        let expectedDevice = expectedObservation.device;
        if (planned.response.status !== 200)
            return planned.response;
        const payload = { result: planned.result };
        if (parsed.dryRun) {
            return {
                status: 200,
                payload: {
                    ok: true,
                    result: {
                        ...(ports.redactResult(payload.result)),
                        invoked: false,
                        dryRun: true,
                        execution: {
                            mode: "dry-run",
                            providerExecution: "available",
                            mutatesHost: false,
                        },
                    },
                },
            };
        }
        if (payload.result?.idempotent) {
            return {
                status: 200,
                payload: {
                    ok: true,
                    result: {
                        ...(ports.redactResult(payload.result)),
                        invoked: false,
                        dryRun: false,
                        execution: { mode: "idempotent", providerExecution: "not-required", mutatesHost: false },
                    },
                },
            };
        }
    if (parsed.command === "device_create") {
        const providerCommand = payload.result?.providerCommand;
        if (providerCommand && "error" in providerCommand) {
            return {
                status: 400,
                payload: {
                    ok: false,
                    error: providerCommand.error,
                    missing: providerCommand.missing || [],
                    plan: ports.redactResult(payload.result),
                },
            };
        }
        let execution: HyperVNativeExecution = { mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "" };
        let hyperVProvisioningExecution: Record<string, unknown> | null = null;
        if (providerCommand && providerCommand.mode !== "noop") {
            {
                try {
                    ports.ensurePrivateRoot(ownerId, parsed.backend, parsed.deviceId);
                }
                catch (error) {
                    return {
                        status: 409,
                        payload: {
                            ok: false,
                            error: "hyper-v-private-root-invalid",
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                            detail: ports.boundedErrorCode(error, "hyper-v-private-root-invalid"),
                        },
                    };
                }
            }
            execution =
                await createVmFromImage(ownerId, parsed, providerCommand.executable || "powershell.exe", hyperVDeadlineAt);
            if (ports.deadlineExpired(hyperVDeadlineAt)) {
                const rollback = await recoverCreateResidue(ownerId, parsed.backend, parsed.deviceId, hyperVCleanupDeadlineAt, (typeof parsed.create?.incarnationId === "string" ? parsed.create.incarnationId : undefined));
                return {
                    status: 504,
                    payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback },
                };
            }
            if (!hyperVCreateSucceeded(execution)) {
                const rollback = await recoverCreateResidue(ownerId, parsed.backend, parsed.deviceId, hyperVCleanupDeadlineAt, (typeof parsed.create?.incarnationId === "string" ? parsed.create.incarnationId : undefined));
                const hyperVExecution = redactExecution(execution, true, "hyper-v-provider-command-failed");
                return {
                    status: 502,
                    payload: {
                        ok: false,
                        error: execution.typedCreateInvalidResult === true
                            ? "hyper-v-create-invalid-result"
                            : "provider-command-failed",
                        detail: hyperVExecution?.diagnosticCode || ports.failureDetail(execution),
                        // The typed primitive behind the detail, from the library's closed list.
                        ...(execution.typedCreateOperation
                            ? { operation: execution.typedCreateOperation }
                            : {}),
                        ...(execution.typedCreateNativeDiagnostics),
                        ...(rollback ? { rollback } : {}),
                        result: {
                            ...(ports.redactResult(payload.result)),
                            invoked: true,
                            dryRun: false,
                            execution: {
                                mode: execution.mode,
                                providerExecution: "executed",
                                mutatesHost: false,
                                ...({}),
                            },
                        },
                    },
                };
            }
        }
        let persistedParsed = parsed;
        if (parsed.backend === "linux-vm" && execution.mode !== "noop") {
            const observation = ports.parseVm(execution.stdout || "");
            const expectedVmName = ports.vmName(ownerId, parsed.deviceId, String(parsed.create?.incarnationId || ""));
            const deviceRoot = ports.deviceRoot(ownerId, "linux-vm", parsed.deviceId);
            const privateRoot = ports.privateRoot(ownerId, "linux-vm", parsed.deviceId);
            const expectedDiskPath = join(deviceRoot, "disks", "root.vhdx");
            if (!observation
                || observation.vmName !== expectedVmName
                || !ports.samePath(observation.diskPath || "", expectedDiskPath)
                || (observation.generation !== 1 && observation.generation !== 2)
                || (observation.generation!==1&&observation.generation!==2)
                || observation.generation !== parsed.create?.baseImageGeneration) {
                const rollback = await recoverCreateResidue(ownerId, parsed.backend, parsed.deviceId, hyperVCleanupDeadlineAt, (typeof parsed.create?.incarnationId === "string" ? parsed.create.incarnationId : undefined));
                return { status: 502, payload: { ok: false, error: "hyper-v-create-invalid-result", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            const guestUsername = `ccc${ownerId.slice(0, 8)}`;
            const seedDiskPath = join(deviceRoot, "disks", "cidata.iso");
            const sshPrivateKeyPath = join(privateRoot, "secrets", "id_ed25519");
            const sshPublicKeyPath = `${sshPrivateKeyPath}.pub`;
            const sshHostPrivateKeyPath = join(privateRoot, "secrets", "ssh_host_ed25519_key");
            const sshHostPublicKeyPath = `${sshHostPrivateKeyPath}.pub`;
            const knownHostsPath = join(privateRoot, "secrets", "known_hosts");
            const observedParsed = { ...parsed, create: { ...(parsed.create || {}), vmId: observation.vmId, guestUsername } };
            const rollbackDevice = createRecord(ownerId, observedParsed);
            const rollbackProvisioning = () => {
                return rollbackCreate(observedParsed, rollbackDevice, null, hyperVCleanupDeadlineAt);
            };
            const seedDeadlineAt = Math.min(hyperVDeadlineAt, ports.now() + 180000);
            const seedTarget = {
                executable: providerCommand?.executable || "powershell.exe",
                vmId: observation.vmId,
                vmName: expectedVmName,
                expectedNotes: ports.marker(ownerId, parsed.deviceId, String(parsed.create?.incarnationId || "")),
                generation: observation.generation,
                osDiskPath: expectedDiskPath,
                mediaPath: seedDiskPath,
                managedMacAddress: String(parsed.create?.macAddress || "")
            };
            try {
                await ports.inspectSeed(seedTarget, seedDeadlineAt);
            }
            catch (cause) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-linux-seed-failed", ownerId, deviceId: parsed.deviceId,
                        detail: ports.seedFailureCode(cause, "hyper-v-linux-seed-preflight-command-failed"), rollback } };
            }
            if (ports.deadlineExpired(seedDeadlineAt)) {
                const rollback = await rollbackProvisioning();
                return { status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            let seedCommand: HyperVNativeCommand;
            try {
                ports.assertPrivateRoot(ownerId, "linux-vm", parsed.deviceId, privateRoot);
                seedCommand = ports.seedCommand({
                    executable: providerCommand?.executable || "powershell.exe",
                    ownerId,
                    deviceId: parsed.deviceId,
                    incarnationId: String(parsed.create?.incarnationId || ""),
                    vmName: expectedVmName,
                    vmId: observation.vmId,
                    diskPath: expectedDiskPath,
                    deviceRoot,
                    privateRoot,
                    seedDiskPath,
                    sshPrivateKeyPath,
                    sshPublicKeyPath,
                    sshHostPrivateKeyPath,
                    sshHostPublicKeyPath,
                    knownHostsPath,
                    guestUsername,
                    networkAddress: String(parsed.create?.networkAddress || ""),
                    networkGateway: String(parsed.create?.networkGateway || ""),
                    networkPrefixLength: typeof parsed.create?.networkPrefix === "string" ? Number(parsed.create.networkPrefix.split("/")[1]) : 24,
                    macAddress: String(parsed.create?.macAddress || ""),
                });
            }
            catch (error) {
                const rollback = await rollbackProvisioning();
                return {
                    status: rollback.ok ? 500 : 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-linux-seed-plan-failed",
                        ownerId,
                        deviceId: parsed.deviceId,
                        detail: ports.boundedErrorCode(error, "hyper-v-linux-seed-plan-failed"),
                        rollback,
                    },
                };
            }
            const seedExecution = await ports.execute(seedCommand, ports.remaining(seedDeadlineAt, 180000), ports.outputLimit);
            hyperVProvisioningExecution = redactExecution(seedExecution, true, "hyper-v-linux-seed-command-failed");
            if (ports.deadlineExpired(seedDeadlineAt)) {
                const rollback = await rollbackProvisioning();
                return { status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            if (!hyperVCreateSucceeded(seedExecution)) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-linux-seed-failed", ownerId, deviceId: parsed.deviceId, provisioning: hyperVProvisioningExecution, rollback } };
            }
            let seedResult: Record<string, unknown> | null = null;
            try {
                const line = String(seedExecution.stdout || "").trim().split(/\r?\n/).at(-1) || "";
                const value = JSON.parse(line);
                seedResult = hyperVCreateRecord(value) ? value : null;
            }
            catch {
                seedResult = null;
            }
            const sshHostKeyFingerprint = String(seedResult?.sshHostKeyFingerprint || "");
            let seedFilesAvailable = false;
            try {
                seedFilesAvailable = Boolean(seedResult
                    && String(seedResult.vmName || "") === expectedVmName
                    && String(seedResult.guestUsername || "") === guestUsername
                    && String(seedResult.networkAddress || "") === String(parsed.create?.networkAddress || "")
                    && ports.samePath(String(seedResult.sshPrivateKeyPath || ""), sshPrivateKeyPath)
                    && ports.samePath(String(seedResult.sshPublicKeyPath || ""), sshPublicKeyPath)
                    && ports.samePath(String(seedResult.sshHostPublicKeyPath || ""), sshHostPublicKeyPath)
                    && ports.samePath(String(seedResult.knownHostsPath || ""), knownHostsPath)
                    && /^SHA256:[A-Za-z0-9+/]{43}$/.test(sshHostKeyFingerprint)
                    && ports.validateHostIdentity(ownerId, parsed.deviceId, sshHostPublicKeyPath, knownHostsPath, String(parsed.create?.networkAddress || ""), sshHostKeyFingerprint));
            }
            catch {
                seedFilesAvailable = false;
            }
            if (!seedResult || seedResult.ok !== true || String(seedResult.vmId).toLowerCase() !== observation.vmId || !ports.samePath(String(seedResult.seedDiskPath || ""), seedDiskPath) || !seedFilesAvailable) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-linux-seed-invalid-result", ownerId, deviceId: parsed.deviceId, rollback } };
            }
            try {
                await ports.attachSeed(seedTarget, seedDeadlineAt);
            }
            catch (cause) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-linux-seed-failed", ownerId, deviceId: parsed.deviceId,
                        detail: ports.seedFailureCode(cause, "hyper-v-linux-seed-media-attach-command-failed"), rollback } };
            }
            if (ports.deadlineExpired(seedDeadlineAt)) {
                const rollback = await rollbackProvisioning();
                return { status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            persistedParsed = { ...parsed, create: { ...(parsed.create || {}), vmId: observation.vmId, ...(observation.switchName ? { switchName: observation.switchName } : {}), guestUsername, guestProvisioned: true, sshHostKeyFingerprint } };
        }
        if (parsed.backend === "windows-vm" && execution.mode !== "noop") {
            const observation = ports.parseVm(execution.stdout || "");
            const expectedVmName = ports.vmName(ownerId, parsed.deviceId, String(parsed.create?.incarnationId || ""));
            const expectedDiskPath = join(ports.deviceRoot(ownerId, "windows-vm", parsed.deviceId), "disks", "root.vhdx");
            if (!observation
                || observation.vmName !== expectedVmName
                || !ports.samePath(observation.diskPath || "", expectedDiskPath)
                || (observation.generation!==1&&observation.generation!==2)
                || observation.generation !== parsed.create?.baseImageGeneration) {
                const rollback = await recoverCreateResidue(ownerId, parsed.backend, parsed.deviceId, hyperVCleanupDeadlineAt, (typeof parsed.create?.incarnationId === "string" ? parsed.create.incarnationId : undefined));
                return {
                    status: 502,
                    payload: { ok: false, error: "hyper-v-create-invalid-result", ownerId, deviceId: parsed.deviceId, rollback },
                };
            }
            const deviceRoot = ports.deviceRoot(ownerId, "windows-vm", parsed.deviceId);
            const privateRoot = ports.privateRoot(ownerId, "windows-vm", parsed.deviceId);
            const credentialPath = join(privateRoot, "secrets", "guest.credential.xml");
            const provisioningMediaPath = join(deviceRoot, "disks", "autounattend.iso");
            const guestUsername = `ccc${ownerId.slice(0, 8)}`;
            const guestPassword = `Ccc!7${ports.passwordEntropy()}`;
            const observedParsed = { ...parsed, create: { ...(parsed.create || {}), vmId: observation.vmId } };
            const rollbackDevice = createRecord(ownerId, observedParsed);
            const rollbackProvisioning = () => {
                return rollbackCreate(observedParsed, rollbackDevice, null, hyperVCleanupDeadlineAt);
            };
            let provisionCommand:HyperVScriptCommand;
            try {
                ports.assertPrivateRoot(ownerId, "windows-vm", parsed.deviceId, privateRoot);
                provisionCommand = ports.provisionCommand({
                    executable: providerCommand?.executable || "powershell.exe",
                    ownerId,
                    deviceId: parsed.deviceId,
                    incarnationId: String(parsed.create?.incarnationId || ""),
                    vmName: expectedVmName,
                    vmId: observation.vmId,
                    diskPath: expectedDiskPath,
                    deviceRoot,
                    privateRoot,
                    credentialPath,
                    provisioningMediaPath,
                    guestUsername,
                    guestPassword,
                    networkAddress: typeof parsed.create?.networkAddress === "string" ? parsed.create.networkAddress : null,
                    networkGateway: typeof parsed.create?.networkGateway === "string" ? parsed.create.networkGateway : null,
                    networkPrefixLength: typeof parsed.create?.networkPrefix === "string"
                        ? Number(parsed.create.networkPrefix.split("/")[1])
                        : null,
                });
            }
            catch (error) {
                const rollback = await rollbackProvisioning();
                return {
                    status: rollback.ok ? 500 : 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-guest-provision-plan-failed",
                        ownerId,
                        deviceId: parsed.deviceId,
                        detail: ports.boundedErrorCode(error, "hyper-v-guest-provision-plan-failed"),
                        rollback,
                    },
                };
            }
            const provisioningDeadlineAt = Math.min(hyperVDeadlineAt, ports.now() + 180000);
            const rawProvisioningExecution = await ports.provision({
                executable: provisionCommand.executable,
                mediaCommand: provisionCommand,
                vmId: observation.vmId,
                vmName: expectedVmName,
                expectedNotes: ports.marker(ownerId, parsed.deviceId, String(parsed.create?.incarnationId || "")),
                generation: observation.generation,
                osDiskPath: expectedDiskPath,
                mediaPath: provisioningMediaPath,
                credentialPath,
                guestUsername,
                outputLimit: ports.outputLimit
            }, provisioningDeadlineAt);
            hyperVProvisioningExecution = redactExecution(rawProvisioningExecution, true, "hyper-v-guest-provision-command-failed");
            if (ports.deadlineExpired(hyperVDeadlineAt)) {
                const rollback = await rollbackProvisioning();
                return { status: 504, payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, rollback } };
            }
            if (ports.deadlineExpired(provisioningDeadlineAt)) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-guest-provision-failed", ownerId, deviceId: parsed.deviceId, provisioning: hyperVProvisioningExecution, rollback } };
            }
            if (!hyperVCreateSucceeded(rawProvisioningExecution)) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-guest-provision-failed", ownerId, deviceId: parsed.deviceId, provisioning: hyperVProvisioningExecution, rollback } };
            }
            const provisioned = ports.parseProvision(rawProvisioningExecution.stdout || "");
            let credentialAvailable = false;
            try {
                credentialAvailable = ports.readable(credentialPath,"hyper-v-guest-credential",64*1024) === true;
            }
            catch {
                credentialAvailable = false;
            }
            if (!provisioned
                || provisioned.vmId !== observation.vmId
                || provisioned.vmName !== expectedVmName
                || provisioned.guestUsername !== guestUsername
                || !ports.samePath(provisioned.credentialPath, credentialPath)
                || !ports.samePath(provisioned.unattendPath, provisioningMediaPath)
                || !credentialAvailable) {
                const rollback = await rollbackProvisioning();
                return { status: 502, payload: { ok: false, error: "hyper-v-guest-provision-invalid-result", ownerId, deviceId: parsed.deviceId, provisioning: hyperVProvisioningExecution, rollback } };
            }
            persistedParsed = {
                ...parsed,
                create: {
                    ...(parsed.create || {}),
                    vmId: observation.vmId,
                    ...(observation.switchName ? { switchName: observation.switchName } : {}),
                    guestUsername,
                    guestProvisioned: true,
                    guestUnattendPath: provisioned.unattendPath,
                },
            };
        }
        const device = createRecord(ownerId, persistedParsed);
        {
            let claim;
            try {
                claim = ports.claim(ownerId, parsed.stateKey, device, hyperVCreateUniqueFields());
            }
            catch (error) {
                const rollback = await rollbackCreate(persistedParsed, device, null, hyperVCleanupDeadlineAt);
                if (!rollback.ok) {
                    return {
                        status: 502,
                        payload: {
                            ok: false,
                            error: "owner-device-state-rollback-failed",
                            ownerId,
                            backend: parsed.backend,
                            deviceId: parsed.deviceId,
                            stateError: ports.stateErrorCode(error) || "owner-state-write-failed",
                            rollback,
                        },
                    };
                }
                const failure = ports.stateFailure(error, { backend: parsed.backend, stateKey: parsed.stateKey });
                return {
                    ...failure,
                    payload: { ...(hyperVCreateRecord(failure.payload) ? failure.payload : {}), rollback },
                };
            }
            if (!claim.ok) {
                const rollback = await rollbackCreate(persistedParsed, device, claim.existing, hyperVCleanupDeadlineAt);
                return {
                    status: rollback.ok ? 409 : 502,
                    payload: {
                        ok: false,
                        error: rollback.ok ? claim.error : "owner-device-conflict-rollback-failed",
                        ownerId,
                        backend: parsed.backend,
                        deviceId: parsed.deviceId,
                        field: claim.field,
                        value: claim.value,
                        existing: ports.redactDevice(claim.existing),
                        rollback,
                    },
                };
            }
        }
        return {
            status: 200,
            payload: {
                ok: true,
                result: {
                    ...(ports.redactResult(payload.result)),
                    device: ports.redactDevice(device),
                    invoked: true,
                    dryRun: false,
                    execution: {
                        mode: execution.mode === "noop" ? "state" : execution.mode,
                        providerExecution: execution.mode === "noop" ? "broker-state" : "executed",
                        mutatesHost: true,
                        ...(execution.provider ? { provider: execution.provider } : {}),
                        ...(typeof execution.status === "number" ? { status: execution.status } : {}),
                        ...(hyperVProvisioningExecution ? { provisioning: {
                                provider: hyperVProvisioningExecution.provider,
                                status: hyperVProvisioningExecution.status,
                            } } : {}),
                    },
                },
            },
        };
    }
    let providerCommand = payload.result?.providerCommand;
    if (!providerCommand || "error" in providerCommand) {
        return {
            status: 400,
            payload: {
                ok: false,
                error: providerCommand?.error || "missing-provider-command",
                missing: providerCommand?.missing || [],
                plan: ports.redactResult(payload.result),
            },
        };
    }
    let effectiveProviderCommand = providerCommand;
    const hyperVPowerDevice = (parsed.command === "device_start" || parsed.command === "device_reboot")
        && hyperVCreateRecord(payload.result?.device)
        ? payload.result.device
        : null;
    let execution = hyperVPowerDevice
        ? await ports.power({
            executable: providerCommand.executable || "powershell.exe",
            ownerId, deviceId: parsed.deviceId,
            incarnationId: ports.incarnation(hyperVPowerDevice) || "",
            vmId: hyperVCreateField(hyperVPowerDevice, "vmId") || "",
            vmName: hyperVCreateField(hyperVPowerDevice, "vmName") || "",
        }, parsed.command === "device_start" ? "start" : "reboot", hyperVDeadlineAt, 120000, {
            force: parsed.force,
            startIfStopped: parsed.startIfStopped,
            memoryMb: hyperVCreateNumber(hyperVPowerDevice, "memoryMb") || 4096,
            cpus: hyperVCreateNumber(hyperVPowerDevice, "cpus") || 2,
        })
        :
            await ports.execute(effectiveProviderCommand, ports.remaining(hyperVDeadlineAt, 120000), ports.outputLimit);
    const hyperVProviderDeadlineExpired = ports.deadlineExpired(hyperVDeadlineAt);
    // windows-vm joins the carve-out for the same reason the name gives linux: the guest may
    // already be Running and need containing. Start-VM issues its start and only then re-queries,
    // so an expired deadline here returned 504 with the guest booted, CCC_UNATTEND mounted and a
    // live autologon password — no readiness, therefore no containment, and no state write to say
    // so. Falling through lets the containment block below make that decision on evidence.
    const guestBootstrapMayNeedContainment = (parsed.backend === "linux-vm" || parsed.backend === "windows-vm")
        && (parsed.command === "device_start" || parsed.command === "device_reboot");
    if (hyperVProviderDeadlineExpired && !guestBootstrapMayNeedContainment) {
        return {
            status: 504,
            payload: { ok: false, error: "hyper-v-operation-deadline-exceeded", ownerId, backend: parsed.backend, deviceId: parsed.deviceId },
        };
    }
    let success = !hyperVProviderDeadlineExpired && (hyperVCreateSucceeded(execution));
    if (hyperVProviderDeadlineExpired && guestBootstrapMayNeedContainment) {
        execution = { ...execution, error: "hyper-v-operation-deadline-exceeded" };
    }
    if (success && true) {
        const observation = ports.parseVm(execution.stdout || "");
        const expectedVmId = String(hyperVCreateField(payload.result?.device, "vmId") || "").toLowerCase();
        const expectedVmName = hyperVCreateField(payload.result?.device, "vmName");
        const expectedDiskPath = hyperVCreateField(payload.result?.device, "diskPath");
        success = Boolean(observation
            && expectedVmId
            && observation.vmId === expectedVmId
            && observation.vmName === expectedVmName
            && (true));
    }
    let hyperVGuestReadyExecution: HyperVNativeExecution | null = null;
    let hyperVGuestReady: HyperVGuestReadyObservation | null = null;
    let hyperVGuestBootDiagnostic: HyperVWindowsGuestBootDiagnostic | null = null;
    let hyperVGuestBootDiagnosticPublic: Record<string, unknown> | null = null;
    let hyperVGuestBootDiagnosticFailureCode: string | null = null;
    let hyperVGuestReadyFailureCode: string | null = null;
    let hyperVGuestReadyFailureDetail: HyperVGuestReadinessFailureDetail | null = null;
    let hyperVGuestReadyTrace: HyperVLinuxGuestReadyTrace | null = null;
    let hyperVContainedRuntimeState: "Off" | null = null;
    let hyperVScrubContainmentFailed = false;
    if (success && parsed.backend === "windows-vm" && (parsed.command === "device_start" || parsed.command === "device_reboot") && parsed.waitForBoot !== false) {
        const device = hyperVCreateRecord(payload.result?.device) ? payload.result.device : {};
        const timeoutMs = Number.isFinite(parsed.bootTimeoutMs)
            ? Math.min(ports.maxBootTimeout, Math.max(1000, Number(parsed.bootTimeoutMs)))
            : 5 * 60 * 1000;
        try {
            const privateRoot = hyperVCreateField(device, "privateRoot") || "";
            const expectedPrivateRoot = ports.privateRoot(ownerId, "windows-vm", parsed.deviceId);
            const credentialPath = hyperVCreateField(device, "guestCredentialPath") || "";
            const provisioningMediaPath = hyperVCreateField(device, "guestUnattendPath") || "";
            const expectedProvisioningMediaPath = join(ports.deviceRoot(ownerId, "windows-vm", parsed.deviceId), "disks", "autounattend.iso");
            if (privateRoot !== expectedPrivateRoot
                || credentialPath !== join(expectedPrivateRoot, "secrets", "guest.credential.xml")
                || provisioningMediaPath !== expectedProvisioningMediaPath) {
                throw new Error("hyper-v-guest-metadata-invalid");
            }
            ports.assertPrivateRoot(ownerId, "windows-vm", parsed.deviceId, privateRoot);
            const readinessTimeoutMilliseconds = Math.max(0, Math.min(timeoutMs, hyperVDeadlineAt - ports.now() - 15000));
            const readiness = await waitHyperVWindowsGuestReadiness({
                timeoutMilliseconds: readinessTimeoutMilliseconds,
                noProgressTimeoutMilliseconds: Math.min(ports.windowsNoProgressTimeout, readinessTimeoutMilliseconds),
                identity: {
                    selector: { kind: "id", id: hyperVCreateField(device, "vmId") || "" },
                    expectedName: hyperVCreateField(device, "vmName") || "",
                    expectedNotes: ports.marker(ownerId, parsed.deviceId, ports.incarnation(device) || ""),
                    credentialPath,
                },
                provisioningMediaPath,
                expectedNetworkAddress: hyperVCreateField(device, "networkAddress") || ""
            }, ports.windowsReadiness(providerCommand.executable || "powershell.exe", ports.deviceRoot(ownerId, "windows-vm", parsed.deviceId), provisioningMediaPath));
            hyperVGuestReadyExecution = {
                mode: "exec", provider: "hyper-v", status: readiness.ok ? 0 : 1,
                stdout: JSON.stringify(readiness), stderr: "",
            };
            ports.assertDeadline(hyperVDeadlineAt);
            hyperVGuestReady = hyperVCreateSucceeded(hyperVGuestReadyExecution)
                ? ports.parseReady(hyperVGuestReadyExecution.stdout || "")
                : null;
            success = Boolean(hyperVGuestReady
                && hyperVGuestReady.vmId === String(hyperVCreateField(device, "vmId") || "").toLowerCase()
                && hyperVGuestReady.vmName === hyperVCreateField(device, "vmName")
                && (!hyperVCreateField(device, "networkAddress") || hyperVGuestReady.networkAddress === hyperVCreateField(device, "networkAddress")));
        }
        catch (error) {
            // Never overwrite a readiness result that already arrived. The deadline assert fires
            // AFTER the runner returns, so replacing unconditionally discarded a structured
            // hyper-v-guest-provisioning-not-scrubbed / -first-logon-incomplete and reported
            // hyper-v-operation-deadline-exceeded instead — containment switches on that reason,
            // so an un-scrubbed guest was left running and unreported at exactly the moment the
            // host was most contended.
            hyperVGuestReadyExecution = hyperVGuestReadyExecution ?? {
                mode: "exec",
                provider: "hyper-v",
                status: null,
                error: ports.boundedErrorCode(error, "hyper-v-guest-ready-precondition-failed"),
            };
            success = false;
        }
    }
    if (success && parsed.backend === "linux-vm" && (parsed.command === "device_start" || parsed.command === "device_reboot") && parsed.waitForBoot !== false) {
        const device = hyperVCreateRecord(payload.result?.device) ? payload.result.device : {};
        const timeoutMs = Number.isFinite(parsed.bootTimeoutMs)
            ? Math.min(ports.maxBootTimeout, Math.max(1000, Number(parsed.bootTimeoutMs)))
            : 5 * 60 * 1000;
        const ssh = ports.executable("ssh.exe") || ports.executable("ssh");
        if (!ssh) {
            hyperVGuestReadyExecution = { mode: "exec", provider: "hyper-v-ssh", status: null, error: "missing-provider-command:ssh" };
            success = false;
        }
        else {
            const readinessStartedAt = ports.now();
            const deadline = Math.min(ports.now() + timeoutMs, hyperVDeadlineAt);
            const guestSignalDeadline = hyperVLinuxGuestSignalDeadlineAt(readinessStartedAt);
            let attempts = 0;
            let bootstrapProbeAttempts = 0;
            let bootstrapProbeSuccesses = 0;
            let bootstrapProbeLastStatus: number | null = null;
            let bootstrapProbeLastError: string | null = null;
            let bootstrapAddressCount = 0;
            let bootstrapSshAttempts = 0;
            let bootstrapSshLastStatus: number | null = null;
            let bootstrapSshLastError: string | null = null;
            let bootstrapHostKeyObserved: boolean | null = null;
            let bootstrapHostKeyMatchesExpected: boolean | null = null;
            const bootstrapHostKeyAdopted = false;
            const observedBootstrapHostKeyAddresses = new Set<string>();
            const matchingBootstrapHostKeyAddresses = new Set<string>();
            let networkFinalizeAttempts = 0;
            let networkFinalizeSucceeded = false;
            let guestSignalObserved = false;
            try {
                const privateRoot = hyperVCreateField(device, "privateRoot") || "";
                const expectedPrivateRoot = ports.privateRoot(ownerId, "linux-vm", parsed.deviceId);
                const hostPublicKeyPath = hyperVCreateField(device, "sshHostPublicKeyPath") || "";
                const knownHostsPath = hyperVCreateField(device, "sshKnownHostsPath") || "";
                const networkAddress = hyperVCreateField(device, "networkAddress") || "";
                const managedMacAddress = hyperVCreateField(device, "macAddress") || "";
                const networkGateway = hyperVCreateField(device, "networkGateway") || "";
                const networkPrefix = hyperVCreateField(device, "networkPrefix") || "";
                let fingerprint = hyperVCreateField(device, "sshHostKeyFingerprint") || "";
                ports.assertPrivateRoot(ownerId, "linux-vm", parsed.deviceId, privateRoot);
                const identityPublication:{identity:{fingerprint:string}|null;committed?:unknown} = privateRoot === expectedPrivateRoot && hostPublicKeyPath === join(expectedPrivateRoot, "secrets", "ssh_host_ed25519_key.pub") ? ports.reconcileHostIdentity(ownerId, parsed.stateKey, parsed.deviceId, hostPublicKeyPath, knownHostsPath, networkAddress, expectedDevice) : { identity: null };
                const reconciledIdentity = identityPublication.identity;
                if (identityPublication.committed !== undefined)
                    expectedDevice = identityPublication.committed;
                if (reconciledIdentity) {
                    fingerprint = reconciledIdentity.fingerprint;
                    device.sshHostKeyFingerprint = reconciledIdentity.fingerprint;
                }
                if (privateRoot !== expectedPrivateRoot
                    || hostPublicKeyPath !== join(expectedPrivateRoot, "secrets", "ssh_host_ed25519_key.pub")
                    || !ports.validateHostIdentity(ownerId, parsed.deviceId, hostPublicKeyPath, knownHostsPath, networkAddress, fingerprint)) {
                    throw new Error("hyper-v-linux-ssh-host-identity-invalid");
                }
                const sshOptions = {
                    executable: ssh,
                    deviceRoot: hyperVCreateField(device, "deviceRoot") || "",
                    privateRoot,
                    sshPrivateKeyPath: hyperVCreateField(device, "sshPrivateKeyPath") || "",
                    knownHostsPath,
                    guestUsername: hyperVCreateField(device, "guestUsername") || "",
                };
                let bootstrapFinalizationAttempted = false;
                do {
                    let networkFinalizedThisIteration = false;
                    attempts += 1;
                    const readyCommand = ports.sshReadyCommand({
                        ...sshOptions,
                        networkAddress,
                        timeoutMs: Math.min(timeoutMs, 30000),
                    });
                    hyperVGuestReadyExecution = await ports.execute(readyCommand, ports.remaining(deadline, 35000), ports.outputLimit);
                    if (hyperVCreateSucceeded(hyperVGuestReadyExecution) && String(hyperVGuestReadyExecution.stdout || "").includes("ccc-hyper-v-linux-ready")) {
                        guestSignalObserved = true;
                        break;
                    }
                    if (!bootstrapFinalizationAttempted && ports.now() < deadline) {
                        bootstrapProbeAttempts += 1;
                        const { execution: bootstrapExecution, observation: bootstrap } = await ports.bootstrapProbe({
                            executable: providerCommand.executable || "",
                            ownerId,
                            deviceId: parsed.deviceId,
                            incarnationId: ports.incarnation(device) || "",
                            vmName: hyperVCreateField(device, "vmName") || "",
                            vmId: hyperVCreateField(device, "vmId"),
                            deadlineAt: deadline,
                        });
                        bootstrapProbeLastStatus = typeof bootstrapExecution.status === "number"
                            ? bootstrapExecution.status
                            : null;
                        if (bootstrap && !bootstrap.diagnosticCode) {
                            bootstrapProbeSuccesses += 1;
                            bootstrapProbeLastError = null;
                        }
                        else {
                            bootstrapProbeLastError = bootstrap?.diagnosticCode
                                || (hyperVCreateSucceeded(bootstrapExecution)
                                    ? "hyper-v-bootstrap-network-response-invalid"
                                    : ports.diagnosticCode(bootstrapExecution, "hyper-v-bootstrap-network-probe-failed") || "hyper-v-bootstrap-network-probe-failed");
                        }
                        bootstrapAddressCount = Math.max(bootstrapAddressCount, bootstrap?.addresses.length || 0);
                        if ((bootstrap?.addresses.length || 0) > 0)
                            guestSignalObserved = true;
                        for (const bootstrapAddress of bootstrap?.addresses || []) {
                            bootstrapSshAttempts += 1;
                            const bootstrapReadyCommand = ports.sshReadyCommand({
                                ...sshOptions,
                                networkAddress: bootstrapAddress,
                                hostKeyAlias: networkAddress,
                                verboseHostKeyDiagnostics: true,
                                timeoutMs: Math.min(10000, Math.max(1000, deadline - ports.now())),
                            });
                            const bootstrapReadyExecution = await ports.execute(bootstrapReadyCommand, ports.remaining(deadline, 15000), ports.outputLimit);
                            bootstrapSshLastStatus = typeof bootstrapReadyExecution.status === "number"
                                ? bootstrapReadyExecution.status
                                : null;
                            let bootstrapAuthenticated = hyperVCreateSucceeded(bootstrapReadyExecution)
                                && String(bootstrapReadyExecution.stdout || "").includes("ccc-hyper-v-linux-ready");
                            if (!bootstrapAuthenticated) {
                                bootstrapSshLastError = hyperVCreateSucceeded(bootstrapReadyExecution)
                                    ? "ssh-readiness-marker-missing"
                                    : hyperVGuestReadinessFailureCode("linux-vm", bootstrapReadyExecution);
                                if (bootstrapSshLastError === "ssh-host-key-rejected") {
                                    const comparison = compareHyperVLinuxEd25519HostKeyFingerprint(fingerprint, `${bootstrapReadyExecution.error || ""}\n${bootstrapReadyExecution.stderr || ""}`);
                                    if (comparison.observed) {
                                        observedBootstrapHostKeyAddresses.add(bootstrapAddress);
                                        if (comparison.matchesExpected)
                                            matchingBootstrapHostKeyAddresses.add(bootstrapAddress);
                                    }
                                    bootstrapHostKeyObserved = observedBootstrapHostKeyAddresses.size > 0;
                                    bootstrapHostKeyMatchesExpected = bootstrapHostKeyObserved
                                        ? matchingBootstrapHostKeyAddresses.size > 0
                                        : null;
                                }
                                if (!bootstrapAuthenticated) {
                                    continue;
                                }
                            }
                            bootstrapHostKeyMatchesExpected = true;
                            bootstrapSshLastError = null;
                            const finalizeCommand = ports.networkFinalizeCommand({
                                ...sshOptions,
                                networkAddress: bootstrapAddress,
                                hostKeyAlias: networkAddress,
                                timeoutMs: 10000,
                                managedMacAddress,
                                managedNetworkAddress: networkAddress,
                                networkGateway,
                                networkPrefixLength: Number(networkPrefix.split("/")[1]),
                            });
                            networkFinalizeAttempts += 1;
                            const finalizeExecution = await ports.execute(finalizeCommand, ports.remaining(deadline, 15000), ports.outputLimit);
                            if (!hyperVCreateSucceeded(finalizeExecution)) {
                                hyperVGuestReadyExecution = {
                                    ...finalizeExecution,
                                    error: "hyper-v-bootstrap-network-finalize-failed",
                                };
                                break;
                            }
                            bootstrapFinalizationAttempted = true;
                            networkFinalizeSucceeded = true;
                            networkFinalizedThisIteration = true;
                            break;
                        }
                    }
                    if (networkFinalizedThisIteration)
                        continue;
                    if (ports.now() < deadline)
                        await ports.sleep(Math.min(2000,Math.max(0,deadline-ports.now())));
                } while (ports.now() < deadline && (guestSignalObserved || ports.now() < guestSignalDeadline));
                success = Boolean(hyperVGuestReadyExecution && hyperVCreateSucceeded(hyperVGuestReadyExecution) && String(hyperVGuestReadyExecution.stdout || "").includes("ccc-hyper-v-linux-ready"));
                if (!success && hyperVLinuxGuestSignalTimedOut(readinessStartedAt, ports.now(), guestSignalObserved)) {
                    hyperVGuestReadyExecution = {
                        ...(hyperVGuestReadyExecution || { mode: "exec", provider: "hyper-v-ssh", status: null }),
                        error: "hyper-v-guest-boot-signal-timeout",
                        timedOut: false,
                    };
                }
                hyperVGuestReady = success ? {
                    ok: true,
                    vmId: String(hyperVCreateField(device, "vmId") || "").toLowerCase(),
                    vmName: hyperVCreateField(device, "vmName") || "",
                    computerName: hyperVCreateField(device, "vmName") || "",
                    attempts,
                    networkAddress: hyperVCreateField(device, "networkAddress") || undefined,
                } : null;
                if (success) {
                    const { execution: cleanupExecution, observation: cleanupObservation } = await ports.bootstrapCleanup({
                        executable: providerCommand.executable || "",
                        ownerId,
                        deviceId: parsed.deviceId,
                        incarnationId: ports.incarnation(device) || "",
                        vmName: hyperVCreateField(device, "vmName") || "",
                        vmId: hyperVCreateField(device, "vmId"),
                        deadlineAt: hyperVDeadlineAt,
                    }, hyperVCreateField(device, "macAddress") || "");
                    if (!cleanupObservation) {
                        hyperVGuestReadyExecution = {
                            ...cleanupExecution,
                            error: "hyper-v-bootstrap-network-cleanup-failed",
                        };
                        hyperVGuestReady = null;
                        success = false;
                    }
                }
                if (success) {
                    // The managed SSH identity has already been verified. A first start provisions
                    // the graphical session; later starts and reboots take the cheap ready path.
                    const guiOptions = {
                        ...sshOptions,
                        networkAddress,
                        timeoutMs: 30000,
                    };
                    let guiExecution = await ports.execute(ports.guiReadyCommand(guiOptions), ports.remaining(hyperVDeadlineAt, 35000), ports.outputLimit);
                    if (!hyperVCreateSucceeded(guiExecution) || !String(guiExecution.stdout || "").includes("CCC_HYPER_V_GUI_READY")) {
                        guiExecution = await ports.execute(ports.guiPrepareCommand({ ...guiOptions, timeoutMs: ports.linuxGuiTimeout }), ports.remaining(hyperVDeadlineAt, ports.linuxGuiTimeout), ports.outputLimit);
                    }
                    if (!hyperVCreateSucceeded(guiExecution) || !String(guiExecution.stdout || "").includes("CCC_HYPER_V_GUI_READY")) {
                        const stage = /hyper-v-linux-gui-(?:privilege|apt-update|apt-install|configure|start|ready)-failed/.exec(String(guiExecution.stderr || ""))?.[0];
                        hyperVGuestReadyExecution = {
                            ...guiExecution,
                            error: stage || (guiExecution.timedOut ? "hyper-v-linux-gui-timeout" : "hyper-v-linux-gui-ready-failed"),
                        };
                        hyperVGuestReady = null;
                        success = false;
                    }
                }
            }
            catch (error) {
                const caughtError = error instanceof Error ? error.message : String(error);
                const readinessError = caughtError === "hyper-v-operation-deadline-exceeded"
                    ? bootstrapSshLastError || caughtError
                    : caughtError;
                hyperVGuestReadyExecution = { mode: "exec", provider: "hyper-v-ssh", status: null, error: readinessError };
                success = false;
            }
            finally {
                hyperVGuestReadyTrace = {
                    managedSshAttempts: attempts,
                    bootstrapProbeAttempts,
                    bootstrapProbeSuccesses,
                    bootstrapProbeLastStatus,
                    bootstrapProbeLastError,
                    bootstrapAddressCount,
                    bootstrapSshAttempts,
                    bootstrapSshLastStatus,
                    bootstrapSshLastError,
                    bootstrapHostKeyObserved,
                    bootstrapHostKeyMatchesExpected,
                    bootstrapHostKeyAdopted,
                    networkFinalizeAttempts,
                    networkFinalizeSucceeded,
                    guestSignalObserved,
                    elapsedMs: Math.max(0, ports.now() - readinessStartedAt),
                };
            }
        }
    }
    if (!success
        && parsed.backend === "linux-vm"
        && (parsed.command === "device_start" || parsed.command === "device_reboot")
        && parsed.waitForBoot !== false) {
        const device = hyperVCreateRecord(payload.result?.device) ? payload.result.device : {};
        let bootstrapContained = false;
        try {
            const { observation: cleanupObservation } = await ports.bootstrapCleanup({
                executable: providerCommand.executable || "",
                ownerId,
                deviceId: parsed.deviceId,
                incarnationId: ports.incarnation(device) || "",
                vmName: hyperVCreateField(device, "vmName") || "",
                vmId: hyperVCreateField(device, "vmId"),
                deadlineAt: hyperVCleanupDeadlineAt,
            }, hyperVCreateField(device, "macAddress") || "");
            bootstrapContained = Boolean(cleanupObservation);
        }
        catch {
            bootstrapContained = false;
        }
        if (!bootstrapContained) {
            try {
                const stopExecution = await ports.power({
                    executable: providerCommand.executable || "powershell.exe",
                    ownerId,
                    deviceId: parsed.deviceId,
                    incarnationId: ports.incarnation(device) || "",
                    vmName: hyperVCreateField(device, "vmName") || "",
                    vmId: hyperVCreateField(device, "vmId") || "",
                }, "stop", hyperVCleanupDeadlineAt, 30000, { force: true });
                const stopObservation = hyperVCreateSucceeded(stopExecution)
                    ? ports.parseVm(stopExecution.stdout || "")
                    : null;
                bootstrapContained = Boolean(stopObservation
                    && stopObservation.state === "Off"
                    && stopObservation.vmId === String(hyperVCreateField(device, "vmId") || "").toLowerCase()
                    && stopObservation.vmName === hyperVCreateField(device, "vmName"));
                if (bootstrapContained)
                    hyperVContainedRuntimeState = "Off";
            }
            catch {
                bootstrapContained = false;
            }
        }
        if (!bootstrapContained) {
            hyperVGuestReadyExecution = {
                ...(hyperVGuestReadyExecution || { mode: "exec", provider: "hyper-v-ssh", status: null }),
                error: "hyper-v-bootstrap-network-containment-failed",
            };
        }
    }
    const hyperVProvisioningMediaRetained = !success && parsed.backend === "windows-vm" && (parsed.command === "device_start" || parsed.command === "device_reboot") ? ports.mediaRetained(join(ports.deviceRoot(ownerId, "windows-vm", parsed.deviceId), "disks", "autounattend.iso")) : false;
    if (!success
        && (hyperVGuestReadyExecution || hyperVProvisioningMediaRetained)
        && true
        && (parsed.command === "device_start" || parsed.command === "device_reboot")) {
        if (hyperVGuestReadyExecution) {
            hyperVGuestReadyFailureCode = hyperVGuestReadinessFailureCode(parsed.backend === "linux-vm" ? "linux-vm" : "windows-vm", hyperVGuestReadyExecution);
            hyperVGuestReadyFailureDetail = hyperVGuestReadinessFailureDetail(parsed.backend === "linux-vm" ? "linux-vm" : "windows-vm", hyperVGuestReadyExecution);
            if (parsed.backend === "linux-vm") {
                hyperVGuestReadyFailureCode = hyperVLinuxGuestReadyTraceFailureCode(hyperVGuestReadyTrace, hyperVGuestReadyFailureCode);
            }
        }
        const device = hyperVCreateRecord(payload.result?.device) ? payload.result.device : {};
        try {
            // Preserve enough cleanup time for a required Windows force stop even when a
            // diagnostic reader stalls near the end of the cleanup window.
            const diagnosticDeadlineAt = hyperVCleanupDeadlineAt - 30000;
            hyperVGuestBootDiagnostic = await ports.bootDiagnostic({
                executable: providerCommand.executable || "powershell.exe",
                vmId: hyperVCreateField(device, "vmId") || "",
                vmName: hyperVCreateField(device, "vmName") || "",
                ownershipNotes: ports.marker(ownerId, parsed.deviceId, ports.incarnation(device) || "")
            }, diagnosticDeadlineAt);
            if (hyperVGuestBootDiagnostic
                && (hyperVGuestBootDiagnostic.vmId !== String(hyperVCreateField(device, "vmId") || "").toLowerCase()
                    || hyperVGuestBootDiagnostic.vmName !== hyperVCreateField(device, "vmName"))) {
                hyperVGuestBootDiagnostic = null;
                hyperVGuestBootDiagnosticFailureCode = "hyper-v-guest-boot-diagnostic-identity-mismatch";
            }
            hyperVGuestBootDiagnosticPublic = hyperVGuestBootDiagnostic ? {
                state: hyperVGuestBootDiagnostic.state,
                uptimeMs: hyperVGuestBootDiagnostic.uptimeMs,
                generation: hyperVGuestBootDiagnostic.generation,
                secureBootEnabled: hyperVGuestBootDiagnostic.secureBootEnabled,
                heartbeatEnabled: hyperVGuestBootDiagnostic.heartbeatEnabled,
                heartbeatPrimaryStatus: hyperVGuestBootDiagnostic.heartbeatPrimaryStatus,
                heartbeatSecondaryStatus: hyperVGuestBootDiagnostic.heartbeatSecondaryStatus,
                integrationServices: hyperVGuestBootDiagnostic.integrationServices,
                hardDiskCount: hyperVGuestBootDiagnostic.hardDiskCount,
                dvdCount: hyperVGuestBootDiagnostic.dvdCount,
                hardDiskControllers: hyperVGuestBootDiagnostic.hardDiskControllers,
                bootDeviceTypes: hyperVGuestBootDiagnostic.bootDeviceTypes,
                bootEntries: hyperVGuestBootDiagnostic.bootEntries,
                hardDisks: hyperVGuestBootDiagnostic.hardDisks,
                dvdDrives: hyperVGuestBootDiagnostic.dvdDrives,
                diagnosticComplete: hyperVGuestBootDiagnostic.diagnosticComplete,
                diagnosticErrors: hyperVGuestBootDiagnostic.diagnosticErrors,
            } : null;
        }
        catch (error) {
            const typedDiagnosticError=ports.errorInfo(error);
            hyperVGuestBootDiagnosticFailureCode = typedDiagnosticError
                ? (typedDiagnosticError?.code === "diagnostic-vm-identity-mismatch" || typedDiagnosticError?.code === "result-identity-mismatch"
                    ? "hyper-v-guest-boot-diagnostic-identity-mismatch"
                    : typedDiagnosticError?.code === "hyper-v-guest-boot-diagnostic-command-failed"
                        ? typedDiagnosticError?.code || "hyper-v-guest-boot-diagnostic-failed"
                        : typedDiagnosticError?.category === "protocol" ? "hyper-v-guest-boot-diagnostic-invalid" : "hyper-v-guest-boot-diagnostic-failed")
                : ports.boundedErrorCode(error, "hyper-v-guest-boot-diagnostic-failed");
            hyperVGuestBootDiagnostic = null;
        }
    }
    // Scrub-failure containment, windows-vm only, and deliberately narrower than the linux block
    // above. These two reasons are the ones that prove the guest is sitting there with a live
    // autologon password and the plaintext answer file still mounted, so leaving it Running until
    // someone happens to run device_delete is the worst of both worlds: refused, so nobody looks,
    // and still exploitable from inside. Every other readiness failure — an ordinary boot timeout,
    // a network mismatch — stays Running on purpose, because powering those off destroys the state
    // needed to diagnose them.
    //
    // Placed after the boot diagnostic on purpose. Run before it, the diagnostic that lands in
    // lastBootCheck describes a machine containment had already powered off — state, uptimeMs and
    // heartbeat all post-mortem — which is the very diagnosability this scope was chosen to keep.
    // Deliberately NOT gated on hyperVGuestReadyExecution. Requiring it meant containment could
    // only run once readiness had started, and two exits sit between Start-VM and readiness — the
    // expired-deadline return and the VM-observation identity gate. Start-VM issues its start and
    // only then re-queries, so both are reachable with the guest already booted: CCC_UNATTEND
    // mounted, plaintext answer file, live autologon, and nothing contained or recorded. The gate
    // made containment depend on how far the operation got rather than on what the host can see.
    if (!success
        && parsed.backend === "windows-vm"
        && (parsed.command === "device_start" || parsed.command === "device_reboot")) {
        // Reuses the code computed above rather than recomputing it. Two independent calls would
        // silently disagree the day anyone adds a windows equivalent of the linux lane's error
        // rewrite: containment would switch on the pre-rewrite reason and the report carry the
        // post-rewrite one. Null when readiness never ran, which is exactly the case above.
        const containedReason = hyperVGuestReadyFailureCode;
        const containedDevice = hyperVCreateRecord(payload.result?.device) ? payload.result.device : {};
        // Those two reasons PROVE the guest is un-scrubbed, but they both require the PowerShell
        // Direct probe to have landed at least once. When it never lands — a stalled OOBE, a
        // servicing reboot loop, integration services not up — the reason is a transport code and
        // the guest sits in its DEFAULT state, which is un-scrubbed: plaintext answer file on the
        // mounted ISO and a live DefaultPassword. That is the most likely way a fresh VM's first
        // start fails, so scoping containment to proof alone left the common case running.
        //
        // The host cannot ask the guest when the probe is down, but it does not need to. Readiness
        // deletes the provisioning ISO only after every gate has passed, so the ISO still being on
        // disk IS the durable evidence that no readiness has ever completed for this device — and
        // the ISO is itself the plaintext residue that motivates containment. Once it is gone there
        // is nothing left to contain, and an ordinary boot timeout on an already-scrubbed guest
        // stays Running and debuggable, which is the whole point of the narrow scope.
        // The path is computed from owner/device identity before the diagnostic and this
        // containment decision. An unreadable path counts as retained, and that same finding
        // triggers a diagnostic even when readiness never ran.
        const provisioningMediaRetained = hyperVProvisioningMediaRetained;
        // scrubConfirmed vetoes the media-retained arm. Once both scrub gates have passed the guest
        // is clean, and a retained ISO then means the removal itself failed — a locked file, an
        // ACL, a rejected reparse path. Containing on that powers off a healthy VM, and keeps doing
        // it, because the marker persists and every later start re-runs into the same failure. The
        // named reasons still contain unconditionally: they ARE the proof of un-scrubbed.
        // BOTH flags, not just scrubConfirmed. The latch fires when the guest's registry and
        // Panther are clean, which is before the DVD is detached — so an ambiguous attachment or a
        // failed Remove-VMDvdDrive leaves the ISO mounted INSIDE the guest, and that ISO carries the
        // local Administrator password in plaintext for anything running there. The scrub does not
        // remove that account. Vetoing on scrubConfirmed alone stood containment down on exactly
        // that guest; the host-side-file argument only holds once the drive is actually gone.
        const readyFailure = ports.parseReadyFailure(hyperVGuestReadyExecution?.stdout || "");
        const scrubConfirmed = readyFailure?.scrubConfirmed === true && readyFailure?.mediaDetached === true;
        // A guest already Off has nothing to contain, and stopping it would claim otherwise:
        // hyperVStopCommand is `if ($Vm.State -ne 'Off') { Stop-VM }` plus a re-query, so on an Off
        // VM it returns ok having done nothing, which then set hyperVContainedRuntimeState and
        // reported mutatesHost: true for a stop that never happened.
        //
        // The diagnostic also runs when retained media could require containment before
        // readiness starts. A confirmed Off or OffCritical state prevents a phantom stop.
        // If the diagnostic itself fails, state is unknown and the retained-media rule remains
        // fail-closed.
        //
        // The comparison is an explicit list, not `!== "Running"`. Hyper-V reports 27 states, and
        // treating every non-Running one as "nothing to contain" would skip Paused, Saved,
        // Starting and Stopping — guests that are very much still holding a mounted answer file.
        // The typed stop transaction skips only an observed Off state.
        const alreadyOff = hyperVGuestBootDiagnostic?.state === "Off"
            || hyperVGuestBootDiagnostic?.state === "OffCritical";
        if (!alreadyOff && (containedReason === "hyper-v-guest-first-logon-incomplete"
            || containedReason === "hyper-v-guest-provisioning-not-scrubbed"
            || (provisioningMediaRetained && !scrubConfirmed))) {
            const device = containedDevice;
            let scrubContained = false;
            try {
                const stopExecution = await ports.power({
                    executable: providerCommand.executable || "powershell.exe",
                    ownerId,
                    deviceId: parsed.deviceId,
                    incarnationId: ports.incarnation(device) || "",
                    vmName: hyperVCreateField(device, "vmName") || "",
                    vmId: hyperVCreateField(device, "vmId") || "",
                }, "stop", hyperVCleanupDeadlineAt, 30000, { force: true });
                const stopObservation = hyperVCreateSucceeded(stopExecution)
                    ? ports.parseVm(stopExecution.stdout || "")
                    : null;
                scrubContained = Boolean(stopObservation
                    && stopObservation.state === "Off"
                    && stopObservation.vmId === String(hyperVCreateField(device, "vmId") || "").toLowerCase()
                    && stopObservation.vmName === hyperVCreateField(device, "vmName"));
                if (scrubContained)
                    hyperVContainedRuntimeState = "Off";
            }
            catch {
                scrubContained = false;
            }
            // A containment that failed must not read as one that was never needed. The reason is
            // preserved — replacing it the way the linux block does would discard the very
            // diagnostic that selected this path.
            if (!scrubContained) {
                hyperVScrubContainmentFailed = true;
                // Both surfaces for the flag — the failure detail and the persisted record —
                // require hyperVGuestReadyExecution, and it is null on exactly the paths that
                // dropping the readiness gate opened. Without this synthesis a failed containment
                // on those paths reached neither the reply nor device_status: guest Running, ISO
                // mounted, live autologon, containment attempted and failed, complete silence. The
                // linux lane already does this; the windows one had no equivalent. Any existing
                // execution is kept so a real readiness reason is never overwritten.
                hyperVGuestReadyExecution = hyperVGuestReadyExecution ?? {
                    mode: "exec",
                    provider: "hyper-v",
                    status: null,
                    error: "hyper-v-guest-scrub-containment-failed",
                };
            }
        }
    }
    // Applied after containment because containment runs after the detail is first computed. The
    // flag has to reach the payload the operator actually reads — and when readiness never ran
    // there is no detail yet to carry it, which is precisely the case that used to go silent, so
    // the detail is built here rather than skipped.
    if (hyperVScrubContainmentFailed&&hyperVGuestReadyExecution) {
        hyperVGuestReadyFailureCode = hyperVGuestReadyFailureCode || "hyper-v-guest-scrub-containment-failed";
        // No null fallback for the execution: the flag is only ever set inside the containment
        // block, which synthesises the execution in the same breath, so it is always present here.
        // A fallback object would be dead code pretending to be defence — this file has already
        // had to remove one of those (the existsSync catch that could never fire).
        hyperVGuestReadyFailureDetail = {
            ...(hyperVGuestReadyFailureDetail
                ?? hyperVGuestReadinessFailureDetail("windows-vm", hyperVGuestReadyExecution)),
            scrubContainmentFailed: true,
        };
    }
    // Hyper-V stop/delete are handled before the generic lifecycle execution above.
    let updatedDevice: unknown;
    let publication: HyperVPublication | undefined;
    try {
        if (!success
            && (hyperVGuestReadyExecution || hyperVContainedRuntimeState)
            && true
            && (parsed.command === "device_start" || parsed.command === "device_reboot")) {
            publication = ports.publish(ownerId, parsed.stateKey, parsed.deviceId, expectedDevice, (candidate) => {
                const observedRuntimeState = hyperVContainedRuntimeState || hyperVGuestBootDiagnostic?.state || "Running";
                updatedDevice = {
                    ...candidate,
                    status: observedRuntimeState === "Running" ? "running" : "stopped",
                    runtimeState: observedRuntimeState,
                    bootReady: false,
                    lastBootCheck: {
                        ready: false,
                        provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct",
                        error: hyperVGuestReadyFailureCode || "guest-not-ready",
                        ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                        ...(hyperVGuestBootDiagnosticPublic ? { diagnostic: hyperVGuestBootDiagnosticPublic } : {}),
                        // The flag has to live in the persisted record, not only in the HTTP
                        // response. The response can be lost — the MCP caller's own timeout can
                        // expire while containment is still running — and this is the one signal
                        // that a guest may still be up with a live autologon. `device_status`
                        // later must be able to see it.
                        ...(hyperVScrubContainmentFailed ? { scrubContainmentFailed: true } : {}),
                        // The diagnostic above is captured BEFORE containment, so on a contained
                        // failure it reports Running while runtimeState says Off. That pair is not
                        // a contradiction to reconcile by moving the capture: taking the diagnostic
                        // after containment would make every contained case a post-mortem of a
                        // machine we had just killed, which is the diagnosability this narrow scope
                        // exists to preserve.
                    },
                    updatedAt: ports.timestamp(),
                };
                return updatedDevice;
            });
        }
        updatedDevice = success
            ?
                (publication = publishStarted(ownerId, parsed, expectedDevice, execution, hyperVGuestReady)).device
            : publication ? publication.device : updatedDevice || payload.result?.device;
    }
    catch (error) {
        throw error;
    }
    return {
        status: publication && !publication.matched ? 409 : success ? 200 : 502,
        payload: {
            ok: success && (!publication || publication.matched),
            ...(publication && !publication.matched ? {
                error: "owner-device-state-conflict",
                ownerId,
                backend: parsed.backend,
                deviceId: parsed.deviceId,
                found: publication.found,
                ...(!success ? { providerFailure: hyperVGuestReadyExecution ? "hyper-v-guest-not-ready" : "provider-command-failed" } : {}),
            } : {}),
            ...(success || (publication && !publication.matched) ? {} : {
                error: hyperVGuestReadyExecution
                    ? "hyper-v-guest-not-ready"
                    : "provider-command-failed",
                detail: hyperVGuestReadyExecution
                    ? hyperVGuestReadyFailureCode || "guest-not-ready"
                    :
                        ports.diagnosticCode(execution, "hyper-v-provider-command-failed") || "hyper-v-provider-command-failed",
            }),
            result: {
                ...(ports.redactResult(payload.result)),
                providerCommand: {
                    mode: effectiveProviderCommand.mode,
                    provider: effectiveProviderCommand.provider,
                },
                device: ports.redactDevice(updatedDevice),
                ...(hyperVGuestReadyExecution ? {
                    boot: hyperVGuestReady
                        ? {
                            ready: true,
                            provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct",
                            computerName: hyperVGuestReady.computerName,
                            attempts: hyperVGuestReady.attempts,
                            ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                        }
                        : {
                            ready: false,
                            provider: parsed.backend === "linux-vm" ? "hyper-v-ssh" : "hyper-v-powershell-direct",
                            error: hyperVGuestReadyFailureCode || "guest-not-ready",
                            ...(hyperVGuestReadyFailureDetail ? { errorDetail: hyperVGuestReadyFailureDetail } : {}),
                            ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                            ...(hyperVGuestBootDiagnosticPublic ? { diagnostic: hyperVGuestBootDiagnosticPublic } : {}),
                            diagnosticAvailable: Boolean(hyperVGuestBootDiagnosticPublic),
                            ...(hyperVGuestBootDiagnosticFailureCode ? { diagnosticError: hyperVGuestBootDiagnosticFailureCode } : {}),
                        },
                } : {}),
                invoked: true,
                dryRun: false,
                execution: {
                    mode: execution.mode,
                    providerExecution: "executed",
                    // Containment force-stops the guest on a FAILED start, so deriving this from
                    // `success` alone reported mutatesHost:false for an operation whose entire
                    // purpose was to change the host. That is the same invisible-mutation the
                    // containment work exists to remove, restated in the response envelope.
                    mutatesHost: success || hyperVContainedRuntimeState !== null,
                    command: {
                        ...redactExecution(execution, true, success
                            ? undefined
                            : "hyper-v-provider-command-failed"),
                        ...(hyperVGuestReadyExecution && !hyperVGuestReady ? {
                            guestReadiness: {
                                provider: parsed.backend === "linux-vm"
                                    ? "hyper-v-ssh"
                                    : "hyper-v-powershell-direct",
                                error: hyperVGuestReadyFailureCode
                                    || "guest-not-ready",
                                ...(hyperVGuestReadyFailureDetail ? { errorDetail: hyperVGuestReadyFailureDetail } : {}),
                                ...(hyperVGuestReadyTrace ? { readiness: hyperVGuestReadyTrace } : {}),
                                diagnosticAvailable: Boolean(hyperVGuestBootDiagnosticPublic),
                                ...(hyperVGuestBootDiagnosticFailureCode ? { diagnosticError: hyperVGuestBootDiagnosticFailureCode } : {}),
                            },
                        } : {}),
                    },
                },
            },
        },
    };
    }
    return { createVmFromImage, recoverCreateResidue, rollbackCreate, invoke, execute };
}
