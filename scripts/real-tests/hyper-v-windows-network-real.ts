import { randomBytes } from "crypto";
import type {
    HyperVHostNetworkCleanupObservation,
    HyperVHostNetworkCleanupProvenance,
    HyperVHostNetworkEnsureProvenance,
    HyperVHostNetworkObservation,
    HyperVHostNetworkSettledIdentity,
    HyperVHostNetworkSpec,
    HyperVInterfaceIndex,
    HyperVNatIdentity,
    HyperVVirtualSwitchIdentity,
    HyperVWindowsNetworkClient,
} from "../../src/hyper-v-windows/index.js";

const MAX_RECONCILIATION_STEPS = 12;
const TOKEN_PATTERN = /^[0-9a-f]{16}$/;

export type HyperVWindowsNetworkLibraryModule = typeof import("../../src/hyper-v-windows/index.js");

export type HyperVWindowsNetworkAdministratorScope = <T>(
    attempt: "cold" | "warm",
    operation: (client: HyperVWindowsNetworkClient, sessionId: string) => Promise<T>,
) => Promise<T>;

export type HyperVWindowsNetworkRealDependencies = {
    readonly library: HyperVWindowsNetworkLibraryModule;
    readonly ordinaryClient: HyperVWindowsNetworkClient;
    readonly withAdministratorClient: HyperVWindowsNetworkAdministratorScope;
    readonly randomToken?: () => string;
    readonly now?: () => number;
    readonly signal?: AbortSignal;
    readonly legacyNativeInvocationCount?: number;
    readonly log?: (message: string) => void;
};

type NativeCounts = Record<"cold" | "warm", { ordinary: number; elevated: number; mutations: number }>;

export type HyperVWindowsNetworkRealResult = {
    readonly token: string;
    readonly switchName: string;
    readonly natName: string;
    readonly administratorScopeCount: 2;
    readonly sessionReused: true;
    readonly attempts: readonly [
        { readonly kind: "cold"; readonly wallTimeMilliseconds: number; readonly switchId: string; readonly natInstanceId: string },
        { readonly kind: "warm"; readonly wallTimeMilliseconds: number; readonly switchId: string; readonly natInstanceId: string },
    ];
    readonly typedNativeInvocationCounts: NativeCounts;
    readonly legacyNativeInvocationCount: number | null;
    readonly legacyComparison: "measured" | "not-run-standalone-safety";
};

function assert(condition: unknown, code: string): asserts condition {
    if (!condition) throw new Error(code);
}

const BOUNDED_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

// The library's own error is `category:operation:code`, every part a bounded token; anything else
// is reported only as not being one. A real run yields exactly one failure line, so an
// unconfirmed mutation must name the primitive that failed and why, not just that one did.
function boundedCause(cause: unknown): string {
    if (!(cause instanceof Error) || cause.name !== "HyperVWindowsError") return "non-library-error";
    const parts = ["category", "operation", "code"].map((key) => Reflect.get(cause, key));
    if (!parts.every((part) => typeof part === "string" && BOUNDED_CODE_PATTERN.test(part))) {
        return "non-library-error";
    }
    return parts.join(":");
}

const MUTATION_UNCONFIRMED_PREFIX = "hyper-v-network-real-ensure-mutation-unconfirmed";

function mutationUnconfirmed(
    operation: "ensure" | "cleanup",
    execution: { readonly kind: string; readonly actionKind?: string; readonly cause?: unknown },
): never {
    const actionKind = typeof execution.actionKind === "string" && BOUNDED_CODE_PATTERN.test(execution.actionKind)
        ? execution.actionKind
        : String(execution.kind);
    throw new Error(`hyper-v-network-real-${operation}-mutation-unconfirmed:${actionKind}:${boundedCause(execution.cause)}`);
}

function aborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new Error("hyper-v-network-real-scenario-cancelled");
}

function stableItems(items: readonly unknown[]): readonly string[] {
    return items.map((item) => JSON.stringify(item)).sort();
}

