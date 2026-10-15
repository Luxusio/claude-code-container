import { beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

type Scenario = {name: string; backend: "macos-vm" | "windows-vm" | "linux-vm" | "android-device"; command: "device_start" | "device_stop" | "device_delete" | "device_reboot" | "device_status"; race?: "created" | "runtime" | "incarnation" | "nested" | "secret" | "missing" | "unrelated"; phase?: "provider" | "plan" | "before-cleanup" | "cleanup-commit" | "before-ssh" | "ssh-commit" | "after-ssh" | "physical-release"; cleanup?: boolean; guestFailure?: boolean; auth?: "missing" | "wrong"; writeFault?: boolean; dryRun?: boolean; planOnly?: boolean; detach?: boolean; wallJump?: -1 | 1};
type StateSnapshot = {bytes: string; dev: string; ino: string; mtime: string; mode: string; nlink: string};
type Receipt = {outcome: {status: number; body: {ok: boolean; error?: string; found?: boolean; providerFailure?: string; result?: {device?: Record<string, unknown> | null; invoked?: boolean; execution?: {providerExecution?: string; command?: unknown}; auxiliaryCleanup?: {ok: boolean; changed: boolean; stateConflict?: boolean; minimizeWatchdog?: {cleared: boolean}}; boot?: unknown; leaseRollback?: {attempted: boolean; ok: boolean}}}}; denied: unknown[]; ownIdentityObservations: number; initial: Record<string, unknown>; expected: Record<string, unknown>[]; unrelated: Record<string, unknown>; after: StateSnapshot; protectedSnapshot: StateSnapshot; injected: boolean; calls: {provider: string; args: string[]; operation?: string; timeoutMs?: number}[]; ownerPublicationsAfterRace: number; temporaryOwnerWritesAfterRace: number; cancellationWrites: number; lease?: Record<string, unknown>; initialExpiry?: string; storageFaults: number; modules: string[]; reconciledRecordAtSsh?: Record<string, unknown>; fingerprint?: string; publicationBuilderClockReads: number; monotonicReads: number; wallJumps: number};

const project = fileURLToPath(new URL("../../", import.meta.url));
const sourceFiles = new Map<string, string>();
const emittedFiles = new Map<string, string>();
function ordinaryFiles(directory: string): string[] {
    return readdirSync(directory).sort().flatMap(name => {
        const path = join(directory, name), stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("unadmitted package symlink: " + path);
        return stat.isDirectory() ? ordinaryFiles(path) : stat.isFile() ? [path] : [];
    });
}
beforeAll(() => {
    // Authenticate CURRENT complete configured package emit, including declarations. A fresh
    // Root build is mandatory; no old module, ignored checkpoint or source fallback is used.
    for (const name of ["hyper-v", "device-lab"]) {
        const packageRoot = join(project, "packages", name);
        const config = ts.readConfigFile(join(packageRoot, "tsconfig.json"), ts.sys.readFile);
        expect(config.error).toBeUndefined();
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packageRoot);
        expect(parsed.errors).toEqual([]);
        const program = ts.createProgram(parsed.fileNames, parsed.options);
        expect(ts.getPreEmitDiagnostics(program).map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
        const memory = new Map<string, string>();
        const emitted = program.emit(undefined, (path, contents) => memory.set(resolve(path), contents));
        expect(emitted.emitSkipped).toBe(false); expect(emitted.diagnostics).toEqual([]);
        const dist = join(packageRoot, "dist");
        expect(existsSync(dist), "genuine fresh configured package build required").toBe(true);
        const actual = ordinaryFiles(dist).filter(path => /\.(?:js|d\.ts)$/.test(path));
        expect(actual.sort()).toEqual([...memory.keys()].filter(path => /\.(?:js|d\.ts)$/.test(path)).sort());
        for (const [path, bytes] of memory) {
            expect(readFileSync(path, "utf8"), "complete current package emit: " + path).toBe(bytes);
            emittedFiles.set(path, createHash("sha256").update(bytes).digest("hex"));
        }
        for (const subdirectory of ["src", "powershell", ...(name === "device-lab" ? ["providers"] : [])]) for (const path of ordinaryFiles(join(packageRoot, subdirectory))) {
            sourceFiles.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
        }
        for (const path of [join(packageRoot, "package.json"), join(packageRoot, "tsconfig.json")]) sourceFiles.set(path, createHash("sha256").update(readFileSync(path)).digest("hex"));
    }
}, 120000);

// Minimal private SDK loader. It loads only authenticated CURRENT package source paths,
// preserves one URL per class/module, and never falls back to a compiled broker.
const SOURCE_LOADER = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const settings=JSON.parse(fs.readFileSync(process.env.CCC_LIFECYCLE_FIXTURE_FILE,'utf8'));
const ts=(await import(pathToFileURL(path.join(settings.project,'node_modules/typescript/lib/typescript.js')).href)).default;
const source=new Map(settings.sourceFiles);
function admitted(url){const name=fileURLToPath(url);if(!source.has(name))throw Error('unadmitted source module '+name);return name;}
export async function resolve(specifier,context,next){
 let candidate;
 for(const name of ['device-lab','hyper-v'])if(specifier==='@ccc/'+name||specifier.startsWith('@ccc/'+name+'/')){
  let rest=specifier==='@ccc/'+name?'index.ts':specifier.slice(('@ccc/'+name+'/').length);
  if(rest==='low-level'||rest==='lifecycle')rest+='/index.ts';
  else if(rest.endsWith('.js'))rest=rest.slice(0,-3)+'.ts';
  candidate=pathToFileURL(path.join(settings.project,'packages',name,rest.startsWith('providers/')||rest.startsWith('powershell/')?rest:'src/'+rest)).href;
 }
 if(!candidate&&specifier.startsWith('.')&&context.parentURL?.includes('/src/')){
  const original=new URL(specifier,context.parentURL);
  candidate=specifier.endsWith('.js')?new URL(specifier.slice(0,-3)+'.ts',context.parentURL).href:original.href;
 }
 if(candidate){admitted(candidate);return{url:candidate,shortCircuit:true};}
 return next(specifier,context);
}
export async function load(url,context,next){
 if(url.endsWith('.ts')){const name=admitted(url);const bytes=fs.readFileSync(name,'utf8');
  const crypto=await import('node:crypto');if(crypto.createHash('sha256').update(bytes).digest('hex')!==source.get(name))throw Error('changed source module '+name);
  return{format:'module',shortCircuit:true,source:ts.transpileModule(bytes,{fileName:name,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText};}
 return next(url,context);
}
`;

const WORKER = String.raw`
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),net=require('node:net'),cp=require('node:child_process'),os=require('node:os'),crypto=require('node:crypto');
const {syncBuiltinESMExports}=require('node:module'),{pathToFileURL}=require('node:url');
const settings=JSON.parse(fs.readFileSync(process.env.CCC_LIFECYCLE_FIXTURE_FILE,'utf8')),scenario=settings.scenario,home=settings.home;
const raw=Object.fromEntries(Object.entries(fs).filter(([,value])=>typeof value==='function'));
const rawSpawnSync=cp.spawnSync;
let monotonicNow=37.25,wallNow=Date.now(),monotonicReads=0,wallJumps=0;
if(scenario.wallJump)Date.now=()=>wallNow;
let ownIdentityProbe=null,ownIdentityObservations=0;
const ownIdentityOptions=Object.freeze({encoding:'utf8',timeout:5000,killSignal:'SIGKILL',windowsHide:true});
const denied=[],calls=[],mutations=[],ownedDescriptors=new Map();let port,server,ownerFile,actor=0,rpcActive=false,ownerReads=0,afterCancellation=false,afterHostKeyWrite=false,afterPhysicalRelease=false,injected=false,protectedSnapshot,expected,initial,other,ownerPublicationsAfterRace=0,temporaryOwnerWritesAfterRace=0,cancellationWrites=0,storageFaults=0,reconciledRecordAtSsh;
const homeIdentity=raw.lstatSync(home);
let ownerMutationActive=false,publicationBuilderClockReads=0;
const nativeIso=Date.prototype.toISOString;
Date.prototype.toISOString=function(...args){const stack=String(new Error().stack);if(!actor&&rpcActive&&injected&&ownerMutationActive&&!/\bat lockRecord(?:Async)?\b/.test(stack)&&(/\bat mutateDeviceAfterCommand\b/.test(stack)||scenario.guestFailure&&/\bat lifecycleCommandInvokeUnlocked\b/.test(stack)))publicationBuilderClockReads++;return Reflect.apply(nativeIso,this,args);};
function deny(kind,args){denied.push({kind,args:args.map(String)});throw Error('fixture denied '+kind);}
function privatePath(value){if(typeof value==='number')return ownedDescriptors.has(value);if(typeof value!=='string'&&!Buffer.isBuffer(value)&&!(value instanceof URL))return false;const name=value instanceof URL?require('node:url').fileURLToPath(value):String(value);const absolute=path.resolve(name);if(absolute!==home&&!absolute.startsWith(home+path.sep))return false;const canonical=raw.realpathSync.native?(()=>{let root=absolute;while(!raw.existsSync(root))root=path.dirname(root);return path.join(raw.realpathSync(root),path.relative(root,absolute));})():absolute;return canonical===home||canonical.startsWith(home+path.sep);}
function controller(operation){actor++;try{return operation();}finally{actor--;}}
function stableHome(){const current=raw.lstatSync(home);if(current.isSymbolicLink()||current.dev!==homeIdentity.dev||current.ino!==homeIdentity.ino)deny('home-rebound',[]);}
function snapshot(){return controller(()=>{const stat=raw.statSync(ownerFile,{bigint:true});return{bytes:raw.readFileSync(ownerFile,'utf8'),dev:String(stat.dev),ino:String(stat.ino),mtime:String(stat.mtimeNs),mode:String(stat.mode),nlink:String(stat.nlink)};});}
function publish(devices){controller(()=>{const temporary=ownerFile+'.fixture-successor';raw.writeFileSync(temporary,JSON.stringify({devices}),{mode:0o600});raw.renameSync(temporary,ownerFile);});}
function race(){if(injected||!scenario.race)return;injected=true;let replacement=structuredClone(scenario.phase==='after-ssh'?JSON.parse(snapshot().bytes).devices.find(item=>item.id===initial.id):initial);
 if(scenario.race==='created'){replacement.createdAt='successor';replacement.updatedAt='successor';replacement.status='successor-state';}
 if(scenario.race==='runtime')replacement.runtime={pid:90002,nonce:'successor-runtime',processStartToken:'successor-birth'};
 if(scenario.race==='incarnation'){replacement.incarnationId='2'.repeat(32);replacement.vmId='bbbbbbbb-cccc-dddd-eeee-ffffffffffff';}
 if(scenario.race==='nested')replacement.preferences={nested:{colour:'changed'},unrelatedToRuntime:true};
 if(scenario.race==='secret')replacement.ssh={...replacement.ssh,password:'successor-private-secret'};
 const unrelated=scenario.race==='unrelated'?{...other,note:'concurrent-unrelated-edit'}:other;
 expected=scenario.race==='missing'?[unrelated]:[scenario.race==='unrelated'?JSON.parse(snapshot().bytes).devices.find(item=>item.id===initial.id):replacement,unrelated];
 publish(expected);protectedSnapshot=snapshot();ownerPublicationsAfterRace=0;temporaryOwnerWritesAfterRace=0;publicationBuilderClockReads=0;
}
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[name]=(...args)=>deny('child_process.'+name,args);
// Only these exact self-only production observations can reach the original builtin.
// Forward captured arguments, never caller arguments; cache each read for this process birth.
cp.spawnSync=(executable,args,options)=>{
 const probe=ownIdentityProbe;
 const exactOptions=options&&Object.getPrototypeOf(options)===Object.prototype&&Object.getOwnPropertySymbols(options).length===0&&Object.getOwnPropertyNames(options).sort().join(',')==='encoding,killSignal,timeout,windowsHide'&&Object.entries(ownIdentityOptions).every(([key,value])=>options[key]===value);
 const query=probe&&executable===probe.executable&&Array.isArray(args)&&exactOptions?probe.queries.find(query=>args.length===query.args.length&&query.args.every((value,index)=>args[index]===value)):null;
 if(!query)return deny('child_process.spawnSync',[executable,args,options]);
 if(!query.result){ownIdentityObservations++;query.result=rawSpawnSync(probe.executable,[...query.args],{...ownIdentityOptions});}
 return{...query.result};
};
process.kill=(...args)=>deny('process.kill',args);
for(const name of ['writeFileSync','appendFileSync','mkdirSync','rmSync','unlinkSync','rmdirSync','renameSync','chmodSync','chownSync','symlinkSync','linkSync','truncateSync','copyFileSync'])fs[name]=(...args)=>{
 stableHome();if(!privatePath(args[0])||(['renameSync','symlinkSync','linkSync','copyFileSync'].includes(name)&&!privatePath(args[1])))return deny('fs.'+name,args);
 if(!actor&&rpcActive){mutations.push({kind:name,path:String(args[0]),target:args[1]===undefined?null:String(args[1])});
  if((name==='writeFileSync'||name==='appendFileSync')&&String(args[0])===ownerFile)ownerPublicationsAfterRace++;
  if(name==='renameSync'&&String(args[1])===ownerFile){ownerPublicationsAfterRace++;if(scenario.writeFault){storageFaults++;throw Object.assign(Error('fixture real inventory EIO'),{code:'EIO'});}}
 }
 const result=raw[name](...args);
 if(!actor&&rpcActive&&name==='writeFileSync'&&String(args[0]).endsWith('ccc-minimize-watchdog.cancel')){cancellationWrites++;afterCancellation=true;}
 if(!actor&&rpcActive&&name==='renameSync'&&String(args[1])===initial?.sshHostPublicKeyPath)afterHostKeyWrite=true;
 if(!actor&&rpcActive&&name==='renameSync'&&String(args[0]).endsWith('devices.mutation.lock'))ownerMutationActive=false;
 if(!actor&&rpcActive&&['renameSync','unlinkSync','rmSync'].includes(name)&&String(args[0]).endsWith(path.sep+path.join('physical-leases','android-device','locks','FIXTURE-USB.json')))afterPhysicalRelease=true;
 return result;
};
fs.openSync=(...args)=>{stableHome();const flags=args[1],write=typeof flags==='string'?/[wa+]/.test(flags):Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));if(write&&!privatePath(args[0]))return deny('fs.openSync.write',args);
 if(!actor&&rpcActive&&String(args[0])===ownerFile&&!write){ownerReads++;if(scenario.phase==='before-cleanup'&&ownerReads===2||scenario.phase==='cleanup-commit'&&afterCancellation)race();}
 if(!actor&&rpcActive&&!write&&scenario.phase==='before-ssh'&&String(args[0])===initial?.sshKnownHostsPath)race();
 if(!actor&&rpcActive&&!write&&scenario.phase==='ssh-commit'&&afterHostKeyWrite&&String(args[0])===ownerFile)race();
 if(!actor&&rpcActive&&!write&&scenario.phase==='physical-release'&&afterPhysicalRelease&&String(args[0])===ownerFile)race();
 if(!actor&&rpcActive&&write&&String(args[0]).startsWith(ownerFile+'.'))temporaryOwnerWritesAfterRace++;
 if(!actor&&rpcActive&&write&&String(args[0]).endsWith('devices.mutation.lock'))ownerMutationActive=true;
 const descriptor=raw.openSync(...args);if(privatePath(args[0])){const held=raw.fstatSync(descriptor);ownedDescriptors.set(descriptor,{path:String(args[0]),dev:held.dev,ino:held.ino,uid:held.uid,readOwner:!write&&String(args[0])===ownerFile});}return descriptor;};
