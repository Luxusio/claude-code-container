import type {
    HyperVHostNetworkObservation,
    HyperVHostNetworkSpec,
    HyperVHostNetworkExecutionResult,
    HyperVHostNetworkReconciliationOutcome,
    HyperVHostNetworkEnsureProvenance,
    HyperVHostNetworkCleanupProvenance,
    HyperVExactNameVirtualMachine,
    HyperVVirtualSwitchId,
    HyperVVirtualSwitchName,
    HyperVNatName,
    HyperVNatInstanceId,
    HyperVVirtualMachineName,
} from "@ccc/hyper-v/index.js";
import type { HyperVNetworkState, HyperVNetworkIntent, HyperVGuestTrustIdentity } from "../domain/hyper-v-network-trust.js";
export type HyperVTrustFileLabel = "hyper-v-linux-ssh-host-public-key" | "hyper-v-linux-ssh-known-hosts" | "hyper-v-linux-ssh-observed-known-hosts";
export type HyperVNetworkStatePorts = {
    readonly kind: "state";
    readState(): HyperVNetworkState | null;
    readIntent(): HyperVNetworkIntent | null;
    writeState(state: HyperVNetworkState): undefined;
    writeIntent(intent: HyperVNetworkIntent): undefined;
    removeState(): undefined;
    removeIntent(): undefined;
    ensureStateRoot(): undefined;
    assertStateRoot(label: string): undefined;
    revision(state: HyperVNetworkState): string;
    boundedError(error: unknown, fallback: string): string;
    assertTrustPath(path: string, label: HyperVTrustFileLabel): undefined;
    readTrustText(path: string, label: HyperVTrustFileLabel): string | null;
    writeTrustText(path: string, text: string): undefined;
    ed25519Identity(encodedKey: string): HyperVGuestTrustIdentity | null;
};
export type HyperVHostNetworkEffects = {
    observe(network: HyperVHostNetworkSpec): Promise<Omit<HyperVHostNetworkObservation, "privilege" | "provenance">>;
    execute(action: Extract<HyperVHostNetworkReconciliationOutcome, {
        readonly kind: "execute";
    }>): Promise<HyperVHostNetworkExecutionResult>;
    exactVirtualMachines(names: readonly HyperVExactNameVirtualMachine["name"][]): Promise<readonly HyperVExactNameVirtualMachine[]>;
};
export type HyperVHostNetworkPorts = {
    readonly kind: "host";
    readonly standard: HyperVHostNetworkEffects;
    withAdministrator<Result>(operation: (effects: HyperVHostNetworkEffects) => Result | Promise<Result>, purpose: "ensure" | "cleanup"): Promise<Result>;
    now(): number;
    pause(milliseconds: number): Promise<void>;
    mutationNeverStarted(cause: unknown): boolean;
};
export type HyperVHostEnsureRequest = {
    readonly network: HyperVHostNetworkSpec;
    readonly provenance: HyperVHostNetworkEnsureProvenance;
    readonly deadlineAt: number;
    confirmed(action: Extract<HyperVHostNetworkExecutionResult, {
        readonly kind: "mutation-completed";
        readonly operation: "ensure";
    }>, observation: HyperVHostNetworkObservation): undefined | Promise<undefined>;
};
export type HyperVHostCleanupRequest = {
    readonly network: HyperVHostNetworkSpec;
    readonly provenance: HyperVHostNetworkCleanupProvenance;
    confirmed(action: Extract<HyperVHostNetworkExecutionResult, {
        readonly kind: "mutation-completed";
        readonly operation: "cleanup";
    }>, observation: Omit<HyperVHostNetworkObservation, "provenance">): undefined | Promise<undefined>;
};
import type {
    HyperVNetworkAllocation,
    HyperVNetworkEnsureRequest,
    HyperVNetworkCleanupRequest,
    HyperVNetworkNativeAttempt,
    HyperVNetworkNativeObservation,
    HyperVNetworkAllocationIdentity,
    HyperVNetworkAllocationsObservation,
    HyperVNetworkObservation,
    HyperVNetworkCleanupObservation,
} from "../domain/hyper-v-network-trust.js";
export type HyperVFabricEffects = {
    readonly kind: "typed";
    readonly host: HyperVHostNetworkPorts;
} | {
    readonly kind: "legacy-compatibility";
    ensure(options: HyperVNetworkEnsureRequest, attempt: HyperVNetworkNativeAttempt): Promise<HyperVNetworkNativeObservation<HyperVNetworkObservation>>;
    cleanup(options: HyperVNetworkCleanupRequest, attempt: HyperVNetworkNativeAttempt): Promise<HyperVNetworkNativeObservation<HyperVNetworkCleanupObservation>>;
    inspectAllocation(allocations: HyperVNetworkAllocationIdentity[], timeoutMs: number): Promise<HyperVNetworkNativeObservation<HyperVNetworkAllocationsObservation>>;
} | {
    readonly kind: "unavailable";
};
export type HyperVNetworkPorts = Omit<HyperVNetworkStatePorts, "kind"> & {
    readonly kind: "network";
    readonly gateway: string;
    readonly prefix: string;
    readonly prefixLength: number;
    readonly marker: string;
    readonly natName: string;
    readonly hostFabric: HyperVFabricEffects;
    readonly references: {
        readonly kind: "unavailable";
    } | {
        readonly kind: "available";
        isReferenced(allocation: HyperVNetworkAllocation): boolean;
    };
    available(): boolean;
    elevationFailure(previousReceipt: unknown, cause: unknown, operation: "ensure" | "cleanup"): Extract<HyperVNetworkNativeObservation<never>, {kind: "failed"}>;
    now(): number;
    timestamp(): string;
    token(): string;
    throwDeadline(): never;
    decodeState(value: unknown): HyperVNetworkState;
    decodeIntent(value: unknown): HyperVNetworkIntent;
    freshIntent(token: string, timestamp: string): HyperVNetworkIntent;
    addressDigest(ownerId: string, deviceId: string): {
        first: number;
        second: number;
    };
    macAddress(ownerId: string, deviceId: string, salt: number): string;
    vmName(ownerId: string, deviceId: string, incarnationId: string): HyperVVirtualMachineName;
    hostSpec(switchName: string, natName: string, prefix: string, gateway: string): HyperVHostNetworkSpec;
    switchId(value: string): HyperVVirtualSwitchId;
    switchName(value: string): HyperVVirtualSwitchName;
    natNameValue(value: string): HyperVNatName;
    natInstanceId(value: string): HyperVNatInstanceId;
    isNativeError(value: unknown): boolean;
    typedError(error: unknown, fallback: string): string;
    typedDiagnosticReceipt(error: unknown, diagnostic: string): unknown;
    diagnosticReceipt(receipt: unknown, diagnostic: string | undefined): unknown;
};
