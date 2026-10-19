import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The coordinator emits this graph after all writers stop. Never substitute a
// Vitest source import: these cases own the actual Node/native composition.
const emittedDirectory = process.env.CCC_NATIVE_RUNTIME_AUTHORITY_DIST ?? fileURLToPath(new URL("../../../dist/", import.meta.url));
if (!isAbsolute(emittedDirectory)) throw new Error("CCC_NATIVE_RUNTIME_AUTHORITY_DIST must be absolute");

const nativeProgram = String.raw`
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
const root = process.env.CCC_NATIVE_FIXTURE_ROOT;
const mode = process.env.CCC_NATIVE_FIXTURE_MODE;
const raw = process.argv.slice(2), executable = basename(dirname(process.argv[1]));
const choice = JSON.parse(readFileSync(join(root, 'choice.json'), 'utf8'));
const value = key => raw[raw.indexOf(key) + 1];
let capsule = null;
if (raw.includes('--connection')) capsule = JSON.parse(readFileSync(process.env.PODMAN_CONNECTIONS_CONF, 'utf8'));
const destination = capsule?.Connection?.Connections?.['ccc-captured-native-runtime'];
const host = raw.includes('--host') ? value('--host') : null;
const graphRoot = raw.includes('--root') ? value('--root') : null;
const authority = host ?? destination?.URI ?? graphRoot ?? choice.host;
const engine = authority.includes('engine-b') || authority.includes('store-b') ? 'b' : 'a';
const commands = ['--version', 'context', 'system', 'info', 'images', 'image', 'inspect', 'run', 'start', 'stop', 'rm', 'exec', 'cp', 'volume', 'ps', 'tag', 'build'];
const start = raw.findIndex(arg => commands.includes(arg));
if (start < 0) throw Error('fixture received an unknown native command');
const args = raw.slice(start), command = args[0];
appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({ executable, program: process.argv[1], engine, raw, args, host, graphRoot, destination,
  capsulePath: capsule ? process.env.PODMAN_CONNECTIONS_CONF : null,
  phase: process.env.CCC_NATIVE_FIXTURE_PHASE,
  selectors: { PATH: process.env.PATH, DOCKER_CONTEXT: process.env.DOCKER_CONTEXT ?? null,
    DOCKER_HOST: process.env.DOCKER_HOST ?? null, DOCKER_API_VERSION: process.env.DOCKER_API_VERSION ?? null,
    DOCKER_SSH_COMMAND: process.env.DOCKER_SSH_COMMAND ?? null, CONTAINER_HOST: process.env.CONTAINER_HOST ?? null,
    CONTAINER_CONNECTION: process.env.CONTAINER_CONNECTION ?? null } }) + '\n');
const statePath = join(root, 'engine-' + engine + '.json');
const state = JSON.parse(readFileSync(statePath, 'utf8'));
const save = () => writeFileSync(statePath, JSON.stringify(state));
const out = value => { if (value !== undefined) process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value)); };
const absent = () => { process.stderr.write('Error: No such object: ' + state.id); process.exit(1); };
const image = 'sha256:' + '1'.repeat(64), derived = 'sha256:' + '2'.repeat(64);
const identity = { 'ccc.identity.version': '1', 'ccc.identity.uid': '1000', 'ccc.identity.gid': '1000',
  'ccc.identity.mapping': mode === 'podman-remote' ? 'podman-keep-id' : 'host', 'ccc.identity.base': image };
function inspected() {
  const mounts = [], labels = {}, env = [], tmpfs = {};
  const argv = state.runArgs;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], next = argv[i + 1];
    if (arg === '-v' || arg === '--volume') {
      const [source, target, options = ''] = next.split(':');
      mounts.push({ Source: source, Destination: target, Type: source.startsWith('/') ? 'bind' : 'volume', Name: source.startsWith('/') ? undefined : source, RW: !options.split(',').includes('ro') });
    }
    if (arg === '--mount') {
      const fields = Object.fromEntries(next.split(',').map(part => { const at = part.indexOf('='); return at < 0 ? [part, ''] : [part.slice(0, at), part.slice(at + 1)]; }));
      const source = fields.source ?? fields.src;
      mounts.push({ Source: source, Destination: fields.target ?? fields.dst, Type: fields.type, Name: fields.type === 'volume' ? source : undefined, RW: !('readonly' in fields || 'ro' in fields) });
    }
    if (arg === '--label') { const at = next.indexOf('='); labels[next.slice(0, at)] = next.slice(at + 1); }
    if (arg === '-e' || arg === '--env') env.push(next);
    if (arg === '--tmpfs') { const at = next.indexOf(':'); tmpfs[next.slice(0, at)] = next.slice(at + 1); }
  }
  return { Id: state.id, Image: derived, State: { Running: state.running }, Mounts: mounts,
    Config: { User: 'ccc', Labels: labels, Env: env },
    HostConfig: { Init: true, Privileged: false, Devices: [], DeviceRequests: [], GroupAdd: [], Tmpfs: tmpfs } };
}
if (command === '--version') out(mode.startsWith('podman') ? 'podman version 5.2.3\n' : 'Docker version 27.0.0\n');
else if (command === 'context') out({ Name: choice.alias, Endpoints: { docker: { Host: choice.host, SkipTLSVerify: false } }, TLSMaterial: {}, Storage: {} });
else if (command === 'system') out([{ Name: choice.alias, Default: true, URI: choice.url, Identity: join(root, 'references', 'identity'), IsMachine: true,
  TLSCA: join(root, 'references', 'ca.pem'), TLSCert: join(root, 'references', 'cert.pem'), TLSKey: join(root, 'references', 'key.pem') }]);
else if (command === 'info') {
  if (args.at(-1) === 'json') out({ host: { serviceIsRemote: mode === 'podman-remote' }, store: { graphRoot: join(root, 'store-a'), runRoot: join(root, 'run-a'), graphDriverName: 'overlay', graphOptions: {}, transientStore: false } });
  else if (args.includes('{{.OperatingSystem}}')) out('Fixture Linux\n');
  else if (args.includes('{{json .SecurityOptions}}')) out('[]');
  else if (args.includes('{{.Host.Security.Rootless}}')) out('false');
  else if (args.includes('{{.ID}}')) out('fixture-daemon-a\n');
}
else if (command === 'images') out(image);
else if (command === 'image') out([{ Id: derived, Config: { User: 'ccc', Labels: identity } }]);
else if (command === 'inspect') {
  const format = args.includes('--format') ? args[args.indexOf('--format') + 1] : args.includes('-f') ? args[args.indexOf('-f') + 1] : null;
  if (args[1] === 'ccc') out(format === '{{.Id}}' ? image : '');
  else {
    if (!state.exists) absent();
    if (format === '{{.Id}}|{{.State.Running}}') out(state.id + '|' + state.running);
    else if (format === '{{.Id}}|{{.State.Running}}|{{.Image}}') out(state.id + '|' + state.running + '|' + derived);
    else if (format === '{{.State.Running}}') out(String(state.running));
    else if (format === '{{.Id}}') out(state.id);
    else if (format === '{{.Image}}') out(derived);
    else if (format === '{{json .}}') out(inspected());
    else out([inspected()]);
  }
}
else if (command === 'ps') out(state.exists && (args.includes('-aq') || state.running) ? state.id : '');
else if (command === 'run') {
  if (args.includes('--rm')) out('1000:1000:/home/ccc:ccc');
  else { state.exists = true; state.running = true; state.runArgs = args; state.created++; save(); out(state.id + '\n'); }
}
else if (command === 'start') { if (!state.exists) absent(); state.running = true; state.starts++; save(); }
else if (command === 'stop') { if (!state.exists) absent(); state.running = false; state.stops++; save(); }
else if (command === 'rm') { state.exists = false; state.running = false; state.removals++; save(); }
else if (command === 'exec') {
  state.execs++; save();
  if (args.includes('/usr/bin/docker') && args.includes('{{.ID}}')) out('fixture-daemon-a\n');
  else if (args.at(-1)?.includes('printf "%s:%s:%s:%s"')) out('1000:1000:ccc:/home/ccc');
  else if (args.includes('cat')) {
    const target = args[args.indexOf('cat') + 1];
    const mount = inspected().Mounts.filter(m => m.Type === 'bind' && (target === m.Destination || target.startsWith(m.Destination + '/'))).sort((a, b) => b.Destination.length - a.Destination.length)[0];
    if (!mount) throw Error('fixture cannot resolve owned mount challenge');
    const path = mount.Source + target.slice(mount.Destination.length);
    if (!existsSync(path)) throw Error('owned mount challenge missing');
    process.stdout.write(readFileSync(path));
  }
}
else if (command === 'volume') out('');
else if (!['cp', 'tag', 'build'].includes(command)) throw Error('unhandled native fixture operation');
`;

