import {describe,expect,it} from "vitest";
import {createIosSimulatorLifecycle} from "../../../packages/device-lab/providers/application/lifecycle/ios-simulator-lifecycle.mjs";
import {iosLifecycleClaimStatus,boundedSimulatorIdentityDetail,iosSimulatorCommandFailed,selectIosSimulatorMatches} from "../../../packages/device-lab/providers/domain/lifecycle/ios-simulator-lifecycle.mjs";
import type {IosSimulatorLifecyclePorts as Ports,IosSimulatorDevice as Device,IosSimulatorCommandResult as Command} from "../../../packages/device-lab/providers/ports/lifecycle/ios-simulator-lifecycle.mjs";

type Reply={ok:boolean;text?:string;payload?:any;command?:Command};
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
    const p:Ports<Reply>={
        iosDeviceId(name){trace.push(["id",name]);return "ios-"+String(name).toLowerCase().replaceAll(" ","-");},
        readIosDevices(){trace.push(["read"]);return current?[current]:[];},
        findIosDevice(id){trace.push(["find",id]);if(transitions>0&&mode==="readback-absent")current=null;
            if(transitions>0&&mode==="readback-successor")current={...base,lifecycle:{runtimeId:"successor",operation:"start",claimedAt:fixedTime},raw:{winner:true}};
            return current?.id===id?current:undefined;},
        ownerSimulatorPrefix(){trace.push(["prefix"]);return "ccc-owner-";},
        slug(name){trace.push(["slug",name]);return String(name).toLowerCase().replaceAll(" ","-");},
        isOwnedSimulatorName(name){trace.push(["owned",name]);return typeof name==="string"&&name.startsWith("ccc-owner-");},
        iosDiscovery(){trace.push(["discovery"]);return mode.startsWith("no-prereq")?{available:false,xcrun:null,missing:["xcrun"]}:{available:true,xcrun:"/allocated/xcrun",missing:[]};},
        simctlJson(executable,args){trace.push(["inventory",executable,args]);if(mode==="inventory-error")return {error:rc(9,""," raw inventory refusal ")};
            let host={name:"ccc-owner-unit",udid:"host-udid"};if(mode==="host-mismatch")host={...host,name:"ccc-owner-other"};if(mode==="host-empty-udid")host={...host,udid:""};
            return {value:{devices:{"runtime":[...(mode==="host-missing"?[]:[host]),...(mode==="host-ambiguous"?[host]:[])]}}};},
        run(executable,args){trace.push(["run",executable,args]);commands.push(args.map(String));const action=args[1];
            if(mode==="run-throw"||mode==="rollback-throw"&&action==="delete")throw raw;
            if(action==="create")return mode==="create-command-fail"?rc(7,""," raw create refusal "):rc(0," host-udid \n");
            if(action==="boot")return mode==="boot-fail"?rc(7,"","raw boot refusal"):mode==="boot-already"?rc(7,"","Unable to boot device in current state: Booted"):rc();
            if(action==="shutdown")return mode==="shutdown-fail"||mode==="delete-shutdown-fail"?rc(7,"","raw shutdown refusal"):mode==="shutdown-already"||mode==="delete-shutdown-already"?rc(7,"","Unable to shutdown device in current state: Shutdown"):rc();
            if(action==="delete")return mode==="delete-fail"||mode==="rollback-fail"?rc(7,"","raw delete refusal"):mode==="delete-invalid"||mode==="rollback-invalid"?rc(7,"","Invalid device"):rc();
            throw Error("unallocated command "+action);},
        runWithTimeout(executable,args,timeout){trace.push(["bootstatus",executable,args,timeout]);if(mode==="bootstatus-throw")throw raw;
            return mode==="boot-not-ready"?{...rc(4,"raw boot stdout","raw boot stderr"),error:raw}:rc(0,"raw boot stdout","raw boot stderr");},
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
        textResult(ok,text){trace.push(["text",ok,text]);return {ok,text};},
        jsonResult(payload){trace.push(["json",payload]);return {ok:true,payload};},
        fail(command){trace.push(["failure",command]);return {ok:false,command};},
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
        expect(result).toEqual({ok:false,text:"raw Appium failure"});expect(f.state()).toMatchObject({status:"stopped",lifecycle:null,recording:{active:false,raw:"recording-metadata"}});
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
        expect(d.trace).toEqual([["read"],["text",false,"Device already exists for this owner: unit"]]);
    });
    it("pure domain retains original claim statuses, simulator selection and bounded refusal text",()=>{
        expect(["start","stop","delete"].map(iosLifecycleClaimStatus)).toEqual(["starting","stopping","deleting"]);
        const host={udid:"u",name:"ccc-owner-a"};expect(selectIosSimulatorMatches({r:[host]},{udid:"u",simulatorName:"different"})).toEqual([host]);
        expect(selectIosSimulatorMatches({r:[host,host]},{simulatorName:host.name})).toHaveLength(2);
        expect(boundedSimulatorIdentityDetail(" "+ "x".repeat(4097)+" ")).toBe("x".repeat(4096)+"...");
        for(const [operation,message]of [["boot","Unable to boot device in current state: Booted"],["shutdown","Unable to shutdown device in current state: Shutdown"],["delete","Invalid device"]] as const){
            expect(iosSimulatorCommandFailed({status:1,stderr:message,stdout:""},operation)).toBe(false);
            expect(iosSimulatorCommandFailed({status:1,stderr:"raw failure",stdout:""},operation)).toBe(true);
        }
    });
});
