import {brokerMacosRecord, brokerMacosCommandSucceeded, brokerMacosField, brokerMacosInstance, brokerMacosToleratesMissingDelete} from "../../domain/lifecycle/macos-vm-lifecycle.js";
import type {BrokerMacosLifecycleRequest, BrokerMacosLifecycleInput, BrokerMacosLifecycleResponse, BrokerMacosProviderResult, BrokerMacosIpObservation, BrokerMacosPlannedCommand, BrokerMacosRollback , BrokerMacosBoot} from "../../domain/lifecycle/macos-vm-lifecycle.js";
import type {BrokerMacosVmLifecyclePorts} from "../../ports/lifecycle/macos-vm-lifecycle.js";

export async function rollbackBrokerMacosCreate<Effect>(ports: BrokerMacosVmLifecyclePorts<Effect>, device: Record<string,unknown>, existing: Record<string,unknown> | null, command: BrokerMacosPlannedCommand<Effect> | null | undefined): Promise<BrokerMacosRollback> {
    if (!command || command.kind !== "ready") return {attempted: false, ok: true, reason: "no-provider-resource-created"};
    if (existing?.provider === device.provider && existing?.providerInstance === device.providerInstance) return {attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device"};
    const target = String(device.providerInstance);
    const result = ports.execute(ports.prepareDelete(command.effect,target),{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
    return {attempted: true, ok: brokerMacosCommandSucceeded(result), result};
}
export function createBrokerMacosRecord(ownerId: string, parsed: BrokerMacosLifecycleRequest, ports: {timestamp: () => string}): Record<string,unknown> {
    return brokerMacosRecord(ownerId,parsed,parsed.create || {},ports.timestamp());
}
export function planBrokerMacosCreateCommand<Effect>(ownerId: string, parsed: BrokerMacosLifecycleRequest, ports: Pick<BrokerMacosVmLifecyclePorts<Effect>, "prepareCreate">, create = parsed.create || {}): BrokerMacosPlannedCommand<Effect> {
    const provider = create.provider === "auto" || !create.provider ? "tart" : String(create.provider);
    if (!["tart","vz","utmctl"].includes(provider)) return {kind: "unavailable", error: "unsupported-provider-command", missing: ["provider"]};
    if (provider !== "tart") return {kind: "metadata-only", purpose: "definition-only"};
    const image = typeof create.image === "string" && create.image ? create.image : null;
    if (!image) return {kind: "metadata-only", purpose: "image-unset"};
    return ports.prepareCreate({provider, image, instance: brokerMacosInstance(ownerId,parsed,create)});
}
export function planBrokerMacosExistingCommand<Effect>(_ownerId: string, parsed: BrokerMacosLifecycleRequest, device: unknown, ports: Pick<BrokerMacosVmLifecyclePorts<Effect>, "prepareExisting">): BrokerMacosPlannedCommand<Effect> {
    const provider = brokerMacosField(device,"provider") === "auto" || !brokerMacosField(device,"provider") ? "tart" : brokerMacosField(device,"provider") || "tart";
    if (!["tart","vz","utmctl"].includes(provider)) return {kind: "unavailable", error: "unsupported-provider-command", missing: ["provider"]};
    const instance = brokerMacosField(device,"providerInstance");
    if (parsed.command === "device_delete" && !instance && !(parsed.stateKey !== "android-device" && parsed.stateKey !== "ios-device" && ["running","booted","started","starting"].includes(String((device as {status?: unknown})?.status || "").toLowerCase()))) {
        return {kind: "metadata-only", purpose: "stopped-definition-delete"};
    }
    if (!instance) return {kind: "unavailable", error: "missing-provider-metadata", missing: ["providerInstance"]};
    const headless = parsed.command === "device_start" && provider === "tart"
        ? (typeof parsed.headless === "boolean" ? parsed.headless : Boolean(device && typeof device === "object" && (device as Record<string,unknown>).headless === true))
        : false;
    return ports.prepareExisting({parsed, provider, instance, headless});
}
export function waitForBrokerMacosBoot<Effect>(parsed: BrokerMacosLifecycleRequest, device: unknown, command: BrokerMacosPlannedCommand<Effect>, ports: BrokerMacosVmLifecyclePorts<Effect>): BrokerMacosBoot {
    if (parsed.backend !== "macos-vm" || parsed.command !== "device_start" || parsed.waitForBoot !== true) return {ok: true, ready: false, skipped: true};
    if (command.kind !== "ready" || command.provider !== "tart" || !command.bootEligible) return {ok: true, ready: false, skipped: true};
    const instance = brokerMacosField(device,"providerInstance");
    if (!instance) return {ok: false, reason: "missing-target", instance: null};
    const timeout = Number.isFinite(parsed.bootTimeoutMs) ? Math.min(600000,Math.max(1000,Number(parsed.bootTimeoutMs))) : 300000;
    const deadline = ports.now() + timeout;
    const attempts: BrokerMacosIpObservation[] = [];
    while (ports.now() < deadline) {
        for (const resolver of ["default","arp"] as const) {
            const result = ports.observeIp(command.effect,instance,resolver,{timeoutMs: Math.min(ports.commandTimeoutMs,Math.max(1000,deadline - ports.now())),outputLimit: ports.outputLimit});
            attempts.push(result);
            const address = result.address;
            if (brokerMacosCommandSucceeded(result) && address) return {ok: true, ready: true, sshHost: address, result, attempts: attempts.slice(-4)};
        }
        ports.sleep(Math.min(5000,Math.max(0,deadline - ports.now())));
    }
    return {ok: false, reason: "timed-out", instance, last: attempts.at(-1), attempts: attempts.slice(-8)};
}

export function createBrokerMacosVmLifecycle<Effect>(ports: BrokerMacosVmLifecyclePorts<Effect>) {
    const createRecord = (ownerId: string, parsed: BrokerMacosLifecycleRequest) => createBrokerMacosRecord(ownerId,parsed,ports);
    const planCreate = (ownerId: string, parsed: BrokerMacosLifecycleRequest, create = parsed.create || {}) => planBrokerMacosCreateCommand(ownerId,parsed,ports,create);
    const planExisting = (ownerId: string, parsed: BrokerMacosLifecycleRequest, device: unknown) => planBrokerMacosExistingCommand(ownerId,parsed,device,ports);
    async function create(input: BrokerMacosLifecycleInput<Effect>): Promise<BrokerMacosLifecycleResponse<Effect>> {
        const {ownerId,parsed,plan} = input;
        const command = plan?.providerCommand;
        if (command?.kind === "unavailable") return {kind: "refused", error: command.error, missing: command.missing || [], plan: plan || null};
        let execution: BrokerMacosProviderResult = {ok: true, mode: "noop", provider: "host-broker-state", resourceMissing: false, receipt: null};
        if (command?.kind === "ready") {
            execution = ports.execute(command.effect,{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
            if (!brokerMacosCommandSucceeded(execution)) return {kind: "provider-failed", error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed", plan, execution};
        }
        let persistedParsed = parsed;

        const device = createRecord(ownerId,persistedParsed);
        let claim;
        try {claim = ports.claimDefinition(ownerId,persistedParsed,device);}
        catch (cause) {
            const rollback = await rollbackBrokerMacosCreate(ports,device,null,command);
            if (!rollback.ok) return {kind: "rollback-failed", error: "owner-device-state-rollback-failed", stateError: ports.stateErrorCode(cause) || "owner-state-write-failed", rollback};
            return {kind: "state-failed", cause, rollback};
        }
        if (!claim.ok) {
            const rollback = await rollbackBrokerMacosCreate(ports,device,claim.existing,command);
            return {kind: "claim-conflict", error: rollback.ok ? claim.error : "owner-device-conflict-rollback-failed", field: claim.field, value: claim.value, existing: claim.existing, rollback};
        }
        return {kind: "completed", plan, device, execution, success: true};
    }
    async function existing(input: BrokerMacosLifecycleInput<Effect>): Promise<BrokerMacosLifecycleResponse<Effect>> {
        const {ownerId,parsed,plan} = input;
        let expected = input.expectedDevice;
        const command = plan?.providerCommand;
        if (!command || command.kind === "unavailable") return {kind: "refused", error: command?.error || "missing-provider-command", missing: command?.missing || [], plan: plan || null};
        const auxiliary = parsed.command === "device_stop" || parsed.command === "device_delete" ? ports.cleanupAuxiliary(ownerId,parsed,expected) : null;
        if (auxiliary?.committed) expected = structuredClone(auxiliary.device);
        if (auxiliary?.result.ok === false) return {kind: "auxiliary-failed", plan, device: auxiliary.device, auxiliary: auxiliary.result};
        const execution: BrokerMacosProviderResult = command.kind === "metadata-only"
            ? ports.executeMetadata(command.purpose,{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit})
            : ports.execute(command.effect,{timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit});
        let success = brokerMacosCommandSucceeded(execution) || brokerMacosToleratesMissingDelete(parsed,execution);
        let boot: BrokerMacosBoot | null = null;
        if (success && parsed.command === "device_start") {boot = waitForBrokerMacosBoot(parsed,plan?.device,command,ports); if (!boot.ok) success = false;}
        const publication = success ? ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind: parsed.command === "device_start" ? "start" : parsed.command === "device_stop" ? "stop" : "delete" , boot}) : undefined;
        const device = success ? publication?.device : plan?.device;
        return {kind: publication && !publication.matched ? "state-conflict" : success ? "completed" : "operation-failed", plan, device, execution, success, publication, ...(auxiliary ? {auxiliary: auxiliary.result} : {}) , boot};
    }
    return {create, start: existing, stop: existing, delete: existing, createRecord, planCreate, planExisting};
}
