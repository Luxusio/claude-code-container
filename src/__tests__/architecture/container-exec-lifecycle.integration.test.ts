import {spawn} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";

const compositionUrl = new URL("../../../dist/composition/container-exec.js", import.meta.url).href;
const sessionUrl = new URL("../../../dist/session.js", import.meta.url).href;
const dockerUrl = new URL("../../../dist/docker.js", import.meta.url).href;
const applicationUrl = new URL("../../../dist/application/container-exec.js", import.meta.url).href;

it("native exec lifecycle acquisition yields to the real owner's timer and enters only after release", async () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-exec-lifecycle-"));
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
const {withContainerLifecycleLockAsync} = await import(${JSON.stringify(sessionUrl)});
const {createNativeContainerExecPorts} = await import(${JSON.stringify(compositionUrl)});
const {withProjectContainerStateLockAsync} = await import(${JSON.stringify(dockerUrl)});
const {createContainerExec} = await import(${JSON.stringify(applicationUrl)});
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
 detectWorktreeBranch: () => null, familyLock: async (_id, operation) => operation(),
 acquireOwnership: async () => ({lockFile: '/owned/session.lock', existingId: 'pinned-id'}),
 inspectSessionContainer: () => ({known: true, containerId: 'pinned-id'}),
 ensureClipboard: async () => null, clipboardPortFile: () => '/owned/clipboard.port', clipboardConnection: () => ({}),
 worktreeMounts: () => [], containerName: () => 'ccc-isolated-exec',
 containerStatus: () => ({exists: true, running: true, containerId: 'pinned-id', imageId: 'image'}),
 sessionClaims: () => ['session.lock'], lockName: () => 'session.lock', prepareDeviceBroker: async () => {},
 prepareContainer: () => { prepared(); return {start: (...args) => {
   if (!timerRan || !ownerReleased) throw new Error('startup preceded release');
   waiterEntered = true; args[7]('pinned-id', {startedByInvocation: false}); return 'ccc-isolated-exec';
 }, initialize: noop}; },
 setSessionContainer: noop, setCleanupEnabled: noop, confirmOwnership: async () => {},
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
