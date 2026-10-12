import {describe,expect,it} from "vitest";
import {createIosSimulatorLifecycle} from "../../../packages/device-lab/providers/application/lifecycle/ios-simulator-lifecycle.mjs";
import {iosLifecycleClaimStatus,selectIosSimulatorMatches} from "../../../packages/device-lab/providers/domain/lifecycle/ios-simulator-lifecycle.mjs";
import type {IosSimulatorLifecyclePorts as Ports,IosSimulatorDevice as Device,IosSimulatorCommandResult as Command} from "../../../packages/device-lab/providers/ports/lifecycle/ios-simulator-lifecycle.mjs";


type Operation="create"|"start"|"stop"|"delete";
const fixedTime="2031-01-02T03:04:05.000Z";
function fixture(mode:string,operation:Operation,raw=new Error("raw-ios-native")) {
    const trace:unknown[][]=[],publications:Array<{expected:Device;replacement:Device|null}>=[],commands:string[][]=[];
    let transitions=0;
    const base:Device={id:"unit",name:"Unit",backend:"ios-simulator",ownerId:"owner",simulatorName:"ccc-owner-unit",udid:"host-udid",status:operation==="stop"?"booted":"stopped",raw:{kept:true}};
    if(/signal|wait|partial|recording|stage/.test(mode))base.recording={active:!mode.includes("pending"),pid:41,stagingPath:mode.includes("stage")?"/allocated/stage":undefined,processIdentity:{startToken:"recording"},raw:"recording-metadata"};
    if(/appium|partial/.test(mode))base.appium={runtimeId:"appium-A",processOwner:"device-lab-mcp",startedBy:mode.includes("foreign")?"external":"direct-provider",serverPid:42,processIdentity:{startToken:"appium"},serverUrl:"http://allocated/status",sessionId:"raw-session"};
    if(mode==="foreign-name")base.simulatorName="foreign-unit";
    if(mode==="name-selection"||mode==="host-empty-udid")base.udid=null;
    let current:Device|null=mode==="missing"?null:base;
    const rc=(status=0,stdout=" raw stdout ",stderr=""):Command=>({status,stdout,stderr,carrier:raw});
    const p:Ports={
        iosDeviceId(name){trace.push(["id",name]);return "ios-"+String(name).toLowerCase().replaceAll(" ","-");},
        readIosDevices(){trace.push(["read"]);return current?[current]:[];},
        findIosDevice(id){trace.push(["find",id]);if(transitions>0&&mode==="readback-absent")current=null;
            if(transitions>0&&mode==="readback-successor")current={...base,lifecycle:{runtimeId:"successor",operation:"start",claimedAt:fixedTime},raw:{winner:true}};
            return current?.id===id?current:undefined;},
        ownerSimulatorPrefix(){trace.push(["prefix"]);return "ccc-owner-";},
        slug(name){trace.push(["slug",name]);return String(name).toLowerCase().replaceAll(" ","-");},
        isOwnedSimulatorName(name){trace.push(["owned",name]);return typeof name==="string"&&name.startsWith("ccc-owner-");},
        iosDiscovery(){trace.push(["discovery"]);return mode.startsWith("no-prereq")?{available:false,xcrun:null,missing:["xcrun"]}:{available:true,xcrun:"/allocated/xcrun",missing:[]};},
        inventory(executable){trace.push(["inventory",executable]);if(mode==="inventory-error")return {kind:"failed",receipt:rc(9,"","raw inventory refusal"),message:"raw inventory refusal"};
            let host={name:"ccc-owner-unit",udid:"host-udid"};if(mode==="host-mismatch")host={...host,name:"ccc-owner-other"};if(mode==="host-empty-udid")host={...host,udid:""};
            return {kind:"listed",devices:[...(mode==="host-missing"?[]:[host]),...(mode==="host-ambiguous"?[host]:[])]};},
        createSimulator(executable,name,type,runtime){trace.push(["create",executable,name,type,runtime]);commands.push(["create",name,type,runtime]);
            if(mode==="run-throw")throw raw;
            return mode==="create-command-fail"?{kind:"failed",receipt:rc(7,"","raw create refusal"),message:"raw create refusal"}:{kind:"created",udid:"host-udid"};},
        simulatorOperation(executable,action,target){trace.push(["run",executable,action,target]);commands.push([action,target]);
            if(mode==="run-throw"||mode==="rollback-throw"&&action==="delete")throw raw;
            const failed=mode===action+"-fail"||action==="shutdown"&&mode==="delete-shutdown-fail"||action==="delete"&&mode==="rollback-fail";
            const receipt=failed?rc(7,"","raw "+action+" refusal"):rc();
            return failed?{kind:"failed",receipt,message:receipt.stderr}:{kind:"succeeded",receipt};},
        waitForBoot(executable,target,timeout){trace.push(["bootstatus",executable,target,timeout]);if(mode==="bootstatus-throw")throw raw;
            return {ready:mode!=="boot-not-ready",skipped:false,status:mode==="boot-not-ready"?4:0,stdout:"raw boot stdout",stderr:"raw boot stderr",...(mode==="boot-not-ready"?{error:raw}:{})};},
        ownerId(){trace.push(["owner"]);return "owner";},
        appiumPortForIosDevice(id){trace.push(["port",id]);return 31001;},
        claimIosDevice(device){trace.push(["claim",device]);if(mode==="claim-throw"||mode==="rollback-throw")throw raw;
            if(mode.startsWith("claim-conflict")||mode.startsWith("rollback-"))return {ok:false,field:"id",value:device.id,existing:{...base,udid:mode==="claim-conflict-same"?"host-udid":"existing-udid"}};
            current=device;return {ok:true};},
        transitionIosDevice(id,expected,replacement){trace.push(["transition",id,expected,replacement]);publications.push({expected,replacement});transitions++;
            if(mode==="transition-throw")throw raw;
            if(mode==="claim-mismatch"&&transitions===1||mode==="complete-mismatch"&&transitions===2)return {matched:false,found:true};
            if(current!==expected)return {matched:false,found:Boolean(current)};current=replacement;return {matched:true,found:true};},
        signalOwnedRuntimeProcess(recording,signal){trace.push(["signal",recording,signal]);if(mode==="signal-throw")throw raw;
            return mode==="signal-unavailable"?{signaled:false,reason:"runtime-process-identity-unavailable"}:mode==="signal-exited"?{signaled:false,reason:"runtime-process-exited"}:{signaled:true};},
        async waitForProcessExit(pid,timeout){trace.push(["wait",pid,timeout]);if(mode==="wait-throw")throw raw;return mode!=="wait-timeout";},
        inspectProcessIdentity(identity,pid){trace.push(["inspect",identity,pid]);if(mode==="inspect-throw")throw raw;return {status:mode==="appium-mismatch"?"mismatch":mode==="appium-unavailable"?"unavailable":mode==="appium-exited"?"exited":"match"};},
        async deleteAppiumSession(appium){trace.push(["delete-session",appium]);if(mode==="session-throw")throw raw;},
        async terminateOwnedAppiumProcess(appium,label,timeout){trace.push(["terminate",appium,label,timeout]);if(mode==="terminate-throw")throw raw;return mode==="appium-fail"||mode==="partial"?{exited:false,error:"raw Appium failure"}:{exited:true,signaled:true};},
        discardLocalOutputStage(file,options){trace.push(["discard",file,options]);if(mode==="stage-throw")throw raw;return mode==="stage-refusal"?{ok:false,message:"raw staged recording refusal"}:{ok:true};},
        iosRecordingDir(device){trace.push(["recording-dir",device]);return "/allocated/recording/"+device.id;},
        withTargetStatus(device){trace.push(["target-status",device]);return device;},
        runtimeId(){trace.push(["uuid"]);return "lifecycle-A";},
        wallTimestamp(){trace.push(["clock"]);return fixedTime;},
    };
    if(mode==="no-prereq-stopped")base.status="stopped";
    if(mode==="recording-refusal")base.recording={active:false,pid:41};
    if(mode==="status-refusal"||mode.startsWith("delete-shutdown")||mode==="delete-booted")base.status="booted";
    return {ports:p,trace,publications,commands,raw,base,state:()=>current};
}
describe("iOS direct lifecycle current lifecycle policy",()=>{
    it("keeps 3000ms recorder wait and its original identity-bearing recording carrier",async()=>{
        const f=fixture("signal-ok","stop");await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(f.trace).toContainEqual(["wait",41,3000]);expect(f.trace.find(row=>row[0]==="signal")?.[1]).toBe(f.base.recording);
        expect(f.state()?.recording).toMatchObject({active:false,pid:41,raw:"recording-metadata",endedAt:fixedTime});
        expect(f.trace.findIndex(row=>row[0]==="signal")).toBeLessThan(f.trace.findIndex(row=>row[0]==="run"));
    });
    it("retains truthful stop partial state after native shutdown and Appium refusal",async()=>{
        const f=fixture("partial","stop");const result=await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(result).toEqual({kind:"text",message:"raw Appium failure"});expect(f.state()).toMatchObject({status:"stopped",lifecycle:null,recording:{active:false,raw:"recording-metadata"}});
        expect(f.state()?.appium).toBe(f.base.appium);
    });
    it("matches Appium process identity before session deletion and uses the unchanged native termination default",async()=>{
        const f=fixture("appium-ok","stop");await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(f.trace.findIndex(row=>row[0]==="inspect")).toBeLessThan(f.trace.findIndex(row=>row[0]==="delete-session"));
        expect(f.trace.findIndex(row=>row[0]==="delete-session")).toBeLessThan(f.trace.findIndex(row=>row[0]==="terminate"));
        expect(f.trace.find(row=>row[0]==="terminate")?.slice(2)).toEqual(["iOS Simulator Appium",undefined]);
    });
    it("default provisioning stays definition-only and duplicate admission precedes discovery",async()=>{
        const f=fixture("definition","create");await createIosSimulatorLifecycle(f.ports).create({backend:"ios-simulator",name:"Other"});
        expect(f.commands).toEqual([]);expect(f.state()).toMatchObject({id:"ios-other",simulatorName:"ccc-owner-other",provisioning:"definition-only",status:"stopped",udid:null});
        const d=fixture("duplicate","create");await createIosSimulatorLifecycle(d.ports).create({backend:"ios-simulator",name:"Unit",deviceId:"unit"});
        expect(d.trace).toEqual([["read"]]);
    });
    it("pure domain retains original claim statuses, simulator selection and bounded refusal text",()=>{
        expect(["start","stop","delete"].map(iosLifecycleClaimStatus)).toEqual(["starting","stopping","deleting"]);
        const host={udid:"u",name:"ccc-owner-a"};expect(selectIosSimulatorMatches([host],{udid:"u",simulatorName:"different"})).toEqual([host]);
        expect(selectIosSimulatorMatches([host,host],{simulatorName:host.name})).toHaveLength(2);

    });
});

