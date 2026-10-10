import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import * as path from "node:path";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const root=path.resolve(import.meta.dirname,"../../..");
const entry="packages/device-lab/providers/backends/macos-vm.mjs";
type RecordData=Record<string,any>;
type Scenario={tool:string;args:RecordData;device?:RecordData;mode?:string;provider?:string;casFailure?:number;successor?:number};
const base=()=>({id:"unit",name:"Unit",backend:"macos-vm",provider:"tart",providerInstance:"ccc-owner-unit",status:"stopped",ssh:null,headless:false,snapshots:[],recording:null,extra:{raw:true}});
function fixture(scenario:Scenario){
    const trace:unknown[]=[],denied:string[]=[],fault={raw:"native-fault"};
    let record=scenario.device?structuredClone(scenario.device):undefined,cas=0,uuid=0,clock=1791633600000;
    const timers=new Set<{active:boolean}>();
    const ownedSetTimeout=(callback:()=>void,ms:number)=>{const timer={active:true};timers.add(timer);queueMicrotask(()=>queueMicrotask(()=>{if(timer.active){clock+=ms;callback();}timers.delete(timer);}));return timer;};
    const ownedClearTimeout=(timer:{active:boolean})=>{timer.active=false;timers.delete(timer);};
    const deny=(name:string):never=>{denied.push(name);throw fault;};
    // Same two-way membrane as the admitted whole-facade shipping fixture.
    // Exports cross out once; callers pass raw args (never pre-wrap them).
    const incoming=new WeakMap<object,any>(),outgoing=new WeakMap<object,any>(),incomingOriginal=new WeakMap<object,any>(),outgoingOriginal=new WeakMap<object,any>();
    function translate(value:any,intoRealm:boolean):any{
        if(value===null||(typeof value!=="object"&&typeof value!=="function"))return value;
        const reverse=intoRealm?outgoingOriginal:incomingOriginal;if(reverse.has(value))return reverse.get(value);
        const cache=intoRealm?incoming:outgoing;if(cache.has(value))return cache.get(value);
        const convert=(item:any)=>translate(item,intoRealm),opposite=(item:any)=>translate(item,!intoRealm);
        const protectedName=(name:PropertyKey)=>["constructor","prototype","__proto__","caller","callee","arguments"].includes(String(name));
        const confinedReject=(site:string):never=>{try{return deny(site);}catch(error){throw convert(error);}};
        const check=(name:PropertyKey)=>{if(intoRealm&&protectedName(name))return confinedReject("host constructor/callee "+String(name));};
        const target:any=typeof value==="function"?(function(){}).bind(null):Array.isArray(value)?[]:Object.create(null);
        const perform=(operation:()=>any)=>{try{return convert(operation());}catch(error){throw convert(error);}};
        const view=new Proxy(target,{
            get(_target,key){check(key);return perform(()=>Reflect.get(value,key,value));},
            set(_target,key,next){check(key);return perform(()=>Reflect.set(value,key,opposite(next),value));},
            has(_target,key){check(key);return perform(()=>Reflect.has(value,key));},
            ownKeys(){try{return Reflect.ownKeys(value).filter(key=>!intoRealm||!protectedName(key));}catch(error){throw convert(error);}},
            getOwnPropertyDescriptor(_target,key){check(key);try{const descriptor=Reflect.getOwnPropertyDescriptor(value,key);if(!descriptor)return undefined;const actual=Reflect.getOwnPropertyDescriptor(target,key);const base={enumerable:descriptor.enumerable,configurable:actual?.configurable===false?false:true};return "value"in descriptor?{...base,writable:descriptor.writable,value:convert(descriptor.value)}:{...base,get:convert(descriptor.get),set:convert(descriptor.set)};}catch(error){throw convert(error);}},
            defineProperty(_target,key,descriptor){check(key);try{const copied={...descriptor};if("value"in copied)copied.value=opposite(copied.value);if("get"in copied)copied.get=opposite(copied.get);if("set"in copied)copied.set=opposite(copied.set);if(!Reflect.defineProperty(value,key,copied))return false;return descriptor.configurable===false||descriptor.configurable===undefined?Reflect.defineProperty(target,key,descriptor):true;}catch(error){throw convert(error);}},
            deleteProperty(_target,key){check(key);return perform(()=>Reflect.deleteProperty(value,key));},
            getPrototypeOf(){if(intoRealm)return confinedReject("host prototype traversal");return perform(()=>Reflect.getPrototypeOf(value));},
            setPrototypeOf(){return confinedReject("realm prototype mutation");},preventExtensions(){return confinedReject("realm capability sealing");},
            apply(_target,receiver,args){return perform(()=>Reflect.apply(value,opposite(receiver),args.map(opposite)));},
            construct(_target,args){return perform(()=>Reflect.construct(value,args.map(opposite)));},
        });cache.set(value,view);(intoRealm?incomingOriginal:outgoingOriginal).set(view,value);return view;
    }
    const intoRealm=(value:any)=>translate(value,true),fromRealm=(value:any)=>translate(value,false);
    // Bounded environment reads, including absent optional keys.
    const envValues:Record<string,string|undefined>={RAW:"exact",CCC_MACOS_VM_LIFECYCLE_CLAIM_TTL_MS:"1000",CCC_MACOS_VM_CLONE_TIMEOUT_MS:undefined,CCC_MACOS_VM_DELETE_TIMEOUT_MS:undefined,CCC_MACOS_VM_STOP_TIMEOUT_MS:undefined,CCC_MACOS_VM_IP_TIMEOUT_MS:undefined,CCC_MACOS_VM_HELPER_TIMEOUT_MS:undefined,DISPLAY:undefined};
    const environment=new Proxy(envValues,{get(target,key){if(Object.hasOwn(target,key))return Reflect.get(target,key);return deny("environment "+String(key));},set(){return deny("environment mutation");},defineProperty(){return deny("environment definition");},deleteProperty(){return deny("environment deletion");}});
    // Native cloning cannot accept the membrane's Proxy views. Resolve ONLY
    // recorded crossings in its operand, without implementing a replacement
    // clone or normalizing carriers. A replacement can contain incoming record
    // fields after a VM spread, so resolve those same tracked views temporarily.
    // The actual native primitive copies the entire graph, then descriptors are
    // restored even when that primitive throws. No getters/prototypes are read.
    const nativeClone=(value:any):any=>{
        if(!outgoingOriginal.has(value)&&!incoming.has(value))return deny("unallocated native clone operand");
        const operand=outgoingOriginal.has(value)?outgoingOriginal.get(value):value;
        const restored:Array<{object:object;key:PropertyKey;descriptor:PropertyDescriptor}>=[],seen=new Set<object>();
        const visit=(object:any,depth:number)=>{
            if(object===null||typeof object!=="object"||seen.has(object))return;
            if(depth>32||seen.size>=512)return deny("native clone operand bound");seen.add(object);
            for(const key of Reflect.ownKeys(object)){
                const descriptor=Reflect.getOwnPropertyDescriptor(object,key);if(!descriptor||!("value"in descriptor))continue;
                let field=descriptor.value;
                if(field!==null&&(typeof field==="object"||typeof field==="function")){
                    if(incomingOriginal.has(field))field=incomingOriginal.get(field);
                    else if(outgoingOriginal.has(field))field=outgoingOriginal.get(field);
                }
                if(field!==descriptor.value){
                    if(!Reflect.defineProperty(object,key,{...descriptor,value:field}))return deny("native clone crossing descriptor");
                    restored.push({object,key,descriptor});
                }
                visit(field,depth+1);
            }
        };
        try{visit(operand,0);return structuredClone(operand);}
        finally{for(const entry of restored.reverse())if(!Reflect.defineProperty(entry.object,entry.key,entry.descriptor))deny("native clone descriptor restoration");}
    };
    const guard=(name:string,values:RecordData)=>new Proxy(values,{get(target,key){if(Object.hasOwn(target,key))return target[key as string];return (..._args:unknown[])=>deny(name+"."+String(key));}});
    const textResult=(ok:boolean,text:string)=>({content:[{type:"text",text}],isError:!ok});
    const command=(command:string,args:string[],options?:unknown)=>{
        expect(["/native/"+(scenario.provider||"tart"),...(scenario.mode==="recorder-helper"?["/native/ssh"]:[])]).toContain(command);trace.push(["command",args,options]);
        if(scenario.mode==="command-throw")throw fault;
        if(args[0]==="run" && args[1]==="--help")return {status:0,stdout:"--with-softnet",stderr:""};
        if(args[0]==="ip")return scenario.mode==="ip-timeout"?{status:7,stdout:"",stderr:"no address"}:{status:0,stdout:"192.0.2.4\n",stderr:""};
        if((scenario.mode==="clone-fail"||scenario.mode==="clone-timeout")&&args[0]==="clone")
            return {status:7,stdout:"raw stdout",stderr:"raw stderr",...(scenario.mode==="clone-timeout"?{signal:"SIGTERM"}:{})};
        if((scenario.mode==="delete-fail"||scenario.mode==="claim-rollback-fail"||(scenario.mode==="primary-delete-fail"&&args[1]==="ccc-owner-unit"))&&args[0]==="delete")return {status:9,stdout:"delete stdout",stderr:"delete stderr"};
        if(scenario.mode==="stop-fail"&&args[0]==="stop")return {status:8,stdout:"stop stdout",stderr:"stop stderr"};
        return {status:0,stdout:"native stdout",stderr:"native stderr"};
    };
    const state={
        readMacosDevices:()=>{trace.push("inventory");return record?[structuredClone(record)]:[];},
        findMacosDevice:(id:string)=>{
            trace.push(["find",id]);const observed=record?.id===id?structuredClone(record):undefined;
            return observed;
        },
        claimMacosDevice:(value:RecordData)=>{
            trace.push(["claim",value]);if(scenario.mode==="claim-throw")throw fault;
            if(scenario.mode==="claim-conflict"||scenario.mode==="claim-same"||scenario.mode==="claim-rollback-fail")return {ok:false,field:"id",value:value.id,existing:scenario.mode==="claim-same"?value:{id:"successor",provider:"other",providerInstance:"different"}};
            record=nativeClone(value);return {ok:true};
        },
        transitionMacosDevice:(id:string,expected:RecordData,next:RecordData|null)=>{
            trace.push(["transition",id,expected,next]);cas++;
            if(scenario.successor===cas){record={...base(),status:"running",lifecycle:{runtimeId:"successor",operation:"start"},marker:"preserved"};return {matched:false,found:true,device:structuredClone(record)};}
            if(scenario.casFailure===cas)return {matched:false,found:Boolean(record)};
            if(!isDeepStrictEqual(record,nativeClone(expected)))return {matched:false,found:Boolean(record)};
            record=next?nativeClone(next):undefined;return {matched:true,found:true,device:record?structuredClone(record):undefined};
        },
        updateMacosDevice:()=>deny("unconditional-update"),
    };
    const fs=guard("fs",{
        constants:{O_NOFOLLOW:0},existsSync:(file:string)=>{trace.push(["exists",file]);return false;},
        mkdirSync:(file:string)=>{if(!file.startsWith("/fixture/home/"))return deny("foreign-directory");trace.push(["mkdir",file]);},
        lstatSync:(file:string)=>{if(!file.startsWith("/fixture/home"))return deny("foreign-stat");trace.push(["stat",file]);return {isDirectory:()=>true,isSymbolicLink:()=>false};},
    });
    const child={pid:71,once(event:string,callback:Function){trace.push(["once",event]);if(scenario.mode==="spawn-error"&&event==="error")queueMicrotask(()=>callback(fault));return this;},unref(){expect(this).toBe(child);trace.push("unref");}};
    const policy=guard("policy",{validateLocalReferencePath:(value:string|undefined)=>{trace.push(["key",value]);return scenario.mode==="key-refuse"?{ok:false,message:"raw-key-refusal"}:{ok:true,path:value||null};}});
    const modules:RecordData={
        fs,path,os:{homedir:()=>"/fixture/home",tmpdir:()=>deny("tmpdir")},crypto:{randomUUID:()=>{trace.push("uuid");return "generation-"+(++uuid);}},
        child_process:guard("process",{spawn:(commandName:string,args:string[],options:RecordData)=>{trace.push(["spawn",commandName,args,{...options,env:"exact-env"}]);expect(options.env).toBe(environment);if(scenario.mode==="spawn-throw")throw fault;return child;}}),
        "../commands.mjs":guard("commands",{commandPath:(name:string)=>{trace.push(["discovery",name]);return name===(scenario.provider||"tart")||(scenario.mode==="recorder-helper"&&["ssh","scp"].includes(name))?"/native/"+name:null;},run:command,runWithTimeout:command}),
        "../context.mjs":{ownerId:()=>"owner",slug:(name:string)=>name.toLowerCase().replace(/[^a-z0-9]/g,"-")},
        "../policy/files.mjs":policy,"../responses.mjs":{textResult,jsonResult:(value:unknown)=>textResult(true,JSON.stringify(value)),fail:(value:unknown)=>({rawFailure:value})},
        "../state/macos-state.mjs":state,
        "../state/device-store.mjs":{withOwnerDeviceOperation:(_backend:string,id:string,callback:()=>unknown)=>{trace.push(["lock",id]);return callback();},withOwnerDeviceOperations:()=>deny("multi-lock")},
        "../state/device-operation-policy.mjs":{requiresOwnerDeviceOperation:(_backend:string,name:string)=>["device_create","device_base_image_create","device_start","device_stop","device_delete"].includes(name)},
        "../state/process-identity.mjs":guard("identity",{signalOwnedRuntimeProcess:(recording:unknown,signal:string)=>{trace.push(["signal",recording,signal]);return {signaled:scenario.mode==="recorder-signaled"};}}),
        "../state/runtime-generation.mjs":guard("generation",{}),"../status.mjs":{withTargetStatus:(value:unknown)=>value},
        "../transfer-file.mjs":guard("transfer",{}),"../screenshot-file.mjs":guard("screenshot",{}),
        "./macos-window-focus.mjs":{MACOS_WINDOW_JXA:"immutable-unrelated"},
        "../display/desktop-input.mjs":guard("display",{}),
    };
    const allowed=new Set([entry,"packages/device-lab/providers/application/lifecycle/macos-vm-lifecycle.mjs","packages/device-lab/providers/domain/lifecycle/macos-vm-lifecycle.mjs","packages/device-lab/providers/ports/lifecycle/macos-vm-lifecycle.mjs","device-lab-mcp/src/tools.mjs","device-lab-mcp/src/operation-tools.mjs","device-lab-mcp/src/creation-input.mjs"]);
    const cache=new Map<string,RecordData>();
    const contexts=new Map<string,ReturnType<typeof createContext>>();
    function load(file:string):RecordData{
        if(!allowed.has(file))return deny("import:"+file);
        if(cache.has(file))return cache.get(file)!;
        const exports:RecordData={};cache.set(file,exports);
        const source=readFileSync(path.join(root,file),"utf8");
        const lowered=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
        class FixedDate extends Date {constructor(value?:any){super(value===undefined?clock:value);}static now(){return clock;}}
        const globals:RecordData={exports:intoRealm(exports),require:intoRealm((name:string)=>{
            if(Object.hasOwn(modules,name))return modules[name];
            if(name.startsWith("."))return load(path.posix.normalize(path.posix.join(path.posix.dirname(file),name)));
            return deny("module:"+name);
        }),Date:intoRealm(FixedDate),process:intoRealm(guard("process-global",{platform:"darwin",env:environment,kill:(pid:number,signal:number)=>{if(scenario.mode!=="recorder-signaled"||pid!==17||signal!==0)return deny("kill");trace.push(["recording-exit",pid]);throw Object.assign(Error("exited"),{code:"ESRCH"});},pid:123})),Buffer:intoRealm(Buffer),
        // The actual catalog clones realm-owned schema metadata. Resolve only
        // the same tracked crossings before using the real native clone;
        // preserve metadata/undefined values rather than normalizing them.
        structuredClone:intoRealm(nativeClone),
        setTimeout:intoRealm(ownedSetTimeout),clearTimeout:intoRealm(ownedClearTimeout),queueMicrotask:intoRealm(queueMicrotask),console:intoRealm(guard("console",{}))};
        const context=createContext(globals,{codeGeneration:{strings:false,wasm:false}});
        contexts.set(file,context);runInContext(lowered,context);
        return exports;
    }
    const api=load(entry);
    expect(denied).toEqual([]);expect(trace).toEqual([]);
    for(const value of Object.values(api))if(typeof value==="function")expect(outgoingOriginal.has(value)).toBe(true);
    const probes:Record<string,string>={filesystem:'require("fs").openSync("/foreign")',process:'require("child_process").execSync("foreign")',network:'require("node:net")',environment:'process.env.FOREIGN',constructor:'Buffer.constructor',"date-constructor":'Date.constructor',"module-constructor":'require("path").join.constructor'};
    return {api,trace,denied,fault,read:()=>record,readBack:()=>state.findMacosDevice("unit"),probe(name:string){try{return fromRealm(runInContext(probes[name],contexts.get(entry)!));}catch(error){throw fromRealm(error);}},load,async invoke(){
        let result:unknown,caught:unknown;
        try{result=await api.handleMacosTool(scenario.tool,scenario.args);}catch(error){caught=error;}
        expect(denied).toEqual([]);expect(timers.size).toBe(0);
        return {result,error:caught===fault?"raw-native-identity":caught,trace,record};
    }};
}
const cases:Array<[string,Scenario]>=[
    ["wrong backend",{tool:"device_create",args:{backend:"android-emulator",name:"Unit"}}],
    ["metadata defaults",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",deviceId:"unit"}}],
    ["duplicate before key",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",deviceId:"unit"},device:base(),mode:"key-refuse"}],
    ["key refusal",{tool:"device_create",args:{backend:"macos-vm",name:"Unit"},mode:"key-refuse"}],
    ["metadata claim exception",{tool:"device_create",args:{backend:"macos-vm",name:"Unit"},mode:"claim-throw"}],
    ["image precedence",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source",image:"ignored"}}],
    ["image alias",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",image:"source"}}],
    ["non Tart image refusal",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source",provider:"vz"},provider:"vz"}],
    ["clone failure",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source"},mode:"clone-fail"}],
    ["clone timeout compensation",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source"},mode:"clone-timeout"}],
    ["image claim exception rollback",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source"},mode:"claim-throw"}],
    ["image conflict rollback",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source"},mode:"claim-conflict"}],
    ["image conflict rollback failure",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source"},mode:"claim-rollback-fail"}],
    ["same provider conflict no delete",{tool:"device_create",args:{backend:"macos-vm",name:"Unit",sourceImage:"source"},mode:"claim-same"}],
    ["missing start",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false}}],
    ["running start refusal",{tool:"device_start",args:{deviceId:"unit"},device:{...base(),status:"running"}}],
    ["live claim refusal",{tool:"device_start",args:{deviceId:"unit"},device:{...base(),lifecycle:{runtimeId:"old",operation:"stop",claimedAt:"2026-10-10T12:00:00.000Z"}}}],
    ["stale recovery",{tool:"device_stop",args:{deviceId:"unit"},device:{...base(),lifecycle:{runtimeId:"old",operation:"stop",claimedAt:"invalid",previousStatus:"stopped"}}}],
    ["stale start recovery failure",{tool:"device_stop",args:{deviceId:"unit"},device:{...base(),lifecycle:{runtimeId:"old",operation:"start",claimedAt:"invalid"}},mode:"stop-fail"}],
    ["Tart start skip readiness",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false,headless:true},device:base()}],
    ["Tart boot IP ready",{tool:"device_start",args:{deviceId:"unit",waitForBoot:true},device:base()}],
    ["bounded IP probe timeout",{tool:"device_start",args:{deviceId:"unit",waitForBoot:true,bootTimeoutMs:1000},device:base(),mode:"ip-timeout"}],
    ["helper missing prerequisites after start",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:{...base(),ssh:{host:"guest",user:"user"}}}],
    ["VZ start",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:{...base(),provider:"vz"},provider:"vz"}],
    ["UTM start",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:{...base(),provider:"utmctl"},provider:"utmctl"}],
    ["spawn throw",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:base(),mode:"spawn-throw"}],
    ["spawn event error",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:base(),mode:"spawn-error"}],
    ["start claim conflict",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:base(),casFailure:1}],
    ["start successor preserves instance",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:base(),successor:2}],
    ["start completion conflict",{tool:"device_start",args:{deviceId:"unit",waitForBoot:false},device:base(),casFailure:3}],
    ["stopped stop",{tool:"device_stop",args:{deviceId:"unit"},device:base()}],
    ["running stop failure",{tool:"device_stop",args:{deviceId:"unit"},device:{...base(),status:"running"},mode:"stop-fail"}],
    ["recording signal order",{tool:"device_stop",args:{deviceId:"unit"},device:{...base(),status:"running",recording:{pid:17,active:false}}}],
    ["remote recording helper",{tool:"device_stop",args:{deviceId:"unit"},device:{...base(),status:"running",ssh:{host:"guest",user:"user"},recording:{pid:17,active:true,remotePath:"/tmp/raw movie.mov"}},mode:"recorder-helper"}],
    ["owned recording exit",{tool:"device_stop",args:{deviceId:"unit"},device:{...base(),status:"running",recording:{pid:17,active:false}},mode:"recorder-signaled"}],
    ["stop successor",{tool:"device_stop",args:{deviceId:"unit"},device:base(),successor:2}],
    ["delete missing",{tool:"device_delete",args:{deviceId:"unit"}}],
    ["delete running refuses",{tool:"device_delete",args:{deviceId:"unit"},device:{...base(),status:"running"}}],
    ["unmanaged deletion",{tool:"device_delete",args:{deviceId:"unit"},device:base()}],
    ["managed deletion",{tool:"device_delete",args:{deviceId:"unit"},device:{...base(),providerResourceManaged:true}}],
    ["forced stop before delete",{tool:"device_delete",args:{deviceId:"unit",force:true},device:{...base(),status:"running",providerResourceManaged:true}}],
    ["partial snapshots recovery deletion",{tool:"device_delete",args:{deviceId:"unit"},device:{...base(),providerResourceManaged:true,snapshots:[{id:"snapshot",provider:"tart",providerInstance:"snap"}],restoreRecovery:{candidateProviderInstance:"candidate",supersededCandidateProviderInstances:["older"]}}}],
    ["provider delete failure",{tool:"device_delete",args:{deviceId:"unit"},device:{...base(),providerResourceManaged:true},mode:"delete-fail"}],
    ["delete partial snapshot progress",{tool:"device_delete",args:{deviceId:"unit"},device:{...base(),providerResourceManaged:true,snapshots:[{id:"snapshot",provider:"tart",providerInstance:"snap"}]},mode:"primary-delete-fail"}],
    ["delete snapshot successor",{tool:"device_delete",args:{deviceId:"unit"},device:{...base(),providerResourceManaged:true,snapshots:[{id:"snapshot",provider:"tart",providerInstance:"snap"}]},successor:2}],
    ["delete final conflict",{tool:"device_delete",args:{deviceId:"unit"},device:base(),casFailure:2}],
];
describe("macOS current native direct lifecycle controls",()=>{
    it("native claim/readback preserves an own undefined field",async()=>{
        {
            const f=fixture({tool:"device_create",args:{backend:"macos-vm",deviceId:"unit"}});
            const outcome=await f.invoke();expect(outcome.error).toBeUndefined();
            for(const record of [f.read(),f.readBack()]){expect(Object.hasOwn(record!,"name")).toBe(true);expect(record!.name).toBeUndefined();}
            const claim=f.trace.find(entry=>Array.isArray(entry)&&entry[0]==="claim") as [string,RecordData];
            expect(Object.hasOwn(claim[1],"name")).toBe(true);expect(claim[1].name).toBeUndefined();expect(f.denied).toEqual([]);
        }
    });
    it("native stop publication retains nested undefined and structured carriers",async()=>{
        {
            const extra={absent:undefined,structured:new Map([["kept",new Set([1,2])]])};
            const f=fixture({tool:"device_stop",args:{deviceId:"unit"},device:{...base(),extra}});
            const outcome=await f.invoke();expect(outcome.error).toBeUndefined();
            const record=f.readBack()!;expect(Object.hasOwn(record.extra,"absent")).toBe(true);expect(record.extra.absent).toBeUndefined();
            expect(record.extra.structured).toBeInstanceOf(Map);expect(record.extra.structured.get("kept")).toBeInstanceOf(Set);
            expect([...record.extra.structured.get("kept")]).toEqual([1,2]);expect(f.denied).toEqual([]);
        }
    });
    it("uses actual public normalization/catalog before the retained direct handler",async()=>{
        {
            const scenario:Scenario={tool:"device_create",args:{}};const f=fixture(scenario);
            const catalog=f.load("device-lab-mcp/src/tools.mjs"),creation=f.load("device-lab-mcp/src/creation-input.mjs");
            expect(catalog.toolOperation("create_macos_vm",{})).toBe("device_create");
            expect(catalog.toolOperation("create_macos_vm",{sourceDeviceId:"source"})).toBe("device_base_image_clone");
            expect(catalog.toolOperation("start",{})).toBe("device_start");expect(catalog.toolOperation("stop",{})).toBe("device_stop");expect(catalog.toolOperation("delete",{})).toBe("device_delete");
            scenario.args=creation.normalizeCreateArgs({backend:"macos-vm",name:"Unit",image:"source",ssh:{user:"user"}});
            expect(scenario.args).toMatchObject({sourceImage:"source",sshUser:"user"});expect((await f.invoke()).error).toBeUndefined();
        }
    });
    it.each(cases)("%s preserves raw result, publication and complete native order",async(_name,scenario)=>{
        const current=await fixture(scenario).invoke();
        if(!["claim-throw","spawn-throw"].includes(scenario.mode||""))expect(current.error).toBeUndefined();
        if(scenario.mode==="claim-throw"||scenario.mode==="spawn-throw")expect(current.error).toBe("raw-native-identity");
    });
    it.each(["filesystem","process","network","environment","constructor","date-constructor","module-constructor"])("counts actual realm %s denial before caught failure",name=>{
        {
            const f=fixture({tool:"unused",args:{}});let caught:unknown;
            try{f.probe(name);}catch(error){caught=error;}
            expect(caught).toBe(f.fault);expect(f.denied).toHaveLength(1);expect(f.trace).toEqual([]);
        }
    });
});

