import { brokerIosRecord, brokerIosCommandSucceeded, brokerIosCreateCommand, brokerIosExistingCommand } from "../../domain/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerIosLifecycleRequest, BrokerIosLifecycleInput, BrokerIosLifecycleResponse, BrokerIosProviderCommand, BrokerIosProviderResult, BrokerIosPlannedCommand } from "../../domain/lifecycle/ios-simulator-lifecycle.js";
import type { BrokerIosSimulatorLifecyclePorts } from "../../ports/lifecycle/ios-simulator-lifecycle.js";

export async function rollbackBrokerIosCreate(ports: BrokerIosSimulatorLifecyclePorts, device: Record<string, unknown>, existing: Record<string, unknown> | null, command: BrokerIosProviderCommand | null | undefined) {
    if (!command || command.mode === "noop") return { attempted: false, ok: true, reason: "no-provider-resource-created" };
    if (existing?.udid === device.udid) return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
    const udid = typeof device.udid === "string" ? device.udid : "";
    if (!udid) return { attempted: false, ok: false, reason: "created-simulator-udid-missing" };
    const executable = typeof command.executable === "string" ? command.executable : "";
    if (!executable) return { attempted: false, ok: false, reason: "created-simulator-provider-command-missing" };
    const result = ports.execute(ports.deleteCommand(executable,udid), { timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit });
    return { attempted: true, ok: brokerIosCommandSucceeded(result), result };
}

export function createBrokerIosRecord(ownerId: string, parsed: BrokerIosLifecycleRequest, ports: Pick<BrokerIosSimulatorLifecyclePorts, "timestamp">): Record<string, unknown> {
        const create = parsed.create || {}, now = ports.timestamp();
        return brokerIosRecord(ownerId,parsed,create,now);
    }

export function planBrokerIosCreateCommand(ownerId: string, parsed: BrokerIosLifecycleRequest, ports: Pick<BrokerIosSimulatorLifecyclePorts, "executable" | "createCommand">, create = parsed.create || {}): BrokerIosPlannedCommand {
        if (create.createSimulator === true) return ports.createCommand({ ...brokerIosCreateCommand(ownerId,parsed,create), executable: ports.executable("xcrun") });
        return { mode: "noop", provider: "host-broker-state", reason: "device_create writes owner-scoped broker metadata" };
    }

export function planBrokerIosExistingCommand(ownerId: string, parsed: BrokerIosLifecycleRequest, device: unknown, ports: Pick<BrokerIosSimulatorLifecyclePorts, "verifyOwnedTarget" | "executable">): BrokerIosPlannedCommand {
        const owned = ports.verifyOwnedTarget(ownerId,device);
        if (!owned.ok) return { error: owned.error, missing: owned.missing };
        const target = owned.target, executable = ports.executable("xcrun");
        return brokerIosExistingCommand(parsed,target,executable);
    }