fs.closeSync=descriptor=>{const witness=ownedDescriptors.get(descriptor);const result=raw.closeSync(descriptor);ownedDescriptors.delete(descriptor);if(!actor&&rpcActive&&witness?.readOwner&&scenario.phase==='plan'&&ownerReads===1)race();return result;};
for(const name of ['writeSync','ftruncateSync','fchmodSync','fchownSync','fsyncSync'])fs[name]=(...args)=>{const witness=ownedDescriptors.get(args[0]);if(!witness)return deny('fs.'+name,args);const held=raw.fstatSync(args[0]);if(held.dev!==witness.dev||held.ino!==witness.ino||held.uid!==witness.uid)return deny('fs.reused-descriptor.'+name,args);return raw[name](...args);};
for(const name of ['writeFile','appendFile','mkdir','rm','unlink','rmdir','rename','chmod','chown','symlink','link','truncate','copyFile']){fs[name]=(...args)=>deny('fs.async.'+name,args);if(fs.promises[name])fs.promises[name]=async(...args)=>deny('fs.promises.'+name,args);}
// No broker fixture needs asynchronous descriptor acquisition. Reject BEFORE either
// native route can return an unowned descriptor/FileHandle, including caught failures.
fs.open=(...args)=>deny('fs.async.open',args);
fs.promises.open=async(...args)=>deny('fs.promises.open',args);
const realListen=net.Server.prototype.listen;net.Server.prototype.listen=function(...args){if(args[0]!==0||args[1]!=='127.0.0.1')return deny('listen',args);return realListen.apply(this,args);};
const realConnect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const value=Array.isArray(args[0])?args[0][0]:args[0];if(value&&typeof value==='object'&&Number(value.port)===port&&['127.0.0.1','localhost'].includes(value.host))return realConnect.apply(this,args);return deny('connect',args);};
os.totalmem=()=>64*1024**3;os.freemem=()=>48*1024**3;syncBuiltinESMExports();
function rpc(base,owner,token,params){return new Promise((resolve,reject)=>{const request=http.request(base+'/v1/owners/'+owner+'/rpc',{method:'POST',headers:{'content-type':'application/json',...(token===undefined?{}:{'x-ccc-device-token':token})}},response=>{let body='';response.on('data',chunk=>body+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(body)}));});request.on('error',reject);request.end(JSON.stringify({method:scenario.detach?'broker.physical.detach':scenario.planOnly?'broker.command.plan':'broker.command.invoke',params:scenario.detach?{backend:params.backend,deviceId:params.deviceId}:params}));});}
(async()=>{
 // Every file token is checked before the first broker/provider import.
 for(const [file,digest] of [...settings.sourceFiles,...settings.emittedFiles])if(crypto.createHash('sha256').update(raw.readFileSync(file)).digest('hex')!==digest)throw Error('changed admitted production file '+file);
 const directory=path.join(settings.project,'packages/device-lab',settings.lens==='source'?'src':'dist');
 if(process.platform==='win32'){
  const extension=settings.lens==='source'?'ts':'js';
  const system=await import(pathToFileURL(path.join(directory,'windows-system-powershell.'+extension)).href);
  const processIdentity=await import(pathToFileURL(path.join(directory,'device-lab-process-identity.'+extension)).href);
  const executable=system.canonicalWindowsPowerShellPath();
  if(!executable)throw Error('fixture canonical self-identity executable unavailable');
  const systemExecutable=path.join("\\\\?\\GLOBALROOT\\SystemRoot\\System32",'WindowsPowerShell','v1.0','powershell.exe');
  const executableMetadata=raw.lstatSync(executable);
  if(!executableMetadata.isFile()||executableMetadata.isSymbolicLink()||raw.realpathSync.native(executable)!==raw.realpathSync.native(systemExecutable))throw Error('unadmitted self-identity executable');
  const pid=process.pid;
  const scripts=[
   "$P = Get-CimInstance Win32_Process -Filter 'ProcessId = "+pid+"' -ErrorAction SilentlyContinue; $H = Get-Process -Id "+pid+" -ErrorAction SilentlyContinue; if ($P -and $H) { [pscustomobject]@{ startToken = $H.StartTime.ToUniversalTime().ToString('o'); commandLine = [string]$P.CommandLine } | ConvertTo-Json -Compress }",
   "$P = Get-Process -Id "+pid+" -ErrorAction SilentlyContinue; if ($P) { [Console]::Out.Write($P.StartTime.ToUniversalTime().ToString('o')) }",
  ];
  if(processIdentity.windowsProcessIdentityScriptForTest(pid)!==scripts[0]||system.windowsStartTokenExpression('$P')!=="$P.StartTime.ToUniversalTime().ToString('o')")throw Error('unadmitted self-identity script');
  ownIdentityProbe={executable,queries:scripts.map(script=>{
   const args=Object.freeze(['-WindowStyle','Hidden','-NoProfile','-NonInteractive','-Command',script]);
   const productionArgs=system.hiddenWindowsPowerShellArgs(['-NoProfile','-NonInteractive','-Command',script]);
   if(productionArgs.length!==args.length||args.some((value,index)=>productionArgs[index]!==value))throw Error('unadmitted self-identity argv');
   return{args,result:null};
  })};
 }
 const broker=await import(pathToFileURL(path.join(directory,'device-lab-broker.'+(settings.lens==='source'?'ts':'js'))).href);
 const ownership=await import(pathToFileURL(path.join(directory,'device-lab-owner.'+(settings.lens==='source'?'ts':'js'))).href);
 const hyperv=await import(pathToFileURL(path.join(directory,'host-control/hyper-v/index.'+(settings.lens==='source'?'ts':'js'))).href);
 const hvState=await import(pathToFileURL(path.join(directory,'device-lab/broker/hyper-v/state.'+(settings.lens==='source'?'ts':'js'))).href);
 const cwd=path.join(home,'project');controller(()=>fs.mkdirSync(cwd,{recursive:true}));
 const owner=ownership.deviceLabOwnerId(cwd),id='race',hv=scenario.backend==='windows-vm'||scenario.backend==='linux-vm',linux=scenario.backend==='linux-vm',physical=scenario.backend==='android-device',stateKey=hv?scenario.backend:physical?'android-device':'macos',incarnationId='1'.repeat(32),vmId='12345678-1234-1234-1234-123456789abc',vmName=hyperv.hyperVVmName(owner,id,incarnationId),privateRoot=hvState.hyperVPrivateDeviceRoot(owner,scenario.backend,id),deviceRoot=hvState.hyperVDeviceRoot(owner,scenario.backend,id);
 const hostKey=Buffer.alloc(51);hostKey.writeUInt32BE(11,0);hostKey.write('ssh-ed25519',4,'ascii');hostKey.writeUInt32BE(32,15);hostKey.fill(5,19);
 const keyBase64=hostKey.toString('base64'),fingerprint='SHA256:'+crypto.createHash('sha256').update(hostKey).digest('base64').replace(/=+$/,'');
 initial={id,backend:scenario.backend,ownerId:owner,provider:hv?'hyper-v':physical?'adb':'tart',providerInstance:'ccc-'+owner+'-'+id,status:physical?'attached':'running',createdAt:'original',updatedAt:'original',headless:true,preferences:{nested:{colour:'original'}},ssh:{password:'original-private-secret',host:'fixture-host',privateRoot:path.join(home,'secret-path')},...(scenario.cleanup?{minimizeWatchdog:{processOwner:'host-broker',startedBy:'broker.windows-sandbox.minimize-watchdog',pid:987654}}:{}),...(physical?{physical:true,serial:'FIXTURE-USB',leaseClaimId:'fixture-claim',leaseClaimNonce:'fixture-nonce'}:{}),...(hv?{vmId,vmName,incarnationId,memoryMb:4096,cpus:2,diskMaxBytes:68719476736,diskPath:path.join(deviceRoot,'disks/root.vhdx'),privateRoot,guestCredentialPath:path.join(privateRoot,'secrets/guest.credential.xml'),guestUnattendPath:path.join(deviceRoot,'disks/autounattend.iso'),guestUsername:'fixture-user',guestProvisioned:true,networkAddress:'172.29.0.20'}:{})};
 if(linux)Object.assign(initial,{deviceRoot,platform:'linux',guestTransport:'ssh',guestUsername:'fixture-user',sshPrivateKeyPath:path.join(privateRoot,'secrets/id_ed25519'),sshHostPublicKeyPath:path.join(privateRoot,'secrets/ssh_host_ed25519_key.pub'),sshKnownHostsPath:path.join(privateRoot,'secrets/known_hosts'),sshHostKeyFingerprint:'SHA256:legacy-unreconciled',sshHostKeySource:'legacy-seed',macAddress:'02:11:22:33:44:55',networkGateway:'172.29.0.1',networkPrefix:'172.29.0.0/24'});
 other={...structuredClone(initial),id:'unrelated',backend:scenario.backend,status:'stopped',createdAt:'unrelated',updatedAt:'unrelated',providerInstance:'ccc-'+owner+'-unrelated',note:'untouched',...(hv?{vmId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',vmName:hyperv.hyperVVmName(owner,'unrelated','2'.repeat(32)),incarnationId:'2'.repeat(32),privateRoot:hvState.hyperVPrivateDeviceRoot(owner,scenario.backend,'unrelated'),diskPath:path.join(hvState.hyperVDeviceRoot(owner,scenario.backend,'unrelated'),'disks/root.vhdx')}:{}),...(physical?{serial:'FIXTURE-OTHER-USB',leaseClaimId:null,leaseClaimNonce:null}:{})};
 ownerFile=path.join(home,'.ccc/devices/owners',owner,stateKey,'devices.json');controller(()=>fs.mkdirSync(path.dirname(ownerFile),{recursive:true}));publish([initial,other]);
 if(hv)controller(()=>{fs.mkdirSync(path.join(privateRoot,'secrets'),{recursive:true,mode:0o700});fs.mkdirSync(path.join(deviceRoot,'disks'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(privateRoot,'incarnation.json'),JSON.stringify({version:1,ownerId:owner,backend:scenario.backend,deviceId:id,incarnationId,createdAt:'original'}),{mode:0o600});fs.writeFileSync(initial.guestCredentialPath,'fixture-credential',{mode:0o600});fs.writeFileSync(initial.diskPath,'fixture-disk',{mode:0o600});});
 if(linux)controller(()=>{const networkFile=path.join(home,'.ccc/device-broker-private/network/hyper-v.json');fs.mkdirSync(path.dirname(networkFile),{recursive:true,mode:0o700});fs.writeFileSync(networkFile,JSON.stringify({version:1,switchName:'CCC Device Lab',switchId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',marker:'ccc-device-lab:hyper-v-network:v1',natName:'CCCDeviceLab',natInstanceId:'ccc-nat-instance-1',prefix:'172.29.0.0/24',gateway:'172.29.0.1',outboundPolicy:'nat',managedNat:true,managedSwitch:false,managedGateway:false,allocations:[{ownerId:owner,deviceId:id,incarnationId,address:'172.29.0.20',macAddress:'02:11:22:33:44:55',allocatedAt:new Date().toISOString()}]}),{mode:0o600});fs.writeFileSync(initial.sshPrivateKeyPath,'fixture-private-key',{mode:0o600});fs.writeFileSync(initial.sshHostPublicKeyPath,'ssh-ed25519 '+keyBase64+' legacy-comment\n',{mode:0o600});fs.writeFileSync(initial.sshKnownHostsPath,'172.29.0.20 ssh-ed25519 '+keyBase64+' authenticated-fixture\n',{mode:0o600});});
 let leaseFile,initialExpiry;
 if(physical)controller(()=>{leaseFile=path.join(home,'.ccc/devices/physical-leases/android-device/locks/FIXTURE-USB.json');fs.mkdirSync(path.dirname(leaseFile),{recursive:true});initialExpiry=new Date(Date.now()+10000).toISOString();fs.writeFileSync(leaseFile,JSON.stringify({backend:'android-device',hardwareId:'FIXTURE-USB',ownerId:owner,deviceId:id,claimId:'fixture-claim',claimNonce:'fixture-nonce',expiresAt:initialExpiry}),{mode:0o600});});
 let state=scenario.command==='device_reboot'?'Running':'Off';
 const fixtureProviderPaths={tart:path.join(home,'fake/tart'),'powershell.exe':path.join(home,'fake/powershell.exe'),adb:path.join(home,'fake/adb'),'ssh.exe':path.join(home,'fake/ssh.exe'),ssh:path.join(home,'fake/ssh')};
 // Linux guest transport uses the explicitly configured providerPaths.ssh token.
 const expectedGui=linux?hyperv.hyperVLinuxGuiReadyCommand({executable:fixtureProviderPaths.ssh,deviceRoot:initial.deviceRoot,privateRoot:initial.privateRoot,sshPrivateKeyPath:initial.sshPrivateKeyPath,knownHostsPath:initial.sshKnownHostsPath,guestUsername:initial.guestUsername,networkAddress:initial.networkAddress,timeoutMs:30000}):null;
 function ownedSshResponse(command){
  if(command.executable!==fixtureProviderPaths.ssh)return deny('unallocated SSH executable',[command.executable]);
  const exactGui=command.mode===expectedGui.mode&&command.executable===expectedGui.executable&&JSON.stringify(command.args)===JSON.stringify(expectedGui.args);
  return{...command,status:scenario.guestFailure?1:0,stdout:scenario.guestFailure?'':exactGui?'CCC_HYPER_V_GUI_READY\n':'ccc-hyper-v-linux-ready\n',stderr:scenario.guestFailure?'fixture-private-provider-output':''};
 }
 const runner=(command,runnerOptions)=>{
  let native=null;try{const envelope=JSON.parse(Buffer.from(command.input||'','base64').toString('utf8'));if(typeof envelope.script==='string')native=JSON.parse(envelope.input);}catch{}
  if(!native&&command.input){try{const value=JSON.parse(command.input);if(value.operation)native=value;}catch{}}
  calls.push({provider:command.provider,args:command.args||[],...(native?{operation:native.operation}:{}),timeoutMs:runnerOptions?.timeoutMs});
  if(scenario.wallJump){monotonicNow+=0.125;wallNow+=scenario.wallJump*86400000;wallJumps++;}
  if(scenario.phase==='provider'||!scenario.phase)race();
  if(command.provider==='hyper-v-ssh'){
   if(reconciledRecordAtSsh===undefined)reconciledRecordAtSsh=controller(()=>JSON.parse(raw.readFileSync(ownerFile,'utf8')).devices.find(item=>item.id===id));
   if(scenario.phase==='after-ssh')race();
   return ownedSshResponse(command);
  }
  if(command.provider==='tart'){
   if(command.args?.[0]==='get'){
    if(scenario.command!=='device_status'||command.executable!==path.join(home,'fake/tart')||command.args.length!==2||command.args[1]!==initial.providerInstance||command.mode!=='exec'||runnerOptions?.timeoutMs!==broker.DEVICE_BROKER_COMMAND_TIMEOUT_MS||runnerOptions?.outputLimit!==broker.DEVICE_BROKER_COMMAND_OUTPUT_LIMIT||Object.keys(runnerOptions).sort().join(',')!=='outputLimit,timeoutMs')return deny('unadmitted owned tart get',[command.args,runnerOptions]);
    return{...command,status:0,stdout:JSON.stringify({Name:initial.providerInstance,State:'running'}),stderr:''};
   }
   if(!['run','stop','delete','list'].includes(command.args?.[0]))return deny('unadmitted tart command',[command.args]);
   return{...command,status:0,stdout:command.args[0]==='list'?'[]':'',stderr:''};
  }
  if(command.provider==='android-device'||command.provider==='adb'||command.provider==='host-broker-state')return{...command,status:0,stdout:'',stderr:''};
  if(command.provider!=='hyper-v'||!native)return deny('unadmitted typed provider command',[command.provider,command.args]);
  if(!['Get-VM','Start-VM','Stop-VM','Restart-VM','Get-VMDiagnostic','Invoke-Guest','Get-VMDvdDrive','Remove-VMDvdDrive','Get-VMHardDiskDrive','Get-VMNetworkAdapter','Get-NetNeighbor','Get-NetIPAddress'].includes(native.operation))return deny('unadmitted Hyper-V operation',[native.operation]);
  if(native.operation==='Start-VM'||native.operation==='Restart-VM')state='Running';if(native.operation==='Stop-VM')state='Off';let items=[];
  if(native.operation==='Get-VM')items=Array.isArray(native.names)
   ? [{id:vmId,name:vmName,notes:hyperv.ownershipMarker(owner,id,incarnationId)}]
   : [{id:vmId,name:vmName,state,status:'Operating normally',notes:hyperv.ownershipMarker(owner,id,incarnationId),uptimeMilliseconds:42,generation:2,checkpointType:'Disabled'}];
  if(native.operation==='Get-VMHardDiskDrive')items=[{vmId,vmName,path:initial.diskPath,controllerType:'SCSI',controllerNumber:0,controllerLocation:0,diskNumber:null}];
  if(linux&&native.operation==='Get-VMNetworkAdapter'&&!native.managementSwitchName)items=[{vmId,vmName,name:'CCC Managed',switchId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',switchName:'CCC Device Lab',status:'Ok',managementOperatingSystem:false,macAddress:'021122334455',ipAddresses:['172.29.0.20']}];
  if(native.operation==='Get-VMDiagnostic')items=[{ok:true,vmId,vmName,state,uptimeMs:42,generation:2,secureBootEnabled:true,heartbeatEnabled:true,heartbeatPrimaryStatus:2,heartbeatSecondaryStatus:0,integrationServices:[],hardDiskCount:1,dvdCount:0,hardDiskControllers:['scsi'],bootDeviceTypes:['hard-disk'],bootEntries:[],hardDisks:[],dvdDrives:[],diagnosticComplete:true,diagnosticErrors:[]}];
  if(native.operation==='Invoke-Guest'){
   if(scenario.guestFailure)return{...command,status:1,stdout:JSON.stringify({schemaVersion:1,operation:native.operation,ok:false,errorCode:'powershell-direct-authentication-failed'}),stderr:'fixture-private-provider-output'};
   items=[{action:'job',output:JSON.stringify({computerName:'CCC-WIN',addresses:['172.29.0.20'],firstLogonCompleted:hyperv.ownershipMarker(owner,id,incarnationId),provisioningSecretsPresent:false})}];
  }
  return{...command,status:0,stdout:JSON.stringify({schemaVersion:1,operation:native.operation,ok:true,items}),stderr:''};
 };
 server=broker.createDeviceBrokerServer({cwd,host:'127.0.0.1',port:0,platform:hv?'win32':'linux',providerPaths:fixtureProviderPaths,commandRunner:runner,...(scenario.wallJump?{hyperVMonotonicNow:()=>{monotonicReads++;return monotonicNow;}}:{})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;
 const token=broker.deviceBrokerOwnerToken(owner);protectedSnapshot=snapshot();expected=[structuredClone(initial),structuredClone(other)];rpcActive=true;
 let outcome;try{outcome=await rpc('http://127.0.0.1:'+port,owner,scenario.auth==='missing'?undefined:scenario.auth==='wrong'?'not-the-owner-token':token,{backend:scenario.backend,command:scenario.command,deviceId:id,force:true,...(scenario.dryRun?{dryRun:true}:{}),...(hv?{bootTimeoutMs:1000}:physical?{}:{waitForBoot:false})});}finally{rpcActive=false;await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
 const after=snapshot(),lease=leaseFile&&raw.existsSync(leaseFile)?JSON.parse(raw.readFileSync(leaseFile,'utf8')):undefined;
 stableHome();if(ownedDescriptors.size)throw Error('fixture-owned file descriptors leaked');
 console.log(JSON.stringify({outcome,denied,ownIdentityObservations,initial,expected,unrelated:other,after,protectedSnapshot,injected,calls,ownerPublicationsAfterRace,temporaryOwnerWritesAfterRace,cancellationWrites,storageFaults,lease,initialExpiry,reconciledRecordAtSsh,fingerprint,publicationBuilderClockReads,monotonicReads,wallJumps,modules:[directory]}));
})().catch(error=>{console.log(JSON.stringify({fatal:String(error),stack:error.stack,denied,calls,mutations}));process.exitCode=1;});
`;

function executeCurrent(lens: "source" | "emitted", scenario: Scenario, expectedDenials = 0): Receipt {
    const root = mkdtempSync(join(tmpdir(), "ccc-lifecycle-state-race-"));
    const home = join(root, "home"); mkdirSync(home);
    const worker = join(root, "worker.cjs"), loader = join(root, "source-loader.mjs");
    writeFileSync(worker, WORKER, {mode: 0o400}); writeFileSync(loader, SOURCE_LOADER, {mode: 0o400});
    const settings = {project, home, lens, scenario, sourceFiles: [...sourceFiles], emittedFiles: [...emittedFiles]};
    const settingsFile = join(root, "fixture-input.json"); writeFileSync(settingsFile, JSON.stringify(settings), {mode: 0o400});
    const diagnostics = mkdtempSync(join(tmpdir(), "ccc-lifecycle-state-receipt-"));
    // Assertions in the caller run AFTER this function returns. Keep complete private output
    // until Vitest reports the final test result, so a later status assertion cannot erase it.
    onTestFinished(context => {
        if (context.task.result?.state === "pass") rmSync(diagnostics, {recursive: true, force: true});
        else console.error(`[lifecycle fixture failure diagnostics] ${diagnostics}`);
    });
    try {
        const output = spawnSync(process.execPath, [...(lens === "source" ? ["--experimental-loader", pathToFileURL(loader).href] : []), worker], {cwd: project, encoding: "utf8", timeout: 20000, maxBuffer: 2 * 1024 * 1024, env: {HOME: home, USERPROFILE: home, PATH: join(home, "fake"), CCC_LIFECYCLE_FIXTURE_FILE: settingsFile}});
        writeFileSync(join(diagnostics, "stdout.json"), output.stdout ?? "", {mode: 0o600});
        writeFileSync(join(diagnostics, "stderr.log"), output.stderr ?? "", {mode: 0o600});
        writeFileSync(join(diagnostics, "metadata.json"), JSON.stringify({lens, scenario, exit: output.status, signal: output.signal, error: output.error ? String(output.error) : null, fixtureHome: home, workerSha: createHash("sha256").update(WORKER).digest("hex"), loaderSha: createHash("sha256").update(SOURCE_LOADER).digest("hex"), sourceFiles: [...sourceFiles], emittedFiles: [...emittedFiles]}, null, 2), {mode: 0o600});
        expect(output.error).toBeUndefined(); expect(output.status, output.stdout + output.stderr).toBe(0);
        const observed = JSON.parse(output.stdout.trim()) as Receipt;
        // Includes actual public body, persisted/protected bytes and metadata, native/helper
        // calls and caught-denial counters. HOME's ordinary cleanup below remains unchanged.
        writeFileSync(join(diagnostics, "receipt.json"), JSON.stringify(observed, null, 2), {mode: 0o600});
        expect(observed.denied, "all denials count before potentially caught native errors").toHaveLength(expectedDenials);
        if (process.platform === "win32") {
            expect(observed.ownIdentityObservations).toBeGreaterThanOrEqual(1);
            expect(observed.ownIdentityObservations).toBeLessThanOrEqual(2);
        } else expect(observed.ownIdentityObservations).toBe(0);
        return observed;
    } finally { rmSync(root, {recursive: true, force: true}); }
}

const macRaces: Scenario[] = ["device_start", "device_stop", "device_delete"].flatMap(command => ["created", "runtime", "nested", "secret", "missing"].map(race => ({name: `Mac ${command} ${race}`, backend: "macos-vm", command, race, phase: "provider"} as Scenario)));
const hyperVRaces: Scenario[] = ["device_start", "device_reboot"].flatMap(command => [false, true].flatMap(guestFailure => ["created", "runtime", "incarnation", "missing"].map(race => ({name: `HyperV ${command} guestFailure=${guestFailure} ${race}`, backend: "windows-vm", command, race, guestFailure, phase: "provider"} as Scenario))));

describe.each(["source", "emitted"] as const)("actual authenticated %s broker lifecycle state transitions", lens => {
    it.each([-1, 1] as const)("preserves the successor generation through actual start/readiness with wall jump %s", wallJump => {
        const observed = executeCurrent(lens, {name: "monotonic generation fence", backend: "windows-vm", command: "device_start", phase: "provider", race: "incarnation", wallJump});
        expect(observed.monotonicReads).toBeGreaterThan(0);
        expect(observed.wallJumps).toBeGreaterThan(1);
        expect(observed.calls.some(call => call.operation === "Start-VM")).toBe(true);
        expect(observed.calls.some(call => call.operation === "Invoke-Guest")).toBe(true);
        expect(observed.outcome).toMatchObject({status: 409, body: {ok: false, error: "owner-device-state-conflict", found: true}});
        expect(observed.after).toEqual(observed.protectedSnapshot);
        expect(JSON.parse(observed.after.bytes).devices).toEqual(observed.expected);
        expect(observed.ownerPublicationsAfterRace).toBe(0);
        expect(observed.temporaryOwnerWritesAfterRace).toBe(0);
        expect(observed.publicationBuilderClockReads).toBe(0);
        for (const call of observed.calls.filter(call => call.operation)) {
            expect(Number.isInteger(call.timeoutMs)).toBe(true);
            expect(call.timeoutMs).toBeGreaterThan(0);
            expect(call.timeoutMs).toBeLessThanOrEqual(120_000);
        }
    });

    it.each(["plan", "dry-run", "status"] as const)("keeps readonly %s paths outside lifecycle publication", mode => {
        const observed = executeCurrent(lens, {name: "readonly gate", backend: "macos-vm", command: mode === "status" ? "device_status" : "device_start", planOnly: mode === "plan", dryRun: mode === "dry-run"});
        expect(observed.outcome.status).toBe(200); expect(observed.after).toEqual(observed.protectedSnapshot);
        expect(observed.ownerPublicationsAfterRace).toBe(0); expect(observed.temporaryOwnerWritesAfterRace).toBe(0);
        if (mode !== "status") expect(observed.calls).toEqual([]);
        expect(JSON.stringify(observed.outcome.body)).not.toContain("original-private-secret");
    });
    it.each([...macRaces, ...hyperVRaces])("refuses exact-record conflicts after real provider invocation: $name", scenario => {
        const observed = executeCurrent(lens, scenario), payload = observed.outcome.body;
        expect(observed.injected).toBe(true); expect(observed.calls.length).toBeGreaterThan(0);
        expect(observed.outcome.status).toBe(409);
        expect(payload).toMatchObject({ok: false, error: "owner-device-state-conflict", found: scenario.race !== "missing", result: {invoked: true, execution: {providerExecution: "executed"}}});
        expect(observed.after).toEqual(observed.protectedSnapshot);
        expect(JSON.parse(observed.after.bytes).devices).toEqual(observed.expected);
        expect(observed.ownerPublicationsAfterRace).toBe(0); expect(observed.temporaryOwnerWritesAfterRace).toBe(0);
        expect(observed.publicationBuilderClockReads, "replacement builder does not materialize a new updatedAt on refusal").toBe(0);
        expect(payload.result).not.toHaveProperty("leaseRollback");
        const publicBytes = JSON.stringify(payload);
        for (const secret of ["original-private-secret", "successor-private-secret", "fixture-private-provider-output", "guest.credential.xml"]) expect(publicBytes).not.toContain(secret);
        if (scenario.backend === "windows-vm") {
            expect(observed.calls.some(call => call.operation === (scenario.command === "device_reboot" ? "Restart-VM" : "Start-VM"))).toBe(true);
            expect(observed.calls.some(call => call.operation === "Invoke-Guest")).toBe(true);
            if (scenario.guestFailure) { expect(observed.calls.some(call => call.operation === "Get-VMDiagnostic")).toBe(true); expect(payload.providerFailure).toBe("hyper-v-guest-not-ready"); expect(payload.result?.boot).toBeDefined(); }
        }
    });
    it.each(["device_start", "device_stop", "device_delete"] as const)("preserves matched Mac behavior and unrelated-record edits: %s", command => {
        for (const race of [undefined, "unrelated"] as const) {
            const observed = executeCurrent(lens, {name: "matched Mac", backend: "macos-vm", command, race, phase: "provider"});
            expect(observed.outcome.status).toBe(200); expect(observed.outcome.body.ok).toBe(true);
            const devices = JSON.parse(observed.after.bytes).devices as Record<string, unknown>[];
            expect(devices.find(device => device.id === "unrelated")).toEqual({...observed.unrelated, ...(race ? {note: "concurrent-unrelated-edit"} : {})});
            const target = devices.find(device => device.id === "race");
            if (command === "device_delete") expect(target).toBeUndefined();
            else expect(target).toMatchObject({status: command === "device_start" ? "running" : "stopped", ssh: {password: "original-private-secret"}, preferences: {nested: {colour: "original"}}});
            expect(observed.ownerPublicationsAfterRace).toBeGreaterThan(0);
        }
    });
    it("captures the independent full persisted record before planning/redaction can rebaseline it", () => {
        const observed = executeCurrent(lens, {name: "before plan redaction", backend: "macos-vm", command: "device_start", phase: "plan", race: "secret"});
        expect(observed.injected).toBe(true); expect(observed.outcome.status).toBe(409);
        expect(observed.after).toEqual(observed.protectedSnapshot); expect(observed.ownerPublicationsAfterRace).toBe(0);
        expect(JSON.stringify(observed.outcome.body)).not.toContain("successor-private-secret");
    });
    it("advances expectation only after authorized auxiliary cleanup actually commits", () => {
        const observed = executeCurrent(lens, {name: "authorized cleanup", backend: "macos-vm", command: "device_stop", cleanup: true});
        expect(observed.outcome.status).toBe(200);
        expect(observed.outcome.body.result?.auxiliaryCleanup).toMatchObject({ok: true, changed: true, minimizeWatchdog: {cleared: true}});
        expect(JSON.parse(observed.after.bytes).devices.find((entry: {id: string}) => entry.id === "race")).toMatchObject({status: "stopped", minimizeWatchdog: null});
        expect(observed.cancellationWrites).toBe(1);
    });
    it.each(["created", "missing"] as const)("preserves successors between committed cleanup and final publication: %s", race => {
        const observed = executeCurrent(lens, {name: "after committed cleanup", backend: "macos-vm", command: "device_stop", cleanup: true, phase: "provider", race});
        expect(observed.outcome.status).toBe(409); expect(observed.after).toEqual(observed.protectedSnapshot);
        expect(observed.outcome.body.result?.auxiliaryCleanup).toMatchObject({ok: true, changed: true});
        expect(observed.ownerPublicationsAfterRace).toBe(0); expect(observed.calls).toHaveLength(1);
    });
    it("refuses a changed cleanup observation before cancellation/native effects", () => {
        const observed = executeCurrent(lens, {name: "cleanup gap", backend: "macos-vm", command: "device_stop", cleanup: true, phase: "before-cleanup", race: "created"});
        expect(observed.injected).toBe(true); expect(observed.outcome.status).toBe(502);
        expect(observed.outcome.body).toMatchObject({error: "auxiliary-runtime-cleanup-failed", result: {invoked: false, auxiliaryCleanup: {ok: false, changed: false, stateConflict: true}}});
        expect(observed.cancellationWrites).toBe(0); expect(observed.calls).toEqual([]); expect(observed.after).toEqual(observed.protectedSnapshot);
        expect(observed.ownerPublicationsAfterRace).toBe(0); expect(observed.temporaryOwnerWritesAfterRace).toBe(0);
        expect(observed.publicationBuilderClockReads).toBe(0);
    });
    it("does not report changed or advance expectation when cleanup publication finds disappearance", () => {
        const observed = executeCurrent(lens, {name: "cleanup disappeared", backend: "macos-vm", command: "device_stop", cleanup: true, phase: "cleanup-commit", race: "missing"});
        expect(observed.injected).toBe(true); expect(observed.outcome.status).toBe(502);
        expect(observed.outcome.body.result?.auxiliaryCleanup).toMatchObject({ok: false, changed: false, stateConflict: true, minimizeWatchdog: {cleared: true}});
        expect(observed.cancellationWrites).toBe(1); expect(observed.calls).toEqual([]); expect(observed.after).toEqual(observed.protectedSnapshot);
        expect(observed.ownerPublicationsAfterRace).toBe(0); expect(observed.temporaryOwnerWritesAfterRace).toBe(0);
    });
    it.each([false, true])("reaches the genuine Hyper-V reboot success/failure binding without a race: failure=%s", guestFailure => {
        const observed = executeCurrent(lens, {name: "real reboot binding", backend: "windows-vm", command: "device_reboot", guestFailure});
        expect(observed.calls.some(call => call.operation === "Restart-VM")).toBe(true); expect(observed.calls.some(call => call.operation === "Invoke-Guest")).toBe(true);
        expect(observed.outcome.status).toBe(guestFailure ? 502 : 200);
        const device = JSON.parse(observed.after.bytes).devices.find((entry: {id: string}) => entry.id === "race");
        expect(device).toMatchObject({status: "running", bootReady: !guestFailure});
        if (guestFailure) { expect(device.lastBootCheck.ready).toBe(false); expect(observed.calls.some(call => call.operation === "Get-VMDiagnostic")).toBe(true); }
    });
    it.each(["device_start", "device_reboot"] as const)("carries the actual committed Linux SSH record through successful and failed readiness: %s", command => {
        for (const guestFailure of [false, true]) {
            const observed = executeCurrent(lens, {name: "Linux own SSH reconciliation", backend: "linux-vm", command, guestFailure});
            expect(observed.calls.some(call => call.operation === (command === "device_reboot" ? "Restart-VM" : "Start-VM"))).toBe(true);
            expect(observed.calls.some(call => call.provider === "hyper-v-ssh")).toBe(true);
            expect(observed.reconciledRecordAtSsh).toMatchObject({sshHostKeyFingerprint: observed.fingerprint, sshHostKeySource: "authenticated-bootstrap"});
            expect(observed.initial.sshHostKeyFingerprint).not.toBe(observed.fingerprint);
            expect(observed.outcome.status).toBe(guestFailure ? 502 : 200);
            expect(observed.outcome.body.error).not.toBe("owner-device-state-conflict");
            const persisted = JSON.parse(observed.after.bytes).devices.find((entry: {id: string}) => entry.id === "race");
            expect(persisted).toMatchObject({sshHostKeyFingerprint: observed.fingerprint, sshHostKeySource: "authenticated-bootstrap", bootReady: !guestFailure});
            expect(observed.ownerPublicationsAfterRace).toBeGreaterThanOrEqual(2);
        }
    });
    it.each(["device_start", "device_reboot"].flatMap(command => [false, true].flatMap(guestFailure => ["before-ssh", "ssh-commit", "after-ssh"].flatMap(phase => ["created", "runtime", "missing"].map(race => ({command, phase, race, guestFailure} as Pick<Scenario, "command" | "phase" | "race" | "guestFailure">))))))("preserves the record across Linux reconciliation boundaries: $command failure=$guestFailure $phase $race", ({command, phase, race, guestFailure}) => {
        const observed = executeCurrent(lens, {name: "Linux SSH transition race", backend: "linux-vm", command, phase, race, guestFailure});
        expect(observed.injected).toBe(true); expect(observed.outcome.status).toBe(409);
        expect(observed.outcome.body).toMatchObject({ok: false, error: "owner-device-state-conflict", found: race !== "missing", result: {invoked: true}});
        expect(observed.after).toEqual(observed.protectedSnapshot);
        expect(JSON.parse(observed.after.bytes).devices).toEqual(observed.expected);
        expect(observed.ownerPublicationsAfterRace).toBe(0); expect(observed.temporaryOwnerWritesAfterRace).toBe(0);
        if (phase === "after-ssh") expect(observed.reconciledRecordAtSsh).toMatchObject({sshHostKeyFingerprint: observed.fingerprint, sshHostKeySource: "authenticated-bootstrap"});
        expect(JSON.stringify(observed.outcome.body)).not.toContain("original-private-secret");
    });
    it.each(["missing", "wrong"] as const)("rejects %s authentication before provider/state publication", auth => {
        const observed = executeCurrent(lens, {name: "auth refusal", backend: "macos-vm", command: "device_delete", auth});
        expect(observed.outcome).toMatchObject({status: 401, body: {ok: false, error: "invalid-owner-token"}});
        expect(observed.calls).toEqual([]); expect(observed.after).toEqual(observed.protectedSnapshot); expect(observed.ownerPublicationsAfterRace).toBe(0);
    });
    it("retains physical lease restoration for a genuine matched EIO publication fault", () => {
        const observed = executeCurrent(lens, {name: "physical write rescue", backend: "android-device", command: "device_stop", writeFault: true});
        expect(observed.storageFaults).toBe(1); expect(observed.outcome.status).toBe(500);
        expect(observed.outcome.body).toMatchObject({ok: false, error: "owner-state-write-failed", result: {leaseRollback: {attempted: true, ok: true}}});
        expect(observed.lease).toMatchObject({deviceId: "race", claimId: "fixture-claim", claimNonce: "fixture-nonce"});
        expect(Date.parse(String(observed.lease?.expiresAt))).toBeGreaterThan(Date.parse(observed.initialExpiry!));
        expect(JSON.parse(observed.after.bytes).devices.find((entry: {id: string}) => entry.id === "race")).toMatchObject({status: "attached", leaseClaimId: "fixture-claim", leaseClaimNonce: "fixture-nonce"});
    });
    it("keeps an ordinary physical CAS conflict out of genuine write-error lease rescue", () => {
        const observed = executeCurrent(lens, {name: "physical ordinary conflict", backend: "android-device", command: "device_stop", phase: "physical-release", race: "nested"});
        expect(observed.injected).toBe(true); expect(observed.outcome.status).toBe(409);
        expect(observed.outcome.body).toMatchObject({ok: false, error: "owner-device-state-conflict", found: true, result: {invoked: true}});
        expect(observed.outcome.body.result).not.toHaveProperty("leaseRollback");
        expect(observed.storageFaults).toBe(0); expect(observed.lease).toBeUndefined();
        expect(observed.after).toEqual(observed.protectedSnapshot); expect(observed.ownerPublicationsAfterRace).toBe(0);
    });
    it("retains normal authenticated physical detach through the shared auxiliary-cleanup caller", () => {
        const observed = executeCurrent(lens, {name: "normal physical detach caller", backend: "android-device", command: "device_stop", cleanup: true, detach: true});
        expect(observed.outcome.status).toBe(200);
        expect(observed.outcome.body).toMatchObject({ok: true, result: {detached: "race", physicalDevicePoweredOff: false}});
        expect(observed.cancellationWrites).toBe(1); expect(observed.calls).toEqual([]); expect(observed.lease).toBeUndefined();
        const devices = JSON.parse(observed.after.bytes).devices as Record<string, unknown>[];
        // Frozen ORIGINAL physical detach deletes the owned inventory record.
        expect(devices.find(entry => entry.id === "race")).toBeUndefined();
        expect(devices).toEqual([observed.unrelated]);
        expect(observed.storageFaults).toBe(0);
    });
});
