import { brokerMacosRecord, brokerMacosCommandSucceeded, brokerMacosCreateCommand, brokerMacosExistingCommand, brokerMacosField, brokerMacosInstance, brokerMacosToleratesMissingDelete } from "../../domain/lifecycle/macos-vm-lifecycle.js";
import type { BrokerMacosLifecycleRequest, BrokerMacosLifecycleInput, BrokerMacosLifecycleResponse, BrokerMacosProviderCommand, BrokerMacosProviderResult, BrokerMacosPlannedCommand , BrokerMacosBoot } from "../../domain/lifecycle/macos-vm-lifecycle.js";
import type { BrokerMacosVmLifecyclePorts } from "../../ports/lifecycle/macos-vm-lifecycle.js";

export async function rollbackBrokerMacosCreate(ports: BrokerMacosVmLifecyclePorts, device: Record<string, unknown>, existing: Record<string, unknown> | null, command: BrokerMacosProviderCommand | null | undefined) {
    if (!command || command.mode === "noop") return { attempted: false, ok: true, reason: "no-provider-resource-created" };
    if (existing?.provider === device.provider && existing?.providerInstance === device.providerInstance) return { attempted: false, ok: true, reason: "provider-resource-owned-by-existing-device" };
    const result = ports.execute({ mode: "exec", provider: command.provider, executable: command.executable, args: ["delete",String(device.providerInstance)] }, { timeoutMs: ports.commandTimeoutMs, outputLimit: ports.outputLimit });
    return { attempted: true, ok: brokerMacosCommandSucceeded(result), result };
}

export function waitForBrokerMacosBoot(parsed: BrokerMacosLifecycleRequest, device: unknown, command: BrokerMacosProviderCommand, ports: BrokerMacosVmLifecyclePorts): BrokerMacosBoot {
    if (parsed.backend !== "macos-vm" || parsed.command !== "device_start" || parsed.waitForBoot !== true) return { ok: true, ready: false, skipped: true };
    if (command.provider !== "tart" || !command.executable) return { ok: true, ready: false, skipped: true };
    const instance = brokerMacosField(device,"providerInstance");
    if (!instance) return { ok: false, error: { mode: "exec", provider: command.provider, executable: command.executable, args: ["ip"], status: null, error: "missing-provider-metadata: providerInstance" } };
    const timeout = Number.isFinite(parsed.bootTimeoutMs) ? Math.min(600000,Math.max(1000,Number(parsed.bootTimeoutMs))) : 300000;
    const deadline = ports.now() + timeout;
    const attempts: BrokerMacosProviderResult[] = [];
    const ipAttempts = [["ip",instance],["ip","--resolver=arp",instance]];
    while (ports.now() < deadline) {
        for (const args of ipAttempts) {
            const result = ports.execute({ mode: "exec", provider: "tart", executable: command.executable, args }, {
                timeoutMs: Math.min(ports.commandTimeoutMs,Math.max(1000,deadline - ports.now())), outputLimit: ports.outputLimit,
            });
            attempts.push(result);
            const address = String(result.stdout || "").trim();
            if (brokerMacosCommandSucceeded(result) && address) return { ok: true, ready: true, sshHost: address, result, attempts: attempts.slice(-4) };
        }
        ports.sleep(Math.min(5000,Math.max(0,deadline - ports.now())));
    }
    const last = attempts.at(-1);
    return { ok: false, error: { mode: "exec", provider: "tart", executable: command.executable, args: ["ip",instance], status: last?.status ?? null, signal: last?.signal, stdout: last?.stdout, stderr: last?.stderr, error: `Timed out waiting for Tart IP for ${instance}` }, attempts: attempts.slice(-8) };
}

export function createBrokerMacosRecord(ownerId: string, parsed: BrokerMacosLifecycleRequest, ports: Pick<BrokerMacosVmLifecyclePorts, "timestamp">): Record<string, unknown> {
        const create = parsed.create || {}, now = ports.timestamp();
        return brokerMacosRecord(ownerId,parsed,create,now);
    }

