import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repository = fileURLToPath(new URL("../../", import.meta.url));

// Only these private executables are dispatched. Their actual native argv and
// environment are compiled by the production binder, without a process mock.
const runtime = String.raw`
const fs = require('node:fs'), path = require('node:path');
const root = process.env.CCC_BIND_USERS_FIXTURE;
const raw = process.argv.slice(2);
const option = name => raw[raw.indexOf(name) + 1];
let authority;
if (raw.includes('--host')) authority = option('--host');
else if (raw.includes('--connection')) {
  const config = JSON.parse(fs.readFileSync(process.env.PODMAN_CONNECTIONS_CONF, 'utf8'));
  authority = config.Connection.Connections[option('--connection')].URI;
} else throw new Error('fixture refuses uncaptured runtime authority');
const engine = authority.includes('retained-a') ? 'a' : authority.includes('current-b') ? 'b' : null;
if (!engine) throw new Error('fixture refuses unknown authority');
const offset = raw.findIndex(value => value === 'ps' || value === 'inspect');
if (offset < 0) throw new Error('fixture refuses noninventory command');
const args = raw.slice(offset);
fs.appendFileSync(path.join(root, 'trace.jsonl'), JSON.stringify({ engine, authority, args,
  dockerContext: process.env.DOCKER_CONTEXT ?? null,
  containerConnection: process.env.CONTAINER_CONNECTION ?? null,
  guarded: fs.existsSync(path.join(root, 'ccc-home', 'codex-state.lock')) }) + '\n');
const state = JSON.parse(fs.readFileSync(path.join(root, 'engine-' + engine + '.json'), 'utf8'));
if (state.unavailable) { process.stderr.write('owned fixture engine unavailable'); process.exit(1); }
if (args[0] === 'ps') {
  const visible = state.containers.filter(value => args.includes('-aq') || value.State.Running);
  process.stdout.write(visible.map(value => value.Id).join('\n'));
} else {
  const requested = args.slice(1);
  process.stdout.write(JSON.stringify(state.containers.filter(value => requested.includes(value.Id))));
}
`;

// The coordinator emits the product before this owner; native A/B routing must
// use that installed-shaped closure, without a TypeScript loader.
const consumer = String.raw`
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const { prepareRuntimeBindHome, recordRuntimeBindAuthority, withRuntimeBindGuard } = await import(${JSON.stringify(new URL("../../dist/adapters/runtime-bind-authority.js", import.meta.url).href)});
const { NATIVE_RUNTIME_SELECTOR_KEYS } = await import(${JSON.stringify(new URL("../../dist/ports/container-runtime-invocation.js", import.meta.url).href)});
const api = await import(${JSON.stringify(new URL("../../dist/container-runtime.js", import.meta.url).href)});
const { clipboardPortMayHaveBindUsers } = await import(${JSON.stringify(new URL("../../dist/clipboard-bind-users.js", import.meta.url).href)});
const { hasLegacyHomeLayoutContainerMounts } = await import(${JSON.stringify(new URL("../../dist/home-layout-container-guard.js", import.meta.url).href)});
const root = process.env.CCC_BIND_USERS_FIXTURE, scenario = process.env.CCC_BIND_USERS_SCENARIO;
const home = prepareRuntimeBindHome(join(root, 'ccc-home'));
withRuntimeBindGuard(home, () => {});
const port = join(home.root, 'clipboard.port');
writeFileSync(port, '123:owned-token', {mode:0o600});
mkdirSync(join(home.root, 'codex'), {mode:0o700});
const selectors = Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null]));
selectors.HOME = join(root, 'host-home');
const config = join(root, 'docker-config');
mkdirSync(config, {mode:0o700});
const alias = join(config, 'mutable-alias.json');
writeFileSync(alias, JSON.stringify({ host:'unix:///fixture/retained-a.sock' }), {mode:0o600});
const retained = { version:1, runtime:'docker', executable:join(root, 'owned-docker.cjs'),
  transport:{kind:'docker',host:'unix:///fixture/retained-a.sock',configDirectory:config,
    tls:{enabled:false,verify:false,caFile:null,certFile:null,keyFile:null}},
  selectors:{...selectors,DOCKER_CONTEXT:'mutable-alias'} };
const current = { version:1, runtime:'podman', executable:join(root, 'owned-podman.cjs'),
  transport:{kind:'podman-remote',url:'ssh://fixture@current-b.invalid/run/podman.sock',identityFile:null,machine:true,
    tls:{caFile:null,certFile:null,keyFile:null}}, selectors:{...selectors,CONTAINER_CONNECTION:'mutable-connection'} };
withRuntimeBindGuard(home, guard => recordRuntimeBindAuthority(guard, retained));
if (scenario === 'alias-removed') rmSync(alias);
else writeFileSync(alias, JSON.stringify({host:'unix:///fixture/current-b.sock'}));
process.env.DOCKER_CONTEXT = 'different-ambient-alias';
process.env.DOCKER_HOST = 'unix:///fixture/current-b.sock';
process.env.CONTAINER_CONNECTION = 'different-ambient-connection';
api._setRuntimeInvocationForTest(current);
const protectedContainer = {Id:'a'.repeat(64),State:{Running:false},Mounts:[
  {Type:'bind',Source:port,Destination:'/run/ccc/clipboard.port'},
  {Type:'bind',Source:join(home.root,'codex'),Destination:'/home/ccc/.codex'},
]};
writeFileSync(join(root,'engine-a.json'), JSON.stringify({unavailable:scenario === 'unavailable',
  containers:scenario === 'clear' || scenario === 'unavailable' ? [] : [protectedContainer]}));
writeFileSync(join(root,'engine-b.json'), JSON.stringify({unavailable:false,containers:[]}));
const beforePort = readFileSync(port,'utf8');
const observation = withRuntimeBindGuard(home, guard => ({
  clipboard:clipboardPortMayHaveBindUsers(port,guard),
  home:hasLegacyHomeLayoutContainerMounts(guard),
}));
assert.deepEqual(observation,{clipboard:scenario !== 'clear',home:scenario !== 'clear'});
assert.equal(readFileSync(port,'utf8'),beforePort);
assert.equal(existsSync(join(home.root,'codex')),true);
const trace = readFileSync(join(root,'trace.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
assert(trace.length > 0,'a conservative result without executing retained authority is insufficient');
assert(trace.some(row=>row.engine === 'a'),'retained authority must actually be inventoried');
if (scenario === 'clear') assert(trace.some(row=>row.engine === 'b'),'current authority must also prove empty');
if (scenario === 'alias-removed' || scenario === 'alias-retargeted') {
  assert(trace.some(row=>row.engine === 'a' && row.args[0] === 'inspect'),'stopped retained bind must be observed');
}
for (const row of trace) {
  assert.equal(row.guarded,true);
  assert.equal(row.dockerContext,null);
  assert.equal(row.containerConnection,null);
  if (row.args[0] === 'ps') assert.deepEqual(row.args,['ps','-aq','--no-trunc']);
  else assert.deepEqual(row.args,['inspect','a'.repeat(64)]);
}
console.log(JSON.stringify({scenario,...observation,nativeCommands:trace.length}));
`;

