import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const providers = join(root, "packages/device-lab/providers");
const guid = "11111111-1111-4111-8111-111111111111";
function fixture() {
    const home = mkdtempSync(join(tmpdir(), "ccc-sandbox-stop-facade-"));
    const script = join(home, "child.mjs"); const log = join(home, "native.jsonl");
    writeFileSync(script, `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const mode=process.argv[2],log=${JSON.stringify(log)},guid=${JSON.stringify(guid)};
const blocked=path.join(process.env.HOME,'second-blocked');
const nativeOpen=fs.openSync,nativeRename=fs.renameSync;let reportedBlocked=false;
const operationLock=file=>typeof file==='string'&&path.basename(path.dirname(file))==='operations'&&file.endsWith('.lock');
fs.openSync=function(file,flags,...rest){
 if(!operationLock(file)||flags!=='wx')return nativeOpen(file,flags,...rest);
 try{const descriptor=nativeOpen(file,flags,...rest);fs.appendFileSync(log,JSON.stringify({kind:'lock-acquired',actor:mode})+'\\n');return descriptor}
 catch(error){if(error.code==='EEXIST'&&mode==='second'&&!reportedBlocked){reportedBlocked=true;fs.appendFileSync(log,JSON.stringify({kind:'lock-blocked',actor:mode})+'\\n');fs.writeFileSync(blocked,'observed actual lock contention')}throw error}
};
fs.renameSync=function(source,destination){if(operationLock(source)&&destination.endsWith('.release'))fs.appendFileSync(log,JSON.stringify({kind:'lock-release-start',actor:mode})+'\\n');return nativeRename(source,destination)};
const nativeSpawn=cp.spawnSync;
cp.spawnSync=function(command,args=[],options){
 const lookup=command==='where'?args[0]:command==='/bin/sh'&&args[0]==='-c'&&args[1]?.startsWith('command -v ')?args[1].slice(11):null;
 if(lookup!==null)return {status:lookup==='wsb'?0:1,stdout:lookup==='wsb'?'scope-safe-fake-wsb\\n':'',stderr:''};
 if(command==='scope-safe-fake-wsb'){
  assert.deepEqual(args,['stop','--id',guid]); assert.equal(options.timeout,60000); assert.equal(options.windowsHide,true);
  fs.appendFileSync(log,JSON.stringify({kind:'enter',actor:mode,args,timeout:options.timeout})+'\\n');
  process.send?.('native-enter');
  if(mode==='first'){const deadline=Date.now()+10000;while(!fs.existsSync(blocked)&&Date.now()<deadline)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);assert.equal(fs.existsSync(blocked),true,'second process must actually observe the held long lock')}
  fs.appendFileSync(log,JSON.stringify({kind:'exit',actor:mode})+'\\n');
  return {status:mode==='failure'?7:0,stdout:'',stderr:mode==='failure'?'native-stop-failed':'',...(mode==='status-zero-error'?{error:new Error('native-status-zero-error')}:{})};
 }
 if(process.platform==='darwin'&&command==='/bin/ps'&&args.length===4&&args[0]==='-p'&&args[1]===String(process.pid)&&args[2]==='-o'&&['lstart=','command='].includes(args[3])){
  assert.equal(options.windowsHide,true);assert.ok(Number.isInteger(options.timeout)&&options.timeout>0&&options.timeout<=5000);
  return nativeSpawn(command,args,options); // Exact read-only own-process state-lock identity on macOS.
 }
 if(/powershell|pwsh/i.test(String(command)))return nativeSpawn(command,args,options); // Read-only own-process identity adapter on Windows.
 throw Error('unexpected native command: '+command+' '+JSON.stringify(args));
};
syncBuiltinESMExports();
const backend=await import(${JSON.stringify(pathToFileURL(join(providers, "backends/windows-sandbox.mjs")).href)});
const state=await import(${JSON.stringify(pathToFileURL(join(providers, "state/device-store.mjs")).href)});
const {ownerId}=await import(${JSON.stringify(pathToFileURL(join(providers, "context.mjs")).href)});
const lock=path.join(process.env.HOME,'.ccc/devices/host-locks/windows-sandbox.json');
if(mode==='seed'){
 state.writeOwnerDevices('windows',[{id:'sandbox',status:'running',backend:'windows-sandbox',sandboxId:guid,singletonClaimId:'old',recording:{active:true,runtimeId:'recording'},minimizeWatchdogLaunch:{pid:17},helperSessionLaunch:{ok:true,minimizeWatchdogPid:17}}]);
 fs.mkdirSync(path.dirname(lock),{recursive:true});fs.writeFileSync(lock,JSON.stringify({provider:'windows-sandbox',ownerId:ownerId(),deviceId:'sandbox',sandboxId:guid,claimId:'old'}));
 console.log(JSON.stringify({owner:ownerId()}));
}else if(mode==='cleanup'){
 const callback=cancelPath=>({attempted:true,ok:true,cancelPath});
 const result=backend.cleanupWindowsSandboxMinimizeWatchdogs({id:'sandbox',status:'running',minimizeWatchdogLaunch:{pid:17},helperSessionLaunch:[]},callback);
 assert.equal(result.device.helperSessionLaunch.minimizeWatchdogPid,null);
 console.log(JSON.stringify({cleanup:true}));
}else{
 const result=await backend.handleWindowsTool('device_stop',{deviceId:'sandbox'});
 const device=state.findOwnerDevice('windows','sandbox');
 console.log(JSON.stringify({result,device,lockExists:fs.existsSync(lock),cancelExists:fs.existsSync(path.join(process.env.HOME,'.ccc/devices/owners',ownerId(),'windows/sandbox/downloads/ccc-minimize-watchdog.cancel'))}));
}
`);
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), TMPDIR: home, TMP: home, TEMP: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
    const execute = (mode: string) => spawnSync(process.execPath, [script, mode], { cwd: home, env, encoding: "utf8", timeout: 20000, windowsHide: true });
    const seed = execute("seed"); if (seed.status !== 0) { rmSync(home, { recursive: true, force: true }); throw new Error(seed.stderr); }
    return { home, script, log, env, execute };
}
function output(text: string): { device: Record<string, unknown>; result: { isError?: boolean; content?: { text: string }[] }; lockExists: boolean; cancelExists: boolean } { return JSON.parse(text.trim().split(/\r?\n/).at(-1)!); }

