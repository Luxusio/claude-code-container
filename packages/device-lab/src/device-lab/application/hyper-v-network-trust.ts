import {
    networkAddressCandidates,
    isHyperVCccNetworkIdentity,
    validHyperVIncarnationId,
    type HyperVNetworkState,
    type HyperVNetworkIntent,
    type HyperVNetworkIntentOwnershipEvidence,
    type HyperVNetworkAllocation,
    type HyperVNetworkCommandResult,
    type HyperVProviderCommand,
    type HyperVNetworkObservation,
    type HyperVNetworkCleanupObservation,
    type HyperVNetworkAllocationRequest,
    type HyperVNetworkEnsureFailure,
    type HyperVNetworkFabricResult,
} from "../domain/hyper-v-network-trust.js";
import type { HyperVNetworkPorts } from "../ports/hyper-v-network-trust.js";
import { planHyperVHostNetworkCleanup, reconcileHyperVHostNetwork } from "@ccc/hyper-v/lifecycle/index.js";
import type {
    HyperVHostNetworkObservation,
    HyperVHostNetworkCleanupObservation,
    HyperVHostNetworkSpec,
    HyperVHostNetworkEnsureProvenance,
    HyperVHostNetworkCleanupProvenance,
    HyperVHostNetworkReconciliationOutcome,
} from "@ccc/hyper-v/index.js";
import {
    DeviceLabHyperVNetworkAdapterError,
    confirmedEnsureOutcome,
    ensureReceiptConflict,
    observationWithConfirmedEnsureReceipts,
    cleanupReceiptConflict,
    isRetryableEnsureObservation,
    parseKnownHostLine,
    type DeviceLabHyperVHostNetworkEnsureOutcome,
    type DeviceLabHyperVHostNetworkCleanupOutcome,
    type DeviceLabHyperVHostNetworkEnsureCompletedAction,
    type DeviceLabHyperVHostNetworkCleanupCompletedAction,
    type DeviceLabHyperVHostNetworkEnsureTransactionResult,
    type DeviceLabHyperVHostNetworkCleanupTransactionResult,
    type HyperVNetworkRelease,
    type HyperVNetworkReleaseOptions,
} from "../domain/hyper-v-network-trust.js";
import type {
    HyperVNetworkStatePorts,
    HyperVHostNetworkPorts,
    HyperVHostNetworkEffects,
    HyperVHostEnsureRequest,
    HyperVHostCleanupRequest,
} from "../ports/hyper-v-network-trust.js";
const MAXIMUM_ENSURE_MUTATIONS = 4;
const MAXIMUM_CLEANUP_MUTATIONS = 3;
const MAXIMUM_TRANSIENT_OBSERVATIONS = 12;
const TRANSIENT_OBSERVATION_INTERVAL_MILLISECONDS = 250;
type HostEnsureOptions = HyperVHostEnsureRequest & {
    effects: HyperVHostNetworkEffects;
    onConfirmedAction: HyperVHostEnsureRequest["confirmed"];
};
type HostCleanupOptions = HyperVHostCleanupRequest & {
    effects: HyperVHostNetworkEffects;
    onConfirmedAction: HyperVHostCleanupRequest["confirmed"];
};
function createHostApplication(ports: HyperVHostNetworkPorts) {
    async function waitForNextTransientObservation(options: Pick<HostEnsureOptions, "deadlineAt">): Promise<boolean> {
        if (Number.isFinite(options.deadlineAt) && options.deadlineAt - ports.now() <= TRANSIENT_OBSERVATION_INTERVAL_MILLISECONDS)
            return false;
        await ports.pause(TRANSIENT_OBSERVATION_INTERVAL_MILLISECONDS);
        return !Number.isFinite(options.deadlineAt) || ports.now() < options.deadlineAt;
    }
    async function inspectDeviceLabHyperVHostNetwork(effects: HyperVHostNetworkEffects, options: {
        network: HyperVHostNetworkSpec;
        provenance: HyperVHostNetworkEnsureProvenance;
        privilege: "standard" | "administrator";
    }): Promise<HyperVHostNetworkObservation> {
        return { privilege: options.privilege, provenance: options.provenance, ...await effects.observe(options.network) };
    }
    async function inspectDeviceLabHyperVHostNetworkCleanup(effects: HyperVHostNetworkEffects, options: {
        network: HyperVHostNetworkSpec;
        privilege: "standard" | "administrator";
    }): Promise<HyperVHostNetworkCleanupObservation> {
        return { privilege: options.privilege, ...await effects.observe(options.network) };
    }
    async function reconcileEnsureWithoutMutation(client: HyperVHostNetworkEffects, options: Pick<HostEnsureOptions, "network" | "provenance" | "deadlineAt">): Promise<DeviceLabHyperVHostNetworkEnsureOutcome> {
        for (let observationCount = 1; observationCount <= MAXIMUM_TRANSIENT_OBSERVATIONS; observationCount += 1) {
            const observation = await inspectDeviceLabHyperVHostNetwork(client, {
                network: options.network,
                provenance: options.provenance,
                privilege: "standard",
            });
            const outcome = assertStandardDecision(reconcileHyperVHostNetwork(observation, options.network));
            if (!isRetryableEnsureObservation(outcome)
                || observationCount === MAXIMUM_TRANSIENT_OBSERVATIONS
                || !await waitForNextTransientObservation(options)) {
                return outcome;
            }
        }
        throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-mutation-bound-exceeded");
    }
    function assertStandardDecision(outcome: HyperVHostNetworkReconciliationOutcome<"ensure">): DeviceLabHyperVHostNetworkEnsureOutcome;
    function assertStandardDecision(outcome: HyperVHostNetworkReconciliationOutcome<"cleanup">): DeviceLabHyperVHostNetworkCleanupOutcome;
    function assertStandardDecision(outcome: HyperVHostNetworkReconciliationOutcome): Exclude<HyperVHostNetworkReconciliationOutcome, {
        readonly kind: "execute";
    }> {
        if (outcome.kind === "execute") {
            throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-standard-plan-executable");
        }
        return outcome;
    }
    async function reconcileEnsureAsAdministrator(client: HyperVHostNetworkEffects, options: Pick<HostEnsureOptions, "network" | "provenance" | "onConfirmedAction" | "deadlineAt">): Promise<DeviceLabHyperVHostNetworkEnsureTransactionResult> {
        let mutations = 0;
        let transientObservations = 0;
        let confirmedActions = 0;
        const completedActions: DeviceLabHyperVHostNetworkEnsureCompletedAction[] = [];
        while (true) {
            const observation = await inspectDeviceLabHyperVHostNetwork(client, {
                network: options.network,
                provenance: options.provenance,
                privilege: "administrator",
            });
            const receiptConflict = ensureReceiptConflict(observation, completedActions);
            if (receiptConflict)
                return { outcome: receiptConflict, completedActions: [...completedActions] };
            while (confirmedActions < completedActions.length) {
                const confirmedAction = completedActions[confirmedActions];
                if (!confirmedAction) {
                    throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-action-operation-mismatch");
                }
                await options.onConfirmedAction(confirmedAction, observation);
                confirmedActions += 1;
            }
            const outcome = reconcileHyperVHostNetwork(observationWithConfirmedEnsureReceipts(observation, completedActions), options.network);
            switch (outcome.kind) {
                case "settled":
                    return {
                        outcome: confirmedEnsureOutcome(outcome, completedActions),
                        completedActions: [...completedActions],
                    };
                case "conflict":
                    return { outcome, completedActions: [...completedActions] };
                case "indeterminate":
                    if (isRetryableEnsureObservation(outcome)
                        && transientObservations + 1 < MAXIMUM_TRANSIENT_OBSERVATIONS
                        && await waitForNextTransientObservation(options)) {
                        transientObservations += 1;
                        break;
                    }
                    return { outcome, completedActions: [...completedActions] };
                case "needs-administrator":
                    throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-administrator-plan-needs-administrator");
                case "execute": {
                    if (mutations >= MAXIMUM_ENSURE_MUTATIONS) {
                        throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-mutation-bound-exceeded");
                    }
                    mutations += 1;
                    const execution = await client.execute(outcome);
                    if (execution.operation !== "ensure") {
                        throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-action-operation-mismatch");
                    }
                    if (execution.kind === "indeterminate") {
                        if (ports.mutationNeverStarted(execution.cause))
                            throw execution.cause;
                        return { outcome: execution, completedActions: [...completedActions] };
                    }
                    completedActions.push(execution);
                    transientObservations = 0;
                    break;
                }
            }
        }
    }
    async function ensureHost(options: HostEnsureOptions): Promise<DeviceLabHyperVHostNetworkEnsureTransactionResult> {
        const outcome = await reconcileEnsureWithoutMutation(options.effects, options);
        if (outcome.kind !== "needs-administrator")
            return { outcome, completedActions: [] };
        return ports.withAdministrator((client) => reconcileEnsureAsAdministrator(client, options), "ensure");
    }
    async function reconcileCleanupAsAdministrator(client: HyperVHostNetworkEffects, options: Pick<HostCleanupOptions, "network" | "provenance" | "onConfirmedAction">): Promise<DeviceLabHyperVHostNetworkCleanupTransactionResult> {
        let mutations = 0;
        let confirmedActions = 0;
        const completedActions: DeviceLabHyperVHostNetworkCleanupCompletedAction[] = [];
        while (true) {
            const observation = await inspectDeviceLabHyperVHostNetworkCleanup(client, {
                network: options.network,
                privilege: "administrator",
            });
            const receiptConflict = cleanupReceiptConflict(observation, completedActions);
            if (receiptConflict)
                return { outcome: receiptConflict, completedActions: [...completedActions] };
            while (confirmedActions < completedActions.length) {
                const confirmedAction = completedActions[confirmedActions];
                if (!confirmedAction) {
                    throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-action-operation-mismatch");
                }
                await options.onConfirmedAction(confirmedAction, observation);
                confirmedActions += 1;
            }
            const outcome = planHyperVHostNetworkCleanup(observation, options.network, options.provenance);
            switch (outcome.kind) {
                case "settled":
                case "conflict":
                case "indeterminate":
                    return { outcome, completedActions: [...completedActions] };
                case "needs-administrator":
                    throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-administrator-plan-needs-administrator");
                case "execute": {
                    if (mutations >= MAXIMUM_CLEANUP_MUTATIONS) {
                        throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-mutation-bound-exceeded");
                    }
                    mutations += 1;
                    const execution = await client.execute(outcome);
                    if (execution.operation !== "cleanup") {
                        throw new DeviceLabHyperVNetworkAdapterError("hyper-v-network-adapter-action-operation-mismatch");
                    }
                    if (execution.kind === "indeterminate") {
                        if (ports.mutationNeverStarted(execution.cause))
                            throw execution.cause;
                        return { outcome: execution, completedActions: [...completedActions] };
                    }
                    completedActions.push(execution);
                    break;
                }
            }
        }
    }
    async function cleanupHost(options: HostCleanupOptions): Promise<DeviceLabHyperVHostNetworkCleanupTransactionResult> {
        const observation = await inspectDeviceLabHyperVHostNetworkCleanup(options.effects, {
            network: options.network,
            privilege: "standard",
        });
        const outcome = assertStandardDecision(planHyperVHostNetworkCleanup(observation, options.network, options.provenance));
        if (outcome.kind !== "needs-administrator")
            return { outcome, completedActions: [] };
        return ports.withAdministrator((client) => reconcileCleanupAsAdministrator(client, options), "cleanup");
    }
    return {
        ensureHost: (request: HyperVHostEnsureRequest) => ensureHost({ ...request, effects: ports.standard, onConfirmedAction: request.confirmed }),
        cleanupHost: (request: HyperVHostCleanupRequest) => cleanupHost({ ...request, effects: ports.standard, onConfirmedAction: request.confirmed }),
    };
}
function createStateApplication(ports: Omit<HyperVNetworkStatePorts, "kind">) {
    function release(
        ownerId: string,
        deviceId: string,
        incarnationId?: string | null,
        options: HyperVNetworkReleaseOptions = {},
    ): HyperVNetworkRelease {
        try {
            const current = ports.readState();
            if (!current)
                return { ok: true, released: false, statePresent: false, remaining: 0 };
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
                stateRevision: ports.revision(current),
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
                if (options.preserveManagedFabric === true) {
                    if (!(typeof incarnationId === "string" && /^[a-f0-9]{32}$/.test(incarnationId)) || matched?.incarnationId !== incarnationId) {
                        return {
                            ok: false,
                            released: false,
                            statePresent: true,
                            remaining: current.allocations.length,
                            ...identity,
                            error: "hyper-v-network-allocation-incarnation-conflict",
                        };
                    }
                    ports.ensureStateRoot();
                    ports.writeState({ ...current, allocations });
                    return {
                        ok: true,
                        released: true,
                        statePresent: true,
                        remaining: 0,
                        ...identity,
                        preservedManagedFabric: true,
                    };
                }
                return { ok: true, released: true, statePresent: true, remaining: 0, ...identity };
            }
            ports.ensureStateRoot();
            ports.writeState({ ...current, allocations });
            return { ok: true, released: true, statePresent: true, remaining: allocations.length, ...identity };
        }
        catch (error) {
            return {
                ok: false,
                released: false,
                statePresent: true,
                remaining: -1,
                error: ports.boundedError(error, "hyper-v-network-state-update-failed"),
            };
        }
    }
    function allocationMatches(
        ownerId: string,
        deviceId: string,
        address: string,
    ): boolean {
        return ports.readState()?.allocations.find(allocation => allocation.ownerId === ownerId && allocation.deviceId === deviceId)?.address === address;
    }
    function knownIdentity(path: string, address: string) {
        const text = ports.readTrustText(path, "hyper-v-linux-ssh-known-hosts");
        if (text === null)
            return null;
        const encoded = parseKnownHostLine(text, address);
        return encoded ? ports.ed25519Identity(encoded) : null;
    }
    function validateGuestTrust(
        ownerId: string,
        deviceId: string,
        publicPath: string,
        knownPath: string,
        address: string,
        fingerprint: string,
    ): boolean {
        if (!allocationMatches(ownerId, deviceId, address))
            return false;
        const text = ports.readTrustText(publicPath, "hyper-v-linux-ssh-host-public-key")?.trim() || "";
        const known = knownIdentity(knownPath, address);
        const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})(?: [^\r\n]{1,256})?$/.exec(text);
        if (!match || !known)
            return false;
        const identity = ports.ed25519Identity(match[1]);
        return identity !== null && known.encodedKey === match[1] && identity.fingerprint === fingerprint;
    }
    function reconcileGuestTrust(ownerId: string, deviceId: string, publicPath: string, knownPath: string, address: string, commit: (fingerprint: string) => boolean): {
        fingerprint: string;
    } | null {
        if (!allocationMatches(ownerId, deviceId, address))
            return null;
        ports.assertTrustPath(publicPath, "hyper-v-linux-ssh-host-public-key");
        ports.assertTrustPath(knownPath, "hyper-v-linux-ssh-known-hosts");
        const identity = knownIdentity(knownPath, address);
        if (!identity)
            return null;
        try {
            ports.writeTrustText(publicPath, `${identity.publicKey}\n`);
            if (!commit(identity.fingerprint))
                return null;
        }
        catch {
            return null;
        }
        return { fingerprint: identity.fingerprint };
    }
    function adoptGuestTrust(ownerId: string, deviceId: string, observedPath: string, publicPath: string, knownPath: string, address: string, commit?: (fingerprint: string) => boolean): {
        fingerprint: string;
    } | null {
        if (!allocationMatches(ownerId, deviceId, address))
            return null;
        ports.assertTrustPath(observedPath, "hyper-v-linux-ssh-observed-known-hosts");
        ports.assertTrustPath(publicPath, "hyper-v-linux-ssh-host-public-key");
        ports.assertTrustPath(knownPath, "hyper-v-linux-ssh-known-hosts");
        const observed = ports.readTrustText(observedPath, "hyper-v-linux-ssh-observed-known-hosts");
        if (observed === null)
            return null;
        const encoded = parseKnownHostLine(observed, address);
        const identity = encoded ? ports.ed25519Identity(encoded) : null;
        if (!identity)
            return null;
        try {
            ports.writeTrustText(knownPath, `${address} ${identity.publicKey}\n`);
        }
        catch {
            return commit && reconcileGuestTrust(ownerId, deviceId, publicPath, knownPath, address, commit) || null;
        }
        if (!commit) {
            ports.writeTrustText(publicPath, `${identity.publicKey}\n`);
            return { fingerprint: identity.fingerprint };
        }
        return reconcileGuestTrust(ownerId, deviceId, publicPath, knownPath, address, commit);
    }
    return { release, validateGuestTrust, reconcileGuestTrust, adoptGuestTrust };
}
function createNetworkApplication(ports: HyperVNetworkPorts) {
    const state = createStateApplication(ports);
    const HYPER_V_NETWORK_GATEWAY = ports.gateway;
    const HYPER_V_NETWORK_PREFIX = ports.prefix;
    const HYPER_V_NETWORK_PREFIX_LENGTH = ports.prefixLength;
    const HYPER_V_NETWORK_MARKER = ports.marker;
    const HYPER_V_NETWORK_NAT = ports.natName;
    const HYPER_V_ELEVATED_TERMINATION_GRACE_MS = 10000;
    const HYPER_V_NETWORK_INSPECTION_BATCH_SIZE = 32;
    function assertHyperVOperationDeadline(deadlineAt: number): void {
        if (Number.isFinite(deadlineAt) && ports.now() >= deadlineAt)
            ports.throwDeadline();
    }
    function hyperVRemainingTimeout(deadlineAt: number, maximumMs: number): number {
        if (!Number.isFinite(deadlineAt))
            return maximumMs;
        const remaining = Math.floor(deadlineAt - ports.now());
        if (remaining <= 0)
            ports.throwDeadline();
        return Math.max(1, Math.min(maximumMs, remaining));
    }
    async function inspectOwnerHost(effects: HyperVHostNetworkEffects, options: {
        network: HyperVHostNetworkSpec;
        privilege: "standard";
        provenance: HyperVHostNetworkEnsureProvenance;
    }): Promise<HyperVHostNetworkObservation> {
        return { privilege: options.privilege, provenance: options.provenance, ...await effects.observe(options.network) };
    }
    function intentOwnsDedicatedNat(intent: HyperVNetworkIntent): boolean {
        return intent.marker !== HYPER_V_NETWORK_MARKER && isHyperVCccNetworkIdentity(intent.marker, intent.natName);
    }
    function intentCanClaimFreshOwnership(intent: HyperVNetworkIntent): boolean {
        return intent.ownershipOrigin !== "adopted" && intentOwnsDedicatedNat(intent);
    }
    function createIntent(runtime: HyperVNetworkPorts): HyperVNetworkIntent {
        const token = runtime.token();
        const intent = runtime.freshIntent(token, runtime.timestamp());
        runtime.ensureStateRoot();
        runtime.writeIntent(intent);
        return intent;
    }
    function sameOwnershipReceipt(left: unknown, right: unknown): boolean {
        return JSON.stringify(left) === JSON.stringify(right);
    }
    function persistTypedIntentIdentityTransition(
        runtime: HyperVNetworkPorts,
        intent: HyperVNetworkIntent,
        marker: string,
        natName: string,
    ): HyperVNetworkIntent {
        if (intent.marker === marker && intent.natName === natName)
            return intent;
        const persisted = runtime.readIntent();
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
        if (!transition)
            throw new Error("hyper-v-network-intent-identity-conflict");
        const checkpoint = ports.decodeIntent(transition);
        runtime.ensureStateRoot();
        runtime.writeIntent(checkpoint);
        runtime.assertStateRoot("hyper-v-network-intent-identity-transition-checkpoint");
        return checkpoint;
    }
    function persistTypedCurrentStateIdentityTransition(
        runtime: HyperVNetworkPorts,
        current: HyperVNetworkState,
        marker: string,
        natName: string,
        natInstanceId: string,
    ): HyperVNetworkState {
        if (current.marker === marker && current.natName === natName)
            return current;
        if (!isAllowedPersistedCccIdentityTransition(current.marker, current.natName, marker, natName)) {
            throw new Error("hyper-v-network-state-identity-conflict");
        }
        const persisted = runtime.readState();
        if (!persisted || ports.revision(persisted) !== ports.revision(current)) {
            throw new Error("hyper-v-network-state-revision-conflict");
        }
        const checkpoint = ports.decodeState({
            ...persisted,
            marker,
            natName,
            natInstanceId,
        });
        runtime.ensureStateRoot();
        runtime.writeState(checkpoint);
        runtime.assertStateRoot("hyper-v-network-state-identity-transition-checkpoint");
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
                const switches = observation.virtualSwitches.filter((candidate) => candidate.name === network.switchName && candidate.notes === marker);
                const hostAdapters = observation.hostAdapters.filter((candidate) => String(candidate.name) === `vEthernet (${network.switchName})`
                    && candidate.interfaceIndex === action.gatewayIdentity.interfaceIndex);
                if (switches.length !== 1
                    || hostAdapters.length !== 1
                    || action.gatewayIdentity.address !== network.gateway
                    || action.gatewayIdentity.prefixLength !== network.prefixLength) {
                    throw new Error("hyper-v-network-intent-ownership-conflict");
                }
                const virtualSwitch = switches[0];
                if (!virtualSwitch)
                    throw new Error("hyper-v-network-intent-ownership-conflict");
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
        runtime: HyperVNetworkPorts,
        intent: HyperVNetworkIntent,
        nextEvidence: HyperVNetworkIntentOwnershipEvidence | null,
    ): HyperVNetworkIntent {
        if (!nextEvidence)
            return intent;
        const persisted = runtime.readIntent();
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
        const checkpoint = ports.decodeIntent({ ...persisted, ownershipEvidence });
        runtime.ensureStateRoot();
        runtime.writeIntent(checkpoint);
        return checkpoint;
    }
    function ownershipEvidenceMatchesObservation(intent: HyperVNetworkIntent | null, observation: HyperVNetworkObservation, marker: string): {
        managedSwitch: boolean;
        managedGateway: boolean;
        managedNat: boolean;
    } {
        const evidence = intent?.ownershipEvidence;
        const switchMatches = !evidence?.switch || (evidence.switch.switchName === observation.switchName
            && evidence.switch.switchId.toLowerCase() === observation.switchId.toLowerCase()
            && evidence.switch.marker === marker);
        const gatewayMatches = !evidence?.gateway || (evidence.gateway.switchName === observation.switchName
            && evidence.gateway.switchId.toLowerCase() === observation.switchId.toLowerCase()
            && evidence.gateway.marker === marker
            && evidence.gateway.prefix === observation.prefix
            && evidence.gateway.gateway === observation.gateway);
        const natMatches = !evidence?.nat || (evidence.nat.natName === observation.natName
            && evidence.nat.natInstanceId === observation.natInstanceId
            && evidence.nat.marker === marker
            && evidence.nat.prefix === observation.prefix);
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
        runtime: HyperVNetworkPorts,
        current: HyperVNetworkState,
        evidence: HyperVNetworkIntentOwnershipEvidence | null,
    ): HyperVNetworkState {
        if (!evidence)
            return current;
        const persisted = runtime.readState();
        if (!persisted || ports.revision(persisted) !== ports.revision(current)) {
            throw new Error("hyper-v-network-state-revision-conflict");
        }
        const switchEvidence = evidence.switch ?? evidence.gateway;
        const checkpoint = ports.decodeState({
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
        runtime.ensureStateRoot();
        runtime.writeState(checkpoint);
        return checkpoint;
    }
    function persistTypedCleanupCheckpoint(
        runtime: HyperVNetworkPorts,
        current: HyperVNetworkState,
        action: DeviceLabHyperVHostNetworkCleanupCompletedAction,
    ): HyperVNetworkState | null {
        const persisted = runtime.readState();
        if (!persisted || ports.revision(persisted) !== ports.revision(current)) {
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
                checkpoint = ports.decodeState({ ...withoutNatIdentity, managedNat: false });
                break;
            }
            case "remove-gateway":
                if (!current.managedGateway
                    || String(action.gatewayIdentity.address) !== current.gateway
                    || Number(action.gatewayIdentity.prefixLength) !== HYPER_V_NETWORK_PREFIX_LENGTH) {
                    throw new Error("hyper-v-network-gateway-identity-conflict");
                }
                checkpoint = ports.decodeState({ ...current, managedGateway: false });
                break;
            case "remove-switch":
                if (!current.managedSwitch
                    || current.switchId.toLowerCase() !== String(action.switchIdentity.id).toLowerCase()
                    || current.switchName !== String(action.switchIdentity.name)) {
                    throw new Error("hyper-v-network-switch-identity-conflict");
                }
                checkpoint = ports.decodeState({ ...current, managedSwitch: false });
                break;
        }
        runtime.ensureStateRoot();
        if (!checkpoint.managedSwitch && !checkpoint.managedGateway && !checkpoint.managedNat) {
            runtime.removeState();
            runtime.assertStateRoot("hyper-v-network-cleanup-terminal-checkpoint");
            return null;
        }
        runtime.writeState(checkpoint);
        return checkpoint;
    }
    function removeIntentBestEffort(runtime: HyperVNetworkPorts): void {
        try {
            runtime.removeIntent();
        }
        catch {
            // A later allocation reconciles stale intent against committed state.
        }
    }
    function commandSucceeded(result: HyperVNetworkCommandResult): boolean {
        return result.status === 0 && !result.error;
    }
    function legacyHostFabricCompatibility(runtime: HyperVNetworkPorts) {
        if (runtime.hostFabric.kind !== "legacy-compatibility") {
            throw new Error("hyper-v-network-typed-runtime-missing");
        }
        return runtime.hostFabric;
    }
    function typedHostFabric(runtime: HyperVNetworkPorts) {
        return runtime.hostFabric.kind === "typed" ? runtime.hostFabric : null;
    }
    async function reconcileOrphanedAllocations(
        runtime: HyperVNetworkPorts,
        current: HyperVNetworkState,
        powershell: string,
        deadlineAt: number,
    ): Promise<HyperVNetworkState> {
        if (runtime.references.kind === "unavailable" || current.allocations.length === 0)
            return current;
        const candidates: HyperVNetworkAllocation[] = [];
        for (const allocation of current.allocations) {
            assertHyperVOperationDeadline(deadlineAt);
            if (!allocation.incarnationId)
                throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
            if (!runtime.references.isReferenced(allocation))
                candidates.push(allocation);
        }
        if (candidates.length === 0)
            return current;
        const orphaned = new Set<string>();
        for (let offset = 0; offset < candidates.length; offset += HYPER_V_NETWORK_INSPECTION_BATCH_SIZE) {
            const batch = candidates.slice(offset, offset + HYPER_V_NETWORK_INSPECTION_BATCH_SIZE);
            const typed = typedHostFabric(runtime);
            if (typed) {
                const names = batch.map(({ ownerId, deviceId, incarnationId }) => {
                    if (!incarnationId)
                        throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
                    return ports.vmName(ownerId, deviceId, incarnationId);
                });
                const observed = await typed.host.standard.exactVirtualMachines(names);
                const byName = new Map(observed.map((virtualMachine) => [String(virtualMachine.name), virtualMachine]));
                for (const candidate of batch) {
                    assertHyperVOperationDeadline(deadlineAt);
                    const incarnationId = candidate.incarnationId;
                    if (!incarnationId)
                        throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
                    const vmName = ports.vmName(candidate.ownerId, candidate.deviceId, incarnationId);
                    const virtualMachine = byName.get(vmName);
                    if (virtualMachine
                        && virtualMachine.notes !== `ccc-device-lab:${candidate.ownerId}:${candidate.deviceId}:${incarnationId}`) {
                        throw new Error("hyper-v-network-allocation-vm-ownership-conflict");
                    }
                    if (!virtualMachine)
                        orphaned.add(`${candidate.ownerId}:${candidate.deviceId}:${incarnationId}`);
                }
                continue;
            }
            const execution = await runtime.run(legacyHostFabricCompatibility(runtime).inspectAllocationsCommand({
                executable: powershell,
                allocations: batch.map(({ ownerId, deviceId, incarnationId }) => {
                    if (!incarnationId)
                        throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
                    return { ownerId, deviceId, incarnationId };
                }),
            }), {
                timeoutMs: hyperVRemainingTimeout(deadlineAt, 120000),
                outputLimit: runtime.commandOutputBytes,
            });
            assertHyperVOperationDeadline(deadlineAt);
            if (!commandSucceeded(execution)) {
                throw new Error(ports.providerDiagnostic(execution, "hyper-v-network-allocation-inspection-failed"));
            }
            const observation = ports.parseAllocationObservation(execution.stdout || "");
            if (!observation || observation.allocations.length !== batch.length) {
                throw new Error("hyper-v-network-allocation-inspection-invalid-result");
            }
            for (let index = 0; index < batch.length; index += 1) {
                assertHyperVOperationDeadline(deadlineAt);
                const candidate = batch[index];
                const observed = observation.allocations[index];
                if (!candidate?.incarnationId)
                    throw new Error("hyper-v-network-allocation-incarnation-unverifiable");
                if (observed.ownerId !== candidate.ownerId
                    || observed.deviceId !== candidate.deviceId
                    || observed.incarnationId !== candidate.incarnationId
                    || observed.vmName !== ports.vmName(candidate.ownerId, candidate.deviceId, candidate.incarnationId)) {
                    throw new Error("hyper-v-network-allocation-inspection-identity-mismatch");
                }
                if (!observed.present)
                    orphaned.add(`${candidate.ownerId}:${candidate.deviceId}:${candidate.incarnationId}`);
            }
        }
        if (orphaned.size === 0)
            return current;
        const allocations = current.allocations.filter((allocation) => !orphaned.has(`${allocation.ownerId}:${allocation.deviceId}:${allocation.incarnationId || ""}`));
        assertHyperVOperationDeadline(deadlineAt);
        runtime.ensureStateRoot();
        const reconciled = { ...current, allocations };
        runtime.writeState(reconciled);
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
        runtime: HyperVNetworkPorts,
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
            const elevatedDeadlineUnixMs = runtime.now() + Math.max(1, timeoutMs - HYPER_V_ELEVATED_TERMINATION_GRACE_MS);
            let elevatedCommand: HyperVProviderCommand;
            try {
                elevatedCommand = elevated(elevatedDeadlineUnixMs);
            }
            catch (error) {
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
        return ports.hostSpec(switchName, natName, HYPER_V_NETWORK_PREFIX, HYPER_V_NETWORK_GATEWAY);
    }
    // The shared typed projection, so a network failure reads the same here as at reconciliation and
    // in a create rollback: only a native code becomes hyper-v-ps-*; a transport or protocol code keeps
    // its category.
    function typedNetworkDiagnosticCode(error: unknown, fallback: string): string {
        return ports.typedError(error, fallback);
    }
    function typedNetworkExecutionDiagnostic(error: unknown, fallback: string): Record<string, unknown> {
        const diagnosticCode = typedNetworkDiagnosticCode(error, fallback);
        return ports.redactExecution({
            mode: "exec",
            provider: "hyper-v",
            status: null,
            error: diagnosticCode,
        }, diagnosticCode);
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
    function persistedNetworkProvenance(current: HyperVNetworkState): HyperVHostNetworkEnsureProvenance {
        return {
            kind: "persisted",
            expectedSwitchNotes: current.marker,
            switchIdentity: {
                id: ports.switchId(current.switchId),
                name: ports.switchName(current.switchName),
            },
            nat: current.natInstanceId
                ? {
                    kind: "exact",
                    identity: {
                        instanceId: ports.natInstanceId(current.natInstanceId),
                        name: ports.natNameValue(current.natName),
                    },
                }
                : { kind: "unrecorded" },
        };
    }
    function natNameFromCccMarker(marker: string): string | null {
        if (marker === HYPER_V_NETWORK_MARKER)
            return HYPER_V_NETWORK_NAT;
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
    async function typedEnsureProvenance(runtime: HyperVNetworkPorts, client: HyperVHostNetworkEffects, current: HyperVNetworkState | null, intent: HyperVNetworkIntent | null): Promise<{
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
                const inspection = await inspectOwnerHost(client, {
                    network: currentNetwork,
                    provenance: currentProvenance,
                    privilege: "standard",
                });
                const exactSwitches = inspection.virtualSwitches.filter((candidate) => String(candidate.id).toLowerCase() === current.switchId.toLowerCase()
                    && String(candidate.name) === current.switchName);
                const exactNats = inspection.nats.filter((candidate) => String(candidate.instanceId) === current.natInstanceId);
                if (exactSwitches.length === 1 && exactNats.length === 1) {
                    const exactSwitch = exactSwitches[0];
                    const exactNat = exactNats[0];
                    if (exactSwitch && exactNat
                        && isAllowedPersistedCccIdentityTransition(current.marker, current.natName, exactSwitch.notes, String(exactNat.name))) {
                        const transitionedCurrent = persistTypedCurrentStateIdentityTransition(runtime, current, exactSwitch.notes, String(exactNat.name), String(exactNat.instanceId));
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
        if (!intent)
            throw new Error("hyper-v-network-intent-missing");
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
                        id: ports.switchId(evidenceSwitch.switchId),
                        name: ports.switchName(evidenceSwitch.switchName),
                    },
                    nat: evidenceNat
                        ? {
                            kind: "exact",
                            identity: {
                                instanceId: ports.natInstanceId(evidenceNat.natInstanceId),
                                name: ports.natNameValue(evidenceNat.natName),
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
        const inspection = await inspectOwnerHost(client, {
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
        if (matchingNats.length > 1)
            throw new Error("hyper-v-network-nat-ambiguous");
        const adoptedNat = matchingNats[0];
        const transitionedIntent = persistTypedIntentIdentityTransition(runtime, intent, virtualSwitch.notes, adoptedNatName);
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
                            instanceId: ports.natInstanceId(evidenceNat.natInstanceId),
                            name: ports.natNameValue(evidenceNat.natName),
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
    async function ensureTypedHyperVHostNetwork(runtime: HyperVNetworkPorts, current: HyperVNetworkState | null, intent: HyperVNetworkIntent | null, deadlineAt: number): Promise<{
        observation: HyperVNetworkObservation;
        current: HyperVNetworkState | null;
        intent: HyperVNetworkIntent | null;
        freshIntentOwnershipEligible: boolean;
    }> {
        const typed = typedHostFabric(runtime);
        if (!typed)
            throw new Error("hyper-v-network-typed-runtime-missing");
        const request = await typedEnsureProvenance(runtime, typed.host.standard, current, intent);
        let checkpointedCurrent = request.current;
        let checkpointedIntent = request.intent;
        const transaction = await createHostApplication(typed.host).ensureHost({
            network: request.network,
            provenance: request.provenance,
            deadlineAt,
            confirmed: (action, observation) => {
                const evidence = typedOwnershipEvidenceFromConfirmedAction(action, observation, request.network, request.provenance.expectedSwitchNotes);
                if (checkpointedCurrent) {
                    checkpointedCurrent = persistTypedOwnershipInCurrentState(runtime, checkpointedCurrent, evidence);
                }
                else if (checkpointedIntent) {
                    checkpointedIntent = persistTypedOwnershipEvidence(runtime, checkpointedIntent, evidence);
                }
                else {
                    throw new Error("hyper-v-network-intent-missing");
                }
                return undefined;
            },
        });
        const outcome = transaction.outcome;
        if (outcome.kind !== "settled" || outcome.operation !== "ensure") {
            if (outcome.kind === "indeterminate" && ports.isNativeError(outcome.cause)) {
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
            id: ports.switchId(release.switchId),
            name: ports.switchName(release.switchName),
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
                        instanceId: ports.natInstanceId(release.natInstanceId),
                        name: ports.natNameValue(release.natName),
                    },
                }
                : { kind: "unmanaged" },
        };
    }
    async function cleanupTypedHyperVHostNetwork(runtime: HyperVNetworkPorts, release: HyperVNetworkRelease) {
        const typed = typedHostFabric(runtime);
        if (!typed || !release.switchName || !release.natName) {
            throw new Error("hyper-v-network-typed-runtime-missing");
        }
        const network = typedHostNetworkSpec(release.switchName, release.natName);
        const persistedState = runtime.readState();
        if (!persistedState
            || !release.stateRevision
            || ports.revision(persistedState) !== release.stateRevision) {
            throw new Error("hyper-v-network-state-revision-conflict");
        }
        let checkpointedState: HyperVNetworkState | null = persistedState;
        const transaction = await createHostApplication(typed.host).cleanupHost({
            network,
            provenance: typedCleanupProvenance(release),
            confirmed: (action) => {
                if (!checkpointedState)
                    throw new Error("hyper-v-network-state-missing");
                checkpointedState = persistTypedCleanupCheckpoint(runtime, checkpointedState, action);
                return undefined;
            },
        });
        const outcome = transaction.outcome;
        if (outcome.kind !== "settled" || outcome.operation !== "cleanup") {
            if (outcome.kind === "indeterminate" && ports.isNativeError(outcome.cause)) {
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
                stateRevision: ports.revision(checkpointedState),
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
            stateRevision: checkpointedState ? ports.revision(checkpointedState) : undefined,
        };
    }
    /**
     * Ensure the host fabric (switch, gateway, NAT) without reserving an address.
     *
     * `ccc devices setup hyper-v` needs the fabric to exist but owns no device, so
     * it takes this entry. It runs the same reconciliation, ownership and state
     * persistence as an allocation — the allocation list is simply left untouched —
     * so setup cannot drift from the broker the way a separate implementation did.
     */
    async function ensureHyperVHostNetworkFabric(runtime: HyperVNetworkPorts, deadlineAt = Number.POSITIVE_INFINITY): Promise<HyperVNetworkFabricResult> {
        const result = await ensureHyperVNetwork(runtime, null, deadlineAt);
        if (!result.ok)
            return result;
        return {
            ok: true,
            switchName: result.switchName,
            gateway: result.gateway,
            prefix: result.prefix,
            outboundPolicy: "nat",
        };
    }
    async function ensureHyperVNetworkAllocation(runtime: HyperVNetworkPorts, ownerId: string, deviceId: string, incarnationId: string, deadlineAt = Number.POSITIVE_INFINITY): Promise<{
        ok: true;
        switchName: string;
        address: string;
        macAddress: string;
        gateway: string;
        prefix: string;
        outboundPolicy: "nat";
    } | {
        ok: false;
        status: number;
        error: string;
        detail?: string;
        execution?: Record<string, unknown>;
        preserveEvidence?: boolean;
    }> {
        const result = await ensureHyperVNetwork(runtime, { ownerId, deviceId, incarnationId }, deadlineAt);
        if (!result.ok)
            return result;
        if (typeof result.address !== "string" || typeof result.macAddress !== "string") {
            return { ok: false, status: 500, error: "hyper-v-network-allocation-failed", detail: "hyper-v-network-allocation-missing" };
        }
        return {
            ok: true,
            switchName: result.switchName,
            address: result.address,
            macAddress: result.macAddress,
            gateway: result.gateway,
            prefix: result.prefix,
            outboundPolicy: "nat",
        };
    }
    async function ensureHyperVNetwork(runtime: HyperVNetworkPorts, allocationRequest: HyperVNetworkAllocationRequest | null, deadlineAt = Number.POSITIVE_INFINITY): Promise<{
        ok: true;
        switchName: string;
        address?: string;
        macAddress?: string;
        gateway: string;
        prefix: string;
        outboundPolicy: "nat";
    } | HyperVNetworkEnsureFailure> {
        const powershell = runtime.resolveExecutable("powershell.exe")
            || runtime.resolveExecutable("pwsh")
            || runtime.resolveExecutable("powershell");
        if (!powershell)
            return { ok: false, status: 503, error: "missing-provider-command", detail: "powershell" };
        if (allocationRequest && !validHyperVIncarnationId(allocationRequest.incarnationId)) {
            return { ok: false, status: 409, error: "hyper-v-network-incarnation-invalid" };
        }
        let current: HyperVNetworkState | null;
        let intent: HyperVNetworkIntent | null = null;
        try {
            current = runtime.readState();
            if (current) {
                let staleIntent: HyperVNetworkIntent | null = null;
                try {
                    staleIntent = runtime.readIntent();
                }
                catch {
                    // Committed state is authoritative.
                }
                if (staleIntent && (current.switchName !== staleIntent.switchName
                    || current.natName !== staleIntent.natName
                    || current.marker !== staleIntent.marker)) {
                    throw new Error("hyper-v-network-intent-state-conflict");
                }
                removeIntentBestEffort(runtime);
            }
            else {
                intent = runtime.readIntent();
                if (!intent)
                    intent = createIntent(runtime);
            }
        }
        catch (error) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-network-allocation-failed",
                detail: ports.boundedError(error, "hyper-v-network-allocation-failed"),
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
            if (current)
                current = await reconcileOrphanedAllocations(runtime, current, powershell, deadlineAt);
        }
        catch (error) {
            return {
                ok: false,
                status: 409,
                error: "hyper-v-network-allocation-reconciliation-failed",
                // The typed inventory read's own code, not the bare category its message starts with:
                // an unconfirmed absence has to say which native error left the allocation in place.
                detail: ports.typedError(error, "hyper-v-network-allocation-reconciliation-failed"),
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
                const typedResult = await ensureTypedHyperVHostNetwork(runtime, current, intent, deadlineAt);
                observation = typedResult.observation;
                current = typedResult.current;
                intent = typedResult.intent;
                typedFreshIntentOwnershipEligible = typedResult.freshIntentOwnershipEligible;
            }
            catch (error) {
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
        }
        else {
            const execution = await runWithElevation(runtime, legacyHostFabricCompatibility(runtime).ensureCommand(networkOptions), (elevatedDeadlineUnixMs) => legacyHostFabricCompatibility(runtime).ensureCommand({
                ...networkOptions,
                executable: runtime.resolveElevationExecutable(powershell),
                elevated: true,
                elevatedDeadlineUnixMs,
            }), deadlineAt);
            assertHyperVOperationDeadline(deadlineAt);
            if (!commandSucceeded(execution)) {
                return {
                    ok: false,
                    status: 502,
                    error: "hyper-v-network-setup-failed",
                    detail: ports.providerDiagnostic(execution, "hyper-v-network-setup-failed"),
                    execution: ports.redactExecution(execution, "hyper-v-network-setup-failed"),
                    preserveEvidence: true,
                };
            }
            observation = ports.parseNetworkObservation(execution.stdout || "");
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
            const resourceIdentityReconciled = Boolean(current && (current.switchId.toLowerCase() !== observation.switchId.toLowerCase()
                || current.natInstanceId !== observation.natInstanceId));
            const allocations = current?.allocations || [];
            const existing = allocationRequest
                ? allocations.find((allocation) => allocation.ownerId === allocationRequest.ownerId
                    && allocation.deviceId === allocationRequest.deviceId)
                : undefined;
            if (allocationRequest && existing) {
                if (existing.incarnationId !== allocationRequest.incarnationId)
                    throw new Error("hyper-v-network-allocation-incarnation-conflict");
                if (current && (current.marker !== observedMarker || current.natName !== observation.natName)) {
                    runtime.ensureStateRoot();
                    runtime.writeState({
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
            let address: string | undefined;
            let macAddress: string | undefined;
            if (allocationRequest) {
                const used = new Set(allocations.map((allocation) => allocation.address));
                address = networkAddressCandidates(ports.gateway, ports.addressDigest(allocationRequest.ownerId, allocationRequest.deviceId))
                    .find((candidate) => !used.has(candidate));
                if (!address)
                    throw new Error("hyper-v-network-address-space-exhausted");
                const usedMacs = new Set(allocations.map((allocation) => allocation.macAddress));
                let macSalt = 0;
                macAddress = ports.macAddress(allocationRequest.ownerId, allocationRequest.deviceId, macSalt);
                while (usedMacs.has(macAddress) && macSalt < 1024) {
                    macAddress = ports.macAddress(allocationRequest.ownerId, allocationRequest.deviceId, ++macSalt);
                }
                if (usedMacs.has(macAddress))
                    throw new Error("hyper-v-network-mac-space-exhausted");
            }
            const legacyFreshIntentOwnsObservedIdentity = !typedHostFabric(runtime) && !current && intent
                ? intentOwnsDedicatedNat({ ...intent, marker: observedMarker, natName: observation.natName })
                : false;
            const typedFreshIntentOwnsObservedIdentity = Boolean(typedHostFabric(runtime)
                && !current
                && intent
                && typedFreshIntentOwnershipEligible
                && intentCanClaimFreshOwnership(intent)
                && intent.marker === observedMarker
                && intent.switchName === observation.switchName
                && intent.natName === observation.natName);
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
                allocations: allocationRequest && address && macAddress
                    ? [
                        ...allocations,
                        {
                            ownerId: allocationRequest.ownerId,
                            deviceId: allocationRequest.deviceId,
                            incarnationId: allocationRequest.incarnationId,
                            address,
                            macAddress,
                            allocatedAt: runtime.timestamp(),
                        },
                    ]
                    : allocations,
            };
            runtime.ensureStateRoot();
            runtime.writeState(next);
            removeIntentBestEffort(runtime);
            return {
                ok: true,
                switchName: observation.switchName,
                ...(address ? { address } : {}),
                ...(macAddress ? { macAddress } : {}),
                gateway: observation.gateway,
                prefix: observation.prefix,
                outboundPolicy: "nat",
            };
        }
        catch (error) {
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
                    const cleanupExecution = await runWithElevation(runtime, legacyHostFabricCompatibility(runtime).cleanupCommand(cleanupOptions), (elevatedDeadlineUnixMs) => legacyHostFabricCompatibility(runtime).cleanupCommand({
                        ...cleanupOptions,
                        executable: runtime.resolveElevationExecutable(powershell),
                        elevated: true,
                        elevatedDeadlineUnixMs,
                    }), deadlineAt);
                    if (!commandSucceeded(cleanupExecution)) {
                        cleanupFailure = ports.providerDiagnostic(cleanupExecution, "hyper-v-network-cleanup-failed")
                            || "hyper-v-network-cleanup-failed";
                    }
                    else if (!ports.parseCleanupObservation(cleanupExecution.stdout || "")) {
                        cleanupFailure = "hyper-v-network-cleanup-invalid-result";
                    }
                }
                catch (cleanupError) {
                    cleanupFailure = ports.boundedError(cleanupError, "hyper-v-network-cleanup-failed");
                }
            }
            const allocationDetail = ports.boundedError(error, "hyper-v-network-allocation-failed");
            return {
                ok: false,
                status: cleanupFailure ? 502 : 409,
                error: cleanupFailure ? "hyper-v-network-allocation-cleanup-failed" : "hyper-v-network-allocation-failed",
                detail: cleanupFailure || allocationDetail,
                ...(cleanupFailure || typedEvidencePreserved ? { preserveEvidence: true } : {}),
            };
        }
    }
    function commitDeferredHyperVNetworkRelease(runtime: HyperVNetworkPorts, ownerId: string, deviceId: string, incarnationId: string | null | undefined, expectedStateRevision: string | undefined, cleanup: HyperVNetworkCleanupObservation): {
        ok: true;
        remaining: number;
    } | {
        ok: false;
        error: string;
    } {
        try {
            const current = runtime.readState();
            if (!current)
                return { ok: false, error: "hyper-v-network-state-missing" };
            if (!expectedStateRevision || ports.revision(current) !== expectedStateRevision) {
                return { ok: false, error: "hyper-v-network-state-revision-conflict" };
            }
            const matched = current.allocations.find((allocation) => allocation.ownerId === ownerId && allocation.deviceId === deviceId);
            if (!matched)
                return { ok: false, error: "hyper-v-network-allocation-missing" };
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
            }
            else if (current.managedNat) {
                next = {
                    ...current,
                    managedSwitch: cleanup.removedSwitch ? false : current.managedSwitch,
                    managedGateway: cleanup.removedGateway ? false : current.managedGateway,
                    managedNat: true,
                    allocations,
                };
            }
            else {
                next = {
                    ...current,
                    managedSwitch: cleanup.removedSwitch ? false : current.managedSwitch,
                    managedGateway: cleanup.removedGateway ? false : current.managedGateway,
                    managedNat: false,
                    allocations,
                };
            }
            runtime.ensureStateRoot();
            runtime.writeState(next);
            return { ok: true, remaining: allocations.length };
        }
        catch (error) {
            return { ok: false, error: ports.boundedError(error, "hyper-v-network-state-update-failed") };
        }
    }
    async function releaseHyperVNetworkAllocationAndCleanup(
        runtime: HyperVNetworkPorts,
        ownerId: string,
        deviceId: string,
        incarnationId: string | null | undefined,
        deadlineAt = Number.POSITIVE_INFINITY,
        options: HyperVNetworkReleaseOptions = {},
    ) {
        const release = state.release(ownerId, deviceId, incarnationId, options);
        if (!release.ok || !release.statePresent || !release.released || release.remaining !== 0) {
            return { ...release, networkCleanup: null };
        }
        if (release.preservedManagedFabric === true) {
            return {
                ...release,
                networkCleanup: { skipped: true, reason: "hyper-v-network-retained-by-request" },
            };
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
        if (!powershell)
            return { ...release, ok: false, error: "missing-provider-command", networkCleanup: null };
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
            }
            catch (error) {
                const diagnosticCode = typedNetworkDiagnosticCode(error, "hyper-v-network-cleanup-failed");
                return {
                    ...release,
                    ok: false,
                    error: diagnosticCode,
                    networkCleanup: typedNetworkExecutionDiagnostic(error, diagnosticCode),
                };
            }
        }
        else {
            const execution = await runWithElevation(runtime, legacyHostFabricCompatibility(runtime).cleanupCommand(cleanupOptions), (elevatedDeadlineUnixMs) => legacyHostFabricCompatibility(runtime).cleanupCommand({
                ...cleanupOptions,
                executable: runtime.resolveElevationExecutable(powershell),
                elevated: true,
                elevatedDeadlineUnixMs,
            }), deadlineAt);
            if (!commandSucceeded(execution)) {
                const diagnosticCode = ports.providerDiagnostic(execution, "hyper-v-network-cleanup-failed");
                return {
                    ...release,
                    ok: false,
                    error: diagnosticCode,
                    networkCleanup: ports.redactExecution(execution, diagnosticCode),
                };
            }
            observation = ports.parseCleanupObservation(execution.stdout || "");
            if (!observation) {
                return {
                    ...release,
                    ok: false,
                    error: "hyper-v-network-cleanup-invalid-result",
                    networkCleanup: ports.redactExecution(execution, "hyper-v-network-cleanup-invalid-result"),
                };
            }
        }
        if (observation.deferred === true) {
            const committed = commitDeferredHyperVNetworkRelease(runtime, ownerId, deviceId, incarnationId, cleanupStateRevision, observation);
            if (!committed.ok) {
                return { ...release, ok: false, error: committed.error, networkCleanup: null };
            }
            return { ...release, ok: true, remaining: committed.remaining, networkCleanup: observation };
        }
        runtime.removeState();
        return { ...release, ok: true, networkCleanup: observation };
    }
    return {
        ...state,
        ensureFabric: (deadlineAt = Number.POSITIVE_INFINITY) => ensureHyperVHostNetworkFabric(ports, deadlineAt),
        allocate: (ownerId: string, deviceId: string, incarnationId: string, deadlineAt = Number.POSITIVE_INFINITY) => ensureHyperVNetworkAllocation(ports, ownerId, deviceId, incarnationId, deadlineAt),
        releaseAndCleanup: (ownerId: string, deviceId: string, incarnationId?: string | null, deadlineAt = Number.POSITIVE_INFINITY, options: HyperVNetworkReleaseOptions = {}) => releaseHyperVNetworkAllocationAndCleanup(ports, ownerId, deviceId, incarnationId, deadlineAt, options),
    };
}
export function createHyperVNetworkTrust(ports: HyperVNetworkStatePorts): ReturnType<typeof createStateApplication>;
export function createHyperVNetworkTrust(ports: HyperVHostNetworkPorts): ReturnType<typeof createHostApplication>;
export function createHyperVNetworkTrust(ports: HyperVNetworkPorts): ReturnType<typeof createNetworkApplication>;
export function createHyperVNetworkTrust(ports: HyperVNetworkStatePorts | HyperVHostNetworkPorts | HyperVNetworkPorts) {
    if (ports.kind === "state")
        return createStateApplication(ports);
    if (ports.kind === "host")
        return createHostApplication(ports);
    return createNetworkApplication(ports);
}
