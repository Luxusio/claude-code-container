import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createFakeAndroidMcpContext, cleanupFakeAndroidMcpContext } from "../helpers/fake-android-mcp-fixture.js";
import { createFakeIosMcpContext, cleanupFakeIosMcpContext } from "../helpers/fake-ios-mcp-fixture.js";
import { deviceLabTestHomeEnvironment } from "../helpers/device-lab-test-environment.js";
import type { PhysicalStopResponse } from "../../../packages/device-lab/providers/ports/physical-stop.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const parse = (result: unknown): Record<string, unknown> => {
    if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
        throw new TypeError("Expected an MCP result with content");
    }
    const first: unknown = result.content[0];
    if (typeof first !== "object" || first === null || !("text" in first) || typeof first.text !== "string") {
        throw new TypeError("Expected MCP text content");
    }
    const parsed: unknown = JSON.parse(first.text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("Expected an MCP JSON object");
    }
    return parsed as Record<string, unknown>;
};
// The emitted broker is a runtime boundary; describe only the actual child
// runner inputs and observations used here without importing its native closure.
type BrokerChildModule = {
    runBrokerBackendChild: (
        script: string, input: string,
        options: { cwd: string; timeoutMs: number; outputLimit: number },
    ) => Promise<{ timedOut: boolean; status: number | null; stdout: string; stderr: string }>;
};
// Existing broker child invocation, captured before extraction. The test also
// checks that the current genuine broker still contains these literal steps.
const childScript = "import { readFileSync } from 'fs';\nconst payload = JSON.parse(readFileSync(0, 'utf8') || '{}');\nconst { moduleUrl, tool, args, handlerName } = payload;\nconst backend = await import(moduleUrl);\nif (!handlerName || typeof backend[handlerName] !== 'function') throw new Error(`Missing backend handler: ${handlerName || '<empty>'}`);\nconst result = await backend[handlerName](tool, args);\nprocess.stdout.write(JSON.stringify({ result: result || null }));";

