import { networkAddressCandidates } from "../../domain/hyper-v-network-trust.js";
export { hyperVNetworkAllocationReferenced } from "../../domain/hyper-v-network-trust.js";
import { createHyperVNetworkTrust } from "../../application/hyper-v-network-trust.js";
import type { HyperVNetworkStatePorts, HyperVNetworkPorts } from "../../ports/hyper-v-network-trust.js";
import { createDeviceLabHyperVHostNetworkPorts } from "./network-adapter.js";
export type { HyperVNetworkRelease, HyperVNetworkReleaseOptions, HyperVNetworkFabricResult } from "../../domain/hyper-v-network-trust.js";
import type { HyperVNetworkReleaseOptions } from "../../domain/hyper-v-network-trust.js";
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
    parseHyperVNetworkCleanupObservation,
    parseHyperVNetworkAllocationsObservation,
    parseHyperVNetworkObservation,
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
    type HyperVWindowsNetworkClient,
} from "@ccc/hyper-v/index.js";
import { HyperVOperationDeadlineError } from "./deadline.js";
import {
    hyperVBoundedErrorCode,
    hyperVProviderDiagnosticCode,
    hyperVTypedErrorCode,
    redactProviderCommandInput,
} from "./public-response.js";
import {
    createFreshHyperVNetworkIntent,
    decodeHyperVNetworkIntent,
    decodeHyperVNetworkState,
    hyperVDeterministicMacAddress,
    type HyperVNetworkAllocation,
    type HyperVNetworkIntent,
    type HyperVNetworkState,
} from "./network-state.js";
import { type WithAdministratorHyperVWindowsNetworkClient } from "./network-adapter.js";
export { hyperVDeterministicMacAddress } from "./network-state.js";
export type { HyperVNetworkAllocation } from "./network-state.js";
const HYPER_V_NETWORK_STATE_LIMIT_BYTES = 256 * 1024;
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
type HyperVNetworkHostFabric = {
    readonly kind: "typed";
    readonly client: HyperVWindowsNetworkClient;
    readonly withAdministratorClient: WithAdministratorHyperVWindowsNetworkClient;
} | {
    readonly kind: "legacy-compatibility";
    readonly ensureCommand: (options: HyperVNetworkOptions) => HyperVProviderCommand;
    readonly cleanupCommand: (options: HyperVNetworkCleanupOptions) => HyperVProviderCommand;
    readonly inspectAllocationsCommand: (options: HyperVNetworkAllocationsOptions) => HyperVProviderCommand;
} | {
    readonly kind: "unavailable";
};
export type HyperVNetworkRuntime = HyperVNetworkStateRuntime & {
    resolveExecutable(name: string): string | null;
    resolveElevationExecutable(standardExecutable: string): string;
    run(command: HyperVProviderCommand, options: {
        timeoutMs: number;
        outputLimit: number;
    }): Promise<HyperVNetworkCommandResult>;
    commandOutputBytes: number;
    allocationReferenced?(allocation: HyperVNetworkAllocation): boolean;
    hostFabric: HyperVNetworkHostFabric;
};
export type HyperVOwnerDevicesReader = (ownerId: string, backend: "windows-vm" | "linux-vm") => unknown[];
export function cachedHyperVOwnerDevicesReader(readDevices: HyperVOwnerDevicesReader): HyperVOwnerDevicesReader {
    const cache = new Map<string, unknown[]>();
    return (ownerId, backend) => {
        const key = `${ownerId}:${backend}`;
        const cached = cache.get(key);
        if (cached)
            return cached;
        const devices = readDevices(ownerId, backend);
        cache.set(key, devices);
        return devices;
    };
}
function hyperVNetworkStateRevision(state: HyperVNetworkState): string {
    return createHash("sha256").update(JSON.stringify(state)).digest("hex");
}
export function hyperVDeterministicNetworkAddresses(ownerId: string, deviceId: string): string[] {
    const digest = createHash("sha256").update(`${ownerId}\0${deviceId}\0address`).digest();
    return networkAddressCandidates(HYPER_V_NETWORK_GATEWAY, { first: digest.readUInt32BE(0), second: digest.readUInt32BE(4) });
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
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("hyper-v-network-state-root-invalid");
}
function readState(runtime: HyperVNetworkStateRuntime): HyperVNetworkState | null {
    return readDeviceLabStateFile(stateFile(runtime), decodeHyperVNetworkState, "hyper-v-network-state", HYPER_V_NETWORK_STATE_LIMIT_BYTES);
}
function readIntent(runtime: HyperVNetworkStateRuntime): HyperVNetworkIntent | null {
    return readDeviceLabStateFile(intentFile(runtime), decodeHyperVNetworkIntent, "hyper-v-network-intent", HYPER_V_NETWORK_STATE_LIMIT_BYTES);
}
function parseEd25519SshPublicKeyBlob(encoded: string): Buffer | null {
    let blob: Buffer;
    try {
        blob = Buffer.from(encoded, "base64");
    }
    catch {
        return null;
    }
    if (blob.length !== 51 || blob.toString("base64") !== encoded)
        return null;
    const algorithmLength = blob.readUInt32BE(0);
    if (algorithmLength !== 11 || blob.subarray(4, 15).toString("ascii") !== "ssh-ed25519")
        return null;
    const keyLength = blob.readUInt32BE(15);
    return keyLength === 32 && blob.length === 19 + keyLength ? blob : null;
}
function statePorts(runtime: HyperVNetworkStateRuntime): HyperVNetworkStatePorts {
    return {
        kind: "state",
        readState: () => readState(runtime),
        readIntent: () => readIntent(runtime),
        writeState: state => { writeJsonFileAtomically(stateFile(runtime), state); },
        writeIntent: intent => { writeJsonFileAtomically(intentFile(runtime), intent); },
        removeState: () => { rmSync(stateFile(runtime), { force: true }); },
        removeIntent: () => { rmSync(intentFile(runtime), { recursive: true, force: true }); },
        ensureStateRoot: () => { ensureStateRoot(runtime); },
        assertStateRoot: label => { runtime.assertSafePath(dirname(stateFile(runtime)), label); },
        revision: hyperVNetworkStateRevision,
        boundedError: hyperVBoundedErrorCode,
        assertTrustPath: (path, label) => { runtime.assertSafePath(path, label); },
        readTrustText: (path, label) => readDeviceLabTextFile(path, label, 64 * 1024),
        writeTrustText: (path, text) => { writeFileAtomically(path, text); },
        ed25519Identity: encodedKey => {
            const blob = parseEd25519SshPublicKeyBlob(encodedKey);
            if (!blob)
                return null;
            return {
                encodedKey,
                publicKey: `ssh-ed25519 ${encodedKey} ccc-hyper-v-guest`,
                fingerprint: `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`,
            };
        },
    };
}
function networkPorts(runtime: HyperVNetworkRuntime): HyperVNetworkPorts {
    const hostFabric = runtime.hostFabric;
    const allocationReferenced = runtime.allocationReferenced;
    return {
        ...statePorts(runtime),
        kind: "network",
        gateway: HYPER_V_NETWORK_GATEWAY,
        prefix: HYPER_V_NETWORK_PREFIX,
        prefixLength: HYPER_V_NETWORK_PREFIX_LENGTH,
        marker: HYPER_V_NETWORK_MARKER,
        natName: HYPER_V_NETWORK_NAT,
        commandOutputBytes: runtime.commandOutputBytes,
        hostFabric: hostFabric.kind === "typed"
            ? { kind: "typed", host: createDeviceLabHyperVHostNetworkPorts(hostFabric.client, hostFabric.withAdministratorClient, Date.now, milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds))) }
            : hostFabric,
        references: allocationReferenced
            ? { kind: "available", isReferenced: allocation => allocationReferenced.call(runtime, allocation) }
            : { kind: "unavailable" },
        resolveExecutable: name => runtime.resolveExecutable(name),
        resolveElevationExecutable: executable => runtime.resolveElevationExecutable(executable),
        run: (command, options) => runtime.run(command, options),
        now: Date.now,
        timestamp: () => new Date().toISOString(),
        token: () => randomBytes(12).toString("hex"),
        throwDeadline: () => { throw new HyperVOperationDeadlineError(); },
        decodeState: decodeHyperVNetworkState,
        decodeIntent: decodeHyperVNetworkIntent,
        freshIntent: createFreshHyperVNetworkIntent,
        addressDigest: (ownerId, deviceId) => {
            const digest = createHash("sha256").update(`${ownerId}\0${deviceId}\0address`).digest();
            return { first: digest.readUInt32BE(0), second: digest.readUInt32BE(4) };
        },
        macAddress: hyperVDeterministicMacAddress,
        vmName: (ownerId, deviceId, incarnationId) => parseHyperVVirtualMachineName(hyperVVmName(ownerId, deviceId, incarnationId)),
        hostSpec: (switchName, natName, cidr, gateway) => createHyperVHostNetworkSpec({ switchName: parseHyperVVirtualSwitchName(switchName), natName: parseHyperVNatName(natName), cidr, gateway }),
        switchId: parseHyperVVirtualSwitchId,
        switchName: parseHyperVVirtualSwitchName,
        natNameValue: parseHyperVNatName,
        natInstanceId: parseHyperVNatInstanceId,
        isNativeError: value => value instanceof HyperVWindowsError,
        parseAllocationObservation: parseHyperVNetworkAllocationsObservation,
        parseNetworkObservation: parseHyperVNetworkObservation,
        parseCleanupObservation: parseHyperVNetworkCleanupObservation,
        typedError: hyperVTypedErrorCode,
        providerDiagnostic: hyperVProviderDiagnosticCode,
        redactExecution: (result, diagnostic) => redactProviderCommandInput(result, true, diagnostic),
    };
}
export function ensureHyperVHostNetworkFabric(runtime: HyperVNetworkRuntime, deadlineAt = Number.POSITIVE_INFINITY) {
    return createHyperVNetworkTrust(networkPorts(runtime)).ensureFabric(deadlineAt);
}
export function ensureHyperVNetworkAllocation(
    runtime: HyperVNetworkRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId: string,
    deadlineAt = Number.POSITIVE_INFINITY,
) {
    return createHyperVNetworkTrust(networkPorts(runtime)).allocate(ownerId, deviceId, incarnationId, deadlineAt);
}
export function releaseHyperVNetworkAllocation(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId?: string | null,
    options: HyperVNetworkReleaseOptions = {},
) {
    return createHyperVNetworkTrust(statePorts(runtime)).release(ownerId, deviceId, incarnationId, options);
}
export function releaseHyperVNetworkAllocationAndCleanup(
    runtime: HyperVNetworkRuntime,
    ownerId: string,
    deviceId: string,
    incarnationId: string | null | undefined,
    deadlineAt = Number.POSITIVE_INFINITY,
    options: HyperVNetworkReleaseOptions = {},
) {
    return createHyperVNetworkTrust(networkPorts(runtime)).releaseAndCleanup(ownerId, deviceId, incarnationId, deadlineAt, options);
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
    return createHyperVNetworkTrust(statePorts(runtime)).validateGuestTrust(ownerId, deviceId, hostPublicKeyPath, knownHostsPath, networkAddress, expectedFingerprint);
}
export function reconcileHyperVLinuxSshHostIdentity(
    runtime: HyperVNetworkStateRuntime,
    ownerId: string,
    deviceId: string,
    hostPublicKeyPath: string,
    knownHostsPath: string,
    networkAddress: string,
    commitFingerprint: (fingerprint: string) => boolean,
) {
    return createHyperVNetworkTrust(statePorts(runtime)).reconcileGuestTrust(ownerId, deviceId, hostPublicKeyPath, knownHostsPath, networkAddress, commitFingerprint);
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
) {
    return createHyperVNetworkTrust(statePorts(runtime)).adoptGuestTrust(ownerId, deviceId, observedKnownHostsPath, hostPublicKeyPath, knownHostsPath, networkAddress, commitFingerprint);
}
