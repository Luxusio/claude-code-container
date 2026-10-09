import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { freePort } from "./helpers/fake-broker-mcp-fixture.js";
import { ownerId } from "@ccc/device-lab/providers/context.mjs";
import { brokerAppium, isLocalObservationBudgetExhaustion } from "../../device-lab-mcp/src/broker.mjs";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { createWaitBudget } from "@ccc/device-lab/providers/wait-budget.mjs";
import { createHash } from "node:crypto";
import ts from "typescript";
import * as fencedProcess from "child_process";
import * as fencedFs from "fs";
import * as fencedHttp from "http";

const effects = vi.hoisted(() => ({ root: "", port: 0, denied: 0, scripts: [] as string[], commands: [] as string[], descriptors: new Set<number>(), pids: [] as number[] }));
const importFences = vi.hoisted(() => {
    const fetch = globalThis.fetch, kill = process.kill;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
        if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== effects.port) { effects.denied++; throw new Error("unallocated import fetch"); }
        return fetch(input, init);
    }) as typeof fetch;
    process.kill = ((pid: number, signal?: string | number) => {
        if (!effects.pids.includes(pid) || (signal !== undefined && signal !== 0)) { effects.denied++; throw new Error("unallocated import signal"); }
        return kill(pid, signal);
    }) as typeof process.kill;
    return { fetch, kill };
});
afterAll(() => { globalThis.fetch = importFences.fetch; process.kill = importFences.kill; });
vi.mock("child_process", async importOriginal => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    const deny = () => { effects.denied++; throw new Error("unallocated subprocess"); };
    return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
        if (args[0] !== process.execPath || !Array.isArray(args[1]) || !effects.commands.includes(JSON.stringify(args[1]))) return deny();
        const child = actual.spawn(...args);
        if (child.pid) effects.pids.push(child.pid);
        return child;
    }, spawnSync: deny, exec: deny, execSync: deny, execFile: deny, execFileSync: deny, fork: deny };
});
vi.mock("fs", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs")>();
    const owned = (path: unknown) => typeof path === "string" && effects.root !== "" && (path === effects.root || path.startsWith(effects.root + "/"));
    const deny = () => { effects.denied++; throw new Error("unallocated filesystem mutation"); };
    return { ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => owned(args[0]) ? actual.writeFileSync(...args) : deny(),
        appendFileSync: (...args: Parameters<typeof actual.appendFileSync>) => owned(args[0]) ? actual.appendFileSync(...args) : deny(),
        rmSync: (...args: Parameters<typeof actual.rmSync>) => owned(args[0]) ? actual.rmSync(...args) : deny(),
        chmodSync: (...args: Parameters<typeof actual.chmodSync>) => owned(args[0]) ? actual.chmodSync(...args) : deny(),
        renameSync: (...args: Parameters<typeof actual.renameSync>) => owned(args[0]) && owned(args[1]) ? actual.renameSync(...args) : deny(),
        mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => owned(args[0]) ? actual.mkdirSync(...args) : deny(),
        unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => owned(args[0]) ? actual.unlinkSync(...args) : deny(),
        openSync: (...args: Parameters<typeof actual.openSync>) => {
            if ((typeof args[1] === "string" ? /[wa+]/.test(args[1]) : args[1] !== 0) && !owned(args[0])) return deny();
            const fd = actual.openSync(...args); if (owned(args[0])) effects.descriptors.add(fd); return fd;
        },
        fchmodSync: (...args: Parameters<typeof actual.fchmodSync>) => effects.descriptors.has(args[0]) ? actual.fchmodSync(...args) : deny(),
    };
});
vi.mock("http", async importOriginal => {
    const actual = await importOriginal<typeof import("node:http")>();
    return { ...actual, request: (...args: Parameters<typeof actual.request>) => {
        const options = args[0] as { hostname?: string; host?: string; port?: number };
        if ((options.hostname || options.host) !== "127.0.0.1" || Number(options.port) !== effects.port) {
            effects.denied++; throw new Error("unallocated HTTP authority");
        }
        return actual.request(...args);
    } };
});
vi.mock("https", async importOriginal => {
    const actual = await importOriginal<typeof import("node:https")>();
    const deny = () => { effects.denied++; throw new Error("unallocated HTTPS authority"); };
    return { ...actual, request: deny, get: deny };
});
const phaseClock = vi.hoisted(() => ({ enabled: false, path: "" }));
// This is the admitted ORIGINAL leaf-clock witness, not a replacement budget.
vi.mock("@ccc/device-lab/providers/wait-budget.mjs", async importOriginal => {
    const actual = await importOriginal<typeof import("@ccc/device-lab/providers/wait-budget.mjs")>();
    function leaf<T>(operation: () => T): T {
        const descriptor = Object.getOwnPropertyDescriptor(performance, "now");
        Object.defineProperty(performance, "now", { configurable: true, value: () => Number(readFileSync(phaseClock.path, "utf8")) });
        try { return operation(); }
        finally { if (descriptor) Object.defineProperty(performance, "now", descriptor); else Reflect.deleteProperty(performance, "now"); }
    }
    return { ...actual, createWaitBudget: (...args: Parameters<typeof actual.createWaitBudget>) => {
        if (!phaseClock.enabled) return actual.createWaitBudget(...args);
        const budget = leaf(() => actual.createWaitBudget(...args));
        return { ...budget, remaining: () => leaf(() => budget.remaining()), requestTimeout: (maximum?: number) => leaf(() => budget.requestTimeout(maximum)) };
    } };
});

