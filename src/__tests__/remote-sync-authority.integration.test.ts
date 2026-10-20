import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Every consumer imports the coordinator's genuine emitted graph. The native
// executables are stateful fixtures; no engine, SSH host or Mutagen daemon runs.
const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
const roots: string[] = [];
type Running = { child: ChildProcess; finished: boolean; done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> };
const running: Running[] = [];
const nativeId = (character: string) => "sync_" + character.repeat(43);
interface Session {
    identifier: string; name: string; alpha: { protocol: string; path: string };
    beta: { protocol: string; user: string; host: string; path: string }; paused: boolean; status: string;
}
interface State {
    sessions: Session[]; created: number; containerId: string;
    listMode: "known" | "failure" | "malformed" | "invalid-row";
    afterCreateUnknown: boolean; holdInventory: boolean; replaceOnInteractive: boolean; invalidEndpointOnInteractive: boolean;
    busy: boolean; terminateFailure: boolean; pauseFailure: boolean; releaseFailure: boolean; holdInteractive: boolean; interactiveExitCode: number;
}
interface Call { program: string; args: string[]; role: string; targets?: string[]; cwd: string; marker: string | null; event?: string; }

const native = String.raw`
import { appendFileSync, existsSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const root = process.env.CCC_REMOTE_FIXTURE, args = process.argv.slice(2), program = basename(process.argv[1]);
const stateFile = join(root, 'state.json'), state = JSON.parse(readFileSync(stateFile, 'utf8'));
const log = extra => appendFileSync(join(root, 'trace.jsonl'), JSON.stringify({
  program, args, role: process.env.CCC_REMOTE_ROLE ?? '', cwd: process.cwd(),
  marker: process.env.CCC_REMOTE_MARKER ?? null, ...extra,
}) + '\n');
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const out = text => process.stdout.write(text);
const fail = text => { process.stderr.write(text); process.exit(1); };
const waitFor = path => {
  const deadline = performance.now() + 12000;
  while (!existsSync(path)) {
    if (performance.now() >= deadline) fail('fixture barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
if (program === 'mutagen') {
  if (args[0] === 'version') { log({}); out('mutagen version 0.17.0\n'); }
  else if (args[0] === 'daemon') log({});
  else if (args[1] === 'list') {
    log({});
    // Snapshot before the barrier: without the real project guard a competing
    // process can admit from the same proved-empty view and create a second writer.
    const snapshot = JSON.stringify(state.sessions);
    if (state.holdInventory) {
      try {
        const fd = openSync(join(root, 'inventory-held'), 'wx'); closeSync(fd);
        waitFor(join(root, 'release-inventory'));
      } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    if (state.listMode === 'failure') fail('inventory query failed');
    if (state.listMode === 'malformed') { out('not JSON'); process.exit(0); }
    if (args.includes('--template')) {
      out(state.listMode === 'invalid-row' ? JSON.stringify([...JSON.parse(snapshot), { name: 'incomplete unrelated row' }]) : snapshot);
    } else {
      // Stock name selectors may match several sessions; absence exits nonzero.
      const matches = JSON.parse(snapshot).filter(row => row.name === args[2] || row.identifier === args[2]);
      if (!matches.length) fail('unable to locate requested sessions');
      for (const row of matches) out('Name: ' + row.name + '\nIdentifier: ' + row.identifier +
        '\nAlpha:\n URL: ' + row.alpha.path + '\nBeta:\n URL: ' + row.beta.user + '@' + row.beta.host + ':' + row.beta.path +
        '\nStatus: ' + (row.paused ? 'Paused' : 'Watching for changes') + '\n');
    }
  } else if (args[1] === 'create') {
    const target = /^([^@]+)@([^:]+):(.*)$/.exec(args[3]);
    if (!target) fail('invalid fixture target');
    state.created++;
    const identifier = 'sync_' + String(state.created).padStart(43, 'A');
    state.sessions.push({ identifier, name: args[args.indexOf('--name') + 1],
      alpha: { protocol: 'local', path: args[2] },
      beta: { protocol: 'ssh', user: target[1], host: target[2], path: target[3] }, paused: false, status: 'watching' });
    if (state.afterCreateUnknown) state.listMode = 'failure';
    log({ targets: [identifier] }); save();
  } else if (['resume', 'pause', 'terminate'].includes(args[1])) {
    const selected = state.sessions.filter(row => row.identifier === args[2] || row.name === args[2]);
    log({ targets: selected.map(row => row.identifier) });
    if (args[1] === 'terminate' && state.terminateFailure || args[1] === 'pause' && state.pauseFailure) fail('native effect refused');
    if (!selected.length) fail('unable to locate requested sessions');
    if (args[1] === 'terminate') state.sessions = state.sessions.filter(row => !selected.includes(row));
    else for (const row of selected) row.paused = args[1] === 'pause';
    save();
  } else fail('unexpected Mutagen operation');
} else if (program === 'ssh') {
  if (args[0] === '-t') {
    log({});
    if (state.holdInteractive) {
      await new Promise(resolve => {
        const timer = setInterval(() => {}, 1000);
        for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
          log({ event: 'child-' + signal }); clearInterval(timer); resolve();
        });
        writeFileSync(join(root, 'interactive-held'), 'ready');
      });
    }
    if (state.replaceOnInteractive) {
      state.replaceOnInteractive = false;
      for (const row of state.sessions) row.identifier = 'sync_' + 'Z'.repeat(43);
      save();
    }
    if (state.invalidEndpointOnInteractive) {
      state.invalidEndpointOnInteractive = false;
      state.sessions.push({ identifier: 'sync_' + 'E'.repeat(43), name: 'unrelated',
        alpha: { protocol: 'local', path: '/unrelated' },
        beta: { protocol: 'local', user: '', host: '', path: 'relative/project' }, paused: false, status: 'watching' });
      save();
    }
    process.exitCode = state.interactiveExitCode;
  } else {
    const command = args.at(-1) ?? '';
    log({});
    if (command.includes('docker images -q')) {
      writeFileSync(join(root, 'image-preflight-' + (process.env.CCC_REMOTE_ROLE ?? 'single')), 'ready');
      out('sha256:fixture\n');
    }
    else if (command.includes('docker run -d')) out('ccc-container-id=' + state.containerId + '\n');
    else if (command.includes('docker stop') && state.busy) { out('ccc-remote-sessions-active\n'); process.exit(42); }
    else if (!command.includes('docker stop') && /rm -f.*\$_ccc_sessions\/[a-f0-9]{32}/.test(command) && state.releaseFailure) fail('fixture reservation release denied');
  }
} else if (program === 'ping') log({});
else fail('unexpected fixture executable');
`;