const consumer = String.raw`
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.CCC_NATIVE_FIXTURE_ROOT, mode = process.env.CCC_NATIVE_FIXTURE_MODE;
const dist = process.env.CCC_NATIVE_RUNTIME_AUTHORITY_DIST;
const load = file => import(pathToFileURL(join(dist, file)).href);
const api = await load('container-runtime.js');
const { createNativeContainerExecPorts } = await load('composition/container-exec.js');
const { createNativeContainerExistingLifecycle } = await load('composition/container-existing-lifecycle.js');
const { createNativeContainerCreateLifecycle } = await load('composition/container-create-lifecycle.js');
const { createNativeContainerDestructiveLifecycle } = await load('composition/container-destructive-lifecycle.js');
const { prepareWindowsCredentialAccess, repairWindowsCodexPrivateState } = await load('adapters/windows-credential-access.js');
const { prepareCodexDaemonPackage } = await load('adapters/codex-daemon-package.js');
const { createNativeHostCredentialRefreshPorts } = await load('adapters/credentials/host-refresh.js');
const { createHostCredentialRefresh } = await load('application/credentials/host-refresh.js');
const { runContainerCommand } = await load('container-command.js');
// The fixture's public account observation is synthetic. No container payload is run.
process.geteuid = () => 1000; process.getegid = () => 1000;
const runtime = mode === 'docker' ? 'docker' : 'podman';
const id = 'a'.repeat(64), project = join(root, 'project');
const aFile = join(root, 'engine-a.json'), bFile = join(root, 'engine-b.json');
const readA = () => JSON.parse(readFileSync(aFile, 'utf8'));
const writeA = state => writeFileSync(aFile, JSON.stringify(state));
const bOriginal = readFileSync(bFile, 'utf8');
const originalConnections = readFileSync(join(root, 'original-connections.json'), 'utf8');
const noop = () => undefined;
function late(phase) {
  writeFileSync(join(root, 'choice.json'), JSON.stringify({ alias: 'redefined-alias', host: 'unix:///fixture/engine-b.sock', url: 'ssh://fixture@engine-b.test/run/podman.sock' }));
  process.env.PATH = join(root, 'b'); process.env.DOCKER_CONTEXT = 'redefined-alias';
  process.env.DOCKER_HOST = 'unix:///fixture/engine-b.sock'; process.env.DOCKER_API_VERSION = '9.99';
  process.env.DOCKER_SSH_COMMAND = 'later-selector-must-be-absent';
  process.env.CONTAINER_CONNECTION = 'redefined-alias'; process.env.CONTAINER_HOST = 'ssh://fixture@engine-b.test/run/podman.sock';
  process.env.PODMAN_CONNECTIONS_CONF = join(root, 'later-connections.json');
  process.env.CCC_NATIVE_FIXTURE_PHASE = phase;
  api.setRuntimeOverride(runtime);
}
api.setRuntimeOverride(runtime);
const ports = createNativeContainerExecPorts({ ensureDirectories: noop, ensureProjectTools: async () => {}, assetDirectory: join(root, 'assets'), trustedCliPath: join(root, 'unused-cli') });
ports.ensureRuntime();
// Capture is optional for the original compiled graph. Its real public ports
// still execute below, so a negative control fails on an observed B effect.
const captured = typeof api.getRuntimeInvocation === 'function' ? api.getRuntimeInvocation() : undefined;
const expectedExecutable = join(root, 'a', runtime);
const withCaptured = operation => captured && typeof api.runWithNativeRuntimeInvocation === 'function'
  ? api.runWithNativeRuntimeInvocation(captured, operation) : operation();
if (captured) {
  assert.equal(captured.executable, expectedExecutable);
  assert.equal(captured.selectors.DOCKER_API_VERSION, '1.44');
}
try {
late('before-preparation');
let preparedStartup, readyId;
if (mode === 'docker') {
  preparedStartup = ports.prepareContainer();
  late('prepared-start-outside-scope');
  preparedStartup.start(project, () => {
    const home = join(root, 'home', '.ccc');
    for (const directory of ['claude', 'codex', 'opencode', 'opencode-data', 'profiles/default/claude', 'profiles/default/codex']) mkdirSync(join(home, directory), {recursive: true});
    for (const file of ['claude.json', 'profiles/default/claude.json']) { const path = join(home, file); if (!existsSync(path)) writeFileSync(path, '{}'); }
  }, [], undefined, undefined, undefined, undefined, value => { readyId = value; });
  assert.equal(readyId, id);
  late('prepared-initialize-outside-scope');
  preparedStartup.initialize(id);
} else {
  // Podman transport is exercised through the same actual ordinary ports without
  // inventing a socket service or running a container-account preparation tool.
  const state = readA(); state.exists = true; state.running = true; writeA(state);
}
late('inspection');
assert.equal(ports.containerRunning(id), true);
assert.equal(ports.containerStatus('same-name').containerId, id);
late('setup');
ports.ensureUv(id);
ports.installProjectTools(id, '/project/path with spaces');
ports.startClipboardBridge(id, { url: 'http://127.0.0.1:4321', token: 'fixture:literal' });
late('final-sync');
ports.ensureSocketAccess(id);
ports.reportConversationFiles(id, 'fixture-project');
late('passed-native-runners');
const bound = captured && typeof api.bindNativeRuntimeInvocation === 'function' ? api.bindNativeRuntimeInvocation(captured) : undefined;
const platform = process.platform;
try {
  Object.defineProperty(process, 'platform', {value: 'win32'});
  prepareWindowsCredentialAccess(runtime, id, '/home/ccc/.claude', bound?.spawnSync);
  repairWindowsCodexPrivateState(runtime, id, bound?.spawnSync);
} finally { Object.defineProperty(process, 'platform', {value: platform}); }
prepareCodexDaemonPackage(runtime, id, bound?.spawnSync);
writeFileSync(join(root, 'home', '.gitconfig'), '[user]\nname = Owned Fixture\n');
const refresh = createHostCredentialRefresh(createNativeHostCredentialRefreshPorts(() => runtime, bound?.spawnSync));
refresh.refreshSsh(id); refresh.syncGit(id);
const prepared = ports.prepareCommand({ runtime, target: id, workdir: '/project/path with spaces', environment: [['FIXTURE', 'literal $(no shell)']], command: {kind: 'command', arguments: ['codex', 'resume', 'argument with spaces', '$(never shell)']} });
late('daemon-preparation');
assert.deepEqual(ports.prepareCodexCommand(prepared), {ok: true});
late('interactive-exec');
assert.equal(await ports.launchCommand(prepared, {interactive: true, terminal: false, codexRecovery: false}), 0);
ports.disposeCommand(prepared);
late('direct-command');
assert.equal(await withCaptured(() => runContainerCommand(runtime, ['exec', id, 'direct literal $(never shell)'], true)), 0);
// Prepare actual native lifecycle facades while A is owned, then invoke their
// returned operations after leaving the initial scope and clearing global cache.
const lifecycle = withCaptured(() => createNativeContainerExistingLifecycle({
  listContainer: () => ({known: true, containerId: id}), identity: () => ({containerId: id, running: readA().running}),
  managedIdentity: () => ({containerId: id, running: readA().running}), assertProjectSources: noop, assertDeviceSources: noop,
  assertFilesystemSources: noop, inspectContract: () => true, verifyBeforeSetup: noop, safeToDefer: () => true,
  isRunning: () => readA().running, canExec: () => true, canExecAfterBriefRetry: () => true, deviceSourcesMatch: () => true,
  syncMcp: noop, fixSsh: noop, syncGit: noop, finish: noop,
}, {startCli: runtime, requiredMountDestinations: () => [], projectPath: project}));
let state = readA(); state.running = false; writeA(state);
late('restart');
assert.deepEqual(lifecycle.run({containerName: 'same-name'}), {kind: 'joined', containerId: id});
state = readA(); state.running = false; writeA(state);
late('remove-stopped');
assert.equal(lifecycle.replace({containerName: 'same-name', expectedContainerId: id, reason: 'fixture replacement', replacementGuard: replace => {replace(); return true;}}), true);
state = readA(); state.exists = true; state.running = true; writeA(state);
const destructive = createNativeContainerDestructiveLifecycle({
  resolvePath: value => value, projectId: () => 'fixture-project', containerName: () => 'same-name',
  withLifecycleLock: (_key, operation) => operation(), sessionClaims: () => [], ensureRuntime: noop,
  managedIdentity: () => {late('destructive-stop-and-remove'); return {containerId: id, running: true};}, cleanupDevices: noop,
});
withCaptured(() => destructive.remove(project));
const rejected = withCaptured(() => createNativeContainerCreateLifecycle({
  withFamilyLock: (_key, operation) => operation(), namespaceExists: () => false, findCollision: () => null,
  assertProjectSources: noop, assertDeviceSources: noop, assertFilesystemSources: noop,
  verifyCreated: () => {late('rejected-create-compensation'); return {kind: 'mismatch', reason: 'fixture mount identity mismatch'};},
  syncMcp: () => {throw Error('rejected create synchronized helpers');}, fixSsh: noop, syncGit: noop, finish: () => {throw Error('rejected create published');},
}, {createCli: runtime, prepareRunArgs: () => ['run', '--name', 'same-name', 'fixture-image'], createFailureHint: 'fixture create failed',
  labWarning: () => null, explicitlyNotFound: result => result.status === 1 && /No such object/.test(result.stderr)}));
late('create-after-preparation');
assert.throws(() => rejected.run({containerName: 'same-name', projectMountIdentity: 'fixture-identity'}), /fixture mount identity mismatch/);
assert.equal(readA().exists, false);
assert.equal(readFileSync(bFile, 'utf8'), bOriginal, 'identical B ID was touched');
assert.equal(readFileSync(join(root, 'original-connections.json'), 'utf8'), originalConnections);
const trace = readFileSync(join(root, 'trace.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const phases = ['inspection', 'setup', 'final-sync', 'passed-native-runners', 'daemon-preparation', 'interactive-exec', 'direct-command', 'restart', 'remove-stopped', 'destructive-stop-and-remove', 'create-after-preparation', 'rejected-create-compensation'];
if (mode === 'docker') phases.push('prepared-start-outside-scope', 'prepared-initialize-outside-scope');
for (const phase of phases) assert(trace.some(row => row.phase === phase), 'missing actual native phase: ' + phase);
for (const row of trace) {
  assert.equal(row.executable, 'a', 'ambient PATH redirected native executable');
  assert.equal(row.program, expectedExecutable);
  assert.equal(row.engine, 'a', 'ambient selector redirected native authority');
  if (row.phase === 'capture') continue;
  assert.equal(row.selectors.PATH, join(root, 'a'));
  assert.equal(row.selectors.DOCKER_API_VERSION, '1.44');
  for (const key of ['DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_SSH_COMMAND', 'CONTAINER_HOST', 'CONTAINER_CONNECTION']) assert.equal(row.selectors[key], null);
  if (mode === 'docker') {
    assert.equal(row.host, 'unix:///fixture/engine-a.sock');
    assert.equal(row.raw.filter(arg => arg === '--host').length, row.args.includes('/usr/bin/docker') ? 2 : 1);
    if (row.args.includes('/usr/bin/docker')) assert.deepEqual(row.args.slice(row.args.indexOf('/usr/bin/docker'), row.args.indexOf('/usr/bin/docker') + 3), ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']);
  }
  if (mode === 'podman-local') {assert.equal(row.graphRoot, join(root, 'store-a')); assert(row.raw.includes('--remote=false'));}
  if (mode === 'podman-remote') {
    assert.equal(row.destination.URI, 'ssh://fixture@engine-a.test/run/podman.sock'); assert.equal(row.destination.IsMachine, true);
    assert.equal(row.destination.TLSKey, join(root, 'references', 'key.pem'));
    assert.notEqual(row.capsulePath, join(root, 'original-connections.json')); assert.equal(existsSync(row.capsulePath), false);
  }
}
assert.equal(trace.filter(row => row.args[0] === 'context').length, mode === 'docker' ? 1 : 0);
assert.equal(trace.filter(row => row.args[0] === 'info' && row.args.at(-1) === 'json').length, mode === 'docker' ? 0 : 1);
assert.equal(trace.filter(row => row.args[0] === 'system').length, mode === 'podman-remote' ? 1 : 0);
assert(trace.some(row => row.phase === 'interactive-exec' && row.args.at(-1) === '$(never shell)'));
assert.deepEqual(trace.filter(row => row.phase === 'rejected-create-compensation').map(row => row.args[0]), ['rm', 'inspect']);
assert.deepEqual(trace.filter(row => row.phase === 'destructive-stop-and-remove').map(row => row.args[0]), ['stop', 'rm']);
console.log('CCC_NATIVE_RUNTIME_RESULT=' + JSON.stringify({mode, phases, nativeCommands: trace.length, bUntouched: true}));
} finally {
  // Preserve genuine native effects as the old-compatible regression witness,
  // even if an ambient B inspection makes a later product guard refuse first.
  const observed = readFileSync(join(root, 'trace.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  for (const row of observed) {
    assert.equal(row.program, expectedExecutable, 'ordinary native effect used ambient executable B');
    assert.equal(row.engine, 'a', 'ordinary native effect reached engine B');
  }
}
`;

