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