export function createBrokerIosSimulatorLifecycle(ports: BrokerIosSimulatorLifecyclePorts) {
    const createRecord = (ownerId: string, parsed: BrokerIosLifecycleRequest) => createBrokerIosRecord(ownerId,parsed,ports);
    const planCreate = (ownerId: string, parsed: BrokerIosLifecycleRequest, create = parsed.create || {}) => planBrokerIosCreateCommand(ownerId,parsed,ports,create);
    const planExisting = (ownerId: string, parsed: BrokerIosLifecycleRequest, device: unknown) => planBrokerIosExistingCommand(ownerId,parsed,device,ports);
    async function create(input: BrokerIosLifecycleInput): Promise<BrokerIosLifecycleResponse> {
        const {ownerId,parsed,plan}=input;
        const command=plan?.providerCommand;
        if (command && "error" in command) return { status: 400, payload: { ok: false, error: command.error, missing: command.missing || [], plan: plan || null } };
        let execution: BrokerIosProviderResult = { mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "" };
        if (command && command.mode !== "noop") {
            execution=ports.execute(command,{timeoutMs:ports.commandTimeoutMs,outputLimit:ports.outputLimit});
            if (!brokerIosCommandSucceeded(execution)) return { status: 502, payload: { ok: false, error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed", detail: ports.failureDetail(execution), result: { ...(plan ? {...plan,device:ports.redactDevice(plan.device)} : {}), invoked:true,dryRun:false, execution:{mode:execution.mode,providerExecution:"executed",mutatesHost:false,command:execution} } } };
        }
        let persistedParsed=parsed;
        if (parsed.create?.createSimulator === true && execution.mode !== "noop") {
            const udid=ports.createdUdid(execution.stdout);
            if (!udid) return {status:502,payload:{ok:false,error:"ios-simulator-create-invalid-udid",ownerId,deviceId:parsed.deviceId}};
            persistedParsed={...parsed,create:{...(parsed.create||{}),udid}};
        }
        const device=createRecord(ownerId,persistedParsed);
        let claim;
        try { claim=ports.claimDefinition(ownerId,persistedParsed,device); }
        catch(error) {
            const rollback=await rollbackBrokerIosCreate(ports,device,null,command);
            if (!rollback.ok) return {status:502,payload:{ok:false,error:"owner-device-state-rollback-failed",ownerId,backend:parsed.backend,deviceId:parsed.deviceId,stateError:ports.stateErrorCode(error)||"owner-state-write-failed",rollback}};
            const failure=ports.stateFailure(error,parsed);
            return {...failure,payload:{...failure.payload,rollback}};
        }
        if (!claim.ok) {
            const rollback=await rollbackBrokerIosCreate(ports,device,claim.existing,command);
            return {status:rollback.ok?409:502,payload:{ok:false,error:rollback.ok?claim.error:"owner-device-conflict-rollback-failed",ownerId,backend:parsed.backend,deviceId:parsed.deviceId,field:claim.field,value:claim.value,existing:ports.redactDevice(claim.existing),rollback}};
        }
        return {status:200,payload:{ok:true,result:{...(plan||{}),device:ports.redactDevice(device),invoked:true,dryRun:false,execution:{mode:execution.mode==="noop"?"state":execution.mode,providerExecution:execution.mode==="noop"?"broker-state":"executed",mutatesHost:true,...(execution.mode==="noop"?{}:{command:execution})}}}};
    }
    async function existing(input: BrokerIosLifecycleInput): Promise<BrokerIosLifecycleResponse> {
        const {ownerId,parsed,plan}=input;
        let expected=input.expectedDevice;
        const command=plan?.providerCommand;
        if (!command || "error" in command) return {status:400,payload:{ok:false,error:command?.error||"missing-provider-command",missing:command?.missing||[],plan:plan?{...plan,device:ports.redactDevice(plan.device)}:null}};
        const auxiliary=parsed.command==="device_stop"||parsed.command==="device_delete"?ports.cleanupAuxiliary(ownerId,parsed,expected):null;
        if (auxiliary?.committed) expected=structuredClone(auxiliary.device);
        if (auxiliary?.result.ok===false) return {status:502,payload:{ok:false,error:"auxiliary-runtime-cleanup-failed",result:{...(plan||{}),device:ports.redactDevice(auxiliary.device),auxiliaryCleanup:auxiliary.result,invoked:false,dryRun:false,execution:{mode:"preflight",providerExecution:"blocked",mutatesHost:auxiliary.result.changed===true||auxiliary.result.appium.cleared===true||auxiliary.result.recording.cleared===true||auxiliary.result.minimizeWatchdog.cleared===true}}}};
        const execution=ports.execute(command,{timeoutMs:ports.commandTimeoutMs,outputLimit:ports.outputLimit});
        let success=brokerIosCommandSucceeded(execution);

        const publication=success?ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind:parsed.command==="device_start"?"start":parsed.command==="device_stop"?"stop":"delete"}):undefined;
        const updated=success?publication?.device:plan?.device;
        return {status:publication&&!publication.matched?409:success?200:502,payload:{ok:success&&(!publication||publication.matched),
            ...(publication&&!publication.matched?{error:"owner-device-state-conflict",ownerId,backend:parsed.backend,deviceId:parsed.deviceId,found:publication.found,...(!success?{providerFailure:"provider-command-failed"}:{})}:{}),
            ...(success||(publication&&!publication.matched)?{}:{error:"provider-command-failed",detail:ports.failureDetail(execution)}),
            result:{...(plan||{}),providerCommand:command,device:ports.redactDevice(updated),...(auxiliary?{auxiliaryCleanup:auxiliary.result}:{}),invoked:true,dryRun:false,execution:{mode:execution.mode,providerExecution:"executed",mutatesHost:success&&parsed.command!=="device_status",command:execution}}}};
    }
    return {create,start:existing,stop:existing,delete:existing,createRecord,planCreate,planExisting};
}
