import {brokerIosRecord, brokerIosCommandSucceeded, brokerIosCreateCommand} from "../../domain/lifecycle/ios-simulator-lifecycle.js";
import type {BrokerIosLifecycleRequest, BrokerIosLifecycleInput, BrokerIosLifecycleResponse, BrokerIosProviderResult, BrokerIosPlannedCommand, BrokerIosRollback, BrokerIosShutdownSettlement, BrokerIosShutdownState } from "../../domain/lifecycle/ios-simulator-lifecycle.js";
import type {BrokerIosSimulatorLifecyclePorts} from "../../ports/lifecycle/ios-simulator-lifecycle.js";

export async function rollbackBrokerIosCreate<Effect>(ports: BrokerIosSimulatorLifecyclePorts<Effect>, device: Record<string,unknown>, existing: Record<string,unknown> | null, command: BrokerIosPlannedCommand<Effect> | null | undefined): Promise<BrokerIosRollback> {
    if (!command || command.kind !== "ready") return {attempted: false, ok: true, reason: "no-provider-resource-created"};
    if (existing?.udid === device.udid) return {attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device"};
    const target = typeof device.udid === "string" ? device.udid : "";
    if (!target) return {attempted: false, ok: false, reason: "created-simulator-udid-missing"};
    if (!command.canCompensate) return {attempted: false, ok: false, reason: "created-simulator-provider-command-missing"};
    const result = ports.execute(ports.prepareDelete(command.effect,target),{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
    return {attempted: true, ok: brokerIosCommandSucceeded(result), result};
}
export function createBrokerIosRecord(ownerId: string, parsed: BrokerIosLifecycleRequest, ports: {timestamp: () => string}): Record<string,unknown> {
    return brokerIosRecord(ownerId,parsed,parsed.create || {},ports.timestamp());
}
export function planBrokerIosCreateCommand<Effect>(ownerId: string, parsed: BrokerIosLifecycleRequest, ports: Pick<BrokerIosSimulatorLifecyclePorts<Effect>, "prepareCreate">, create = parsed.create || {}): BrokerIosPlannedCommand<Effect> {
    if (create.createSimulator === true) return ports.prepareCreate(brokerIosCreateCommand(ownerId,parsed,create));
    return {kind: "metadata-only"};
}
export function planBrokerIosExistingCommand<Effect>(ownerId: string, parsed: BrokerIosLifecycleRequest, device: unknown, ports: Pick<BrokerIosSimulatorLifecyclePorts<Effect>, "verifyOwnedTarget" | "prepareExisting">): BrokerIosPlannedCommand<Effect> {
    const owned = ports.verifyOwnedTarget(ownerId,device);
    if (!owned.ok) return {kind: "unavailable", error: owned.error, missing: owned.missing};
    return ports.prepareExisting({parsed, target: owned.target});
}

export function createBrokerIosSimulatorLifecycle<Effect>(ports: BrokerIosSimulatorLifecyclePorts<Effect>) {
    const createRecord = (ownerId: string, parsed: BrokerIosLifecycleRequest) => createBrokerIosRecord(ownerId,parsed,ports);
    const planCreate = (ownerId: string, parsed: BrokerIosLifecycleRequest, create = parsed.create || {}) => planBrokerIosCreateCommand(ownerId,parsed,ports,create);
    const planExisting = (ownerId: string, parsed: BrokerIosLifecycleRequest, device: unknown) => planBrokerIosExistingCommand(ownerId,parsed,device,ports);
    async function create(input: BrokerIosLifecycleInput<Effect>): Promise<BrokerIosLifecycleResponse<Effect>> {
        const {ownerId,parsed,plan} = input;
        const command = plan?.providerCommand;
        if (command?.kind === "unavailable") return {kind: "refused", error: command.error, missing: command.missing || [], plan: plan || null};
        let execution: BrokerIosProviderResult = {ok: true, mode: "noop", provider: "host-broker-state", receipt: null};
        let createdUdid: string | null = null;
        if (command?.kind === "ready") {
            const result = ports.executeCreate(command.effect,{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
            execution = result;
            if (!brokerIosCommandSucceeded(execution)) return {kind: "provider-failed", error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed", plan, execution};
            createdUdid = result.createdUdid;
        }
        let persistedParsed = parsed;
        if (parsed.create?.createSimulator === true && execution.mode !== "noop") {
            const udid = createdUdid;
            if (!udid) return {kind: "provider-failed", error: "ios-simulator-create-invalid-udid", plan, execution};
            persistedParsed = {...parsed, create: {...(parsed.create || {}),udid}};
        }
        const device = createRecord(ownerId,persistedParsed);
        let claim;
        try {claim = ports.claimDefinition(ownerId,persistedParsed,device);}
        catch (cause) {
            const rollback = await rollbackBrokerIosCreate(ports,device,null,command);
            if (!rollback.ok) return {kind: "rollback-failed", error: "owner-device-state-rollback-failed", stateError: ports.stateErrorCode(cause) || "owner-state-write-failed", rollback};
            return {kind: "state-failed", cause, rollback};
        }
        if (!claim.ok) {
            const rollback = await rollbackBrokerIosCreate(ports,device,claim.existing,command);
            return {kind: "claim-conflict", error: rollback.ok ? claim.error : "owner-device-conflict-rollback-failed", field: claim.field, value: claim.value, existing: claim.existing, rollback};
        }
        return {kind: "completed", plan, device, execution, success: true};
    }
    async function existing(input: BrokerIosLifecycleInput<Effect>): Promise<BrokerIosLifecycleResponse<Effect>> {
        const {ownerId,parsed,plan} = input;
        let expected = input.expectedDevice;
        const command = plan?.providerCommand;
        if (!command || command.kind === "unavailable") return {kind: "refused", error: command?.error || "missing-provider-command", missing: command?.missing || [], plan: plan || null};
        const auxiliary = parsed.command === "device_stop" || parsed.command === "device_delete" ? ports.cleanupAuxiliary(ownerId,parsed,expected) : null;
        if (auxiliary?.committed) expected = structuredClone(auxiliary.device);
        if (auxiliary?.result.ok === false) return {kind: "auxiliary-failed", plan, device: auxiliary.device, auxiliary: auxiliary.result};
        const stopping = parsed.command === "device_stop" && command.kind === "ready";
        const deadline = stopping ? ports.now() + ports.commandTimeoutMs : Infinity;
        const remainingMs = () => Math.max(0, deadline - ports.now());
        const commandAllowance = stopping ? Math.floor(remainingMs()) : ports.commandTimeoutMs;
        if (stopping && !(commandAllowance >= 1)) return {kind: "operation-failed", plan, device: expected,
            execution: {ok: false, mode: "exec", provider: command.provider, receipt: null}, success: false,
            shutdown: {ok: false, reason: "timed-out", attempts: 0, lastState: null}, invoked: false,
            mutatesHost: Boolean(auxiliary && (auxiliary.result.changed || auxiliary.result.appium.cleared === true || auxiliary.result.recording.cleared === true || auxiliary.result.minimizeWatchdog.cleared === true)), recoveryRequired: false,
            ...(auxiliary ? {auxiliary: auxiliary.result} : {})};
        const execution: BrokerIosProviderResult = command.kind === "metadata-only"
            ? {ok: true, mode: "noop", provider: "host-broker-state", receipt: null}
            : ports.execute(command.effect,{timeoutMs: commandAllowance, outputLimit: ports.outputLimit});
        let success = brokerIosCommandSucceeded(execution);
        let shutdown: BrokerIosShutdownSettlement | undefined;
        let retryExecution: BrokerIosProviderResult | undefined;
        if (success && stopping) {
            let attempts = 0;
            let commandAttempts: 1 | 2 = 1;
            let lastState: BrokerIosShutdownState = null;
            shutdown = {ok: false, reason: "timed-out", attempts, lastState};
            while (true) {
                const timeoutMs = Math.floor(remainingMs());
                if (!(timeoutMs >= 1)) break;
                let observation;
                try { observation = ports.observeShutdown(command.effect, ownerId, expected, {timeoutMs, outputLimit: ports.outputLimit}); }
                catch { shutdown = {ok: false, reason: "observation-failed", attempts: attempts + 1, lastState}; break; }
                attempts++;
                const recognized = observation.ok && ["Shutdown", "Booted", "Shutting Down"].includes(observation.state || "");
                if (recognized) lastState = observation.state;
                if (!(Math.floor(remainingMs()) >= 1)) { shutdown = {ok: false, reason: "timed-out", attempts, lastState}; break; }
                if (!recognized) {
                    shutdown = {ok: false, reason: "observation-failed", attempts, lastState}; break;
                }
                if (observation.state === "Shutdown") { shutdown = {ok: true, attempts, lastState: "Shutdown"}; break; }
                if (observation.state === "Booted" && commandAttempts === 1) {
                    const retry = ports.executeShutdownIfCurrent(ownerId, parsed, expected, command.effect, {remainingMs, outputLimit: ports.outputLimit});
                    if (retry.kind === "state-conflict") return {kind: "state-conflict", plan, device: retry.device, execution, success: false,
                        publication: {found: retry.found, matched: false, device: retry.device},
                        shutdown: {ok: false, reason: "observation-failed", attempts, lastState, commandAttempts}, mutatesHost: true, recoveryRequired: true,
                        ...(auxiliary ? {auxiliary: auxiliary.result} : {})};
                    if (retry.kind === "timed-out") { shutdown = {ok: false, reason: "timed-out", attempts, lastState}; break; }
                    retryExecution = retry.execution;
                    commandAttempts = 2;
                }
                const pauseMs = Math.min(100, Math.floor(remainingMs()));
                shutdown = {ok: false, reason: "timed-out", attempts, lastState};
                if (!(pauseMs >= 1)) break;
                await ports.sleep(pauseMs);
            }
            shutdown = {...shutdown, commandAttempts};
            success = shutdown.ok;
        }

        if (shutdown?.ok && !(Math.floor(remainingMs()) >= 1)) { shutdown = {...shutdown, ok: false, reason: "timed-out"}; success = false; }
        const publication = success ? ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind: parsed.command === "device_start" ? "start" : parsed.command === "device_stop" ? "stop" : "delete" }, stopping ? {remainingMs} : undefined) : undefined;
        if (shutdown?.ok && publication?.deadlineExpired) { shutdown = {...shutdown, ok: false, reason: "timed-out"}; success = false; }
        const device = success ? publication?.device : shutdown ? expected : plan?.device;
        return {kind: publication && !publication.matched ? "state-conflict" : success ? "completed" : "operation-failed", plan, device, execution, success, publication, ...(retryExecution ? {retryExecution} : {}), ...(auxiliary ? {auxiliary: auxiliary.result} : {}), ...(shutdown ? {shutdown, mutatesHost: true, recoveryRequired: !shutdown.ok} : {}) };
    }
    return {create, start: existing, stop: existing, delete: existing, createRecord, planCreate, planExisting};
}
