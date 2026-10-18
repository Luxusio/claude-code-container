import { brokerAndroidAvdName, brokerAndroidCommandSucceeded, brokerAndroidField, brokerAndroidNumber, brokerAndroidRecord, brokerAndroidReplacement, brokerAndroidSerial } from "../../domain/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidBoot, BrokerAndroidLifecycleInput, BrokerAndroidLifecycleRequest, BrokerAndroidLifecycleOutcome, BrokerAndroidOutcomeFacts, BrokerAndroidPreparation, BrokerAndroidRollback, BrokerAndroidFailureReason, BrokerAndroidProviderResult } from "../../domain/lifecycle/android-emulator-lifecycle.js";
import type { BrokerAndroidCreatePortAllocation, BrokerAndroidCreatePortAllocationPorts, BrokerAndroidEmulatorLifecyclePorts, BrokerAndroidPreparationPorts } from "../../ports/lifecycle/android-emulator-lifecycle.js";

/** Live augmentation reuses the broker's already inward preview allocator. */
export async function allocateBrokerAndroidCreatePort(ownerId: string, parsed: BrokerAndroidLifecycleRequest, ports: BrokerAndroidCreatePortAllocationPorts): Promise<BrokerAndroidCreatePortAllocation> {
    const allocation = ports.previewAllocation(ownerId, parsed);
    if (!allocation.ok) return allocation;
    const live = await ports.livePorts();
    if (!live.ok) return live;
    return live.ports.has(allocation.port) ? ports.previewAllocation(ownerId, parsed, live.ports) : allocation;
}

export function createBrokerAndroidRecord(ownerId: string, parsed: BrokerAndroidLifecycleRequest, ports: Pick<BrokerAndroidEmulatorLifecyclePorts<unknown, unknown>, "timestamp" | "avdHome">): Record<string, unknown> {
    const create = parsed.create || {};
    const now = ports.timestamp();
    const name = String(create.name || parsed.deviceId);
    const avdName = brokerAndroidAvdName(ownerId, create, name);
    const root = ports.avdHome();
    return brokerAndroidRecord(ownerId, parsed, create, name, avdName, root, now);
}

export function planBrokerAndroidCreate<Effect>(ownerId: string, parsed: BrokerAndroidLifecycleRequest,
    ports: Pick<BrokerAndroidPreparationPorts<unknown, Effect>, "ownedAvdName" | "prepareCreate">, create = parsed.create || {}): BrokerAndroidPreparation<Effect> {
    const systemImage = typeof create.systemImage === "string" ? create.systemImage : null;
    if (!systemImage) return {kind: "unavailable", error: "missing-provider-metadata", missing: ["systemImage"]};
    const avdName = brokerAndroidAvdName(ownerId, create, String(create.name || parsed.deviceId));
    if (!ports.ownedAvdName(avdName, ownerId)) return {kind: "unavailable", error: "android-avd-name-not-owner-scoped", missing: ["owner-prefixed avdName"]};
    return ports.prepareCreate({avdName, systemImage, ...(typeof create.deviceProfile === "string" && create.deviceProfile ? {deviceProfile: create.deviceProfile} : {})});
}

export function planBrokerAndroidExisting<Runtime, Effect>(ownerId: string, parsed: BrokerAndroidLifecycleRequest, device: unknown,
    ports: Omit<BrokerAndroidPreparationPorts<Runtime, Effect>, "prepareCreate">): BrokerAndroidPreparation<Effect> {
    const runtime = ports.captureRuntime();
    const serial = brokerAndroidSerial(device);
    const name = brokerAndroidField(device, "avdName");
    if (parsed.command === "device_status" || parsed.command === "device_stop") {
        if (!serial) return {kind: "unavailable", error: "missing-provider-metadata", missing: ["serial or port"]};
        return parsed.command === "device_status" ? ports.prepareStatus(runtime, serial) : ports.prepareStop(runtime, serial);
    }
    if (parsed.command === "device_delete") {
        if (parsed.deleteAvd === false) return {kind: "metadata-only"};
        if (!name) return {kind: "unavailable", error: "missing-provider-metadata", missing: ["avdName"]};
        if (!ports.ownedAvdName(name, ownerId)) return {kind: "unavailable", error: "android-avd-name-not-owner-scoped", missing: ["owner-prefixed avdName"]};
        return {kind: "metadata-only"};
    }
    if (!name) return {kind: "unavailable", error: "missing-provider-metadata", missing: ["avdName"]};
    const deviceHeadless = device && typeof device === "object" ? (device as Record<string, unknown>).headless : undefined;
    return ports.prepareStart(runtime, {avdName: name, port: brokerAndroidNumber(device, "port"), headless: typeof parsed.headless === "boolean" ? parsed.headless : deviceHeadless !== false});
}