// This bounded subprocess evaluates each COMPLETE current exported facade and
// genuine repository/lease/lock closure. Only command/process/Appium leaves are
// fake. Canonical entry counters wrap and forward the actual implementation.
const nativeControl = String.raw`
import vm from 'node:vm';import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const [root,home,platform,mode]=process.argv.slice(2),providers=path.join(root,'packages/device-lab/providers');
const calls=[],denied={spawn:0,signal:0,network:0,command:0},entries={};let time=Date.now(),state,cas=0;
const deny=kind=>{denied[kind]++;throw Error('DENIED '+kind)};
class Clock extends Date{constructor(...args){super(...(args.length?args:[time]))}static now(){return time}}
const proc={...process,env:{...process.env,HOME:home,USERPROFILE:home,CCC_PROFILE:'physical-control'},cwd:()=>home,kill:(pid,signal)=>{
 if(pid===process.pid&&signal===0)return true;if(pid===777001&&signal===0){if(mode!=='timeout')throw Error('owned fake exited');return true}return deny('signal')}};
const ctx=vm.createContext({__entry:name=>entries[name]=(entries[name]||0)+1,__cas:(backend,id,expected,next,native)=>{
 cas++;return native(backend,id,(mode==='claim-conflict'&&cas===1||mode==='commit-conflict'&&cas===2)?{...expected,__stale:true}:expected,next)},
 console,process:proc,Date:Clock,Buffer,URL,URLSearchParams,TextEncoder,TextDecoder,
 setTimeout:(fn,ms,...args)=>{time+=ms;return setTimeout(fn,0,...args)},clearTimeout,setInterval:()=>deny('command'),clearInterval,fetch:()=>deny('network')});
const modules=new Map();
const mock=(id,exports)=>{const m=new vm.SyntheticModule(Object.keys(exports),function(){for(const[k,v]of Object.entries(exports))this.setExport(k,v)},{context:ctx,identifier:id});modules.set(id,m);return m};
function successor(){if(mode==='successor')state[platform==='android'?'updateAndroidRealDevice':'updateIosRealDevice']('physical-control',d=>({...d,lifecycle:{runtimeId:'successor'}}))}
async function load(id){if(modules.has(id))return modules.get(id);
 if(id==='os'||id==='node:os')return mock(id,{...await import('node:os'),homedir:()=>home});
 if(id==='child_process'||id==='node:child_process')return mock(id,{...await import('node:child_process'),spawn:()=>deny('spawn'),spawnSync:()=>deny('spawn'),exec:()=>deny('spawn'),execSync:()=>deny('spawn'),execFile:()=>deny('spawn'),execFileSync:()=>deny('spawn')});
 if(!path.isAbsolute(id))return mock(id,{...await import(id.startsWith('node:')?id:'node:'+id)});
 if(id.endsWith('/commands.mjs'))return mock(id,{commandPath:()=>null,run:(exe,args)=>{calls.push(['adb',exe,args]);if(exe!=='fake-adb'||JSON.stringify(args)!==JSON.stringify(['-s','fake-serial','shell','pkill','-2','screenrecord']))return deny('command');return{status:mode==='unsafe'?17:0,stdout:'',stderr:'fake denied'}},runBuffer:()=>deny('command'),runWithTimeout:()=>deny('command')});
 if(id.endsWith('/backends/android.mjs'))return mock(id,{androidDiscovery:()=>{calls.push(['discover']);return{adb:'fake-adb'}},androidScreenshotResult:()=>deny('command'),appiumDiscovery:()=>deny('command')});
 if(id.endsWith('/backends/ios-simulator.mjs'))return mock(id,{iosDiscovery:()=>deny('command'),iosAppiumDiscovery:()=>deny('command'),normalizeIosOrientation:()=>deny('command'),fetchIosAppiumJson:async(url,options)=>{calls.push(['session',url,options.method]);if(url!=='http://fixture.invalid/session/fixture-session'||options.method!=='DELETE')return deny('network');return{}}});
 if(id.endsWith('/state/process-identity.mjs'))return mock(id,{processIdentityMatches:()=>true,readProcessIdentity:()=>({pid:process.pid,startToken:'private-self',commandHash:'a'.repeat(64)}),readProcessIdentityAsync:async()=>({pid:process.pid,startToken:'private-self',commandHash:'a'.repeat(64)}),refreshOwnedRuntimeProcessIdentity:()=>deny('command'),waitForProcessIdentity:async()=>deny('command'),inspectProcessIdentity:(identity,pid)=>{calls.push(['inspect',pid]);if(![777001,777002,process.pid].includes(pid))return deny('signal');return{status:pid===777001&&mode!=='timeout'?'exited':'match'}},signalOwnedRuntimeProcess:(recording,signal)=>{
 calls.push(['signal',recording.pid,signal]);if(recording.pid!==777001||signal!=='SIGINT')return deny('signal');successor();if(mode==='raw-signal')throw Error('raw owned signal');return mode==='unsafe'?{attempted:false,signaled:false,reason:'unsafe'}:mode==='successor'?{attempted:false,signaled:false,exited:true,reason:'runtime-process-exited'}:{attempted:true,signaled:true}},terminateOwnedRuntimeProcess:async(runtime,label,options)=>{calls.push(['terminate',runtime.pid,label,options.timeoutMs]);if(runtime.pid!==777002||label!=='iOS physical Appium'||options.timeoutMs!==1000)return deny('signal');return mode==='partial'?{exited:false,error:'raw Appium failure'}:{exited:true}}});
 let source=fs.readFileSync(id,'utf8');
 if(id.endsWith('/state/device-store.mjs')){source=source.replace('export function transitionOwnerDeviceRecord(','function nativeTransitionOwnerDeviceRecord(');source+='\nexport function transitionOwnerDeviceRecord(backend,id,expected,next){return __cas(backend,id,expected,next,nativeTransitionOwnerDeviceRecord)}\n'}
 if(id.endsWith('/application/physical-stop.mjs')){assert.ok(source.includes('export function createPhysicalStopApplication('));source=source.replace('export function createPhysicalStopApplication(','function nativeCreatePhysicalStopApplication(');source+='\nexport function createPhysicalStopApplication(ports){__entry("compose");const app=nativeCreatePhysicalStopApplication(ports);return Object.fromEntries(Object.entries(app).map(([name,method])=>[name,(...args)=>{__entry(name);return Reflect.apply(method,app,args)}]))}\n'}
 const m=new vm.SourceTextModule(source,{context:ctx,identifier:id,initializeImportMeta(meta){meta.url=pathToFileURL(id).href;meta.resolve=()=>pathToFileURL(path.join(providers,'context.mjs')).href}});modules.set(id,m);return m}
const backend=await load(path.join(providers,'backends',platform+'-device.mjs'));
await backend.link((spec,parent)=>load(spec.startsWith('.')?path.resolve(path.dirname(parent.identifier),spec):spec));await backend.evaluate();
state=modules.get(path.join(providers,'state',platform+'-device-state.mjs')).namespace;
const store=modules.get(path.join(providers,'state/device-store.mjs')).namespace,leases=modules.get(path.join(providers,'state/physical-lease-store.mjs')).namespace;
const fdBefore=process.platform==='linux'?fs.readdirSync('/proc/self/fd').length:null;
const owner=modules.get(path.join(providers,'context.mjs')).namespace.ownerId(),hardware=platform==='android'?'fake-serial':'fake-udid';
const lease=leases.claimPhysicalLease(platform+'-device',hardware,'physical-control',{claimNonce:'private-nonce'});assert.equal(lease.ok,true);
const original={id:'physical-control',ownerId:owner,backend:platform+'-device',physical:true,status:'running',serial:'fake-serial',udid:'fake-udid',pid:42,leaseClaimId:lease.lease.claimId,leaseClaimNonce:'private-nonce',extra:'raw-extra',recording:{active:!['inactive','commit-conflict','serialized'].includes(mode),pid:777001,runtimeId:'owned-recorder',processIdentity:{pid:777001},extra:'recording-extra'},appium:{runtimeId:'owned-appium',processOwner:'device-lab-mcp',startedBy:'direct-provider',serverPid:777002,processIdentity:{pid:777002},sessionId:'fixture-session',serverUrl:'http://fixture.invalid'}};
assert.equal(state[platform==='android'?'claimAndroidRealDevice':'claimIosRealDevice'](original).ok,true);
const leaseFile=path.join(home,'.ccc/devices/physical-leases',platform+'-device','locks',encodeURIComponent(hardware)+'.json');const before=JSON.parse(fs.readFileSync(leaseFile,'utf8'));
const unknown=path.join(home,'unknown-retained');fs.writeFileSync(unknown,'untouched unknown target\n');
if(mode==='serialized'){let release,ready;const gate=new Promise(r=>release=r),started=new Promise(r=>ready=r),order=[];
 const first=store.withOwnerDeviceOperation(platform+'-device',original.id,async()=>{order.push('first');ready();await gate;order.push('first-done')});await started;
 const second=store.withOwnerDeviceOperation(platform+'-device',original.id,()=>order.push('second'));await new Promise(r=>setTimeout(r,20));assert.deepEqual(order,['first']);release();await Promise.all([first,second]);assert.deepEqual(order,['first','first-done','second'])}
const handler=backend.namespace[platform==='android'?'handleAndroidRealTool':'handleIosRealTool'];let result,error;
try{result=await handler('device_stop',mode==='missing'?{deviceId:'absent',backend:platform+'-device'}:{deviceId:original.id})}catch(e){error=e.message}
const current=state[platform==='android'?'findAndroidRealDevice':'findIosRealDevice'](original.id);
const after=JSON.parse(fs.readFileSync(leaseFile,'utf8'));assert.equal(after.claimId,before.claimId);assert.equal(after.claimNonce,before.claimNonce);
assert.equal(fs.readFileSync(unknown,'utf8'),'untouched unknown target\n');assert.deepEqual(denied,{spawn:0,signal:0,network:0,command:0});assert.equal(entries.stop||0,mode==='missing'&&platform==='android'?0:1);
if(mode==='inactive'){const detached=await handler('device_detach',{deviceId:original.id});assert.equal(detached.isError,false);assert.equal(fs.existsSync(leaseFile),false);assert.ok(entries.cleanup>=1);assert.ok(entries.claimLifecycle>=1)}
const op=path.join(home,'.ccc/devices/owners',owner,platform+'-device','operations');assert.ok(!fs.existsSync(op)||fs.readdirSync(op).length===0);
if(fdBefore!==null)assert.equal(fs.readdirSync('/proc/self/fd').length,fdBefore);
process.stdout.write(JSON.stringify({result,error,current,calls,entries,denied,leasePreserved:true,lockJoined:true,fdJoined:true}));
`;
type Control = { result?: PhysicalStopResponse; error?: string; current: Record<string, unknown>; calls: unknown[][];
    entries: Record<string, number>; denied: Record<string, number>; leasePreserved: boolean; lockJoined: boolean; fdJoined: boolean };
