import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as url from "node:url";
import { isDeepStrictEqual } from "node:util";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

const root=path.resolve(import.meta.dirname,"../../.."),entry="device-lab-broker.ts",owner="0123456789abcdef";
type Data=Record<string,any>;
type Scenario={params:Data;device?:Data;mode?:string;addresses?:string[];probeCost?:number};
const device=():Data=>({id:"unit",name:"Unit",backend:"macos-vm",provider:"tart",providerInstance:"owned-unit",status:"stopped",recording:null,extra:{absent:undefined,structured:new Map([["kept",new Set([1,2])]])}});
function fixture(scenario:Scenario){
    const trace:unknown[]=[],denied:string[]=[];
    let fault:any,clock=1791633600000,record=scenario.device?structuredClone(scenario.device):undefined,reads=0,writes=0,probes=0;
    const stateFile="/fixture/home/.ccc/devices/owners/"+owner+"/macos/devices.json";
    const deny=(name:string):never=>{denied.push(name);throw fault;};
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
            defineProperty(_target,key,descriptor){check(key);try{const copied={...descriptor};if("value"in copied)copied.value=opposite(copied.value);if("get"in copied)copied.get=opposite(copied.get);if("set"in copied)copied.set=opposite(copied.set);
                if(!Reflect.defineProperty(value,key,copied))return false;
                // Match the existing iOS facade membrane: immutable CJS export
                // descriptors also exist on the target, with their viewed values
                // and attributes, so defineProperty/get obey Proxy invariants.
                return descriptor.configurable===false||descriptor.configurable===undefined?Reflect.defineProperty(target,key,descriptor):true;
            }catch(error){throw convert(error);}},
            deleteProperty(_target,key){check(key);return perform(()=>Reflect.deleteProperty(value,key));},
            getPrototypeOf(){if(intoRealm)return confinedReject("host prototype traversal");return perform(()=>Reflect.getPrototypeOf(value));},
            setPrototypeOf(){return confinedReject("realm prototype mutation");},preventExtensions(){return confinedReject("realm capability sealing");},
            apply(_target,receiver,args){return perform(()=>Reflect.apply(value,opposite(receiver),args.map(opposite)));},
            construct(_target,args){return perform(()=>Reflect.construct(value,args.map(opposite)));},
        });cache.set(value,view);(intoRealm?incomingOriginal:outgoingOriginal).set(view,value);return view;
    }
    const intoRealm=(value:any)=>translate(value,true),fromRealm=(value:any)=>translate(value,false);

    const nativeClone=(value:any):any=>{
        if(value===null||typeof value!=="object")return structuredClone(value);
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

    const guard=(name:string,values:Data={})=>new Proxy(values,{get(target,key){if(Object.hasOwn(target,key))return Reflect.get(target,key);return (..._args:unknown[])=>deny(name+"."+String(key));}});
    const envValues:Record<string,string|undefined>={HOME:"/fixture/home",USERPROFILE:"/fixture/home",PATH:"/native",CCC_PROFILE:undefined};
    const environment=new Proxy(envValues,{get(target,key){if(Object.hasOwn(target,key))return Reflect.get(target,key);return deny("environment "+String(key));},set(){return deny("environment mutation");}});
    const nativeData=(value:any)=>value===null||typeof value!=="object"?structuredClone(value):outgoingOriginal.has(value)||incoming.has(value)?nativeClone(value):structuredClone(value);
    const sourceFile=(file:string)=>path.join(root,"packages/device-lab/src",file);
    const checkFile=(file:string)=>{if(file!==stateFile&&!file.startsWith("/fixture/home/.ccc/devices/owners/"+owner+"/macos/"))return deny("state path "+file);};
    const ownerState=guard("owner-state",{
        readOwnerDeviceStateFile(file:string,limit:number){checkFile(file);expect(limit).toBe(256*1024);reads++;trace.push(["read",file]);
            if(scenario.mode==="cleanup-successor"&&reads===2)record={...device(),marker:"successor",status:"running"};
            return record?[structuredClone(record)]:[];
        },
        assertOwnerDeviceStateWritable(values:any,limit:number){expect(limit).toBe(256*1024);trace.push(["writable",nativeData(values)]);},
        ownerDeviceStateErrorCode(error:any){return error===fault&&scenario.mode==="claim-state-error"?"owner-devices-state-read-failed":null;},
    });
    const state=guard("state",{
        withSharedMutationLock(file:string,callback:()=>unknown,options?:unknown){checkFile(file);trace.push(["lock",file,nativeData(options)]);return callback();},
        withSharedMutationLockAsync(file:string,callback:()=>unknown,options:unknown){checkFile(file);trace.push(["operation-lock",file,nativeData(options)]);return callback();},
        writeJsonFileAtomically(file:string,value:any){checkFile(file);writes++;trace.push(["write",file,nativeData(value)]);
            if(["claim-throw","claim-state-error","claim-rollback-fail"].includes(scenario.mode||"")&&writes===1)throw fault;
            const copied=nativeData(value);record=copied.devices[0];
        },
    });
    const execute=(command:any,options:any)=>{
        const observed=nativeData(command),limits=nativeData(options);
        if(observed.mode==="noop"||observed.provider==="host-broker-state"){
            const expected={mode:"noop",provider:"host-broker-state",reason:"Stopped macOS VM delete without providerInstance deletes only owner broker metadata"};
            const ownedStoppedInput=isDeepStrictEqual(scenario.params,{backend:"macos-vm",command:"device_delete",deviceId:"unit"})&&scenario.mode===undefined
                &&scenario.device?.id==="unit"&&scenario.device.backend==="macos-vm"&&scenario.device.status==="stopped"
                &&Object.hasOwn(scenario.device,"providerInstance")&&scenario.device.providerInstance===undefined
                &&record?.id==="unit"&&record.status==="stopped"&&record.providerInstance===undefined&&isDeepStrictEqual(record,scenario.device);
            if(!ownedStoppedInput||!isDeepStrictEqual(observed,expected)||!isDeepStrictEqual(limits,{timeoutMs:2300,outputLimit:32*1024}))return deny("unallocated metadata-only delete noop");
        }
        trace.push(["command",observed,limits]);
        if(observed.mode!=="noop")expect(["tart","vz","utmctl"]).toContain(observed.provider);expect(limits.outputLimit).toBe(32*1024);expect(limits.timeoutMs).toBeGreaterThanOrEqual(0);expect(limits.timeoutMs).toBeLessThanOrEqual(2300);
        if(scenario.mode==="command-throw")throw fault;
        if(scenario.mode==="successor")record={...device(),marker:"successor",status:"running"};
        if(observed.args?.[0]==="clone"&&["claim-conflict","claim-same"].includes(scenario.mode||""))record=scenario.mode==="claim-same"?{...device(),providerInstance:observed.args[2]}:{...device(),providerInstance:"successor-other"};
        let status=0,stdout="raw native stdout",stderr="raw native stderr";
        if(observed.args?.[0]==="ip"){stdout=scenario.addresses?.[probes++]||"";clock+=scenario.probeCost||0;}
        if(scenario.mode==="command-failure")status=17;
        if(scenario.mode==="missing-resource"&&observed.args?.[0]==="delete"){status=1;stderr="VM does not exist";}
        if(scenario.mode==="claim-rollback-fail"&&observed.args?.[0]==="delete")status=9;
        return {...observed,status,stdout,stderr,pid:71,raw:undefined};
    };
    const modules:Data={
        crypto,path,url,util:{isDeepStrictEqual:(left:any,right:any)=>isDeepStrictEqual(nativeData(left),nativeData(right))},
        os:guard("os",{homedir:()=>"/fixture/home"}),fs:guard("filesystem",{constants:{X_OK:1},accessSync:(file:string)=>{if(!["/native/tart","/native/vz","/native/utmctl"].includes(file))return deny("foreign executable");}}),
        child_process:guard("process"),http:guard("network"),worker_threads:guard("worker"),
        "./device-lab-owner-state.js":ownerState,"./device-lab-shared-state.js":state,
    };
    const captured=new Set(["device-lab/application/broker-observation-inventory.ts","device-lab/application/broker-observation-leases.ts","device-lab/application/broker-observation-appium.ts","device-lab/application/broker-observation-status.ts","device-lab/application/broker-observation-command-plan.ts","device-lab/domain/broker-observation.ts","device-lab/broker/hyper-v/deadline.ts"]);
    const newModules=new Set(["device-lab/application/lifecycle/macos-vm-lifecycle.ts","device-lab/domain/lifecycle/macos-vm-lifecycle.ts","device-lab/ports/lifecycle/macos-vm-lifecycle.ts"]);
    const cache=new Map<string,Data>();
    class FixedDate extends Date{constructor(value?:any){super(value===undefined?clock:value);}static now(){return clock;}}
    const context=createContext({
        Date:intoRealm(FixedDate),Buffer:intoRealm(Buffer),structuredClone:intoRealm(nativeData),
        process:intoRealm(guard("process-global",{platform:"darwin",env:environment,pid:123,cwd:()=>"/fixture/project"})),
        Atomics:intoRealm(guard("pacing",{wait:(_array:unknown,index:number,expected:number,ms:number)=>{expect(index).toBe(0);expect(expected).toBe(0);expect(ms).toBeGreaterThanOrEqual(0);expect(ms).toBeLessThanOrEqual(5000);trace.push(["sleep",ms]);clock+=ms;return "timed-out";}})),
        console:intoRealm(guard("console")),setTimeout:intoRealm(()=>deny("timer")),setInterval:intoRealm(()=>deny("interval")),
    },{codeGeneration:{strings:false,wasm:false}});
    // Native leaf faults are actual allocated realm carriers, preserving exact
    // identity through catch/instanceof boundaries without a host prototype grant.
    fault=fromRealm(runInContext("({native:'raw-fault'})",context));
    function resolve(name:string,parent:string){
        if(name.startsWith("."))return path.posix.normalize(path.posix.join(path.posix.dirname(parent),name)).replace(/\.js$/,".ts");
        return name;
    }
    function requireFor(parent:string){return (name:string):unknown=>{
        const nativeName=name.startsWith("node:")?name.slice(5):name;
        if(Object.hasOwn(modules,name))return modules[name];if(Object.hasOwn(modules,nativeName))return modules[nativeName];
        if(["net","http","https"].includes(nativeName))return deny("network import "+name);
        const file=resolve(name,parent);if(file===entry||captured.has(file)||newModules.has(file))return load(file);
        // Unrelated prelude imports are inert, denied native leaves; no selected
        // policy/guard is substituted and any accidental invocation is counted.
        if(name.startsWith(".")||name.startsWith("@ccc/"))return guard("unrelated "+file);
        return deny("unadmitted import "+name);
    };}
    // Bind only compiler module metadata; preserve the entire immutable source.
    function bindBrokerModuleUrl(source:string,file:string){
        const parsed=ts.createSourceFile(file,source,ts.ScriptTarget.ES2022,true,ts.ScriptKind.TS);
        let replacements=0;
        const transformer:ts.TransformerFactory<ts.SourceFile>=context=>{
            const visit:ts.Visitor=node=>{
                if(ts.isPropertyAccessExpression(node)&&ts.isMetaProperty(node.expression)
                    &&node.expression.keywordToken===ts.SyntaxKind.ImportKeyword
                    &&node.expression.name.text==="meta"&&node.name.text==="url"&&!node.questionDotToken){
                    replacements++;
                    return context.factory.createStringLiteral(url.pathToFileURL(sourceFile(file)).href);
                }
                if(ts.isMetaProperty(node)&&node.keywordToken===ts.SyntaxKind.ImportKeyword)throw Error("unadmitted broker import.meta metadata");
                return ts.visitEachChild(node,visit,context);
            };
            return node=>ts.visitNode(node,visit) as ts.SourceFile;
        };
        const transformed=ts.transform(parsed,[transformer]);
        try{expect(replacements).toBe(file===entry?5:0);return ts.createPrinter().printFile(transformed.transformed[0]);}
        finally{transformed.dispose();}
    }
    function load(file:string):Data{
        if(cache.has(file))return cache.get(file)!;
        const exports:Data={};cache.set(file,exports);
        const source=readFileSync(sourceFile(file),"utf8");
        const hook=file===entry?"\nexports.__macosFixture={invoke:lifecycleCommandInvoke,unlocked:lifecycleCommandInvokeUnlocked,parse:validateCommandParams,record:createOwnerDeviceRecord,planCreate:providerCommandForCreate,planExisting:providerCommandFor};":"";
        const lowered=ts.transpileModule(bindBrokerModuleUrl(source,file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
        const wrapper=fromRealm(runInContext("(function(exports,require){"+lowered+hook+"\n})",context));wrapper(exports,requireFor(file));return exports;
    }
    (context as Data).require=intoRealm(requireFor(entry));
    const facade=load(entry),api=facade.__macosFixture;
    expect(denied).toEqual([]);expect(trace).toEqual([]);expect(outgoingOriginal.has(api.invoke)).toBe(true);
    const normalized={cwd:"/fixture/project",host:"127.0.0.1",port:0,profile:undefined,platform:"darwin",providerPaths:{tart:"/native/tart",vz:"/native/vz",utmctl:"/native/utmctl"},usesDefaultCommandRunner:false,commandTimeoutMs:2300,commandRunner:execute};
    const programs:Record<string,string>={filesystem:'require("fs").openSync("/foreign")',process:'require("child_process").spawn("/foreign",[])',network:'require("node:net")',environment:'process.env.FOREIGN',constructor:'Buffer.constructor',"date-constructor":'Date.constructor',"module-constructor":'require("path").join.constructor',"global-timer":'globalThis.setTimeout(()=>{},1)'};
    return {api,facade,trace,denied,fault,normalized,read:()=>record,probeUnknownNoop:()=>execute({mode:"noop",provider:"host-broker-state",reason:"unallocated noop",args:["unallocated"]},{timeoutMs:2300,outputLimit:32*1024}),probe(name:string){try{return fromRealm(runInContext(programs[name],context));}catch(error){throw fromRealm(error);}},
        async invoke(){let result:any,caught:any;try{result=await (0,api.invoke)(owner,scenario.params,normalized);}catch(error){caught=error;}
            expect(denied).toEqual([]);return {result:result===undefined?undefined:nativeData(result),error:caught===fault?"raw-native-identity":caught,trace,record:record?structuredClone(record):undefined};
        }};
}
const cases:Array<[string,Scenario]>=[
    ["invalid backend",{params:{backend:"unknown",command:"device_start",deviceId:"unit"}}],
    ["invalid command",{params:{backend:"macos-vm",command:"unknown",deviceId:"unit"}}],
    ["metadata-only auto",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit"}}],
    ["metadata-only VZ",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",provider:"vz",image:"ignored"}}],
    ["metadata-only UTM",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",provider:"utmctl"}}],
    ["unsupported create provider",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",provider:"other"}}],
    ["Tart image clone",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"ccc-macos-base"}}],
    ["explicit SSH carriers",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base",headless:true,cpus:7,sshHost:"guest",sshPort:2222,sshUser:"user",sshPassword:"secret"}}],
    ["duplicate create refuses",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit"},device:device()}],
    ["dry-run create",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base",dryRun:true}}],
    ["create raw failure",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base"},mode:"command-failure"}],
    ["create raw throw",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base"},mode:"command-throw"}],
    ["claim throw compensates",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base"},mode:"claim-throw"}],
    ["claim state failure compensates",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base"},mode:"claim-state-error"}],
    ["claim rollback failure",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base"},mode:"claim-rollback-fail"}],
    ["claim provider identity conflict",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base"},mode:"claim-conflict"}],
    ["existing provider same instance retained",{params:{backend:"macos-vm",command:"device_create",name:"Unit",deviceId:"unit",image:"base"},mode:"claim-same"}],
    ["missing start",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit"}}],
    ["Tart detached headless",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",headless:true},device:device()}],
    ["headless explicit override",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",headless:false},device:{...device(),headless:true}}],
    ["VZ exec start",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit"},device:{...device(),provider:"vz"}}],
    ["UTM exec start",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit"},device:{...device(),provider:"utmctl"}}],
    ["start missing instance",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit"},device:{...device(),providerInstance:undefined}}],
    ["start raw failure",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit"},device:device(),mode:"command-failure"}],
    ["start raw throw",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit"},device:device(),mode:"command-throw"}],
    ["wait explicitly false",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:false},device:device()}],
    ["wait string true omitted by validator",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:"true"},device:device()}],
    ["first IP ready",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true},device:device(),addresses:["192.0.2.4\n"]}],
    ["ARP IP ready",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true},device:device(),addresses:["","192.0.2.5\n"]}],
    ["IP last-four retained",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true},device:device(),addresses:["","","","","192.0.2.6\n"]}],
    ["IP minimum timeout",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true,bootTimeoutMs:1},device:device()}],
    ["IP last-eight/default bound",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true},device:device()}],
    ["IP maximum bound",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true,bootTimeoutMs:900000},device:device(),probeCost:100000}],
    ["IP second probe beyond deadline preserved",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true,bootTimeoutMs:1000},device:device(),probeCost:1001}],
    ["nonTart wait skipped",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit",waitForBoot:true},device:{...device(),provider:"vz"}}],
    ["start successor CAS refusal",{params:{backend:"macos-vm",command:"device_start",deviceId:"unit"},device:device(),mode:"successor"}],
    ["stop whole-record carrier",{params:{backend:"macos-vm",command:"device_stop",deviceId:"unit"},device:{...device(),status:"running",bootReady:true,lastBootCheck:{ready:true}}}],
    ["stop provider failure",{params:{backend:"macos-vm",command:"device_stop",deviceId:"unit"},device:{...device(),status:"running"},mode:"command-failure"}],
    ["stop unknown recording blocks",{params:{backend:"macos-vm",command:"device_stop",deviceId:"unit"},device:{...device(),status:"running",recording:{authority:"other"}}}],
    ["stop committed recording cleanup",{params:{backend:"macos-vm",command:"device_stop",deviceId:"unit"},device:{...device(),status:"running",recording:{authority:"host-broker",processOwner:"host-broker",startedBy:"broker.device.recording.start"}}}],
    ["partial cleanup remains committed",{params:{backend:"macos-vm",command:"device_stop",deviceId:"unit"},device:{...device(),status:"running",appium:{},recording:{authority:"other"}}}],
    ["cleanup refuses successor",{params:{backend:"macos-vm",command:"device_stop",deviceId:"unit"},device:{...device(),status:"running"},mode:"cleanup-successor"}],
    ["delete absent idempotent",{params:{backend:"macos-vm",command:"device_delete",deviceId:"unit"}}],
    ["delete no-instance metadata-only",{params:{backend:"macos-vm",command:"device_delete",deviceId:"unit"},device:{...device(),providerInstance:undefined}}],
    ["delete stopped resource",{params:{backend:"macos-vm",command:"device_delete",deviceId:"unit"},device:device()}],
    ["delete missing resource tolerated",{params:{backend:"macos-vm",command:"device_delete",deviceId:"unit"},device:device(),mode:"missing-resource"}],
    ["delete raw failure",{params:{backend:"macos-vm",command:"device_delete",deviceId:"unit"},device:device(),mode:"command-failure"}],
    ["delete successor",{params:{backend:"macos-vm",command:"device_delete",deviceId:"unit"},device:device(),mode:"successor"}],
    ["unchanged shared status caller",{params:{backend:"macos-vm",command:"device_status",deviceId:"unit"},device:device()}],
];
describe("prepared whole broker macOS current native controls",()=>{
    it.each(cases)("%s preserves raw results/native order/whole-record publication",async(_name,scenario)=>{
        const currentFixture=fixture(scenario);
        const current=await currentFixture.invoke();
        if(_name==="delete no-instance metadata-only"){
            for(const [observation,f]of [[current,currentFixture]] as const){
                expect(observation.trace.filter((row:any)=>Array.isArray(row)&&row[0]==="command")).toEqual([["command",{mode:"noop",provider:"host-broker-state",reason:"Stopped macOS VM delete without providerInstance deletes only owner broker metadata"},{timeoutMs:2300,outputLimit:32*1024}]]);
                expect(observation.result.payload.result.device).toBe(null);expect(observation.record).toBeUndefined();
                const effectsBefore=f.trace.length;let caught:unknown;try{f.probeUnknownNoop();}catch(error){caught=error;}
                expect(caught).toBe(f.fault);expect(f.denied).toEqual(["unallocated metadata-only delete noop"]);
                expect(f.trace.length).toBe(effectsBefore);expect(f.read()).toBeUndefined();
            }
        }
        if(["command-throw","claim-throw"].includes(scenario.mode||""))expect(current.error).toBe("raw-native-identity");else expect(current.error).toBeUndefined();
        if(current.record?.extra){expect(Object.hasOwn(current.record.extra,"absent")).toBe(true);expect(current.record.extra.absent).toBeUndefined();expect(current.record.extra.structured).toBeInstanceOf(Map);expect(current.record.extra.structured.get("kept")).toBeInstanceOf(Set);}
    });
    it.each(["filesystem","process","network","environment","constructor","date-constructor","module-constructor","global-timer"])("counts actual VM %s denial before catching for BOTH roles",name=>{
        {const f=fixture({params:{}});let caught:unknown;try{f.probe(name);}catch(error){caught=error;}expect(caught).toBe(f.fault);expect(f.denied).toHaveLength(1);expect(f.trace).toEqual([]);}
    });
});