const consumer = String.raw`
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.CCC_REMOTE_FIXTURE, project = join(root, 'project');
const load = file => import(pathToFileURL(join(process.env.CCC_REMOTE_DIST, file)).href);
const api = await load('remote.js'), utils = await load('utils.js');
const config = { host: process.env.CCC_REMOTE_HOST ?? 'host-a', user: 'user', remotePath: '' };
mkdirSync(join(root, '.ccc'), { recursive: true, mode: 0o700 });
writeFileSync(join(root, '.ccc', 'config.json'), JSON.stringify({ remote: { [api.getProjectHash(project)]: config } }), { mode: 0o600 });
if (process.argv[2] === 'seed') {
  writeFileSync(join(root, 'info.json'), JSON.stringify({ projectId: utils.getProjectId(project), legacy: api.getMutagenSessionName(project) }));
} else {
  writeFileSync(join(root, 'started-' + (process.env.CCC_REMOTE_ROLE ?? 'single')), 'ready');
  try {
    if (process.argv[2] === 'embed' || process.argv[2] === 'embed-user') {
      const application = await load('application/remote-services.js'), adapter = await load('adapters/remote-services.js');
      const outcome = await application.createRemoteServices(adapter.createNativeRemoteServicesPorts()).remoteExec(project, process.argv[2] === 'embed-user' ? 'prompt-host' : undefined);
      const recorded = { kind: outcome.kind, exitCode: outcome.exitCode, reason: outcome.reason, signal: outcome.signal,
        cleanupFailures: outcome.cleanupFailures.map(failure => ({ kind: failure.kind, phase: failure.phase })) };
      writeFileSync(join(root, 'outcome.json'), JSON.stringify(recorded));
      await new Promise(resolve => setImmediate(resolve));
      writeFileSync(join(root, 'embedder-continued'), 'after core completion');
    }
    else if (process.argv[2] === 'exec') await api.remoteExec(project);
    else if (process.argv[2] === 'terminate') await api.remoteTerminate(project);
    else if (process.argv[2] === 'check') await api.remoteCheck(project);
    else throw Error('unexpected fixture action');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
`;

