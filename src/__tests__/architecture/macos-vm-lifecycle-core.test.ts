import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { createMacosVmLifecycleApplication } from "../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs";
import type { MacosVmLifecyclePorts, MacosVmDevice, MacosVmProcessHandle } from "../../../packages/device-lab/providers/ports/lifecycle/macos-vm-lifecycle.mjs";

type Result={ok:boolean;value:unknown};
function nativeLeaves(initial?:MacosVmDevice){
    let current=initial;const trace:string[]=[],fault={native:"raw claim failure"};
    const child={pid:71,unref(){expect(this).toBe(child);trace.push("unref");}};
    const plan={available:true,missing:[],selectedProvider:"tart",providerCommand:"/native/tart",providerInstance:"ccc-owner-unit",startCommand:{command:"/native/tart",args:["run","ccc-owner-unit"]},stopCommand:{command:"/native/tart",args:["stop","ccc-owner-unit"]}};
    const ports:MacosVmLifecyclePorts<Result,typeof child>={
        read(){trace.push("read");return current?[current]:[];},find(){trace.push("find");return current||null;},
        claim(device){trace.push("claim");current=device;return {ok:true};},
        transition(_id,expected,replacement){trace.push("transition");if(current!==expected)return {matched:false,found:Boolean(current),device:current!};current=replacement||undefined;return {matched:true,found:true,device:current!};},
        owner:()=>"owner",deviceId:()=>"unit",timestamp:()=>"2026-10-10T12:00:00.000Z",now:()=>1791633600000,runtimeId:()=>"claim",claimTtlMs:()=>1000,parseLifecycleClaimedAt:value=>Date.parse(value),
        validateSshKey:()=>({ok:true,path:null}),helperMetadata:()=>({}),
        providerPlan:()=>plan,tartPlan:()=>({plan}),publicDevice:device=>device,
        providerCommand(_command,args){trace.push(args.join(" "));return {status:0,stdout:"raw out",stderr:"raw err"};},
        commandTimedOut:result=>result.signal==="SIGTERM",tartStartArgs:()=>["run","ccc-owner-unit"],supportsFeature:()=>true,
        spawn(){trace.push("spawn");return child;},async waitProviderStart(value){expect(value).toBe(child);trace.push("wait-start");return null;},
        async waitBoot(){trace.push("boot");return {ready:true,ip:"192.0.2.4"};},
        async waitGuestHelper(){trace.push("guest-helper");return {ok:true};},provisionHelper(){trace.push("provision");return {ok:true,skipped:true};},
        signalRecording(){trace.push("recording-signal");return {signaled:false};},async waitRecordingExit(){trace.push("recording-wait");return true;},
        sshBridge:()=>({discovery:{ssh:"ssh"},target:"host"}),sshBaseArgs:()=>[],shellQuote:value=>"'"+value+"'",sshCommandOptions:()=>({}),
        helperCommand:()=>({status:0,stdout:"",stderr:""}),textResult:(ok,value)=>({ok,value}),jsonResult:value=>({ok:true,value}),fail:value=>({ok:false,value}),
    };
    return {ports,trace,fault,child,read:()=>current,replace:(value:MacosVmDevice)=>{current=value;}};
}
describe("macOS independent inward policy controls",()=>{
    it("constructs without looking up or invoking any native leaf",()=>{
        const touched:string[]=[];const ports=new Proxy({},{get(_target,key){touched.push(String(key));throw Error("eager-native-observation");}}) as MacosVmLifecyclePorts<Result,MacosVmProcessHandle>;
        createMacosVmLifecycleApplication(ports);expect(touched).toEqual([]);
    });
    it("keeps domain imports free of effect authorities",()=>{
        const file=path.resolve(import.meta.dirname,"../../../packages/device-lab/providers/domain/lifecycle/macos-vm-lifecycle.mjs");
        const source=readFileSync(file,"utf8");expect(source).not.toMatch(/^import\s/m);expect(source).not.toMatch(/\b(?:process|spawn|readFileSync|writeFileSync)\b/);
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
        expect(result?.ok).toBe(true);expect(f.trace.indexOf("spawn")).toBeLessThan(f.trace.indexOf("wait-start"));
        expect(f.trace.indexOf("wait-start")).toBeLessThan(f.trace.indexOf("unref"));expect(f.trace).not.toContain("boot");
        expect(f.read()).toMatchObject({status:"running",runtime:{providerPid:71},bootReady:false});expect(f.read()).not.toHaveProperty("lifecycle");
    });
    it("a successor prevents runtime publication and guarded rollback from stopping its instance",async()=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart"});
        f.ports.waitProviderStart=async()=>{f.replace({id:"unit",status:"running",providerInstance:"ccc-owner-unit",lifecycle:{runtimeId:"successor",operation:"start",claimedAt:"now"}});return null;};
        const result=await createMacosVmLifecycleApplication(f.ports).start({deviceId:"unit",waitForBoot:false});
        expect(result?.ok).toBe(false);expect(f.read()?.lifecycle?.runtimeId).toBe("successor");expect(f.trace).not.toContain("stop ccc-owner-unit");
    });
    it("stop clears runtime and recording only after the native stop result",async()=>{
        const f=nativeLeaves({id:"unit",status:"running",provider:"tart",providerInstance:"ccc-owner-unit",runtime:{providerPid:71},recording:{pid:17,active:false}});
        const result=await createMacosVmLifecycleApplication(f.ports).stop({deviceId:"unit"});
        expect(result?.ok).toBe(true);expect(f.trace.indexOf("stop ccc-owner-unit")).toBeLessThan(f.trace.indexOf("recording-signal"));
        expect(f.read()).toMatchObject({status:"stopped",runtime:null,recording:null,bootReady:false});
    });
    it.each(["boot-failure","helper-failure"])("publishes truthful started partial fields on %s",async mode=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart",ssh:{user:"user",host:null}});
        f.ports.waitBoot=async(_plan,timeout,deadline)=>{expect(timeout).toBe(900000);expect(deadline).toBe(1791634200000);return mode==="boot-failure"?{ready:false,error:"raw-ip-failure"}:{ready:true,ip:"192.0.2.4"};};
        f.ports.waitGuestHelper=async()=>mode==="helper-failure"?{ok:false,error:"raw-helper-failure",provisioning:{status:"failed"}}:{ok:true};
        const result=await createMacosVmLifecycleApplication(f.ports).start({deviceId:"unit",waitForBoot:true,bootTimeoutMs:900000});
        expect(result?.ok).toBe(false);expect(f.read()?.status).toBe(mode==="boot-failure"?"starting":"running");expect(f.read()).not.toHaveProperty("lifecycle");
        expect(f.read()?.runtime?.providerPid).toBe(71);if(mode==="helper-failure")expect(f.read()?.ssh?.host).toBe("192.0.2.4");
    });
    it("managed deletion records already-completed snapshot progress when a later delete fails",async()=>{
        const f=nativeLeaves({id:"unit",status:"stopped",provider:"tart",providerResourceManaged:true,providerInstance:"ccc-owner-unit",snapshots:[{id:"snapshot",provider:"tart",providerInstance:"snap"}]});
        f.ports.providerCommand=(_command,args)=>{f.trace.push(args.join(" "));return {status:args[1]==="ccc-owner-unit"?9:0,stdout:"raw out",stderr:"raw err"};};
        const result=await createMacosVmLifecycleApplication(f.ports).delete({deviceId:"unit"});
        expect(result?.ok).toBe(false);expect(f.trace.filter(value=>value.startsWith("delete"))).toEqual(["delete snap","delete ccc-owner-unit"]);
        expect(f.read()?.snapshots).toEqual([]);expect(f.read()?.status).toBe("stopped");
    });
});

