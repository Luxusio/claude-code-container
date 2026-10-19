import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Use the normal build output, with an explicit override for isolated graphs.
// This fixture never substitutes Source modules for genuine emitted code.
const distribution = process.env.CCC_NATIVE_RUNTIME_AUTHORITY_DIST ?? fileURLToPath(new URL("../../../dist/", import.meta.url));
if (!isAbsolute(distribution)) throw new Error("CCC_NATIVE_RUNTIME_AUTHORITY_DIST must be absolute");
const exactId = "a".repeat(64);
const endpointA = "tcp://engine-a.fixture:2376";
const endpointB = "tcp://engine-b.fixture:2376";
const selectors = [
    "PATH", "PATHEXT", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "DOCKER_CONFIG", "DOCKER_CONTEXT",
    "DOCKER_HOST", "DOCKER_TLS", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "DOCKER_API_VERSION",
    "DOCKER_SSH_COMMAND", "SSH_AUTH_SOCK", "CONTAINER_HOST", "CONTAINER_CONNECTION", "CONTAINER_SSHKEY",
    "CONTAINER_PROXY", "PODMAN_CONNECTIONS_CONF", "CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE",
    "CONTAINERS_CONF_MODULE", "CONTAINERS_STORAGE_CONF", "STORAGE_DRIVER", "STORAGE_OPTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
] as const;

interface Trace { executable: "A" | "B"; args: string[]; endpoint: string; command: string; id?: string; }
interface Owner { child: ChildProcess; messages: Array<Record<string, unknown>>; output: string; }

async function eventually(predicate: () => boolean, description: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for " + description);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
}