describe.skipIf(process.platform === "win32")("retained bind users through owned native Docker and Podman clients (POSIX executable fixture)", () => {
    it.each(["alias-removed", "alias-retargeted", "unavailable", "clear"] as const)("protects retained resources and proves only complete absence: %s", scenario => {
        const fixture = realpathSync(mkdtempSync(join(tmpdir(), "ccc-native-bind-users-")));
        chmodSync(fixture, 0o700);
        try {
            for (const directory of ["host-home", "tmp"]) mkdirSync(join(fixture, directory), { mode: 0o700 });
            for (const executable of ["owned-docker.cjs", "owned-podman.cjs"]) {
                const path = join(fixture, executable);
                writeFileSync(path, `#!${process.execPath}\n${runtime}`, { mode: 0o700 });
                chmodSync(path, 0o700);
            }
            writeFileSync(join(fixture, "trace.jsonl"), "", { mode: 0o600 });
            const observed = spawnSync(process.execPath, ["--input-type=module", "-e", consumer], {
                cwd: repository, encoding: "utf8", timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
                env: { ...process.env, HOME: join(fixture, "host-home"), USERPROFILE: join(fixture, "host-home"),
                    TMPDIR: join(fixture, "tmp"), TMP: join(fixture, "tmp"), TEMP: join(fixture, "tmp"),
                    CCC_BIND_USERS_FIXTURE: fixture, CCC_BIND_USERS_SCENARIO: scenario,
                    CCC_HOME: undefined, CCC_PROFILE: undefined, CCC_RUNTIME: undefined },
            });
            const trace = readFileSync(join(fixture, "trace.jsonl"), "utf8");
            expect(observed.error, observed.stderr).toBeUndefined();
            expect(observed.status, `${observed.stderr}\n${observed.stdout}\nOwned native trace:\n${trace}`).toBe(0);
            expect(JSON.parse(observed.stdout.trim())).toMatchObject({ scenario, clipboard: scenario !== "clear", home: scenario !== "clear" });
        } finally { rmSync(fixture, { recursive: true, force: true }); }
    });
});
