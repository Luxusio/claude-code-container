import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

interface Trace { executable: "A" | "B"; args: string[]; endpoint: string; command: string; id?: string; claimsAtStop?: string[]; }
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
    let ipcFaultPreload: string;
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
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
const lockDirectory = ${JSON.stringify(join(home, ".ccc", "run", "locks"))};
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ executable: ${JSON.stringify(executable)}, args: raw, endpoint, command: args[0], id: args[1],
    ...(args[0] === 'stop' ? {claimsAtStop: readdirSync(lockDirectory).filter(name => name.endsWith('.lock')).sort()} : {}) }) + '\\n');
if (args[0] === 'context' && args[1] === 'inspect') {
    console.log(JSON.stringify({ Name: 'mutable', Endpoints: { docker: { Host: readFileSync(${JSON.stringify(alias)}, 'utf8'), SkipTLSVerify: false } },
        TLSMaterial: { docker: ['ca.pem', 'cert.pem', 'key.pem'] }, Storage: { TLSPath: ${JSON.stringify(join(root, "tls"))} } }));
} else if (args[0] === '--version') console.log('Docker version 27.1.1');
else if (args[0] === 'info' && args[2] === '{{.OperatingSystem}}') console.log('Linux');
else if (args[0] === 'info' && args[2] === '{{json .SecurityOptions}}') console.log('[]');
else if (args[0] === 'ps') {
    const requested = args[4]?.slice(3);
    if (!/^[a-f0-9]{64}$/.test(requested || '')
        || JSON.stringify(args) !== JSON.stringify(['ps', '-aq', '--no-trunc', '-f', 'id=' + requested])) process.exit(95);
    const engines = JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8'));
    if (engines[endpoint] && Object.hasOwn(engines[endpoint], requested)) console.log(requested);
}
else if (args[0] === 'stop') {
    writeFileSync(${JSON.stringify(join(root, "stop-entered"))}, String(process.pid));
    const deadline = Date.now() + 15000;
    while (existsSync(${JSON.stringify(join(root, "hold-stop"))})) {
        if (Date.now() > deadline) process.exit(94);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
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
        ipcFaultPreload = join(root, "reject-one-update.cjs");
        writeFileSync(ipcFaultPreload, `
const cp = require('node:child_process');
const fs = require('node:fs');
const originalSpawn = cp.spawn;
cp.spawn = function(command, args, options) {
    const child = originalSpawn.apply(this, arguments);
    if (process.argv[1] === ${JSON.stringify(ownerScript)} && Array.isArray(args) && args.includes(${JSON.stringify(join(distribution, "session-ownership-guardian.js"))})) {
        const originalSend = child.send.bind(child);
        const originalEmit = child.emit.bind(child);
        child.emit = function(event, ...rest) {
            const frame = rest[0];
            if (event === 'message' && frame?.type === 'ack'
                && fs.existsSync(${JSON.stringify(join(root, "hold-next-ack"))})) {
                fs.unlinkSync(${JSON.stringify(join(root, "hold-next-ack"))});
                // This frame came from the real guardian. Keep it out of the
                // parent's handler until that parent dies; never fabricate ACK.
                fs.writeFileSync(${JSON.stringify(join(root, "held-real-ack.json"))}, JSON.stringify(frame));
                return true;
            }
            return originalEmit(event, ...rest);
        };
        child.send = function(message, ...rest) {
            if (message.type === 'update' && fs.existsSync(${JSON.stringify(join(root, "reject-next-update"))})) {
                fs.unlinkSync(${JSON.stringify(join(root, "reject-next-update"))});
                const callback = rest.find(value => typeof value === 'function');
                queueMicrotask(() => callback(new Error('Owned fixture rejected one actual update send')));
                return false;
            }
            return originalSend(message, ...rest);
        };
    }
    return child;
};
require('node:module').syncBuiltinESMExports();
`);
        writeFileSync(ownerScript, `
import * as runtime from ${moduleUrl("container-runtime.js")};
import { setSession, setSessionContainerId, setSessionCleanupEnabled, setupSignalHandlers,
    armSessionOwnership, confirmSessionOwnership, cleanupSession, acquireHostSessionOwnership,
    beginSessionStartupInHeldLifecycleLock, recordSessionOwnStartInHeldLifecycleLock, publishSessionReadyInHeldLifecycleLock,
    withContainerLifecycleLock, withContainerLifecycleLockAsync, observeActiveSessionsForContainer, getSessionLockClaimsForContainer } from ${moduleUrl("session.js")};
import { getProjectId } from ${moduleUrl("utils.js")};
import { createNativeSessionClaims } from ${moduleUrl("composition/session-claims.js")};
import { createNativeSessionClaimObservationStore } from ${moduleUrl("adapters/session-claim-observation.js")};
import { captureNativeSessionOwnership } from ${moduleUrl("adapters/session-ownership.js")};
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
const mode = process.argv[2], project = ${JSON.stringify(join(root, "project"))};
runtime.setRuntimeOverride('docker');
let lock, guardian;
const prefix = getProjectId(project);
const prepare = async () => {
    const claims = createNativeSessionClaims(withContainerLifecycleLock);
    lock = withContainerLifecycleLock(prefix, () => claims.reserveSessionLockInHeldLifecycleLock(prefix));
    setSession(lock, project);
    setSessionContainerId(${JSON.stringify(exactId)});
    setSessionCleanupEnabled(false);
};
// Keep the same public entrypoint executable in a compatible old build: its
// failure must be an observable engine-B stop, never a missing-export error.
if (!mode.startsWith('recover') && mode !== 'query') {
    if (typeof runtime.runWithNativeRuntimeInvocation === 'function') {
        await runtime.runWithNativeRuntimeInvocation(runtime.getRuntimeInvocation(), prepare);
    } else await prepare();
}
writeFileSync(${JSON.stringify(alias)}, ${JSON.stringify(endpointB)});
process.env.PATH = ${JSON.stringify(binB + ":" + dirname(process.execPath) + ":/usr/bin:/bin")};
process.env.DOCKER_CONTEXT = 'redefined';
process.env.DOCKER_HOST = ${JSON.stringify(endpointB)};
process.env.DOCKER_CONFIG = ${JSON.stringify(join(root, "config-b"))};
runtime.setRuntimeOverride('docker');
// Both guardian launch and signal registration occur after the native scope
// returned, with ambient PATH, alias and configuration selecting engine B.
if (mode === 'query') {
    const active = observeActiveSessionsForContainer(prefix);
    const claims = getSessionLockClaimsForContainer(prefix);
    process.send({event: 'query', active, claims}, () => process.exit(0));
    await new Promise(() => {});
}
if (mode.startsWith('recover')) {
    process.send({event: 'recovering'});
    try {
        const acquired = await acquireHostSessionOwnership({projectId: prefix, projectPath: project}, () => {
            process.send({event: 'inspecting', claims: readdirSync(${JSON.stringify(join(home, ".ccc", "run", "locks"))}).filter(name => name.endsWith('.lock'))});
            if (mode === 'recover-fail') throw new Error('Owned fixture failed join');
            return {known: true, containerId: mode === 'recover-join' ? ${JSON.stringify(exactId)} : null, runtime: 'docker'};
        });
        lock = acquired.lockFile;
        const children = readFileSync('/proc/' + process.pid + '/task/' + process.pid + '/children', 'utf8').trim().split(/\\s+/).filter(Boolean).map(Number);
        if (children.length !== 1) throw new Error('Expected one owned guardian');
        guardian = children[0];
    } catch (error) {
        process.send({event: 'acquisition-failed', error: error.message});
        setInterval(() => {}, 1000);
        await new Promise(() => {});
    }
} else {
    guardian = await armSessionOwnership();
    if (mode !== 'older-ack-failed') setupSignalHandlers();
    if (mode === 'startup-intent') {
        await withContainerLifecycleLockAsync(prefix, () => beginSessionStartupInHeldLifecycleLock());
    } else if (mode === 'own-start' || mode === 'older-ack-failed') {
        if (mode === 'older-ack-failed') {
            writeFileSync(${JSON.stringify(join(root, "reject-next-update"))}, 'reject one send');
            setSessionCleanupEnabled(true);
            let rejected = false;
            try { await confirmSessionOwnership(); } catch { rejected = true; }
            if (!rejected) throw new Error('The older IPC queue did not reject');
            process.send({event: 'older-update-rejected'});
        }
        let publicationFailed = false;
        try {
            await withContainerLifecycleLockAsync(prefix, () => {
                beginSessionStartupInHeldLifecycleLock();
                recordSessionOwnStartInHeldLifecycleLock(${JSON.stringify(exactId)});
            });
        } catch (error) {
            if (mode !== 'older-ack-failed' || error.message !== 'Session ownership guardian is unavailable.') throw error;
            publicationFailed = true;
            const snapshot = await withContainerLifecycleLockAsync(prefix, () => createNativeSessionClaimObservationStore()
                .read(captureNativeSessionOwnership(lock), {lockFile: lock, projectPath: project, toolName: 'claude', prefix}));
            if (!snapshot || snapshot.observation.ownStarted?.generation !== snapshot.observation.generation
                || snapshot.observation.ownStarted.containerId !== ${JSON.stringify(exactId)}) {
                throw new Error('Positive own-start compensation was not durably qualified');
            }
            process.send({event: 'own-start-publication-failed', lock, guardian, error: error.message,
                durableOwnStarted: snapshot.observation.ownStarted});
        }
        if (mode === 'older-ack-failed' && !publicationFailed) throw new Error('Unavailable guardian was incorrectly reported healthy');
    } else if (mode === 'held-ready' || mode === 'queued-grant-intent' || mode.startsWith('delayed-')) {
        await withContainerLifecycleLockAsync(prefix, () => {
            beginSessionStartupInHeldLifecycleLock();
            recordSessionOwnStartInHeldLifecycleLock(${JSON.stringify(exactId)});
            publishSessionReadyInHeldLifecycleLock(${JSON.stringify(exactId)}, {startedByInvocation: true});
        });
        await confirmSessionOwnership();
    } else {
        setSessionCleanupEnabled(true);
        await confirmSessionOwnership();
    }
    if (mode === 'revoked') { setSessionCleanupEnabled(false); await confirmSessionOwnership(); }
}
if (mode !== 'older-ack-failed') process.send({ event: 'ready', lock, guardian });
process.on('message', async message => {
    if (message.event === 'eof') process.exit(0);
    if (message.event === 'supersede-queued-grant') {
        // No await separates the older grant request and the newer intent:
        // the grant's queued transport cannot run before this publication.
        setSessionCleanupEnabled(true);
        withContainerLifecycleLock(prefix, () => beginSessionStartupInHeldLifecycleLock());
        const readOwn = () => withContainerLifecycleLock(prefix, () => createNativeSessionClaimObservationStore()
            .read(captureNativeSessionOwnership(lock), {lockFile: lock, projectPath: project, toolName: 'claude', prefix}));
        const before = readOwn();
        if (!before) throw new Error('The new startup intent was not qualified');
        await confirmSessionOwnership();
        const after = readOwn();
        if (!after) throw new Error('The confirmed startup intent was not qualified');
        const authorityState = snapshot => ({generation: snapshot.observation.generation, pending: snapshot.observation.pending,
            lastAcknowledged: snapshot.observation.lastAcknowledged, ownStarted: snapshot.observation.ownStarted});
        process.send({event: 'newer-intent-confirmed', lock, guardian, before: authorityState(before), after: authorityState(after)});
    }
    if (message.event === 'queue-revocation') {
        writeFileSync(${JSON.stringify(join(root, "hold-next-ack"))}, 'hold exactly one real ACK');
        setSessionCleanupEnabled(true);
        const deadline = Date.now() + 15000;
        while (true) {
            try { JSON.parse(readFileSync(${JSON.stringify(join(root, "held-real-ack.json"))}, 'utf8')); break; }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                if (Date.now() > deadline) throw new Error('Owned real ACK rendezvous did not occur');
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        if (mode === 'delayed-disable') setSessionCleanupEnabled(false);
        else if (mode === 'delayed-target') setSessionContainerId(${JSON.stringify("b".repeat(64))});
        else throw new Error('Unexpected owned revocation mode');
        process.send({event: 'revocation-requested', lock, guardian});
    }
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
        if (!mode.startsWith("recover") && mode !== "query") writeFileSync(alias, endpointA);
        const child = spawn(process.execPath, [ownerScript, mode], {
            cwd: root,
            env: { HOME: home, USERPROFILE: home, PATH: binA + ":" + dirname(process.execPath) + ":/usr/bin:/bin",
                DOCKER_CONTEXT: "mutable", DOCKER_CONFIG: join(root, "config-a"),
                TMPDIR: root, TMP: root, TEMP: root, CCC_DEVICE_BROKER_AUTO_START: "0",
                ...(mode === "older-ack-failed" || mode.startsWith("delayed-") ? {NODE_OPTIONS: "--require " + JSON.stringify(ipcFaultPreload)} : {}) },
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
            if (message.event === "ready" || message.event === "own-start-publication-failed") {
                const pid = Number(message.guardian);
                const identity = token(pid);
                if (identity) guardians.set(pid, identity);
            }
        });
        return owner;
    }

    async function frame(owner: Owner, event: string): Promise<Record<string, unknown>> {
        await eventually(() => {
            if (owner.messages.some(message => message.event === event)) return true;
            if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error("Owner exited before " + event + ": " + owner.output);
            return false;
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

    it("actual held-guard startup publication records authority before queued acknowledgement settles after release", async () => {
        const owner = launch("held-ready");
        const ready = await frame(owner, "ready");
        const observation = JSON.parse(readFileSync(String(ready.lock) + ".guardian.json", "utf8"));
        expect(observation.registration).toBe("ready");
        expect(observation.pending).toBeNull();
        expect(observation.lastAcknowledged).toMatchObject({containerId: exactId, cleanupEnabled: true});
        expect(observation.lastAcknowledged.generation).toBe(observation.generation);
        owner.child.send({event: "eof"});
        await eventually(() => !existsSync(String(ready.lock)), "held publication's autonomous cleanup");
        await eventually(() => token(Number(ready.guardian)) === undefined, "held publication's guardian exit");
        expectOnlyAStopped(1);
    });

    it("actual acquisition receives guardian READY and existing-target ACK while it holds the nonreentrant guard", async () => {
        const owner = launch("recover-join");
        const ready = await frame(owner, "ready");
        const observation = JSON.parse(readFileSync(String(ready.lock) + ".guardian.json", "utf8"));
        expect(observation.registration).toBe("ready");
        expect(observation.pending).toBeNull();
        expect(observation.lastAcknowledged).toMatchObject({containerId: exactId, cleanupEnabled: false});
        expect(observation.lastAcknowledged.generation).toBe(observation.generation);
        expect(owner.messages.some(message => message.event === "inspecting")).toBe(true);
        owner.child.send({event: "eof"});
        await eventually(() => !existsSync(String(ready.lock)), "held-acquisition no-obligation rollback");
        await eventually(() => token(Number(ready.guardian)) === undefined, "held-acquisition guardian exit");
        expect(stops()).toEqual([]);
    });

    it("read-only session queries preserve a dead owner's exact receipt while its live guardian retries", async () => {
        writeFileSync(failures, "1");
        writeFileSync(join(root, "hold-stop"), "hold native effect");
        const owner = launch("guardian");
        const ready = await frame(owner, "ready");
        const claim = String(ready.lock), receipt = readFileSync(claim);
        owner.child.send({event: "eof"});
        await eventually(() => owner.child.exitCode !== null, "dead parent before query");
        await eventually(() => existsSync(join(root, "stop-entered")), "live guardian's held stop");
        expect(token(Number(ready.guardian))).toBe(guardians.get(Number(ready.guardian)));
        const before = [claim, claim + ".guardian.json", claim + ".runtime.json"].map(path => readFileSync(path));
        const queried = await frame(launch("query"), "query");
        expect(queried.claims).toContain(claim.slice(claim.lastIndexOf("/") + 1));
        expect(readFileSync(claim)).toEqual(receipt);
        expect([claim, claim + ".guardian.json", claim + ".runtime.json"].map(path => readFileSync(path))).toEqual(before);
        rmSync(join(root, "hold-stop"));
        await eventually(() => !existsSync(claim), "same live guardian's successful retry");
        await eventually(() => token(Number(ready.guardian)) === undefined, "retry guardian terminal exit");
        expectOnlyAStopped(2);
    });

    it("after three failed stops and guardian death, the next admission recovers A before reserving under ambient B", async () => {
        writeFileSync(failures, "3");
        const owner = launch("guardian");
        const ready = await frame(owner, "ready"), claim = String(ready.lock);
        owner.child.send({event: "eof"});
        await eventually(() => owner.child.exitCode !== null, "failed cleanup parent exit");
        await eventually(() => token(Number(ready.guardian)) === undefined, "three-attempt guardian terminal exit");
        expect(stops()).toHaveLength(3);
        expect(existsSync(claim)).toBe(true);
        const retained = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        expect(retained.recovery.status).toBe("recovery-needed");
        writeFileSync(failures, "0");
        const successor = launch("recover");
        const acquired = await frame(successor, "ready");
        expect(stops()).toHaveLength(4);
        expect(stops().every(call => call.executable === "A" && call.endpoint === endpointA && call.id === exactId)).toBe(true);
        expect(stops()[3]!.claimsAtStop).toEqual([claim.slice(claim.lastIndexOf("/") + 1)]);
        const inspection = successor.messages.find(message => message.event === "inspecting")!;
        expect(inspection.claims).toEqual([String(acquired.lock).split("/").at(-1)]);
        for (const path of [claim, claim + ".guardian.json", claim + ".runtime.json"]) expect(existsSync(path)).toBe(false);
        expect(engineState()[endpointA]![exactId]).toBe(false);
        expect(engineState()[endpointB]![exactId]).toBe(true);
        successor.child.send({event: "eof"});
        await eventually(() => !existsSync(String(acquired.lock)), "no-obligation successor rollback");
        await eventually(() => token(Number(acquired.guardian)) === undefined, "successor guardian exit");
        expect(stops()).toHaveLength(4);
    }, 30_000);

    it("a cleanup-disabled join cannot erase a dead predecessor's obligation while its live guardian is between retries", async () => {
        writeFileSync(failures, "1");
        const predecessor = launch("guardian");
        const previous = await frame(predecessor, "ready"), claim = String(previous.lock);
        predecessor.child.send({event: "eof"});
        await eventually(() => predecessor.child.exitCode !== null, "predecessor parent exit");
        const guard = join(home, ".ccc", "run", "locks", claim.split("/").at(-1)!.split("--")[0] + ".container-lifecycle.guard");
        await eventually(() => stops().length === 1 && !existsSync(guard), "failed stop's released guard before retry");
        const guardianPid = Number(previous.guardian);
        expect(token(guardianPid)).toBe(guardians.get(guardianPid));
        process.kill(guardianPid, "SIGSTOP");
        const receipt = readFileSync(claim);
        const successor = launch("recover-join");
        const joined = await frame(successor, "ready");
        expect(existsSync(claim)).toBe(true);
        expect(readFileSync(claim)).toEqual(receipt);
        expect(JSON.parse(readFileSync(String(joined.lock) + ".guardian.json", "utf8")).lastAcknowledged)
            .toMatchObject({containerId: exactId, cleanupEnabled: false});
        successor.child.send({event: "eof"});
        await eventually(() => !existsSync(String(joined.lock)), "failed join's own claim rollback");
        await eventually(() => token(Number(joined.guardian)) === undefined, "failed join's guardian exit");
        expect(readFileSync(claim)).toEqual(receipt);
        expect(stops()).toHaveLength(1);
        expect(token(guardianPid)).toBe(guardians.get(guardianPid));
        process.kill(guardianPid, "SIGCONT");
        await eventually(() => !existsSync(claim), "original obligation's successful retry");
        await eventually(() => token(guardianPid) === undefined, "original guardian completion");
        expect(stops()).toHaveLength(2);
        expect(stops().every(call => call.executable === "A" && call.endpoint === endpointA && call.id === exactId)).toBe(true);
        expect(engineState()[endpointB]![exactId]).toBe(true);
    }, 30_000);

    it("an intent followed by parent death before its positive callback retains uncertainty and never infers a stop", async () => {
        const owner = launch("startup-intent");
        const ready = await frame(owner, "ready"), claim = String(ready.lock);
        expect(JSON.parse(readFileSync(claim + ".guardian.json", "utf8"))).toMatchObject({
            pending: {kind: "startup"}, ownStarted: null,
        });
        owner.child.kill("SIGKILL");
        await eventually(() => owner.child.signalCode !== null, "hard-killed intent parent");
        await eventually(() => token(Number(ready.guardian)) === undefined, "incomplete intent guardian exit");
        expect(existsSync(claim)).toBe(true);
        expect(stops()).toEqual([]);
        expect(engineState()[endpointA]![exactId]).toBe(true);
        expect(engineState()[endpointB]![exactId]).toBe(true);
        const successor = launch("recover");
        await frame(successor, "acquisition-failed");
        expect(successor.messages.some(message => message.event === "inspecting")).toBe(false);
        expect(readdirSync(join(home, ".ccc", "run", "locks")).filter(name => name.endsWith(".lock"))).toEqual([claim.split("/").at(-1)]);
        expect(stops()).toEqual([]);
    }, 30_000);

    it("an older unsent standalone grant cannot overwrite a newer held startup intent when confirmation settles", async () => {
        const owner = launch("queued-grant-intent");
        const ready = await frame(owner, "ready"), claim = String(ready.lock);
        const receipt = readFileSync(claim);
        const initial = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        expect(initial.pending).toBeNull();
        expect(initial.lastAcknowledged).toMatchObject({containerId: exactId, cleanupEnabled: true});
        expect(initial.ownStarted).toEqual({generation: initial.generation, containerId: exactId});
        owner.child.send({event: "supersede-queued-grant"});
        const confirmed = await frame(owner, "newer-intent-confirmed");
        expect(confirmed.before).toMatchObject({
            pending: {kind: "startup", containerId: null, cleanupEnabled: false}, ownStarted: null,
        });
        expect(confirmed.after).toEqual(confirmed.before);
        const current = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        expect(current.generation).not.toBe(initial.generation);
        expect(current.pending).toMatchObject({kind: "startup", generation: current.generation, containerId: null, cleanupEnabled: false});
        expect(current.lastAcknowledged).toEqual(initial.lastAcknowledged);
        expect(current.ownStarted).toBeNull();
        owner.child.send({event: "eof"});
        await eventually(() => owner.child.exitCode !== null, "parent EOF after superseded-grant confirmation");
        await eventually(() => token(Number(ready.guardian)) === undefined, "newer startup intent retains incomplete responsibility");
        expect(stops()).toEqual([]);
        expect(engineState()[endpointA]![exactId]).toBe(true);
        expect(engineState()[endpointB]![exactId]).toBe(true);
        expect(readFileSync(claim)).toEqual(receipt);
        const retained = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        expect(retained.generation).toBe(current.generation);
        expect(retained.pending).toEqual(current.pending);
        expect(retained.lastAcknowledged).toEqual(initial.lastAcknowledged);
        expect(retained.ownStarted).toBeNull();
        expect(retained.recovery.status).toBe("recovery-needed");
    }, 30_000);

    it.each(["disable", "target"] as const)("standalone %s revocation prevents EOF cleanup while an older real ACK remains withheld", async change => {
        const owner = launch("delayed-" + change);
        const ready = await frame(owner, "ready"), claim = String(ready.lock);
        const receipt = readFileSync(claim);
        const initiallyAcknowledged = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        expect(initiallyAcknowledged.pending).toBeNull();
        expect(initiallyAcknowledged.lastAcknowledged).toMatchObject({containerId: exactId, cleanupEnabled: true});
        expect(initiallyAcknowledged.ownStarted).toEqual({generation: initiallyAcknowledged.generation, containerId: exactId});
        owner.child.send({event: "queue-revocation"});
        await frame(owner, "revocation-requested");
        const held = JSON.parse(readFileSync(join(root, "held-real-ack.json"), "utf8"));
        expect(held).toEqual({type: "ack", sequence: expect.any(Number)});
        expect(held.sequence).toBeGreaterThan(initiallyAcknowledged.lastAcknowledged.sequence);
        const revokedBeforeDeath = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        // Kill only our exact parent. The independent guardian has sent the
        // older positive ACK, but that frame never reached its parent's logic.
        owner.child.kill("SIGKILL");
        await eventually(() => owner.child.signalCode !== null, "revoked parent death before old ACK delivery");
        await eventually(() => token(Number(ready.guardian)) === undefined, "guardian records incomplete revoked responsibility");
        expect(stops()).toEqual([]);
        expect(engineState()[endpointA]![exactId]).toBe(true);
        expect(engineState()[endpointB]![exactId]).toBe(true);
        expect(readFileSync(claim)).toEqual(receipt);
        const retained = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        expect(revokedBeforeDeath.pending).toMatchObject({cleanupEnabled: false});
        expect(revokedBeforeDeath.ownStarted).toBeNull();
        expect(retained.pending).toEqual(revokedBeforeDeath.pending);
        expect(retained.generation).toBe(revokedBeforeDeath.generation);
        expect(retained.lastAcknowledged).toEqual(revokedBeforeDeath.lastAcknowledged);
        expect(retained.ownStarted).toBeNull();
        expect(retained.recovery.status).toBe("recovery-needed");
        expect(JSON.parse(readFileSync(join(root, "held-real-ack.json"), "utf8"))).toEqual(held);
    }, 30_000);

    it("a positive own-start survives an earlier rejected real IPC update and is recoverable after both processes exit", async () => {
        const owner = launch("older-ack-failed");
        await frame(owner, "older-update-rejected");
        const failed = await frame(owner, "own-start-publication-failed"), claim = String(failed.lock);
        expect(failed.error).toBe("Session ownership guardian is unavailable.");
        expect(owner.messages.some(message => message.event === "ready")).toBe(false);
        const observation = JSON.parse(readFileSync(claim + ".guardian.json", "utf8"));
        expect(observation.ownStarted).toEqual({generation: observation.generation, containerId: exactId});
        expect(failed.durableOwnStarted).toEqual(observation.ownStarted);
        owner.child.kill("SIGKILL");
        await eventually(() => owner.child.signalCode !== null, "failed transport parent death");
        const guardianPid = Number(failed.guardian), guardianIdentity = guardians.get(guardianPid);
        if (guardianIdentity && token(guardianPid) === guardianIdentity) process.kill(guardianPid, "SIGKILL");
        await eventually(() => token(guardianPid) === undefined, "failed transport guardian death");
        expect(existsSync(claim)).toBe(true);
        expect(stops()).toEqual([]);
        const successor = launch("recover");
        await frame(successor, "ready");
        expect(stops()).toHaveLength(1);
        expect(stops()[0]).toMatchObject({executable: "A", endpoint: endpointA, id: exactId});
        expect(existsSync(claim)).toBe(false);
        expect(engineState()[endpointA]![exactId]).toBe(false);
        expect(engineState()[endpointB]![exactId]).toBe(true);
    }, 30_000);

    it("an all-dead equal-authority cohort retains one deterministic obligation and stops the exact target once", async () => {
        const first = launch("guardian"), firstReady = await frame(first, "ready");
        const second = launch("guardian"), secondReady = await frame(second, "ready");
        const cohort = [firstReady, secondReady];
        const claims = cohort.map(item => String(item.lock)).sort();
        const runtimes = cohort.map(item => readFileSync(String(item.lock) + ".runtime.json", "utf8"));
        expect(runtimes[0]).toBe(runtimes[1]);
        for (const item of cohort) {
            const pid = Number(item.guardian);
            expect(token(pid)).toBe(guardians.get(pid));
            process.kill(pid, "SIGSTOP");
        }
        for (const owner of [first, second]) owner.child.kill("SIGKILL");
        for (const owner of [first, second]) await eventually(() => owner.child.signalCode !== null, "cohort parent death");
        for (const item of cohort) {
            const pid = Number(item.guardian);
            expect(token(pid)).toBe(guardians.get(pid));
            process.kill(pid, "SIGKILL");
            await eventually(() => token(pid) === undefined, "cohort guardian death");
        }
        expect(claims.every(path => existsSync(path))).toBe(true);
        expect(stops()).toEqual([]);
        const successor = launch("recover");
        await frame(successor, "ready");
        expect(stops()).toHaveLength(1);
        expect(stops()[0]).toMatchObject({executable: "A", endpoint: endpointA, id: exactId});
        expect(stops()[0]!.claimsAtStop).toEqual([claims[0]!.split("/").at(-1)]);
        expect(claims.every(path => !existsSync(path))).toBe(true);
        expect(engineState()[endpointA]![exactId]).toBe(false);
        expect(engineState()[endpointB]![exactId]).toBe(true);
    }, 30_000);

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
