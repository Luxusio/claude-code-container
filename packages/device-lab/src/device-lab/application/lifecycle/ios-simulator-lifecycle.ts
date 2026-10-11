import {brokerIosRecord, brokerIosCommandSucceeded, brokerIosCreateCommand} from "../../domain/lifecycle/ios-simulator-lifecycle.js";
import type {BrokerIosLifecycleRequest, BrokerIosLifecycleInput, BrokerIosLifecycleResponse, BrokerIosProviderResult, BrokerIosPlannedCommand, BrokerIosRollback } from "../../domain/lifecycle/ios-simulator-lifecycle.js";
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
        let execution: BrokerIosProviderResult = {mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "", receipt: null};
        if (command?.kind === "ready") {
            execution = ports.execute(command.effect,{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
            if (!brokerIosCommandSucceeded(execution)) return {kind: "provider-failed", error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed", plan, execution};
        }
        let persistedParsed = parsed;
        if (parsed.create?.createSimulator === true && execution.mode !== "noop") {
            const udid = ports.createdUdid(execution.stdout);
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
        const execution: BrokerIosProviderResult = command.kind === "metadata-only"
            ? {mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "", receipt: null}
            : ports.execute(command.effect,{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
        let success = brokerIosCommandSucceeded(execution) ;

        const publication = success ? ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind: parsed.command === "device_start" ? "start" : parsed.command === "device_stop" ? "stop" : "delete" }) : undefined;
        const device = success ? publication?.device : plan?.device;
        return {kind: publication && !publication.matched ? "state-conflict" : success ? "completed" : "operation-failed", plan, device, execution, success, publication, ...(auxiliary ? {auxiliary: auxiliary.result} : {}) };
    }
    return {create, start: existing, stop: existing, delete: existing, createRecord, planCreate, planExisting};
}
