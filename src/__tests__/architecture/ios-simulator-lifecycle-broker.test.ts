import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import type { Server } from "node:http";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { coreBoundaryViolations } from "./core-boundary.js";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { backendRoot, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "../helpers/host-broker-test-fixture.js";
import { createDeviceBrokerServer } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";

const project = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoot = join(project, "packages/device-lab/src/device-lab");
const appFile = join(sourceRoot, "application/lifecycle/ios-simulator-lifecycle.ts");
const domainFile = join(sourceRoot, "domain/lifecycle/ios-simulator-lifecycle.ts");
const portsFile = join(sourceRoot, "ports/lifecycle/ios-simulator-lifecycle.ts");
const compile = (source: string, file: string) => ts.transpileModule(source, {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

// Fixed native fixture kernel. Every callable exposed to subject code is created
// in its own VM; native clone/equality bridges are captured privately, deleted
// before loading, and never return host prototypes or executable objects.
// This is a bounded ordinary-record clone control, not a JSON oracle or a
// reflective membrane. Real filesystem/HTTP authority is checked separately.
const FIXTURE_KERNEL = String.raw`
(()=>{
 "use strict";
 const nativeClone=globalThis.__clone, nativeEqual=globalThis.__equal, nativeIsBuffer=globalThis.__isBuffer;
 delete globalThis.__clone;delete globalThis.__equal;delete globalThis.__isBuffer;
 const moduleText=globalThis.__moduleText;delete globalThis.__moduleText;
 const modules=JSON.parse(moduleText), loaded=Object.create(null), traces=[], denied={process:0,fs:0,network:0,timer:0,clone:0};
 const deny=category=>{denied[category]++;throw Error('DENIED '+category);};
 for(const [name,category] of [['process','process'],['console','process'],['fetch','network'],['setTimeout','timer'],['setInterval','timer'],['setImmediate','timer']])
  Object.defineProperty(globalThis,name,{get(){return deny(category);},configurable:false});
 globalThis.require=()=>deny('fs');
 // The bounded diagnostic formatter uses only this pure predicate;
 // no Buffer constructor/allocation/read API is exposed.
 globalThis.Buffer=Object.freeze({isBuffer(value){return nativeIsBuffer(value);}});
 const plainPrototype=Object.prototype, arrayPrototype=Array.prototype;
 function boundedDto(value,depth=0,budget={left:256}){
  if(depth>12||--budget.left<0)return deny('clone');
  if(value===null||['string','number','boolean','undefined'].includes(typeof value))return;
  if(typeof value!=='object'||![plainPrototype,arrayPrototype].includes(Object.getPrototypeOf(value)))return deny('clone');
  for(const key of Reflect.ownKeys(value)){
   if(typeof key!=='string')return deny('clone');const descriptor=Object.getOwnPropertyDescriptor(value,key);
   if(!descriptor||!Object.hasOwn(descriptor,'value'))return deny('clone');boundedDto(descriptor.value,depth+1,budget);
  }
 }
 function adopt(value){if(!value||typeof value!=='object')return value;Object.setPrototypeOf(value,Array.isArray(value)?arrayPrototype:plainPrototype);for(const key of Object.keys(value))adopt(value[key]);return value;}
 const clone=value=>{boundedDto(value);traces.push(['clone']);return adopt(nativeClone(value));};
 const equal=(a,b)=>{boundedDto(a);boundedDto(b);return nativeEqual(a,b);};
 globalThis.structuredClone=clone;globalThis.isDeepStrictEqual=equal;
 const RealDate=Date;
 globalThis.Date=class extends RealDate {constructor(...args){if(!args.length)traces.push(['timestamp']);super(...(args.length?args:['2026-10-10T00:00:00.000Z']));}static now(){return 1791590400000;}};
 globalThis.DEVICE_BROKER_HYPER_V_BACKENDS=new Set(['windows-vm','linux-vm']);
 globalThis.DEVICE_BROKER_COMMAND_OUTPUT_LIMIT=32768;globalThis.DEVICE_BROKER_INVENTORY_FILE_LIMIT=262144;
 let records=[], scenario={}, parsed, plan, expected, kernel, candidate, claimWrites=0, readCount=0;
 const owner='0123456789abcdef', rawError=Error('exact native error');
 function nativeRead(ownerId,stateKey){if(ownerId!==owner||stateKey!=='ios')return deny('fs');traces.push(['read']);if(scenario.cleanupRace&&++readCount===1){records=records.map(d=>({...d,name:'Successor',extra:{raw:'winner'}}));}return records;}
 globalThis.readOwnerDevices=nativeRead;
 globalThis.ownerDevicesFile=(o,k)=>{if(o!==owner||k!=='ios')return deny('fs');return 'allocated-owner/ios/devices.json';};
 globalThis.ownerDevicesMutationLockFile=(o,k)=>{if(o!==owner||k!=='ios')return deny('fs');return 'allocated-owner/ios/devices.lock';};
 globalThis.withSharedMutationLock=(file,action)=>{if(file!=='allocated-owner/ios/devices.lock')return deny('fs');traces.push(['lock']);return action();};
 globalThis.assertOwnerDeviceStateWritable=(value,limit)=>{boundedDto(value);if(limit!==262144)return deny('fs');};
 globalThis.writeJsonFileAtomically=(file,payload)=>{if(file!=='allocated-owner/ios/devices.json')return deny('fs');traces.push(['write']);
  if(parsed.command==='device_create'&&++claimWrites===1&&scenario.claimError){if(scenario.claimError==='raw')throw rawError;throw new kernel.OwnerDeviceStateError('owner-devices-state-invalid');}
  records=payload.devices;
 };
 globalThis.executableFor=(name)=>{if(name!=='xcrun')return deny('process');traces.push(['executable',name]);return '/allocated/xcrun';};
 globalThis.providerExecutable=globalThis.executableFor;
 const execute=function(command,options){
  if(!['simctl','xcrun','host-broker-state'].includes(command.provider)||command.mode!=='noop'&&command.executable!=='/allocated/xcrun')return deny('process');
  traces.push(['execute',command,options,this===normalized]);
  if(scenario.runnerError)throw rawError;
  if(command.args?.[1]==='list')return {...command,status:0,stdout:JSON.stringify({devices:{runtime:[{name:'ccc-'+owner+'-fixture',udid:'created-udid'}]}}),stderr:''};
  if(scenario.successor&&['boot','shutdown','delete'].includes(command.args?.[1]))records=records.map(d=>({...d,name:'Successor',extra:{raw:'winner'}}));
  const create=command.args?.[1]==='create', rollback=command.args?.[1]==='delete'&&parsed.command==='device_create';
  return {...command,status:scenario.commandFailure||rollback&&scenario.rollbackFailure?17:0,
   stdout:create?(scenario.invalidUdid?'invalid udid\n':' created-udid\n'):'raw stdout',stderr:scenario.commandFailure||rollback&&scenario.rollbackFailure?'raw stderr':'',
   ...(scenario.commandFailure?{error:'raw error'}:{})};
 };
 const normalized={commandTimeoutMs:10000,usesDefaultCommandRunner:false,platform:'darwin',get commandRunner(){if(scenario.runnerGetterError)throw rawError;return execute;}};
 globalThis.validateCommandParams=()=>parsed;
 globalThis.lifecycleCommandPlan=(_owner,_params,_normalized,_redact,observation)=>{if(observation)observation.device=expected;return {status:200,payload:{ok:true,result:plan}};};
 // These are pre-admitted inputs, not replacement operation callbacks. Public
 // parser/preview/lock/authentication executes in the actual HTTP witness below.
 function load(key){if(loaded[key])return loaded[key];if(!Object.hasOwn(modules,key))return deny('fs');const exports={};loaded[key]=exports;
  const allowed={app:{'../../domain/lifecycle/ios-simulator-lifecycle.js':'domain','../../ports/lifecycle/ios-simulator-lifecycle.js':'ports'},domain:{},ports:{'../../domain/lifecycle/ios-simulator-lifecycle.js':'domain'}};
  const require=specifier=>{const target=allowed[key]?.[specifier];if(!target)return deny('fs');return load(target);};
  new Function('exports','require',modules[key])(exports,require);return exports;
 }
 kernel=load('native');
 const makePorts=()=>({
  execute:(command,options)=>normalized.commandRunner(command,options),executable:name=>executableFor(name),timestamp:()=>new Date().toISOString(),
  createCommand:input=>(0,kernel.iosSimulatorCreateCommand)(input),createdUdid:value=>(0,kernel.iosSimulatorCreatedUdid)(value),deleteCommand:(exe,id)=>(0,kernel.iosSimulatorDeleteCommand)(exe,id),
  verifyOwnedTarget:(o,device)=>(0,kernel.resolveBrokerOwnedIosSimulatorTarget)(o,device,normalized),
  claimDefinition:(o,p,device)=>(0,kernel.claimOwnerDevice)(o,p.stateKey,device,['id','udid','simulatorName']),
  cleanupAuxiliary:(o,p,device)=>(0,kernel.cleanupLifecycleAuxiliaryRuntime)(o,p,normalized,device),
  publish:(o,k,id,device,change)=>(0,kernel.transitionOwnerLifecycleDevice)(o,k,id,device,current=>{
   const replacement=(0,candidate.domain.brokerIosReplacement)(current,change);return replacement===null?null:{...replacement,updatedAt:new Date().toISOString()};
  }),
  redactDevice:device=>(0,kernel.redactBrokerDeviceSecrets)(device),stateErrorCode:error=>(0,kernel.ownerDeviceStateErrorCode)(error),
  stateFailure:(error,p)=>(0,kernel.ownerDeviceStateFailure)(error,{backend:p.backend,stateKey:p.stateKey}),failureDetail:result=>(0,kernel.providerFailureDetail)(result),
  commandTimeoutMs:10000,outputLimit:32768,
 });
 function positiveCounts(){return Object.values(denied).every(n=>n===0);}
 globalThis.__iosFixture={
  initialize(){candidate={app:load('app'),domain:load('domain'),ports:load('ports')};if(traces.length||!positiveCounts())throw Error('unexpected initialization authority');},
  async run(spec){
   scenario=spec;records=[];claimWrites=0;readCount=0;
   parsed={ok:true,backend:'ios-simulator',stateKey:'ios',command:spec.operation||'device_create',deviceId:'fixture',force:spec.operation==='device_delete',dryRun:false,
    ...(spec.wait?{waitForBoot:true}:{}),...(spec.operation&&spec.operation!=='device_create'?{}:{create:{name:'Fixture',createSimulator:spec.provision===true,deviceType:'phone-type',runtime:'runtime-id'}})};
   if(parsed.command!=='device_create')records=[{id:'fixture',backend:'ios-simulator',simulatorName:'ccc-'+owner+'-fixture',udid:'created-udid',status:parsed.command==='device_start'?'stopped':'running',extra:{raw:'original'},
    ...(spec.auxiliary?{appium:{serverPid:456,raw:'metadata'},recording:{authority:'host-broker',processOwner:'host-broker',startedBy:'broker.device.recording.start',active:true,pid:123,raw:'metadata'}}:{}),
    ...(spec.partialAuxiliary?{appium:{raw:'metadata'},recording:{authority:'foreign',active:true,pid:123,raw:'metadata'}}:{})}];
   if(spec.sameUdid)records=[{id:'existing',backend:'ios-simulator',simulatorName:'ccc-'+owner+'-existing',udid:'created-udid',status:'stopped'}];
   if(spec.otherConflict)records=[{id:'existing',backend:'ios-simulator',simulatorName:'ccc-'+owner+'-fixture',udid:'other-udid',status:'stopped'}];
   const ports=makePorts(),application=(0,candidate.app.createBrokerIosSimulatorLifecycle)(ports);
   expected=records.find(d=>d.id===parsed.deviceId);if(expected)expected=clone(expected);
   traces.length=0;
   const providerCommand=parsed.command==='device_create'?application.planCreate(owner,parsed):application.planExisting(owner,parsed,expected);
   plan={providerCommand,...(expected?{device:expected}:{}),...(parsed.create?{create:parsed.create}:{})};
   readCount=0;
   let result,error;
   try{result=await application[parsed.command.slice(7)]({ownerId:owner,parsed,plan,expectedDevice:expected});}catch(cause){error=cause;}
   const observation={result,error,errorIsRaw:error===rawError,records,traces:traces.slice(),denied:{...denied},ports};
   if(!positiveCounts())throw Error('unexpected native effect, including caught attempts');return observation;
  },
  negative(ports){const controls=[['process',()=>ports.execute.constructor('return process')()],['network',()=>ports.createdUdid.constructor.constructor('return fetch')()],['fs',()=>ports.redactDevice.constructor("return require('node:fs')")()],['timer',()=>ports.timestamp.constructor('return setTimeout(()=>{},0)')()],['clone',()=>structuredClone({executable:()=>0})]];
   const cases=[];
   for(const [caseIndex,[category,action]]of controls.entries()){
    const before={...denied},traceBefore=traces.length,recordIdentity=records,recordData=adopt(nativeClone(records));let caughtDenied=false,safeErrorCode=null;
    try{action();}catch(error){
     if(error!==null&&typeof error==='object'){const message=Object.getOwnPropertyDescriptor(error,'message'),code=Object.getOwnPropertyDescriptor(error,'code');
      caughtDenied=Boolean(message&&Object.hasOwn(message,'value')&&message.value==='DENIED '+category);
      if(code&&Object.hasOwn(code,'value')&&typeof code.value==='string'&&/^[A-Z0-9_]{1,64}$/.test(code.value))safeErrorCode=code.value;
     }
    }
    const after={...denied},delta=after[category]-before[category],nativeTrace={before:traceBefore,after:traces.length},recordsUnchanged=records===recordIdentity&&nativeEqual(records,recordData);
    const proof={caseIndex,category,before,after,delta,caughtDenied,safeErrorCode,nativeTrace,recordsUnchanged};cases.push(proof);
    if(!caughtDenied||!Number.isSafeInteger(delta)||delta<=0||Object.keys(before).some(key=>key!==category&&after[key]!==before[key])||nativeTrace.after!==nativeTrace.before||!recordsUnchanged){const failure=Error('negative effect count mismatch '+category);Object.defineProperty(failure,'negativeControl',{value:Object.freeze(proof),enumerable:true});throw failure;}
   }
   return {form:'constructor-escape-semantic-delta-v1',counts:{...denied},cases};
  },
 };
})();
`;

type DenialCategory = "process" | "network" | "fs" | "timer" | "clone";
type DenialCounts = Record<DenialCategory, number>;
type NegativeProof = { form: string; counts: DenialCounts; cases: { caseIndex: number; category: DenialCategory; before: DenialCounts; after: DenialCounts; delta: number; caughtDenied: boolean; safeErrorCode: string | null; nativeTrace: { before: number; after: number }; recordsUnchanged: boolean }[] };
 const categories: DenialCategory[]=['process','network','fs','timer','clone'],keys=[...categories].sort(),zeroCounts: DenialCounts={process:0,fs:0,network:0,timer:0,clone:0};
 const validateNegativeProof=(proof: NegativeProof)=>{
  assert.equal(proof.form,'constructor-escape-semantic-delta-v1');assert.equal(proof.cases.length,categories.length);assert.deepEqual(Object.keys(proof.counts).sort(),keys);
  let previous=zeroCounts;
  for(const [index,row]of proof.cases.entries()){
   assert.equal(row.caseIndex,index);assert.equal(row.category,categories[index]);assert.equal(row.caughtDenied,true);
   assert.deepEqual(Object.keys(row.before).sort(),keys);assert.deepEqual(Object.keys(row.after).sort(),keys);assert.deepEqual(row.before,previous);
   for(const category of categories){assert(Number.isSafeInteger(row.before[category])&&row.before[category]>=0);assert(Number.isSafeInteger(row.after[category])&&row.after[category]>=0);if(category!==row.category)assert.equal(row.after[category],row.before[category]);}
   assert.equal(row.before[row.category],0);assert.equal(row.delta,row.after[row.category]-row.before[row.category]);assert(Number.isSafeInteger(row.delta)&&row.delta>0);
   assert(Number.isSafeInteger(row.nativeTrace.before)&&row.nativeTrace.before>=0);assert.equal(row.nativeTrace.after,row.nativeTrace.before);assert.equal(row.recordsUnchanged,true);
   assert(row.safeErrorCode===null||typeof row.safeErrorCode==='string'&&/^[A-Z0-9_]{1,64}$/.test(row.safeErrorCode));previous=row.after;
  }
  assert.deepEqual(proof.counts,previous);return proof;
 };


type Observation = { result?: { status: number; payload: Record<string, unknown> }; error?: unknown; errorIsRaw: boolean; records: unknown[]; traces: unknown[]; denied: Record<string, number>; ports: unknown };
type Fixture = { initialize(): void; run(spec: Record<string, unknown>): Promise<Observation>; negative(ports: unknown): NegativeProof };
function fixture(): Fixture {
    const nativeSource = readFileSync(join(project, "packages/device-lab/src/device-lab-broker.ts"), "utf8");
    const ast = ts.createSourceFile("broker.ts", nativeSource, ts.ScriptTarget.Latest, true);
    const names = new Set(["brokerOwnedAppiumPid","iosSimulatorCreateCommand","iosSimulatorCreatedUdid","iosSimulatorDeleteCommand","OwnerDeviceStateError","ownerDeviceStateErrorCode","isHyperVBackend","createOwnerDeviceUniqueFields","rollbackProviderCreateAfterConflict","mutateDeviceAfterCommand","cleanupLifecycleAuxiliaryRuntime","resolveBrokerOwnedIosSimulatorTarget","redactBrokerDeviceSecrets","ownerDeviceStateFailure","brokerOwnedAppiumRuntime","terminateBrokerOwnedAppium","signalBrokerOwnedRecording","transitionOwnerLifecycleDevice","claimOwnerDevice","assertUniqueOwnerDeviceIds","brokerIosSimulatorPrefix","brokerSlug","field","truncateOutput","commandSucceeded","providerFailureDetail","commandToleratesMissingMacosVmDelete","commandToleratesStoppedAndroidEmulatorStatus"]);
    const leafSources = [ast, ...["device-lab-owner-state.ts", "device-lab/providers/ios-simulator.ts"].map(file => ts.createSourceFile(file, readFileSync(join(project, "packages/device-lab/src", file), "utf8"), ts.ScriptTarget.Latest, true))];
    const native = leafSources.flatMap(ast => ast.statements.filter(node => (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.has(node.name.text)).map(node => node.getText(ast))).join("\n");
    const modules: Record<string, string> = { native: compile(native + "\nexport {" + [...names].join(",") + "};", "native-broker.ts") };
    for (const [key, file] of [["app", appFile], ["domain", domainFile], ["ports", portsFile]]) {
        const source = readFileSync(file!, "utf8");
        expect(coreBoundaryViolations(source, file!, { root: sourceRoot, language: "ts" })).toEqual([]);
        modules[key!] = compile(source, file!);
    }
    const context = createContext({ __clone: structuredClone, __equal: isDeepStrictEqual, __isBuffer: Buffer.isBuffer, __moduleText: JSON.stringify(modules) });
    runInContext(FIXTURE_KERNEL, context, { timeout: 1000 });
    const controller = runInContext("__iosFixture", context, { timeout: 1000 }) as Fixture;
    controller.initialize();
    return controller;
}

async function observe(spec: Record<string, unknown>): Promise<Observation> {
    const current = fixture();
    const after = await current.run(spec);
    if(after.error)expect(after.errorIsRaw).toBe(true);
    for (const row of after.traces) if (Array.isArray(row) && row[0] === "execute") expect(row[3]).toBe(true);
    expect(after.denied).toEqual({ process: 0, fs: 0, network: 0, timer: 0, clone: 0 });
    const proof = validateNegativeProof(structuredClone(current.negative(after.ports)));
    for (const mutation of ["zero", "category", "other", "native", "records"] as const) {
        const bad = structuredClone(proof), first = bad.cases[0]!;
        if (mutation === "zero") { first.after.process = first.before.process; first.delta = 0; }
        if (mutation === "category") first.category = "network";
        if (mutation === "other") first.after.fs++;
        if (mutation === "native") first.nativeTrace.after++;
        if (mutation === "records") first.recordsUnchanged = false;
        assert.throws(() => validateNegativeProof(bad), { code: "ERR_ASSERTION" });
    }
    return after;
}

// Current policy with fixed native record/command leaves and actual native
// claim/cleanup/CAS helpers. This does
// not certify real process/filesystem behavior or replace the HTTP binding.
describe("iOS distinct broker lifecycle current native controls", () => {
    it("preserves definition-only and provisioned create, raw UDID parsing and publication", async () => {
        const definition = await observe({}); expect(definition.result?.status).toBe(200);
        const provisioned = await observe({ provision: true }); expect(provisioned.result?.status).toBe(200);
        expect(provisioned.records).toMatchObject([{ udid: "created-udid", authority: "host-broker", status: "stopped" }]);
    });
    it("returns original invalid-created-UDID502 without inventing rollback or metadata", async () => {
        const observed = await observe({ provision: true, invalidUdid: true });
        expect(observed.result).toMatchObject({ status: 502, payload: { error: "ios-simulator-create-invalid-udid" } });
        expect(observed.records).toEqual([]);
        expect(observed.traces.filter(row => Array.isArray(row) && row[0] === "execute")).toHaveLength(1);
    });
    it("keeps raw command failure and getter/runner error identity before state writes", async () => {
        expect((await observe({ provision: true, commandFailure: true })).result).toMatchObject({ status: 502, payload: { error: "provider-command-failed", detail: "error: raw error\nstderr: raw stderr\nstdout:  created-udid\n" } });
        await observe({ provision: true, runnerError: true }); await observe({ provision: true, runnerGetterError: true });
    });
    it("selects exact claim compensation and retains existing same-UDID authority", async () => {
        expect((await observe({ provision: true, sameUdid: true })).result).toMatchObject({ status: 409, payload: { rollback: { attempted: false, reason: "provider-resource-owned-by-existing-device" } } });
        expect((await observe({ provision: true, otherConflict: true })).result).toMatchObject({ status: 409, payload: { rollback: { attempted: true, ok: true } } });
        expect((await observe({ provision: true, otherConflict: true, rollbackFailure: true })).result).toMatchObject({ status: 502, payload: { error: "owner-device-conflict-rollback-failed" } });
        await observe({ provision: true, claimError: "state" }); await observe({ provision: true, claimError: "raw" });
    });
    it("keeps start boot-only despite explicit wait, and exact stop/delete replacements", async () => {
        const start = await observe({ operation: "device_start", wait: true }); expect(start.result?.status).toBe(200);
        expect(start.records).toMatchObject([{ status: "running" }]);
        expect(start.traces.some(row => Array.isArray(row) && row[0] === "execute"
            && typeof row[1] === "object" && row[1] !== null && "args" in row[1]
            && Array.isArray(row[1].args) && row[1].args.includes("bootstatus"))).toBe(false);
        expect((await observe({ operation: "device_stop" })).records).toMatchObject([{ status: "stopped" }]);
        expect((await observe({ operation: "device_delete" })).records).toEqual([]);
    });
    it("advances expected only after actual committed auxiliary cleanup, preserving partial residue", async () => {
        expect((await observe({ operation: "device_stop", auxiliary: true })).records).toMatchObject([{ status: "stopped", appium: null, recording: null }]);
        const partial = await observe({ operation: "device_delete", partialAuxiliary: true });
        expect(partial.result).toMatchObject({ status: 502, payload: { error: "auxiliary-runtime-cleanup-failed", result: { invoked: false, execution: { mutatesHost: true } } } });
        expect(partial.records).toMatchObject([{ status: "running", appium: null, recording: { authority: "foreign" } }]);
    });
    it("refuses an uncommitted auxiliary successor before provider execution and a later CAS after effects", async () => {
        const early = await observe({ operation: "device_stop", cleanupRace: true }); expect(early.result?.status).toBe(502);
        const late = await observe({ operation: "device_stop", successor: true });
        expect(late.result).toMatchObject({ status: 409, payload: { error: "owner-device-state-conflict", result: { invoked: true } } });
        expect(late.records).toMatchObject([{ name: "Successor", extra: { raw: "winner" } }]);
    });
});

type NativeCommand = { mode: string; provider: string; executable?: string; args?: string[]; [key: string]: unknown };
type NativeResult = NativeCommand & { status: number; stdout: string; stderr: string; error?: string };
type RpcResult = { status: number; payload: Record<string, unknown> };
type HttpControl = {
    home: string; ownerId: string; calls: Array<{ command: NativeCommand; timeoutMs: number; outputLimit: number }>;
    denied: { provider: number }; invoke(params: Record<string, unknown>, authenticated?: boolean): Promise<RpcResult>;
    records(): unknown[]; write(records: unknown[]): string; setNative(effect: (command: NativeCommand) => NativeResult): void;
};
async function withHttp(check: (control: HttpControl) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "ccc-ios-broker-lifecycle-"));
    const restore = isolateDeviceLabTestEnvironment(home), errors: unknown[] = [];
    const cwd = join(home, "project"); mkdirSync(cwd);
    const ownerId = deviceLabOwnerId(cwd), calls: HttpControl["calls"] = [], denied = { provider: 0 };
    let server: Server | undefined;
    let effect = (command: NativeCommand): NativeResult => ({ ...command, status: 0, stderr: "",
        stdout: command.args?.[1] === "list" ? JSON.stringify({ devices: { runtime: [{ name: `ccc-${ownerId}-broker`, udid: "created-udid" }] } })
            : command.args?.[1] === "create" ? " created-udid\n" : "raw output\n" });
    try {
        // No source fallback: these are the actual newly emitted package facade
        // and application paths. The historical pins above are not their pins.
        const emittedBroker = readFileSync(join(project, "packages/device-lab/dist/device-lab-broker.js"), "utf8");
        expect(emittedBroker).toContain("createBrokerIosSimulatorLifecycle");
        expect(emittedBroker).toContain("./device-lab/application/lifecycle/ios-simulator-lifecycle.js");
        expect(readFileSync(join(project, "packages/device-lab/dist/device-lab/application/lifecycle/ios-simulator-lifecycle.js"), "utf8")).toContain("createBrokerIosSimulatorLifecycle");
        server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, providerPaths: { xcrun: "/allocated/xcrun" },
            commandRunner(command, options) {
                if (!["xcrun", "simctl", "host-broker-state"].includes(command.provider)) { denied.provider++; throw Error("DENIED native provider"); }
                calls.push({ command, ...options }); return effect(command);
            },
        });
        const base = await listen(server), endpoint = ownerRpcEndpoint(base, ownerId), headers = ownerRpcHeaders(ownerId);
        const root = backendRoot(ownerId, "ios"), records = () => existsSync(join(root, "devices.json"))
            ? (JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: unknown[] }).devices : [];
        const controller: HttpControl = { home, ownerId, calls, denied, records,
            write: value => join(writeBrokerDevices(ownerId, "ios", value), "devices.json"), setNative: value => { effect = value; },
            async invoke(params, authenticated = true) {
                const response = await fetch(endpoint, { method: "POST", headers: authenticated ? headers : { "content-type": "application/json" },
                    body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "ios-simulator", ...params } }) });
                const payload = await response.json() as Record<string, unknown>;
                expect(denied).toEqual({ provider: 0 }); return { status: response.status, payload };
            },
        };
        expect(calls).toEqual([]); expect(denied).toEqual({ provider: 0 });
        await check(controller); expect(denied).toEqual({ provider: 0 });
    } catch (error) { errors.push(error); }
    finally {
        try { if (server) await close(server); } catch (error) { errors.push(error); }
        try { restore(); } catch (error) { errors.push(error); }
        try { rmSync(home, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "iOS assertion precedes owned listener/home teardown errors");
}

describe("iOS actual emitted authenticated broker/native bindings", () => {
    it("dispatches four operations with broker-only defaults, auth, dry-run and duplicate classification", async () => {
        await withHttp(async c => {
            const create = { command: "device_create", deviceId: "ios-broker", name: "Broker", createSimulator: true, deviceType: "phone-type", runtime: "runtime-id" };
            expect((await c.invoke(create, false)).status).toBe(401); expect(c.calls).toEqual([]);
            const dry = await c.invoke({ ...create, dryRun: true }); expect(dry).toMatchObject({ status: 200, payload: { result: { invoked: false, dryRun: true } } });
            expect(c.records()).toEqual([]); expect(c.calls).toEqual([]);
            const created = await c.invoke(create); expect(created).toMatchObject({ status: 200, payload: { result: { device: { id: "ios-broker", udid: "created-udid", authority: "host-broker", status: "stopped" } } } });
            expect(c.calls[0]).toMatchObject({ command: { provider: "simctl", args: ["simctl", "create", `ccc-${c.ownerId}-broker`, "phone-type", "runtime-id"] }, timeoutMs: 5000, outputLimit: 32768 });
            expect((await c.invoke(create)).status).toBe(409);
            const start = await c.invoke({ command: "device_start", deviceId: "ios-broker", waitForBoot: true });
            expect(start).toMatchObject({ status: 200, payload: { result: { device: { status: "running" }, invoked: true } } });
            expect(c.calls.some(row => row.command.args?.includes("bootstatus"))).toBe(false);
            expect(await c.invoke({ command: "device_stop", deviceId: "ios-broker" })).toMatchObject({ status: 200, payload: { result: { device: { status: "stopped" }, invoked: true } } });
            const before = c.calls.length;
            expect(await c.invoke({ command: "device_stop", deviceId: "ios-broker" })).toMatchObject({ status: 200, payload: { result: { invoked: true, execution: { mode: "exec" } } } });
            expect(c.calls.length).toBeGreaterThan(before);
            expect(await c.invoke({ command: "device_delete", deviceId: "ios-broker", confirmDestructive: true })).toMatchObject({ status: 200, payload: { result: { device: null } } });
            expect(c.records()).toEqual([]);
        });
    }, 30000);
    it("uses real owner/simulator guard before boot and real full-record CAS after shutdown", async () => {
        await withHttp(async c => {
            const original = { id: "ios-broker", backend: "ios-simulator", simulatorName: `ccc-${c.ownerId}-broker`, udid: "created-udid", status: "running", extra: { raw: "old" } };
            c.write([{ ...original, simulatorName: "foreign-simulator" }]);
            const denied = await c.invoke({ command: "device_start", deviceId: original.id });
            expect(denied).toMatchObject({ status: 400, payload: { error: "ios-simulator-not-owner-scoped" } }); expect(c.calls).toEqual([]);
            c.write([original]); const winner = { ...original, name: "Successor", extra: { raw: "winner" } };
            c.setNative(command => {
                if (command.args?.[1] === "shutdown") c.write([winner]);
                return { ...command, status: 0, stdout: command.args?.[1] === "list" ? JSON.stringify({ devices: { runtime: [{ name: original.simulatorName, udid: original.udid }] } }) : "raw shutdown", stderr: "" };
            });
            expect(await c.invoke({ command: "device_stop", deviceId: original.id })).toMatchObject({ status: 409, payload: { error: "owner-device-state-conflict", result: { invoked: true } } });
            expect(c.records()).toEqual([winner]);
        });
    }, 30000);
    it("executes actual malformed/linked native-state guards without provider effects", async () => {
        await withHttp(async c => {
            const file = c.write([]); writeFileSync(file, "malformed raw owner file");
            expect((await c.invoke({ command: "device_start", deviceId: "ios-broker" })).status).toBeGreaterThanOrEqual(400); expect(c.calls).toEqual([]);
            const target = join(c.home, "allocated-external-state.json"); writeFileSync(target, '{"devices":[]}');
            rmSync(file); symlinkSync(target, file);
            expect((await c.invoke({ command: "device_start", deviceId: "ios-broker" })).status).toBeGreaterThanOrEqual(400); expect(c.calls).toEqual([]);
            expect(readFileSync(target, "utf8")).toBe('{"devices":[]}');
        });
    }, 30000);
});
