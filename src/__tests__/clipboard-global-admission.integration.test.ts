import {spawn, type ChildProcess} from "node:child_process";
import {chmodSync, closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {request} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {afterEach, beforeEach, describe, expect, it} from "vitest";
import {prepareRuntimeBindHome, withRuntimeBindGuard} from "../adapters/runtime-bind-authority.js";

// The coordinator emits the combined candidate before running this owner.
// These are actual product processes, private files and an inert executable;
// no engine, host clipboard program, foreign daemon or container is used.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const productUrl = (name: string) => pathToFileURL(join(repository, "dist", name)).href;
const exactId = "d".repeat(64);
interface Result {code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string}
interface OwnedProcess {pid: number; startToken: string}
interface RecordValue {port: number; token: string; portFile: string}

async function eventually(predicate: () => boolean | Promise<boolean>, description: string, milliseconds = 12_000) {
    const deadline = performance.now() + milliseconds;
    while (!await predicate()) {
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 15));
    }
}
function startToken(pid: number): string | null {
    try {
        const text = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
        return fields[0] === "Z" ? null : fields[19] ?? null;
    }
    catch { return null; }
}
function http(record: RecordValue, path: string, method = "GET"): Promise<{status: number; body: string}> {
    return new Promise((resolve, reject) => {
        const req = request({hostname: "127.0.0.1", port: record.port, path, method, timeout: 1500,
            headers: {Authorization: `Bearer ${record.token}`, Connection: "close"}}, response => {
            let body = ""; response.on("data", chunk => { body += String(chunk); });
            response.once("end", () => resolve({status: response.statusCode ?? 0, body})); response.once("error", reject);
        });
        req.once("error", reject); req.once("timeout", () => req.destroy(new Error("owned HTTP peer timed out"))); req.end();
    });
}

