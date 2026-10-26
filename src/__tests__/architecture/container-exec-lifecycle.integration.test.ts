import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";

const compositionUrl = new URL("../../../dist/composition/container-exec.js", import.meta.url).href;
const sessionUrl = new URL("../../../dist/session.js", import.meta.url).href;
const dockerUrl = new URL("../../../dist/docker.js", import.meta.url).href;
const applicationUrl = new URL("../../../dist/application/container-exec.js", import.meta.url).href;
const cleanupApplicationUrl = new URL("../../../dist/application/session-cleanup.js", import.meta.url).href;
const runtimeUrl = new URL("../../../dist/container-runtime.js", import.meta.url).href;
const invocationPortUrl = new URL("../../../dist/ports/container-runtime-invocation.js", import.meta.url).href;
const bindAuthorityUrl = new URL("../../../dist/adapters/runtime-bind-authority.js", import.meta.url).href;

it("native exec lifecycle acquisition yields to the real owner's timer and enters only after release", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-exec-lifecycle-"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
const {withContainerLifecycleLockAsync} = await import(${JSON.stringify(sessionUrl)});
const {createNativeContainerExecPorts} = await import(${JSON.stringify(compositionUrl)});
const {withProjectContainerStateLockAsync} = await import(${JSON.stringify(dockerUrl)});
const {createContainerExec} = await import(${JSON.stringify(applicationUrl)});
const {_setRuntimeInvocationForTest} = await import(${JSON.stringify(runtimeUrl)});
const {NATIVE_RUNTIME_SELECTOR_KEYS} = await import(${JSON.stringify(invocationPortUrl)});
const {prepareRuntimeBindHome, withRuntimeBindGuard} = await import(${JSON.stringify(bindAuthorityUrl)});
const homePreparation = prepareRuntimeBindHome(${JSON.stringify(join(root, ".ccc"))});
withRuntimeBindGuard(homePreparation, () => {});
// The real lock ports may enter native operation scope. This fixture supplies
// all process effects below, so unexpected dispatch cannot reach a host runtime.
_setRuntimeInvocationForTest({version: 1, runtime: 'docker', executable: ${JSON.stringify(join(root, "unexpected-native-cli"))},
 transport: {kind: 'docker', host: 'unix:///fixture/lock-only.sock', configDirectory: ${JSON.stringify(join(root, "native-config"))},
 tls: {enabled: false, verify: false, caFile: null, certFile: null, keyFile: null}},
 selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null]))});