export function planBrokerMacosCreateCommand(ownerId: string, parsed: BrokerMacosLifecycleRequest, ports: Pick<BrokerMacosVmLifecyclePorts, "executable">, create = parsed.create || {}): BrokerMacosPlannedCommand {
        const provider = create.provider === "auto" || !create.provider ? "tart" : String(create.provider);
        if (!["tart","vz","utmctl"].includes(provider)) return { error: "unsupported-provider-command", missing: ["provider"] };
        if (provider !== "tart") return { mode: "noop", provider: "host-broker-state", reason: "device_create writes owner-scoped broker metadata" };
        const image = typeof create.image === "string" && create.image ? create.image : null;
        if (!image) return { mode: "noop", provider: "host-broker-state", reason: "macOS VM device_create without image writes owner-scoped broker metadata" };
        const instance = brokerMacosInstance(ownerId,parsed,create);
        return brokerMacosCreateCommand("tart",image,instance,ports.executable("tart"));
    }

export function planBrokerMacosExistingCommand(_ownerId: string, parsed: BrokerMacosLifecycleRequest, device: unknown, ports: Pick<BrokerMacosVmLifecyclePorts, "executable">): BrokerMacosPlannedCommand {
        const provider = brokerMacosField(device,"provider") === "auto" || !brokerMacosField(device,"provider") ? "tart" : brokerMacosField(device,"provider") || "tart";
        if (!["tart","vz","utmctl"].includes(provider)) return { error: "unsupported-provider-command", missing: ["provider"] };
        const instance = brokerMacosField(device,"providerInstance");
        if (parsed.command === "device_delete" && !instance && !(parsed.stateKey !== "android-device" && parsed.stateKey !== "ios-device" && ["running","booted","started","starting"].includes(String((device as {status?: unknown})?.status || "").toLowerCase()))) {
            return { mode: "noop", provider: "host-broker-state", reason: "Stopped macOS VM delete without providerInstance deletes only owner broker metadata" };
        }
        if (!instance) return { error: "missing-provider-metadata", missing: ["providerInstance"] };
        const executable = ports.executable(provider);
        return brokerMacosExistingCommand(parsed,device,provider,instance,executable);
    }

