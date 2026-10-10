import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import { createMacosVmLifecycleApplication } from "../../../packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs";
import { managedProviderResource, macosProviderInstanceReferenced, snapshotProviderInstances, restoreRecoveryProviderInstances, macosSshConfig } from "../../../packages/device-lab/providers/domain/lifecycle/macos-vm-lifecycle.mjs";
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
        owner:()=>"owner",deviceId:()=>"unit",timestamp:()=>"2026-10-10T12:00:00.000Z",now:()=>1791633600000,runtimeId:()=>"claim",claimTtlMs:()=>1000,
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
// Independent original policy text from the whole 125324-byte admitted provider;
// it is not read from the candidate and needs no ignored artifact at runtime.
const ORIGINAL_DOMAIN="function macosProviderInstanceReferenced(device, instance) {\n    if (!device || !instance) return false;\n    if (device.providerInstance === instance || device.restoreRecovery?.candidateProviderInstance === instance) return true;\n    if ((device.restoreRecovery?.supersededCandidateProviderInstances || []).includes(instance)) return true;\n    return (device.snapshots || []).some((snapshot) => snapshot.providerInstance === instance);\n}\n\nfunction rollbackCreatedMacosResource(deviceId, plan, instance) {\n    const current = findMacosDevice(deviceId);\n    if (macosProviderInstanceReferenced(current, instance)) {\n        return { ok: false, attempted: false, reason: \"provider-instance-owned-by-successor\", providerInstance: instance };\n    }\n    const deleted = tartDeleteInstance(plan, instance);\n    return {\n        ok: deleted.status === 0,\n        attempted: true,\n        providerInstance: instance,\n        status: deleted.status,\n        stdout: deleted.stdout,\n        stderr: deleted.stderr,\n    };\n}\n\nfunction managedProviderResource(device) {\n    return Boolean(\n        device.providerResourceManaged ||\n        device.provisioning === \"image-created\" ||\n        device.provisioning === \"image-cloned\" ||\n        device.imageSource ||\n        device.clonedFrom ||\n        device.imageCreatedAt ||\n        device.clonedAt\n    );\n}\n\nfunction snapshotProviderInstances(device) {\n    return (Array.isArray(device.snapshots) ? device.snapshots : [])\n        .filter((snapshot) => snapshot.provider === \"tart\" && snapshot.providerInstance)\n        .map((snapshot) => ({ kind: \"snapshot\", id: snapshot.id, instance: snapshot.providerInstance }));\n}\n\nfunction restoreRecoveryProviderInstances(device) {\n    const recovery = device.restoreRecovery;\n    if (!recovery?.candidateProviderInstance) return [];\n    return [recovery.candidateProviderInstance, ...(recovery.supersededCandidateProviderInstances || [])]\n        .map((instance) => ({ kind: \"restore-recovery\", instance }));\n}\n";
const original=runInNewContext(ORIGINAL_DOMAIN+"\n({managedProviderResource,macosProviderInstanceReferenced,snapshotProviderInstances,restoreRecoveryProviderInstances})") as {managedProviderResource:typeof managedProviderResource;macosProviderInstanceReferenced:typeof macosProviderInstanceReferenced;snapshotProviderInstances:typeof snapshotProviderInstances;restoreRecoveryProviderInstances:typeof restoreRecoveryProviderInstances};
const ORIGINAL_SSH="function usesDefaultTartMacosCredentials({ provider, image }) {\n    const selectedProvider = !provider || provider === \"auto\" ? \"tart\" : provider;\n    if (selectedProvider !== \"tart\") return false;\n    const value = String(image || \"\");\n    return value === \"ccc-macos-base\" ||\n        /^ghcr\\.io\\/cirruslabs\\/macos-[^:]+(?:[:@].*)?$/.test(value) ||\n        /^macos-[^-]+-base$/.test(value);\n}\n\nfunction macosSshConfig({ sshHost, sshPort = 22, sshUser, sshKeyPath, sshPassword, provider, image }) {\n    const useDefaultPassword = usesDefaultTartMacosCredentials({ provider, image }) && !sshHost && !sshUser && !sshKeyPath && !sshPassword;\n    return sshHost || sshUser || sshKeyPath || sshPassword || useDefaultPassword ? {\n        host: sshHost || null,\n        port: sshPort,\n        user: sshUser || (useDefaultPassword ? \"admin\" : null),\n        keyPath: sshKeyPath || null,\n        password: sshPassword || (useDefaultPassword ? \"admin\" : null),\n    } : null;\n}\n";
const originalSsh=runInNewContext(ORIGINAL_SSH+"\nmacosSshConfig") as typeof macosSshConfig;
describe("macOS independent inward policy controls",()=>{
    it("constructs without looking up or invoking any native leaf",()=>{
        const touched:string[]=[];const ports=new Proxy({},{get(_target,key){touched.push(String(key));throw Error("eager-native-observation");}}) as MacosVmLifecyclePorts<Result,MacosVmProcessHandle>;
        createMacosVmLifecycleApplication(ports);expect(touched).toEqual([]);
    });
    it("keeps domain imports free of effect authorities",()=>{
        const file=path.resolve(import.meta.dirname,"../../../packages/device-lab/providers/domain/lifecycle/macos-vm-lifecycle.mjs");
        const source=readFileSync(file,"utf8");expect(source).not.toMatch(/^import\s/m);expect(source).not.toMatch(/\b(?:process|spawn|readFileSync|writeFileSync)\b/);
    });
    it.each([
        {id:"unit"}, {id:"unit",providerResourceManaged:true}, {id:"unit",provisioning:"image-created"},
        {id:"unit",imageSource:"source"}, {id:"unit",clonedFrom:"parent"}, {id:"unit",providerInstance:"instance"},
        {id:"unit",snapshots:[{id:"first",provider:"tart",providerInstance:"instance"},{id:"ignored",provider:"vz",providerInstance:"other"}]},
        {id:"unit",restoreRecovery:{candidateProviderInstance:"candidate",supersededCandidateProviderInstances:["older","instance"]}},
    ] satisfies MacosVmDevice[])("matches frozen managed-resource/snapshot/recovery policy for %j",device=>{
        expect(managedProviderResource(device)).toBe(original.managedProviderResource(device));
        expect(snapshotProviderInstances(device)).toEqual(original.snapshotProviderInstances(device));
        expect(restoreRecoveryProviderInstances(device)).toEqual(original.restoreRecoveryProviderInstances(device));
        for(const instance of ["instance","candidate","older","unrelated",""])expect(macosProviderInstanceReferenced(device,instance)).toBe(original.macosProviderInstanceReferenced(device,instance));
    });
    it("metadata create is synchronous and claim raw exceptions preserve identity",()=>{
        const f=nativeLeaves();f.ports.claim=()=>{throw f.fault;};
        let error:unknown;try{createMacosVmLifecycleApplication(f.ports).create({backend:"macos-vm",name:"Unit"});}catch(value){error=value;}
        expect(error).toBe(f.fault);expect(f.trace).toEqual(["read"]);expect(f.read()).toBeUndefined();
    });
    it.each([{provider:"auto",image:null},{provider:"tart",image:"ccc-macos-base"},{provider:"auto",image:"ghcr.io/cirruslabs/macos-sonoma-base:latest"},{provider:"vz",image:"ccc-macos-base"},{provider:"tart",image:"custom",sshUser:"user",sshHost:"guest"},{provider:"tart",image:"ccc-macos-base",sshPassword:"raw-secret",sshPort:2222}])("preserves frozen SSH defaults/redirection %j",input=>{
        expect(macosSshConfig(input)).toEqual(originalSsh(input));
    });
    it("required leaf getters are lazy and imported native calls preserve their bare receiver",()=>{
        const f=nativeLeaves();Object.defineProperty(f.ports,"read",{get(){f.trace.push("get-read");return function(this:unknown){expect(this).toBeUndefined();f.trace.push("read");return [];};}});
        const app=createMacosVmLifecycleApplication(f.ports);expect(f.trace).toEqual([]);
        app.create({backend:"macos-vm",name:"Unit"});expect(f.trace.slice(0,2)).toEqual(["get-read","read"]);
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