/** Authenticated broker policy; it does not share the direct provider workflow. */
export function createBrokerAndroidEmulatorLifecycle<Effect, Receipt>(ports: BrokerAndroidEmulatorLifecyclePorts<Effect, Receipt>) {
    function refusal(input: BrokerAndroidLifecycleInput<Effect>, reason: BrokerAndroidFailureReason, error: string, extra: BrokerAndroidOutcomeFacts<Effect, Receipt> = {}): BrokerAndroidLifecycleOutcome<Effect, Receipt> {
        return {kind: "refused", reason, error, ...extra, ownerId: input.ownerId, backend: input.parsed.backend, deviceId: input.parsed.deviceId};
    }

    async function inactive(name: string): Promise<boolean> {
        const live = await ports.liveAvds();
        if (!live.ok || live.names.has(name)) return false;
        const processes = await ports.avdProcesses(name);
        return processes.ok && !processes.active;
    }

    async function rollbackClaim(device: Record<string, unknown>, existing: Record<string, unknown> | null, preparation: BrokerAndroidPreparation<Effect> | undefined): Promise<BrokerAndroidRollback> {
        if (!preparation || preparation.kind !== "ready") return { attempted: false, ok: true, reason: "no-provider-resource-created" };
        if (existing?.avdName === device.avdName) return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
        const ownerId = brokerAndroidField(device, "ownerId");
        if (!ownerId) return { attempted: false, ok: false, reason: "created-avd-owner-id-missing" };
        const name = brokerAndroidField(device, "avdName");
        if (!name || !ports.ownedAvdName(name, ownerId)) return { attempted: false, ok: false, reason: "created-avd-identity-unverified" };
        const live = await ports.liveAvds();
        if (!live.ok || live.names.has(name)) return { attempted: false, ok: false, reason: live.ok && live.names.has(name) ? "created-avd-active" : "created-avd-liveness-unverified" };
        const processes = await ports.avdProcesses(name);
        if (!processes.ok || processes.active) return { attempted: false, ok: false, reason: processes.ok && processes.active ? "created-avd-active" : "created-avd-liveness-unverified" };
        const root = ports.approvedAvdRoot(brokerAndroidField(device, "avdRoot"));
        if (!root) return { attempted: false, ok: false, reason: "created-avd-root-unavailable" };
        try {
            const cleanup = await ports.removeAvdArtifacts(name, ownerId, root, () => inactive(name));
            return { attempted: true, ok: true, artifactsRemoved: cleanup.removed };
        } catch { return { attempted: true, ok: false, reason: "android-avd-artifact-cleanup-failed" }; }
    }

    async function create(input: BrokerAndroidLifecycleInput<Effect>): Promise<BrokerAndroidLifecycleOutcome<Effect, Receipt>> {
        const {ownerId, parsed, plan, createAvdRoot} = input;
        const preparation = plan?.preparation;
        if (preparation?.kind === "unavailable") return {kind: "refused", reason: "invalid", error: preparation.error, missing: preparation.missing, plan: plan || null};
        if (parsed.create?.createAvd === true) {
            const name = brokerAndroidField(plan?.device, "avdName");
            if (!name || !createAvdRoot || !ports.ownedAvdName(name, ownerId)) return refusal(input, "conflict", "android-avd-create-identity-unavailable");
            try {
                if ((await ports.avdArtifacts(ownerId, createAvdRoot)).some(artifact => artifact.name === name)) return refusal(input, "conflict", "android-avd-artifacts-already-exist");
            } catch { return refusal(input, "conflict", "android-avd-storage-preflight-failed"); }
        }
        let execution = await ports.metadataObservation("create", {timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
        if (preparation?.kind === "ready") {
            execution = await ports.executePrepared(preparation.effect, {timeoutMs: parsed.create?.createAvd === true ? 300000 : ports.commandTimeoutMs, outputLimit: ports.outputLimit});
            if (!brokerAndroidCommandSucceeded(execution)) {
                let rollback: BrokerAndroidRollback | null = null;
                if (parsed.create?.createAvd === true) {
                    const name = brokerAndroidField(plan?.device, "avdName");
                    if (name && createAvdRoot && ports.ownedAvdName(name, ownerId)) {
                        try { rollback = {ok: true, artifactsRemoved: (await ports.removeAvdArtifacts(name, ownerId, createAvdRoot, () => inactive(name))).removed}; }
                        catch { rollback = {ok: false, error: "android-avd-artifact-cleanup-failed"}; }
                    } else { rollback = {ok: false, error: "android-avd-create-identity-unavailable"}; }
                }
                return {kind: "provider-failed", error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed",
                    ...(rollback ? {rollback} : {}), plan: plan || null, invoked: true, mutatesHost: false, execution};
            }
        }
        const persistedParsed = plan?.create && typeof plan.create === "object" ? {...parsed, create: plan.create as Record<string, unknown>} : parsed;
        const device = createBrokerAndroidRecord(ownerId, persistedParsed, ports);
        if (parsed.create?.createAvd === true) {
            if (!createAvdRoot) return refusal(input, "provider-failed", "android-avd-root-unavailable");
            device.avdRoot = createAvdRoot;
        }
        let claim;
        try { claim = ports.claimDefinition(ownerId, persistedParsed, device); }
        catch (error) {
            const rollback = await rollbackClaim(device, null, preparation);
            if (!rollback.ok) return refusal(input, "provider-failed", "owner-device-state-rollback-failed", {stateError: ports.stateErrorCode(error) || "owner-state-write-failed", rollback});
            return {kind: "state-exception", cause: error, rollback, backend: parsed.backend, stateKey: parsed.stateKey};
        }
        if (!claim.ok) {
            const rollback = await rollbackClaim(device, claim.existing, preparation);
            return refusal(input, rollback.ok ? "conflict" : "provider-failed", rollback.ok ? claim.error : "owner-device-conflict-rollback-failed", {field: claim.field, value: claim.value, existing: claim.existing, rollback});
        }
        return {kind: "created", plan: plan || null, device, invoked: true, mutatesHost: true, execution};
    }

    async function confirmStop(device: unknown): Promise<string | null> {
        const serial = brokerAndroidSerial(device);
        const name = brokerAndroidField(device, "avdName");
        const preparation = ports.prepareStopInventory();
        if (!serial || !name || !/^[A-Za-z0-9._-]+$/.test(name) || preparation.kind === "unavailable") return "identity-unavailable";
        const deadline = ports.now() + 30000;
        while (ports.now() < deadline) {
            let serialPresent: boolean;
            try {
                const remaining = deadline - ports.now();
                if (remaining <= 0) break;
                const inventory = await ports.observeStopInventory(preparation.effect, serial, { timeoutMs: Math.min(10000, remaining), outputLimit: ports.outputLimit });
                if (!inventory.ok || !inventory.available) return "inventory-unavailable";
                serialPresent = inventory.serialPresent;
            } catch { return "inventory-unavailable"; }
            const remaining = deadline - ports.now();
            if (remaining <= 0) break;
            try {
                const processes = await ports.avdProcesses(name, Math.min(10000, remaining), true);
                if (!processes.ok) return "process-inventory-unavailable";
                if (ports.now() >= deadline) break;
                if (!serialPresent && !processes.active) return null;
            } catch { return "process-inventory-unavailable"; }
            await ports.sleep(Math.min(250, Math.max(0, deadline - ports.now())));
        }
        return "deadline-exceeded";
    }

    async function confirmBoot(parsed: BrokerAndroidLifecycleRequest, device: unknown): Promise<BrokerAndroidBoot<Receipt>> {
        if (parsed.waitForBoot !== true) return {ok: true, ready: false, skipped: true};
        const serial = brokerAndroidSerial(device);
        const preparation = ports.prepareBootProbe(serial);
        if (preparation.kind === "unavailable") return {ok: false, ready: false, reason: "probe-unavailable", error: preparation.observation};
        const timeout = Number.isFinite(parsed.bootTimeoutMs) ? Math.min(600000, Math.max(1000, Number(parsed.bootTimeoutMs))) : 60000;
        const deadline = ports.now() + timeout;
        const attempts: BrokerAndroidProviderResult<Receipt>[] = [];
        while (ports.now() < deadline) {
            const result = await ports.observeBootProbe(preparation.effect, {timeoutMs: Math.min(ports.commandTimeoutMs, Math.max(1000, deadline - ports.now())), outputLimit: ports.outputLimit});
            attempts.push(result);
            if (result.ok && result.ready) return {ok: true, ready: true, result, attempts: attempts.slice(-4)};
            await ports.sleep(Math.min(1000, Math.max(0, deadline - ports.now())));
        }
        return {ok: false, ready: false, reason: "deadline-exceeded", serial, last: attempts.at(-1), attempts: attempts.slice(-8)};
    }

    async function invoke(input: BrokerAndroidLifecycleInput<Effect>): Promise<BrokerAndroidLifecycleOutcome<Effect, Receipt>> {
        const {ownerId, parsed, plan} = input;
        let expectedDevice = input.expectedDevice;
        const preparation = plan?.preparation;
        if (!preparation || preparation.kind === "unavailable") return {
            kind: "refused", reason: "invalid", error: preparation?.error || "missing-provider-command",
            missing: preparation?.missing || [], plan: plan || null,
        };
        if (parsed.command === "device_start") {
            const port = brokerAndroidNumber(plan?.device, "port");
            if (ports.validPort(port)) {
                const live = await ports.livePorts();
                if (!live.ok) return refusal(input, live.reason, live.error, {detail: live.detail});
                if (port !== null && live.ports.has(port)) return refusal(input, "conflict", "android-emulator-port-conflict", {detail: `port-${port}-already-in-use`});
            }
        }
        const deletingArtifacts = parsed.command === "device_delete" && parsed.deleteAvd !== false;
        if (deletingArtifacts) {
            const name = brokerAndroidField(plan?.device, "avdName");
            const root = ports.approvedAvdRoot(brokerAndroidField(plan?.device, "avdRoot"));
            if (!root || !name || !ports.ownedAvdName(name, ownerId)) return refusal(input, "conflict", !root ? "android-avd-root-unavailable" : "android-avd-identity-unavailable");
            const live = await ports.liveAvds();
            if (!live.ok) return refusal(input, live.reason, "android-avd-liveness-unverified", {detail: live.detail});
            if (live.names.has(name)) return refusal(input, "conflict", "android-avd-active");
            const processes = await ports.avdProcesses(name);
            if (!processes.ok) return refusal(input, processes.reason, "android-avd-liveness-unverified", {detail: processes.detail});
            if (processes.active) return refusal(input, "conflict", "android-avd-active");
        }
        const auxiliary = parsed.command === "device_stop" || parsed.command === "device_delete" ? await ports.cleanupAuxiliary(ownerId, parsed, expectedDevice) : null;
        if (auxiliary?.committed) expectedDevice = structuredClone(auxiliary.device);
        if (auxiliary?.result.ok === false) return {
            kind: "auxiliary-failed", error: "auxiliary-runtime-cleanup-failed", plan: plan || null,
            device: auxiliary.device, auxiliaryCleanup: auxiliary.result, invoked: false,
            mutatesHost: auxiliary.result.changed === true || auxiliary.result.appium.cleared === true || auxiliary.result.recording.cleared === true || auxiliary.result.minimizeWatchdog.cleared === true,
        };
        const execution = deletingArtifacts || preparation.kind === "metadata-only"
            ? await ports.metadataObservation(deletingArtifacts ? "delete-artifacts" : "delete-metadata", {timeoutMs: deletingArtifacts ? 120000 : ports.commandTimeoutMs, outputLimit: ports.outputLimit})
            : await ports.executePrepared(preparation.effect, {timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
        let success = brokerAndroidCommandSucceeded(execution);
        if (success && parsed.command === "device_stop") {
            const stopFailure = await confirmStop(plan?.device);
            if (stopFailure) return {
                kind: "stop-unconfirmed", error: "android-emulator-stop-unconfirmed", ownerId, backend: parsed.backend, deviceId: parsed.deviceId,
                detail: stopFailure, plan: plan || null, device: plan?.device, invoked: true, mutatesHost: true, execution,
            };
        }
        if (deletingArtifacts) {
            const name = brokerAndroidField(plan?.device, "avdName");
            const root = ports.approvedAvdRoot(brokerAndroidField(plan?.device, "avdRoot"));
            try {
                if (!name || !root) throw new Error("missing-provider-metadata");
                await ports.removeAvdArtifacts(name, ownerId, root, () => inactive(name));
                success = true;
            } catch { return refusal(input, "provider-failed", "android-avd-artifact-cleanup-failed"); }
        }
        let boot: BrokerAndroidBoot<Receipt> | null = null;
        if (success && parsed.command === "device_start") {boot = await confirmBoot(parsed, plan?.device); if (!boot.ok) success = false;}
        const publication = success ? ports.transition(ownerId, parsed, expectedDevice, candidate => parsed.command === "device_delete" ? null : {...brokerAndroidReplacement(candidate, parsed, boot), updatedAt: ports.timestamp()}) : null;
        const observed = {
            plan: plan || null, device: success ? publication?.device : plan?.device,
            ...(boot ? {boot} : {}), ...(auxiliary ? {auxiliaryCleanup: auxiliary.result} : {}),
            invoked: true as const, mutatesHost: success, execution,
        };
        if (publication && !publication.matched) return {
            kind: "publication-conflict", error: "owner-device-state-conflict", ownerId, backend: parsed.backend, deviceId: parsed.deviceId, found: publication.found, ...observed,
        };
        if (!success) return {kind: "provider-failed", error: "provider-command-failed", ...observed, mutatesHost: false};
        return {kind: "completed", ...observed};
    }

    function start(input: BrokerAndroidLifecycleInput<Effect>) {return invoke(input);}
    function stop(input: BrokerAndroidLifecycleInput<Effect>) {return invoke(input);}
    function deleteDevice(input: BrokerAndroidLifecycleInput<Effect>) {return invoke(input);}
    return {create, start, stop, delete: deleteDevice};
}
