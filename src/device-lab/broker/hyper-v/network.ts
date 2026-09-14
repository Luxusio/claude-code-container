import { createHash, randomBytes } from "crypto";
import { lstatSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { readDeviceLabStateFile, readDeviceLabTextFile } from "../../../device-lab-state-file.js";
import { writeFileAtomically, writeJsonFileAtomically } from "../../../device-lab-shared-state.js";
import {
    HYPER_V_NETWORK_GATEWAY,
    HYPER_V_NETWORK_MARKER,
    HYPER_V_NETWORK_NAT,
    HYPER_V_NETWORK_PREFIX,
    HYPER_V_NETWORK_PREFIX_LENGTH,
    hyperVVmName,
    isHyperVCccNetworkIdentity,
    parseHyperVNetworkCleanupObservation,
    parseHyperVNetworkAllocationsObservation,
    parseHyperVNetworkObservation,
    type HyperVNetworkCleanupObservation,
    type HyperVNetworkObservation,
    type HyperVProviderCommand,
} from "../../../host-control/hyper-v/index.js";
import type {
    HyperVNetworkAllocationsOptions,
    HyperVNetworkCleanupOptions,
    HyperVNetworkOptions,
} from "../../../host-control/hyper-v/contracts.js";
import {
    createHyperVHostNetworkSpec,
    parseHyperVNatInstanceId,
    parseHyperVNatName,
    parseHyperVVirtualMachineName,
    parseHyperVVirtualSwitchId,
    parseHyperVVirtualSwitchName,
    HyperVWindowsError,
    type HyperVHostNetworkCleanupProvenance,
    type HyperVHostNetworkEnsureProvenance,
    type HyperVHostNetworkObservation,
    type HyperVHostNetworkSpec,
    type HyperVWindowsNetworkClient,
} from "../../../hyper-v-windows/index.js";
import { assertHyperVOperationDeadline, hyperVRemainingTimeout } from "./deadline.js";
import {
    hyperVBoundedErrorCode,
    hyperVProviderDiagnosticCode,
    redactProviderCommandInput,
} from "./public-response.js";
import { validHyperVIncarnationId } from "./state.js";
import {
    createFreshHyperVNetworkIntent,
    decodeHyperVNetworkIntent,
    decodeHyperVNetworkState,
    hyperVDeterministicMacAddress,
    type HyperVNetworkAllocation,
    type HyperVNetworkIntent,
    type HyperVNetworkIntentOwnershipEvidence,
    type HyperVNetworkState,
} from "./network-state.js";
import {
    cleanupDeviceLabHyperVHostNetwork,
    ensureDeviceLabHyperVHostNetwork,
    inspectDeviceLabHyperVHostNetwork,
    type DeviceLabHyperVHostNetworkCleanupCompletedAction,
    type DeviceLabHyperVHostNetworkEnsureCompletedAction,
    type WithAdministratorHyperVWindowsNetworkClient,
} from "./network-adapter.js";

export { hyperVDeterministicMacAddress } from "./network-state.js";
export type { HyperVNetworkAllocation } from "./network-state.js";

const HYPER_V_NETWORK_STATE_LIMIT_BYTES = 256 * 1024;
const HYPER_V_ELEVATED_TERMINATION_GRACE_MS = 10_000;
const HYPER_V_NETWORK_INSPECTION_BATCH_SIZE = 32;

export type HyperVNetworkCommandResult = {
    mode: string;
    provider: string;
    status?: number | null;
    stdout?: string;
    stderr?: string;
    error?: string;
    timedOut?: boolean;
};

export interface HyperVNetworkStateRuntime {
    privateRoot: string;
    assertSafePath(path: string, label: string): void;
}

type HyperVNetworkHostFabric =
    | {
        readonly kind: "typed";
        readonly client: HyperVWindowsNetworkClient;
        readonly withAdministratorClient: WithAdministratorHyperVWindowsNetworkClient;
    }
    | {
        readonly kind: "legacy-compatibility";
        readonly ensureCommand: (options: HyperVNetworkOptions) => HyperVProviderCommand;
        readonly cleanupCommand: (options: HyperVNetworkCleanupOptions) => HyperVProviderCommand;
        readonly inspectAllocationsCommand: (options: HyperVNetworkAllocationsOptions) => HyperVProviderCommand;
    }
    | { readonly kind: "unavailable" };

export type HyperVNetworkRuntime = HyperVNetworkStateRuntime & {
    resolveExecutable(name: string): string | null;
    resolveElevationExecutable(standardExecutable: string): string;
    run(
        command: HyperVProviderCommand,
        options: { timeoutMs: number; outputLimit: number },
    ): Promise<HyperVNetworkCommandResult>;
    commandOutputBytes: number;
    allocationReferenced?(allocation: HyperVNetworkAllocation): boolean;
    hostFabric: HyperVNetworkHostFabric;
};

export type HyperVOwnerDevicesReader = (
    ownerId: string,
    backend: "windows-vm" | "linux-vm",
) => unknown[];

export function cachedHyperVOwnerDevicesReader(readDevices: HyperVOwnerDevicesReader): HyperVOwnerDevicesReader {
    const cache = new Map<string, unknown[]>();
    return (ownerId, backend) => {
        const key = `${ownerId}:${backend}`;
        const cached = cache.get(key);
        if (cached) return cached;
        const devices = readDevices(ownerId, backend);
        cache.set(key, devices);
        return devices;
    };
}

export function hyperVNetworkAllocationReferenced(
    allocation: HyperVNetworkAllocation,
    readDevices: HyperVOwnerDevicesReader,
): boolean {
    const matchingDevices = (["windows-vm", "linux-vm"] as const).flatMap((backend) =>
        readDevices(allocation.ownerId, backend).filter((candidate) => candidate
            && typeof candidate === "object"
            && !Array.isArray(candidate)
            && (candidate as Record<string, unknown>).id === allocation.deviceId));
    const incarnations = matchingDevices.map((device) => {
        const incarnationId = (device as Record<string, unknown>).incarnationId;
        if (!validHyperVIncarnationId(incarnationId)) {
            throw new Error("hyper-v-network-owner-state-incarnation-unverifiable");
        }
        return incarnationId;
    });
    if (new Set(incarnations).size > 1) {
        throw new Error("hyper-v-network-owner-state-incarnation-conflict");
    }
    return incarnations[0] === allocation.incarnationId;
}

export type HyperVNetworkRelease = {
    ok: boolean;
    released: boolean;
    statePresent: boolean;
    remaining: number;
    managedSwitch?: boolean;
    managedGateway?: boolean;
    managedNat?: boolean;
    switchName?: string;
    switchId?: string;
    natName?: string;
    marker?: string;
    natInstanceId?: string;
    stateRevision?: string;
    error?: string;
};

function hyperVNetworkStateRevision(state: HyperVNetworkState): string {
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}

export function hyperVDeterministicNetworkAddresses(ownerId: string, deviceId: string): string[] {
    const digest = createHash("sha256").update(`${ownerId}\0${deviceId}\0address`).digest();
    const start = digest.readUInt32BE(0) % 241;
    let step = (digest.readUInt32BE(4) % 240) + 1;
    while (step % 241 === 0) step += 1;
    return Array.from({ length: 241 }, (_, index) => `172.29.0.${10 + ((start + index * step) % 241)}`);
}

function intentOwnsDedicatedNat(intent: HyperVNetworkIntent): boolean {
    return intent.marker !== HYPER_V_NETWORK_MARKER && isHyperVCccNetworkIdentity(intent.marker, intent.natName);
}

function intentCanClaimFreshOwnership(intent: HyperVNetworkIntent): boolean {
    return intent.ownershipOrigin !== "adopted" && intentOwnsDedicatedNat(intent);
}

function stateFile(runtime: HyperVNetworkStateRuntime): string {
    return join(runtime.privateRoot, "network", "hyper-v.json");
}

function intentFile(runtime: HyperVNetworkStateRuntime): string {
    return join(runtime.privateRoot, "network", "hyper-v-intent.json");
}

function ensureStateRoot(runtime: HyperVNetworkStateRuntime): void {
    const root = dirname(stateFile(runtime));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    runtime.assertSafePath(root, "hyper-v-network-state-root");
    const metadata = lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("hyper-v-network-state-root-invalid");
}

function readState(runtime: HyperVNetworkStateRuntime): HyperVNetworkState | null {
    return readDeviceLabStateFile(
        stateFile(runtime),
        decodeHyperVNetworkState,
        "hyper-v-network-state",
        HYPER_V_NETWORK_STATE_LIMIT_BYTES,
    );
}

function readIntent(runtime: HyperVNetworkStateRuntime): HyperVNetworkIntent | null {
    return readDeviceLabStateFile(
        intentFile(runtime),
        decodeHyperVNetworkIntent,
        "hyper-v-network-intent",
        HYPER_V_NETWORK_STATE_LIMIT_BYTES,
    );
}

function createIntent(runtime: HyperVNetworkStateRuntime): HyperVNetworkIntent {
    const token = randomBytes(12).toString("hex");
    const intent = createFreshHyperVNetworkIntent(token, new Date().toISOString());
    ensureStateRoot(runtime);
    writeJsonFileAtomically(intentFile(runtime), intent);
    return intent;
}

function sameOwnershipReceipt(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function persistTypedIntentIdentityTransition(
    runtime: HyperVNetworkRuntime,
    intent: HyperVNetworkIntent,
    marker: string,
    natName: string,
): HyperVNetworkIntent {
    if (intent.marker === marker && intent.natName === natName) return intent;
    const persisted = readIntent(runtime);
    if (!persisted || !sameOwnershipReceipt(persisted, intent)) {
        throw new Error("hyper-v-network-intent-revision-conflict");
    }
    const observedToken = /^ccc-device-lab:hyper-v-network:([a-f0-9]{24})$/.exec(marker)?.[1];
    const transition = marker === HYPER_V_NETWORK_MARKER && natName === HYPER_V_NETWORK_NAT
        ? { ...persisted, marker, natName, ownershipOrigin: "adopted" as const }
        : intent.marker === HYPER_V_NETWORK_MARKER
            && observedToken
            && natName === `${HYPER_V_NETWORK_NAT}-${observedToken}`
            ? { ...persisted, token: observedToken, marker, natName, ownershipOrigin: "adopted" as const }
            : null;
    if (!transition) throw new Error("hyper-v-network-intent-identity-conflict");
    const checkpoint = decodeHyperVNetworkIntent(transition);
    ensureStateRoot(runtime);
    writeJsonFileAtomically(intentFile(runtime), checkpoint);
    runtime.assertSafePath(dirname(intentFile(runtime)), "hyper-v-network-intent-identity-transition-checkpoint");
    return checkpoint;
}

function persistTypedCurrentStateIdentityTransition(
    runtime: HyperVNetworkRuntime,
    current: HyperVNetworkState,
    marker: string,
    natName: string,
    natInstanceId: string,
): HyperVNetworkState {
    if (current.marker === marker && current.natName === natName) return current;
    if (!isAllowedPersistedCccIdentityTransition(current.marker, current.natName, marker, natName)) {
        throw new Error("hyper-v-network-state-identity-conflict");
    }
    const persisted = readState(runtime);
    if (!persisted || hyperVNetworkStateRevision(persisted) !== hyperVNetworkStateRevision(current)) {
        throw new Error("hyper-v-network-state-revision-conflict");
    }
    const checkpoint = decodeHyperVNetworkState({
        ...persisted,
        marker,
        natName,
        natInstanceId,
    });
    ensureStateRoot(runtime);
    writeJsonFileAtomically(stateFile(runtime), checkpoint);
    runtime.assertSafePath(dirname(stateFile(runtime)), "hyper-v-network-state-identity-transition-checkpoint");
    return checkpoint;
}

function typedOwnershipEvidenceFromConfirmedAction(
    action: DeviceLabHyperVHostNetworkEnsureCompletedAction,
    observation: HyperVHostNetworkObservation,
    network: HyperVHostNetworkSpec,
    marker: string,
): HyperVNetworkIntentOwnershipEvidence | null {
    switch (action.actionKind) {
        case "create-switch":
            if (action.switchIdentity.name !== network.switchName) {
                throw new Error("hyper-v-network-intent-ownership-conflict");
            }
            return {
                switch: {
                    switchName: String(action.switchIdentity.name),
                    switchId: String(action.switchIdentity.id).toLowerCase(),
                    marker,
                },
            };
        case "repair-switch-notes":
            return null;
        case "create-gateway": {
            const switches = observation.virtualSwitches.filter((candidate) =>
                candidate.name === network.switchName && candidate.notes === marker);
            const hostAdapters = observation.hostAdapters.filter((candidate) =>
                String(candidate.name) === `vEthernet (${network.switchName})`
                && candidate.interfaceIndex === action.gatewayIdentity.interfaceIndex);
            if (switches.length !== 1
                || hostAdapters.length !== 1
                || action.gatewayIdentity.address !== network.gateway
                || action.gatewayIdentity.prefixLength !== network.prefixLength) {
                throw new Error("hyper-v-network-intent-ownership-conflict");
            }
            const virtualSwitch = switches[0];
            if (!virtualSwitch) throw new Error("hyper-v-network-intent-ownership-conflict");
            return {
                gateway: {
                    switchName: String(virtualSwitch.name),
                    switchId: String(virtualSwitch.id).toLowerCase(),
                    marker,
                    prefix: String(network.cidr),
                    gateway: String(network.gateway),
                },
            };
        }
        case "create-nat":
            if (action.natIdentity.name !== network.natName) {
                throw new Error("hyper-v-network-intent-ownership-conflict");
            }
            return {
                nat: {
                    natName: String(action.natIdentity.name),
                    natInstanceId: String(action.natIdentity.instanceId),
                    marker,
                    prefix: String(network.cidr),
                },
            };
    }
}

function persistTypedOwnershipEvidence(
    runtime: HyperVNetworkRuntime,
    intent: HyperVNetworkIntent,
    nextEvidence: HyperVNetworkIntentOwnershipEvidence | null,
): HyperVNetworkIntent {
    if (!nextEvidence) return intent;

    const persisted = readIntent(runtime);
    if (!persisted || !sameOwnershipReceipt(persisted, intent)) {
        throw new Error("hyper-v-network-intent-revision-conflict");
    }
    const previousSwitchEvidence = persisted.ownershipEvidence?.switch ?? persisted.ownershipEvidence?.gateway;
    const switchReplaced = Boolean(nextEvidence.switch
        && previousSwitchEvidence
        && (nextEvidence.switch.switchName !== previousSwitchEvidence.switchName
            || nextEvidence.switch.switchId !== previousSwitchEvidence.switchId
            || nextEvidence.switch.marker !== previousSwitchEvidence.marker));
    const switchEvidence = nextEvidence.switch ?? persisted.ownershipEvidence?.switch;
    const gatewayEvidence = nextEvidence.gateway
        ?? (switchReplaced ? undefined : persisted.ownershipEvidence?.gateway);
    const natEvidence = nextEvidence.nat ?? persisted.ownershipEvidence?.nat;
    const ownershipEvidence: HyperVNetworkIntentOwnershipEvidence = {
        ...(switchEvidence ? { switch: switchEvidence } : {}),
        ...(gatewayEvidence ? { gateway: gatewayEvidence } : {}),
        ...(natEvidence ? { nat: natEvidence } : {}),
    };
    const checkpoint = decodeHyperVNetworkIntent({ ...persisted, ownershipEvidence });
    ensureStateRoot(runtime);
    writeJsonFileAtomically(intentFile(runtime), checkpoint);
    return checkpoint;
}

function ownershipEvidenceMatchesObservation(
    intent: HyperVNetworkIntent | null,
    observation: HyperVNetworkObservation,
    marker: string,
): { managedSwitch: boolean; managedGateway: boolean; managedNat: boolean } {
    const evidence = intent?.ownershipEvidence;
    const switchMatches = !evidence?.switch || (
        evidence.switch.switchName === observation.switchName
        && evidence.switch.switchId.toLowerCase() === observation.switchId.toLowerCase()
        && evidence.switch.marker === marker
    );
    const gatewayMatches = !evidence?.gateway || (
        evidence.gateway.switchName === observation.switchName
        && evidence.gateway.switchId.toLowerCase() === observation.switchId.toLowerCase()
        && evidence.gateway.marker === marker
        && evidence.gateway.prefix === observation.prefix
        && evidence.gateway.gateway === observation.gateway
    );
    const natMatches = !evidence?.nat || (
        evidence.nat.natName === observation.natName
        && evidence.nat.natInstanceId === observation.natInstanceId
        && evidence.nat.marker === marker
        && evidence.nat.prefix === observation.prefix
    );
    if (!switchMatches || !gatewayMatches || !natMatches) {
        throw new Error("hyper-v-network-intent-ownership-conflict");
    }
    return {
        managedSwitch: Boolean(evidence?.switch),
        managedGateway: Boolean(evidence?.gateway),
        managedNat: Boolean(evidence?.nat),
    };
}

function persistTypedOwnershipInCurrentState(
    runtime: HyperVNetworkRuntime,
    current: HyperVNetworkState,
    evidence: HyperVNetworkIntentOwnershipEvidence | null,
): HyperVNetworkState {
    if (!evidence) return current;

    const persisted = readState(runtime);
    if (!persisted || hyperVNetworkStateRevision(persisted) !== hyperVNetworkStateRevision(current)) {
        throw new Error("hyper-v-network-state-revision-conflict");
    }
    const switchEvidence = evidence.switch ?? evidence.gateway;
    const checkpoint = decodeHyperVNetworkState({
        ...current,
        ...(switchEvidence
            ? {
                switchName: switchEvidence.switchName,
                switchId: switchEvidence.switchId.toLowerCase(),
                marker: switchEvidence.marker,
            }
            : {}),
        ...(evidence.nat
            ? {
                natName: evidence.nat.natName,
                natInstanceId: evidence.nat.natInstanceId,
                marker: evidence.nat.marker,
            }
            : {}),
        managedSwitch: current.managedSwitch || Boolean(evidence.switch),
        managedGateway: current.managedGateway || Boolean(evidence.gateway),
        managedNat: current.managedNat || Boolean(evidence.nat),
    });
    ensureStateRoot(runtime);
    writeJsonFileAtomically(stateFile(runtime), checkpoint);
    return checkpoint;
}

function persistTypedCleanupCheckpoint(
    runtime: HyperVNetworkRuntime,
    current: HyperVNetworkState,
    action: DeviceLabHyperVHostNetworkCleanupCompletedAction,
): HyperVNetworkState | null {
    const persisted = readState(runtime);
    if (!persisted || hyperVNetworkStateRevision(persisted) !== hyperVNetworkStateRevision(current)) {
        throw new Error("hyper-v-network-state-revision-conflict");
    }
    let checkpoint: HyperVNetworkState;
    switch (action.actionKind) {
        case "remove-nat": {
            if (!current.managedNat
                || current.natInstanceId !== String(action.natIdentity.instanceId)
                || current.natName !== String(action.natIdentity.name)) {
                throw new Error("hyper-v-network-nat-identity-conflict");
            }
            const { natInstanceId: _removedNatIdentity, ...withoutNatIdentity } = current;
            checkpoint = decodeHyperVNetworkState({ ...withoutNatIdentity, managedNat: false });
            break;
        }
        case "remove-gateway":
            if (!current.managedGateway
                || String(action.gatewayIdentity.address) !== current.gateway
                || Number(action.gatewayIdentity.prefixLength) !== HYPER_V_NETWORK_PREFIX_LENGTH) {
                throw new Error("hyper-v-network-gateway-identity-conflict");
            }
            checkpoint = decodeHyperVNetworkState({ ...current, managedGateway: false });
            break;
        case "remove-switch":
            if (!current.managedSwitch
                || current.switchId.toLowerCase() !== String(action.switchIdentity.id).toLowerCase()
                || current.switchName !== String(action.switchIdentity.name)) {
                throw new Error("hyper-v-network-switch-identity-conflict");
            }
            checkpoint = decodeHyperVNetworkState({ ...current, managedSwitch: false });
            break;
    }
    ensureStateRoot(runtime);
    if (!checkpoint.managedSwitch && !checkpoint.managedGateway && !checkpoint.managedNat) {
        rmSync(stateFile(runtime), { force: true });
        runtime.assertSafePath(dirname(stateFile(runtime)), "hyper-v-network-cleanup-terminal-checkpoint");
        return null;
    }
    writeJsonFileAtomically(stateFile(runtime), checkpoint);
    return checkpoint;
}

function removeIntentBestEffort(runtime: HyperVNetworkStateRuntime): void {
    try {
        rmSync(intentFile(runtime), { recursive: true, force: true });
    } catch {
        // A later allocation reconciles stale intent against committed state.
    }
}

function commandSucceeded(result: HyperVNetworkCommandResult): boolean {
    return result.status === 0 && !result.error;
}

function legacyHostFabricCompatibility(runtime: HyperVNetworkRuntime) {
    if (runtime.hostFabric.kind !== "legacy-compatibility") {
        throw new Error("hyper-v-network-typed-runtime-missing");
    }
    return runtime.hostFabric;
}

function typedHostFabric(runtime: HyperVNetworkRuntime) {
    return runtime.hostFabric.kind === "typed" ? runtime.hostFabric : null;
}

async function reconcileOrphanedAllocations(
    runtime: HyperVNetworkRuntime,
    current: HyperVNetworkState,
    powershell: string,
    deadlineAt: number,
): Promise<HyperVNetworkState> {
    if (!runtime.allocationReferenced || current.allocations.length === 0) return current;
    const candidates: HyperVNetworkAllocation[] = [];
    for (const allocation of current.allocations) {
        assertHyperVOperationDeadline(deadlineAt);
        if (!allocation.incarnationId) throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
        if (!runtime.allocationReferenced(allocation)) candidates.push(allocation);
    }
    if (candidates.length === 0) return current;
    const orphaned = new Set<string>();
    for (let offset = 0; offset < candidates.length; offset += HYPER_V_NETWORK_INSPECTION_BATCH_SIZE) {
        const batch = candidates.slice(offset, offset + HYPER_V_NETWORK_INSPECTION_BATCH_SIZE);
        const typed = typedHostFabric(runtime);
        if (typed) {
            const names = batch.map(({ ownerId, deviceId, incarnationId }) => {
                if (!incarnationId) throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
                return parseHyperVVirtualMachineName(hyperVVmName(ownerId, deviceId, incarnationId));
            });
            const observed = await typed.client.getVMsByExactNames({ names });
            const byName = new Map(observed.map((virtualMachine) => [String(virtualMachine.name), virtualMachine]));
            for (const candidate of batch) {
                assertHyperVOperationDeadline(deadlineAt);
                const incarnationId = candidate.incarnationId;
                if (!incarnationId) throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
                const vmName = hyperVVmName(candidate.ownerId, candidate.deviceId, incarnationId);
                const virtualMachine = byName.get(vmName);
                if (virtualMachine
                    && virtualMachine.notes !== `ccc-device-lab:${candidate.ownerId}:${candidate.deviceId}:${incarnationId}`) {
                    throw new Error("hyper-v-network-allocation-vm-ownership-conflict");
                }
                if (!virtualMachine) orphaned.add(`${candidate.ownerId}:${candidate.deviceId}:${incarnationId}`);
            }
            continue;
        }
        const execution = await runtime.run(legacyHostFabricCompatibility(runtime).inspectAllocationsCommand({
            executable: powershell,
            allocations: batch.map(({ ownerId, deviceId, incarnationId }) => {
                if (!incarnationId) throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
                return { ownerId, deviceId, incarnationId };
            }),
        }), {
            timeoutMs: hyperVRemainingTimeout(deadlineAt, 120000),
            outputLimit: runtime.commandOutputBytes,
        });
        assertHyperVOperationDeadline(deadlineAt);
        if (!commandSucceeded(execution)) {
            throw new Error(hyperVProviderDiagnosticCode(execution, "hyper-v-network-allocation-inspection-failed"));
        }
        const observation = parseHyperVNetworkAllocationsObservation(execution.stdout || "");
        if (!observation || observation.allocations.length !== batch.length) {
            throw new Error("hyper-v-network-allocation-inspection-invalid-result");
        }
        for (let index = 0; index < batch.length; index += 1) {
            assertHyperVOperationDeadline(deadlineAt);
            const candidate = batch[index];
            const observed = observation.allocations[index];
            if (!candidate?.incarnationId) throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
            if (observed.ownerId !== candidate.ownerId
                || observed.deviceId !== candidate.deviceId
                || observed.incarnationId !== candidate.incarnationId
                || observed.vmName !== hyperVVmName(candidate.ownerId, candidate.deviceId, candidate.incarnationId)) {
                throw new Error("hyper-v-network-allocation-inspection-identity-mismatch");
            }
            if (!observed.present) orphaned.add(`${candidate.ownerId}:${candidate.deviceId}:${candidate.incarnationId}`);
        }
    }
    if (orphaned.size === 0) return current;
    const allocations = current.allocations.filter(
        (allocation) => !orphaned.has(`${allocation.ownerId}:${allocation.deviceId}:${allocation.incarnationId || ""}`),
    );
    assertHyperVOperationDeadline(deadlineAt);
    ensureStateRoot(runtime);
    const reconciled = { ...current, allocations };
    writeJsonFileAtomically(stateFile(runtime), reconciled);
    return reconciled;
}

function elevationRequired(result: HyperVNetworkCommandResult): boolean {
    const diagnostic = [result.error, result.stderr, result.stdout].map((value) => String(value || "")).join("\n");
    return diagnostic.includes("hyper-v-network-elevation-required")
        || diagnostic.includes("PermissionDenied")
        || diagnostic.includes("Windows System Error 5")
        || /access (?:is )?denied/i.test(diagnostic);
}

async function runWithElevation(
    runtime: HyperVNetworkRuntime,
    standard: HyperVProviderCommand,
    elevated: (deadlineUnixMs: number) => HyperVProviderCommand,
    deadlineAt: number,
): Promise<HyperVNetworkCommandResult> {
    let execution = await runtime.run(standard, {
        timeoutMs: hyperVRemainingTimeout(deadlineAt, 120000),
        outputLimit: runtime.commandOutputBytes,
    });
    if (!commandSucceeded(execution) && elevationRequired(execution)) {
        const timeoutMs = hyperVRemainingTimeout(deadlineAt, 180000);
        const elevatedDeadlineUnixMs = Date.now() + Math.max(1, timeoutMs - HYPER_V_ELEVATED_TERMINATION_GRACE_MS);
        let elevatedCommand: HyperVProviderCommand;
        try {
            elevatedCommand = elevated(elevatedDeadlineUnixMs);
        } catch (error) {
            return { ...execution, status: 1, error: error instanceof Error ? error.message : String(error) };
        }
        execution = await runtime.run(elevatedCommand, {
            timeoutMs,
            outputLimit: runtime.commandOutputBytes,
        });
    }
    return execution;
}

function typedHostNetworkSpec(switchName: string, natName: string): HyperVHostNetworkSpec {
    return createHyperVHostNetworkSpec({
        switchName: parseHyperVVirtualSwitchName(switchName),
        natName: parseHyperVNatName(natName),
        cidr: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
    });
}

function typedNetworkDiagnosticCode(error: unknown, fallback: string): string {
    if (error instanceof HyperVWindowsError) {
        if (/^hyper-v-[a-z0-9-]{3,128}$/.test(error.code)) return error.code;
        const normalized = error.code.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        return normalized ? `hyper-v-ps-${normalized}`.slice(0, 80).replace(/-+$/, "") : fallback;
    }
    return hyperVBoundedErrorCode(error, fallback);
}

function typedNetworkExecutionDiagnostic(error: unknown, fallback: string): Record<string, unknown> {
    const diagnosticCode = typedNetworkDiagnosticCode(error, fallback);
    return redactProviderCommandInput({
        mode: "exec",
        provider: "hyper-v",
        status: null,
        error: diagnosticCode,
    }, true, diagnosticCode);
}

function typedNetworkAllocationConflict(detail: string): string | null {
    if (detail === "hyper-v-network-conflict-switch-identity-conflict"
        || detail === "hyper-v-network-conflict-switch-successor-conflict") {
        return "hyper-v-network-switch-identity-conflict";
    }
    if (detail === "hyper-v-network-conflict-nat-identity-conflict"
        || detail === "hyper-v-network-conflict-nat-successor-conflict") {
        return "hyper-v-network-nat-identity-conflict";
    }
    return null;
}

function persistedNetworkProvenance(
    current: HyperVNetworkState,
): HyperVHostNetworkEnsureProvenance {
    return {
        kind: "persisted",
        expectedSwitchNotes: current.marker,
        switchIdentity: {
            id: parseHyperVVirtualSwitchId(current.switchId),
            name: parseHyperVVirtualSwitchName(current.switchName),
        },
        nat: current.natInstanceId
            ? {
                kind: "exact",
                identity: {
                    instanceId: parseHyperVNatInstanceId(current.natInstanceId),
                    name: parseHyperVNatName(current.natName),
                },
            }
            : { kind: "unrecorded" },
    };
}

function natNameFromCccMarker(marker: string): string | null {
    if (marker === HYPER_V_NETWORK_MARKER) return HYPER_V_NETWORK_NAT;
    const match = /^ccc-device-lab:hyper-v-network:([a-f0-9]{24})$/.exec(marker);
    return match ? `${HYPER_V_NETWORK_NAT}-${match[1]}` : null;
}

function isStableCccNetworkIdentity(marker: string, natName: string): boolean {
    return marker === HYPER_V_NETWORK_MARKER && natName === HYPER_V_NETWORK_NAT;
}

function isTokenCccNetworkIdentity(marker: string, natName: string): boolean {
    return marker !== HYPER_V_NETWORK_MARKER && isHyperVCccNetworkIdentity(marker, natName);
}

function isAllowedPersistedCccIdentityTransition(
    currentMarker: string,
    currentNatName: string,
    observedMarker: string,
    observedNatName: string,
): boolean {
    return (isStableCccNetworkIdentity(currentMarker, currentNatName)
            && isTokenCccNetworkIdentity(observedMarker, observedNatName))
        || (isTokenCccNetworkIdentity(currentMarker, currentNatName)
            && isStableCccNetworkIdentity(observedMarker, observedNatName));
}

async function typedEnsureProvenance(
    runtime: HyperVNetworkRuntime,
    client: HyperVWindowsNetworkClient,
    current: HyperVNetworkState | null,
    intent: HyperVNetworkIntent | null,
): Promise<{
    readonly network: HyperVHostNetworkSpec;
    readonly provenance: HyperVHostNetworkEnsureProvenance;
    readonly current: HyperVNetworkState | null;
    readonly intent: HyperVNetworkIntent | null;
    readonly freshIntentOwnershipEligible: boolean;
}> {
    if (current) {
        const currentNetwork = typedHostNetworkSpec(current.switchName, current.natName);
        const currentProvenance = persistedNetworkProvenance(current);
        if (current.natInstanceId) {
            const inspection = await inspectDeviceLabHyperVHostNetwork(client, {
                network: currentNetwork,
                provenance: currentProvenance,
                privilege: "standard",
            });
            const exactSwitches = inspection.virtualSwitches.filter((candidate) =>
                String(candidate.id).toLowerCase() === current.switchId.toLowerCase()
                && String(candidate.name) === current.switchName);
            const exactNats = inspection.nats.filter((candidate) =>
                String(candidate.instanceId) === current.natInstanceId);
            if (exactSwitches.length === 1 && exactNats.length === 1) {
                const exactSwitch = exactSwitches[0];
                const exactNat = exactNats[0];
                if (exactSwitch && exactNat
                    && isAllowedPersistedCccIdentityTransition(
                        current.marker,
                        current.natName,
                        exactSwitch.notes,
                        String(exactNat.name),
                    )) {
                    const transitionedCurrent = persistTypedCurrentStateIdentityTransition(
                        runtime,
                        current,
                        exactSwitch.notes,
                        String(exactNat.name),
                        String(exactNat.instanceId),
                    );
                    return {
                        network: typedHostNetworkSpec(current.switchName, String(exactNat.name)),
                        provenance: {
                            kind: "recognized-adoption",
                            expectedSwitchNotes: exactSwitch.notes,
                            switchIdentity: { id: exactSwitch.id, name: exactSwitch.name },
                            nat: {
                                kind: "exact",
                                identity: { instanceId: exactNat.instanceId, name: exactNat.name },
                            },
                        },
                        current: transitionedCurrent,
                        intent,
                        freshIntentOwnershipEligible: false,
                    };
                }
            }
        }
        return {
            network: currentNetwork,
            provenance: currentProvenance,
            current,
            intent,
            freshIntentOwnershipEligible: false,
        };
    }
    if (!intent) throw new Error("hyper-v-network-intent-missing");

    const intendedNetwork = typedHostNetworkSpec(intent.switchName, intent.natName);
    const evidenceSwitch = intent.ownershipEvidence?.switch ?? intent.ownershipEvidence?.gateway;
    const evidenceNat = intent.ownershipEvidence?.nat;
    if (evidenceSwitch) {
        return {
            network: intendedNetwork,
            provenance: {
                kind: "persisted",
                expectedSwitchNotes: intent.marker,
                switchIdentity: {
                    id: parseHyperVVirtualSwitchId(evidenceSwitch.switchId),
                    name: parseHyperVVirtualSwitchName(evidenceSwitch.switchName),
                },
                nat: evidenceNat
                    ? {
                        kind: "exact",
                        identity: {
                            instanceId: parseHyperVNatInstanceId(evidenceNat.natInstanceId),
                            name: parseHyperVNatName(evidenceNat.natName),
                        },
                    }
                    : { kind: "unrecorded" },
            },
            current: null,
            intent,
            freshIntentOwnershipEligible: intentCanClaimFreshOwnership(intent),
        };
    }
    const fresh: HyperVHostNetworkEnsureProvenance = {
        kind: "fresh",
        expectedSwitchNotes: intent.marker,
    };
    const inspection = await inspectDeviceLabHyperVHostNetwork(client, {
        network: intendedNetwork,
        provenance: fresh,
        privilege: "standard",
    });
    if (inspection.virtualSwitches.length !== 1) {
        return { network: intendedNetwork, provenance: fresh, current: null, intent, freshIntentOwnershipEligible: true };
    }
    const virtualSwitch = inspection.virtualSwitches[0];
    if (!virtualSwitch) {
        return { network: intendedNetwork, provenance: fresh, current: null, intent, freshIntentOwnershipEligible: true };
    }
    const adoptedNatName = natNameFromCccMarker(virtualSwitch.notes);
    if (!adoptedNatName || !isHyperVCccNetworkIdentity(virtualSwitch.notes, adoptedNatName)) {
        return { network: intendedNetwork, provenance: fresh, current: null, intent, freshIntentOwnershipEligible: true };
    }
    const matchingNats = inspection.nats.filter((nat) => String(nat.name) === adoptedNatName);
    if (matchingNats.length > 1) throw new Error("hyper-v-network-nat-ambiguous");
    const adoptedNat = matchingNats[0];
    const transitionedIntent = persistTypedIntentIdentityTransition(
        runtime,
        intent,
        virtualSwitch.notes,
        adoptedNatName,
    );
    return {
        network: typedHostNetworkSpec(transitionedIntent.switchName, transitionedIntent.natName),
        provenance: {
            kind: "recognized-adoption",
            expectedSwitchNotes: virtualSwitch.notes,
            switchIdentity: { id: virtualSwitch.id, name: virtualSwitch.name },
            nat: evidenceNat
                ? {
                    kind: "exact",
                    identity: {
                        instanceId: parseHyperVNatInstanceId(evidenceNat.natInstanceId),
                        name: parseHyperVNatName(evidenceNat.natName),
                    },
                }
                : adoptedNat
                    ? { kind: "exact", identity: { instanceId: adoptedNat.instanceId, name: adoptedNat.name } }
                : { kind: "absent" },
        },
        current: null,
        intent: transitionedIntent,
        freshIntentOwnershipEligible: intentCanClaimFreshOwnership(transitionedIntent),
    };
}

async function ensureTypedHyperVHostNetwork(
    runtime: HyperVNetworkRuntime,
    current: HyperVNetworkState | null,
    intent: HyperVNetworkIntent | null,
): Promise<{
    observation: HyperVNetworkObservation;
    current: HyperVNetworkState | null;
    intent: HyperVNetworkIntent | null;
    freshIntentOwnershipEligible: boolean;
}> {
    const typed = typedHostFabric(runtime);
    if (!typed) throw new Error("hyper-v-network-typed-runtime-missing");
    const request = await typedEnsureProvenance(runtime, typed.client, current, intent);
    let checkpointedCurrent = request.current;
    let checkpointedIntent = request.intent;
    const transaction = await ensureDeviceLabHyperVHostNetwork({
        client: typed.client,
        network: request.network,
        provenance: request.provenance,
        withAdministratorClient: typed.withAdministratorClient,
        onConfirmedAction: (action, observation) => {
            const evidence = typedOwnershipEvidenceFromConfirmedAction(
                action,
                observation,
                request.network,
                request.provenance.expectedSwitchNotes,
            );
            if (checkpointedCurrent) {
                checkpointedCurrent = persistTypedOwnershipInCurrentState(
                    runtime,
                    checkpointedCurrent,
                    evidence,
                );
            } else if (checkpointedIntent) {
                checkpointedIntent = persistTypedOwnershipEvidence(
                    runtime,
                    checkpointedIntent,
                    evidence,
                );
            } else {
                throw new Error("hyper-v-network-intent-missing");
            }
        },
    });
    const outcome = transaction.outcome;
    if (outcome.kind !== "settled" || outcome.operation !== "ensure") {
        if (outcome.kind === "indeterminate" && outcome.cause instanceof HyperVWindowsError) {
            throw outcome.cause;
        }
        const detail = outcome.kind === "conflict" || outcome.kind === "indeterminate"
            ? outcome.reason
            : outcome.kind;
        throw new Error(`hyper-v-network-${outcome.kind}-${detail}`);
    }
    const completed = new Set(transaction.completedActions.map((action) => action.actionKind));
    return {
        observation: {
            ok: true,
            switchName: String(outcome.identity.switchIdentity.name),
            switchId: String(outcome.identity.switchIdentity.id),
            marker: request.provenance.expectedSwitchNotes,
            natName: String(outcome.identity.natIdentity.name),
            natInstanceId: String(outcome.identity.natIdentity.instanceId),
            prefix: String(request.network.cidr),
            gateway: String(request.network.gateway),
            interfaceIndex: Number(outcome.identity.interfaceIndex),
            createdSwitch: completed.has("create-switch"),
            createdGateway: completed.has("create-gateway"),
            createdNat: completed.has("create-nat"),
        },
        current: checkpointedCurrent,
        intent: checkpointedIntent,
        freshIntentOwnershipEligible: request.freshIntentOwnershipEligible,
    };
}

function typedCleanupProvenance(release: HyperVNetworkRelease): HyperVHostNetworkCleanupProvenance {
    if (!release.switchName || !release.switchId || !release.natName) {
        throw new Error("hyper-v-network-identity-unproven");
    }
    const switchIdentity = {
        id: parseHyperVVirtualSwitchId(release.switchId),
        name: parseHyperVVirtualSwitchName(release.switchName),
    };
    return {
        switch: release.managedSwitch === true
            ? { kind: "managed", identity: switchIdentity }
            : { kind: "unmanaged" },
        gateway: release.managedGateway === true
            ? {
                kind: "managed",
                identity: {
                    switchIdentity,
                    address: typedHostNetworkSpec(release.switchName, release.natName).gateway,
                    prefixLength: typedHostNetworkSpec(release.switchName, release.natName).prefixLength,
                },
            }
            : { kind: "unmanaged" },
        nat: release.managedNat === true && release.natInstanceId
            ? {
                kind: "managed",
                identity: {
                    instanceId: parseHyperVNatInstanceId(release.natInstanceId),
                    name: parseHyperVNatName(release.natName),
                },
            }
            : { kind: "unmanaged" },
    };
}

async function cleanupTypedHyperVHostNetwork(
    runtime: HyperVNetworkRuntime,
    release: HyperVNetworkRelease,
) {
    const typed = typedHostFabric(runtime);
    if (!typed || !release.switchName || !release.natName) {
        throw new Error("hyper-v-network-typed-runtime-missing");
    }
    const network = typedHostNetworkSpec(release.switchName, release.natName);
    const persistedState = readState(runtime);
    if (!persistedState
        || !release.stateRevision
        || hyperVNetworkStateRevision(persistedState) !== release.stateRevision) {
        throw new Error("hyper-v-network-state-revision-conflict");
    }
    let checkpointedState: HyperVNetworkState | null = persistedState;
    const transaction = await cleanupDeviceLabHyperVHostNetwork({
        client: typed.client,
        network,
        provenance: typedCleanupProvenance(release),
        withAdministratorClient: typed.withAdministratorClient,
        onConfirmedAction: (action) => {
            if (!checkpointedState) throw new Error("hyper-v-network-state-missing");
            checkpointedState = persistTypedCleanupCheckpoint(runtime, checkpointedState, action);
        },
    });
    const outcome = transaction.outcome;
    if (outcome.kind !== "settled" || outcome.operation !== "cleanup") {
        if (outcome.kind === "indeterminate" && outcome.cause instanceof HyperVWindowsError) {
            throw outcome.cause;
        }
        const detail = outcome.kind === "conflict" || outcome.kind === "indeterminate"
            ? outcome.reason
            : outcome.kind;
        throw new Error(`hyper-v-network-${outcome.kind}-${detail}`);
    }
    const completed = new Set(transaction.completedActions.map((action) => action.actionKind));
    if (outcome.disposition === "deferred-switch-in-use") {
        if (!checkpointedState) {
            return {
                observation: {
                    ok: true,
                    removedSwitch: completed.has("remove-switch"),
                    removedNat: completed.has("remove-nat"),
                    removedGateway: completed.has("remove-gateway"),
                    alreadyMissing: false,
                },
                stateRevision: undefined,
            };
        }
        return {
            observation: {
                ok: true,
                removedSwitch: false,
                removedNat: completed.has("remove-nat"),
                removedGateway: completed.has("remove-gateway"),
                alreadyMissing: false,
                deferred: true,
                reason: "hyper-v-network-switch-in-use" as const,
            },
            stateRevision: hyperVNetworkStateRevision(checkpointedState),
        };
    }
    return {
        observation: {
            ok: true,
            removedSwitch: completed.has("remove-switch"),
            removedNat: completed.has("remove-nat"),
            removedGateway: completed.has("remove-gateway"),
            alreadyMissing: transaction.completedActions.length === 0,
        },
        stateRevision: checkpointedState ? hyperVNetworkStateRevision(checkpointedState) : undefined,
    };
}

export async function ensureHyperVNetworkAllocation(
    runtime: HyperVNetworkRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId: string,
    deadlineAt = Number.POSITIVE_INFINITY,
): Promise<
    | { ok: true; switchName: string; address: string; macAddress: string; gateway: string; prefix: string; outboundPolicy: "nat" }
    | { ok: false; status: number; error: string; detail?: string; execution?: Record<string, unknown>; preserveEvidence?: boolean }
> {
    const powershell = runtime.resolveExecutable("powershell.exe")
        || runtime.resolveExecutable("pwsh")
        || runtime.resolveExecutable("powershell");
    if (!powershell) return { ok: false, status: 503, error: "missing-provider-command", detail: "powershell" };
    if (!validHyperVIncarnationId(incarnationId)) return { ok: false, status: 409, error: "hyper-v-network-incarnation-invalid" };
    let current: HyperVNetworkState | null;
    let intent: HyperVNetworkIntent | null = null;
    try {
        current = readState(runtime);
        if (current) {
            let staleIntent: HyperVNetworkIntent | null = null;
            try {
                staleIntent = readIntent(runtime);
            } catch {
                // Committed state is authoritative.
            }
            if (staleIntent && (current.switchName !== staleIntent.switchName
                || current.natName !== staleIntent.natName
                || current.marker !== staleIntent.marker)) {
                throw new Error("hyper-v-network-intent-state-conflict");
            }
            removeIntentBestEffort(runtime);
        } else {
            intent = readIntent(runtime);
            if (!intent) intent = createIntent(runtime);
        }
    } catch (error) {
        return {
            ok: false,
            status: 409,
            error: "hyper-v-network-allocation-failed",
            detail: hyperVBoundedErrorCode(error, "hyper-v-network-allocation-failed"),
        };
    }
    const expectedNetworkIdentity = current ?? intent;
    if (!expectedNetworkIdentity) {
        return {
            ok: false,
            status: 409,
            error: "hyper-v-network-allocation-failed",
            detail: "hyper-v-network-intent-missing",
        };
    }
    try {
        if (current) current = await reconcileOrphanedAllocations(runtime, current, powershell, deadlineAt);
    } catch (error) {
        return {
            ok: false,
            status: 409,
            error: "hyper-v-network-allocation-reconciliation-failed",
            detail: hyperVBoundedErrorCode(error, "hyper-v-network-allocation-reconciliation-failed"),
            preserveEvidence: true,
        };
    }
    const currentUsesLegacyTokenIdentity = Boolean(current
        && current.marker !== HYPER_V_NETWORK_MARKER
        && isHyperVCccNetworkIdentity(current.marker, current.natName));
    const canRepairPersistedCccIdentity = Boolean(current
        && isHyperVCccNetworkIdentity(current.marker, current.natName)
        && current.switchId
        && current.natInstanceId);
    const canReconcileNetworkIdentity = !current
        || (current.allocations.length === 0 && !canRepairPersistedCccIdentity);
    const networkOptions = {
        executable: powershell,
        switchName: expectedNetworkIdentity.switchName,
        natName: expectedNetworkIdentity.natName,
        marker: expectedNetworkIdentity.marker,
        prefix: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
        prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
        allowExistingNat: Boolean(current?.natInstanceId) && !canReconcileNetworkIdentity,
        allowCccOwnedNetworkAdoption: canReconcileNetworkIdentity,
        allowPersistedCccIdentityRepair: canRepairPersistedCccIdentity,
        expectedSwitchId: canReconcileNetworkIdentity ? undefined : current?.switchId,
        expectedNatInstanceId: canReconcileNetworkIdentity ? undefined : current?.natInstanceId,
    };
    let observation: HyperVNetworkObservation | null;
    let typedFreshIntentOwnershipEligible = false;
    if (typedHostFabric(runtime)) {
        try {
            const typedResult = await ensureTypedHyperVHostNetwork(runtime, current, intent);
            observation = typedResult.observation;
            current = typedResult.current;
            intent = typedResult.intent;
            typedFreshIntentOwnershipEligible = typedResult.freshIntentOwnershipEligible;
        } catch (error) {
            const detail = typedNetworkDiagnosticCode(error, "hyper-v-network-setup-failed");
            const allocationConflict = typedNetworkAllocationConflict(detail);
            if (allocationConflict) {
                return {
                    ok: false,
                    status: 409,
                    error: "hyper-v-network-allocation-failed",
                    detail: allocationConflict,
                    preserveEvidence: true,
                };
            }
            return {
                ok: false,
                status: 502,
                error: "hyper-v-network-setup-failed",
                detail,
                execution: typedNetworkExecutionDiagnostic(error, detail),
                preserveEvidence: true,
            };
        }
    } else {
        const execution = await runWithElevation(
            runtime,
            legacyHostFabricCompatibility(runtime).ensureCommand(networkOptions),
            (elevatedDeadlineUnixMs) => legacyHostFabricCompatibility(runtime).ensureCommand({
                ...networkOptions,
                executable: runtime.resolveElevationExecutable(powershell),
                elevated: true,
                elevatedDeadlineUnixMs,
            }),
            deadlineAt,
        );
        assertHyperVOperationDeadline(deadlineAt);
        if (!commandSucceeded(execution)) {
            return {
                ok: false,
                status: 502,
                error: "hyper-v-network-setup-failed",
                detail: hyperVProviderDiagnosticCode(execution, "hyper-v-network-setup-failed"),
                execution: redactProviderCommandInput(execution, true, "hyper-v-network-setup-failed"),
                preserveEvidence: true,
            };
        }
        observation = parseHyperVNetworkObservation(execution.stdout || "");
    }
    const observedMarker = observation?.marker || expectedNetworkIdentity.marker;
    const observedIdentityIsCccOwned = isHyperVCccNetworkIdentity(observedMarker, observation?.natName);
    const observedUsesLegacyTokenIdentity = Boolean(observation
        && observedMarker !== HYPER_V_NETWORK_MARKER
        && isHyperVCccNetworkIdentity(observedMarker, observation.natName));
    const persistedIdentityTransitionIsAllowed = Boolean(current && observation
        && ((currentUsesLegacyTokenIdentity
            && observedMarker === HYPER_V_NETWORK_MARKER
            && observation.natName === HYPER_V_NETWORK_NAT)
        || (current.marker === HYPER_V_NETWORK_MARKER
            && current.natName === HYPER_V_NETWORK_NAT
            && observedUsesLegacyTokenIdentity)));
    const observedPersistedIdentityMatches = Boolean(canRepairPersistedCccIdentity
        && current
        && observation
        && current.switchId.toLowerCase() === observation.switchId.toLowerCase()
        && current.natInstanceId
        && current.natInstanceId === observation.natInstanceId
        && persistedIdentityTransitionIsAllowed);
    if (!observation
        || observation.switchName !== expectedNetworkIdentity.switchName
        || (current
            ? (!canReconcileNetworkIdentity
                && (observation.natName !== current.natName || observedMarker !== current.marker)
                && !(observedPersistedIdentityMatches && observedIdentityIsCccOwned))
                || (canReconcileNetworkIdentity && !observedIdentityIsCccOwned)
            : !observedIdentityIsCccOwned)
        || observation.prefix !== HYPER_V_NETWORK_PREFIX
        || observation.gateway !== HYPER_V_NETWORK_GATEWAY) {
        return { ok: false, status: 502, error: "hyper-v-network-setup-invalid-result", preserveEvidence: true };
    }
    try {
        if (current && !canReconcileNetworkIdentity && current.switchId.toLowerCase() !== observation.switchId.toLowerCase()) {
            throw new Error("hyper-v-network-switch-identity-conflict");
        }
        if (current?.natInstanceId && !canReconcileNetworkIdentity && current.natInstanceId !== observation.natInstanceId) {
            throw new Error("hyper-v-network-nat-identity-conflict");
        }
        const typedIntentOwnership = typedHostFabric(runtime)
            ? ownershipEvidenceMatchesObservation(intent, observation, observedMarker)
            : { managedSwitch: false, managedGateway: false, managedNat: false };
        const resourceIdentityReconciled = Boolean(current && (
            current.switchId.toLowerCase() !== observation.switchId.toLowerCase()
            || current.natInstanceId !== observation.natInstanceId
        ));
        const allocations = current?.allocations || [];
        const existing = allocations.find((allocation) => allocation.ownerId === ownerId && allocation.deviceId === deviceId);
        if (existing) {
            if (existing.incarnationId !== incarnationId) throw new Error("hyper-v-network-allocation-incarnation-conflict");
            if (current && (current.marker !== observedMarker || current.natName !== observation.natName)) {
                ensureStateRoot(runtime);
                writeJsonFileAtomically(stateFile(runtime), {
                    ...current,
                    switchId: observation.switchId.toLowerCase(),
                    marker: observedMarker,
                    natName: observation.natName,
                    natInstanceId: observation.natInstanceId,
                });
            }
            return {
                ok: true,
                switchName: observation.switchName,
                address: existing.address,
                macAddress: existing.macAddress,
                gateway: observation.gateway,
                prefix: observation.prefix,
                outboundPolicy: "nat",
            };
        }
        const used = new Set(allocations.map((allocation) => allocation.address));
        const address = hyperVDeterministicNetworkAddresses(ownerId, deviceId).find((candidate) => !used.has(candidate));
        if (!address) throw new Error("hyper-v-network-address-space-exhausted");
        const usedMacs = new Set(allocations.map((allocation) => allocation.macAddress));
        let macSalt = 0;
        let macAddress = hyperVDeterministicMacAddress(ownerId, deviceId, macSalt);
        while (usedMacs.has(macAddress) && macSalt < 1024) {
            macAddress = hyperVDeterministicMacAddress(ownerId, deviceId, ++macSalt);
        }
        if (usedMacs.has(macAddress)) throw new Error("hyper-v-network-mac-space-exhausted");
        const legacyFreshIntentOwnsObservedIdentity = !typedHostFabric(runtime) && !current && intent
            ? intentOwnsDedicatedNat({ ...intent, marker: observedMarker, natName: observation.natName })
            : false;
        const typedFreshIntentOwnsObservedIdentity = Boolean(
            typedHostFabric(runtime)
            && !current
            && intent
            && typedFreshIntentOwnershipEligible
            && intentCanClaimFreshOwnership(intent)
            && intent.marker === observedMarker
            && intent.switchName === observation.switchName
            && intent.natName === observation.natName,
        );
        const next: HyperVNetworkState = {
            version: 1,
            switchName: observation.switchName,
            switchId: observation.switchId.toLowerCase(),
            marker: observedMarker,
            natName: observation.natName,
            natInstanceId: observation.natInstanceId,
            prefix: observation.prefix,
            gateway: observation.gateway,
            outboundPolicy: "nat",
            managedSwitch: (!resourceIdentityReconciled && current?.managedSwitch === true)
                || observation.createdSwitch
                || typedIntentOwnership.managedSwitch
                || typedFreshIntentOwnsObservedIdentity
                || legacyFreshIntentOwnsObservedIdentity,
            managedGateway: (!resourceIdentityReconciled && current?.managedGateway === true)
                || observation.createdGateway === true
                || (!typedHostFabric(runtime) && observation.createdSwitch)
                || typedIntentOwnership.managedGateway
                || typedFreshIntentOwnsObservedIdentity
                || legacyFreshIntentOwnsObservedIdentity,
            managedNat: (!resourceIdentityReconciled && current?.managedNat === true)
                || observation.createdNat
                || typedIntentOwnership.managedNat
                || typedFreshIntentOwnsObservedIdentity
                || legacyFreshIntentOwnsObservedIdentity,
            allocations: [
                ...allocations,
                { ownerId, deviceId, incarnationId, address, macAddress, allocatedAt: new Date().toISOString() },
            ],
        };
        ensureStateRoot(runtime);
        writeJsonFileAtomically(stateFile(runtime), next);
        removeIntentBestEffort(runtime);
        return {
            ok: true,
            switchName: observation.switchName,
            address,
            macAddress,
            gateway: observation.gateway,
            prefix: observation.prefix,
            outboundPolicy: "nat",
        };
    } catch (error) {
        let cleanupFailure: string | null = null;
        const typedEvidencePreserved = Boolean(typedHostFabric(runtime)
            && (observation.createdSwitch || observation.createdGateway === true || observation.createdNat));
        if (!typedHostFabric(runtime)
            && (observation.createdSwitch || observation.createdGateway === true || observation.createdNat)) {
            try {
                const cleanupOptions = {
                    executable: powershell,
                    switchName: observation.switchName,
                    natName: observation.natName,
                    marker: observedMarker,
                    prefix: HYPER_V_NETWORK_PREFIX,
                    gateway: HYPER_V_NETWORK_GATEWAY,
                    prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
                    removeNat: observation.createdNat,
                    removeSwitch: observation.createdSwitch,
                    removeGateway: observation.createdGateway === true || observation.createdSwitch,
                    expectedSwitchId: observation.switchId,
                    expectedNatInstanceId: observation.createdNat ? observation.natInstanceId : undefined,
                };
                const cleanupExecution = await runWithElevation(
                    runtime,
                    legacyHostFabricCompatibility(runtime).cleanupCommand(cleanupOptions),
                    (elevatedDeadlineUnixMs) => legacyHostFabricCompatibility(runtime).cleanupCommand({
                        ...cleanupOptions,
                        executable: runtime.resolveElevationExecutable(powershell),
                        elevated: true,
                        elevatedDeadlineUnixMs,
                    }),
                    deadlineAt,
                );
                if (!commandSucceeded(cleanupExecution)) {
                    cleanupFailure = hyperVProviderDiagnosticCode(cleanupExecution, "hyper-v-network-cleanup-failed")
                        || "hyper-v-network-cleanup-failed";
                } else if (!parseHyperVNetworkCleanupObservation(cleanupExecution.stdout || "")) {
                    cleanupFailure = "hyper-v-network-cleanup-invalid-result";
                }
            } catch (cleanupError) {
                cleanupFailure = hyperVBoundedErrorCode(cleanupError, "hyper-v-network-cleanup-failed");
            }
        }
        const allocationDetail = hyperVBoundedErrorCode(error, "hyper-v-network-allocation-failed");
        return {
            ok: false,
            status: cleanupFailure ? 502 : 409,
            error: cleanupFailure ? "hyper-v-network-allocation-cleanup-failed" : "hyper-v-network-allocation-failed",
            detail: cleanupFailure || allocationDetail,
            ...(cleanupFailure || typedEvidencePreserved ? { preserveEvidence: true } : {}),
        };
    }
}

export function releaseHyperVNetworkAllocation(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId?: string | null,
): HyperVNetworkRelease {
    try {
        const current = readState(runtime);
        if (!current) return { ok: true, released: false, statePresent: false, remaining: 0 };
        const matched = current.allocations.find((allocation) => allocation.ownerId === ownerId && allocation.deviceId === deviceId);
        const identity = {
            managedSwitch: current.managedSwitch,
            managedGateway: current.managedGateway,
            managedNat: current.managedNat,
            switchName: current.switchName,
            switchId: current.switchId,
            natName: current.natName,
            marker: current.marker,
            natInstanceId: current.natInstanceId,
            stateRevision: hyperVNetworkStateRevision(current),
        };
        if (matched?.incarnationId && matched.incarnationId !== incarnationId) {
            return {
                ok: false,
                released: false,
                statePresent: true,
                remaining: current.allocations.length,
                ...identity,
                error: "hyper-v-network-allocation-incarnation-conflict",
            };
        }
        const allocations = current.allocations.filter((allocation) => allocation !== matched);
        if (allocations.length === current.allocations.length) {
            return { ok: true, released: false, statePresent: true, remaining: allocations.length, ...identity };
        }
        if (allocations.length === 0 && (current.managedSwitch || current.managedGateway || current.managedNat)) {
            return { ok: true, released: true, statePresent: true, remaining: 0, ...identity };
        }
        ensureStateRoot(runtime);
        writeJsonFileAtomically(stateFile(runtime), { ...current, allocations });
        return { ok: true, released: true, statePresent: true, remaining: allocations.length, ...identity };
    } catch (error) {
        return {
            ok: false,
            released: false,
            statePresent: true,
            remaining: -1,
            error: hyperVBoundedErrorCode(error, "hyper-v-network-state-update-failed"),
        };
    }
}

function commitDeferredHyperVNetworkRelease(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId: string | null | undefined,
    expectedStateRevision: string | undefined,
    cleanup: HyperVNetworkCleanupObservation,
): { ok: true; remaining: number } | { ok: false; error: string } {
    try {
        const current = readState(runtime);
        if (!current) return { ok: false, error: "hyper-v-network-state-missing" };
        if (!expectedStateRevision || hyperVNetworkStateRevision(current) !== expectedStateRevision) {
            return { ok: false, error: "hyper-v-network-state-revision-conflict" };
        }
        const matched = current.allocations.find((allocation) => allocation.ownerId === ownerId && allocation.deviceId === deviceId);
        if (!matched) return { ok: false, error: "hyper-v-network-allocation-missing" };
        if (!validHyperVIncarnationId(incarnationId) || matched.incarnationId !== incarnationId) {
            return { ok: false, error: "hyper-v-network-allocation-incarnation-conflict" };
        }
        const allocations = current.allocations.filter((allocation) => allocation !== matched);
        let next: HyperVNetworkState;
        if (cleanup.removedNat) {
            const { natInstanceId: _removedNatIdentity, ...withoutNatIdentity } = current;
            next = {
                ...withoutNatIdentity,
                managedSwitch: cleanup.removedSwitch ? false : current.managedSwitch,
                managedGateway: cleanup.removedGateway ? false : current.managedGateway,
                managedNat: false,
                allocations,
            };
        } else if (current.managedNat) {
            next = {
                ...current,
                managedSwitch: cleanup.removedSwitch ? false : current.managedSwitch,
                managedGateway: cleanup.removedGateway ? false : current.managedGateway,
                managedNat: true,
                allocations,
            };
        } else {
            next = {
                ...current,
                managedSwitch: cleanup.removedSwitch ? false : current.managedSwitch,
                managedGateway: cleanup.removedGateway ? false : current.managedGateway,
                managedNat: false,
                allocations,
            };
        }
        ensureStateRoot(runtime);
        writeJsonFileAtomically(stateFile(runtime), next);
        return { ok: true, remaining: allocations.length };
    } catch (error) {
        return { ok: false, error: hyperVBoundedErrorCode(error, "hyper-v-network-state-update-failed") };
    }
}

export async function releaseHyperVNetworkAllocationAndCleanup(
    runtime: HyperVNetworkRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId: string | null | undefined,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    const release = releaseHyperVNetworkAllocation(runtime, ownerId, deviceId, incarnationId);
    if (!release.ok || !release.statePresent || !release.released || release.remaining !== 0) {
        return { ...release, networkCleanup: null };
    }
    if (release.managedSwitch !== true && release.managedGateway !== true && release.managedNat !== true) {
        return { ...release, networkCleanup: { skipped: true, reason: "hyper-v-network-ownership-unproven" } };
    }
    if (!release.switchId) {
        return { ...release, ok: false, error: "hyper-v-network-switch-identity-unproven", networkCleanup: null };
    }
    if (!release.switchName || !release.natName || !release.marker) {
        return { ...release, ok: false, error: "hyper-v-network-identity-unproven", networkCleanup: null };
    }
    if (release.managedNat === true && !release.natInstanceId) {
        return { ...release, ok: false, error: "hyper-v-network-nat-identity-unproven", networkCleanup: null };
    }
    const powershell = runtime.resolveExecutable("powershell.exe")
        || runtime.resolveExecutable("pwsh")
        || runtime.resolveExecutable("powershell");
    if (!powershell) return { ...release, ok: false, error: "missing-provider-command", networkCleanup: null };
    const cleanupOptions = {
        executable: powershell,
        switchName: release.switchName,
        natName: release.natName,
        marker: release.marker,
        prefix: HYPER_V_NETWORK_PREFIX,
        gateway: HYPER_V_NETWORK_GATEWAY,
        prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
        removeNat: release.managedNat === true,
        removeSwitch: release.managedSwitch === true,
        removeGateway: release.managedGateway === true,
        expectedSwitchId: release.switchId,
        expectedNatInstanceId: release.natInstanceId,
    };
    let observation;
    let cleanupStateRevision = release.stateRevision;
    if (typedHostFabric(runtime)) {
        try {
            const typedResult = await cleanupTypedHyperVHostNetwork(runtime, release);
            observation = typedResult.observation;
            cleanupStateRevision = typedResult.stateRevision;
        } catch (error) {
            const diagnosticCode = typedNetworkDiagnosticCode(error, "hyper-v-network-cleanup-failed");
            return {
                ...release,
                ok: false,
                error: diagnosticCode,
                networkCleanup: typedNetworkExecutionDiagnostic(error, diagnosticCode),
            };
        }
    } else {
        const execution = await runWithElevation(
            runtime,
            legacyHostFabricCompatibility(runtime).cleanupCommand(cleanupOptions),
            (elevatedDeadlineUnixMs) => legacyHostFabricCompatibility(runtime).cleanupCommand({
                ...cleanupOptions,
                executable: runtime.resolveElevationExecutable(powershell),
                elevated: true,
                elevatedDeadlineUnixMs,
            }),
            deadlineAt,
        );
        if (!commandSucceeded(execution)) {
            const diagnosticCode = hyperVProviderDiagnosticCode(execution, "hyper-v-network-cleanup-failed");
            return {
                ...release,
                ok: false,
                error: diagnosticCode,
                networkCleanup: redactProviderCommandInput(execution, true, diagnosticCode),
            };
        }
        observation = parseHyperVNetworkCleanupObservation(execution.stdout || "");
        if (!observation) {
            return {
                ...release,
                ok: false,
                error: "hyper-v-network-cleanup-invalid-result",
                networkCleanup: redactProviderCommandInput(execution, true, "hyper-v-network-cleanup-invalid-result"),
            };
        }
    }
    if (observation.deferred === true) {
        const committed = commitDeferredHyperVNetworkRelease(
            runtime,
            ownerId,
            deviceId,
            incarnationId,
            cleanupStateRevision,
            observation,
        );
        if (!committed.ok) {
            return { ...release, ok: false, error: committed.error, networkCleanup: null };
        }
        return { ...release, ok: true, remaining: committed.remaining, networkCleanup: observation };
    }
    rmSync(stateFile(runtime), { force: true });
    return { ...release, ok: true, networkCleanup: observation };
}

export function validateHyperVLinuxSshHostIdentity(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    expectedFingerprint: string,
): boolean {
    const allocation = readState(runtime)?.allocations.find(
        (candidate) => candidate.ownerId === ownerId && candidate.deviceId === deviceId,
    );
    if (!allocation || allocation.address !== networkAddress) return false;
    const publicKey = readDeviceLabTextFile(hostPublicKeyPath, "hyper-v-linux-ssh-host-public-key", 64 * 1024)?.trim() || "";
    const knownHostIdentity = readHyperVLinuxSshKnownHostIdentity(knownHostsPath, networkAddress);
    const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{1,256})?$/.exec(publicKey);
    if (!match || !knownHostIdentity) return false;
    const publicKeyBlob = parseEd25519SshPublicKeyBlob(match[1]);
    if (!publicKeyBlob || knownHostIdentity.encodedKey !== match[1]) return false;
    let actualFingerprint = "";
    try {
        actualFingerprint = `SHA256:${createHash("sha256").update(publicKeyBlob).digest("base64").replace(/=+$/, "")}`;
    } catch {
        return false;
    }
    return actualFingerprint === expectedFingerprint;
}

function parseEd25519SshPublicKeyBlob(encoded: string): Buffer | null {
    let blob: Buffer;
    try {
        blob = Buffer.from(encoded, "base64");
    } catch {
        return null;
    }
    if (blob.length !== 51 || blob.toString("base64") !== encoded) return null;
    const algorithmLength = blob.readUInt32BE(0);
    if (algorithmLength !== 11 || blob.subarray(4, 15).toString("ascii") !== "ssh-ed25519") return null;
    const keyLength = blob.readUInt32BE(15);
    return keyLength === 32 && blob.length === 19 + keyLength ? blob : null;
}

function readHyperVLinuxSshKnownHostIdentity(
    knownHostsPath: string,
    networkAddress: string,
): { encodedKey: string; publicKey: string; fingerprint: string } | null {
    const knownHosts = readDeviceLabTextFile(
        knownHostsPath,
        "hyper-v-linux-ssh-known-hosts",
        64 * 1024,
    );
    if (knownHosts === null) return null;
    const lines = knownHosts.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 1) return null;
    const match = /^(\S+) ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{1,256})?$/.exec(lines[0]);
    if (!match || match[1] !== networkAddress) return null;
    const blob = parseEd25519SshPublicKeyBlob(match[2]);
    if (!blob) return null;
    return {
        encodedKey: match[2],
        publicKey: `ssh-ed25519 ${match[2]} ccc-hyper-v-guest`,
        fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
    };
}