const exhaustion = "broker-observation-budget-exhausted-before-rpc";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
// Frozen from the authenticated ORIGINAL emitted capture, including its final newline.
// Original-v-candidate replay belongs to the coordinator's immutable admission QA,
// not this ordinary regression suite. No task artifacts or temporary overlay are read.
const originalBudgetFunction = `function createWaitBudget(timeoutMs, intervalMs) {
  const timeout = boundedNumber(timeoutMs, 1e4, 6e5);
  const interval = boundedNumber(intervalMs, 500, 6e4);
  const deadline = performance.now() + timeout;
  const remaining = () => Math.max(0, deadline - performance.now());
  return {
    timeoutMs: timeout,
    remaining,
    requestTimeout(maximum = 12e4) {
      return Math.min(maximum, Math.ceil(remaining()));
    },
    async pause() {
      const wakeAt = Math.min(deadline, performance.now() + interval);
      let delay;
      while ((delay = wakeAt - performance.now()) > 0) {
        await new Promise((resolve14) => setTimeout(resolve14, Math.ceil(delay)));
      }
    }
  };
}
`;
const originalBudgetHash = "69028e5b2459ed15064445e3c2c346cf49d3382de86c8b44bf5e9241cdf0b109";
// esbuild can renumber its Promise callback after unrelated module edits.
const budgetContract = (body: string) => body.replace(/\bresolve\d+\b/g, "resolve").replace(/\s+/g, " ").trim();

// Parse the real emitted function, authenticate the frozen ORIGINAL body, and insert
// a local clock binding. Normalization, remaining, requestTimeout and pause stay intact.
function clockInsertion(source: string) {
    const ast = ts.createSourceFile("server.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const functions: ts.FunctionDeclaration[] = [];
    const visit = (node: ts.Node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "createWaitBudget") functions.push(node);
        ts.forEachChild(node, visit);
    };
    visit(ast);
    expect(functions).toHaveLength(1);
    const body = functions[0].body!;
    let leaves = 0;
    const countLeaves = (node: ts.Node) => {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
            && node.expression.expression.getText(ast) === "performance" && node.expression.name.text === "now") leaves++;
        ts.forEachChild(node, countLeaves);
    };
    countLeaves(body);
    expect(leaves).toBe(4);
    return { insertion: body.getStart(ast) + 1, body: body.getText(ast), leaves };
}

