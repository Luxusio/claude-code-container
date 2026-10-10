import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import {describe,expect,it} from "vitest";
import * as path from "node:path";import {fileURLToPath,pathToFileURL} from "node:url";import * as vm from "node:vm";import ts from "typescript";
import type {IosSimulatorLifecyclePorts as Ports,IosSimulatorDevice as Device,IosSimulatorCommandResult as Command} from "../../../packages/device-lab/providers/ports/lifecycle/ios-simulator-lifecycle.mjs";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../.."),providerRoot="packages/device-lab/providers/";
type Reply={ok:boolean;text?:string;payload?:any;command?:Command};
type Operation="create"|"start"|"stop"|"delete";
const fixedTime="2031-01-02T03:04:05.000Z";
function fixture(mode:string,operation:Operation,raw=new Error("raw-ios-native")) {
    const trace:unknown[][]=[],publications:Array<{expected:Device;replacement:Device|null}>=[],commands:string[][]=[];
    let transitions=0,bootResult:Command|undefined;
    const base:Device={id:"unit",name:"Unit",backend:"ios-simulator",ownerId:"owner",simulatorName:"ccc-owner-unit",udid:"host-udid",status:operation==="stop"?"booted":"stopped",raw:{kept:true}};
    if(/signal|wait|partial|recording|stage/.test(mode))base.recording={active:!mode.includes("pending"),pid:41,stagingPath:mode.includes("stage")?"/allocated/stage":undefined,processIdentity:{startToken:"recording"},raw:"recording-metadata"};
    if(/appium|partial/.test(mode))base.appium={runtimeId:"appium-A",processOwner:"device-lab-mcp",startedBy:mode.includes("foreign")?"external":"direct-provider",serverPid:42,processIdentity:{startToken:"appium"},serverUrl:"http://allocated/status",sessionId:"raw-session"};
    if(mode==="foreign-name")base.simulatorName="foreign-unit";
    if(mode==="name-selection")base.udid=null;
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
            bootResult=mode==="boot-not-ready"||mode==="loss-carrier"?{...rc(4,"raw boot stdout","raw boot stderr"),error:raw}:rc(0,"raw boot stdout","raw boot stderr");return bootResult;},
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
    return {ports:p,trace,publications,commands,raw,base,state:()=>current,bootResult:()=>bootResult};
}