export function reconcileHyperVLinuxSshHostIdentity(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    commitFingerprint: (fingerprint: string) => boolean,
): { fingerprint: string } | null {
    const allocation = readState(runtime)?.allocations.find(
        (candidate) => candidate.ownerId === ownerId && candidate.deviceId === deviceId,
    );
    if (!allocation || allocation.address !== networkAddress) return null;
    runtime.assertSafePath(hostPublicKeyPath, "hyper-v-linux-ssh-host-public-key");
    runtime.assertSafePath(knownHostsPath, "hyper-v-linux-ssh-known-hosts");
    const identity = readHyperVLinuxSshKnownHostIdentity(knownHostsPath, networkAddress);
    if (!identity) return null;
    try {
        writeFileAtomically(hostPublicKeyPath, `${identity.publicKey}\n`);
        if (!commitFingerprint(identity.fingerprint)) return null;
    } catch {
        return null;
    }
    return { fingerprint: identity.fingerprint };
}

export function adoptHyperVLinuxSshHostIdentity(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    observedKnownHostsPath: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    commitFingerprint?: (fingerprint: string) => boolean,
): { fingerprint: string } | null {
    const allocation = readState(runtime)?.allocations.find(
        (candidate) => candidate.ownerId === ownerId && candidate.deviceId === deviceId,
    );
    if (!allocation || allocation.address !== networkAddress) return null;
    runtime.assertSafePath(observedKnownHostsPath, "hyper-v-linux-ssh-observed-known-hosts");
    runtime.assertSafePath(hostPublicKeyPath, "hyper-v-linux-ssh-host-public-key");
    runtime.assertSafePath(knownHostsPath, "hyper-v-linux-ssh-known-hosts");
    const observed = readDeviceLabTextFile(
        observedKnownHostsPath,
        "hyper-v-linux-ssh-observed-known-hosts",
        64 * 1024,
    );
    if (observed === null) return null;
    const lines = observed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 1) return null;
    const match = /^(\S+) ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{1,256})?$/.exec(lines[0]);
    if (!match || match[1] !== networkAddress) return null;
    const blob = parseEd25519SshPublicKeyBlob(match[2]);
    if (!blob) return null;
    const publicKey = `ssh-ed25519 ${match[2]} ccc-hyper-v-guest`;
    const fingerprint = `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
    try {
        writeFileAtomically(knownHostsPath, `${networkAddress} ${publicKey}\n`);
    } catch {
        const recovered = commitFingerprint && reconcileHyperVLinuxSshHostIdentity(
            runtime, ownerId, deviceId, hostPublicKeyPath, knownHostsPath, networkAddress, commitFingerprint,
        );
        return recovered || null;
    }
    if (!commitFingerprint) {
        writeFileAtomically(hostPublicKeyPath, `${publicKey}\n`);
        return { fingerprint };
    }
    return reconcileHyperVLinuxSshHostIdentity(
        runtime, ownerId, deviceId, hostPublicKeyPath, knownHostsPath, networkAddress, commitFingerprint,
    );
}