function nativeCase(platform: string, mode: string, check: (control: Control) => void): void {
    const directory = mkdtempSync(join(tmpdir(), "ccc-physical-stop-native-"));
    const script = join(directory, "control.mjs"); writeFileSync(script, nativeControl, { flag: "wx" });
    let failed = true;
    try {
        const run = spawnSync(process.execPath, ["--experimental-vm-modules", script, root, directory, platform, mode],
            { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024, env: { ...deviceLabTestHomeEnvironment(directory), PATH: "", NODE_OPTIONS: "" } });
        expect(run.error, directory).toBeUndefined(); expect(run.status, `${directory}: ${run.stderr}`).toBe(0);
        const result = JSON.parse(run.stdout) as Control;
        expect(result.denied).toEqual({ spawn: 0, signal: 0, network: 0, command: 0 });
        expect(result).toMatchObject({ leasePreserved: true, lockJoined: true, fdJoined: true }); check(result); failed = false;
    } finally { if (!failed) rmSync(directory, { recursive: true, force: true }); }
}

describe("physical stop native facade composition", () => {
    for (const platform of ["android", "ios"]) describe(platform, () => {
        it("whole public wrapper reaches actual canonical stop and shared detach with genuine native storage/lease/lock", () => {
            nativeCase(platform, "inactive", c => { expect(parse(c.result!)).toMatchObject({ stopped: false, detached: false, physicalDevicePoweredOff: false });
            expect(c.current).toMatchObject({ status: "attached", recording: null, appium: null, pid: null, extra: "raw-extra" });
            expect(c.current.lifecycle).toBeUndefined(); expect(c.entries.stop).toBe(1); expect(c.entries.cleanup).toBeGreaterThanOrEqual(1); });
        });
        it.each(["unsafe", "timeout"])("preserves native runtime metadata and lease on %s", mode => {
            nativeCase(platform, mode, c => { expect(c.result?.isError).toBe(true); expect(c.current.status).toBe("running");
            expect(c.current.recording).toMatchObject({ active: true, extra: "recording-extra" });
            if (platform === "ios") expect(c.calls.some(row => ["session", "terminate"].includes(String(row[0])))).toBe(false);
            if (mode === "timeout") expect(c.result?.content[0].text).toContain("3000ms"); });
        });
        it.each(["claim-conflict", "commit-conflict", "successor"])("native raw CAS/current generation preserves %s", mode => {
            nativeCase(platform, mode, c => { expect(parse(c.result!)).toMatchObject({ error: "owner-device-state-conflict", operation: mode === "claim-conflict" ? "stop-claim" : "stop", found: true });
            if (mode === "claim-conflict") expect(c.calls).toEqual([]);
            if (mode === "successor") expect(c.current.lifecycle).toMatchObject({ runtimeId: "successor" }); });
        });
        it("raw native signal exception propagates while genuine operation lock unwinds", () => {
            nativeCase(platform, "raw-signal", c => { expect(c.error).toBe("raw owned signal"); expect(c.current.status).toBe("stopping"); });
        });
        it("preserves the platform's explicit-backend missing wrapper", () => {
            nativeCase(platform, "missing", c => {
                if (platform === "android") expect(parse(c.result!)).toMatchObject({ error: "device-not-found", backend: "android-device", deviceId: "absent" });
                else expect(c.result).toBeUndefined();
                expect(c.current.status).toBe("running"); expect(c.calls).toEqual([]);
            });
        });
        it("genuine operation lock serializes the same device before canonical stop", () => {
            nativeCase(platform, "serialized", c => { expect(c.result?.isError).toBe(false); expect(c.current.status).toBe("attached"); });
        });
    });
    it("iOS lower owned-Appium failure retains Appium and records partial recorder stop", () => {
        nativeCase("ios", "partial", c => { expect(c.result?.content[0].text).toBe("raw Appium failure; Appium metadata and physical lease were preserved for retry.");
        expect(c.current.recording).toMatchObject({ active: false, extra: "recording-extra", endedAt: expect.any(String) });
        expect(c.current.appium).toMatchObject({ runtimeId: "owned-appium" }); });
    });
});