type Api={handleIosTool(name:string,args:Record<string,unknown>):Promise<any>;[key:string]:any};
function realm(emitted:boolean,mode:string,operation:Operation) {
    let denied=0;const deniedSites:string[]=[];
    const deny=(site:string):never=>{denied++;deniedSites.push(site);throw Error("unallocated iOS capability "+site);};
    // Reused complete-main bidirectional membrane; count before throw, including caught attempts.
    const incoming = new WeakMap<object, any>(), outgoing = new WeakMap<object, any>(), incomingOriginal = new WeakMap<object, any>(), outgoingOriginal = new WeakMap<object, any>();
    const translate = (value: any, into: boolean): any => {
        if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
        const reverse = into ? outgoingOriginal : incomingOriginal; if (reverse.has(value)) return reverse.get(value);
        const cache = into ? incoming : outgoing; if (cache.has(value)) return cache.get(value);
        const convert = (v: any) => translate(v, into), opposite = (v: any) => translate(v, !into);
        const protectedName = (key: PropertyKey) => ["constructor", "prototype", "__proto__", "caller", "callee", "arguments"].includes(String(key));
        const reject = (site: string): never => { try { return deny(site); } catch (error) { throw convert(error); } };
        const check = (key: PropertyKey) => { if (into && protectedName(key)) reject("host prototype " + String(key)); };
        const target = typeof value === "function" ? (function() {}).bind(null) : Array.isArray(value) ? [] : Object.create(null);
        const perform = (operation: () => any) => { try { return convert(operation()); } catch (error) { throw convert(error); } };
        const view = new Proxy(target, {
            get(_target, key) { check(key); return perform(() => Reflect.get(value, key, value)); },
            set(_target, key, next) { check(key); return perform(() => Reflect.set(value, key, opposite(next), value)); },
            has(_target, key) { check(key); return perform(() => Reflect.has(value, key)); },
            ownKeys() { return Reflect.ownKeys(value).filter(key => !into || !protectedName(key)); },
            getOwnPropertyDescriptor(_target, key) { check(key); const d = Reflect.getOwnPropertyDescriptor(value, key); if (!d) return undefined;
                const own = Reflect.getOwnPropertyDescriptor(target, key); const base = { enumerable: d.enumerable, configurable: own?.configurable === false ? false : true };
                return "value" in d ? { ...base, writable: d.writable, value: convert(d.value) } : { ...base, get: convert(d.get), set: convert(d.set) }; },
            defineProperty(_target, key, descriptor) { check(key); const d = { ...descriptor }; if ("value" in d) d.value = opposite(d.value);
                if ("get" in d) d.get = opposite(d.get); if ("set" in d) d.set = opposite(d.set);
                if(!Reflect.defineProperty(value,key,d))return false;
                // Mirror immutable descriptors (notably CJS __esModule) so the
                // actual VM export writes obey Proxy invariants in both directions.
                return descriptor.configurable===false||descriptor.configurable===undefined?Reflect.defineProperty(target,key,descriptor):true; },
            deleteProperty(_target, key) { check(key); return perform(() => Reflect.deleteProperty(value, key)); },
            getPrototypeOf() { if (into) return reject("host prototype traversal"); return perform(() => Reflect.getPrototypeOf(value)); },
            setPrototypeOf() { return reject("prototype mutation"); }, preventExtensions() { return reject("capability sealing"); },
            apply(_target, receiver, args) { return perform(() => Reflect.apply(value, opposite(receiver), args.map(opposite))); },
            construct(_target, args) { return perform(() => Reflect.construct(value, args.map(opposite))); },
        });
        cache.set(value, view); (into ? incomingOriginal : outgoingOriginal).set(view, value); return view;
    };
    const into = (v: any) => translate(v, true), out = (v: any) => translate(v, false);

    const context=vm.createContext({},{codeGeneration:{strings:false,wasm:false}});
    const raw=out(vm.runInContext('new Error("raw-ios-native")',context)),f=fixture(mode,operation,raw),p=f.ports;
    if(mode==="loss-carrier"){
        f.base.ownUndefined=undefined;f.base.raw={kept:true,ownUndefined:undefined,structured:new Map([["kept",new Set([1,2])]])};
        Object.assign(raw,{code:"allocated-native-boot-error",ownUndefined:undefined});
    }
    // Reuse the bounded native clone adapter: resolve only recorded membrane
    // crossings in allocated results/trace/state; copy with the native primitive.
    // Restore descriptors on both success and throw. Never JSON-normalize values.
    const nativeSnapshot=(value:any):any=>{
        if(value===null||typeof value!=="object")return value;
        if(value!==f.trace&&value!==f.state()&&!outgoingOriginal.has(value)&&!incoming.has(value))return deny("unallocated snapshot root");
        const operand=outgoingOriginal.has(value)?outgoingOriginal.get(value):value;
        const restored:Array<{object:object;key:PropertyKey;descriptor:PropertyDescriptor}>=[],seen=new Set<object>();
        const visit=(object:any,depth:number)=>{
            if(object===null||typeof object!=="object"||seen.has(object))return;
            if(depth>32||seen.size>=512)return deny("native snapshot operand bound");seen.add(object);
            for(const key of Reflect.ownKeys(object)){
                const descriptor=Reflect.getOwnPropertyDescriptor(object,key);if(!descriptor||!("value"in descriptor))continue;
                let field=descriptor.value;
                if(field!==null&&(typeof field==="object"||typeof field==="function")){
                    if(incomingOriginal.has(field))field=incomingOriginal.get(field);
                    else if(outgoingOriginal.has(field))field=outgoingOriginal.get(field);
                }
                if(field!==descriptor.value){
                    if(!Reflect.defineProperty(object,key,{...descriptor,value:field}))return deny("native snapshot crossing descriptor");
                    restored.push({object,key,descriptor});
                }
                visit(field,depth+1);
            }
        };
        try{visit(operand,0);return structuredClone(operand);}
        finally{for(const entry of restored.reverse())if(!Reflect.defineProperty(entry.object,entry.key,entry.descriptor))deny("native snapshot descriptor restoration");}
    };
    let lockHeld=false;
    const checkReceiver=(name:string,fn:(...args:any[])=>any)=>function(this:unknown,...args:any[]){
        f.trace.push(["receiver",name,this===undefined]);expect(this).toBeUndefined();return Reflect.apply(fn,undefined,args);};
    let ticks=1000;
    class FixedDate {toISOString(){f.trace.push(["clock"]);return fixedTime;}static now(){const value=ticks;ticks+=mode==="wait-timeout"?3001:0;f.trace.push(["monotonic",value]);return value;}static parse(value:string){return Date.parse(value);}static UTC(...args:number[]){return Reflect.apply(Date.UTC,Date,args);}}
    const processData={env:new Proxy({},{get:(_t,key)=>deny("env "+String(key))}),kill(pid:number,signal:number){
        if(pid!==41||signal!==0)return deny("unallocated PID/signal");f.trace.push(["liveness",pid,signal]);if(mode!=="wait-timeout")throw raw;}};
    let sessionTimer=false,sessionSignal:object|undefined;
    class SessionAbortController {signal={};constructor(){if(!f.base.appium?.sessionId)return deny("unallocated HTTP controller");sessionSignal=this.signal;}abort(){return deny("unexpected HTTP abort");}}
    const globals={process:new Proxy(processData,{get:(t,k)=>Object.hasOwn(t,k)?Reflect.get(t,k):deny("process "+String(k))}),Buffer,Date:FixedDate,AbortController:SessionAbortController,
        console:new Proxy({},{get:(_t,k)=>()=>deny("console "+String(k))}),fetch:(url:unknown,options:any)=>{
            if(url!=="http://allocated/status/session/raw-session"||!f.base.appium||options?.method!=="DELETE"||options?.signal!==sessionSignal||options?.redirect!=="manual"||!sessionTimer)return deny("network");
            expect(options.headers).toEqual({"Content-Type":"application/json"});f.trace.push(["native-session-delete",url,options.method]);
            return Promise.resolve({status:200,ok:true,headers:{get:(name:string)=>{expect(name).toBe("content-length");return null;}},body:null});},
        setTimeout:(callback:()=>void,delay:number)=>{if(delay===5000&&sessionSignal&&!sessionTimer){sessionTimer=true;f.trace.push(["session-deadline",delay]);return 2;}
            if(delay!==50)return deny("timer "+delay);f.trace.push(["pace",delay]);callback();return 1;},
        clearTimeout:(timer:number)=>{if(timer!==2||!sessionTimer)return deny("timer clear");sessionTimer=false;f.trace.push(["session-settled"]);},setInterval:()=>deny("interval")};
    for(const [key,value]of Object.entries(globals))context[key]=into(value);
    context.globalThis=into(new Proxy(globals,{get:(t,k)=>Object.hasOwn(t,k)?Reflect.get(t,k):deny("global "+String(k)),set:()=>deny("global mutation")}));
    const closed=(label:string)=>new Proxy({},{get:(_t,k)=>(..._args:unknown[])=>deny(label+"."+String(k))});
    const nativeFs=closed("filesystem");
    const contextLeaf={ownerId:checkReceiver("owner",p.ownerId),slug:checkReceiver("slug",p.slug)};
    const commands={
        commandPath:checkReceiver("commandPath",(tool:string)=>{expect(tool).toBe("xcrun");f.trace.push(["command-path",tool]);return mode.startsWith("no-prereq")?null:"/allocated/xcrun";}),
        localBinPath:()=>deny("unrelated executable"),
        run:checkReceiver("run",(executable:string,args:string[])=>{if(args[0]!=="simctl")return deny("native command");if(args[1]==="list"){const inventory=p.simctlJson(executable,args.slice(1));return inventory.error??{status:0,stdout:JSON.stringify(inventory.value),stderr:""};}return p.run(executable,args);}),
        runWithTimeout:checkReceiver("bootstatus",p.runWithTimeout),runWithInput:()=>deny("unrelated command input"),
    };
    const state={readIosDevices:checkReceiver("read",p.readIosDevices),findIosDevice:checkReceiver("find",p.findIosDevice),claimIosDevice:checkReceiver("claim",p.claimIosDevice),
        transitionIosDevice:checkReceiver("transition",p.transitionIosDevice),updateIosDevice:()=>deny("unrelated publication")};
    const identity={inspectProcessIdentity:checkReceiver("inspect",p.inspectProcessIdentity),signalOwnedRuntimeProcess:checkReceiver("signal",p.signalOwnedRuntimeProcess),
        terminateOwnedRuntimeProcess:checkReceiver("terminate-runtime",async(runtime:any,label:string,options:any)=>{expect(options).toEqual({timeoutMs:1000});return p.terminateOwnedAppiumProcess(runtime,label,options.timeoutMs);}),
        readProcessIdentity:()=>deny("unallocated identity"),refreshOwnedRuntimeProcessIdentity:()=>deny("unallocated identity"),waitForProcessIdentity:()=>deny("unallocated identity")};
    const transfer={discardLocalOutputStage:checkReceiver("discard",p.discardLocalOutputStage),
        commitLocalOutputStage:()=>deny("unallocated output"),copyStagedInputFile:()=>deny("unallocated input"),createLocalOutputStage:()=>deny("unallocated output"),populateLocalOutputStage:()=>deny("unallocated output"),restoreLocalOutputStage:()=>deny("unallocated output"),stageLocalInputFile:()=>deny("unallocated input")};
    const nativeLeaves:Record<string,unknown>={
        fs:nativeFs,path,os:{homedir:()=>"/allocated-home",tmpdir:()=>deny("tmpdir")},
        crypto:{createHash:checkReceiver("hash",(algorithm:string)=>{expect(algorithm).toBe("sha256");return createHash(algorithm);}),randomUUID:checkReceiver("uuid",p.runtimeId)},
        child_process:closed("process"),url:{fileURLToPath},
        [providerRoot+"commands.mjs"]:commands,[providerRoot+"context.mjs"]:contextLeaf,[providerRoot+"state/ios-state.mjs"]:state,[providerRoot+"state/process-identity.mjs"]:identity,
        [providerRoot+"state/runtime-generation.mjs"]:closed("unrelated generation"),[providerRoot+"transfer-file.mjs"]:transfer,
        [providerRoot+"state/physical-lease-store.mjs"]:{readPhysicalLeases:()=>deny("unallocated physical lease")},
        [providerRoot+"state/device-store.mjs"]:{withOwnerDeviceOperation:checkReceiver("owner-lock",async(backend:string,id:string,callback:()=>Promise<unknown>)=>{
            expect(backend).toBe("ios");expect(typeof id).toBe("string");expect(lockHeld).toBe(false);f.trace.push(["owner-lock",backend,id]);
            if(mode==="lock-timeout")throw out(vm.runInContext('Object.assign(new Error("raw owned lock timeout"),{code:"shared-mutation-lock-timeout"})',context));
            lockHeld=true;try{return await callback();}finally{lockHeld=false;f.trace.push(["owner-unlock"]);}})},
        [providerRoot+"file-listing.mjs"]:closed("listing"),[providerRoot+"wait-budget.mjs"]:closed("unrelated wait"),
        [providerRoot+"policy/files.mjs"]:closed("files"),[providerRoot+"screenshot-file.mjs"]:closed("screenshot"),
    };
    const allowed=new Set([providerRoot+"backends/ios-simulator.mjs",providerRoot+"responses.mjs",providerRoot+"status.mjs",providerRoot+"state/device-operation-policy.mjs",
        providerRoot+"application/lifecycle/ios-simulator-lifecycle.mjs",providerRoot+"domain/lifecycle/ios-simulator-lifecycle.mjs"]);
    const cache=new Map<string,any>();let facadeRequire:((specifier:string)=>any)|undefined;
    const source=(name:string)=>{
        const file=path.join(root,emitted?"dist/"+name:name),birth=lstatSync(file);expect(birth.isFile()&&!birth.isSymbolicLink()&&birth.nlink===1).toBe(true);expect(realpathSync(file)).toBe(file);
        const bytes=readFileSync(file,"utf8"),after=lstatSync(file);expect([after.dev,after.ino,after.size,after.mtimeMs]).toEqual([birth.dev,birth.ino,birth.size,birth.mtimeMs]);
        return bytes;
    };
    const load=(name:string):any=>{
        if(cache.has(name))return cache.get(name);if(!allowed.has(name))return deny("module "+name);
        const exports=Object.create(null);cache.set(name,exports);
        const compiled=ts.transpileModule(source(name).replace(/import\.meta\.url/g,JSON.stringify(pathToFileURL(path.join(root,emitted?"dist/"+name:name)).href)),
            {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
        const mapped=(specifier:string)=>{
            const builtin=specifier.replace(/^node:/,"");if(Object.hasOwn(nativeLeaves,builtin))return nativeLeaves[builtin];
            if(!specifier.startsWith("."))return deny("import "+specifier);
            const target=path.posix.normalize(path.posix.join(path.posix.dirname(name),specifier));if(Object.hasOwn(nativeLeaves,target))return nativeLeaves[target];return load(target);
        };
        if(name===providerRoot+"backends/ios-simulator.mjs")facadeRequire=mapped;
        vm.runInContext("(function(require,module,exports){"+compiled+"\n})",context,{filename:name})(into(mapped),into({exports}),into(exports));
        if(name===providerRoot+"responses.mjs")for(const key of ["textResult","jsonResult","fail"])exports[key]=checkReceiver("publish-"+key,exports[key] as (...args:any[])=>any);
        return exports;
    };
    const api=load(providerRoot+"backends/ios-simulator.mjs") as Api;
    expect(denied).toBe(0);expect(f.trace).toEqual([]);expect(lockHeld).toBe(false);
    expect(cache.has(providerRoot+"application/lifecycle/ios-simulator-lifecycle.mjs")).toBe(true);expect(cache.has(providerRoot+"domain/lifecycle/ios-simulator-lifecycle.mjs")).toBe(true);
    const assertZero=()=>{expect(denied,"including caught native attempts").toBe(0);expect(lockHeld,"owned operation callbacks joined").toBe(false);expect(sessionTimer,"native session deadline settled").toBe(false);};
    return {api,f,raw,deniedSites,assertZero,nativeSnapshot,denied:()=>denied,negative(){
        for(const callback of [()=>vm.runInContext('(require)=>{try{require("fs").readFileSync("/foreign")}catch{}}',context)(into(facadeRequire)),()=>vm.runInContext('try{process.env.UNALLOCATED_SECRET}catch{}',context),
            ()=>vm.runInContext('try{process.kill(999,9)}catch{}',context),()=>vm.runInContext('try{fetch("https://unallocated.invalid")}catch{}',context),
            ()=>vm.runInContext('try{Buffer.constructor("return process")()}catch{}',context),()=>vm.runInContext('try{globalThis.UNALLOCATED_HOST_READ}catch{}',context)]){const before=denied;callback();expect(denied).toBe(before+1);}
    }};
}
const facadeCases:Array<[Operation,string,Record<string,unknown>]>=[
    ["create","definition",{backend:"ios-simulator",name:"Other"}],["create","duplicate",{backend:"ios-simulator",name:"Unit",deviceId:"unit"}],
    ...["created","claim-throw","claim-conflict","claim-conflict-same","rollback-fail","rollback-invalid","rollback-throw"].map(mode=>["create",mode,{backend:"ios-simulator",name:"Other",createSimulator:true,deviceType:"type",runtime:"runtime"}] as [Operation,string,Record<string,unknown>]),
    ...["foreign-name","host-ambiguous","host-mismatch","claim-mismatch","boot-already","boot-not-ready","complete-mismatch","bootstatus-throw"].map(mode=>["start",mode,{deviceId:"unit"}] as [Operation,string,Record<string,unknown>]),
    ...["no-prereq-stopped","signal-exited","wait-timeout","appium-mismatch","appium-foreign","partial","readback-successor","lock-timeout"].map(mode=>["stop",mode,{deviceId:"unit"}] as [Operation,string,Record<string,unknown>]),
    ...["deleted","delete-invalid","stage-refusal","appium-mismatch","partial","complete-mismatch"].map(mode=>["delete",mode,{deviceId:"unit",force:true,deleteSimulator:true}] as [Operation,string,Record<string,unknown>]),
    ["delete","stage-refusal",{deviceId:"unit",force:true,deleteSimulator:false}],
    ["delete","delete-booted",{deviceId:"unit",force:true,deleteSimulator:true}],
];
describe("iOS current public facade and guarded native bindings",()=>{
    it.each(facadeCases)("%s binds whole native facade for %s without replacing policy",async(operation,mode,args)=>{
        for(const emitted of [false,true]){const after=realm(emitted,mode,operation);let newError:unknown;
            try{await after.api.handleIosTool("device_"+operation,args);}catch(error){newError=error;}
            after.assertZero();
            if(newError!==undefined)expect(newError).toBe(after.raw);
        }
    });
    it("counts caught actual-VM require FS/process/network/environment/constructor/global refusals before throwing",()=>{
        const f=realm(false,"negative","start");f.assertZero();f.negative();expect(f.denied()).toBe(6);expect(f.deniedSites).toHaveLength(6);
    });
    it("actual whole-facade start preserves own undefined, structured metadata and native returned error carrier",async()=>{
        for(const emitted of [false,true]){
            const after=realm(emitted,"loss-carrier","start");
            const invoke=async(r:ReturnType<typeof realm>)=>{
                const result=await r.api.handleIosTool("device_start",{deviceId:"unit"}),state=r.f.state()!,native=r.f.bootResult()!;
                expect(state.status).toBe("starting");expect(Object.hasOwn(state,"ownUndefined")).toBe(true);expect(state.ownUndefined).toBeUndefined();
                const metadata=state.raw as {ownUndefined?:unknown;structured:Map<string,Set<number>>};
                expect(Object.hasOwn(metadata,"ownUndefined")).toBe(true);expect(metadata.ownUndefined).toBeUndefined();
                expect(metadata.structured).toBeInstanceOf(Map);expect(metadata.structured.get("kept")).toBeInstanceOf(Set);expect([...metadata.structured.get("kept")!]).toEqual([1,2]);
                const boot=state.lastBootCheck as {error:unknown};expect(Object.hasOwn(boot,"error")).toBe(true);expect(boot.error).toBe(native.error);expect(native.error).toBe(r.raw);expect(native.carrier).toBe(r.raw);
                expect(Object.hasOwn(r.raw,"ownUndefined")).toBe(true);expect((r.raw as any).ownUndefined).toBeUndefined();expect((r.raw as any).code).toBe("allocated-native-boot-error");
                const publication=r.f.publications.at(-1)!;expect(publication.replacement).toBe(state);expect(publication.expected.lifecycle?.runtimeId).toBe("lifecycle-A");
                const copied=r.nativeSnapshot(state);expect(Object.hasOwn(copied,"ownUndefined")).toBe(true);expect(copied.raw.structured).toBeInstanceOf(Map);r.assertZero();return result;
            };
            await invoke(after);
        }
    });
});
// VM controls raw native leaves and clock/pacing. Authentic native authorities also
// execute through the existing owned public MCP fixture. No native macOS/Xcode,
// broker-native, distribution, or whole-operation acceptance is claimed.