const ports = createNativeContainerExecPorts({
  ensureDirectories() { throw new Error('unexpected directories callback'); },
  async ensureProjectTools() { throw new Error('unexpected project callback'); },
  assetDirectory: ${JSON.stringify(root)}, trustedCliPath: ${JSON.stringify(join(root, "unused-cli"))}
});
let entered;
const owned = new Promise(resolve => { entered = resolve; });
let release;
const gate = new Promise(resolve => { release = resolve; });
let ownerReleased = false, timerRan = false, waiterEntered = false;
const owner = withProjectContainerStateLockAsync(async () => {
  entered(); await gate; ownerReleased = true;
});
await owned;
// A globally blocked composed startup must leave the target lifecycle available.
let competingEntered = false;
let prepared;
const preparedGate = new Promise(resolve => { prepared = resolve; });
const noop = () => {};
Object.assign(ports, {
 ensureRuntime: noop, resolveProject: () => '/project/repo', ensureDirectories: noop,
 ensureProjectTools: async () => {}, projectId: () => 'isolated-exec', debugEnabled: () => false,
 terminalReady: () => false, runtime: () => 'docker', tool: () => undefined,
 isWorktreeWorkspace: () => false, familyLock: async (_id, operation) => operation(),
 acquireOwnership: async () => ({lockFile: '/owned/session.lock', existingId: 'pinned-id'}),
 inspectSessionContainer: () => ({known: true, containerId: 'pinned-id'}),
 verifyStoppedSessionContainerForReplacement: () => false,
 ensureClipboard: async () => null, validateClipboard: async selected => selected,
 clipboardPortFile: () => '/owned/clipboard.port', clipboardConnection: () => ({}),
 worktreeMounts: () => [], containerName: () => 'ccc-isolated-exec',
 containerStatus: () => ({exists: true, running: true, containerId: 'pinned-id', imageId: 'image'}),
 sessionClaims: () => ['session.lock'], lockName: () => 'session.lock', prepareDeviceBroker: async () => {},
 prepareContainer: () => { prepared(); return {start: (...args) => {
   if (!timerRan || !ownerReleased) throw new Error('startup preceded release');
   waiterEntered = true; args[7]('pinned-id', {startedByInvocation: false}); return 'ccc-isolated-exec';
 }, initialize: noop}; },
 beginSessionStartupInHeldLifecycleLock: noop, recordSessionOwnStartInHeldLifecycleLock: noop,
 publishSessionReadyInHeldLifecycleLock: noop, setCleanupEnabled: noop, confirmOwnership: async () => {},
 configLock: operation => operation(), restoreConfig: noop, buildMcpConfig: async () => [],
 containerRunning: () => true, syncClipboard: noop, ensureSocketAccess: noop,
 attachClipboardImage: async (_path, args) => ({args}), startClipboardBridge: noop,
 observeCommandEnvironment: () => ({forwarded: [], skippedKeys: [], containerMarker: ['container', 'docker'], hostLangPresent: true}),
 prepareCommand: () => 'artifact', launchCommand: async () => 0, disposeCommand: noop,
 reportConversationFiles: noop, cleanupSession: noop, report: noop,
 setupFailure: cause => new Error('setup failed', {cause}), isRestartRequired: () => false
});
const waiter = createContainerExec(ports).exec('/repo', ['printf']);
await preparedGate;
// Let the application proceed from preparation into its real mutation acquisition.
await new Promise(resolve => setTimeout(resolve, 10));
await Promise.race([
 withContainerLifecycleLockAsync('isolated-exec', () => { competingEntered = true; }),
 new Promise((_resolve, reject) => setTimeout(() => reject(new Error('target lifecycle occupied during global wait')), 1000))
]);
if (!competingEntered || waiterEntered) throw new Error('global wait occupied target lifecycle');
setTimeout(() => {
  if (waiterEntered) throw new Error('waiter entered before owner release');
  timerRan = true; release();
}, 30);
const result = await waiter;
await owner;
console.log(JSON.stringify({result, timerRan, ownerReleased, waiterEntered}));
`], {cwd: root, env: {...process.env, HOME: root, USERPROFILE: root, CCC_HOME: undefined, CCC_PROFILE: undefined}, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const completed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
    });
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
        expect(await completed, stderr).toBe(0);
        expect(JSON.parse(stdout.trim())).toEqual({result: 0, timerRan: true, ownerReleased: true, waiterEntered: true});
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await completed.catch(() => undefined);
        rmSync(root, {recursive: true, force: true});
    }
}, 20000);

it.each(["reused", "owned", "stop-retry"] as const)("emitted library startup failure owns real session cleanup for %s", async scenario => {
    const root = mkdtempSync(join(tmpdir(), "ccc-exec-library-cleanup-"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import {existsSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const {createContainerExec} = await import(${JSON.stringify(applicationUrl)});
const {createSessionCleanup} = await import(${JSON.stringify(cleanupApplicationUrl)});
const root = ${JSON.stringify(root)}, scenario = ${JSON.stringify(scenario)};
const reused = scenario === 'reused', retries = scenario === 'stop-retry';
const claim = join(root, 'owned-session.lock'), unrelated = join(root, 'unrelated-receipt');
writeFileSync(unrelated, 'preserve this receipt');
const target = reused ? 'reused-exact-id' : 'started-exact-id';
const startupFailure = new Error('initialization failed');
const stopFailure = new Error('stop failed');
const wrapped = new Error('Container setup failed', {cause: startupFailure});
const events = [], targets = [], permissions = [];
let stopAttempts = 0, removals = 0, commandCalls = 0, restoreCalls = 0, disposalCalls = 0;
// The two emitted applications and the on-disk claim are real. Runtime, device,
// guard and process leaves are explicit fakes; no provider or container is used.
const cleanup = createSessionCleanup({
 projectId: () => 'isolated-library',
 withLifecycleLock(prefix, operation) {
   if (prefix !== 'isolated-library') throw new Error('wrong cleanup family');
   events.push('cleanup-guard'); return operation();
 },
 peerVetoes(prefix, ownPath, pinnedId) {
   if (prefix !== 'isolated-library' || ownPath !== claim || pinnedId !== target) throw new Error('wrong owned cleanup target');
   return {sharedDeviceCleanupBlocked: false, exactContainerStopBlocked: false, responsibilityTransferred: false};
 },
 removeClaim(path, settlement) {
   if (path !== claim) throw new Error('unrelated claim removal');
   if (settlement.containerId !== target || settlement.cleanupEnabled !== !reused
     || settlement.containerStopped !== !reused || settlement.responsibilityTransferred) throw new Error('wrong cleanup settlement');
   events.push('remove-claim'); removals++; rmSync(path); return undefined;
 },
 cleanupDevices(path, timeout, profile) {
   if (path !== '/project/library-repo' || timeout !== 5000 || profile !== undefined) throw new Error('wrong device cleanup context');
   events.push('devices'); return {stopped: 1, skipped: 0, failed: 0};
 },
 reportDeviceCleanupFailure(report) { throw report.kind === 'exception' ? report.error : new Error('unexpected failed device rows'); },
 stopContainer(readTarget) {
   const id = readTarget(); targets.push(id); stopAttempts++; events.push('stop');
   if (id !== target) throw new Error('stopped a different container');
   if (retries && stopAttempts === 1) throw stopFailure;
   return undefined;
 }
});
const noop = () => {};
const unexpected = () => { throw new Error('unexpected post-startup operation'); };
const ports = {
 ensureRuntime: noop, resolveProject: () => '/project/library-repo', ensureDirectories: noop,
 ensureProjectTools: async () => {}, projectId: () => 'isolated-library', debugEnabled: () => false,
 terminalReady: () => false, runtime: () => 'docker', tool: () => undefined,
 defaultTool: () => ({name: 'codex'}), isWorktreeWorkspace: () => false, assertWorkspace: unexpected,
 familyLock: async (_id, operation) => operation(),
 async acquireOwnership() {
   writeFileSync(claim, 'owned claim');
   cleanup.setSession(claim, '/project/library-repo', undefined, 'command');
   cleanup.setSessionCleanupEnabled(false);
   if (reused) cleanup.setSessionContainerId(target);
   return {lockFile: claim, existingId: reused ? target : null};
 },
 inspectSessionContainer: () => ({known: true, containerId: reused ? target : null}),
 verifyStoppedSessionContainerForReplacement: () => false,
 ensureClipboard: async () => null, validateClipboard: async selected => selected,
 clipboardPortFile: () => join(root, 'clipboard.port'), clipboardConnection: () => ({}),
 worktreeMounts: () => [], containerName: () => 'ccc-isolated-library',
 containerStatus: () => ({exists: true, running: reused, containerId: target, imageId: 'fake-image'}),
 sessionClaims: () => ['owned-session.lock'], lockName: () => 'owned-session.lock', prepareDeviceBroker: async () => {},
 stateLock: async operation => operation(), lifecycleLock: async (_prefix, operation) => operation(),
 setupLock: async (_prefix, operation) => operation(),
 prepareContainer: () => ({
   start(...args) {
     if (!reused) { args[11]?.(); args[9](target); }
     args[7](target, {startedByInvocation: !reused}); return 'ccc-isolated-library';
   },
   initialize(id) { if (id !== target) throw new Error('wrong initialized target'); throw startupFailure; }
 }),
 startContainer: unexpected,
 beginSessionStartupInHeldLifecycleLock() { cleanup.setSessionCleanupEnabled(false); },
 recordSessionOwnStartInHeldLifecycleLock(id) {
   cleanup.setSessionContainerId(id); permissions.push(true); cleanup.setSessionCleanupEnabled(true);
 },
 publishSessionReadyInHeldLifecycleLock(id, handoff) {
   cleanup.setSessionContainerId(id); permissions.push(handoff.startedByInvocation);
   cleanup.setSessionCleanupEnabled(handoff.startedByInvocation);
 },
 setCleanupEnabled(enabled) { permissions.push(enabled); cleanup.setSessionCleanupEnabled(enabled); },
 confirmOwnership: async () => {}, configLock: operation => operation(),
 restoreConfig() { restoreCalls++; }, ensureUv: unexpected, buildMcpConfig: unexpected, setupProxy: unexpected,
 containerRunning: unexpected, installTools: unexpected, ensureClaude: unexpected,
 prepareCodexConfig: unexpected, assertCodexState: unexpected, ensureCodexHarness: unexpected,
 syncClipboard: unexpected, ensureSocketAccess: unexpected, isRestartRequired: () => false,
 attachClipboardImage: unexpected, installProjectTools: unexpected, startClipboardBridge: unexpected,
 observeCommandEnvironment: unexpected, prepareCommand: unexpected, prepareCodexCommand: unexpected,
 launchCommand() { commandCalls++; return Promise.resolve(99); },
 disposeCommand() { disposalCalls++; }, reportConversationFiles: unexpected,
 setupFailure(cause) { if (cause !== startupFailure) throw new Error('lost startup cause'); return wrapped; },
 setupToolFailure: unexpected, handoffFailure: unexpected, invalidRuntimeFailure: unexpected,
 cleanupSession: () => { void cleanup.cleanupSession(); }, report: noop
};
let error, rejected = false;
try { await createContainerExec(ports).exec('/repo', ['printf']); }
catch (caught) { rejected = true; error = caught; }
const first = {
 rejected, claimExists: existsSync(claim), retained: cleanup.getCurrentSession().lockFile === claim,
 stopAttempts, removals,
 preservesPrimary: retries
   ? error instanceof AggregateError && error.errors.length === 2 && error.errors[0] === wrapped && error.cause === wrapped
   : error === wrapped,
 preservesStop: !retries || (error instanceof AggregateError && error.errors[1] === stopFailure)
};
const beforeFallback = events.length;
cleanup.cleanupSession();
const afterFallback = events.length;
cleanup.cleanupSession();
console.log(JSON.stringify({
 first, stopAttempts, targets, removals, permissions, events,
 fallbackEffects: afterFallback - beforeFallback,
 repeatedFallbackEffects: events.length - afterFallback,
 claimExists: existsSync(claim), cleared: cleanup.getCurrentSession().lockFile === null,
 unrelated: readFileSync(unrelated, 'utf8'), commandCalls, restoreCalls, disposalCalls
}));
`], {cwd: root, env: {...process.env, HOME: root, USERPROFILE: root, CCC_HOME: undefined, CCC_PROFILE: undefined}, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); });
    child.stderr.on("data", data => { stderr += String(data); });
    const completed = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject); child.once("close", resolve);
    });
    const timeout = setTimeout(() => child.kill(), 15000);
    try {
        expect(await completed, stderr).toBe(0);
        const retry = scenario === "stop-retry", reused = scenario === "reused";
        const target = reused ? "reused-exact-id" : "started-exact-id";
        expect(JSON.parse(stdout.trim())).toEqual({
            first: {
                rejected: true, claimExists: retry, retained: retry,
                stopAttempts: reused ? 0 : 1, removals: retry ? 0 : 1,
                preservesPrimary: true, preservesStop: true,
            },
            stopAttempts: reused ? 0 : retry ? 2 : 1,
            targets: reused ? [] : retry ? [target, target] : [target],
            removals: 1, permissions: reused ? [false] : [true, true],
            events: reused ? ["cleanup-guard", "remove-claim"]
                : retry ? ["cleanup-guard", "devices", "stop", "cleanup-guard", "devices", "stop", "remove-claim"]
                : ["cleanup-guard", "devices", "stop", "remove-claim"],
            fallbackEffects: retry ? 4 : 0, repeatedFallbackEffects: 0,
            claimExists: false, cleared: true, unrelated: "preserve this receipt",
            commandCalls: 0, restoreCalls: 0, disposalCalls: 0,
        });
    } finally {
        clearTimeout(timeout);
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await completed.catch(() => undefined);
        rmSync(root, {recursive: true, force: true});
    }
}, 20000);