describe.skipIf(process.platform === "win32")("emitted ordinary native invocation authority", () => {
    it.each(["docker", "podman-local", "podman-remote"] as const)("retains %s executable and engine across prepared callbacks, setup, launch and compensation", mode => {
        const root = mkdtempSync(join(tmpdir(), "ccc-runtime-authority-"));
        const id = "a".repeat(64);
        try {
            for (const directory of ["a", "b", "home", "project", "assets", "tmp"]) mkdirSync(join(root, directory), {mode: 0o700});
            for (const engine of ["a", "b"]) {
                for (const runtime of ["docker", "podman"]) {
                    const path = join(root, engine, runtime);
                    writeFileSync(path, `#!${process.execPath}\n${nativeProgram}`, {mode: 0o700});
                    chmodSync(path, 0o700);
                }
                writeFileSync(join(root, `engine-${engine}.json`), JSON.stringify({id, exists: engine === "b", running: engine === "b", runArgs: [], created: 0, starts: 0, stops: 0, removals: 0, execs: 0}));
            }
            writeFileSync(join(root, "choice.json"), JSON.stringify({alias: "fixture-alias", host: "unix:///fixture/engine-a.sock", url: "ssh://fixture@engine-a.test/run/podman.sock"}));
            writeFileSync(join(root, "original-connections.json"), '{"fixture":"preserve-original"}');
            writeFileSync(join(root, "later-connections.json"), '{"fixture":"later-config"}');
            writeFileSync(join(root, "trace.jsonl"), "");
            const result = spawnSync(process.execPath, ["--input-type=module", "-e", consumer], {
                cwd: root, encoding: "utf8", timeout: 45_000, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024,
                env: {PATH: join(root, "a"), HOME: join(root, "home"), USERPROFILE: join(root, "home"),
                    TMPDIR: join(root, "tmp"), LANG: "C.UTF-8", TZ: "UTC", container: undefined,
                    CCC_HOME: undefined, CCC_PROFILE: undefined, CCC_RUNTIME: undefined, VITEST: undefined,
                    DOCKER_CONTEXT: "fixture-alias", DOCKER_HOST: undefined, DOCKER_CONFIG: join(root, "home", ".docker"),
                    DOCKER_TLS: undefined, DOCKER_TLS_VERIFY: undefined, DOCKER_CERT_PATH: undefined, DOCKER_SSH_COMMAND: undefined,
                    DOCKER_API_VERSION: "1.44", CONTAINER_CONNECTION: mode === "podman-remote" ? "fixture-alias" : undefined,
                    CONTAINER_HOST: undefined, CONTAINER_SSHKEY: undefined, SSH_AUTH_SOCK: undefined,
                    PODMAN_CONNECTIONS_CONF: join(root, "original-connections.json"), CCC_NATIVE_RUNTIME_AUTHORITY_DIST: emittedDirectory,
                    CCC_NATIVE_FIXTURE_ROOT: root, CCC_NATIVE_FIXTURE_MODE: mode, CCC_NATIVE_FIXTURE_PHASE: "capture"},
            });
            const trace = readFileSync(join(root, "trace.jsonl"), "utf8");
            expect(result.error, result.stderr).toBeUndefined();
            expect(result.status, `${result.stderr}\n${result.stdout}\nowned native trace:\n${trace}`).toBe(0);
            const line = result.stdout.split("\n").find(value => value.startsWith("CCC_NATIVE_RUNTIME_RESULT="));
            expect(line).toBeDefined();
            expect(JSON.parse(line!.slice("CCC_NATIVE_RUNTIME_RESULT=".length))).toMatchObject({mode, bUntouched: true});
        } finally {
            rmSync(root, {recursive: true, force: true});
        }
    }, 60_000);
});
