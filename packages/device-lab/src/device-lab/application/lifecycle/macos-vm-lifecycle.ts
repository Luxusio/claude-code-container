import {brokerMacosRecord, brokerMacosCommandSucceeded, brokerMacosField, brokerMacosInstance, brokerMacosToleratesMissingDelete, isBrokerMacosTartImageCreate} from "../../domain/lifecycle/macos-vm-lifecycle.js";
import type {BrokerMacosLifecycleRequest, BrokerMacosLifecycleInput, BrokerMacosLifecycleResponse, BrokerMacosProviderResult, BrokerMacosIpObservation, BrokerMacosPlannedCommand, BrokerMacosRollback , BrokerMacosBoot, BrokerMacosPublication, BrokerMacosHelperPreparation} from "../../domain/lifecycle/macos-vm-lifecycle.js";
import type {BrokerMacosVmLifecyclePorts} from "../../ports/lifecycle/macos-vm-lifecycle.js";

export async function rollbackBrokerMacosCreate<Effect>(ports: BrokerMacosVmLifecyclePorts<Effect>, device: Record<string,unknown>, existing: Record<string,unknown> | null, command: BrokerMacosPlannedCommand<Effect> | null | undefined): Promise<BrokerMacosRollback> {
    if (!command || command.kind !== "ready") return {attempted: false, ok: true, reason: "no-provider-resource-created"};
    if (existing?.provider === device.provider && existing?.providerInstance === device.providerInstance) return {attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device"};
    const remaining = ports.remainingMs ? ports.remainingMs() : Infinity;
    if (!(remaining >= 1)) return {attempted: false, ok: false, reason: "macos-tart-create-budget-exhausted"};
    const target = String(device.providerInstance);
    const result = await ports.execute(ports.prepareDelete(command.effect,target),{timeoutMs: Math.min(ports.commandTimeoutMs, remaining), outputLimit: ports.outputLimit, ...(ports.remainingMs ? {remainingMs: ports.remainingMs} : {})});
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
function providerObservation(value: unknown): value is BrokerMacosProviderResult {
    if (!value || typeof value !== "object") return false;
    const result = value as Partial<BrokerMacosProviderResult>;
    return typeof result.ok === "boolean" && typeof result.mode === "string" && typeof result.provider === "string" && typeof result.resourceMissing === "boolean";
}
function pendingStart(device: unknown): boolean {
    if (!device || typeof device !== "object") return false;
    const record = device as {status?: unknown; lifecycle?: {operation?: unknown} | null};
    return String(record.status || "").toLowerCase() === "starting" || record.lifecycle?.operation === "start";
}
export async function waitForBrokerMacosBoot<Effect>(parsed: BrokerMacosLifecycleRequest, device: unknown, command: BrokerMacosPlannedCommand<Effect>, ports: BrokerMacosVmLifecyclePorts<Effect>): Promise<BrokerMacosBoot> {
    if (parsed.backend !== "macos-vm" || parsed.command !== "device_start" || parsed.waitForBoot !== true) return {ok: true, ready: false, skipped: true};
    if (command.kind !== "ready" || command.provider !== "tart" || !command.bootEligible) return {ok: true, ready: false, skipped: true};
    const instance = brokerMacosField(device,"providerInstance");
    if (!instance) return {ok: false, reason: "missing-target", instance: null};
    const timeout = Number.isFinite(parsed.bootTimeoutMs) ? Math.min(600000,Math.max(1000,Number(parsed.bootTimeoutMs))) : 300000;
    const deadline = ports.now() + Math.min(timeout, ports.remainingMs ? ports.remainingMs() : Infinity);
    const remainingMs = () => Math.min(deadline - ports.now(), ports.remainingMs ? ports.remainingMs() : Infinity);
    const attempts: BrokerMacosIpObservation[] = [];
    while (remainingMs() > 0) {
        for (const resolver of ["default","arp"] as const) {
            const remaining = remainingMs();
            if (remaining <= 0) break;
            const result = await ports.observeIp(command.effect,instance,resolver,{timeoutMs: Math.min(ports.commandTimeoutMs,remaining),outputLimit: ports.outputLimit});
            if (!providerObservation(result) || !(result.address === null || typeof result.address === "string")) throw new Error("invalid-macos-ip-observation");
            attempts.push(result);
            if (!(remainingMs() > 0)) break;
            const address = result.address;
            if (brokerMacosCommandSucceeded(result) && address) return {ok: true, ready: true, sshHost: address, result, attempts: attempts.slice(-4)};
        }
        const remaining = remainingMs();
        if (remaining <= 0) break;
        await ports.sleep(Math.min(5000,remaining));
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
            const provisioned = isBrokerMacosTartImageCreate({...parsed, ...parsed.create});
            const remaining = provisioned && ports.remainingMs ? ports.remainingMs() : Infinity;
            if (!(remaining >= 1)) return {kind: "refused", error: "macos-tart-create-budget-exhausted", missing: [], plan: plan || null};
            const timeoutMs = Math.min(provisioned ? ports.createTimeoutMs ?? ports.commandTimeoutMs : ports.commandTimeoutMs, remaining);
            execution = await ports.execute(command.effect,{timeoutMs, outputLimit: ports.outputLimit, ...(provisioned && ports.remainingMs ? {remainingMs: ports.remainingMs} : {})});
            if (!brokerMacosCommandSucceeded(execution)) return {kind: "provider-failed", error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed", plan, execution};
            if (provisioned && ports.remainingMs && !(ports.remainingMs() >= 1)) return {kind: "provider-failed", error: "macos-tart-create-budget-exhausted", plan, execution};
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
        return {kind: "completed", plan, device, execution, success: true, invoked: true, mutatesHost: true, recoveryRequired: false};
    }
    async function existing(input: BrokerMacosLifecycleInput<Effect>): Promise<BrokerMacosLifecycleResponse<Effect>> {
        const {ownerId,parsed,plan} = input;
        const starting = parsed.command === "device_start";
        const startDeadline = starting ? ports.now() + (Number.isFinite(parsed.bootTimeoutMs) ? Math.min(600000, Math.max(1000, Number(parsed.bootTimeoutMs))) : 300000) : Infinity;
        const remainingMs = () => Math.max(0, Math.min(startDeadline - ports.now(), ports.remainingMs ? ports.remainingMs() : Infinity));
        let expected = input.expectedDevice;
        const command = plan?.providerCommand;
        if (!command || command.kind === "unavailable") return {kind: "refused", error: command?.error || "missing-provider-command", missing: command?.missing || [], plan: plan || null};
        if (starting && pendingStart(expected)) return {kind: "refused", error: "device-start-recovery-required", missing: [], plan: plan || null};
        if (starting && !(remainingMs() >= 1)) return {kind: "refused", error: "macos-start-budget-exhausted", missing: [], plan: plan || null};
        const noExecution: BrokerMacosProviderResult = {ok: false, mode: command.kind === "ready" ? "exec" : "noop", provider: command.kind === "ready" ? command.provider : "host-broker-state", resourceMissing: false, receipt: null};
        if (starting) {
            let reservation: BrokerMacosPublication;
            try {
                reservation = ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind: "reserve-start", lifecycle: {runtimeId: ports.runtimeId(), operation: "start", claimedAt: ports.timestamp()}, boot: null});
                if (!reservation.matched || !reservation.device) return {kind: "state-conflict", plan, device: reservation.device, execution: noExecution, success: false, invoked: false, mutatesHost: false, recoveryRequired: false, publication: reservation};
                expected = structuredClone(reservation.device);
            } catch (cause) {
                return {kind: "state-failed", cause, rollback: {attempted: false, ok: true, reason: "no-provider-resource-created"}};
            }
        }
        let auxiliary;
        try {auxiliary = parsed.command === "device_stop" || parsed.command === "device_delete" ? await ports.cleanupAuxiliary(ownerId,parsed,expected) : null;}
        catch {
            return {kind: "operation-failed", plan, device: expected, execution: noExecution, success: false, invoked: false, mutatesHost: true, recoveryRequired: pendingStart(expected), failure: "auxiliary-threw"};
        }
        if (auxiliary?.committed) expected = structuredClone(auxiliary.device);
        if (auxiliary?.result.ok === false) return {kind: "auxiliary-failed", plan, device: auxiliary.device, auxiliary: auxiliary.result};
        if (starting && !(remainingMs() >= 1)) return {kind: "operation-failed", plan, device: expected, execution: noExecution, success: false, invoked: false, mutatesHost: true, recoveryRequired: true, failure: "start-budget-exhausted"};
        let execution: BrokerMacosProviderResult;
        try {
            const timeoutMs = starting ? Math.min(ports.commandTimeoutMs, remainingMs()) : ports.commandTimeoutMs;
            execution = command.kind === "metadata-only"
                ? await ports.executeMetadata(command.purpose,{timeoutMs, outputLimit: ports.outputLimit})
                : await ports.execute(command.effect,{timeoutMs, outputLimit: ports.outputLimit, ...(starting ? {remainingMs} : {})});
        } catch {
            return {kind: "operation-failed", plan, device: expected, execution: noExecution, success: false, invoked: true, mutatesHost: true, recoveryRequired: starting || pendingStart(expected), failure: "execution-threw", ...(auxiliary ? {auxiliary: auxiliary.result} : {})};
        }
        if (!providerObservation(execution)) return {kind: "operation-failed", plan, device: expected, execution: noExecution, success: false, invoked: true, mutatesHost: true, recoveryRequired: starting || pendingStart(expected), failure: "execution-invalid", ...(auxiliary ? {auxiliary: auxiliary.result} : {})};
        let success = brokerMacosCommandSucceeded(execution) || brokerMacosToleratesMissingDelete(parsed,execution);
        let boot: BrokerMacosBoot | null = null;
        let helperPreparation: BrokerMacosHelperPreparation | undefined;
        if (success && starting) {
            if (!(remainingMs() >= 1)) return {kind: "operation-failed", plan, device: expected, execution, success: false, invoked: true, mutatesHost: true, recoveryRequired: true, failure: "start-budget-exhausted"};
            try {boot = await waitForBrokerMacosBoot(parsed,expected,command,{...ports, remainingMs}); if (!boot.ok) success = false;}
            catch {return {kind: "operation-failed", plan, device: expected, execution, success: false, invoked: true, mutatesHost: true, recoveryRequired: true, failure: "boot-threw"};}
            if (success) {
                const device = expected && typeof expected === "object" ? {...expected as Record<string, unknown>} : {};
                const ssh = device.ssh && typeof device.ssh === "object" ? {...device.ssh as Record<string, unknown>} : null;
                if (ssh && !ssh.host && boot?.ok && boot.sshHost) ssh.host = boot.sshHost;
                if (ssh) device.ssh = ssh;
                if (!(remainingMs() >= 1)) return {kind: "operation-failed", plan, device: expected, execution, success: false, invoked: true, mutatesHost: true, recoveryRequired: true, failure: "start-budget-exhausted", boot};
                if (ssh?.host && ssh.user) {
                    try {helperPreparation = await ports.provisionGuestHelper(ownerId, expected, device, {remainingMs, waitForReady: parsed.waitForBoot !== false});}
                    catch {return {kind: "operation-failed", plan, device: expected, execution, success: false, invoked: true, mutatesHost: true, recoveryRequired: true, failure: "helper-threw", boot};}
                    if (!helperPreparation || typeof helperPreparation.ok !== "boolean" || typeof helperPreparation.skipped !== "boolean" || !helperPreparation.helper || typeof helperPreparation.helper !== "object" || Array.isArray(helperPreparation.helper)) {
                        return {kind: "operation-failed", plan, device: expected, execution, success: false, invoked: true, mutatesHost: true, recoveryRequired: true, failure: "helper-invalid", boot};
                    }
                } else helperPreparation = {ok: true, skipped: true, helper: {status: "skipped-missing-ssh", provisioning: {status: "skipped-missing-ssh"}}};
                if (helperPreparation.ok && !(remainingMs() > 0)) helperPreparation = {...helperPreparation, ok: false, error: "macos-helper-readiness-timeout", helper: {...helperPreparation.helper, status: "failed"}};
                success = helperPreparation.ok;
            }
        }
        let publication: BrokerMacosPublication | undefined;
        if (success) {
            try {
                if (starting && !(remainingMs() >= 1)) return {kind: "operation-failed", plan, device: expected, execution, success: false, invoked: true, mutatesHost: true, recoveryRequired: true, failure: "start-budget-exhausted", boot, helperPreparation};
                publication = ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind: starting ? "start" : parsed.command === "device_stop" ? "stop" : "delete", boot, ...(helperPreparation ? {helper: helperPreparation.helper} : {})});
                if (!publication || typeof publication.matched !== "boolean") throw new Error("invalid-lifecycle-publication");
            }
            catch (cause) {
                let stateError: string | null = null;
                try {stateError = ports.stateErrorCode(cause);} catch { /* Preserve the partial-effect outcome if diagnostic classification fails. */ }
                return {kind: "operation-failed", plan, device: expected, execution, success: false, invoked: true, mutatesHost: true, recoveryRequired: starting || pendingStart(expected), failure: "publication-threw", ...(stateError ? {stateError, cause} : {}), ...(auxiliary ? {auxiliary: auxiliary.result} : {}), boot, helperPreparation};
            }
        }
        const conflict = publication !== undefined && !publication.matched;
        const device = publication ? publication.device : expected;
        return {kind: conflict ? "state-conflict" : success ? "completed" : "operation-failed", plan, device, execution, success, invoked: true, mutatesHost: true, recoveryRequired: starting ? !success || conflict : pendingStart(expected) && (!success || conflict), publication, ...(auxiliary ? {auxiliary: auxiliary.result} : {}), boot, ...(helperPreparation ? {helperPreparation} : {})};
    }
    return {create, start: existing, stop: existing, delete: existing, createRecord, planCreate, planExisting};
}