// Real HTTP and Linux process identity; deliberately no NODE_ENV=test escape.
describe.skipIf(process.platform !== "linux")("broker composed observation budget with real generation attestation", () => {
    let home: string;
    let child: ChildProcess;
    let log: string;
    let behavior: string;
    let auth: string;
    let preload: string;
    let originalFetch: typeof fetch;
    let originalKill: typeof process.kill;
    let childToken: string;
    let expectedDenials = 0;
    const publicChildren: ChildProcess[] = [];
    let options: { hostCandidates: string[]; port: number; autolaunch: boolean; timeoutMs: number };
    const requests = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    const count = (path: string) => requests().filter(entry => entry === path).length;
    

    beforeEach(async () => {
        home = mkdtempSync(join(tmpdir(), "ccc-broker-flow-"));
        expect(effects.denied, "including caught effects during imports or between cases").toBe(expectedDenials);
        effects.root = home; effects.scripts = []; effects.commands = []; effects.descriptors.clear(); effects.pids = []; publicChildren.length = 0;
        log = join(home, "requests.log");
        behavior = join(home, "behavior.json");
        phaseClock.enabled = false; phaseClock.path = join(home, "clock.json"); writeFileSync(phaseClock.path, "0", { mode: 0o600 });
        auth = join(home, "auth.json");
        writeFileSync(log, "", { mode: 0o600 });
        writeFileSync(behavior, "{}", { mode: 0o600 });
        const owner = ownerId();
        writeFileSync(auth, JSON.stringify({ ownerId: owner, secret: "b".repeat(64) }), { mode: 0o600 });
        for (const key of Object.keys(process.env)) if (/^(CCC_|ANDROID_)/i.test(key)) vi.stubEnv(key, undefined);
        vi.stubEnv("HOME", home);
        vi.stubEnv("USERPROFILE", home);
        vi.stubEnv("NODE_ENV", "production");
        vi.stubEnv("CCC_DEVICE_BROKER_AUTH_FILE", auth);
        vi.stubEnv("CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER", "");
        const port = await freePort();
        effects.port = port;
        originalFetch = globalThis.fetch;
        globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
            if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || Number(url.port) !== port) {
                effects.denied++; throw new Error("unallocated fetch authority");
            }
            return originalFetch(input, init);
        }) as typeof fetch;
        originalKill = process.kill;
        process.kill = ((pid: number, signal?: string | number) => {
            if (!effects.pids.includes(pid) || (signal !== undefined && signal !== 0)) { effects.denied++; throw new Error("unallocated signal"); }
            return originalKill(pid, signal);
        }) as typeof process.kill;
        const script = join(home, "broker.cjs");
        writeFileSync(script, `
const fs=require('fs'),http=require('http'),crypto=require('crypto');
const log=${JSON.stringify(log)},behavior=${JSON.stringify(behavior)},owner=${JSON.stringify(owner)},port=${port},clock=${JSON.stringify(phaseClock.path)};
const root=${JSON.stringify(home)},cp=require('child_process'),net=require('net');
const open=fs.openSync.bind(fs),write=fs.writeSync.bind(fs),close=fs.closeSync.bind(fs),denied=open(root+'/broker-denials.log','a',0o600);
const deny=kind=>{write(denied,kind+'\\n');throw new Error('unallocated fixture effect:'+kind);};
const owned=p=>typeof p==='string'&&(p===root||p.startsWith(root+'/'));
for(const name of ['writeFileSync','appendFileSync','mkdirSync','unlinkSync','rmSync','chmodSync']){const actual=fs[name];fs[name]=function(path,...args){if(!owned(path))return deny('fs:'+name);return actual.call(this,path,...args);};}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>deny('process:'+name);
process.kill=()=>deny('signal');globalThis.fetch=()=>deny('fetch');http.request=http.get=()=>deny('http');net.Socket.prototype.connect=()=>deny('connect');
const listen=net.Server.prototype.listen;net.Server.prototype.listen=function(p,h,...args){if(p!==port||h!=='127.0.0.1')return deny('listen');return listen.call(this,p,h,...args);};
process.on('exit',()=>close(denied));
let observations=0,ensured=false;
const stat=fs.readFileSync('/proc/self/stat','utf8');
const token='linux:'+stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19];
const startedAt=new Date().toISOString();
const server=http.createServer((req,res)=>{
 fs.appendFileSync(log,req.url+'\\n');
 const configured=JSON.parse(fs.readFileSync(behavior,'utf8'));
 const active=!configured.publicRoute||(ensured&&(!configured.afterAbsence||observations>0));
 const state=active?configured:{};
 const send=(code,body)=>{res.writeHead(code,{'content-type':'application/json'});res.end(JSON.stringify(body));};
 if(req.url==='/health')return send(200,{ok:true,name:'ccc-device-broker'});
 if(req.url==='/status')return setTimeout(()=>{if(state.clockAfterAttestation!==undefined)fs.writeFileSync(clock,String(state.clockAfterAttestation));fs.appendFileSync(log,'phase:status:'+(!state.changedGeneration&&!state.incompatible?'success':'invalid')+'\\n');send(200,{ok:true,broker:{name:'ccc-device-broker',mode:'host-broker-daemon',port,process:{pid:process.pid,startToken:state.changedGeneration?'replacement-token':token},startedAt,protocolVersion:state.incompatible?0:${JSON.stringify(DEVICE_BROKER_PROTOCOL_VERSION)}}});},state.attestationDelay||0);
 if(req.url==='/v1/owner/resolve')return setTimeout(()=>{if(state.clockAfterOwner!==undefined)fs.writeFileSync(clock,String(state.clockAfterOwner));if(state.ownerError)return send(500,{ok:false,error:'owned-owner-error'});fs.appendFileSync(log,'phase:owner-success\\n');send(200,{ok:true,result:{ownerId:owner}});},state.ownerDelay||0);
 let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{
  const h=req.headers,secret=JSON.parse(fs.readFileSync(${JSON.stringify(auth)},'utf8')).secret;
  const ownerToken=crypto.createHash('sha256').update('ccc-device-broker:owner:'+owner+':secret:'+secret).digest('hex');
  const payload=['v1',owner,h['x-ccc-device-auth-timestamp'],h['x-ccc-device-auth-nonce'],startedAt,token,crypto.createHash('sha256').update(body).digest('hex')].join('\\n');
  const expected=crypto.createHmac('sha256',ownerToken).update(payload).digest('hex');
  if(h['x-ccc-device-auth']!==expected||state.authError)return send(401,{ok:false,error:'bad-generation-auth'});
  const rpc=JSON.parse(body);
  fs.appendFileSync(log,JSON.stringify(rpc)+'\\n');
  if(rpc.method==='broker.inventory')return send(200,{ok:true,result:{backends:[{stateKey:'android',devices:[{id:'pixel',backend:'android-emulator'}]}]}});
  if(rpc.method==='broker.appium.session.ensure'){ensured=true;if(configured.firstRace)fs.writeFileSync(clock,'race');return send(200,{ok:true,result:{appium:{sessionId:'WAIT'}}});}
  observations++;fs.appendFileSync(log,'phase:rpc-started\\n');
  if(state.clockOnRpc!==undefined)fs.writeFileSync(clock,String(state.clockOnRpc));
  if(state.rpcError)return send(500,{ok:false,error:typeof state.rpcError==='string'?state.rpcError:'owned-rpc-error'});
  if(state.bodyError){res.writeHead(200,{'content-type':'application/json'});return res.end('invalid-json');}
  if(state.stallBody){res.writeHead(200,{'content-type':'application/json'});res.write('{"ok":true,"result":{"response":{"body":{"value":"matching text');return;}
  setTimeout(()=>{if(state.clockAfterResponse!==undefined)fs.writeFileSync(clock,String(state.clockAfterResponse));if(configured.outerRace)fs.writeFileSync(clock,'race');fs.appendFileSync(log,'phase:observation-success\\n');send(200,{ok:true,result:{response:{body:{value:state.value??(rpc.params.path==='/source'?'<App>absent</App>':1)}}}});},state.rpcDelay||0);
 });
});
server.listen(port,'127.0.0.1',()=>process.stdout.write(JSON.stringify({pid:process.pid,processStartToken:token,startedAt})+'\\n'));
`, { mode: 0o600 });
        effects.scripts.push(script);
        effects.commands.push(JSON.stringify([script, "devices", "broker", "serve", "--port", String(port)]));
        child = spawn(process.execPath, [script, "devices", "broker", "serve", "--port", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
        const [data] = await once(child.stdout!, "data");
        const runtime = { ...JSON.parse(String(data)), name: "ccc-device-broker", ownerId: owner, managedBy: "ccc-host", host: "127.0.0.1", port, command: process.execPath, args: [script, "devices", "broker", "serve", "--port", String(port)] };
        effects.pids.push(child.pid!); childToken = runtime.processStartToken;
        const root = join(home, ".ccc", "devices", "broker");
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, "runtime.json"), JSON.stringify(runtime), { mode: 0o600 });
        options = { hostCandidates: ["127.0.0.1"], port, autolaunch: false, timeoutMs: 2000 };
    }, 15000);

    const publicClient = async (controlled: boolean) => {
        const target = fileURLToPath(new URL("../../dist/device-lab-mcp/server.mjs", import.meta.url));
        const source = readFileSync(target, "utf8");
        expect(hash(originalBudgetFunction)).toBe(originalBudgetHash);
        const pinned = clockInsertion(source), frozen = clockInsertion(originalBudgetFunction);
        expect(hash(budgetContract(pinned.body))).toBe(hash(budgetContract(frozen.body)));
        preload = join(home, "preload.mjs");
        const denials = join(home, "denials.log");
        writeFileSync(denials, "", { mode: 0o600 });
        // This evidence is private and per invocation; admission goldens are never rewritten.
        writeFileSync(join(home, "transform.json"), JSON.stringify({ originalFunction: originalBudgetHash, allocatedModule: hash(source), function: hash(budgetContract(frozen.body)), insertion: pinned.insertion, leaves: pinned.leaves, controlled }), { mode: 0o600 });
        writeFileSync(preload, `
import fs from 'node:fs';import cp from 'node:child_process';import http from 'node:http';import https from 'node:https';import net from 'node:net';import {registerHooks,syncBuiltinESMExports} from 'node:module';import {createHash} from 'node:crypto';import {fileURLToPath} from 'node:url';
const root=${JSON.stringify(home)},port=${options.port},brokerPid=${child.pid},token=${JSON.stringify(childToken)},target=${JSON.stringify(target)},expected=${JSON.stringify(hash(source))};
const originalRead=fs.readFileSync.bind(fs),originalOpen=fs.openSync.bind(fs),originalWrite=fs.writeSync.bind(fs),originalClose=fs.closeSync.bind(fs);
const denyFd=originalOpen(${JSON.stringify(denials)},'a');
const deny=kind=>{originalWrite(denyFd,kind+'\\n');throw new Error('unallocated effect: '+kind);};
const owned=p=>{if(p instanceof URL)p=fileURLToPath(p);return typeof p==='string'&&(p===root||p.startsWith(root+'/'));};
const descriptors=new Set();
for(const name of ['writeFileSync','appendFileSync','mkdirSync','rmSync','rmdirSync','unlinkSync','chmodSync','renameSync','copyFileSync','truncateSync','symlinkSync','linkSync']){
 const actual=fs[name];fs[name]=function(...args){if(!owned(args[0])||(name==='renameSync'||name==='copyFileSync'||name==='linkSync')&&!owned(args[1]))return deny('fs:'+name);return actual.apply(this,args);};
}
fs.openSync=function(path,flags,...rest){const writes=typeof flags==='string'?/[wa+]/.test(flags):Boolean(flags&3);if(writes&&!owned(path))return deny('fs:open');const fd=originalOpen(path,flags,...rest);if(writes)descriptors.add(fd);return fd;};
for(const name of ['writeSync','fchmodSync','ftruncateSync']){const actual=fs[name];fs[name]=function(fd,...args){if(!descriptors.has(fd))return deny('fs:'+name);return actual.call(this,fd,...args);};}
for(const name of ['writeFile','appendFile','mkdir','rm','rmdir','unlink','chmod','rename','copyFile','truncate','symlink','link']){const actual=fs.promises[name];fs.promises[name]=async function(...args){if(!owned(args[0])||(name==='rename'||name==='copyFile'||name==='link')&&!owned(args[1]))return deny('fs.promises:'+name);return actual.apply(this,args);};}
// Genuine native PID/listener discovery needs these readonly OS observations.
const procAllowed=p=>/^\\/proc\\/(?:net\\/tcp6?|self\\/(?:stat|cmdline)|\\d+\\/(?:stat|cmdline|fd(?:\\/\\d+)?|task(?:\\/\\d+(?:\\/fd(?:\\/\\d+)?)?)?))$/.test(String(p));
for(const name of ['readFileSync','readdirSync','readlinkSync']){const actual=fs[name];fs[name]=function(path,...args){if(String(path).startsWith('/proc/')&&!procAllowed(path))return deny('proc:'+name);return actual.call(this,path,...args);};}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=()=>deny('process:'+name);
const kill=process.kill.bind(process);process.kill=(pid,signal)=>{if(pid!==brokerPid||(signal!==0&&signal!==undefined))return deny('signal');const stat=originalRead('/proc/'+pid+'/stat','utf8');if('linux:'+stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19]!==token)return deny('generation');return kill(pid,signal);};
const authority=(input)=>{if(typeof input==='object'&&!(input instanceof URL)){return (input.hostname||input.host)==='127.0.0.1'&&Number(input.port)===port;}const url=new URL(String(input));return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number(url.port)===port;};
const fetch=globalThis.fetch;globalThis.fetch=(input,...args)=>authority(input instanceof Request?input.url:input)?fetch(input,...args):deny('fetch');
const request=http.request;http.request=(input,...args)=>authority(input)?request(input,...args):deny('http');http.get=(...args)=>{const req=http.request(...args);req.end();return req;};https.request=https.get=()=>deny('https');
const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const a=Array.isArray(args[0])?args[0][0]:args[0];if(!a||typeof a!=='object'||a.host!=='127.0.0.1'||Number(a.port)!==port)return deny('connect');return connect.apply(this,args);};net.Server.prototype.listen=()=>deny('listen');
syncBuiltinESMExports();
const nativeNow=globalThis.performance.now.bind(globalThis.performance);
// Shared monotonic leaf time is held during owned HTTP phases. The real budget's
// original pause loop advances it using real timer elapsed time; no pause method
// or observation RPC is replaced, and transport timeout milliseconds stay real.
const clockState={value:0,phase:'0',pausing:false,pauseAt:0,pauseBase:0};
const leaf=interval=>({now:()=>{const phase=originalRead(${JSON.stringify(phaseClock.path)},'utf8');if(phase!==clockState.phase){clockState.phase=phase;if(phase!=='race')clockState.value=Math.max(clockState.value,Number(phase));}const stack=new Error().stack||'';if(interval===300&&phase==='race'&&stack.includes('requestTimeout'))clockState.value=Math.max(clockState.value,1000);if(interval===300&&stack.includes('pause')){if(!clockState.pausing){clockState.pausing=true;clockState.pauseAt=nativeNow();clockState.pauseBase=clockState.value;}clockState.value=Math.max(clockState.value,clockState.pauseBase+nativeNow()-clockState.pauseAt);}else clockState.pausing=false;return clockState.value;}});
if(${controlled})registerHooks({load(url,context,next){const result=next(url,context);if(url!==new URL('file://'+target).href)return result;const text=String(result.source);if(createHash('sha256').update(text).digest('hex')!==expected)throw new Error('emitted module pin mismatch');const insertion=${pinned.insertion};return {...result,source:text.slice(0,insertion)+'\\nconst performance = globalThis[Symbol.for("ccc-owned-wait-leaf")](intervalMs);\\n'+text.slice(insertion)};}});
globalThis[Symbol.for('ccc-owned-wait-leaf')]=leaf;
process.on('exit',()=>originalClose(denyFd));
`, { mode: 0o600 });
        const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", preload, target],
            env: { ...process.env, HOME: home, NODE_ENV: "production", CCC_DEVICE_BROKER_AUTH_FILE: auth, CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER: "" } as Record<string, string> });
        effects.scripts.push(preload, target);
        effects.commands.push(JSON.stringify(["--import", preload, target]));
        const client = new Client({ name: "broker-wait-contract", version: "1.0.0" });
        try { await client.connect(transport); }
        catch (error) { await transport.close(); expect(readFileSync(denials, "utf8")).toBe(""); throw error; }
        const owned = (transport as unknown as { _process: ChildProcess })._process;
        expect(owned.pid).toBeGreaterThan(0);
        publicChildren.push(owned); effects.pids.push(owned.pid!);
        const stat = readFileSync(`/proc/${owned.pid}/stat`, "utf8");
        const generation = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
        const close = async () => {
            const closed = owned.exitCode !== null || owned.signalCode !== null ? Promise.resolve() : once(owned, "close");
            if (owned.exitCode === null && owned.signalCode === null) {
                const current = readFileSync(`/proc/${owned.pid}/stat`, "utf8");
                expect(current.slice(current.lastIndexOf(")") + 1).trim().split(/\s+/)[19]).toBe(generation);
            }
            await client.close(); await closed;
            expect(readFileSync(denials, "utf8")).toBe("");
        };
        return { client, denials, close };
    };

    const assertAdmission = (extraStatus = 0) => {
        const ledger = requests();
        let admitted = false, statuses = 0, rpcs = 0;
        for (const event of ledger) {
            if (event === "/status") { statuses++; admitted = false; }
            if (event === "phase:status:success") admitted = true;
            if (event.startsWith("{")) { expect(admitted, ledger.join("\n")).toBe(true); admitted = false; rpcs++; }
        }
        expect(statuses).toBe(rpcs + extraStatus);
    };

    afterEach(async () => {
        phaseClock.enabled = false;
        globalThis.fetch = originalFetch;
        process.kill = originalKill;
        if (child && child.exitCode === null) {
            const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
            expect("linux:" + stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19]).toBe(childToken);
            child.kill(); await once(child, "exit");
        }
        for (const owned of publicChildren) expect(owned.exitCode !== null || owned.signalCode !== null, "public process must be joined before removal").toBe(true);
        expect(readFileSync(join(home, "broker-denials.log"), "utf8")).toBe("");
        expect(effects.denied).toBe(expectedDenials);
        vi.unstubAllEnvs();
        if (home) rmSync(home, { recursive: true, force: true });
    });

    it("subtracts delayed owner resolution and real attestation before forwarding the host allowance", async () => {
        writeFileSync(behavior, JSON.stringify({ ownerDelay: 140, attestationDelay: 140 }));
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 700 });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        expect(count("/v1/owner/resolve")).toBe(1);
        expect(count("/status")).toBe(1);
        const sent = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        expect(sent).toHaveLength(1);
        expect(sent[0].params.requestTimeoutMs).toBeGreaterThan(0);
        expect(sent[0].params.requestTimeoutMs).toBeLessThan(460);
    });

    it("leaves ordinary non-wait requests without an observation allowance", async () => {
        writeFileSync(behavior, JSON.stringify({ rpcDelay: 180 }));
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source" });
        expect(result.ok, JSON.stringify(result)).toBe(true);
        const sent = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        expect(sent).toHaveLength(1);
        expect(sent[0].params).not.toHaveProperty("requestTimeoutMs");
    });

    it("does not restart the allowance for a stalled RPC after owner resolution and attestation", async () => {
        writeFileSync(behavior, JSON.stringify({ ownerDelay: 140, attestationDelay: 140, rpcDelay: 550 }));
        const started = performance.now();
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 600 });
        expect(result.ok, JSON.stringify(result)).toBe(false);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(count("/status")).toBe(1);
        expect(requests().filter(line => line.startsWith("{"))).toHaveLength(1);
    });

    it("does not send an RPC when real attestation consumes the remaining allowance", async () => {
        writeFileSync(behavior, JSON.stringify({ ownerDelay: 140, attestationDelay: 400 }));
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 350 });
        expect(result.ok).toBe(false);
        expect(result.error).not.toBe(exhaustion);
        expect(count("/status")).toBe(1);
        expect(requests().filter(line => line.startsWith("{"))).toHaveLength(0);
    });

    it.each(["owner", "attestation"])("successful %s then known expiry with no observation RPC", async phase => {
        phaseClock.enabled = true;
        writeFileSync(behavior, JSON.stringify(phase === "owner" ? { clockAfterOwner: 351 } : { clockAfterAttestation: 351 }));
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 350 });
        expect(result).toMatchObject({ ok: false, selected: null, attempts: [], error: exhaustion });
        expect(isLocalObservationBudgetExhaustion(result)).toBe(true);
        expect(isLocalObservationBudgetExhaustion({ ...result })).toBe(false);
        expect(isLocalObservationBudgetExhaustion(JSON.parse(JSON.stringify(result)))).toBe(false);
        expect(requests().filter(line => line.startsWith("{"))).toEqual([]);
        expect(count("/status")).toBe(phase === "owner" ? 0 : 1);
        expect(requests()).toContain(phase === "owner" ? "phase:owner-success" : "phase:status:success");
    });

    it("retains ORIGINAL-admitted exact two absences and500→200 allowances over authenticated HTTP", async () => {
        phaseClock.enabled = true;
        const wait = createWaitBudget(500, 300);
        const first = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: wait.requestTimeout(600000) });
        writeFileSync(phaseClock.path, "300");
        const second = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: wait.requestTimeout(600000) });
        expect(first.ok).toBe(true); expect(second.ok).toBe(true);
        expect(first.result.response.body.value).toBe("<App>absent</App>");
        expect(second.result.response.body.value).toBe("<App>absent</App>");
        const observations = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
        expect(observations.map(rpc => rpc.params.requestTimeoutMs)).toEqual([500, 200]);
        assertAdmission();
    });

    it("never relabels a started RPC and its caught deadline failure at the next candidate", async () => {
        phaseClock.enabled = true;
        writeFileSync(behavior, JSON.stringify({ clockOnRpc: 351 }));
        const result = await brokerAppium({ ...options, hostCandidates: ["127.0.0.1", "127.0.0.1"], action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 350 });
        expect(result.ok).toBe(false);
        expect(result.error).not.toBe(exhaustion);
        expect(result.attempts).toHaveLength(1);
        expect(result.attempts[0].status).toBeNull();
        expect(requests()).toContain("phase:rpc-started");
        expect(requests().filter(line => line.startsWith("{"))).toHaveLength(1);
        assertAdmission();
    });

    it("preserves body bounds and owner-token admission before known pre-attestation expiry", async () => {
        phaseClock.enabled = true;
        const oversized = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", body: "x".repeat(65537), requestTimeoutMs: 350 });
        expect(oversized).toMatchObject({ ok: false, error: "request-too-large" });
        expect(requests()).toEqual([]);
        writeFileSync(auth, JSON.stringify({ ownerId: ownerId(), secret: "invalid" }));
        writeFileSync(behavior, JSON.stringify({ clockAfterOwner: 351 }));
        const missingAuth = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs: 350 });
        expect(missingAuth).toMatchObject({ ok: false, error: "broker-owner-auth-unavailable" });
        expect(count("/status")).toBe(0);
        expect(requests().filter(line => line.startsWith("{"))).toEqual([]);
    });

    it.each([0, -1, NaN, Infinity, "100", null, 600001])("rejects invalid client observation allowance %s without transport", async (requestTimeoutMs) => {
        const result = await brokerAppium({ ...options, action: "request", backend: "android-emulator", deviceId: "pixel", path: "/source", requestTimeoutMs });
        expect(result).toMatchObject({ ok: false, error: "invalid-appium-request-timeout" });
        expect(requests()).toEqual([]);
    });

    it("counts caught unallocated network, process, filesystem and signal attempts before denial", () => {
        expectedDenials += 4;
        expect(() => fencedProcess.execSync("unallocated-provider")).toThrow("unallocated");
        expect(() => fencedFs.openSync("/tmp/unallocated-broker-budget-file", "w")).toThrow("unallocated");
        expect(() => fencedHttp.request({ host: "127.0.0.1", port: options.port + 1 })).toThrow("unallocated");
        expect(() => process.kill(1, 0)).toThrow("unallocated");
        expect(effects.denied).toBe(expectedDenials);
        expect(requests()).toEqual([]);
    });

    it.each(["wait_for_text", "wait_for_app"].flatMap(tool => [false, true].map(stallBody => ({ tool, stallBody }))))("native emitted $tool keeps500/300 budget (stall=$stallBody)", async ({ tool, stallBody }) => {
        writeFileSync(behavior, JSON.stringify({ publicRoute: true, stallBody }));
        const { client, close } = await publicClient(false);
        try {
            const result = await client.callTool({ name: tool, arguments: {
                ...options, viaBroker: true, deviceId: "pixel",
                ...(tool === "wait_for_app" ? { appId: "com.example.target" } : { text: "matching text" }), timeoutMs: 500, intervalMs: 300, detail: true,
            } });
            const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
            const rpcs = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
            expect(rpcs.filter(rpc => rpc.method === "broker.appium.session.ensure")).toHaveLength(1);
            const observations = rpcs.filter(rpc => rpc.method === "broker.appium.request");
            expect(observations.length).toBeGreaterThan(0);
            if (stallBody) {
                expect(payload.ok).toBe(false);
                expect(payload.found).toBeUndefined();
                expect(observations).toHaveLength(1);
            } else {
                expect(payload.found, JSON.stringify(payload)).toBe(false);
                expect(payload).toMatchObject({ timeoutMs: 500, provider: "broker-appium", backend: "android-emulator" });
                expect(requests()).toContain("phase:observation-success");
                if (tool === "wait_for_text") expect(payload.source).toBe("<App>absent</App>");
                else expect(payload.appState).toBe(1);
            }
            expect(count("/health")).toBe(0);
            const extra = count("/status") - rpcs.length;
            if (stallBody) assertAdmission();
            else {
                expect([0, 1]).toContain(extra);
                if (extra === 1) {
                    const lastStatus = requests().lastIndexOf("/status");
                    expect(requests().slice(lastStatus)).toContain("phase:status:success");
                    expect(requests().slice(lastStatus).some(line => line.startsWith("{"))).toBe(false);
                }
                assertAdmission(extra);
            }
            const calls = () => requests().filter(line => line.startsWith("/"));
            const requestsAtFinish = calls().length;
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(calls()).toHaveLength(requestsAtFinish);
        } finally { await close(); }
    }, 15000);

    const publicCases: Array<{ label: string; state: Record<string, unknown>; found: boolean; error: boolean; observations: number; extra: number }> = [
        { label: "first owner expiry", state: { clockAfterOwner: 1000 }, found: false, error: true, observations: 0, extra: 0 },
        { label: "first successful-attestation expiry", state: { clockAfterAttestation: 1000 }, found: false, error: true, observations: 0, extra: 1 },
        { label: "later owner expiry after absence", state: { afterAbsence: true, clockAfterOwner: 1000 }, found: false, error: false, observations: 1, extra: 0 },
        { label: "later successful-attestation expiry after absence", state: { afterAbsence: true, clockAfterAttestation: 1000 }, found: false, error: false, observations: 1, extra: 1 },
        { label: "started stalled RPC after absence", state: { afterAbsence: true, rpcDelay: 550 }, found: false, error: true, observations: 2, extra: 0 },
        { label: "started stalled response body after absence", state: { afterAbsence: true, stallBody: true }, found: false, error: true, observations: 2, extra: 0 },
        { label: "started stalled status after absence", state: { afterAbsence: true, attestationDelay: 550 }, found: false, error: true, observations: 1, extra: 1 },
        { label: "owner error after absence", state: { afterAbsence: true, ownerError: true }, found: false, error: true, observations: 1, extra: 0 },
        { label: "auth error after absence", state: { afterAbsence: true, authError: true }, found: false, error: true, observations: 1, extra: 1 },
        { label: "body error after absence", state: { afterAbsence: true, bodyError: true }, found: false, error: true, observations: 2, extra: 0 },
        { label: "config protocol error after absence", state: { afterAbsence: true, incompatible: true }, found: false, error: true, observations: 1, extra: 1 },
        { label: "generation error after absence", state: { afterAbsence: true, changedGeneration: true }, found: false, error: true, observations: 1, extra: 1 },
        { label: "RPC error after absence", state: { afterAbsence: true, rpcError: true }, found: false, error: true, observations: 2, extra: 0 },
        { label: "started RPC HTTP500 reserved reason after absence", state: { afterAbsence: true, rpcError: exhaustion }, found: false, error: true, observations: 2, extra: 0 },
        { label: "found before deadline", state: { foundValue: true }, found: true, error: false, observations: 1, extra: 0 },
        { label: "late successful response remains error", state: { clockAfterResponse: 1000, foundValue: true }, found: false, error: true, observations: 1, extra: 0 },
        { label: "first positive-remaining then zero allowance race", state: { firstRace: true }, found: false, error: true, observations: 0, extra: 0 },
        { label: "positive-remaining then zero allowance after absence", state: { outerRace: true }, found: false, error: false, observations: 1, extra: 0 },
    ];
    it.each(["wait_for_text", "wait_for_app"].flatMap(tool => publicCases.map(test => ({ tool, ...test }))))("controlled emitted $tool: $label", async ({ tool, label, state, found, error, observations, extra }) => {
        const value = state.foundValue ? (tool === "wait_for_text" ? "matching text" : 3) : undefined;
        writeFileSync(behavior, JSON.stringify({ ...state, value, publicRoute: true }));
        const { client, close } = await publicClient(true);
        try {
            const result = await client.callTool({ name: tool, arguments: { ...options, viaBroker: true, deviceId: "pixel", ...(tool === "wait_for_app" ? { appId: "com.example.target" } : { text: "matching text" }), timeoutMs: 500, intervalMs: 300, detail: true } });
            const text = (result.content as Array<{ text: string }>)[0].text;
            let payload: Record<string, unknown>;
            try { payload = JSON.parse(text); } catch { payload = { error: text }; }
            if (error) {
                expect(payload.found, text).toBeUndefined();
                if (label.startsWith("first") && !label.includes("race")) expect(payload.error, text).toBe(exhaustion);
                else if (label === "started RPC HTTP500 reserved reason after absence") {
                    expect(payload).toMatchObject({ ok: false, error: exhaustion, status: 500 });
                    const attempts = payload.attempts as Array<{ status: number }>;
                    expect(attempts).toHaveLength(1);
                    expect(attempts[0].status).toBe(500);
                    expect(payload.selected).toEqual(attempts[0]);
                    expect(payload.selected).toMatchObject({ ok: false, status: 500, host: "127.0.0.1", port: options.port });
                } else expect(text).not.toContain(exhaustion);
                expect(result.isError === true || payload.ok === false || Boolean(payload.error), text).toBe(true);
            } else {
                expect(payload.found, text).toBe(found);
                expect(payload).toMatchObject({ provider: "broker-appium", backend: "android-emulator" });
                if (!found) {
                    expect(payload.timeoutMs).toBe(500);
                    expect(payload[tool === "wait_for_text" ? "source" : "appState"]).toBe(tool === "wait_for_text" ? "<App>absent</App>" : 1);
                }
            }
            const rpcs = requests().filter(line => line.startsWith("{")).map(line => JSON.parse(line));
            expect(rpcs.filter(rpc => rpc.method === "broker.appium.session.ensure")).toHaveLength(1);
            expect(rpcs.filter(rpc => rpc.method === "broker.appium.request")).toHaveLength(observations);
            if (state.afterAbsence) expect(requests()).toContain("phase:observation-success");
            assertAdmission(extra);
            if (label.includes("successful-attestation expiry")) {
                const cutoff = requests().slice(requests().lastIndexOf("/status"));
                expect(cutoff).toContain("phase:status:success");
                expect(cutoff.some(line => line.startsWith("{"))).toBe(false);
                expect(Number(readFileSync(phaseClock.path, "utf8"))).toBe(1000);
            }
            const calls = () => requests().filter(line => line.startsWith("/"));
            const atFinish = calls();
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(calls()).toEqual(atFinish);
        } finally { await close(); }
    }, 15000);
});