describe.skipIf(process.platform !== "linux")("emitted native session cleanup retains runtime authority", () => {
    let root: string;
    let home: string;
    let binA: string;
    let binB: string;
    let alias: string;
    let log: string;
    let state: string;
    let failures: string;
    let ownerScript: string;
    const owners: Owner[] = [];
    const guardians = new Map<number, string>();

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-session-authority-"));
        home = join(root, "home");
        binA = join(root, "bin-a");
        binB = join(root, "bin-b");
        for (const path of [home, binA, binB, join(root, "project"), join(root, "config-a"), join(root, "config-b")]) {
            mkdirSync(path, { recursive: true });
        }
        alias = join(root, "context-endpoint");
        log = join(root, "native.jsonl");
        state = join(root, "engines.json");
        failures = join(root, "remaining-stop-failures");
        writeFileSync(alias, endpointA);
        writeFileSync(log, "");
        writeFileSync(failures, "0");
        writeFileSync(state, JSON.stringify({ [endpointA]: { [exactId]: true }, [endpointB]: { [exactId]: true } }));
        for (const [bin, executable] of [[binA, "A"], [binB, "B"]] as const) {
            const file = join(bin, "docker");
            writeFileSync(file, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const raw = process.argv.slice(2);
let offset = 0, host, tls, verify, ca, cert, key;
while (offset < raw.length) {
    const arg = raw[offset];
    if (arg === '--config') { offset += 2; continue; }
    if (arg === '--host') { host = raw[offset + 1]; offset += 2; continue; }
    if (arg.startsWith('--tls=')) tls = arg.slice(6);
    else if (arg.startsWith('--tlsverify=')) verify = arg.slice(12);
    else if (arg.startsWith('--tlscacert=')) ca = arg.slice(12);
    else if (arg.startsWith('--tlscert=')) cert = arg.slice(10);
    else if (arg.startsWith('--tlskey=')) key = arg.slice(9);
    else break;
    offset++;
}
const args = raw.slice(offset);
const endpoint = host || process.env.DOCKER_HOST || readFileSync(${JSON.stringify(alias)}, 'utf8');
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ executable: ${JSON.stringify(executable)}, args: raw, endpoint, command: args[0], id: args[1] }) + '\\n');
if (args[0] === 'context' && args[1] === 'inspect') {
    console.log(JSON.stringify({ Name: 'mutable', Endpoints: { docker: { Host: readFileSync(${JSON.stringify(alias)}, 'utf8'), SkipTLSVerify: false } },
        TLSMaterial: { docker: ['ca.pem', 'cert.pem', 'key.pem'] }, Storage: { TLSPath: ${JSON.stringify(join(root, "tls"))} } }));
} else if (args[0] === '--version') console.log('Docker version 27.1.1');
else if (args[0] === 'info' && args[2] === '{{.OperatingSystem}}') console.log('Linux');
else if (args[0] === 'info' && args[2] === '{{json .SecurityOptions}}') console.log('[]');
else if (args[0] === 'stop') {
    // Both fake executables interpret native transport flags. Executable A
    // alone is insufficient if an invocation accidentally follows alias B.
    // An ordinary unbound native call follows the mutable ambient context,
    // including its TLS defaults; a compatible old build can really stop B.
    // Explicit replay must carry the captured TLS references faithfully.
    if (host && (tls !== 'true' || verify !== 'true' ||
        ca !== ${JSON.stringify(join(root, "tls", "docker", "ca.pem"))} ||
        cert !== ${JSON.stringify(join(root, "tls", "docker", "cert.pem"))} ||
        key !== ${JSON.stringify(join(root, "tls", "docker", "key.pem"))})) process.exit(91);
    const remaining = Number(readFileSync(${JSON.stringify(failures)}, 'utf8'));
    if (remaining > 0) { writeFileSync(${JSON.stringify(failures)}, String(remaining - 1)); process.exit(73); }
    const engines = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
    if (!engines[endpoint] || !Object.hasOwn(engines[endpoint], args[1])) process.exit(92);
    engines[endpoint][args[1]] = false;
    writeFileSync(${JSON.stringify(state)}, JSON.stringify(engines));
} else process.exit(93);
`);
            chmodSync(file, 0o700);
        }
        const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(join(distribution!, file)).href);
        ownerScript = join(root, "owner.mjs");
        writeFileSync(ownerScript, `
import * as runtime from ${moduleUrl("container-runtime.js")};
import { createSessionLock, setSession, setSessionContainerId, setSessionCleanupEnabled, setupSignalHandlers,
    armSessionOwnership, confirmSessionOwnership, cleanupSession } from ${moduleUrl("session.js")};
import { getProjectId } from ${moduleUrl("utils.js")};
import { writeFileSync } from 'node:fs';
const mode = process.argv[2], project = ${JSON.stringify(join(root, "project"))};
runtime.setRuntimeOverride('docker');
let lock;
const prepare = async () => {
    lock = createSessionLock(getProjectId(project));
    setSession(lock, project);
    setSessionContainerId(${JSON.stringify(exactId)});
};
// Keep the same public entrypoint executable in a compatible old build: its
// failure must be an observable engine-B stop, never a missing-export error.
if (typeof runtime.runWithNativeRuntimeInvocation === 'function') {
    await runtime.runWithNativeRuntimeInvocation(runtime.getRuntimeInvocation(), prepare);
} else await prepare();
writeFileSync(${JSON.stringify(alias)}, ${JSON.stringify(endpointB)});
process.env.PATH = ${JSON.stringify(binB + ":" + dirname(process.execPath) + ":/usr/bin:/bin")};
process.env.DOCKER_CONTEXT = 'redefined';
process.env.DOCKER_HOST = ${JSON.stringify(endpointB)};
process.env.DOCKER_CONFIG = ${JSON.stringify(join(root, "config-b"))};
runtime.setRuntimeOverride('docker');
// Both guardian launch and signal registration occur after the native scope
// returned, with ambient PATH, alias and configuration selecting engine B.
const guardian = await armSessionOwnership();
setupSignalHandlers();
setSessionCleanupEnabled(true);
await confirmSessionOwnership();
if (mode === 'revoked') { setSessionCleanupEnabled(false); await confirmSessionOwnership(); }
process.send({ event: 'ready', lock, guardian });
process.on('message', async message => {
    if (message.event === 'eof') process.exit(0);
    if (message.event === 'cleanup') {
        try { cleanupSession(); process.send({ event: 'cleaned' }); process.exit(0); }
        catch { process.send({ event: 'retry', retained: true }); }
    }
});
`);
    });

    function token(pid: number): string | undefined {
        try {
            const stat = readFileSync("/proc/" + pid + "/stat", "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
            return fields[0] === "Z" || fields[0] === "X" ? undefined : fields[19];
        } catch { return undefined; }
    }

    afterEach(async () => {
        for (const { child } of owners) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        for (const { child } of owners) await eventually(() => child.exitCode !== null || child.signalCode !== null, "owned parent exit");
        for (const [pid, identity] of guardians) {
            if (token(pid) === identity) process.kill(pid, "SIGKILL");
            await eventually(() => token(pid) !== identity, "owned guardian exit");
        }
        owners.length = 0;
        guardians.clear();
        rmSync(root, { recursive: true, force: true });
    });

    function launch(mode: string): Owner {
        const child = spawn(process.execPath, [ownerScript, mode], {
            cwd: root,
            env: { HOME: home, USERPROFILE: home, PATH: binA + ":" + dirname(process.execPath) + ":/usr/bin:/bin",
                DOCKER_CONTEXT: "mutable", DOCKER_CONFIG: join(root, "config-a"),
                TMPDIR: root, TMP: root, TEMP: root, CCC_DEVICE_BROKER_AUTO_START: "0" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const owner: Owner = { child, messages: [], output: "" };
        owners.push(owner);
        child.stdout!.on("data", chunk => { owner.output += String(chunk); });
        child.stderr!.on("data", chunk => { owner.output += String(chunk); });
        child.on("error", error => { owner.output += error.message; });
        child.on("message", value => {
            const message = value as Record<string, unknown>;
            owner.messages.push(message);
            if (message.event === "ready") {
                const pid = Number(message.guardian);
                const identity = token(pid);
                if (identity) guardians.set(pid, identity);
            }
        });
        return owner;
    }

    async function frame(owner: Owner, event: string): Promise<Record<string, unknown>> {
        await eventually(() => {
            if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error("Owner exited before " + event + ": " + owner.output);
            return owner.messages.some(message => message.event === event);
        }, event);
        return owner.messages.find(message => message.event === event)!;
    }

    const trace = (): Trace[] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Trace);
    const stops = (): Trace[] => trace().filter(call => call.command === "stop");
    const engineState = () => JSON.parse(readFileSync(state, "utf8")) as Record<string, Record<string, boolean>>;
    function expectOnlyAStopped(attempts: number): void {
        expect(stops()).toHaveLength(attempts);
        for (const stop of stops()) {
            expect(stop.executable).toBe("A");
            expect(stop.endpoint).toBe(endpointA);
            expect(stop.id).toBe(exactId);
            expect(stop.args).toContain("--tlsverify=true");
            expect(stop.args).toContain("--tlscacert=" + join(root, "tls", "docker", "ca.pem"));
        }
        expect(engineState()[endpointA]![exactId]).toBe(false);
        expect(engineState()[endpointB]![exactId]).toBe(true);
        expect(trace().filter(call => call.command === "context")).toHaveLength(1);
    }

    it("normal host cleanup and retry outside the completed native scope retain A after ambient B", async () => {
        writeFileSync(failures, "1");
        const owner = launch("host");
        const ready = await frame(owner, "ready");
        expect(readFileSync(alias, "utf8")).toBe(endpointB);
        owner.child.send({ event: "cleanup" });
        await frame(owner, "retry");
        expect(existsSync(String(ready.lock))).toBe(true);
        expect(stops()).toHaveLength(1);
        expect(stops()[0]!.endpoint).toBe(endpointA);
        owner.child.send({ event: "cleanup" });
        await eventually(() => owner.child.exitCode !== null, "successful host cleanup");
        expect(owner.child.exitCode, owner.output).toBe(0);
        await eventually(() => token(Number(ready.guardian)) === undefined, "released guardian");
        expect(existsSync(String(ready.lock))).toBe(false);
        expectOnlyAStopped(2);
    });

    it("signal callback registered outside the native scope stops only the original engine A", async () => {
        const owner = launch("signal");
        const ready = await frame(owner, "ready");
        owner.child.kill("SIGTERM");
        await eventually(() => owner.child.exitCode !== null || owner.child.signalCode !== null, "signal cleanup exit");
        expect(owner.child.signalCode, owner.output).toBeNull();
        expect(owner.child.exitCode, owner.output).toBe(0);
        await eventually(() => token(Number(ready.guardian)) === undefined, "signal guardian release");
        expect(existsSync(String(ready.lock))).toBe(false);
        expectOnlyAStopped(1);
    });

    it.each([0, 1])("actual guardian EOF replays A with unchanged target after ambient B (failures %s)", async failureCount => {
        writeFileSync(failures, String(failureCount));
        const owner = launch("guardian");
        const ready = await frame(owner, "ready");
        owner.child.send({ event: "eof" });
        await eventually(() => owner.child.exitCode !== null, "parent EOF");
        await eventually(() => !existsSync(String(ready.lock)), "autonomous captured cleanup");
        await eventually(() => token(Number(ready.guardian)) === undefined, "guardian cleanup exit");
        expectOnlyAStopped(1 + failureCount);
    });

    it("acknowledged revocation before EOF releases only the receipt and preserves both identical IDs", async () => {
        const owner = launch("revoked");
        const ready = await frame(owner, "ready");
        owner.child.send({ event: "eof" });
        await eventually(() => !existsSync(String(ready.lock)), "revoked receipt rollback");
        await eventually(() => token(Number(ready.guardian)) === undefined, "revoked guardian exit");
        expect(stops()).toEqual([]);
        expect(engineState()[endpointA]![exactId]).toBe(true);
        expect(engineState()[endpointB]![exactId]).toBe(true);
    });

    it.each(["unknown", "oversized", "malformed"] as const)("actual guardian refuses %s native initialization before READY or dispatch", async invalid => {
        const directory = join(home, ".ccc", "run", "locks");
        mkdirSync(directory, { recursive: true });
        const projectPath = join(root, "project");
        const projectId = "project-" + createHash("sha256").update(projectPath).digest("hex").slice(0, 12);
        const lock = join(directory, projectId + "--owner.lock");
        writeFileSync(lock, String(process.pid));
        const stat = lstatSync(lock, { bigint: true });
        const receipt = { path: lock, bytes: Buffer.from(String(process.pid)).toString("base64"),
            device: String(stat.dev), inode: String(stat.ino), birthtime: String(stat.birthtimeNs), ownerPid: process.pid };
        const invocation = {
            version: 1, runtime: "docker", executable: join(binA, "docker"),
            transport: { kind: "docker", host: endpointA, configDirectory: join(root, "config-a"),
                tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
            selectors: Object.fromEntries(selectors.map(key => [key, key === "HOME" || key === "USERPROFILE" ? home : null])),
        };
        const candidate = invalid === "unknown" ? { ...invocation, argv: ["--host", endpointB], secret: "fixture-private-native-secret" }
            : invalid === "oversized" ? { ...invocation, transport: { ...invocation.transport, host: "x".repeat(8193) } }
            : { ...invocation, version: "1" };
        const child = spawn(process.execPath, [join(distribution!, "session-ownership-guardian.js"), String(process.pid)], {
            cwd: root, env: { HOME: home, USERPROFILE: home, PATH: binB, CCC_DEVICE_BROKER_AUTO_START: "0" },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const owner: Owner = { child, messages: [], output: "" };
        owners.push(owner);
        child.stdout!.on("data", chunk => { owner.output += String(chunk); });
        child.stderr!.on("data", chunk => { owner.output += String(chunk); });
        child.on("message", message => { owner.messages.push(message as Record<string, unknown>); });
        child.send({ type: "init", binding: { lockFile: lock, projectPath }, receipt, runtimeInvocation: candidate });
        await eventually(() => child.exitCode !== null, "invalid initialization exit");
        expect(child.exitCode, owner.output).toBe(1);
        expect(owner.messages.map(message => message.type)).toEqual(["error"]);
        expect(trace()).toEqual([]);
        expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
        expect(owner.output).not.toContain("fixture-private-native-secret");
        expect(owner.output).not.toContain(root);
        expect(owner.output.length).toBeLessThan(2048);
    });
});