describe.skipIf(process.platform === "win32")("physical stop genuine emitted public bindings", () => {
    for (const platform of ["android", "ios"]) it(`${platform} emitted MCP and existing backend child keep lease and shared detach semantics`, async () => {
        for (const relative of ["backends/android-device.mjs", "backends/ios-device.mjs", "application/physical-stop.mjs", "ports/physical-stop.mjs"]) {
            const source = join(root, "packages/device-lab/providers", relative), emitted = join(root, "dist/packages/device-lab/providers", relative);
            expect(existsSync(emitted), `mandatory genuine output missing: ${emitted}`).toBe(true);
            expect(readFileSync(emitted, "utf8")).toBe(readFileSync(source, "utf8"));
        }
        const brokerFile = join(root, "packages/device-lab/dist/device-lab-broker.js");
        const broker = readFileSync(brokerFile, "utf8");
        const { runBrokerBackendChild } = await import(pathToFileURL(brokerFile).href) as BrokerChildModule;
        for (const line of childScript.split("\n")) expect(broker).toContain(JSON.stringify(line));
        const context = await (platform === "android" ? createFakeAndroidMcpContext() : createFakeIosMcpContext());
        let emittedClient: Client | undefined; const failures: unknown[] = [];
        try {
            const backend = platform + "-device", deviceId = platform + "-physical-policy-binding";
            const attached = await context.client.callTool({ name: "attach", arguments: { backend, deviceId, name: deviceId,
                ...(platform === "android" ? { serial: "R5CREAL123" } : { udid: "00008110-001C195E0E91801E" }) } });
            expect(attached.isError, JSON.stringify(attached)).not.toBe(true);
            const device = parse(attached).device as { ownerId: string; serial: string; udid: string };
            const leaseFile = join(context.homeDir, ".ccc/devices/physical-leases", backend, "locks", encodeURIComponent(platform === "android" ? device.serial : device.udid) + ".json");
            const before = JSON.parse(readFileSync(leaseFile, "utf8")) as Record<string, unknown>;
            const env = { ...deviceLabTestHomeEnvironment(context.homeDir), PATH: context.binDir,
                CCC_PROFILE: platform === "ios" ? "test-" + basename(context.homeDir) : "", NODE_ENV: "test",
                ...(platform === "android" ? { NODE_OPTIONS: "--require=" + JSON.stringify(join(context.homeDir, "node-provider-routing.cjs")), FAKE_ANDROID_LOG: context.logPath } : {}) };
            const emittedAdapter = join(root, "dist/device-lab-mcp/server.mjs"); expect(existsSync(emittedAdapter), "mandatory genuine MCP assembly").toBe(true);
            expect(readFileSync(emittedAdapter, "utf8"), "genuine MCP bundle includes canonical physical policy").toContain("function createPhysicalStopApplication(");
            emittedClient = new Client({ name: "physical-stop-emitted", version: "1" }, { capabilities: {} });
            await emittedClient.connect(new StdioClientTransport({ command: process.execPath, args: [emittedAdapter], cwd: root, env }));
            const stopped = await emittedClient.callTool({ name: "stop", arguments: { deviceId, implicitBroker: false, detail: true } });
            expect(stopped.isError, JSON.stringify(stopped)).not.toBe(true); expect(parse(stopped)).toMatchObject({ stopped: false, detached: false, physicalDevicePoweredOff: false, device: { status: "attached" } });
            const after = JSON.parse(readFileSync(leaseFile, "utf8")) as Record<string, unknown>;
            expect(after).toMatchObject({ claimId: before.claimId, claimNonce: before.claimNonce, deviceId: before.deviceId });
            const previous = { ...process.env };
            try {
                for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, env);
                const child = await runBrokerBackendChild(childScript, JSON.stringify({
                    moduleUrl: pathToFileURL(join(root, "dist/packages/device-lab/providers/backends", platform + "-device.mjs")).href,
                    handlerName: platform === "android" ? "handleAndroidRealTool" : "handleIosRealTool", tool: "device_stop", args: { deviceId },
                }), { cwd: root, timeoutMs: 10000, outputLimit: 1024 * 1024 });
                expect(child.timedOut).toBe(false); expect(child.status, child.stderr).toBe(0);
                expect(parse((JSON.parse(child.stdout) as { result: PhysicalStopResponse }).result)).toMatchObject({ stopped: false, detached: false, physicalDevicePoweredOff: false });
            } finally { for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, previous); }
            const detached = await context.client.callTool({ name: "detach", arguments: { deviceId } });
            expect(detached.isError, JSON.stringify(detached)).not.toBe(true); expect(parse(detached)).toMatchObject({ detached: deviceId, physicalDevicePoweredOff: false });
            expect(existsSync(leaseFile)).toBe(false);
        } catch (error) { failures.push(error); }
        finally {
            try { await emittedClient?.close(); } catch (error) { failures.push(error); }
            try { if (platform === "android") await cleanupFakeAndroidMcpContext(context); else await cleanupFakeIosMcpContext(context); }
            catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "physical stop assertion failed before cleanup failures");
    }, 30000);
});
