import {spawn, spawnSync, type ChildProcess} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {userInfo} from "node:os";
import {createRequire} from "node:module";
import {join} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {afterEach, beforeEach, describe, expect, it} from "vitest";

// Real Source-loaded Node processes, private native files and an inert runtime
// executable. No Docker/Podman engine, container payload or user process runs.
const repository = fileURLToPath(new URL("../../", import.meta.url));
// A private-project cwd cannot resolve this repository's bare package name.
// Resolve the installed loader from this test module, then pass its absolute
// URL to every real child so a loader error cannot masquerade as CLI rejection.
const sourceLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const moduleUrl = (path: string) => pathToFileURL(join(repository, "src", path)).href;
const exactId = "a".repeat(64);
const image = `sha256:${"b".repeat(64)}`;
const oldImage = `sha256:${"c".repeat(64)}`;

interface NativeWitness {
    args: string[];
    invocation: {executable: string; transport: {host: string}};
    pending: string;
    claimPid: number;
    clientPid: number;
}

interface ChildResult {status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;}

async function eventually(predicate: () => boolean, description: string): Promise<void> {
    const deadline = performance.now() + 15_000;
    while (!predicate()) {
        if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await new Promise(resolve => setTimeout(resolve, 15));
    }
}

describe.runIf(process.platform === "linux")("native publication at protected-bind dispatch", () => {
    let root: string;
    let home: string;
    let runtime: string;
    let client: string;
    const children = new Set<ChildProcess>();

    beforeEach(() => {
        // Codex's real ancestor admission rejects world-writable /tmp. Use a
        // uniquely owned private fixture under the OS account home, independent
        // of a coordinator's overridden HOME; no existing account data is used.
        root = mkdtempSync(join(userInfo().homedir, ".ccc-bind-publication-"));
        home = join(root, "user");
        for (const path of [home, join(root, "tmp"), join(root, "project"), join(root, "config")]) mkdirSync(path, {mode: 0o700});
        runtime = join(root, "runtime.mjs");
        client = join(root, "client.mjs");
        writeFileSync(runtime, `#!${process.execPath}
import {appendFileSync, existsSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
const root = ${JSON.stringify(root)}, home = ${JSON.stringify(home)}, id = ${JSON.stringify(exactId)};
const image = ${JSON.stringify(image)}, oldImage = ${JSON.stringify(oldImage)};
const uid = process.getuid?.() || 1000, gid = process.getgid?.() || 1000;
const raw = process.argv.slice(2);
const commands = ['images', 'image', 'inspect', 'info', 'ps', 'run', 'start', 'rm', 'stop', 'exec', 'cp', 'tag', 'volume', 'build'];
const start = raw.findIndex(arg => commands.includes(arg));
if (start < 0) throw Error('unrecognized inert runtime invocation');
const args = raw.slice(start), command = args[0], mode = process.env.CCC_BIND_WITNESS_MODE;
appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({args, raw, mode}) + '\\n');
const output = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
const protectedRun = command === 'run' && (!args.includes('--rm') || args.includes('--mount'));
if (protectedRun) {
    const history = JSON.parse(readFileSync(join(home, '.ccc', 'runtime-bind-authority', 'history.json'), 'utf8'));
    const claim = JSON.parse(readFileSync(join(home, '.ccc', 'codex-state.lock'), 'utf8'));
    const authority = history.authorities.find(item => item.executable === process.argv[1]);
    if (!authority || !/^[a-f0-9]{32}$/.test(history.pending) || claim.pid !== process.ppid) process.exit(97);
    appendFileSync(join(root, 'witness.jsonl'), JSON.stringify({args, invocation: authority, pending: history.pending,
        claimPid: claim.pid, clientPid: process.pid}) + '\\n');
    if (mode === 'wsl-parent-death') {
        writeFileSync(join(root, 'client-entered'), String(process.pid));
        process.kill(process.ppid, 'SIGKILL');
        const deadline = Date.now() + 10000;
        while (!existsSync(join(root, 'release-late-effect'))) {
            if (Date.now() > deadline) process.exit(98);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        writeFileSync(join(root, 'late-native-effect'), id);
        process.exit(0);
    }
    if (mode === 'ordinary-fail' || mode === 'codex-fail' || mode === 'wsl-fail') process.exit(73);
    if (args.includes('--cidfile')) writeFileSync(args[args.indexOf('--cidfile') + 1], id);
    if (args.includes('/ccc-bind-proof')) { output('2096:85186\\n'); process.exit(0); }
    if (args.includes('dst=/state') || args.some(arg => arg.endsWith(',dst=/state'))) process.exit(0);
    writeFileSync(join(root, 'materialized'), id); output(id + '\\n'); process.exit(0);
}
if (command === 'images') output(image + '\\n');
else if (command === 'image') output([{Id: image, Config: {User: 'ccc', Labels: {
    'ccc.identity.version': '1', 'ccc.identity.uid': String(uid), 'ccc.identity.gid': String(gid),
    'ccc.identity.mapping': 'host', 'ccc.identity.base': image}}}]);
else if (command === 'inspect') {
    const format = args[args.indexOf('--format') + 1] || args[args.indexOf('-f') + 1];
    if (args[1] === 'ccc') output(format === '{{.Id}}' ? image : '');
    else if (!existsSync(join(root, 'materialized'))) { process.stderr.write('Error: No such object: ' + id); process.exit(1); }
    else if (format === '{{.Id}}|{{.State.Running}}') output(id + '|true');
    else if (format === '{{.Id}}') output(id);
    else output({Id: id, Image: image, State: {Running: true}, Mounts: [], Config: {Labels: {}}, HostConfig: {}});
} else if (command === 'ps') output('');
else if (command === 'run') output(args.includes(oldImage) ? '1001:1001' : uid + ':' + gid + ':/home/ccc:ccc');
else if (command === 'info') output(args.includes('{{.ID}}') ? 'inert-daemon' : '');
else if (command === 'rm') { try { (await import('node:fs')).unlinkSync(join(root, 'materialized')); } catch {} }
else if (command === 'exec' && args.at(-1)?.includes('printf "%s:%s:%s:%s"')) output(uid + ':' + gid + ':ccc:/home/ccc');
`);
        chmodSync(runtime, 0o700);
        writeFileSync(client, `
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const root = ${JSON.stringify(root)}, home = ${JSON.stringify(home)}, mode = process.argv[2];
const authority = await import(${JSON.stringify(moduleUrl("adapters/runtime-bind-authority.ts"))});
const runtime = await import(${JSON.stringify(moduleUrl("container-runtime.ts"))});
const {NATIVE_RUNTIME_SELECTOR_KEYS} = await import(${JSON.stringify(moduleUrl("ports/container-runtime-invocation.ts"))});
const prepared = authority.prepareRuntimeBindHome(join(home, '.ccc'));
if (!existsSync(join(home, '.ccc', 'runtime-bind-authority', 'history.json'))) authority.withRuntimeBindGuard(prepared, () => undefined);
runtime._setRuntimeInfoForTest({runtime: 'docker', flavor: 'docker-native', remote: false, dockerDesktop: mode.startsWith('wsl'), rootless: false});
runtime._setRuntimeInvocationForTest({version: 1, runtime: 'docker', executable: ${JSON.stringify(runtime)},
    transport: {kind: 'docker', host: 'unix:///inert-publication/engine-a.sock', configDirectory: join(root, 'config'),
        tls: {enabled: false, verify: false, caFile: null, certFile: null, keyFile: null}},
    selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, null]))});
const history = () => authority.withRuntimeBindGuard(join(home, '.ccc'), guard => {
    const value = authority.readRuntimeBindAuthority(guard);
    return {coverage: value.coverage, pending: value.pending, count: value.authorities.length};
});
if (mode === 'hold') {
    await authority.withRuntimeBindGuardAsync(join(home, '.ccc'), async () => {
        process.send?.({held: true});
        await new Promise(resolve => process.once('message', resolve));
    });
} else if (mode.startsWith('wsl')) {
    const original = fs.readFileSync;
    fs.readFileSync = function(path, ...args) {
        return path === '/proc/sys/kernel/osrelease' ? '6.6-microsoft-standard-WSL2' : original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    const {proveWslBindSourceIdentity} = await import(${JSON.stringify(moduleUrl("wsl-bind-source-proof.ts"))});
    const source = '/run/desktop/mnt/host/wsl/docker-desktop-bind-mounts/Owned/' + 'd'.repeat(64);
    const started = performance.now();
    const value = proveWslBindSourceIdentity(source, {dev: '2096', ino: '85186'}, ${JSON.stringify(image)});
    if (mode === 'wsl-busy') console.log(JSON.stringify({value, elapsed: performance.now() - started}));
    else console.log(JSON.stringify({value, history: history()}));
} else if (mode.startsWith('codex')) {
    const {prepareCodexStateOwnership} = await import(${JSON.stringify(moduleUrl("codex-state-ownership.ts"))});
    const store = join(home, '.ccc', 'codex'); mkdirSync(store, {mode: 0o700});
    const identity = {uid: process.geteuid(), gid: process.getegid(), mapping: 'host', contractVersion: '1'};
    let error = null;
    try { prepareCodexStateOwnership({Image: ${JSON.stringify(oldImage)}, Mounts: [{Type: 'bind', Source: store, Destination: '/home/ccc/.codex'}]},
        ${JSON.stringify(image)}, identity); } catch (cause) { error = cause.message; }
    console.log(JSON.stringify({error, history: history()}));
} else {
    const {startProjectContainer} = await import(${JSON.stringify(moduleUrl("docker.ts"))});
    if (mode === 'ordinary-corrupt') writeFileSync(join(home, '.ccc', 'runtime-bind-authority', 'history.json'), 'preserve malformed history');
    let error = null;
    try { startProjectContainer(join(root, 'project'), () => {
        const credentials = join(home, '.ccc', 'profiles', 'default');
        mkdirSync(credentials, {recursive: true, mode: 0o700});
        writeFileSync(join(credentials, 'claude.json'), '{}', {mode: 0o600});
    }); } catch (cause) { error = cause.message; }
    console.log(JSON.stringify({error, history: history()}));
}
`);
    });

    afterEach(async () => {
        // All signals target only handles created by this fixture.
        for (const child of children) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
        await Promise.all([...children].map(child => child.exitCode !== null || child.signalCode !== null
            ? Promise.resolve() : new Promise<void>(resolve => child.once("exit", () => resolve()))));
        children.clear();
        // Release the owned inert client if an assertion interrupted its parent-death case.
        writeFileSync(join(root, "release-late-effect"), "release");
        if (existsSync(join(root, "client-entered"))) {
            await eventually(() => existsSync(join(root, "late-native-effect")), "owned late native effect settlement");
        }
        rmSync(root, {recursive: true, force: true});
    });

    function environment(mode: string): NodeJS.ProcessEnv {
        return {...process.env, HOME: home, USERPROFILE: home, TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
            CCC_BIND_WITNESS_MODE: mode, container: "", CCC_DISABLE_PROXY: "1"};
    }

    function cliEnvironment(): NodeJS.ProcessEnv {
        const env = environment("cli");
        // Execute the actual CLI entry rather than its import-only test mode.
        // Keep this isolated from the parent Vitest process and helper children.
        delete env.VITEST;
        return env;
    }

    function run(mode: string): ChildResult {
        const result = spawnSync(process.execPath, ["--import", sourceLoader, client, mode], {
            cwd: repository, env: environment(mode), encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
        });
        expect(result.error, result.stderr).toBeUndefined();
        return result;
    }

    function resultJson(result: ChildResult): Record<string, unknown> {
        expect(result.status, result.stderr).toBe(0);
        const lastLine = result.stdout.trim().split("\n").at(-1);
        expect(lastLine, result.stderr).toBeTruthy();
        return JSON.parse(lastLine!);
    }

    function witnesses(): NativeWitness[] {
        return existsSync(join(root, "witness.jsonl")) ? readFileSync(join(root, "witness.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
    }

    it.each(["ordinary-fail", "codex-fail"])("%s has captured durable authority and pending before a real native executable observes its bind", mode => {
        const result = resultJson(run(mode));
        expect(result.error).toBeTypeOf("string");
        expect(result.history).toMatchObject({coverage: "complete", pending: true, count: 1});
        const observed = witnesses();
        expect(observed).toHaveLength(1);
        expect(observed[0].invocation).toMatchObject({executable: runtime, transport: {host: "unix:///inert-publication/engine-a.sock"}});
        expect(observed[0].pending).toMatch(/^[a-f0-9]{32}$/);
        expect(observed[0].claimPid).toBeGreaterThan(0);
        expect(observed[0].clientPid).not.toBe(observed[0].claimPid);
        expect(existsSync(join(home, ".ccc", "codex-state.lock"))).toBe(false);
    });

    it("a failed ordinary history publication never dispatches a native protected bind", () => {
        const result = resultJson(run("ordinary-corrupt"));
        expect(result.error).toBeTypeOf("string");
        expect(result.history).toMatchObject({coverage: "unknown", pending: true});
        expect(witnesses()).toEqual([]);
        expect(readFileSync(join(home, ".ccc", "runtime-bind-authority", "history.json"), "utf8")).toBe("preserve malformed history");
    });

    it("the standalone Codex helper positively completes and settles its own captured request", () => {
        const result = resultJson(run("codex-success"));
        expect(result.error).toBeNull();
        expect(result.history).toMatchObject({coverage: "complete", pending: false, count: 1});
        expect(witnesses()).toHaveLength(1);
        expect(witnesses()[0].args).toContain(`type=bind,src=${join(home, ".ccc", "codex")},dst=/state`);
    });

    it("a completed exact ordinary creation settles before later mount rejection and exact compensation", () => {
        const result = resultJson(run("ordinary-materialized"));
        expect(result.error).toBeTypeOf("string"); // This inert runtime intentionally supplies an invalid mount contract.
        expect(result.history).toMatchObject({coverage: "complete", pending: false, count: 1});
        expect(witnesses()).toHaveLength(1);
        const trace = readFileSync(join(root, "trace.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as {args: string[]});
        expect(trace.some(row => row.args[0] === "inspect" && row.args.includes("{{.Id}}|{{.State.Running}}") && row.args.includes(exactId))).toBe(true);
        expect(trace.filter(row => row.args[0] === "rm").map(row => row.args)).toEqual([["rm", "-f", exactId]]);
    });

    it("caller SIGKILL and a late native effect leave durable uncertainty that a later successful helper cannot clear", async () => {
        const child = spawn(process.execPath, ["--import", sourceLoader, client, "wsl-parent-death"], {
            cwd: repository, env: environment("wsl-parent-death"), stdio: ["ignore", "pipe", "pipe"],
        });
        children.add(child);
        let stderr = "";
        child.stderr?.on("data", chunk => { stderr += String(chunk); });
        await eventually(() => existsSync(join(root, "client-entered")), "owned helper dispatch");
        await eventually(() => child.signalCode !== null || child.exitCode !== null, "owned caller SIGKILL");
        expect(child.signalCode, stderr).toBe("SIGKILL");
        const interrupted = JSON.parse(readFileSync(join(home, ".ccc", "runtime-bind-authority", "history.json"), "utf8"));
        expect(interrupted.pending).toMatch(/^[a-f0-9]{32}$/);
        expect(existsSync(join(root, "late-native-effect"))).toBe(false);
        writeFileSync(join(root, "release-late-effect"), "release");
        await eventually(() => existsSync(join(root, "late-native-effect")), "late engine-side bind effect");
        const succeeded = resultJson(run("wsl-success"));
        expect(succeeded.value).toBe(true);
        expect(succeeded.history).toMatchObject({coverage: "incomplete", pending: false, count: 1});
        expect(readFileSync(join(root, "late-native-effect"), "utf8")).toBe(exactId);
        expect(witnesses()).toHaveLength(2);
    });

    it("a standalone WSL proof does not wait behind another process's held global guard or dispatch a helper", async () => {
        const holder = spawn(process.execPath, ["--import", sourceLoader, client, "hold"], {
            cwd: repository, env: environment("hold"), stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        children.add(holder);
        let held = false, output = "";
        holder.on("message", message => { if (typeof message === "object" && message !== null && "held" in message) held = true; });
        holder.stderr?.on("data", chunk => { output += String(chunk); });
        await eventually(() => held || holder.exitCode !== null || holder.signalCode !== null, "owned global holder");
        expect(held, output).toBe(true);
        const result = resultJson(run("wsl-busy"));
        expect(result.value).toBeNull();
        expect(result.elapsed).toBeTypeOf("number");
        expect(Number(result.elapsed)).toBeLessThan(1500);
        expect(witnesses()).toEqual([]);
        holder.send({release: true});
        await eventually(() => holder.exitCode !== null || holder.signalCode !== null, "owned guard release");
        expect(holder.exitCode, output).toBe(0);
    });

    it.each([{args: ["--help"]}, {args: ["--runtime", "not-a-runtime"]}])("informational or invalid CLI entry $args does not initialize CCC home", ({args}) => {
        const result = spawnSync(process.execPath, ["--import", sourceLoader, join(repository, "src", "index.ts"), ...args], {
            cwd: join(root, "project"), env: cliEnvironment(), encoding: "utf8", timeout: 20_000, killSignal: "SIGKILL",
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(args[0] === "--help" ? 0 : 1);
        if (args[0] === "--help") {
            expect(result.stdout).toContain("ccc - Claude Code Container");
            expect(result.stdout).toContain("USAGE:");
        } else {
            expect(result.stderr).toContain("Invalid --runtime value: 'not-a-runtime'. Allowed: 'docker' or 'podman'.");
        }
        expect(existsSync(join(home, ".ccc"))).toBe(false);
        expect(witnesses()).toEqual([]);
    });
    it("invalid runtime environment exits before home initialization or any runtime effect", () => {
        const result = spawnSync(process.execPath, ["--import", sourceLoader, join(repository, "src", "index.ts")], {
            cwd: join(root, "project"), env: {...cliEnvironment(), CCC_RUNTIME: "not-a-runtime"}, encoding: "utf8", timeout: 20_000,
        });
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.status, result.stderr).toBe(1);
        expect(result.stderr).toContain("Invalid CCC_RUNTIME value: 'not-a-runtime'. Allowed: 'docker' or 'podman'.");
        expect(existsSync(join(home, ".ccc"))).toBe(false);
        expect(witnesses()).toEqual([]);
    });
});