function foreignFingerprint(
    observation: HyperVHostNetworkObservation | HyperVHostNetworkCleanupObservation,
    target: {
    readonly switchName: string;
    readonly natName: string;
    readonly switchId?: string;
    readonly interfaceIndex?: number;
    },
): string {
    const switches = observation.virtualSwitches
        .filter((item) => item.name !== target.switchName && item.id !== target.switchId)
        .map((item) => ({ id: item.id, name: item.name, switchType: item.switchType, notes: item.notes }));
    const nats = observation.nats
        .filter((item) => item.name !== target.natName)
        .map((item) => ({ instanceId: item.instanceId, name: item.name, prefix: item.internalAddressPrefix }));
    const addresses = observation.ipv4Addresses
        .filter((item) => item.interfaceIndex !== target.interfaceIndex)
        .map((item) => ({
            interfaceIndex: item.interfaceIndex,
            address: item.address,
            prefixLength: item.prefixLength,
        }));
    const adapters = observation.vmNetworkAdapters
        .filter((item) => item.switchId !== target.switchId && item.switchName !== target.switchName)
        .map((item) => ({
            vmId: item.vmId,
            vmName: item.vmName,
            name: item.name,
            switchId: item.switchId,
            switchName: item.switchName,
            managementOperatingSystem: item.managementOperatingSystem,
        }));
    return JSON.stringify({
        switches: stableItems(switches),
        nats: stableItems(nats),
        addresses: stableItems(addresses),
        adapters: stableItems(adapters),
    });
}

