import { brokerWindowsSandboxField as field, brokerWindowsSandboxRecord, brokerWindowsSandboxCommandSucceeded as succeeded, brokerWindowsSandboxRuntimeChoice } from '../../domain/lifecycle/windows-sandbox-lifecycle.js';
import type { BrokerWindowsSandboxResult, BrokerWindowsSandboxPrepared, BrokerWindowsSandboxInput, BrokerWindowsSandboxOutcome, BrokerWindowsSandboxFacts } from '../../domain/lifecycle/windows-sandbox-lifecycle.js';
import type { BrokerWindowsSandboxLifecyclePorts } from '../../ports/lifecycle/windows-sandbox-lifecycle.js';
export function createBrokerWindowsSandboxLifecycle<Prepared, Receipt>(ports: BrokerWindowsSandboxLifecyclePorts<Prepared, Receipt>) {
    type Ready = Extract<BrokerWindowsSandboxPrepared<Prepared>, {kind:'ready'}>;
    function runtimeSnapshot(effect: Ready): {ok:true;sandboxIds:string[]}|{ok:false;error:BrokerWindowsSandboxResult<Receipt>} {
        if (ports.platform !== 'win32') return {ok:true,sandboxIds:[]};
        if (!effect.sandboxId) return {ok:false,error:{status:null,error:'windows-sandbox-start-missing-registration-metadata'}};
        const result = ports.listRuntime(effect.handle,{timeoutMs:10000,outputLimit:ports.outputLimit});
        return succeeded(result) ? {ok:true,sandboxIds:ports.runtimeIds(result.stdout || '')} : {ok:false,error:{...result,error:result.error || 'windows-sandbox-runtime-snapshot-failed'}};
    }
    function registerRuntime(effect:Ready,baseline:string[]):{ok:true;sandboxId:string}|{ok:false;error:BrokerWindowsSandboxResult<Receipt>} {
        if (ports.platform !== 'win32') return {ok:true,sandboxId:effect.sandboxId || ''};
        if (!effect.sandboxId) return {ok:false,error:{status:null,error:'windows-sandbox-start-missing-registration-metadata'}};
        const deadline=ports.now()+60000;
        let last:BrokerWindowsSandboxResult<Receipt>|null=null;
        while(ports.now()<=deadline) {
            last=ports.listRuntime(effect.handle,{timeoutMs:Math.min(10000,Math.max(1000,deadline-ports.now())),outputLimit:ports.outputLimit});
            if(succeeded(last)) {
                const choice=brokerWindowsSandboxRuntimeChoice(ports.runtimeIds(last.stdout || ''),baseline,effect.sandboxId);
                if(choice.kind==='requested'||choice.kind==='single')return {ok:true,sandboxId:choice.id};
                if(choice.kind==='ambiguous'||choice.kind==='preexisting')return {ok:false,error:{...last,error:choice.error}};
            }
            ports.sleep(500);
        }
        return {ok:false,error:{status:last?.status??null,signal:last?.signal,stdout:last?.stdout,stderr:last?.stderr,timedOut:last?.timedOut,error:`No new Windows Sandbox runtime for ${effect.sandboxId} appeared in wsb list within 60000ms`}};
    }
    async function existing(input:BrokerWindowsSandboxInput<Prepared>):Promise<BrokerWindowsSandboxOutcome<Receipt>> {
        const {ownerId,parsed,device}=input;
        let expected=input.expectedDevice,prepared=input.prepared;
        if(parsed.command==='device_start') {
            const recorded=field(device,'configPath')||field(device,'wsbConfigPath');
            if(recorded&&ports.isCanonicalConfig(ownerId,parsed.deviceId,recorded)) {
                try {
                    if(brokerWindowsSandboxRecord(device))ports.writeConfig(ownerId,parsed.deviceId,device);
                    prepared=ports.prepare(ownerId,parsed,device);
                }catch(error){return {kind:'refused',category:'state-write-failed',error:'windows-sandbox-config-refresh-failed',detail:error instanceof Error?error.message:String(error)};}
            }
        }
        if(!prepared||prepared.kind==='unavailable')return {kind:'refused',category:'invalid',error:prepared?.error||'missing-provider-command',missing:prepared?.missing||[]};
        const baseline=parsed.command==='device_start'&&ports.platform==='win32'?runtimeSnapshot(prepared):null;
        if(baseline&&!baseline.ok)return {kind:'refused',category:'provider-failed',error:'windows-sandbox-runtime-snapshot-failed',facts:{device,invoked:false,mutatesHost:false,execution:baseline.error}};
        const collision=baseline?.ok&&prepared.sandboxId?brokerWindowsSandboxRuntimeChoice(baseline.sandboxIds,baseline.sandboxIds,prepared.sandboxId):null;
        if(collision?.kind==='preexisting')return {kind:'refused',category:'provider-failed',error:'windows-sandbox-runtime-already-present',detail:collision.error,facts:{device,invoked:false,mutatesHost:false}};
        let runtime:{sandboxId?:string;requestedSandboxId?:string;minimized:boolean}={sandboxId:prepared.sandboxId,minimized:prepared.minimized};
        if(parsed.command==='device_start') {
            const lock=ports.claimSingleton(ownerId,device,prepared.sandboxId);
            if(!lock.ok)return {kind:'refused',category:'conflict',error:'windows-sandbox-host-busy',detail:lock.error,lock:lock.lock};
        }
        const auxiliary=parsed.command==='device_stop'||parsed.command==='device_delete'?ports.cleanupAuxiliary(ownerId,parsed,expected):null;
        if(auxiliary?.committed)expected=structuredClone(auxiliary.device);
        if(auxiliary?.result.ok===false)return {kind:'refused',category:'provider-failed',error:'auxiliary-runtime-cleanup-failed',facts:{device:auxiliary.device,auxiliaryCleanup:auxiliary.result,invoked:false,mutatesHost:auxiliary.result.changed===true||auxiliary.result.appium.cleared===true||auxiliary.result.recording.cleared===true||auxiliary.result.minimizeWatchdog.cleared===true}};
        const helper=parsed.command==='device_start'?ports.helperPaths(ownerId,parsed.deviceId):null;
        if(helper){ports.removeMarker(helper.minimizeWatchdogCancelPath);ports.removeMarker(helper.minimizeWatchdogResultPath);}
        const startedAfter=helper?ports.timestampBefore(2000):null;
        const bounds={timeoutMs:ports.commandTimeoutMs,outputLimit:ports.outputLimit};
        const windowSnapshot=helper&&prepared.minimized&&ports.platform==='win32'?ports.snapshotWindows(bounds):null;
        const handles=windowSnapshot&&succeeded(windowSnapshot)?ports.windowHandles(windowSnapshot.stdout||''):null;
        const execution=ports.run(prepared.handle,bounds);
        let success=succeeded(execution);
        const mutatedHost=success||auxiliary?.result.changed===true||auxiliary?.result.appium.cleared===true||auxiliary?.result.recording.cleared===true||auxiliary?.result.minimizeWatchdog.cleared===true;
        let registration:BrokerWindowsSandboxResult<Receipt>|null=null,watchdog:BrokerWindowsSandboxResult<Receipt>|null=null,confirmation:BrokerWindowsSandboxResult<Receipt>|null=null;
        let watchdogCleanup:ReturnType<typeof ports.cancelWatchdog>|null=null;
        if(success&&parsed.command==='device_start') {
            const registered=registerRuntime(prepared,baseline?.ok?baseline.sandboxIds:[]);
            if(registered.ok) {
                if(registered.sandboxId&&registered.sandboxId!==prepared.sandboxId) {
                    ports.updateSingletonRuntimeId(ownerId,device,prepared.sandboxId,registered.sandboxId);
                    runtime={...runtime,sandboxId:registered.sandboxId,requestedSandboxId:prepared.sandboxId};
                }
                if(prepared.minimized&&ports.platform==='win32'&&helper&&startedAfter&&handles!==null) {
                    watchdog=ports.launchWatchdog(startedAfter,helper,handles,bounds);
                    if(!succeeded(watchdog))confirmation=watchdog;
                }else if(prepared.minimized&&ports.platform==='win32'&&helper)confirmation={status:null,error:'windows-sandbox-window-baseline-unavailable'};
                if(prepared.minimized&&ports.platform==='win32'&&helper&&watchdog&&succeeded(watchdog))confirmation=ports.waitForMinimizeConfirmation(helper.minimizeWatchdogResultPath);
            }else {registration=registered.error;success=false;}
        }
        if(!success&&watchdog?.pid)watchdogCleanup=ports.cancelWatchdog(ownerId,parsed.deviceId);
        if(parsed.command==='device_start'&&!success&&!registration)ports.releaseSingleton(ownerId,device,runtime.sandboxId);
        const facts:BrokerWindowsSandboxFacts<Receipt>={device,execution,runtime,registration,watchdog,confirmation,watchdogCleanup,auxiliaryCleanup:auxiliary?.result,invoked:true,mutatesHost:mutatedHost};
        if(success&&(parsed.command==='device_stop'||parsed.command==='device_delete')) {
            const observed=ports.inspectExpectedRecord(ownerId,parsed.stateKey,parsed.deviceId,expected);
            if(!observed.matched)return {kind:'refused',category:'conflict',error:'owner-device-state-conflict',facts:{...facts,device:observed.device,publication:observed,mutatesHost:true}};
            ports.releaseSingleton(ownerId,device,runtime.sandboxId);
        }
        const artifactCleanup=success&&parsed.command==='device_delete'?ports.cleanArtifacts(ownerId,parsed.deviceId):null;
        if(artifactCleanup?.ok===false)return {kind:'refused',category:'provider-failed',error:'windows-sandbox-device-artifact-cleanup-failed',facts:{...facts,device:auxiliary?.device||device,artifactCleanup,mutatesHost:true}};
        const publication=success?ports.publish(ownerId,parsed.stateKey,parsed.deviceId,expected,{kind:parsed.command==='device_start'?'start':parsed.command==='device_stop'?'stop':'delete',minimized:parsed.minimized,runtime,watchdog,confirmation,...(watchdog&&helper?{watchdogCancelPath:helper.minimizeWatchdogCancelPath}:{})}):undefined;
        const finalFacts={...facts,device:success?publication?.device:device,artifactCleanup,publication};
        if(publication?.matched===false)return {kind:'refused',category:'conflict',error:'owner-device-state-conflict',facts:finalFacts};
        if(!success)return {kind:registration?'indeterminate':'failed',success:false,facts:finalFacts};
        return {kind:'completed',success:true,facts:finalFacts};
    }
    return {start:existing,stop:existing,delete:existing};
}
