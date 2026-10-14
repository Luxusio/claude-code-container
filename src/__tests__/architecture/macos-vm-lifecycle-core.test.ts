import { describe, expect, it } from "vitest";
import { createMacosVmLifecycleApplication } from "../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs";
import type { MacosVmLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs";
import { createMacosImageSnapshots } from "../../../packages/device-lab/providers/application/macos-image-snapshots.mjs";
import type { MacosImageSnapshotsPorts } from "../../../packages/device-lab/providers/ports/macos-image-snapshots.mjs";
import type { MacosVmLifecyclePorts, MacosVmDevice, MacosVmCommandResult, MacosVmNativeObservation, MacosVmProviderPlan, MacosVmLifecycleOutcome } from "../../../packages/device-lab/providers/ports/lifecycle/macos-vm-lifecycle.mjs";

type Result={ok:boolean;value:unknown};
function nativeLeaves(initial?:MacosVmDevice){
    let current=initial;const trace:string[]=[],fault={native:"raw claim failure"};
    const child={pid:71,unref(){expect(this).toBe(child);trace.push("unref");}};
    const plan={available:true,missing:[],selectedProvider:"tart",providerCommand:"/native/tart",providerInstance:"ccc-owner-unit",startCommand:{command:"/native/tart",args:["run","ccc-owner-unit"]},stopCommand:{command:"/native/tart",args:["stop","ccc-owner-unit"]}};
    const nativePlan={available:true,missing:[],selectedProvider:"tart",providerInstance:plan.providerInstance,stopAvailable:true,evidence:plan};
    const observe=(evidence:MacosVmCommandResult):MacosVmNativeObservation=>({ok:evidence.status===0,timedOut:evidence.signal==="SIGTERM",detail:evidence.stderr||evidence.stdout,evidence});
    const command=(_command:string|null,args:(string|null|undefined)[])=>{trace.push(args.join(" "));return {status:0,stdout:"raw out",stderr:"raw err"};};
    const ports:MacosVmLifecyclePorts<typeof child>={
        read(){trace.push("read");return current?[current]:[];},find(){trace.push("find");return current||null;},
        claim(device){trace.push("claim");current=device;return {ok:true};},
        transition(_id,expected,replacement){trace.push("transition");if(current!==expected)return {matched:false,found:Boolean(current),device:current!};current=replacement||undefined;return {matched:true,found:true,device:current!};},
        owner:()=>"owner",deviceId:()=>"unit",timestamp:()=>"2026-10-10T12:00:00.000Z",now:()=>1791633600000,runtimeId:()=>"claim",claimTtlMs:()=>1000,parseLifecycleClaimedAt:value=>Date.parse(value),
        validateSshKey:()=>({ok:true,path:null}),helperMetadata:()=>({}),
        providerPlan:()=>nativePlan,tartPlan:()=>({plan:nativePlan}),
        cloneInstance(_plan,source,target){return observe(command(null,["clone",source,target]));},
        deleteInstance(_plan,instance){return observe(command(null,["delete",instance]));},
        stopInstance(value){return observe(command(null,["stop",value.providerInstance]));},
        launchProvider(){trace.push("spawn");return {child,startCommand:plan.startCommand};},async waitProviderStart(value){expect(value).toBe(child);trace.push("wait-start");return null;},
        async waitBoot(){trace.push("boot");return {ready:true,ip:"192.0.2.4"};},
        async waitGuestHelper(){trace.push("guest-helper");return {ok:true};},provisionHelper(){trace.push("provision");return {ok:true,skipped:true};},
        signalRecording(){trace.push("recording-signal");return {signaled:false,exited:true};},async waitRecordingExit(){trace.push("recording-wait");return true;},
        interruptGuestRecording(){trace.push("guest-recording-interrupt");},
    };
    return {ports,trace,fault,child,plan,command,observe,read:()=>current,replace:(value:MacosVmDevice)=>{current=value;}};
}
// The unchanged image consumer still accepts its existing outward Result contract.
function imageLifecycle(f:ReturnType<typeof nativeLeaves>):MacosVmLifecycle<Result> {
    const app=createMacosVmLifecycleApplication(f.ports);
    const present=(outcome:MacosVmLifecycleOutcome):Result=>({ok:outcome.kind==="completed",value:"value" in outcome?outcome.value:outcome});
    const normalize=(plan:MacosVmProviderPlan)=>({available:plan.available,missing:plan.missing,selectedProvider:plan.selectedProvider,providerInstance:plan.providerInstance,stopAvailable:Boolean(plan.stopCommand),evidence:plan});
    const result=(outcome:MacosVmLifecycleOutcome|undefined)=>outcome&&present(outcome);
    return {...app,create:input=>result(app.create(input)),createImage:input=>result(app.createImage(input)),
        start:async input=>result(await app.start(input)),stop:async input=>result(await app.stop(input)),delete:async input=>result(await app.delete(input)),
        recoverStale:id=>{const recovered=app.recoverStale(id);return {...recovered,error:recovered.error&&present(recovered.error)};},
        conflict:(...args)=>present(app.conflict(...args)),
        rollbackCreated:(id,plan,instance)=>app.rollbackCreated(id,normalize(plan),instance),
        rollbackStarted:(id,claim,plan)=>app.rollbackStarted(id,claim,normalize(plan)),
        clone:(plan,source,target)=>{const cloned=app.clone(normalize(plan),source,target);return {result:cloned.result.evidence,cleanup:cloned.cleanup?.evidence||null};},
        cloneFailureEvidence:(command,cleanup,target)=>({command,cleanup,target}),
        cloneFailure:(command,cleanup,target)=>present(app.cloneFailure(f.observe(command),cleanup&&f.observe(cleanup),target)),
    };
}

function imagePorts(f:ReturnType<typeof nativeLeaves>,command:ReturnType<typeof nativeLeaves>["command"]):MacosImageSnapshotsPorts<Result> {
    return {...f.ports,snapshotId:()=>"snapshot-before",providerPlan:()=>f.plan,
        providerCommand:command,publicDevice:device=>device,waitRecordingExit:async()=>true,
        textResult:(ok,value)=>({ok,value}),jsonResult:value=>({ok:true,value}),fail:value=>({ok:false,value}),
        presentRestoreFailure:(evidence,error,candidate)=>({ok:false,value:{evidence,error,candidate}})};
}
describe("macOS independent inward policy controls",()=>{
    it("issues one fresh native identity for every same-name normal and image creation",()=>{
        const f=nativeLeaves();
        const records=new Map<string,MacosVmDevice>();
        let sequence=0;
        f.ports.deviceId=()=>`macos-birth-${++sequence}`;
        f.ports.read=()=>[...records.values()];
        f.ports.find=id=>records.get(id||"")||null;
        f.ports.claim=device=>{records.set(device.id,device);return {ok:true};};
        f.ports.providerPlan=device=>({available:true,missing:[],selectedProvider:"tart",providerInstance:`ccc-owner-${device.id}`,stopAvailable:true,evidence:{...f.plan,providerInstance:`ccc-owner-${device.id}`}});
        f.ports.tartPlan=device=>({plan:f.ports.providerPlan(device)});
        const app=createMacosVmLifecycleApplication(f.ports);
        for (const create of [app.create,app.createImage]) {
            expect(create({backend:"macos-vm",name:"Same 名称",sourceImage:"base"})?.kind).toBe("completed");
            expect(create({backend:"macos-vm",name:"Same 名称",sourceImage:"base"})?.kind).toBe("completed");
        }
        expect([...records.keys()]).toEqual(["macos-birth-1","macos-birth-2","macos-birth-3","macos-birth-4"]);
        expect([...records.values()].map(device=>device.name)).toEqual(Array(4).fill("Same 名称"));
        expect(new Set([...records.values()].map(device=>device.providerInstance)).size).toBe(4);
        expect(sequence).toBe(4);
    });
    it.each(["create","createImage"] as const)("rejects caller deviceId in %s before entropy, storage or native calls",operation=>{
        const f=nativeLeaves();
        f.ports.deviceId=()=>{throw Error("caller IDs must be rejected before admission");};
        const result=createMacosVmLifecycleApplication(f.ports)[operation]({backend:"macos-vm",name:"Chosen",deviceId:"unit",sourceImage:"base",force:true});
        expect(result?.kind).toBe("refused");
        expect(f.trace).toEqual([]);
        expect(f.read()).toBeUndefined();
    });
    it("refuses an entropy collision without recovering or deleting the historical definition",()=>{
        const historical:MacosVmDevice={id:"unit",name:"Historical",status:"starting",provider:"tart",providerInstance:"ccc-owner-unit",lifecycle:{runtimeId:"old",operation:"start",claimedAt:"2020-01-01T00:00:00.000Z"}};
        const f=nativeLeaves(historical);
        const result=createMacosVmLifecycleApplication(f.ports).create({backend:"macos-vm",name:"Replacement",sourceImage:"base",force:true});
        expect(result?.kind).not.toBe("completed");
        expect(f.read()).toBe(historical);
        expect(f.trace).toEqual(["read"]);
    });

    it("retains clone and failed owned cleanup evidence without claiming the destination",()=>{
        const f=nativeLeaves();
        const primary=f.observe({status:null,stdout:"",stderr:"clone timed out",signal:"SIGTERM"});
        const cleanup=f.observe({status:9,stdout:"",stderr:"owned cleanup denied"});
        f.ports.cloneInstance=(_plan,source,target)=>{expect(source).toBe("base");expect(target).toBe("ccc-owner-unit");f.trace.push("clone");return primary;};
        f.ports.deleteInstance=(_plan,target)=>{expect(target).toBe("ccc-owner-unit");f.trace.push("delete");return cleanup;};
        const result=createMacosVmLifecycleApplication(f.ports).create({backend:"macos-vm",sourceImage:"base"});
        expect(result).toEqual({kind:"clone-failed",evidence:{target:"ccc-owner-unit",command:primary,cleanup}});
        expect(f.read()).toBeUndefined();expect(f.trace).not.toContain("claim");
        expect(f.trace.slice(-2)).toEqual(["clone","delete"]);
    });

    it("preserves running runtime identity when native provider stop fails",async()=>{
        const runtime={runtimeId:"exact-runtime",providerPid:71};
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",runtime});
        const evidence={status:7,stdout:"",stderr:"native stop refused"};
        f.ports.stopInstance=()=>f.observe(evidence);
        const result=await createMacosVmLifecycleApplication(f.ports).stop({deviceId:"unit"});
        expect(result).toEqual({kind:"failed",evidence});
        expect(f.read()).toMatchObject({status:"running",runtime});
        expect(f.read()).not.toHaveProperty("lifecycle");
        expect(f.trace).not.toContain("recording-signal");
    });
    it("metadata create is synchronous and claim raw exceptions preserve identity",()=>{
        const f=nativeLeaves();f.ports.claim=()=>{throw f.fault;};
        let error:unknown;try{createMacosVmLifecycleApplication(f.ports).create({backend:"macos-vm",name:"Unit"});}catch(value){error=value;}
        expect(error).toBe(f.fault);expect(f.trace).toEqual(["read"]);expect(f.read()).toBeUndefined();
    });
    it("image alias clones before claiming and a claim exception compensates before rethrow",()=>{
        const f=nativeLeaves();f.ports.claim=()=>{f.trace.push("claim-throw");throw f.fault;};
        let error:unknown;try{createMacosVmLifecycleApplication(f.ports).create({backend:"macos-vm",name:"Unit",sourceImage:"preferred",image:"ignored"});}catch(value){error=value;}
        expect(error).toBe(f.fault);expect(f.trace.filter(value=>value.startsWith("clone")||value.startsWith("delete")||value==="claim-throw")).toEqual(["clone preferred ccc-owner-unit","claim-throw","delete ccc-owner-unit"]);
    });
    it("preserves opaque child receiver, launch/readback and skipped readiness ordering",async()=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart"});
        const result=await createMacosVmLifecycleApplication(f.ports).start({deviceId:"unit",waitForBoot:false});
        expect(result?.kind).toBe("completed");expect(f.trace.indexOf("spawn")).toBeLessThan(f.trace.indexOf("wait-start"));
        expect(f.trace.indexOf("wait-start")).toBeLessThan(f.trace.indexOf("unref"));expect(f.trace).not.toContain("boot");
        expect(f.read()).toMatchObject({status:"running",runtime:{providerPid:71},bootReady:false});expect(f.read()).not.toHaveProperty("lifecycle");
    });
    it("a successor prevents runtime publication and guarded rollback from stopping its instance",async()=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart"});
        f.ports.waitProviderStart=async()=>{f.replace({id:"unit",status:"running",providerInstance:"ccc-owner-unit",lifecycle:{runtimeId:"successor",operation:"start",claimedAt:"now"}});return null;};
        const result=await createMacosVmLifecycleApplication(f.ports).start({deviceId:"unit",waitForBoot:false});
        expect(result?.kind).toBe("problem");expect(f.read()?.lifecycle?.runtimeId).toBe("successor");expect(f.trace).not.toContain("stop ccc-owner-unit");
    });
    it("stop clears runtime and recording only after the native stop result",async()=>{
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",runtime:{providerPid:71},recording:{runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"a".repeat(64)},active:false}});
        const result=await createMacosVmLifecycleApplication(f.ports).stop({deviceId:"unit"});
        expect(result?.kind).toBe("completed");expect(f.trace.indexOf("stop ccc-owner-unit")).toBeLessThan(f.trace.indexOf("recording-signal"));
        expect(f.read()).toMatchObject({status:"stopped",runtime:null,recording:null,bootReady:false});
    });
    it("refused recorder signaling retains identity and recovery metadata after provider stop",async()=>{
        const recording={runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"command"},active:true,remotePath:"/video"};
        const recovery={candidateProviderInstance:"recovery"};
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",runtime:{providerPid:71},recording,restoreRecovery:recovery});
        f.ports.signalRecording=()=>({signaled:false,reason:"runtime-process-identity-mismatch"});
        f.ports.interruptGuestRecording=()=>{throw Error("remote cleanup must not run after identity refusal");};
        const result=await createMacosVmLifecycleApplication(f.ports).stop({deviceId:"unit"});
        expect(result?.kind).toBe("problem");expect((result?.kind === "problem" ? result.value : undefined)).toMatchObject({error:"macos-recording-cleanup-incomplete",reason:"runtime-process-identity-mismatch"});
        expect(f.read()).toMatchObject({status:"stopped",runtime:null,recording,restoreRecovery:recovery});
        expect(f.read()).not.toHaveProperty("lifecycle");expect(f.trace).not.toContain("recording-wait");
    });
    it("unconfirmed recorder exit reports partial stop without discarding its generation",async()=>{
        const recording={runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"command"},active:true};
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",recording});
        f.ports.signalRecording=()=>({signaled:true});
        f.ports.waitRecordingExit=async(runtime,timeout)=>{expect(runtime).toMatchObject(recording);expect(timeout).toBe(1000);return false;};
        const result=await createMacosVmLifecycleApplication(f.ports).stop({deviceId:"unit"});
        expect(result?.kind).toBe("problem");expect(f.read()).toMatchObject({status:"stopped",recording});expect(f.read()).not.toHaveProperty("lifecycle");
    });
    it("confirmed recorder exit allows stop to clear recording metadata",async()=>{
        const recording={runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"command"},active:true};
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",recording});
        f.ports.signalRecording=()=>({signaled:true});
        f.ports.waitRecordingExit=async(runtime)=>{expect(runtime).toMatchObject(recording);return true;};
        const result=await createMacosVmLifecycleApplication(f.ports).stop({deviceId:"unit"});
        expect(result?.kind).toBe("completed");expect(f.read()).toMatchObject({status:"stopped",recording:null});
    });
    it.each(["refused","unconfirmed"])("forced delete stops before resource deletion when recording cleanup is %s",async mode=>{
        const recording={runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"command"}};
        const snapshots=[{id:"snapshot",provider:"tart",providerInstance:"snap"}],restoreRecovery={candidateProviderInstance:"recovery"};
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",providerResourceManaged:true,recording,snapshots,restoreRecovery});
        f.ports.signalRecording=()=>({signaled:mode==="unconfirmed",reason:"runtime-process-identity-unavailable"});
        f.ports.waitRecordingExit=async()=>false;
        const result=await createMacosVmLifecycleApplication(f.ports).delete({deviceId:"unit",force:true});
        expect(result?.kind).toBe("problem");expect(f.trace.filter(value=>value.startsWith("delete "))).toEqual([]);
        expect(f.read()).toMatchObject({status:"stopped",runtime:null,recording,snapshots,restoreRecovery});expect(f.read()).not.toHaveProperty("lifecycle");
    });
    it("already-stopped devices retain unverified recordings instead of deleting resources",async()=>{
        const recording={pid:17,active:false};
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart",providerInstance:"ccc-owner-unit",providerResourceManaged:true,recording});
        f.ports.signalRecording=()=>({signaled:false,reason:"runtime-process-identity-missing"});
        const result=await createMacosVmLifecycleApplication(f.ports).delete({deviceId:"unit"});
        expect(result?.kind).toBe("problem");expect(f.trace.filter(value=>value.startsWith("delete "))).toEqual([]);expect(f.read()?.recording).toEqual(recording);
    });
    it("forced delete removes managed resources only after confirmed recorder exit",async()=>{
        const recording={runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"a".repeat(64)}};
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",providerResourceManaged:true,recording});
        f.ports.signalRecording=()=>({signaled:true});
        f.ports.waitRecordingExit=async(runtime)=>{expect(runtime).toMatchObject(recording);f.trace.push("recording-exited");return true;};
        const result=await createMacosVmLifecycleApplication(f.ports).delete({deviceId:"unit",force:true});
        expect(result?.kind).toBe("completed");expect(f.read()).toBeUndefined();
        expect(f.trace.indexOf("delete ccc-owner-unit")).toBeGreaterThan(f.trace.indexOf("recording-exited"));
    });
    it("a recording successor survives completed cleanup and blocks forced resource deletion",async()=>{
        const recording={runtimeId:"recorder",pid:17,processIdentity:{pid:17,startToken:"birth",commandHash:"command"}};
        const successor={runtimeId:"successor",pid:18,processIdentity:{pid:18,startToken:"new-birth",commandHash:"new-command"}};
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",providerResourceManaged:true,recording});
        f.ports.signalRecording=()=>({signaled:true});
        f.ports.waitRecordingExit=async()=>{f.replace({...f.read()!,recording:successor});return true;};
        const result=await createMacosVmLifecycleApplication(f.ports).delete({deviceId:"unit",force:true});
        expect(result?.kind).toBe("problem");expect(f.read()?.recording).toEqual(successor);expect(f.trace.filter(value=>value.startsWith("delete "))).toEqual([]);
    });
    it("cleanup refusal cannot restore state over a different lifecycle owner",async()=>{
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",recording:{runtimeId:"recorder",pid:17}});
        const successor={id:"unit",status:"running",lifecycle:{runtimeId:"successor",operation:"start",claimedAt:"now"}};
        f.ports.signalRecording=()=>{f.replace(successor);return {signaled:false,reason:"runtime-process-identity-missing"};};
        const result=await createMacosVmLifecycleApplication(f.ports).stop({deviceId:"unit"});
        expect(result?.kind).toBe("problem");expect(result).toMatchObject({kind:"problem",value:{error:"owner-device-state-conflict"}});expect(f.read()).toEqual(successor);
    });
    it.each(["boot-failure","helper-failure"])("publishes truthful started partial fields on %s",async mode=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart",ssh:{user:"user",host:null}});
        f.ports.waitBoot=async(_plan,timeout,deadline)=>{expect(timeout).toBe(900000);expect(deadline).toBe(1791634200000);return mode==="boot-failure"?{ready:false,error:"raw-ip-failure"}:{ready:true,ip:"192.0.2.4"};};
        f.ports.waitGuestHelper=async()=>mode==="helper-failure"?{ok:false,error:"raw-helper-failure",provisioning:{status:"failed"}}:{ok:true};
        const result=await createMacosVmLifecycleApplication(f.ports).start({deviceId:"unit",waitForBoot:true,bootTimeoutMs:900000});
        expect(result?.kind).toBe("problem");expect(f.read()?.status).toBe(mode==="boot-failure"?"starting":"running");expect(f.read()).not.toHaveProperty("lifecycle");
        expect(f.read()?.runtime?.providerPid).toBe(71);if(mode==="helper-failure")expect(f.read()?.ssh?.host).toBe("192.0.2.4");
    });
    it("managed deletion records already-completed snapshot progress when a later delete fails",async()=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart",providerResourceManaged:true,providerInstance:"ccc-owner-unit",snapshots:[{id:"snapshot",provider:"tart",providerInstance:"snap"}]});
        f.ports.deleteInstance=(_plan,instance)=>{f.trace.push(`delete ${instance}`);return f.observe({status:instance==="ccc-owner-unit"?9:0,stdout:"raw out",stderr:"raw err"});};
        const result=await createMacosVmLifecycleApplication(f.ports).delete({deviceId:"unit"});
        expect(result?.kind).toBe("failed");expect(f.trace.filter(value=>value.startsWith("delete"))).toEqual(["delete snap","delete ccc-owner-unit"]);
        expect(f.read()?.snapshots).toEqual([]);expect(f.read()?.status).toBe("stopped");
    });
});