function countedClient(
    client: HyperVWindowsNetworkClient,
    count: (mutation: boolean) => void,
): HyperVWindowsNetworkClient {
    const read = <A extends readonly unknown[], R>(operation: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => { count(false); return operation.apply(client, args); };
    const mutate = <A extends readonly unknown[], R>(operation: (...args: A) => Promise<R>) =>
        async (...args: A): Promise<R> => { count(true); return operation.apply(client, args); };
    return {
        getVMSwitches: read(client.getVMSwitches),
        createVMSwitch: mutate(client.createVMSwitch),
        setVMSwitchNotes: mutate(client.setVMSwitchNotes),
        removeVMSwitch: mutate(client.removeVMSwitch),
        getAllVMNetworkAdapters: read(client.getAllVMNetworkAdapters),
        getVMNetworkAdapters: read(client.getVMNetworkAdapters),
        getManagementNetworkAdapters: read(client.getManagementNetworkAdapters),
        removeVMNetworkAdapter: mutate(client.removeVMNetworkAdapter),
        getNetNeighbors: read(client.getNetNeighbors),
        getVMsByExactNames: read(client.getVMsByExactNames),
        getHostNetworkAdapters: read(client.getHostNetworkAdapters),
        getNetIPAddresses: read(client.getNetIPAddresses),
        createNetIPAddress: mutate(client.createNetIPAddress),
        removeNetIPAddress: mutate(client.removeNetIPAddress),
        getNetNats: read(client.getNetNats),
        createNetNat: mutate(client.createNetNat),
        removeNetNat: mutate(client.removeNetNat),
    };
}

async function inspect(
    library: HyperVWindowsNetworkLibraryModule,
    client: HyperVWindowsNetworkClient,
    privilege: "standard" | "administrator",
    provenance: HyperVHostNetworkEnsureProvenance,
    network: HyperVHostNetworkSpec,
    signal?: AbortSignal,
): Promise<HyperVHostNetworkObservation> {
    aborted(signal);
    const options = signal ? { signal } : undefined;
    const [virtualSwitches, hostAdapters, ipv4Addresses, nats, vmNetworkAdapters] = await Promise.all([
        client.getVMSwitches({ kind: "all" }, options),
        client.getHostNetworkAdapters({
            name: library.parseHyperVNetworkAdapterName(`vEthernet (${String(network.switchName)})`),
        }, options),
        client.getNetIPAddresses({ kind: "all-ipv4" }, options),
        client.getNetNats({ kind: "all" }, options),
        client.getAllVMNetworkAdapters(options),
    ]);
    return { privilege, provenance, virtualSwitches, hostAdapters, ipv4Addresses, nats, vmNetworkAdapters };
}

type PartialNetworkIdentity = {
    switchIdentity?: HyperVVirtualSwitchIdentity;
    interfaceIndex?: HyperVInterfaceIndex;
    natIdentity?: HyperVNatIdentity;
};

function exactEnsureProvenance(
    notes: string,
    receipts: Readonly<PartialNetworkIdentity>,
): HyperVHostNetworkEnsureProvenance {
    if (!receipts.switchIdentity) return { kind: "fresh", expectedSwitchNotes: notes };
    return {
        kind: "recognized-adoption",
        expectedSwitchNotes: notes,
        switchIdentity: receipts.switchIdentity,
        nat: receipts.natIdentity
            ? { kind: "exact", identity: receipts.natIdentity }
            : { kind: "unrecorded" },
    };
}

async function ensureNetwork(
    library: HyperVWindowsNetworkLibraryModule,
    client: HyperVWindowsNetworkClient,
    network: HyperVHostNetworkSpec,
    notes: string,
    receipts: PartialNetworkIdentity,
    signal?: AbortSignal,
): Promise<HyperVHostNetworkSettledIdentity> {
    for (let step = 0; step < MAX_RECONCILIATION_STEPS; step += 1) {
        const provenance = exactEnsureProvenance(notes, receipts);
        const observation = await inspect(library, client, "administrator", provenance, network, signal);
        const outcome = library.reconcileHyperVHostNetwork(observation, network);
        if (outcome.kind === "settled") {
            assert(outcome.operation === "ensure", "hyper-v-network-real-ensure-operation-mismatch");
            assert(receipts.switchIdentity?.id === outcome.identity.switchIdentity.id
                && receipts.interfaceIndex === outcome.identity.interfaceIndex
                && receipts.natIdentity?.instanceId === outcome.identity.natIdentity.instanceId,
            "hyper-v-network-real-ownership-receipt-missing");
            return outcome.identity;
        }
        if (outcome.kind === "indeterminate"
            && (outcome.reason === "host-adapter-missing" || outcome.reason === "gateway-transitioning")) {
            await new Promise<void>((resolve) => setTimeout(resolve, 250));
            continue;
        }
        assert(outcome.kind === "execute", `hyper-v-network-real-ensure-${String(outcome.kind)}`);
        if (outcome.action.kind === "create-nat" && receipts.interfaceIndex === undefined) {
            throw new Error("hyper-v-network-real-gateway-ownership-unproven");
        }
        const execution = await library.executeHyperVHostNetworkAction(client, outcome, signal ? { signal } : undefined);
        if (execution.kind !== "mutation-completed") mutationUnconfirmed("ensure", execution);
        if (execution.actionKind === "create-switch" || execution.actionKind === "repair-switch-notes") {
            if (receipts.switchIdentity) assert(receipts.switchIdentity.id === execution.switchIdentity.id, "hyper-v-network-real-switch-successor");
            receipts.switchIdentity = execution.switchIdentity;
        } else if (execution.actionKind === "create-gateway") {
            receipts.interfaceIndex = execution.gatewayIdentity.interfaceIndex;
        } else if (execution.actionKind === "create-nat") {
            receipts.natIdentity = execution.natIdentity;
        }
    }
    throw new Error("hyper-v-network-real-ensure-step-limit");
}

async function recoverTokenScopedReceipts(
    library: HyperVWindowsNetworkLibraryModule,
    client: HyperVWindowsNetworkClient,
    network: HyperVHostNetworkSpec,
    notes: string,
    switchName: string,
    natName: string,
    receipts: PartialNetworkIdentity,
    signal?: AbortSignal,
): Promise<void> {
    const observation = await inspect(library, client, "administrator", { kind: "fresh", expectedSwitchNotes: notes }, network, signal);
    if (!receipts.switchIdentity) {
        const switches = observation.virtualSwitches.filter((item) => item.name === switchName);
        if (switches.length === 1 && switches[0]!.notes === notes) {
            receipts.switchIdentity = { id: switches[0]!.id, name: switches[0]!.name };
        }
    }
    if (receipts.switchIdentity && receipts.interfaceIndex === undefined && observation.hostAdapters.length === 1) {
        const adapter = observation.hostAdapters[0]!;
        const owned = observation.ipv4Addresses.some((item) => item.interfaceIndex === adapter.interfaceIndex
            && item.address === network.gateway);
        if (owned) receipts.interfaceIndex = adapter.interfaceIndex;
    }
    if (receipts.switchIdentity && !receipts.natIdentity) {
        const nats = observation.nats.filter((item) => item.name === natName);
        if (nats.length === 1) receipts.natIdentity = { instanceId: nats[0]!.instanceId, name: nats[0]!.name };
    }
}

async function cleanupNetwork(
    library: HyperVWindowsNetworkLibraryModule,
    client: HyperVWindowsNetworkClient,
    network: HyperVHostNetworkSpec,
    identity: Readonly<PartialNetworkIdentity> & { readonly switchIdentity: HyperVVirtualSwitchIdentity },
    signal?: AbortSignal,
): Promise<void> {
    const provenance: HyperVHostNetworkCleanupProvenance = {
        switch: { kind: "managed", identity: identity.switchIdentity },
        gateway: identity.interfaceIndex === undefined
            ? { kind: "unmanaged" }
            : {
                kind: "managed",
                identity: {
                    switchIdentity: identity.switchIdentity,
                    address: network.gateway,
                    prefixLength: network.prefixLength,
                },
            },
        nat: identity.natIdentity === undefined
            ? { kind: "unmanaged" }
            : { kind: "managed", identity: identity.natIdentity },
    };
    const expected = new Set(["remove-switch"]);
    if (identity.interfaceIndex !== undefined) expected.add("remove-gateway");
    if (identity.natIdentity !== undefined) expected.add("remove-nat");
    const removed = new Set<string>();
    for (let step = 0; step < MAX_RECONCILIATION_STEPS; step += 1) {
        const ensureObservation = await inspect(library, client, "administrator", { kind: "fresh", expectedSwitchNotes: "unused" }, network, signal);
        const observation: HyperVHostNetworkCleanupObservation = {
            privilege: "administrator",
            virtualSwitches: ensureObservation.virtualSwitches,
            hostAdapters: ensureObservation.hostAdapters,
            ipv4Addresses: ensureObservation.ipv4Addresses,
            nats: ensureObservation.nats,
            vmNetworkAdapters: ensureObservation.vmNetworkAdapters,
        };
        const outcome = library.planHyperVHostNetworkCleanup(observation, network, provenance);
        if (outcome.kind === "settled") {
            assert(outcome.operation === "cleanup", "hyper-v-network-real-cleanup-operation-mismatch");
            assert(outcome.disposition === "complete", "hyper-v-network-real-cleanup-deferred");
            assert([...expected].every((action) => removed.has(action)),
                "hyper-v-network-real-cleanup-receipts-incomplete");
            return;
        }
        assert(outcome.kind === "execute", `hyper-v-network-real-cleanup-${String(outcome.kind)}`);
        const execution = await library.executeHyperVHostNetworkAction(client, outcome, signal ? { signal } : undefined);
        if (execution.kind !== "mutation-completed") mutationUnconfirmed("cleanup", execution);
        if (execution.actionKind === "remove-switch") {
            assert(execution.switchIdentity.id === identity.switchIdentity.id, "hyper-v-network-real-cleanup-switch-id-mismatch");
        } else if (execution.actionKind === "remove-nat" && identity.natIdentity !== undefined) {
            assert(execution.natIdentity.instanceId === identity.natIdentity.instanceId, "hyper-v-network-real-cleanup-nat-id-mismatch");
        } else if (execution.actionKind === "remove-gateway" && identity.interfaceIndex !== undefined) {
            assert(execution.gatewayIdentity.interfaceIndex === identity.interfaceIndex,
                "hyper-v-network-real-cleanup-interface-id-mismatch");
        }
        removed.add(execution.actionKind);
    }
    throw new Error("hyper-v-network-real-cleanup-step-limit");
}

export async function runHyperVWindowsNetworkRealScenario(
    dependencies: HyperVWindowsNetworkRealDependencies,
): Promise<HyperVWindowsNetworkRealResult> {
    const token = (dependencies.randomToken ?? (() => randomBytes(8).toString("hex")))();
    assert(TOKEN_PATTERN.test(token), "hyper-v-network-real-token-invalid");
    const library = dependencies.library;
    const switchName = `ccc-net-real-${token}`;
    const natName = `ccc-net-real-${token}`;
    const notes = `ccc-hyper-v-network-real:${token}`;
    dependencies.log?.(`INFO Hyper-V network proof token=${token} switch=${switchName} nat=${natName}`);
    const subnetOctet = 64 + (Number.parseInt(token.slice(0, 2), 16) % 128);
    const network = library.createHyperVHostNetworkSpec({
        switchName: library.parseHyperVVirtualSwitchName(switchName),
        natName: library.parseHyperVNatName(natName),
        cidr: `172.31.${subnetOctet}.0/24`,
        gateway: `172.31.${subnetOctet}.1`,
    });
    const counts: NativeCounts = {
        cold: { ordinary: 0, elevated: 0, mutations: 0 },
        warm: { ordinary: 0, elevated: 0, mutations: 0 },
    };
    const now = dependencies.now ?? Date.now;
    const attempts: Array<{ kind: "cold" | "warm"; wallTimeMilliseconds: number; switchId: string; natInstanceId: string }> = [];
    const sessionIds: string[] = [];

    for (const kind of ["cold", "warm"] as const) {
        aborted(dependencies.signal);
        const startedAt = now();
        const ordinary = countedClient(dependencies.ordinaryClient, () => { counts[kind].ordinary += 1; });
        const initialProvenance: HyperVHostNetworkEnsureProvenance = {
            kind: "fresh",
            expectedSwitchNotes: notes,
        };
        const before = await inspect(library, ordinary, "standard", initialProvenance, network, dependencies.signal);
        assert(!before.virtualSwitches.some((item) => item.name === switchName)
            && !before.nats.some((item) => item.name === natName),
        "hyper-v-network-real-token-resource-preexists");
        const decision = library.reconcileHyperVHostNetwork(before, network);
        assert(decision.kind === "needs-administrator", `hyper-v-network-real-standard-decision-${String(decision.kind)}`);

        const identity = await dependencies.withAdministratorClient(kind, async (rawElevated, sessionId) => {
            assert(typeof sessionId === "string" && sessionId.length > 0, "hyper-v-network-real-session-id-invalid");
            sessionIds.push(sessionId);
            const elevated = countedClient(rawElevated, (mutation) => {
                counts[kind].elevated += 1;
                if (mutation) counts[kind].mutations += 1;
            });
            const administratorBefore = await inspect(
                library,
                elevated,
                "administrator",
                initialProvenance,
                network,
                dependencies.signal,
            );
            assert(!administratorBefore.virtualSwitches.some((item) => item.name === switchName)
                && !administratorBefore.nats.some((item) => item.name === natName),
            "hyper-v-network-real-token-resource-preexists-after-elevation");
            const administratorForeignBefore = foreignFingerprint(administratorBefore, { switchName, natName });
            const receipts: PartialNetworkIdentity = {};
            let created: HyperVHostNetworkSettledIdentity;
            try {
                created = await ensureNetwork(library, elevated, network, notes, receipts, dependencies.signal);
            } catch (error) {
                const ownershipUnproven = error instanceof Error
                    && (error.message === "hyper-v-network-real-ownership-receipt-missing"
                        || error.message === "hyper-v-network-real-gateway-ownership-unproven");
                // A mutation whose response was lost may still have applied. The library never
                // replays it; the proof reinspects and adopts only resources that carry this
                // run's token exactly once, so the host is left clean without touching anything
                // else. Ambiguity (two token-named switches) is left for the person.
                if (error instanceof Error && error.message.startsWith(MUTATION_UNCONFIRMED_PREFIX)) {
                    try {
                        await recoverTokenScopedReceipts(library, elevated, network, notes, switchName, natName, receipts, dependencies.signal);
                    } catch (recoveryError) {
                        throw new AggregateError([error, recoveryError], "hyper-v-network-real-ensure-and-recovery-failed");
                    }
                }
                if (receipts.switchIdentity && !ownershipUnproven) {
                    try {
                        await cleanupNetwork(library, elevated, network, {
                            switchIdentity: receipts.switchIdentity,
                            ...(receipts.interfaceIndex === undefined ? {} : { interfaceIndex: receipts.interfaceIndex }),
                            ...(receipts.natIdentity === undefined ? {} : { natIdentity: receipts.natIdentity }),
                        }, dependencies.signal);
                    } catch (cleanupError) {
                        throw new AggregateError([error, cleanupError], "hyper-v-network-real-ensure-and-cleanup-failed");
                    }
                }
                throw error;
            }
            await cleanupNetwork(library, elevated, network, created, dependencies.signal);
            const finalObservation = await inspect(library, elevated, "administrator", initialProvenance, network, dependencies.signal);
            assert(!finalObservation.virtualSwitches.some((item) => item.id === created.switchIdentity.id),
                "hyper-v-network-real-switch-cleanup-unconfirmed");
            assert(!finalObservation.nats.some((item) => item.instanceId === created.natIdentity.instanceId),
                "hyper-v-network-real-nat-cleanup-unconfirmed");
            assert(!finalObservation.ipv4Addresses.some((item) => item.interfaceIndex === created.interfaceIndex
                && item.address === network.gateway), "hyper-v-network-real-gateway-cleanup-unconfirmed");
            assert(foreignFingerprint(finalObservation, {
                switchName,
                natName,
                switchId: created.switchIdentity.id,
                interfaceIndex: created.interfaceIndex,
            }) === administratorForeignBefore, "hyper-v-network-real-unrelated-resource-mutated");
            return created;
        });

        const after = await inspect(library, ordinary, "standard", initialProvenance, network, dependencies.signal);
        assert(!after.virtualSwitches.some((item) => item.id === identity.switchIdentity.id),
            "hyper-v-network-real-ordinary-switch-cleanup-unconfirmed");
        assert(!after.nats.some((item) => item.instanceId === identity.natIdentity.instanceId),
            "hyper-v-network-real-ordinary-nat-cleanup-unconfirmed");
        attempts.push({
            kind,
            wallTimeMilliseconds: Math.max(0, now() - startedAt),
            switchId: String(identity.switchIdentity.id),
            natInstanceId: String(identity.natIdentity.instanceId),
        });
        dependencies.log?.(`PASS Hyper-V network ${kind} exact-ID cleanup (${counts[kind].ordinary} ordinary, ${counts[kind].elevated} elevated native calls)`);
    }

    assert(sessionIds.length === 2 && sessionIds[0] === sessionIds[1], "hyper-v-network-real-session-not-reused");
    const cold = attempts[0];
    const warm = attempts[1];
    assert(cold?.kind === "cold" && warm?.kind === "warm", "hyper-v-network-real-attempts-invalid");
    const coldResult = {
        kind: "cold" as const,
        wallTimeMilliseconds: cold.wallTimeMilliseconds,
        switchId: cold.switchId,
        natInstanceId: cold.natInstanceId,
    };
    const warmResult = {
        kind: "warm" as const,
        wallTimeMilliseconds: warm.wallTimeMilliseconds,
        switchId: warm.switchId,
        natInstanceId: warm.natInstanceId,
    };
    return {
        token,
        switchName,
        natName,
        administratorScopeCount: 2,
        sessionReused: true,
        attempts: [coldResult, warmResult],
        typedNativeInvocationCounts: counts,
        legacyNativeInvocationCount: dependencies.legacyNativeInvocationCount ?? null,
        legacyComparison: dependencies.legacyNativeInvocationCount === undefined
            ? "not-run-standalone-safety"
            : "measured",
    };
}