export function createBrokerMacosVmLifecycle(ports: BrokerMacosVmLifecyclePorts) {
    const createRecord = (ownerId: string, parsed: BrokerMacosLifecycleRequest) => createBrokerMacosRecord(ownerId,parsed,ports);
    const planCreate = (ownerId: string, parsed: BrokerMacosLifecycleRequest, create = parsed.create || {}) => planBrokerMacosCreateCommand(ownerId,parsed,ports,create);
    const planExisting = (ownerId: string, parsed: BrokerMacosLifecycleRequest, device: unknown) => planBrokerMacosExistingCommand(ownerId,parsed,device,ports);
    async function create(input: BrokerMacosLifecycleInput): Promise<BrokerMacosLifecycleResponse> {
        const {ownerId,parsed,plan}=input;
        const command=plan?.providerCommand;
        if (command && "error" in command) return { status: 400, payload: { ok: false, error: command.error, missing: command.missing || [], plan: plan || null } };
        let execution: BrokerMacosProviderResult = { mode: "noop", provider: "host-broker-state", status: 0, stdout: "", stderr: "" };
        if (command && command.mode !== "noop") {
            execution=ports.execute(command,{timeoutMs:ports.commandTimeoutMs,outputLimit:ports.outputLimit});
            if (!brokerMacosCommandSucceeded(execution)) return { status: 502, payload: { ok: false, error: execution.typedCreateInvalidResult === true ? "hyper-v-create-invalid-result" : "provider-command-failed", detail: ports.failureDetail(execution), result: { ...(plan ? {...plan,device:ports.redactDevice(plan.device)} : {}), invoked:true,dryRun:false, execution:{mode:execution.mode,providerExecution:"executed",mutatesHost:false,command:execution} } } };
        }
        let persistedParsed=parsed;

        const device=createRecord(ownerId,persistedParsed);
        let claim;
        try { claim=ports.claimDefinition(ownerId,persistedParsed,device); }
        catch(error) {
            const rollback=await rollbackBrokerMacosCreate(ports,device,null,command);
            if (!rollback.ok) return {status:502,payload:{ok:false,error:"owner-device-state-rollback-failed",ownerId,backend:parsed.backend,deviceId:parsed.deviceId,stateError:ports.stateErrorCode(error)||"owner-state-write-failed",rollback}};
            const failure=ports.stateFailure(error,parsed);
            return {...failure,payload:{...failure.payload,rollback}};
        }
        if (!claim.ok) {
            const rollback=await rollbackBrokerMacosCreate(ports,device,claim.existing,command);
            return {status:rollback.ok?409:502,payload:{ok:false,error:rollback.ok?claim.error:"owner-device-conflict-rollback-failed",ownerId,backend:parsed.backend,deviceId:parsed.deviceId,field:claim.field,value:claim.value,existing:ports.redactDevice(claim.existing),rollback}};
        }
        return {status:200,payload:{ok:true,result:{...(plan||{}),device:ports.redactDevice(device),invoked:true,dryRun:false,execution:{mode:execution.mode==="noop"?"state":execution.mode,providerExecution:execution.mode==="noop"?"broker-state":"executed",mutatesHost:true,...(execution.mode==="noop"?{}:{command:execution})}}}};
    }
    async function existing(input: BrokerMacosLifecycleInput): Promise<BrokerMacosLifecycleResponse> {
        const {ownerId,parsed,plan}=input;
        let expected=input.expectedDevice;
        const command=plan?.providerCommand;
        if (!command || "error" in command) return {status:400,payload:{ok:false,error:command?.error||"missing-provider-command",missing:command?.missing||[],plan:plan?{...plan,device:ports.redactDevice(plan.device)}:null}};
        const auxiliary=parsed.command==="device_stop"||parsed.command==="device_delete"?ports.cleanupAuxiliary(ownerId,parsed,expected):null;
        if (auxiliary?.committed) expected=structuredClone(auxiliary.device);
        if (auxiliary?.result.ok===false) return {status:502,payload:{ok:false,error:"auxiliary-runtime-cleanup-failed",result:{...(plan||{}),device:ports.redactDevice(auxiliary.device),auxiliaryCleanup:auxiliary.result,invoked:false,dryRun:false,execution:{mode:"preflight",providerExecution:"blocked",mutatesHost:auxiliary.result.changed===true||auxiliary.result.appium.cleared===true||auxiliary.result.recording.cleared===true||auxiliary.result.minimizeWatchdog.cleared===true}}}};
        const execution=ports.execute(command,{timeoutMs:ports.commandTimeoutMs,outputLimit:ports.outputLimit});
        let success=brokerMacosCommandSucceeded(execution) || brokerMacosToleratesMissingDelete(parsed,execution);
        let boot: BrokerMacosBoot | null=null;
        if (success && parsed.command === "device_start") {boot=waitForBrokerMacosBoot(parsed,plan?.device,command,ports);if(!boot.ok)success=false;}
        const publication=success?ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind:parsed.command==="device_start"?"start":parsed.command==="device_stop"?"stop":"delete",boot}):undefined;
        const updated=success?publication?.device:plan?.device;
        return {status:publication&&!publication.matched?409:success?200:502,payload:{ok:success&&(!publication||publication.matched),
            ...(publication&&!publication.matched?{error:"owner-device-state-conflict",ownerId,backend:parsed.backend,deviceId:parsed.deviceId,found:publication.found,...(!success?{providerFailure:"provider-command-failed"}:{})}:{}),
            ...(success||(publication&&!publication.matched)?{}:{error:"provider-command-failed",detail:ports.failureDetail(execution)}),
            result:{...(plan||{}),providerCommand:command,device:ports.redactDevice(updated),...(auxiliary?{auxiliaryCleanup:auxiliary.result}:{}),invoked:true,dryRun:false,execution:{mode:execution.mode,providerExecution:"executed",mutatesHost:success&&parsed.command!=="device_status",command:boot&&!boot.ok?{...execution,registration:null,macosBoot:boot,androidBoot:null}:execution}}}};
    }
    return {create,start:existing,stop:existing,delete:existing,createRecord,planCreate,planExisting};
}