describe("macOS image and snapshot publication",()=>{
    it("issues fresh identities for same-name clones without changing the historical source",async()=>{
        const source:MacosVmDevice={id:"legacy-source",name:"Historical",status:"stopped",provider:"tart",providerInstance:"legacy-native"};
        const f=nativeLeaves(source),records=new Map<string,MacosVmDevice>([[source.id,source]]);
        let sequence=0;
        const ports=imagePorts(f,f.command);
        ports.deviceId=()=>`macos-clone-${++sequence}`;
        ports.read=()=>[...records.values()];
        ports.find=id=>records.get(id||"")||null;
        ports.claim=device=>{records.set(device.id,device);return {ok:true};};
        ports.transition=(id,expected,replacement)=>{const current=records.get(id||"");if(current!==expected)return {matched:false,found:Boolean(current),device:current};if(replacement)records.set(id!,replacement);else records.delete(id!);return {matched:true,found:true,device:replacement};};
        ports.providerPlan=device=>({...f.plan,providerInstance:device.providerInstance||`ccc-owner-${device.id}`});
        const lifecycle=imageLifecycle({...f,ports:{...f.ports,read:ports.read,find:id=>ports.find(id)||null,claim:ports.claim,transition:ports.transition}});
        const app=createMacosImageSnapshots(ports,lifecycle);
        expect((await app.clone({name:"Same 名称",sourceDeviceId:source.id}))?.ok).toBe(true);
        expect((await app.clone({name:"Same 名称",sourceDeviceId:source.id}))?.ok).toBe(true);
        expect([...records.keys()]).toEqual(["legacy-source","macos-clone-1","macos-clone-2"]);
        expect(records.get("legacy-source")).toMatchObject({id:"legacy-source",providerInstance:"legacy-native",status:"stopped"});
        expect(records.get("macos-clone-1")?.providerInstance).not.toBe(records.get("macos-clone-2")?.providerInstance);
        expect(sequence).toBe(2);
    });
    it("refuses caller clone identity before source recovery or native mutation",async()=>{
        const source:MacosVmDevice={id:"legacy-source",status:"starting",provider:"tart",providerInstance:"legacy-native",lifecycle:{runtimeId:"old",operation:"start",claimedAt:"2020-01-01T00:00:00.000Z"}};
        const f=nativeLeaves(source),ports=imagePorts(f,f.command);
        ports.deviceId=()=>{throw Error("caller IDs must be rejected before admission");};
        const result=await createMacosImageSnapshots(ports,imageLifecycle(f)).clone({name:"Chosen",deviceId:"old-id",sourceDeviceId:source.id,force:true});
        expect(result?.ok).toBe(false);
        expect(f.trace).toEqual([]);
        expect(f.read()).toBe(source);
    });

    it("releases the source before destination publication and compensates a publication exception",async()=>{
        const source:MacosVmDevice={id:"unit",status:"stopped",provider:"tart",providerInstance:"ccc-owner-unit"};
        const f=nativeLeaves(source);
        const resources=new Set(["ccc-owner-unit"]);
        const command:typeof f.command=(_command,args)=>{
            if(args[0]==="clone"&&typeof args[2]==="string")resources.add(args[2]);
            if(args[0]==="delete"&&typeof args[1]==="string")resources.delete(args[1]);
            return {status:0,stdout:"",stderr:""};
        };
        f.ports.cloneInstance=(plan,source,target)=>f.observe(command(plan.evidence.providerCommand,["clone",source,target]));
        f.ports.deleteInstance=(plan,instance)=>f.observe(command(plan.evidence.providerCommand,["delete",instance]));
        f.ports.claim=destination=>{
            expect(destination).toMatchObject({id:"copy",providerInstance:"ccc-owner-copy",providerResourceManaged:true,
                clonedFrom:{deviceId:"unit",providerInstance:"ccc-owner-unit"}});
            expect(f.read()).toMatchObject({id:"unit",status:"stopped",providerInstance:"ccc-owner-unit"});
            expect(f.read()).not.toHaveProperty("lifecycle");
            throw f.fault;
        };
        const ports=imagePorts(f,command);
        ports.deviceId=()=>"copy";
        ports.providerPlan=device=>({...f.plan,providerInstance:device.providerInstance||`ccc-owner-${device.id}`});
        const app=createMacosImageSnapshots(ports,imageLifecycle(f));
        await expect(app.clone({name:"Copy",sourceDeviceId:"unit"})).rejects.toBe(f.fault);
        expect(resources).toEqual(new Set(["ccc-owner-unit"]));
        expect(f.read()).not.toHaveProperty("lifecycle");
    });

    it("retains a failed candidate cleanup as recovery metadata after successful activation",async()=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart",providerInstance:"ccc-owner-unit",
            snapshots:[{id:"snapshot-before",name:"Before",provider:"tart",providerInstance:"owned-snapshot"}]});
        const resources=new Set(["ccc-owner-unit","owned-snapshot"]);
        const command:typeof f.command=(_command,args)=>{
            if(args[0]==="clone"&&typeof args[2]==="string")resources.add(args[2]);
            if(args[0]==="delete"&&typeof args[1]==="string"){
                if(args[1].includes("-restore-"))return {status:9,stdout:"",stderr:"candidate cleanup denied"};
                resources.delete(args[1]);
            }
            return {status:0,stdout:"restored",stderr:""};
        };
        f.ports.cloneInstance=(plan,source,target)=>f.observe(command(plan.evidence.providerCommand,["clone",source,target]));
        f.ports.deleteInstance=(plan,instance)=>f.observe(command(plan.evidence.providerCommand,["delete",instance]));
        const app=createMacosImageSnapshots(imagePorts(f,command),imageLifecycle(f));
        const result=await app.restoreSnapshot({deviceId:"unit",snapshotName:"Before"});
        expect(result?.ok).toBe(true);
        expect(f.read()).toMatchObject({status:"stopped",restoredFrom:{id:"snapshot-before",name:"Before"},
            restoreRecovery:{snapshotId:"snapshot-before",snapshotName:"Before",error:"candidate cleanup denied"}});
        expect(f.read()).not.toHaveProperty("lifecycle");
        const candidate=f.read()?.restoreRecovery?.candidateProviderInstance;
        expect(candidate).toContain("-restore-");
        expect(resources).toEqual(new Set(["ccc-owner-unit","owned-snapshot",candidate]));
    });
});