describe("actual public Sandbox facade with private native/state adapters", () => {
    it.each(["success", "status-zero-error"])("retains native argv/budget, actual claim release and CURRENT auxiliary fields (%s)", mode => {
        const f = fixture();
        try {
            const execution = f.execute(mode); expect(execution.status, execution.stderr).toBe(0); const value = output(execution.stdout);
            expect(value.result.isError).not.toBe(true); expect(value.device).toMatchObject({ status: "stopped", sandboxId: guid, lifecycle: null, singletonClaimId: null, recording: { active: true, runtimeId: "recording" }, minimizeWatchdogLaunch: { pid: 17 }, helperSessionLaunch: { ok: true, minimizeWatchdogPid: null } });
            expect(value.lockExists).toBe(false); expect(value.cancelExists).toBe(true);
            const trace = readFileSync(f.log, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line)); expect(trace.filter(row => row.kind === "enter" || row.kind === "exit")).toEqual([{ kind: "enter", actor: mode, args: ["stop", "--id", guid], timeout: 60000 }, { kind: "exit", actor: mode }]);
        } finally { rmSync(f.home, { recursive: true, force: true }); }
    });
    it("preserves retry state and actual singleton on native failure", () => {
        const f = fixture();
        try {
            const execution = f.execute("failure"); expect(execution.status, execution.stderr).toBe(0); const value = output(execution.stdout);
            expect(value.result.isError).toBe(true); expect(value.result.content?.[0].text).toBe("Error: native-stop-failed");
            expect(value.device).toMatchObject({ status: "running", singletonClaimId: "old", minimizeWatchdogLaunch: null, helperSessionLaunch: { minimizeWatchdogPid: null } });
            expect(Object.hasOwn(value.device, "lifecycle")).toBe(false); expect(value.lockExists).toBe(true);
        } finally { rmSync(f.home, { recursive: true, force: true }); }
    });
    it("serializes two public-facade processes for one private owner/device and stops runtime once", async () => {
        const f = fixture(); const children: ReturnType<typeof spawn>[] = [];
        let outputFirst = "", outputSecond = "", errorFirst = "", errorSecond = "";
        try {
            const first = spawn(process.execPath, [f.script, "first"], { cwd: f.home, env: f.env, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true }); children.push(first);
            first.stdout?.on("data", data => { outputFirst += data; }); first.stderr?.on("data", data => { errorFirst += data; });
            const firstExit = new Promise<number | null>((resolve, reject) => { first.once("error", reject); first.once("exit", resolve); });
            await new Promise<void>((resolve, reject) => { first.once("message", () => resolve()); first.once("error", reject); first.once("exit", code => reject(new Error(`first exited before stop: ${code}: ${errorFirst}`))); });
            const second = spawn(process.execPath, [f.script, "second"], { cwd: f.home, env: f.env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); children.push(second);
            second.stdout?.on("data", data => { outputSecond += data; }); second.stderr?.on("data", data => { errorSecond += data; });
            const secondExit = new Promise<number | null>((resolve, reject) => { second.once("error", reject); second.once("exit", resolve); });
            expect(await firstExit, errorFirst).toBe(0); expect(await secondExit, errorSecond).toBe(0);
            expect(output(outputFirst).device.status).toBe("stopped"); expect(output(outputSecond).device.status).toBe("stopped");
            const trace = readFileSync(f.log, "utf8").trim().split(/\r?\n/).map(line => JSON.parse(line));
            expect(trace.map(row => [row.kind, row.actor])).toEqual([["lock-acquired", "first"], ["enter", "first"], ["lock-blocked", "second"], ["exit", "first"], ["lock-release-start", "first"], ["lock-acquired", "second"], ["lock-release-start", "second"]]);
            expect(trace.filter(row => row.kind === "enter")).toHaveLength(1);
            const captureDirectory = process.env.CCC_SANDBOX_STOP_EVIDENCE_DIR;
            if (captureDirectory) {
                expect(resolve(captureDirectory)).toBe(join(root, "doc/harness/checkpoints/recovery-evidence"));
                writeFileSync(join(captureDirectory, "two-process-native-lock-trace.json"), JSON.stringify({ nativeStopCount: 1, actualNativeLongLockTrace: trace }, null, 2) + "\n");
            }
        } finally { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill(); rmSync(f.home, { recursive: true, force: true }); }
    }, 30000);
});