describe("iOS lifecycle identity and cleanup admission",()=>{
    it("keeps boot readiness failure distinct from a failed native boot",async()=>{
        const f=fixture("boot-not-ready","start");const result=await createIosSimulatorLifecycle(f.ports).start({deviceId:"unit",bootTimeoutMs:1234});
        expect(result).toMatchObject({kind:"json",payload:{device:{status:"starting",bootReady:false},boot:{ready:false,skipped:false,status:4,error:f.raw}}});
        expect(f.trace).toContainEqual(["bootstatus","/allocated/xcrun","host-udid",1234]);
        const failed=fixture("boot-fail","start");const refusal=await createIosSimulatorLifecycle(failed.ports).start({deviceId:"unit"});
        expect(refusal).toMatchObject({kind:"command-failure",receipt:{status:7,stderr:"raw boot refusal",carrier:failed.raw}});
        expect(failed.state()).toMatchObject({status:"stopped",raw:{kept:true}});expect(failed.state()?.lifecycle).toBeUndefined();
        expect(failed.trace.some(row=>row[0]==="bootstatus")).toBe(false);
    });
    it("compensates native boot after completion CAS refusal without replacing current metadata",async()=>{
        const f=fixture("complete-mismatch","start");const result=await createIosSimulatorLifecycle(f.ports).start({deviceId:"unit",waitForBoot:false});
        expect(result).toMatchObject({kind:"conflict",payload:{operation:"start-complete",rollback:{ok:true,receipt:{status:0,carrier:f.raw}}}});
        expect(f.commands).toEqual([["boot","host-udid"],["shutdown","host-udid"]]);
        expect(f.state()).toBe(f.publications[0]!.replacement);
    });
    it("rolls back only a newly created conflicting simulator identity",async()=>{
        for(const [mode,deleted] of [["claim-conflict-other",true],["claim-conflict-same",false]] as const){
            const f=fixture(mode,"create");const result=await createIosSimulatorLifecycle(f.ports).create({backend:"ios-simulator",name:"Other",deviceId:"other",createSimulator:true,deviceType:"type",runtime:"runtime"});
            expect(result).toEqual({kind:"text",message:"Device identity already exists for this owner (id: other)"});
            expect(f.commands).toEqual([["create","ccc-owner-other","type","runtime"],...(deleted?[["delete","host-udid"]]:[])]);
            expect(f.state()).toBe(f.base);
        }
    });
    it("retains successful recorder and Appium cleanup when native deletion fails",async()=>{
        const f=fixture("partial","delete");f.ports.terminateOwnedAppiumProcess=async()=>({exited:true});
        const native=f.ports.simulatorOperation;f.ports.simulatorOperation=(executable,action,target)=>action==="delete"?{kind:"failed",receipt:{status:9,stdout:"",stderr:"delete refusal"},message:"delete refusal"}:native(executable,action,target);
        const result=await createIosSimulatorLifecycle(f.ports).delete({deviceId:"unit",force:true,deleteSimulator:true});
        expect(result).toEqual({kind:"command-failure",receipt:{status:9,stdout:"",stderr:"delete refusal"}});
        expect(f.state()).toMatchObject({status:"stopped",lifecycle:null,appium:null,recording:{active:false,endedAt:fixedTime,raw:"recording-metadata"}});
        expect(f.trace.findIndex(row=>row[0]==="wait")).toBeLessThan(f.trace.findIndex(row=>row[0]==="inspect"));
    });
    it.each(["host-missing","host-ambiguous","host-mismatch","host-empty-udid","foreign-name"])("refuses %s before claiming or operating on a host",async mode=>{
        const f=fixture(mode,"start");const result=await createIosSimulatorLifecycle(f.ports).start({deviceId:"unit"});
        expect(result).toMatchObject({kind:"text",message:expect.stringMatching(/ownership|non-owned/)});
        expect(f.publications).toEqual([]);expect(f.commands).toEqual([]);expect(f.state()).toBe(f.base);
    });
    it("resolves a definition by its exact owned name and operates on the selected UDID",async()=>{
        const f=fixture("name-selection","start");const result=await createIosSimulatorLifecycle(f.ports).start({deviceId:"unit",waitForBoot:false});
        expect(result).toMatchObject({kind:"json",payload:{device:{status:"booted",udid:null},boot:{ready:true,skipped:true}}});
        expect(f.commands).toEqual([["boot","host-udid"]]);
    });
    it("refuses a lost initial CAS before native boot",async()=>{
        const f=fixture("claim-mismatch","start");const result=await createIosSimulatorLifecycle(f.ports).start({deviceId:"unit"});
        expect(result).toMatchObject({kind:"conflict",payload:{error:"owner-device-state-conflict",operation:"start-claim",found:true}});
        expect(f.commands).toEqual([]);expect(f.state()).toBe(f.base);
    });
    it("does not overwrite a successor when stop completion loses its generation",async()=>{
        const f=fixture("readback-successor","stop");const result=await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(result).toMatchObject({kind:"conflict",payload:{error:"owner-device-state-conflict",operation:"stop",found:true}});
        expect(f.state()).toMatchObject({lifecycle:{runtimeId:"successor"},raw:{winner:true}});expect(f.publications).toHaveLength(1);
    });
    it.each(["signal-unavailable","wait-timeout"])("preserves active recording and avoids shutdown after %s",async mode=>{
        const f=fixture(mode,"stop");const result=await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(result).toMatchObject({kind:"text",message:expect.stringMatching(/could not be safely stopped|did not exit/)});
        expect(f.commands).toEqual([]);expect(f.state()?.recording).toBe(f.base.recording);expect(f.state()?.status).toBe("booted");
    });
    it.each(["appium-mismatch","appium-unavailable"])("keeps Appium metadata and never deletes its session for %s",async mode=>{
        const f=fixture(mode,"stop");const result=await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(result).toMatchObject({kind:"text",message:expect.stringContaining("process identity could not be verified")});
        expect(f.trace.filter(row=>row[0]==="delete-session"||row[0]==="terminate")).toEqual([]);
        expect(f.state()).toMatchObject({status:"stopped",lifecycle:null});expect(f.state()?.appium).toBe(f.base.appium);
    });
    it("deletes native and metadata truthfully when recording stage cleanup refuses",async()=>{
        const f=fixture("stage-refusal","delete");const result=await createIosSimulatorLifecycle(f.ports).delete({deviceId:"unit",force:true,deleteSimulator:true});
        expect(result).toEqual({kind:"text",message:"raw staged recording refusal; simulator and device metadata were deleted, but the staged recording requires explicit recovery"});
        expect(f.state()).toBeNull();expect(f.trace.find(row=>row[0]==="discard")).toEqual(["discard","/allocated/stage",{label:"recording-local-path",stageParent:"/allocated/recording/unit",stagePrefix:".recording-stage-"}]);
    });
    it("preserves metadata for stage recovery when deleting only the definition",async()=>{
        const f=fixture("stage-refusal","delete");const result=await createIosSimulatorLifecycle(f.ports).delete({deviceId:"unit",force:true});
        expect(result).toEqual({kind:"text",message:"raw staged recording refusal; device metadata was preserved for explicit recovery"});
        expect(f.commands).toEqual([]);expect(f.state()).toMatchObject({status:"stopped",lifecycle:null,recording:{active:false,stagingPath:"/allocated/stage"}});
    });
});