it.each(["preflight-refusal", "uncertain-mutation", "stopped-upgrade", "retry-target-missing", "retained-join", "retained-stopped", "retained-provisional", "retained-timeout", "retained-live-proof", "retained-ack-failure", "retained-retry-changed", "retained-changed", "retained-postack-changed"] as const)("composed native session retires only qualified startup responsibility: %s", async scenario => {
    const root = mkdtempSync(join(tmpdir(), "ccc-exec-native-retirement-"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {basename,join} from 'node:path';
const root=${JSON.stringify(root)}, scenario=${JSON.stringify(scenario)}, project=join(root,'project');
mkdirSync(project);
writeFileSync(join(project,'untracked.txt'),'uncommitted work\\n');
const oldId='a'.repeat(64), nextId='b'.repeat(64), helperId='c'.repeat(64), image='sha256:'+'d'.repeat(64);
const executable=join(root,'private-runtime'), originalSpawn=cp.spawnSync, effects=[];
let removed=false, stopped=false, projectId, markerRead=false;
const retryScenario=scenario==='retry-target-missing', retainedScenario=scenario.startsWith('retained-');
const retainedStopped=['retained-stopped','retained-provisional','retained-timeout','retained-live-proof','retained-ack-failure','retained-retry-changed'].includes(scenario);
const retainedSuccess=['retained-join','retained-stopped','retained-provisional'].includes(scenario);
let targetRunning=retainedScenario&&!retainedStopped, exactStarts=0, retainedAttempts=0, retryTargetChanged=false;
const retainedFiles=[], cleanupFlags=[];let projectFingerprint, commandLaunched=false, falseAckAtLaunch=false, warningShown=false, falseAckBeforeFailure=false;
let externallyRemoved=false, retryStarts=0, secondDispatches=0, expectedAtRetry, ownTargetAtRetry=false;
cp.spawnSync=(command,argv,options)=>{
 if(command!==executable) return originalSpawn(command,argv,options);
 const offset=argv.indexOf('--tlskey=')+1, args=argv.slice(offset);
 effects.push(args[0]);
 if(args[0]==='ps') return {status:0,stdout:retryScenario&&externallyRemoved?'':(removed?nextId:oldId)+'\\n'};
 if(args[0]==='inspect'&&args.includes('{{.Id}}')) return {status:0,stdout:image};
 if(args[0]==='inspect') return {status:0,stdout:JSON.stringify({Id:retryTargetChanged?nextId:oldId,Image:'sha256:'+'e'.repeat(64),State:{Running:targetRunning},
   Config:{Labels:{'ccc.managed':'true','ccc.project.path':project,...(retainedScenario&&scenario!=='retained-provisional'?{'ccc.project.mount-identity':projectFingerprint}:{})}},
   Mounts:[{Type:'bind',Source:project,Destination:'/project/'+projectId,RW:true}]})};
 if(args[0]==='start') {
   assert.equal(retainedStopped,true); assert.deepEqual(args,['start',oldId]); assert.equal(targetRunning,false); exactStarts++;
   if(scenario==='retained-timeout')return {status:null,error:Object.assign(new Error('controlled existing-target start timeout'),{code:'ETIMEDOUT'})};
   targetRunning=true;return {status:0,stdout:oldId};
 }
 if(args[0]==='cp') return {status:1,stdout:'',stderr:'stopped copy unsupported'};
 if(args[0]==='run') {
   if(retryScenario){secondDispatches++;return {status:null,error:Object.assign(new Error('new target creation timed out'),{code:'ETIMEDOUT'})};}
   assert.ok(args.includes('--volumes-from')); assert.equal(args[args.indexOf('--volumes-from')+1],oldId+':ro');
   assert.equal(args[args.indexOf('--entrypoint')+1],'/usr/bin/cat'); assert.ok(args.includes(image));
   writeFileSync(args[args.indexOf('--cidfile')+1],helperId);
   markerRead=true; return {status:0,stdout:readFileSync(join(project,basename(args.at(-1))),'utf8')};
 }
 if(args[0]==='rm') {assert.deepEqual(args,['rm',oldId]); removed=true; return {status:0};}
 if(args[0]==='stop') {assert.deepEqual(args,['stop',nextId]); stopped=true; return {status:0};}
 if(args[0]==='--version') return {status:0,stdout:'Docker version 27.1.1\\n'};
 if(args[0]==='info') return {status:0,stdout:args.includes('{{json .SecurityOptions}}')?'[]\\n':'Linux\\n'};
 throw new Error('unexpected private runtime operation: '+args[0]);
};
syncBuiltinESMExports();
const runtime=await import(${JSON.stringify(runtimeUrl)});
const {NATIVE_RUNTIME_SELECTOR_KEYS}=await import(${JSON.stringify(invocationPortUrl)});
runtime._setRuntimeInfoForTest({runtime:'docker'});
runtime._setRuntimeInvocationForTest({version:1,runtime:'docker',executable,
 transport:{kind:'docker',host:'unix:///fixture/native-retirement.sock',configDirectory:join(root,'config'),
 tls:{enabled:false,verify:false,caFile:null,certFile:null,keyFile:null}},
 selectors:Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key=>[key,null]))});
const {prepareRuntimeBindHome,withRuntimeBindGuard}=await import(${JSON.stringify(bindAuthorityUrl)});
const preparedHome=prepareRuntimeBindHome(join(root,'.ccc')); withRuntimeBindGuard(preparedHome,()=>{});
const session=await import(${JSON.stringify(sessionUrl)});
const docker=await import(${JSON.stringify(dockerUrl)});
const {createContainerExec}=await import(${JSON.stringify(applicationUrl)});
const {createContainerExistingLifecycle}=await import(new URL('./application/container-existing-lifecycle.js',${JSON.stringify(sessionUrl)}));
const {createNativeContainerExecPorts}=await import(${JSON.stringify(compositionUrl)});
const {getProjectId}=await import(new URL('./utils.js',${JSON.stringify(sessionUrl)}));
const {captureNativeSessionOwnership}=await import(new URL('./adapters/session-ownership.js',${JSON.stringify(sessionUrl)}));
const {createNativeSessionClaimObservationStore}=await import(new URL('./adapters/session-claim-observation.js',${JSON.stringify(sessionUrl)}));
projectId=getProjectId(project);
const store=createNativeSessionClaimObservationStore();
if(retainedScenario){
 const {locksDir}=await import(new URL('./home-layout.js',${JSON.stringify(sessionUrl)}));
 const {encodeSessionClaim}=await import(new URL('./domain/session-claims.js',${JSON.stringify(sessionUrl)}));
 const {captureBindMountSourceIdentity,bindMountSourceIdentityDigest}=await import(new URL('./adapters/container-mount-observations.js',${JSON.stringify(sessionUrl)}));
 projectFingerprint=bindMountSourceIdentityDigest(captureBindMountSourceIdentity(project));
 mkdirSync(locksDir(),{recursive:true,mode:0o700});
 session.withContainerLifecycleLock(projectId,()=>{
   for(let index=0;index<2;index++){
     const deadOwner=2000000000+index,deadGuardian=2000000010+index;
     for(const pid of [deadOwner,deadGuardian]){try{process.kill(pid,0);throw new Error('fixture PID unexpectedly exists');}catch(error){if(error.code!=='ESRCH')throw error;}}
     const path=join(locksDir(),projectId+'--retained-'+index+'.lock'),generation='retained-generation-'+index;
     writeFileSync(path,encodeSessionClaim(deadOwner,'retained-owner-'+index,'monitored'),{mode:0o600,flag:'wx'});
     let old=store.begin({receipt:captureNativeSessionOwnership(path),binding:{lockFile:path,projectPath:project,prefix:projectId},
       runtimeInvocation:runtime.getRuntimeInvocation(),guardian:{pid:deadGuardian,startToken:'retained-guardian-'+index},generation});
     old=store.update(old,{...old.observation,pending:{kind:'startup',generation,sequence:1,containerId:null,cleanupEnabled:true}});
     for(const entry of [path,path+'.guardian.json',path+'.runtime.json']){
       const stat=lstatSync(entry);retainedFiles.push({path:entry,bytes:readFileSync(entry,'utf8'),ino:stat.ino,dev:stat.dev});
     }
   }
 });
}
const ports=createNativeContainerExecPorts({ensureDirectories(){},ensureProjectTools:async()=>{},assetDirectory:root,trustedCliPath:join(root,'unused-cli')});
const noop=()=>{}, primary=new Error('controlled startup refusal');
let claim, guardian, mutationIntents=0;
const acquire=ports.acquireOwnership, begin=ports.beginSessionStartupInHeldLifecycleLock, setCleanup=ports.setCleanupEnabled, confirm=ports.confirmOwnership;
Object.assign(ports,{
 ensureRuntime:noop,resolveProject:()=>project,ensureDirectories:noop,ensureProjectTools:async()=>{},debugEnabled:()=>false,
 terminalReady:()=>false,tool:()=>undefined,isWorktreeWorkspace:()=>false,
 ensureClipboard:async()=>null,validateClipboard:async selected=>selected,worktreeMounts:()=>[],prepareDeviceBroker:async()=>{},
 containerName:()=> 'fixture-project',containerStatus:()=>retainedScenario?{exists:true,running:targetRunning,containerId:scenario==='retained-changed'||retryTargetChanged?nextId:oldId,imageId:'current-image'}:retryScenario?{exists:false,running:false,containerId:null,imageId:null}:{exists:true,running:false,containerId:oldId,imageId:'old-image'},
 inspectSessionContainer:scenario==='stopped-upgrade'||retainedScenario?(...args)=>{
   const inspected=docker.inspectSessionContainerOwnership(...args);
   if(scenario==='retained-postack-changed'){
     const currentPath=session.getCurrentSession().lockFile;
     const observed=currentPath?store.read(captureNativeSessionOwnership(currentPath),{prefix:projectId}):null;
     if(observed?.observation.lastAcknowledged?.containerId===oldId&&observed.observation.lastAcknowledged.cleanupEnabled===false){
       claim=currentPath;guardian=observed.observation.guardian.pid;falseAckBeforeFailure=true;
       return {...inspected,containerId:nextId};
     }
   }
   return inspected;
 }:()=>({known:true,containerId:retryScenario?null:oldId,running:false}),
 async acquireOwnership(...args){
   const result=await acquire(...args); claim=result.lockFile;
   const snapshot=store.read(captureNativeSessionOwnership(claim),{prefix:projectId});
   assert.ok(snapshot); assert.equal(snapshot.observation.pending,null); guardian=snapshot.observation.guardian.pid;
   if(scenario==='stopped-upgrade') assert.equal(result.requiresLiveVerification,true);
   if(retainedScenario){assert.equal(result.existingOnly,true);assert.equal(result.existingId,oldId);assert.equal(snapshot.observation.lastAcknowledged.cleanupEnabled,false);
     if(retainedStopped){assert.equal(targetRunning,false);if(scenario==='retained-provisional')assert.equal(result.requiresLiveVerification,true);}}
   return result;
 },
 beginSessionStartupInHeldLifecycleLock(){mutationIntents++;begin();},
 setCleanupEnabled(enabled){cleanupFlags.push(enabled);setCleanup(enabled);},
 prepareContainer:policy=>{if(retainedScenario)assert.deepEqual(policy,{existingContainerId:oldId});else assert.equal(policy,undefined);return {start(...args){
   if(retainedScenario){
     retainedAttempts++;assert.equal(args[8],oldId);assert.equal(args[6](()=>{throw new Error('restricted replacement was dispatched');}),false);
     if(retainedAttempts===2){assert.equal(scenario,'retained-retry-changed');assert.equal(retryTargetChanged,true);throw new Error('controlled retained retry target changed');}
     if(retainedStopped){
       const started=runtime.runtimeSpawnSync(['start',oldId],{encoding:'utf8',timeout:1});
       if(started.error)throw started.error;
       assert.equal(started.status,0);assert.equal(targetRunning,true);
       if(scenario==='retained-live-proof')throw new Error('controlled live contract proof failed');
     }
     args[7](oldId,{startedByInvocation:false});return 'fixture-project';
   }
   if(retryScenario) {
     if(++retryStarts===1){args[11]();args[9](oldId);args[7](oldId,{startedByInvocation:true});return 'fixture-project';}
     expectedAtRetry=args[8];
     const beforeRetry=store.read(captureNativeSessionOwnership(claim),{prefix:projectId});
     ownTargetAtRetry=beforeRetry?.observation.ownStarted?.containerId===oldId
       &&beforeRetry.observation.lastAcknowledged?.containerId===oldId
       &&beforeRetry.observation.lastAcknowledged.cleanupEnabled===true
       &&beforeRetry.observation.pending===null;
     const unexpected=()=>{throw new Error('retry reached a forbidden existing-container effect');};
     const lifecycle=createContainerExistingLifecycle({
       listContainer:()=>({known:true,containerId:null}),isRunning:()=>false,
       identity:unexpected,managedIdentity:unexpected,assertProjectSources:unexpected,
       assertDeviceSources:unexpected,assertFilesystemSources:unexpected,inspectContract:unexpected,
       verifyBeforeSetup:unexpected,safeToDefer:unexpected,canExec:unexpected,canExecAfterBriefRetry:unexpected,
       deviceSourcesMatch:unexpected,syncMcp:unexpected,fixSsh:unexpected,syncGit:unexpected,
       start:unexpected,stop:unexpected,remove:unexpected,reportContractMismatch:unexpected,
       reportContractMatch:unexpected,reportRestart:unexpected,reportRecreation:unexpected,
       reportDeferred:unexpected,throwUnsafeDefer:unexpected,finish:unexpected,
     });
     assert.deepEqual(lifecycle.run({containerName:'fixture-project',initiallyRunningContainerId:args[8],replacementGuard:args[6]}),{kind:'continue-to-create'});
     runtime.runtimeSpawnSync(['run','--name','unexpected-retry-target'],{encoding:'utf8',timeout:1});
     throw new Error('retry creation dispatched without its previous target');
   }
   if(scenario==='stopped-upgrade') {
     assert.equal(args[6](()=>{args[11]();runtime.runtimeSpawnSync(['rm',oldId],{encoding:'utf8',timeout:30000});}),true);
     args[11](); args[9](nextId); args[7](nextId,{startedByInvocation:true}); return 'fixture-project';
   }
   if(scenario==='uncertain-mutation'){args[11]();args[11]();}
   throw primary;
 },initialize(){
   if(retainedScenario){
     assert.equal(targetRunning,true);
     const current=store.read(captureNativeSessionOwnership(claim),{prefix:projectId});assert.ok(current);
     assert.equal(current.observation.pending,null);assert.equal(current.observation.ownStarted,null);
     assert.equal(current.observation.lastAcknowledged.containerId,oldId);assert.equal(current.observation.lastAcknowledged.cleanupEnabled,false);
   }else if(!retryScenario)throw primary;
 }};},
 setupFailure:cause=>new Error('Container setup failed',{cause}),isRestartRequired:()=>false,report:event=>{if(event.kind==='recovery-retained')warningShown=true;},
});
if(retryScenario) Object.assign(ports,{
 configLock:operation=>operation(),restoreConfig:noop,ensureUv:noop,setupProxy:noop,
 buildMcpConfig:async()=>{await Promise.resolve();externallyRemoved=true;return [];},
 containerRunning:()=>!externallyRemoved,
});
if(retainedScenario) Object.assign(ports,{
 configLock:operation=>operation(),restoreConfig:noop,ensureUv:noop,setupProxy:noop,installProjectTools:noop,
 buildMcpConfig:async()=>{if(scenario==='retained-retry-changed'){targetRunning=false;retryTargetChanged=true;}return [];},containerRunning:()=>targetRunning,
 installTools:noop,
 syncClipboard:noop,ensureSocketAccess:noop,startClipboardBridge:noop,
 async confirmOwnership(){await confirm();if(scenario==='retained-ack-failure')throw new Error('controlled disabled acknowledgement observation failed');},
 observeCommandEnvironment:()=>({forwarded:[],skippedKeys:[],containerMarker:['container','docker'],hostLangPresent:true}),
 prepareCommand:intent=>{assert.equal(intent.target,oldId);return Symbol('private command');},
 prepareCodexCommand:()=>({ok:true}),disposeCommand:noop,
 launchCommand:async()=>{
   const current=store.read(captureNativeSessionOwnership(claim),{prefix:projectId});assert.ok(current);
   falseAckAtLaunch=current.observation.lastAcknowledged?.containerId===oldId
     &&current.observation.lastAcknowledged.cleanupEnabled===false&&current.observation.ownStarted===null&&current.observation.pending===null;
   assert.equal(falseAckAtLaunch,true);assert.ok(cleanupFlags.every(enabled=>enabled===false));commandLaunched=true;return 17;
 },
});
let error,status;
try {status=await createContainerExec(ports).exec(project,['printf']);} catch(cause){error=cause;}
if(retainedScenario&&retainedSuccess){assert.equal(error,undefined);assert.equal(status,17);}else assert.ok(error);
const snapshot=existsSync(claim)?store.read(captureNativeSessionOwnership(claim),{prefix:projectId}):null;
const retained=snapshot!==null, pending=snapshot?.observation.pending?.kind??null;
if(retainedScenario){
 if(retainedSuccess){assert.equal(commandLaunched,true);assert.equal(falseAckAtLaunch,true);assert.equal(warningShown,true);}
 else {assert.ok(!(error instanceof AggregateError));
   const expected=scenario==='retained-postack-changed'?/Retained predecessor recovery requires the same identified managed container/:
     scenario==='retained-timeout'?/controlled existing-target start timeout/:scenario==='retained-live-proof'?/controlled live contract proof failed/:
     scenario==='retained-ack-failure'?/controlled disabled acknowledgement observation failed/:scenario==='retained-retry-changed'?/controlled retained retry target changed/:/Existing-only session/;
   assert.match((error.cause??error).message,expected);
   assert.equal(commandLaunched,false);
 }
 if(scenario==='retained-postack-changed')assert.equal(falseAckBeforeFailure,true);
 assert.equal(retained,false);assert.equal(pending,null);assert.equal(mutationIntents,0);assert.ok(cleanupFlags.every(enabled=>enabled===false));
 assert.equal(exactStarts,retainedStopped?1:0);assert.equal(effects.filter(effect=>effect==='start').length,exactStarts);
 assert.equal(effects.some(effect=>['run','rm','stop'].includes(effect)),false);
 assert.equal(retainedAttempts,scenario==='retained-retry-changed'?2:scenario==='retained-changed'||scenario==='retained-postack-changed'?0:1);
 for(const old of retainedFiles){const stat=lstatSync(old.path);assert.equal(readFileSync(old.path,'utf8'),old.bytes);assert.equal(stat.ino,old.ino);assert.equal(stat.dev,old.dev);}
 assert.equal(retainedFiles.length,6);
} else if(scenario==='uncertain-mutation') {
 assert.ok(error instanceof AggregateError); assert.equal(error.errors[0].cause,primary);
 assert.equal(pending,'startup'); assert.equal(mutationIntents,1); assert.equal(stopped,false);
 // The controlled fake effect created no resource. After asserting retention,
 // teardown publishes an explicit disabled update through the actual guardian
 // and awaits its ACK; it does not erase or fabricate an observation record.
 session.setSessionCleanupEnabled(false); await session.confirmSessionOwnership();
 session.cleanupSession();
} else {
 assert.ok(!(error instanceof AggregateError));
 if(retryScenario){
   assert.match(error.cause.message,/refusing to create a replacement in the same invocation/);
   assert.equal(retryStarts,2);assert.equal(expectedAtRetry,oldId);assert.equal(ownTargetAtRetry,true);
   assert.equal(secondDispatches,0);assert.equal(effects.includes('run'),false);assert.equal(effects.includes('stop'),false);
 } else assert.equal(error.cause,primary);
 assert.equal(retained,false); assert.equal(pending,null);
 assert.equal(mutationIntents,scenario==='stopped-upgrade'||retryScenario?1:0);
}
assert.equal(session.getCurrentSession().lockFile,null);
assert.equal(existsSync(claim),false); assert.equal(existsSync(claim+'.guardian.json'),false); assert.equal(existsSync(claim+'.runtime.json'),false);
assert.equal(readFileSync(join(project,'untracked.txt'),'utf8'),'uncommitted work\\n');
assert.deepEqual(readdirSync(project),['untracked.txt']);
const until=Date.now()+5000;
while(Date.now()<until){try{process.kill(guardian,0);}catch(cause){if(cause.code==='ESRCH')break;throw cause;} await new Promise(resolve=>setTimeout(resolve,20));}
try{process.kill(guardian,0);throw new Error('owned guardian did not exit');}catch(cause){if(cause.code!=='ESRCH')throw cause;}
console.log(JSON.stringify({retained,pending,mutationIntents,markerRead,removed,stopped,claimsRetired:true,
 ...(retryScenario?{retryStarts,secondDispatches,expectedAtRetry,ownTargetAtRetry}:{}),
 ...(retainedScenario?{retainedFiles:retainedFiles.length,commandLaunched,falseAckAtLaunch,cleanupFlags,exactStarts}: {}),
 ...(scenario==='retained-postack-changed'?{falseAckBeforeFailure}:{})}));
`], {cwd: root, env: {...process.env, HOME: root, USERPROFILE: root, CCC_HOME: undefined, CCC_PROFILE: undefined}, stdio: ["ignore", "pipe", "pipe"]});
    let stdout = "", stderr = "";
    child.stdout.on("data", data => { stdout += String(data); }); child.stderr.on("data", data => { stderr += String(data); });
    const completed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    const timeout = setTimeout(() => child.kill(), 20000);
    try {
        expect(await completed, stderr).toBe(0);
        expect(JSON.parse(stdout.trim())).toEqual({
            retained: scenario === "uncertain-mutation", pending: scenario === "uncertain-mutation" ? "startup" : null,
            mutationIntents: scenario === "preflight-refusal" || scenario.startsWith("retained-") ? 0 : 1,
            markerRead: scenario === "stopped-upgrade", removed: scenario === "stopped-upgrade", stopped: scenario === "stopped-upgrade", claimsRetired: true,
            ...(scenario === "retry-target-missing" ? {retryStarts: 2, secondDispatches: 0, expectedAtRetry: "a".repeat(64), ownTargetAtRetry: true} : {}),
            ...(scenario.startsWith("retained-") ? {
                retainedFiles: 6, commandLaunched: ["retained-join", "retained-stopped", "retained-provisional"].includes(scenario),
                falseAckAtLaunch: ["retained-join", "retained-stopped", "retained-provisional"].includes(scenario),
                cleanupFlags: ["retained-join", "retained-stopped", "retained-provisional"].includes(scenario) ? [false] : [],
                exactStarts: ["retained-stopped", "retained-provisional", "retained-timeout", "retained-live-proof", "retained-ack-failure", "retained-retry-changed"].includes(scenario) ? 1 : 0,
            } : {}),
            ...(scenario === "retained-postack-changed" ? {falseAckBeforeFailure: true} : {}),
        });
    } finally {
        clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill();
        await completed.catch(() => undefined); rmSync(root, {recursive: true, force: true});
    }
}, 25000);
