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
 ensureClipboard: async () => null, validateClipboard: async selected => selected,
 clipboardPortFile: () => join(root, 'clipboard.port'), clipboardConnection: () => ({}),
 worktreeMounts: () => [], containerName: () => 'ccc-isolated-library',
 containerStatus: () => ({exists: true, running: reused, containerId: target, imageId: 'fake-image'}),
 sessionClaims: () => ['owned-session.lock'], lockName: () => 'owned-session.lock', prepareDeviceBroker: async () => {},
 stateLock: async operation => operation(), lifecycleLock: async (_prefix, operation) => operation(),
 setupLock: async (_prefix, operation) => operation(),
 prepareContainer: () => ({
   start(...args) {
     if (!reused) args[9](target);
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