function lifecycleFacade(mode: string) {
    const home = mkdtempSync(join(tmpdir(), "ccc-sandbox-lifecycle-facade-"));
    const script = join(home, "lifecycle.mjs");
    writeFileSync(script, `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const mode=process.argv[2],guid=${JSON.stringify(guid)},other='22222222-2222-4222-8222-222222222222',third='33333333-3333-4333-8333-333333333333';
const trace=[];let launched=false,lists=0,state,owner,scratch,lock;
const nativeRm=fs.rmSync,nativeSpawnSync=cp.spawnSync;
const identityArgs=['-WindowStyle','Hidden','-NoProfile','-NonInteractive','-Command',"$P = Get-CimInstance Win32_Process -Filter 'ProcessId = "+process.pid+"' -ErrorAction SilentlyContinue; $H = Get-Process -Id "+process.pid+" -ErrorAction SilentlyContinue; if ($P -and $H) { [pscustomobject]@{ startToken = $H.StartTime.ToUniversalTime().ToString('o'); commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }"];
fs.rmSync=function(file,options){if(mode==='delete-scratch-throw'&&file===scratch&&options?.recursive)throw Error('scratch denied');return nativeRm(file,options)};
cp.spawn=function(command,args){throw Error('unexpected detached native command: '+command+' '+JSON.stringify(args))};
cp.spawnSync=function(command,args=[],options={}){
 const lookup=command==='where'?args[0]:command==='/bin/sh'&&args[0]==='-c'&&args[1]?.startsWith('command -v ')?args[1].slice(11):null;
 if(lookup!==null)return {status:lookup==='wsb'&&mode!=='start-prerequisite'?0:1,stdout:lookup==='wsb'&&mode!=='start-prerequisite'?'scope-safe-fake-wsb\\n':'',stderr:''};
 if(command==='scope-safe-fake-wsb'){
  assert.equal(options.windowsHide,true);trace.push({command,args,timeout:options.timeout});
  if(args[0]==='list'){
   assert.deepEqual(args,['list','--raw']);lists++;
   if(mode==='start-inventory-failure')return {status:8,stdout:'inventory stdout',stderr:'',error:new Error('inventory error')};
   if(!launched)return {status:0,stdout:'[]',stderr:''};
   if(mode==='start-ambiguous')return {status:0,stdout:JSON.stringify([other,third]),stderr:'inventory warning',error:new Error('inventory opaque')};
   if(mode==='start-singleton-conflict'){
    const current=state.findOwnerDevice('windows','sandbox');
    state.writeOwnerDevices('windows',[{...current,status:'running',sandboxId:other,singletonClaimId:'successor',lifecycle:{runtimeId:'successor',operation:'start',claimedAt:'2026-10-10T00:00:00.000Z'}}]);
    const singleton=JSON.parse(fs.readFileSync(lock,'utf8'));fs.writeFileSync(lock,JSON.stringify({...singleton,sandboxId:other,claimId:'successor'}));
    return {status:0,stdout:JSON.stringify([other]),stderr:''};
   }
   if(mode==='start-complete-conflict'){
    const current=state.findOwnerDevice('windows','sandbox');
    state.writeOwnerDevices('windows',[{...current,status:'running',singletonClaimId:'successor',lifecycle:{runtimeId:'successor',operation:'start',claimedAt:'2026-10-10T00:00:00.000Z'}}]);
    const singleton=JSON.parse(fs.readFileSync(lock,'utf8'));fs.writeFileSync(lock,JSON.stringify({...singleton,claimId:'successor'}));
   }
   return {status:0,stdout:JSON.stringify([guid]),stderr:''};
  }
  if(args[0]==='stop'){
   assert.deepEqual(args,['stop','--id',guid]);assert.equal(options.timeout,60000);
   return {status:mode==='delete-native-failure'?7:0,stdout:'stop stdout',stderr:mode==='delete-native-failure'?'stop stderr':'',error:new Error('stop error')};
  }
 }
 if(process.platform==='darwin'&&command==='/bin/ps'&&args.length===4&&args[0]==='-p'&&args[1]===String(process.pid)&&args[2]==='-o'&&['lstart=','command='].includes(args[3])){
  assert.equal(options.windowsHide,true);assert.ok(Number.isInteger(options.timeout)&&options.timeout>0&&options.timeout<=5000);
  return nativeSpawnSync(command,args,options); // Exact read-only own-process state-lock identity on macOS.
 }
 if(/powershell(?:\\.exe)?$/i.test(String(command))){
  if(args.length===identityArgs.length&&args.every((arg,index)=>arg===identityArgs[index])){
   assert.equal(options.windowsHide,true);assert.ok(Number.isInteger(options.timeout)&&options.timeout>0&&options.timeout<=5000);
   return nativeSpawnSync(command,args,options); // Exact read-only own-process identity query on native Windows.
  }
  assert.equal(options.timeout,120000);assert.equal(options.windowsHide,true);
  trace.push({command,args,timeout:options.timeout});launched=true;
  return {status:mode==='start-launch-failure'?7:0,stdout:'launch stdout',stderr:mode==='start-launch-failure'?'launch stderr':'',error:new Error('launch error')};
 }
 throw Error('unexpected native command: '+command+' '+JSON.stringify(args));
};
syncBuiltinESMExports();
const backend=await import(${JSON.stringify(pathToFileURL(join(providers, "backends/windows-sandbox.mjs")).href)});
state=await import(${JSON.stringify(pathToFileURL(join(providers, "state/device-store.mjs")).href)});
const {ownerId}=await import(${JSON.stringify(pathToFileURL(join(providers, "context.mjs")).href)});
owner=ownerId();scratch=path.join(process.env.HOME,'.ccc/devices/owners',owner,'windows/sandbox');lock=path.join(process.env.HOME,'.ccc/devices/host-locks/windows-sandbox.json');
const running=mode==='start-status'||mode==='delete-native-failure';
state.writeOwnerDevices('windows',mode==='missing'?[]:[{id:'sandbox',status:running?'running':'stopped',backend:'windows-sandbox',sandboxId:guid,minimized:false,...(running?{singletonClaimId:'old'}:{})}]);
fs.mkdirSync(scratch,{recursive:true});fs.writeFileSync(path.join(scratch,'preserved-marker'),'scratch');
if(running){fs.mkdirSync(path.dirname(lock),{recursive:true});fs.writeFileSync(lock,JSON.stringify({provider:'windows-sandbox',ownerId:owner,deviceId:'sandbox',sandboxId:guid,claimId:'old'}))}
// State publication above establishes this process's real identity on its native host.
// Only the provider-facing native leaves below use the Windows launch/registration branch.
Object.defineProperty(process,'platform',{value:'win32'});
if(mode==='missing'){
 for(const name of ['device_start','device_stop','device_delete'])assert.equal(await backend.handleWindowsTool(name,{deviceId:'missing'}),undefined);
 console.log(JSON.stringify({missing:true,trace}));
}else{
 let result,thrown;
 try{result=await backend.handleWindowsTool(mode.startsWith('delete')?'device_delete':'device_start',{deviceId:'sandbox',minimized:false,force:mode==='delete-native-failure'})}catch(error){thrown=error.message}
 console.log(JSON.stringify({result,thrown,device:state.findOwnerDevice('windows','sandbox'),trace,lists,lockExists:fs.existsSync(lock),scratchExists:fs.existsSync(scratch),scratch}));
}
`);
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData/Roaming"), LOCALAPPDATA: join(home, "AppData/Local"), TMPDIR: home, TMP: home, TEMP: home, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR };
    try {
        const execution = spawnSync(process.execPath, [script, mode], { cwd: home, env, encoding: "utf8", timeout: 20000, windowsHide: true });
        expect(execution.status, execution.stderr).toBe(0);
        return JSON.parse(execution.stdout.trim().split(/\r?\n/).at(-1)!);
    } finally { rmSync(home, { recursive: true, force: true }); }
}