describe.runIf(process.platform === "linux")("clipboard native global admission", () => {
    let root: string, home: string, portFile: string, driver: string, runtime: string;
    const children = new Set<ChildProcess>(), daemons: OwnedProcess[] = [], published: RecordValue[] = [], descriptors: number[] = [];
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-clipboard-global-")); home = join(root, "home");
        mkdirSync(home, {mode: 0o700}); mkdirSync(join(root, "config"), {mode: 0o700});
        const prepared = prepareRuntimeBindHome(join(home, ".ccc")); withRuntimeBindGuard(prepared, () => {});
        portFile = join(home, ".ccc", "run", "clipboard.port");
        runtime = join(root, "runtime.mjs"); driver = join(root, "driver.mjs");
        writeFileSync(runtime, `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
const root=${JSON.stringify(root)}, home=${JSON.stringify(home)}, id=${JSON.stringify(exactId)};
const raw=process.argv.slice(2), index=raw.findIndex(value=>['ps','inspect','info','context','version'].includes(value));
if(index<0) process.exit(95);
const args=raw.slice(index), mode=existsSync(join(root,'mode'))?readFileSync(join(root,'mode'),'utf8'):'clear';
let claim=null; try{claim=JSON.parse(readFileSync(join(home,'.ccc','codex-state.lock'),'utf8')).pid}catch{}
appendFileSync(join(root,'native.jsonl'),JSON.stringify({args,claim})+'\\n');
if(mode==='unreachable') process.exit(72);
if(args[0]==='ps') process.stdout.write(mode==='stopped'?id+'\\n':'');
else if(args[0]==='inspect') process.stdout.write(JSON.stringify([{Id:id,State:{Running:false},Mounts:[{Type:'bind',Source:${JSON.stringify(portFile)},Destination:'/run/ccc/clipboard.port'}]}]));
else if(args[0]==='info') process.stdout.write('{}');
`);
        chmodSync(runtime, 0o700);
        writeFileSync(join(root, "hold-listen.cjs"), `
const fs=require('node:fs'),http=require('node:http'),root=${JSON.stringify(root)};
const create=http.createServer;
http.createServer=function(...args){const server=create.apply(this,args),listen=server.listen;
 server.listen=function(...args){const callback=args.pop();
  args.push(()=>{fs.writeFileSync(root+'/child-listening',String(server.address().port));
   const timer=setInterval(()=>{if(fs.existsSync(root+'/release-ready')){clearInterval(timer);callback();}},10);
   server.once('close',()=>clearInterval(timer));
  });return listen.apply(this,args);
 };return server;
};require('node:module').syncBuiltinESMExports();
`);
        writeFileSync(join(root, "expired-published.cjs"), `
const {performance}=require('node:perf_hooks');let now=100;
Object.defineProperty(performance,'now',{configurable:true,value:()=>now});
process.prependListener('message',message=>{if(message&&message.type==='published')now+=60000;});
`);
        writeFileSync(join(root, "terminal-fsync-failure.cjs"), `
const fs=require('node:fs'),portFile=${JSON.stringify(portFile)},root=${JSON.stringify(root)},nativeFsync=fs.fsyncSync;
fs.fsyncSync=function(fd){
 let target;try{target=fs.readlinkSync('/proc/self/fd/'+fd);}catch{}
 if(target===portFile&&/^retired-v1:[1-9][0-9]{0,4}:[a-f0-9]{32}$/.test(fs.readFileSync(target,'utf8'))){
  let claim=null;try{claim=JSON.parse(fs.readFileSync(root+'/home/.ccc/codex-state.lock','utf8')).pid;}catch{}
  fs.appendFileSync(root+'/terminal-attempts.jsonl',JSON.stringify({pid:process.pid,claim})+'\\n',{mode:0o600});
  const error=new Error('owned terminal fsync failure');error.code='EIO';throw error;
 }
 return nativeFsync.apply(this,arguments);
};require('node:module').syncBuiltinESMExports();
`);
        writeFileSync(driver, `
import {existsSync,mkdirSync,readFileSync,renameSync,statSync,writeFileSync} from 'node:fs';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const root=${JSON.stringify(root)}, home=${JSON.stringify(home)}, mode=process.argv[2];
const nativeSpawn=childProcess.spawn;
childProcess.spawn=function(...args){
 if(mode.startsWith('precommit-')&&args[0]===process.execPath&&Array.isArray(args[1])&&args[1].includes('--serve')){
  args[2]={...args[2],env:{...process.env,NODE_OPTIONS:'--require='+JSON.stringify(join(root,'hold-listen.cjs'))}};
 }
 const child=nativeSpawn.apply(this,args);
 if(args[0]===process.execPath && Array.isArray(args[1]) && args[1].includes('--serve') && child.pid){
   const text=readFileSync('/proc/'+child.pid+'/stat','utf8');
   process.send?.({spawned:{pid:child.pid,startToken:text.slice(text.lastIndexOf(')')+2).split(' ')[19]}});
 }
 return child;
}; syncBuiltinESMExports();
const authority=await import(${JSON.stringify(productUrl("adapters/runtime-bind-authority.js"))});
const runtime=await import(${JSON.stringify(productUrl("container-runtime.js"))});
const {NATIVE_RUNTIME_SELECTOR_KEYS}=await import(${JSON.stringify(productUrl("ports/container-runtime-invocation.js"))});
runtime._setRuntimeInvocationForTest({version:1,runtime:'docker',executable:${JSON.stringify(runtime)},transport:{kind:'docker',host:'unix:///inert/clipboard.sock',configDirectory:join(root,'config'),tls:{enabled:false,verify:false,caFile:null,certFile:null,keyFile:null}},selectors:Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key=>[key,null]))});
if(mode==='hold'){
 await authority.withRuntimeBindGuardAsync(join(home,'.ccc'),async()=>{process.send?.({held:true});await new Promise(resolve=>process.once('message',resolve));});
} else if(mode==='pending') {
 authority.withRuntimeBindGuard(join(home,'.ccc'),guard=>authority.beginRuntimeBindCreation(guard,runtime.peekRuntimeInvocation()));
} else if(mode==='validation-peer') {
 const {createServer}=await import('node:http');const token='c'.repeat(32);
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
  if(existsSync(join(root,'hold-health'))){
   writeFileSync(join(root,'health-observed'),'authenticated');
   while(!existsSync(join(root,'release-health')))await new Promise(resolve=>setTimeout(resolve,10));
  }
  res.end(JSON.stringify({service:'ccc-clipboard',valid:true,version:'fixture'}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 mkdirSync(join(home,'.ccc','run'),{recursive:true,mode:0o700});
 const selected={port:server.address().port,token,portFile:${JSON.stringify(portFile)}};
 writeFileSync(selected.portFile,selected.port+':'+token,{mode:0o600});
 writeFileSync(join(root,'selected.json'),JSON.stringify(selected),{mode:0o600});process.send?.({ready:true});
} else if(mode==='settlement-peer') {
 const {createServer}=await import('node:http');const token='e'.repeat(32);
 const server=createServer((req,res)=>{
  if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
  if(req.url==='/health'){res.end(JSON.stringify({service:'ccc-clipboard',valid:true,version:'owned-prior-policy',retirement:'writer-settlement-v1'}));return;}
  if(req.url==='/shutdown'&&req.method==='POST'){
   server.close(()=>{if(process.connected)process.disconnect();});
   if(server.listening){res.writeHead(503);res.end();return;}
   writeFileSync(join(root,'peer-settled'),JSON.stringify({listenerClosed:true}),{mode:0o600});
   res.setHeader('Connection','close');res.end(JSON.stringify({service:'ccc-clipboard',retirement:'writer-settlement-v1',settled:true}));return;
  }
  res.writeHead(404);res.end();
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 mkdirSync(join(home,'.ccc','run'),{recursive:true,mode:0o700});
 writeFileSync(${JSON.stringify(portFile)},server.address().port+':'+token,{mode:0o600});process.send?.({ready:true});
} else if(mode==='legacy') {
 const {createServer}=await import('node:http');const token='a'.repeat(32);
 const server=createServer((req,res)=>{if(req.headers.authorization!=='Bearer '+token){res.writeHead(401);res.end();return;}
 if(req.url==='/health')res.end(JSON.stringify({service:'ccc-clipboard',valid:true,version:'legacy'}));
 else if(req.url==='/shutdown'){writeFileSync(join(root,'legacy-shutdown'),'unexpected');res.end('shutting down');setTimeout(()=>{(awaitImportFs=>awaitImportFs.unlinkSync(${JSON.stringify(portFile)}))(requireFs);process.exit(0)},4000)}
 else{res.writeHead(404);res.end();}});
 const requireFs=await import('node:fs');
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 (await import('node:fs')).mkdirSync(join(home,'.ccc','run'),{recursive:true,mode:0o700});
 writeFileSync(${JSON.stringify(portFile)},server.address().port+':'+token,{mode:0o600});process.send?.({ready:true});
} else {
 const clipboard=await import(${JSON.stringify(productUrl("clipboard-server.js"))});
 if(mode==='validate'){
  const selected=JSON.parse(readFileSync(join(root,'selected.json'),'utf8'));
  const value=await authority.withRuntimeBindGuardAsync(join(home,'.ccc'),guard=>clipboard.validateClipboardSelection(selected,guard));
  console.log(JSON.stringify(value));
 }else if(mode==='child-expiry'){
  const outcome=await authority.withRuntimeBindGuardAsync(join(home,'.ccc'),async()=>{
   const child=childProcess.spawn(process.execPath,[${JSON.stringify(join(repository, "dist", "clipboard-server.js"))},'--serve','--parent-publisher'],{
    env:{...process.env,NODE_OPTIONS:'--require='+JSON.stringify(join(root,'expired-published.cjs'))},stdio:['ignore','ignore','pipe','ipc']});
   let committed=false,issued=null;
   child.on('message',message=>{
    if(message?.type==='ready'){
     mkdirSync(join(home,'.ccc','run'),{recursive:true,mode:0o700});
     const bytes=message.port+':'+message.token;writeFileSync(${JSON.stringify(portFile)},bytes,{mode:0o600});
     const file=statSync(${JSON.stringify(portFile)},{bigint:true});
     issued={path:${JSON.stringify(portFile)},bytes,device:String(file.dev),inode:String(file.ino),birthtime:String(file.birthtimeNs),mtime:String(file.mtimeNs),ctime:String(file.ctimeNs)};
     child.send({type:'published',receipt:issued});
    }else if(message?.type==='committed'){committed=true;child.kill('SIGTERM');}
   });
   const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
   child.send({type:'initialize',runtimeInvocation:runtime.peekRuntimeInvocation()});
   const result=await exited;
   return {committed,issued,result,bytes:readFileSync(${JSON.stringify(portFile)},'utf8'),inode:String(statSync(${JSON.stringify(portFile)},{bigint:true}).ino)};
  });console.log(JSON.stringify(outcome));
 }else if(mode==='sessions'){
  const {captureNativeSessionOwnership}=await import(${JSON.stringify(productUrl("adapters/session-ownership.js"))});
  const directory=join(home,'.ccc','run','locks');mkdirSync(directory,{recursive:true,mode:0o700});
  const path=join(directory,'requester.lock');writeFileSync(path,String(process.pid),{mode:0o600});
  const receipt=captureNativeSessionOwnership(path);
  const exact=clipboard.hasAnyActiveSessionsExcept(receipt,directory), string=clipboard.hasAnyActiveSessionsExcept(path,directory);
  const elsewhere=clipboard.hasAnyActiveSessionsExcept({...receipt,path:join(root,'elsewhere','requester.lock')},directory);
  renameSync(path,path+'.old');writeFileSync(path,String(process.pid),{mode:0o600});
  const replaced=clipboard.hasAnyActiveSessionsExcept(receipt,directory);
  writeFileSync(path,String(process.ppid));const foreign=clipboard.hasAnyActiveSessionsExcept(captureNativeSessionOwnership(path),directory);
  console.log(JSON.stringify({exact,string,elsewhere,replaced,foreign}));
 }else{
 const value=mode==='stop'?await clipboard.stopClipboardServerIfLast(false):await clipboard.ensureClipboardSelection();
 console.log(JSON.stringify(value));
 }
}
`);
    });
    afterEach(async () => {
        for (const record of published) await http(record, "/shutdown", "POST").catch(() => undefined);
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        for (const daemon of daemons) if (startToken(daemon.pid) === daemon.startToken) {
            try { process.kill(daemon.pid, "SIGKILL"); } catch { /* already exited */ }
        }
        await Promise.all([...children].map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve()
            : new Promise<void>(resolve => child.once("close", () => resolve()))));
        for (const descriptor of descriptors) closeSync(descriptor);
        children.clear(); daemons.length = 0; published.length = 0; descriptors.length = 0; rmSync(root, {recursive: true, force: true});
    });
    function start(mode: string, terminalFsyncFailure = false) {
        const child = spawn(process.execPath, [driver, mode], {cwd: root,
            env: {...process.env, HOME: home, USERPROFILE: home, CCC_HOME: undefined, CCC_PROFILE: undefined, VITEST: undefined,
                NODE_OPTIONS: terminalFsyncFailure ? `--require=${JSON.stringify(join(root, "terminal-fsync-failure.cjs"))}` : undefined},
            stdio: ["ignore", "pipe", "pipe", "ipc"]});
        children.add(child); let stdout = "", stderr = "";
        child.stdout!.on("data", chunk => { stdout += String(chunk); }); child.stderr!.on("data", chunk => { stderr += String(chunk); });
        child.on("message", (message: unknown) => {
            if (message && typeof message === "object" && "spawned" in message) daemons.push(message.spawned as OwnedProcess);
        });
        const result = new Promise<Result>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({code, signal, stdout, stderr})); });
        return {child, result};
    }
    function readRecord(): RecordValue {
        const [port, ...token] = readFileSync(portFile, "utf8").trim().split(":");
        return {port: Number(port), token: token.join(":"), portFile};
    }
    function trace(): Array<{args: string[]; claim: number | null}> {
        return existsSync(join(root, "native.jsonl")) ? readFileSync(join(root, "native.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    }

    it("publishes a missing port through parent IPC under the actual global claim, then cheaply reuses it", async () => {
        const first = start("ensure"), result = await first.result;
        expect(result.code, result.stderr).toBe(0);
        const selection: RecordValue = JSON.parse(result.stdout.trim()); published.push(selection);
        expect(selection).toEqual(readRecord()); expect(selection.token).toMatch(/^[a-f0-9]{32}$/);
        expect(JSON.parse((await http(selection, "/health")).body)).toMatchObject({valid: true, retirement: "writer-settlement-v1"});
        const observations = trace(); expect(observations.length).toBeGreaterThan(0);
        expect(observations.every(value => value.claim === first.child.pid)).toBe(true);
        const reused = await start("ensure").result; expect(reused.code, reused.stderr).toBe(0);
        expect(JSON.parse(reused.stdout.trim())).toEqual(selection); expect(trace()).toEqual(observations);
    }, 20_000);

    it("cannot publish between creation's held guard and final inventory", async () => {
        const owner = start("hold");
        await new Promise<void>(resolve => owner.child.once("message", () => resolve()));
        const waiter = start("ensure");
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(existsSync(portFile)).toBe(false); expect(trace()).toEqual([]); expect(waiter.child.exitCode).toBeNull();
        owner.child.send({release: true}); expect((await owner.result).code).toBe(0);
        const result = await waiter.result; expect(result.code, result.stderr).toBe(0);
        published.push(JSON.parse(result.stdout.trim())); expect(readRecord()).toEqual(published[0]);
    }, 20_000);

    it("excludes only the exact current requester's receipt, never a basename, displaced inode or foreign owner", async () => {
        const result = await start("sessions").result; expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual({exact: false, string: true, elsewhere: true, replaced: true, foreign: true});
        expect(trace()).toEqual([]);
    });

    it.each(["current", "retired", "token"] as const)("validates an actual emitted %s selection under its genuine native guard", async state => {
        const peer = start("validation-peer"); await new Promise<void>(resolve => peer.child.once("message", () => resolve()));
        const selected: RecordValue = JSON.parse(readFileSync(join(root, "selected.json"), "utf8"));
        if (state === "retired") writeFileSync(portFile, `retired-v1:${selected.port}:${selected.token}`);
        if (state === "token") writeFileSync(portFile, `${selected.port}:${"b".repeat(32)}`);
        const bytes = readFileSync(portFile, "utf8"), result = await start("validate").result;
        expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual(state === "current" ? selected : null);
        expect(readFileSync(portFile, "utf8")).toBe(bytes);
    }, 20_000);

    it.each(["inode", "token", "history"] as const)("rejects %s replacement during an authenticated selection health observation", async replacement => {
        const peer = start("validation-peer"); await new Promise<void>(resolve => peer.child.once("message", () => resolve()));
        writeFileSync(join(root, "hold-health"), "hold");
        const validating = start("validate");
        await eventually(() => existsSync(join(root, "health-observed")), "authenticated validation observation");
        const target = replacement === "history" ? join(home, ".ccc", "runtime-bind-authority", "history.json") : portFile;
        const before = readFileSync(target, "utf8");
        if (replacement === "token") {
            const selected: RecordValue = JSON.parse(readFileSync(join(root, "selected.json"), "utf8"));
            writeFileSync(portFile, `${selected.port}:${"b".repeat(32)}`);
        } else {renameSync(target, join(root, `old-${replacement}`)); writeFileSync(target, before, {mode: 0o600});}
        const bytes = readFileSync(target, "utf8"), inode = statSync(target).ino;
        writeFileSync(join(root, "release-health"), "release");
        const result = await validating.result; expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toBeNull();
        expect(readFileSync(target, "utf8")).toBe(bytes); expect(statSync(target).ino).toBe(inode);
    }, 20_000);

    it("an actual child rejects a queued published receipt after its monotonic deadline before the timer callback", async () => {
        const result = await start("child-expiry").result; expect(result.code, result.stderr).toBe(0);
        const outcome: {committed: boolean; issued: {bytes: string; inode: string}; result: {code: number | null}; bytes: string; inode: string} = JSON.parse(result.stdout.trim());
        expect(outcome.issued).toBeTruthy(); expect(outcome.committed).toBe(false); expect(outcome.result.code).toBe(0);
        expect(outcome.bytes).toBe(outcome.issued.bytes); expect(outcome.inode).toBe(outcome.issued.inode);
        expect(readFileSync(portFile, "utf8")).toBe(outcome.issued.bytes);
    }, 20_000);

    it.each(["pending", "incomplete", "unreachable"] as const)("refuses first publication for %s authority", async mode => {
        if (mode === "pending") expect((await start("pending").result).code).toBe(0);
        else if (mode === "incomplete") writeFileSync(join(home, ".ccc", "runtime-bind-authority", "receiving-host-incomplete"), "", {mode: 0o600});
        else writeFileSync(join(root, "mode"), "unreachable");
        const result = await start("ensure").result; expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toBeNull(); expect(existsSync(portFile)).toBe(false); expect(daemons).toEqual([]);
    }, 20_000);
    it.each(["retired-v1:1234:broken", `retired-v1:1234:${"a".repeat(32)}\n`, `retired-v2:1234:${"a".repeat(32)}`])("never treats an unknown or partial terminal record as restart authority: %s", async bytes => {
        mkdirSync(join(home, ".ccc", "run"), {mode: 0o700}); writeFileSync(portFile, bytes, {mode: 0o600});
        const result = await start("ensure").result; expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toBeNull(); expect(readFileSync(portFile, "utf8")).toBe(bytes); expect(daemons).toEqual([]);
    }, 20_000);

    it.each(["disconnect", "timeout"] as const)("a precommit parent %s cannot leave a late child publication or retirement marker", async failure => {
        const parent = start(`precommit-${failure}`);
        await eventually(() => existsSync(join(root, "child-listening")) && daemons.length === 1, "owned uncommitted listener");
        const daemon = daemons[0]; expect(existsSync(portFile)).toBe(false);
        if (failure === "disconnect") parent.child.kill("SIGKILL");
        const result = await parent.result;
        if (failure === "disconnect") expect(result.signal).toBe("SIGKILL");
        else {expect(result.code).toBe(1); expect(result.stderr).toContain("Clipboard daemon publication timed out");}
        await eventually(() => startToken(daemon.pid) !== daemon.startToken, "precommit child relinquishment");
        writeFileSync(join(root, "release-ready"), "late callback release");
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(existsSync(portFile)).toBe(false);
    }, 20_000);

    it("stopped background containers veto last-session retirement without any live session record", async () => {
        const started = await start("ensure").result; expect(started.code, started.stderr).toBe(0);
        const record: RecordValue = JSON.parse(started.stdout.trim()); published.push(record);
        const before = readFileSync(portFile, "utf8"); writeFileSync(join(root, "mode"), "stopped");
        const stopped = await start("stop").result; expect(stopped.code, stopped.stderr).toBe(0);
        expect(readFileSync(portFile, "utf8")).toBe(before); expect((await http(record, "/health")).status).toBe(200);
        expect(trace().some(value => value.args[0] === "inspect")).toBe(true);
    }, 20_000);

    it("normal orphan settlement marks and restarts on the same held port-file inode", async () => {
        const started = await start("ensure").result; expect(started.code, started.stderr).toBe(0);
        const record: RecordValue = JSON.parse(started.stdout.trim()); published.push(record);
        const descriptor = openSync(portFile, "r"); descriptors.push(descriptor); const inode = fstatSync(descriptor).ino;
        await eventually(() => readFileSync(portFile, "utf8") === `retired-v1:${record.port}:${record.token}`, "one-shot orphan terminal record", 30_000);
        expect(fstatSync(descriptor).ino).toBe(inode); expect(readFileSync(descriptor, "utf8")).toBe(`retired-v1:${record.port}:${record.token}`);
        const restarted = await start("ensure").result; expect(restarted.code, restarted.stderr).toBe(0);
        const next: RecordValue = JSON.parse(restarted.stdout.trim()); published.push(next);
        expect(next.portFile).toBe(record.portFile); expect(next.token).not.toBe(record.token);
        expect(fstatSync(descriptor).ino).toBe(inode); expect(readFileSync(portFile, "utf8")).toBe(`${next.port}:${next.token}`);
    }, 40_000);

    it("a terminal marker fsync failure rejects the actual upgrade request before any replacement daemon starts", async () => {
        const peer = start("settlement-peer"); await new Promise<void>(resolve => peer.child.once("message", () => resolve()));
        const original = readRecord(), bytes = readFileSync(portFile, "utf8"), inode = statSync(portFile).ino;
        const upgrading = start("ensure", true), failed = await upgrading.result;
        expect(failed.code, failed.stderr).toBe(1); expect(failed.stderr).toContain("owned terminal fsync failure");
        expect(JSON.parse(readFileSync(join(root, "peer-settled"), "utf8"))).toEqual({listenerClosed: true});
        expect((await peer.result).code).toBe(0);
        expect(daemons).toEqual([]);
        const attempts = readFileSync(join(root, "terminal-attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(attempts).toEqual([{pid: upgrading.child.pid, claim: upgrading.child.pid}]);
        expect(readFileSync(portFile, "utf8")).toBe(`retired-v1:${bytes}`); expect(statSync(portFile).ino).toBe(inode);
        // A complete marker remains truthful after sealing even if its flush
        // failed. Only a later, fresh guarded request may recognize it.
        const restarted = await start("ensure").result; expect(restarted.code, restarted.stderr).toBe(0);
        const successor: RecordValue = JSON.parse(restarted.stdout.trim()); published.push(successor);
        expect(successor.token).not.toBe(original.token); expect(successor.portFile).toBe(portFile);
        expect(statSync(portFile).ino).toBe(inode); expect(readFileSync(portFile, "utf8")).toBe(`${successor.port}:${successor.token}`);
        expect(readFileSync(join(root, "terminal-attempts.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    }, 20_000);

    it("an actual orphan consumes its terminal writer once after fsync failure and closes the exact daemon", async () => {
        const started = await start("ensure", true).result; expect(started.code, started.stderr).toBe(0);
        const record: RecordValue = JSON.parse(started.stdout.trim()); published.push(record);
        const daemon = daemons[0]; expect(daemon).toBeDefined();
        expect(daemon.startToken).toMatch(/^[0-9]+$/); expect(startToken(daemon.pid)).toBe(daemon.startToken);
        const bytes = readFileSync(portFile, "utf8"), descriptor = openSync(portFile, "r"); descriptors.push(descriptor);
        const inode = fstatSync(descriptor).ino;
        expect(existsSync(join(root, "terminal-attempts.jsonl"))).toBe(false);
        expect((await http(record, "/health")).status).toBe(200);
        await eventually(() => {
            try {
                const stat = readFileSync(`/proc/${daemon.pid}/stat`, "utf8"), close = stat.lastIndexOf(")");
                const fields = stat.slice(close + 1).trim().split(/\s+/);
                if (!stat.startsWith(`${daemon.pid} (`) || close < 0 || !/^[A-Za-z]$/.test(fields[0] ?? "") || !/^[0-9]+$/.test(fields[19] ?? "")) return false;
                return fields[19] !== daemon.startToken || fields[0] === "Z";
            } catch (error) {return (error as NodeJS.ErrnoException).code === "ENOENT";}
        }, "exact orphan daemon cessation after terminal fsync failure", 30_000);
        const attempts = readFileSync(join(root, "terminal-attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
        expect(attempts).toEqual([{pid: daemon.pid, claim: daemon.pid}]);
        await expect(http(record, "/health")).rejects.toSatisfy((error: NodeJS.ErrnoException) =>
            error.code === "ECONNREFUSED" || error.code === "ECONNRESET");
        expect(readFileSync(portFile, "utf8")).toBe(`retired-v1:${bytes}`); expect(statSync(portFile).ino).toBe(inode);
        expect(fstatSync(descriptor).ino).toBe(inode); expect(readFileSync(descriptor, "utf8")).toBe(`retired-v1:${bytes}`);
        // The qualified process has ceased, so it cannot retry against this
        // complete record or acquire authority over a future publication.
        expect(readFileSync(join(root, "terminal-attempts.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
    }, 40_000);

    it("an orphan consumes only its original publication receipt and preserves a same-byte successor inode", async () => {
        const started = await start("ensure").result; expect(started.code, started.stderr).toBe(0);
        const record: RecordValue = JSON.parse(started.stdout.trim()); published.push(record);
        const descriptor = openSync(portFile, "r"); descriptors.push(descriptor); const original = fstatSync(descriptor).ino;
        const bytes = readFileSync(portFile, "utf8"); renameSync(portFile, join(root, "original-port")); writeFileSync(portFile, bytes, {mode: 0o600});
        const successor = statSync(portFile).ino; expect(successor).not.toBe(original);
        const daemon = daemons[0]; expect(daemon).toBeDefined();
        await eventually(() => startToken(daemon.pid) !== daemon.startToken, "orphan original receipt consumption", 30_000);
        expect(readFileSync(portFile, "utf8")).toBe(bytes); expect(statSync(portFile).ino).toBe(successor);
        expect(fstatSync(descriptor).ino).toBe(original); expect(readFileSync(descriptor, "utf8")).toBe(bytes);
    }, 40_000);

    it("never shuts down a legacy late-unlink writer even when all retained inventories are empty", async () => {
        const legacy = start("legacy"); await new Promise<void>(resolve => legacy.child.once("message", () => resolve()));
        const before = readFileSync(portFile, "utf8"), record = readRecord(); published.push(record);
        const result = await start("ensure").result; expect(result.code, result.stderr).toBe(0);
        expect(JSON.parse(result.stdout.trim())).toEqual(record); expect(readFileSync(portFile, "utf8")).toBe(before);
        expect(existsSync(join(root, "legacy-shutdown"))).toBe(false); expect(daemons).toEqual([]);
        expect((await http(record, "/health")).status).toBe(200);
    }, 20_000);
});