afterEach(async () => {
    for (const owned of running.splice(0)) {
        if (!owned.finished && owned.child.pid) {
            // This fixture created the detached group; it contains only its
            // consumer and instrumented native children.
            try { process.kill(-owned.child.pid, "SIGKILL"); } catch { /* already joined */ }
        }
        await owned.done;
    }
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "ccc-sync-authority-")); roots.push(root); chmodSync(root, 0o700);
    const bin = join(root, "bin"); mkdirSync(bin, { mode: 0o700 }); mkdirSync(join(root, "project"), { mode: 0o700 });
    const consumerPath = join(root, "consumer.mjs"); writeFileSync(consumerPath, consumer, { mode: 0o600 });
    for (const program of ["mutagen", "ssh", "ping"]) writeFileSync(join(bin, program), "#!" + process.execPath + "\n" + native, { mode: 0o700 });
    const statePath = join(root, "state.json"), tracePath = join(root, "trace.jsonl");
    const initial: State = { sessions: [], created: 0, containerId: "a".repeat(64), listMode: "known",
        afterCreateUnknown: false, holdInventory: false, replaceOnInteractive: false, invalidEndpointOnInteractive: false,
        busy: false, terminateFailure: false, pauseFailure: false, releaseFailure: false, holdInteractive: false, interactiveExitCode: 0 };
    writeFileSync(statePath, JSON.stringify(initial)); writeFileSync(tracePath, "");
    const env = { ...process.env, HOME: root, PATH: bin + ":" + (process.env.PATH ?? ""),
        CCC_REMOTE_FIXTURE: root, CCC_REMOTE_DIST: dist, CCC_REMOTE_MARKER: "captured-fixture", CCC_REMOTE_HOST: "host-a" };
    const seed = spawnSync(process.execPath, [consumerPath, "seed"], { env, cwd: join(root, "project"), encoding: "utf8", timeout: 15000, killSignal: "SIGKILL" });
    expect(seed.status, seed.stderr).toBe(0);
    const info = JSON.parse(readFileSync(join(root, "info.json"), "utf8")) as { projectId: string; legacy: string };
    const state = () => JSON.parse(readFileSync(statePath, "utf8")) as State;
    const set = (changes: Partial<State>) => writeFileSync(statePath, JSON.stringify({ ...state(), ...changes }));
    const calls = () => readFileSync(tracePath, "utf8").split("\n").filter(Boolean).map(row => JSON.parse(row) as Call);
    const clear = () => writeFileSync(tracePath, "");
    const start = (action = "exec", answer: string | null = "n", overrides: NodeJS.ProcessEnv = {}) => {
        const child = spawn(process.execPath, [consumerPath, action], { env: { ...env, ...overrides }, cwd: join(root, "project"), detached: true, stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "", stderr = "", answered = false;
        const owned: Running = { child, finished: false, done: new Promise((resolve, reject) => {
            child.stdout!.on("data", data => {
                stdout += String(data);
                if (answer !== null && !answered && stdout.includes("Stop container and pause sync?")) { answered = true; child.stdin!.end(answer + "\n"); }
            });
            child.stderr!.on("data", data => { stderr += String(data); });
            child.once("error", reject);
            child.once("close", (code, signal) => { owned.finished = true; resolve({ code, signal, stdout, stderr }); });
        }) };
        running.push(owned); return owned;
    };
    const run = (action = "exec", answer: string | null = "n", overrides: NodeJS.ProcessEnv = {}) => start(action, answer, overrides).done;
    const record = (name = info.legacy): Session => ({ identifier: nativeId("x"), name,
        alpha: { protocol: "local", path: join(root, "project") },
        beta: { protocol: "ssh", user: "user", host: "host-a", path: "docker://" + initial.containerId + "/project/" + info.projectId },
        paused: false, status: "watching" });
    return { root, env, consumerPath, info, state, set, calls, clear, start, run, record };
}
function mutations(calls: Call[]) { return calls.filter(call => call.program === "mutagen" && ["create", "resume", "pause", "terminate"].includes(call.args[1])); }
async function waitFile(file: string) {
    const deadline = performance.now() + 10000;
    while (!existsSync(file)) {
        if (performance.now() >= deadline) throw Error("fixture did not publish " + file);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

const promptStreamConsumer = [
    "import { join } from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    "const { createNativeRemoteServicesPorts } = await import(pathToFileURL(join(process.env.CCC_PROMPT_DIST, 'adapters/remote-services.js')).href);",
    "const interrupt = () => { throw Error('unexpected interrupt on a pipe'); };",
    "const deadline = setTimeout(() => { console.error('native prompt did not settle'); process.exit(71); }, 3000);",
    "let recorded;",
    "if (process.argv[2] === 'overlap') {",
    " const first = createNativeRemoteServicesPorts().prompt({ kind: 'user', defaultUser: 'first' }, interrupt);",
    " const second = createNativeRemoteServicesPorts().prompt({ kind: 'user', defaultUser: 'second' }, interrupt);",
    " first.cancel();",
    " const cancelled = await first.result, answer = await second.result;",
    " recorded = { cancelled, answer };",
    "} else {",
    " const first = createNativeRemoteServicesPorts().prompt({ kind: 'user', defaultUser: 'first' }, interrupt);",
    " const firstAnswer = await first.result;",
    " const second = createNativeRemoteServicesPorts().prompt({ kind: 'cleanup' }, interrupt);",
    " recorded = { first: firstAnswer, second: await second.result, ended: process.stdin.readableEnded };",
    "}",
    "clearTimeout(deadline); process.stdin.destroy();",
    "console.log('STREAM_RESULT=' + JSON.stringify(recorded));",
].join("\n");

describe("emitted native prompts with a real input pipe", () => {
    it.each(["overlap", "EOF"] as const)("settles %s readers without losing input or waiting on an ended stream", action => {
        const root = mkdtempSync(join(tmpdir(), "ccc-prompt-stream-")); roots.push(root);
        const entry = join(root, "consumer.mjs"); writeFileSync(entry, promptStreamConsumer);
        const result = spawnSync(process.execPath, [entry, action], {
            env: { ...process.env, HOME: root, CCC_PROMPT_DIST: dist }, cwd: root,
            input: action === "overlap" ? "hello\n" : "", encoding: "utf8", timeout: 5000, killSignal: "SIGKILL",
        });
        expect(result.status, result.stderr + result.stdout).toBe(0);
        const recorded = JSON.parse(result.stdout.split("STREAM_RESULT=").at(-1)!.trim());
        expect(recorded).toEqual(action === "overlap" ? { cancelled: "", answer: "hello" } : { first: "", second: "", ended: true });
    }, 10000);
});

const promptPty = [
    "import errno,json,os,pty,select,signal,sys,time",
    "node,entry,action,question=sys.argv[1:]",
    "pid,master=pty.fork()",
    "if pid==0: os.execve(node,[node,entry,action],dict(os.environ))",
    "output=b''; sent=False; ended=False; status=None; deadline=time.monotonic()+12",
    "try:",
    " while time.monotonic()<deadline:",
    "  if ended: time.sleep(0.01)",
    "  if not ended and select.select([master],[],[],0.05)[0]:",
    "   try: chunk=os.read(master,65536)",
    "   except OSError as error:",
    "    if error.errno!=errno.EIO: raise",
    "    chunk=b''",
    "   if not chunk: ended=True",
    "   output+=chunk",
    "   if question.encode() in output and not sent: os.write(master,b'\\x03'); sent=True",
    "  observed,value=os.waitpid(pid,os.WNOHANG)",
    "  if observed: status=value; break",
    "finally:",
    " if status is None:",
    "  observed,value=os.waitpid(pid,os.WNOHANG)",
    "  if observed: status=value",
    "  else:",
    "   try: os.killpg(pid,signal.SIGKILL)",
    "   except ProcessLookupError: pass",
    "   _,status=os.waitpid(pid,0)",
    " os.close(master)",
    "print(json.dumps({'sent':sent,'exitCode':os.waitstatus_to_exitcode(status),'output':output.decode('utf8','replace')}))",
].join("\n");

describe.runIf(process.platform !== "win32")("emitted remote sync authority with native ports", () => {
    it.each(["user", "cleanup"] as const)("terminal Ctrl-C cancels the real %s reader before later remote effects", kind => {
        const f = fixture(), configPath = join(f.root, ".ccc", "config.json"), saved = readFileSync(configPath, "utf8");
        const result = spawnSync("python3", ["-c", promptPty, process.execPath, f.consumerPath, kind === "user" ? "embed-user" : "embed", kind === "user" ? "Remote user [" : "Stop container and pause sync?"], {
            env: { ...f.env, TERM: "xterm-256color" }, cwd: join(f.root, "project"), encoding: "utf8", timeout: 15000, killSignal: "SIGKILL",
        });
        expect(result.status, result.stderr).toBe(0);
        const terminal = JSON.parse(result.stdout) as { sent: boolean; exitCode: number; output: string };
        expect(terminal.sent, terminal.output).toBe(true); expect(terminal.exitCode, terminal.output).toBe(0);
        expect(JSON.parse(readFileSync(join(f.root, "outcome.json"), "utf8"))).toEqual({ kind: "cancelled", signal: "SIGINT", cleanupFailures: [] });
        expect(existsSync(join(f.root, "embedder-continued"))).toBe(true); expect(readFileSync(configPath, "utf8")).toBe(saved);
        expect(f.calls().some(call => call.program === "ssh" && call.args.some(argument => argument.includes("docker stop")))).toBe(false);
        expect(mutations(f.calls()).some(call => call.args[1] === "pause")).toBe(false);
        if (kind === "user") {
            expect(f.calls().some(call => call.program === "ssh")).toBe(false); expect(f.state().created).toBe(0);
            expect(terminal.output).not.toContain("Config saved.");
        }
    }, 20000);

    it("serializes two independent public callers with the real existing project guard and creates one writer", async () => {
        const f = fixture(); f.set({ holdInventory: true });
        const first = f.start("exec", "n", { CCC_REMOTE_ROLE: "first" }); await waitFile(join(f.root, "inventory-held"));
        const second = f.start("exec", "n", { CCC_REMOTE_ROLE: "second" }); await waitFile(join(f.root, "image-preflight-second"));
        await new Promise(resolve => setTimeout(resolve, 1000));
        expect(f.calls().filter(call => call.program === "mutagen" && call.args[1] === "list")).toHaveLength(1);
        writeFileSync(join(f.root, "release-inventory"), "continue");
        const results = await Promise.all([first.done, second.done]);
        expect(results.map(result => result.code), results.map(result => result.stderr).join("\n")).toEqual([0, 0]);
        expect(f.state().created).toBe(1); expect(f.state().sessions).toHaveLength(1);
        expect(mutations(f.calls()).map(call => call.args[1])).toEqual(["create"]);
        for (const call of f.calls().filter(call => call.program === "mutagen")) expect(call).toMatchObject({ cwd: join(f.root, "project"), marker: "captured-fixture" });
    }, 30000);

    it.each(["failure", "malformed", "invalid-row"] as const)("refuses %s inventory with zero Mutagen effects", async listMode => {
        const f = fixture(); f.set({ listMode });
        const result = await f.run();
        expect(mutations(f.calls())).toEqual([]); expect(f.state().created).toBe(0); expect(result.code).toBe(1);
    }, 20000);

    it.each(["create", "resume", "cleanup", "terminate"] as const)("rejects incompatible unrelated endpoint inventory before %s effects", async action => {
        const f = fixture();
        if (action !== "create") expect((await f.run()).code).toBe(0);
        const selected = f.state().sessions.map(row => ({ ...row, paused: action === "resume" }));
        const unrelated: Session = { ...f.record("unrelated"), identifier: nativeId("E"), alpha: { protocol: "local", path: "/unrelated" },
            beta: { protocol: "local", user: "", host: "", path: "relative/project" } };
        f.set(action === "cleanup" ? { sessions: selected, invalidEndpointOnInteractive: true } : { sessions: [...selected, unrelated] });
        f.clear(); const result = await f.run(action === "terminate" ? "terminate" : "exec", "y");
        expect(mutations(f.calls())).toEqual([]);
        expect(f.state().sessions).toEqual([...selected, unrelated]);
        expect(result.code).toBe(1); expect(result.stdout).not.toContain("Sync terminated.");
        if (action === "cleanup") expect(f.calls().some(call => call.program === "ssh" && call.args.some(arg => arg.includes("docker stop")))).toBe(true);
    }, 20000);

    it("rejects a malformed unrelated name that shadows the public termination identifier", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0); const selected = f.state().sessions[0];
        const shadow = { ...f.record(selected.identifier), identifier: nativeId("S"), alpha: { protocol: "local", path: "/unrelated" },
            beta: { ...selected.beta, host: "foreign-host" } };
        f.set({ sessions: [selected, shadow] }); f.clear(); const result = await f.run("terminate");
        // A native name selector can alias an identifier. Neither row may be
        // controlled when complete inventory contains that impossible name.
        expect(mutations(f.calls())).toEqual([]); expect(f.state().sessions).toEqual([selected, shadow]);
        expect(result.code).toBe(1); expect(result.stdout).not.toContain("Sync terminated.");
    }, 20000);

    it("protects legacy unscoped sessions without resuming, terminating, creating or pausing", async () => {
        const f = fixture(), legacy = f.record(); legacy.paused = true; f.set({ sessions: [legacy] });
        const result = await f.run("exec", "y");
        expect(mutations(f.calls())).toEqual([]); expect(f.state().sessions).toEqual([legacy]); expect(result.code).toBe(1);
    }, 20000);

    it("refuses duplicate nonunique scoped names rather than choosing or controlling both", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0);
        const first = f.state().sessions[0], second = { ...first, identifier: nativeId("d"), paused: true };
        f.set({ sessions: [first, second] }); f.clear();
        const result = await f.run("exec", "y");
        expect(mutations(f.calls())).toEqual([]); expect(f.state().sessions).toEqual([first, second]); expect(result.code).toBe(1);
    }, 20000);

    it("isolates different configured hosts for the same local project", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0);
        const hostA = f.state().sessions[0]; f.clear();
        const result = await f.run("exec", "n", { CCC_REMOTE_HOST: "host-b" });
        expect(result.code, result.stderr).toBe(0); expect(f.state().sessions).toHaveLength(2);
        expect(f.state().sessions.find(row => row.identifier === hostA.identifier)).toEqual(hostA);
        expect(new Set(f.state().sessions.map(row => row.name)).size).toBe(2);
        expect(mutations(f.calls()).map(call => call.args[1])).toEqual(["create"]);
    }, 20000);

    it.each(["user", "host", "root"] as const)("refuses a scoped record with foreign %s binding without effects", async field => {
        const f = fixture(); expect((await f.run()).code).toBe(0);
        const before = f.state().sessions[0];
        const foreign = { ...before, alpha: { ...before.alpha }, beta: { ...before.beta } };
        if (field === "root") foreign.alpha.path = join(f.root, "other-project"); else foreign.beta[field] = "foreign";
        f.set({ sessions: [foreign] }); f.clear(); const result = await f.run("exec", "y");
        expect(mutations(f.calls())).toEqual([]); expect(f.state().sessions).toEqual([foreign]); expect(result.code).toBe(1);
    }, 20000);

    it("resumes and pauses only the captured unique identifier after the exact container stops", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0);
        const before = f.state().sessions[0]; f.set({ sessions: [{ ...before, paused: true }] }); f.clear();
        const result = await f.run("exec", "y"); expect(result.code, result.stderr).toBe(0);
        expect(mutations(f.calls())).toEqual([
            expect.objectContaining({ args: ["sync", "resume", before.identifier], targets: [before.identifier] }),
            expect.objectContaining({ args: ["sync", "pause", before.identifier], targets: [before.identifier] }),
        ]);
        const calls = f.calls();
        const stopAt = calls.findIndex(call => call.program === "ssh" && call.args.some(arg => arg.includes("docker stop")));
        const pauseAt = calls.findIndex(call => call.program === "mutagen" && call.args[1] === "pause");
        expect(stopAt).toBeGreaterThanOrEqual(0); expect(stopAt).toBeLessThan(pauseAt);
        expect(calls.slice(stopAt + 1, pauseAt).some(call => call.program === "mutagen" && call.args[1] === "list")).toBe(true);
    }, 20000);

    it("replaces only same-authority container changes using the old unique identifier", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0); const before = f.state().sessions[0];
        f.set({ containerId: "b".repeat(64) }); f.clear();
        const result = await f.run();
        expect(result.code, result.stderr).toBe(0);
        expect(mutations(f.calls()).map(call => call.args[1])).toEqual(["terminate", "create"]);
        expect(mutations(f.calls())[0]).toMatchObject({ args: ["sync", "terminate", before.identifier], targets: [before.identifier] });
        expect(f.state().sessions[0].beta.path).toContain("docker://" + "b".repeat(64) + "/project/");
    }, 20000);

    it("requires exact post-create proof and never guesses destructive compensation or retries", async () => {
        const f = fixture(); f.set({ afterCreateUnknown: true }); const result = await f.run();
        expect(mutations(f.calls()).map(call => call.args[1])).toEqual(["create"]);
        expect(f.state().created).toBe(1); expect(f.state().sessions).toHaveLength(1); expect(result.code).toBe(1);
    }, 20000);

    it("preserves a same-name successor installed during SSH instead of pausing it at cleanup", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0); f.set({ replaceOnInteractive: true }); f.clear();
        const result = await f.run("exec", "y");
        expect(f.calls().some(call => call.program === "ssh" && call.args.some(arg => arg.includes("docker stop")))).toBe(true);
        expect(mutations(f.calls())).toEqual([]);
        expect(f.state().sessions[0]).toMatchObject({ identifier: nativeId("Z"), paused: false }); expect(result.code, result.stderr).toBe(0);
    }, 20000);

    it("preserves sync when exact container stop reports a busy peer", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0); const before = f.state().sessions;
        f.set({ busy: true }); f.clear(); const result = await f.run("exec", "y");
        expect(mutations(f.calls())).toEqual([]); expect(f.state().sessions).toEqual(before); expect(result.code, result.stderr).toBe(0);
    }, 20000);

    it("public termination selects the observed identifier and does not announce failed completion", async () => {
        const f = fixture(); expect((await f.run()).code).toBe(0); const before = f.state().sessions[0];
        f.set({ terminateFailure: true }); f.clear(); const refused = await f.run("terminate");
        expect(mutations(f.calls())).toEqual([expect.objectContaining({ args: ["sync", "terminate", before.identifier], targets: [before.identifier] })]);
        expect(refused.code).toBe(1); expect(refused.stdout).not.toContain("Sync terminated."); expect(f.state().sessions).toEqual([before]);
        f.set({ terminateFailure: false }); f.clear(); const completed = await f.run("terminate");
        expect(completed.code, completed.stderr).toBe(0); expect(completed.stdout).toContain("Sync terminated."); expect(f.state().sessions).toEqual([]);
    }, 20000);
    it("returns a nonzero session completion to a continuing embedder while the public facade preserves its status", async () => {
        const embedded = fixture(); embedded.set({ interactiveExitCode: 17 });
        const returned = await embedded.run("embed");
        expect(returned.code, returned.stderr).toBe(0); expect(existsSync(join(embedded.root, "embedder-continued"))).toBe(true);
        expect(JSON.parse(readFileSync(join(embedded.root, "outcome.json"), "utf8"))).toEqual({ kind: "completed", exitCode: 17, cleanupFailures: [] });
        const cli = fixture(); cli.set({ interactiveExitCode: 17 }); const exited = await cli.run();
        expect(exited.code, exited.stderr).toBe(17); expect(exited.signal).toBeNull();
    }, 20000);

    it("returns expected failure and checked release evidence without terminating the embedder", async () => {
        const f = fixture(); f.set({ listMode: "failure", releaseFailure: true }); const result = await f.run("embed");
        expect(result.code, result.stderr).toBe(0); expect(existsSync(join(f.root, "embedder-continued"))).toBe(true);
        expect(JSON.parse(readFileSync(join(f.root, "outcome.json"), "utf8"))).toEqual({ kind: "failed", reason: "sync-unknown", cleanupFailures: [{ kind: "release-failed" }] });
        expect(f.calls().some(call => call.program === "ssh" && call.args[0] === "-t")).toBe(false);
    }, 20000);

    it("projects failed required cleanup as CLI failure after a successful session", async () => {
        const f = fixture(); f.set({ releaseFailure: true }); const result = await f.run();
        expect(result.code).toBe(1); expect(result.stderr).toContain("fixture reservation release denied");
    }, 20000);

    it.each(["SIGINT", "SIGTERM"] as const)("joins native SSH and preserves %s once at the public boundary", async signal => {
        const f = fixture(); f.set({ holdInteractive: true }); const execution = f.start();
        await waitFile(join(f.root, "interactive-held")); expect(execution.child.kill(signal)).toBe(true);
        const result = await execution.done; expect(result.code, result.stderr).toBeNull(); expect(result.signal).toBe(signal);
        expect(f.calls().filter(call => call.event === "child-" + signal)).toHaveLength(1);
        expect(mutations(f.calls()).some(call => call.args[1] === "pause")).toBe(false);
    }, 20000);

    it("returns signal cancellation to its continuing native embedder after joining SSH", async () => {
        const f = fixture(); f.set({ holdInteractive: true }); const execution = f.start("embed");
        await waitFile(join(f.root, "interactive-held")); expect(execution.child.kill("SIGTERM")).toBe(true);
        const result = await execution.done; expect(result.code, result.stderr).toBe(0); expect(result.signal).toBeNull();
        expect(JSON.parse(readFileSync(join(f.root, "outcome.json"), "utf8"))).toEqual({ kind: "cancelled", signal: "SIGTERM", cleanupFailures: [] });
        expect(existsSync(join(f.root, "embedder-continued"))).toBe(true); expect(f.calls().filter(call => call.event === "child-SIGTERM")).toHaveLength(1);
    }, 20000);

});