describe("actual public Sandbox start and delete semantic rendering", () => {
    it("renders start with the existing public device fields and accepts status-zero native error metadata", () => {
        const value = lifecycleFacade("start-success");
        expect(value.result.isError).toBe(false);
        expect(value.result.content).toHaveLength(1); expect(value.result.content[0].type).toBe("text");
        const payload = JSON.parse(value.result.content[0].text);
        expect(Object.keys(payload)).toEqual(["device"]);
        expect(payload.device).toMatchObject({ id: "sandbox", status: "running", sandboxId: guid, launchMode: "wsb-file", minimized: false,
            minimizeConfirmed: false, minimizeWarning: null, minimizeWatchdogLaunch: { ok: true, skipped: true },
            helperSessionLaunch: { ok: true, skipped: true, reason: "wsb-file launch creates the interactive Sandbox session", launchMode: "wsb-file", minimizeWatchdogLaunch: { ok: true, skipped: true } } });
        expect(value.device).toMatchObject({ status: "running", sandboxId: guid }); expect(value.lockExists).toBe(true);
        expect(value.trace.map((item: { timeout: number }) => item.timeout)).toEqual([10000, 120000, 10000]);
        expect(value.trace[1].args).toContain("-EncodedCommand");
    });
    it.each([
        ["start-status", "Refusing to start sandbox while status is running"],
        ["start-prerequisite", "Windows Sandbox backend missing prerequisites: wsb"],
        ["start-inventory-failure", "Error: inventory stdout"],
        ["start-launch-failure", "Error: launch stderr"],
        ["delete-native-failure", "Error: stop stderr"],
    ])("preserves the exact public refusal/native error priority for %s", (mode, text) => {
        const value = lifecycleFacade(mode);
        expect(value.result).toEqual({ content: [{ type: "text", text }], isError: true });
        expect(value.device.status).toBe(mode === "start-status" || mode === "delete-native-failure" ? "running" : "stopped");
        expect(value.scratchExists).toBe(true);
    });
    it("preserves the exact registration diagnostic order and ambiguous ownership cleanup suffix", () => {
        const value = lifecycleFacade("start-ambiguous"), other = "22222222-2222-4222-8222-222222222222", third = "33333333-3333-4333-8333-333333333333";
        expect(value.result).toEqual({ content: [{ type: "text", text: `Windows Sandbox launch produced multiple new runtimes: ${other}, ${third}. status=0 stderr=inventory warning stdout=${JSON.stringify([other, third])} error=inventory opaque cleanupSkipped=ambiguous-runtime-ownership lockRetained=true minimizeWatchdogCleaned=true` }], isError: true });
        expect(value.device.status).toBe("starting"); expect(value.lockExists).toBe(true); expect(value.lists).toBe(2);
        expect(value.trace.some((item: { args: string[] }) => item.args[0] === "stop")).toBe(false);
    });
    it("renders the existing singleton conflict JSON in its exact public field order", () => {
        const value = lifecycleFacade("start-singleton-conflict");
        expect(value.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: "windows-sandbox-singleton-generation-conflict", backend: "windows-sandbox", deviceId: "sandbox", runtimeStopped: false, compensationRefused: true, watchdogCleaned: false }) }], isError: true });
        expect(value.device.singletonClaimId).toBe("successor"); expect(value.lockExists).toBe(true);
        expect(value.trace.some((item: { args: string[] }) => item.args[0] === "stop")).toBe(false);
    });
    it("renders conflict compensation as the existing rollback field and preserves the successor", () => {
        const value = lifecycleFacade("start-complete-conflict");
        expect(value.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ ok: false, error: "owner-device-state-conflict", backend: "windows-sandbox", deviceId: "sandbox", operation: "start-complete", found: true,
            rollback: { runtimeStopped: false, compensationRefused: true, watchdogCleaned: false, singletonReleased: false } }) }], isError: true });
        expect(value.device.lifecycle.runtimeId).toBe("successor"); expect(value.lockExists).toBe(true);
    });
    it("renders actual record and scratch deletion with the existing pretty JSON response", () => {
        const value = lifecycleFacade("delete-success");
        expect(value.result).toEqual({ content: [{ type: "text", text: JSON.stringify({ deleted: "sandbox", scratchRemoved: value.scratch }, null, 2) }], isError: false });
        expect(value.device).toBeUndefined(); expect(value.lockExists).toBe(false); expect(value.scratchExists).toBe(false); expect(value.trace).toEqual([]);
    });
    it("keeps record deletion truthful when scratch removal throws at the actual facade", () => {
        const value = lifecycleFacade("delete-scratch-throw");
        expect(value.thrown).toBe("scratch denied"); expect(value.result).toBeUndefined(); expect(value.device).toBeUndefined();
        expect(value.lockExists).toBe(false); expect(value.scratchExists).toBe(true);
    });
    it("retains undefined missing-device results for all public entrypoints", () => {
        expect(lifecycleFacade("missing")).toEqual({ missing: true, trace: [] });
    });
});
