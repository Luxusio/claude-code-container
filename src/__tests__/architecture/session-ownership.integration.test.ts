import { createHash } from "node:crypto";
import { NATIVE_RUNTIME_SELECTOR_KEYS, type NativeRuntimeInvocation, type NativeRuntimeSelectors } from "../../ports/container-runtime-invocation.js";
import { captureNativeSessionOwnership } from "../../adapters/session-ownership.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { readDeviceRuntimeProcessIdentityAsync } from "@ccc/device-lab/device-lab-process-identity.js";
import { getProjectId } from "../../utils.js";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These children import the shipped JavaScript, outside Vitest's source aliases.
// After SIGKILL the observer uses only native filesystem/process operations:
// no session query can reconcile the claim on behalf of the guardian.
const distribution = process.env.CCC_NATIVE_RUNTIME_AUTHORITY_DIST ?? fileURLToPath(new URL("../../../dist/", import.meta.url));
function fixtureInvocation(executable: string, home: string): NativeRuntimeInvocation {
    return {
        version: 1, runtime: "docker", executable,
        transport: { kind: "docker", host: "unix:///fixture/engine-a.sock", configDirectory: join(home, ".docker"),
            tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
        selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key,
            key === "HOME" || key === "USERPROFILE" ? home : process.env[key] ?? null])) as NativeRuntimeSelectors,
    };
}

const idA = "a".repeat(64);
const idB = "b".repeat(64);

// The private preload intercepts only runtime commands. Native PowerShell,
// filesystem identity, guardian IPC and lifecycle acquisition remain real.
describe("emitted guardian native lifecycle recovery on every platform", () => {
    const children: ChildProcess[] = [];
    let root: string;
    let home: string;
    let project: string;
    let lock: string;
    let guard: string;
    let log: string;
    let shim: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-native-guardian-"));
        home = join(root, "home");
        project = join(root, "project");
        const directory = join(home, ".ccc", "run", "locks");
        mkdirSync(directory, { recursive: true });
        mkdirSync(project);
        const prefix = getProjectId(project);
        lock = join(directory, prefix + "--fixture.lock");
        guard = join(directory, prefix + ".container-lifecycle.guard");
        log = join(root, "runtime.jsonl");
        shim = join(root, "runtime-preload.cjs");
        writeFileSync(lock, String(process.pid));
        writeFileSync(log, "");
        writeFileSync(shim, `
const cp = require('node:child_process');
const fs = require('node:fs');
const original = cp.spawnSync;
const originalOpen = fs.openSync;
const originalRead = fs.readSync;
const originalClose = fs.closeSync;
const guardDescriptors = new Set();
fs.openSync = function(path) {
    const descriptor = originalOpen.apply(this, arguments);
    if (String(path) === process.env.CCC_FIXTURE_GUARD) guardDescriptors.add(descriptor);
    return descriptor;
};
fs.readSync = function(descriptor) {
    const result = originalRead.apply(this, arguments);
    if (guardDescriptors.has(descriptor) && result > 0) {
        fs.writeFileSync(process.env.CCC_FIXTURE_LOG + '.guard-read', String(process.pid));
    }
    return result;
};
fs.closeSync = function(descriptor) {
    try { return originalClose.apply(this, arguments); }
    finally { guardDescriptors.delete(descriptor); }
};
cp.spawnSync = function(command, args, options) {
    if (String(command) !== process.env.CCC_FIXTURE_EXECUTABLE && !/^(docker|podman)(\\.exe)?$/i.test(String(command))) return original.apply(this, arguments);
    let index = 0, host;
    while (index < args.length) {
        if (args[index] === '--config') { index += 2; continue; }
        if (args[index] === '--host') { host = args[index + 1]; index += 2; continue; }
        if (/^--tls(?:verify|cacert|cert|key)?=/.test(args[index])) { index++; continue; }
        break;
    }
    args = args.slice(index);
    if (args[0] === 'stop' && host !== 'unix:///fixture/engine-a.sock') throw new Error('fixture refused uncaptured authority');
    fs.appendFileSync(process.env.CCC_FIXTURE_LOG, JSON.stringify(args) + '\\n');
    let status = 0, stdout = '';
    if (args[0] === '--version') stdout = 'Docker version 27.1.1\\n';
    if (args[0] === 'info' && args[2] === '{{.OperatingSystem}}') stdout = 'Linux\\n';
    if (args[0] === 'info' && args[2] === '{{json .SecurityOptions}}') stdout = '[]\\n';
    if (args[0] === 'stop') {
        const marker = process.env.CCC_FIXTURE_LOG + '.entered';
        fs.writeFileSync(marker, String(process.pid));
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(process.env.CCC_FIXTURE_LOG + '.release')) {
            if (Date.now() > deadline) throw new Error('fixture stop release timeout');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        const attempts = fs.readFileSync(process.env.CCC_FIXTURE_LOG, 'utf8').trim().split('\\n').map(JSON.parse).filter(a => a[0] === 'stop').length;
        status = attempts <= Number(process.env.CCC_FIXTURE_FAILURES || 0) ? 72 + attempts : 0;
    }
    return {pid: process.pid, status, signal: null, stdout, stderr: status ? 'fixture-sensitive-runtime-stderr-secret' : '', output: [null, stdout, '']};
};
require('node:module').syncBuiltinESMExports();
`);
    });
    afterEach(async () => {
        writeFileSync(log + ".release", "release");
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        for (const child of children) await eventually(() => child.exitCode !== null || child.signalCode !== null, "fixture child exit");
        children.length = 0;
        rmSync(root, { recursive: true, force: true });
    });
    const calls = () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]);
    const stops = () => calls().filter(args => args[0] === "stop");
    async function launch(failures = 0, acknowledged = true) {
        const child = spawn(process.execPath, [join(distribution, "session-ownership-guardian.js"), String(process.pid)], {
            env: { ...process.env, HOME: home, USERPROFILE: home, CCC_RUNTIME: "docker",
                CCC_DEVICE_BROKER_AUTO_START: "0", NODE_OPTIONS: "--require " + JSON.stringify(shim),
                CCC_FIXTURE_EXECUTABLE: join(root, "docker"), CCC_FIXTURE_LOG: log, CCC_FIXTURE_GUARD: guard, CCC_FIXTURE_FAILURES: String(failures) },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        children.push(child);
        const messages: unknown[] = [];
        let stderr = "";
        child.stdout!.resume();
        child.stderr!.on("data", chunk => { stderr += String(chunk); });
        child.on("message", message => { messages.push(message); });
        child.send({ type: "init", binding: { lockFile: lock, projectPath: project }, receipt: captureNativeSessionOwnership(lock), runtimeInvocation: fixtureInvocation(join(root, "docker"), home) });
        await eventually(() => messages.some(m => (m as { type: string }).type === "ready"), "real guardian READY: " + stderr);
        if (acknowledged) {
            child.send({ type: "update", sequence: 1, containerId: idA, cleanupEnabled: true });
            await eventually(() => messages.some(m => (m as { type: string }).type === "ack"), "real guardian ACK");
        }
        return { child, stderr: () => stderr, stderrEnded: () => child.stderr!.readableEnded };
    }
    it.each([0, 1, 3])("publishes native guardian identity and retains receipt until exact-ID stop succeeds (failures %s)", async failures => {
        const { child, stderr } = await launch(failures);
        child.disconnect();
        await eventually(() => existsSync(log + ".entered"), "held exact-ID stop");
        expect(existsSync(lock)).toBe(true);
        const record = JSON.parse(readFileSync(guard, "utf8")) as { pid: number; processIdentityStatus: string; processIdentity: { pid: number; startToken: string; commandHash: string } };
        expect(record.pid).toBe(child.pid);
        expect(record.processIdentityStatus).toBe("recorded");
        expect(record.processIdentity.pid).toBe(child.pid);
        expect(record.processIdentity.startToken).toBeTruthy();
        expect(record.processIdentity.commandHash).toMatch(/^[a-f0-9]{64}$/);
        expect(record.processIdentity).toEqual(await readDeviceRuntimeProcessIdentityAsync(child.pid));
        writeFileSync(log + ".release", "release");
        await eventually(() => child.exitCode !== null, "bounded guardian exit");
        expect(child.exitCode, stderr()).toBe(failures === 3 ? 1 : 0);
        expect(existsSync(lock)).toBe(failures === 3);
        expect(stops()).toEqual(Array.from({ length: failures === 3 ? 3 : failures + 1 }, () => ["stop", idA]));
        expect(existsSync(guard)).toBe(false);
    }, 30_000);
    it.each([false, true])("reports bounded ordered terminal causes before native exit (protocol primary %s)", async protocol => {
        const { child, stderr, stderrEnded } = await launch(3);
        writeFileSync(log + ".release", "release");
        if (protocol) {
            child.send({ type: "update", sequence: 1, containerId: idB,
                cleanupEnabled: true, secret: "fixture-private-causal-secret" });
        } else child.disconnect();
        await eventually(() => child.exitCode !== null, "native terminal causal evidence");
        await eventually(stderrEnded, "native terminal diagnostic pipe drained");
        expect(child.exitCode).toBe(1);
        expect(existsSync(lock)).toBe(true);
        expect(stops()).toEqual(Array.from({ length: 3 }, () => ["stop", idA]));
        const prefix = "[ccc] Session ownership guardian failure: ";
        const diagnostics = stderr().split("\n").filter(line => line.startsWith(prefix));
        expect(diagnostics).toHaveLength(1);
        expect(diagnostics[0]!.length).toBeLessThan(2048);
        expect(stderr()).not.toContain("fixture-private-causal-secret");
        expect(stderr()).not.toContain(root);
        expect(stderr()).not.toContain("owned fixture stop failure");
        expect(stderr()).not.toContain("fixture-sensitive-runtime-stderr-secret");
        const attempts = [73, 74, 75].map(status => ({ kind: "error", operation: "container-stop", status, signal: "none", code: "unknown" }));
        const cleanup = { kind: "aggregate", operation: "cleanup", errors: attempts, cause: attempts[0] };
        expect(JSON.parse(diagnostics[0]!.slice(prefix.length))).toEqual(protocol
            ? { kind: "aggregate", operation: "guardian", errors: [{ kind: "error", operation: "protocol" }, cleanup],
                cause: { kind: "error", operation: "protocol" } }
            : cleanup);
        expect(existsSync(guard)).toBe(false);
    }, 30_000);
    it.each(["successor", "foreign"] as const)("revalidates %s authority between failed stop attempts", async kind => {
        const { child, stderr } = await launch(1);
        child.disconnect();
        await eventually(() => existsSync(log + ".entered"), "first exact-ID stop");
        writeFileSync(log + ".release", "release");
        await eventually(() => stops().length === 1 && !existsSync(guard), "first failed attempt released its guard");
        expect(existsSync(lock)).toBe(true);
        const foreign = join(dirname(lock), getProjectId(project) + "--foreign.lock");
        const bytes = readFileSync(lock);
        if (kind === "successor") {
            renameSync(lock, lock + ".retired");
            writeFileSync(lock, bytes, { flag: "wx" });
        } else writeFileSync(foreign, String(process.pid), { flag: "wx" });
        await eventually(() => child.exitCode !== null, "retry authority veto");
        expect(child.exitCode, stderr()).toBe(0);
        expect(stops()).toEqual([["stop", idA]]);
        expect(existsSync(lock)).toBe(kind === "successor");
        if (kind === "successor") expect(readFileSync(lock)).toEqual(bytes);
        else expect(readFileSync(foreign, "utf8")).toBe(String(process.pid));
    }, 30_000);
    it.each([
        ["mismatch", false], ["matching", false], ["unavailable", false],
        ["mismatch", true], ["matching", true], ["unavailable", true],
    ] as const)("recovers only positive recorded identity mismatch (%s, rollback %s)", async (kind, rollback) => {
        const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        children.push(unrelated);
        const identity = await readDeviceRuntimeProcessIdentityAsync(unrelated.pid);
        expect(identity, "Native fixture identity must be observable").toBeTruthy();
        const record = { token: "0123456789abcdef0123456789abcdef", host: hostname(), pid: unrelated.pid,
            processIdentityStatus: kind === "unavailable" ? "unavailable" : "recorded",
            ...(kind === "unavailable" ? {} : { processIdentity: { ...identity!,
                startToken: kind === "mismatch" ? identity!.startToken + "-previous" : identity!.startToken } }) };
        const { child, stderr } = await launch(0, !rollback);
        writeFileSync(guard, JSON.stringify(record));
        writeFileSync(log + ".release", "release");
        child.disconnect();
        if (kind !== "mismatch") {
            await eventually(() => existsSync(log + ".guard-read"), "guardian observed valid fixture guard after native identity startup");
            expect(readFileSync(log + ".guard-read", "utf8")).toBe(String(child.pid));
            expect(unrelated.exitCode).toBeNull();
            expect(unrelated.signalCode).toBeNull();
            await new Promise(resolve => setTimeout(resolve, 700));
            expect(child.exitCode).toBeNull();
            expect(existsSync(lock)).toBe(true);
            expect(JSON.parse(readFileSync(guard, "utf8"))).toEqual(record);
            expect(stops()).toEqual([]);
            // Release only the exact fixture child. Acquisition now has positive
            // process-exit evidence, avoiding the production 180-second limit.
            unrelated.kill("SIGKILL");
            await eventually(() => unrelated.exitCode !== null || unrelated.signalCode !== null, "guard owner fixture exit");
        }
        await eventually(() => child.exitCode !== null, "native guard recovery completion");
        expect(child.exitCode, stderr()).toBe(0);
        expect(existsSync(lock)).toBe(false);
        expect(existsSync(guard)).toBe(false);
        expect(stops()).toEqual(rollback ? [] : [["stop", idA]]);
        if (kind === "mismatch") {
            expect(unrelated.exitCode).toBeNull();
            expect(unrelated.signalCode).toBeNull();
        }
    }, 30_000);
});

it("emitted native receipts accept an owned regular claim and refuse changed bytes before removal", () => {
    const root = mkdtempSync(join(tmpdir(), "ccc-emitted-receipt-"));
    const lock = join(root, "owner.lock");
    try {
        writeFileSync(lock, String(process.pid));
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const api=await import(${JSON.stringify(pathToFileURL(join(distribution, "adapters", "session-ownership.js")).href)});
const path=process.argv[1];
const captured=api.captureNativeSessionOwnership(path);
assert.equal(captured.ownerPid,Number(readFileSync(path,'utf8')));
assert.equal(captured.bytes,readFileSync(path).toString('base64'));
assert.ok(BigInt(captured.device)>0n);
assert.ok(BigInt(captured.inode)>0n);
assert.equal(api.nativeSessionOwnershipMatches(captured),true);
writeFileSync(path,'2147483647');
assert.equal(api.nativeSessionOwnershipMatches(captured),false);
assert.throws(()=>api.removeCapturedNativeSessionOwnership(captured));
assert.equal(existsSync(path),true);
assert.equal(readFileSync(path,'utf8'),'2147483647');
process.stdout.write('native receipt qualified');
`, lock], { encoding: "utf8", timeout: 10_000 });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("native receipt qualified");
    } finally { rmSync(root, { recursive: true, force: true }); }
});

interface Ready {
    event: "ready";
    lock: string;
    guardian: number;
    pendingRefusals?: { overwrite: boolean; arm: boolean; clear: boolean };
}
interface Owner {
    child: ChildProcess;
    messages: unknown[];
    output: string;
    ready?: Ready;
}

async function eventually(predicate: () => boolean, description: string, timeout = 15_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

function running(pid: number): boolean {
    try {
        // A disconnected grandchild can briefly remain a zombie before the host
        // reaps it. It has exited and cannot perform cleanup or retain a timer.
        if (process.platform === "linux") {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            if (/^ [ZX] /.test(stat.slice(stat.lastIndexOf(")") + 1))) return false;
        }
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH" || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function linuxStartToken(pid: number): string | undefined {
    if (process.platform !== "linux") return undefined;
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
        return /^[0-9]+$/.test(fields[19] ?? "") && fields[0] !== "Z" && fields[0] !== "X"
            ? fields[19] : undefined;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

describe("emitted session facade owns a real host process lifetime", () => {
    let root: string;
    let home: string;
    let bin: string;
    let log: string;
    let ownerScript: string;
    let guardianGateScript: string;
    const owners: Owner[] = [];
    const guardians = new Map<number, string | undefined>();

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "ccc-session-owner-"));
        home = join(root, "home");
        bin = join(root, "bin");
        log = join(root, "runtime.jsonl");
        mkdirSync(home);
        mkdirSync(bin);
        mkdirSync(join(root, "project"));
        mkdirSync(join(root, "sibling"));
        writeFileSync(log, "");
        // This is an owned executable, never a daemon or a real runtime. It
        // records argv so name discovery and extra stop effects are observable.
        const docker = join(bin, "docker");
        writeFileSync(docker, `#!${process.execPath}
import { appendFileSync } from 'node:fs';
let args = process.argv.slice(2), index = 0, host;
while (index < args.length) {
    if (args[index] === '--config') { index += 2; continue; }
    if (args[index] === '--host') { host = args[index + 1]; index += 2; continue; }
    if (/^--tls(?:verify|cacert|cert|key)?=/.test(args[index])) { index++; continue; }
    break;
}
args = args.slice(index);
if (args[0] === 'stop' && host !== 'unix:///fixture/engine-a.sock') process.exit(96);
appendFileSync(process.env.CCC_TEST_RUNTIME_LOG, JSON.stringify(args) + '\\n');
if (args[0] === '--version') console.log('Docker version 27.1.1');
if (args[0] === 'info' && args[2] === '{{.OperatingSystem}}') console.log('Linux');
if (args[0] === 'info' && args[2] === '{{json .SecurityOptions}}') console.log('[]');
if (args[0] === 'stop' && process.env.CCC_TEST_STOP_FAIL === '1') process.exit(73);
`);
        chmodSync(docker, 0o700);
        ownerScript = join(root, "owner.mjs");
        guardianGateScript = join(root, "guardian-gate.mjs");
        writeFileSync(guardianGateScript, `
import { existsSync, writeFileSync } from 'node:fs';
if (process.argv[1] === ${JSON.stringify(join(distribution, "session-ownership-guardian.js"))}) {
    const owner = process.ppid;
    writeFileSync(process.env.CCC_TEST_GUARDIAN_GATE + '.entered', JSON.stringify({ pid: process.pid, parent: owner }));
    while (!existsSync(process.env.CCC_TEST_GUARDIAN_GATE + '.release')) {
        if (process.ppid !== owner) process.exit(1);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}
`);
        const moduleUrl = (file: string) => JSON.stringify(pathToFileURL(join(distribution, file)).href);
        writeFileSync(ownerScript, `
import { createSessionLock, setSession, clearSession, setupSignalHandlers, armSessionOwnership,
    setSessionContainerId, setSessionCleanupEnabled, confirmSessionOwnership, cleanupSession, acquireHostSessionOwnership,
    getCurrentSession, observeActiveSessionsForContainer } from ${moduleUrl("session.js")};
import { getProjectId } from ${moduleUrl("utils.js")};
import { _setRuntimeInvocationForTest, _setRuntimeInfoForTest, getRuntimeInvocation } from ${moduleUrl("container-runtime.js")};
import { NATIVE_RUNTIME_SELECTOR_KEYS } from ${moduleUrl("ports/container-runtime-invocation.js")};
import { captureNativeSessionOwnership } from ${moduleUrl("adapters/session-ownership.js")};
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const [project, profileArg, initialId, mode] = process.argv.slice(2);
const profile = profileArg || undefined;
_setRuntimeInfoForTest({ runtime: 'docker' });
_setRuntimeInvocationForTest({
    version: 1, runtime: 'docker', executable: ${JSON.stringify(docker)},
    transport: { kind: 'docker', host: 'unix:///fixture/engine-a.sock', configDirectory: ${JSON.stringify(join(home, ".docker"))},
        tls: { enabled: false, verify: false, caFile: null, certFile: null, keyFile: null } },
    selectors: Object.fromEntries(NATIVE_RUNTIME_SELECTOR_KEYS.map(key => [key, process.env[key] ?? null])),
});
let lock;
if (!mode.startsWith('acquire')) {
    lock = createSessionLock(getProjectId(project), profile);
    setSession(lock, project, profile);
}
setupSignalHandlers();
process.send({ event: 'phase', phase: mode.startsWith('acquire') ? 'acquiring' : 'arming' });
if (mode === 'acquire-signal') {
    // Observe delivery without replacing the facade's real signal listener.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.send({ event: 'signal-observed', signal }));
}
let guardian;
let directGuardian;
let pendingRefusals;
let extraGuardian;
if (mode.startsWith('acquire')) {
    const resume = new Promise((resolve) => {
        const listener = (message) => {
            if (message.event === 'resume-inspection') { process.off('message', listener); resolve(message); }
        };
        process.on('message', listener);
    });
    const failInspection = new Promise((resolve) => {
        const listener = (message) => {
            if (message.event === 'fail-inspection') { process.off('message', listener); resolve(); }
        };
        process.on('message', listener);
    });
    try {
        const acquired = await acquireHostSessionOwnership({ projectId: getProjectId(project), projectPath: project, profile }, async () => {
            lock = getCurrentSession().lockFile;
            process.send({ event: 'phase', phase: 'inspecting', lock });
            process.send({ event: 'inspecting', lock });
            const continuation = await resume;
            if (mode === 'acquire-fail') {
                const active = observeActiveSessionsForContainer(getProjectId(project), lock);
                process.send({ event: 'diagnostic-observed', lock, active, predecessorPresent: existsSync(continuation.predecessorLock) });
                await failInspection;
                throw new Error('Owned fixture pre-ACK inspection failure');
            }
            return { known: true, containerId: initialId, runtime: 'docker' };
        });
        lock = acquired.lockFile;
        if (mode !== 'acquire-join') { setSessionCleanupEnabled(true); await confirmSessionOwnership(); }
        const childPids = readFileSync('/proc/' + process.pid + '/task/' + process.pid + '/children', 'utf8').trim().split(/\\s+/).filter(Boolean).map(Number);
        if (childPids.length !== 1) throw new Error('Expected one exact native guardian child after acquisition');
        guardian = childPids[0];
    } catch (error) {
        console.error(error);
        process.send({ event: 'acquisition-failed', lock });
        setInterval(() => {}, 1000);
        // No normal container setup or fallback destructive operation follows.
        await new Promise(() => {});
    }
} else if (mode === 'replacement') {
    setSessionContainerId(initialId);
    process.send({ event: 'arming', lock });
    try { guardian = await armSessionOwnership(); }
    catch (error) {
        console.error(error);
        let fallbackError = false;
        try { cleanupSession(); } catch { fallbackError = true; }
        process.send({ event: 'replacement-failed', lock, fallbackError });
        setInterval(() => {}, 1000);
        await new Promise(() => {});
    }
} else if (mode === 'direct') {
    // Keep the actual entry's ChildProcess handle so its OS exit status is
    // observable, with a real parent PID, receipt and private HOME binding.
    directGuardian = spawn(process.execPath, [${JSON.stringify(join(distribution, "session-ownership-guardian.js"))}, String(process.pid)], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: process.env,
    });
    directGuardian.stderr.on('data', (chunk) => process.stderr.write(chunk));
    const waitFrame = (type) => new Promise((resolve, reject) => {
        const message = (frame) => {
            if (frame.type === type) { directGuardian.off('message', message); resolve(frame); }
            else if (frame.type === 'error') reject(new Error('Guardian rejected native fixture'));
        };
        directGuardian.on('message', message);
        directGuardian.once('error', reject);
    });
    const ready = waitFrame('ready');
    directGuardian.send({ type: 'init', binding: { lockFile: lock, projectPath: project, profile }, receipt: captureNativeSessionOwnership(lock), runtimeInvocation: getRuntimeInvocation() });
    await ready;
    const acknowledged = waitFrame('ack');
    directGuardian.send({ type: 'update', sequence: 1, containerId: initialId, cleanupEnabled: true });
    await acknowledged;
    guardian = directGuardian.pid;
    directGuardian.once('exit', (code, signal) => process.send({ event: 'guardian-exit', code, signal }));
    process.once('exit', () => directGuardian.kill());
} else if (mode === 'pending') {
    const firstArm = armSessionOwnership();
    let overwrite = false;
    let clear = false;
    try { setSession(lock + '.other', project, profile); } catch { overwrite = true; }
    try { clearSession(); } catch { clear = true; }
    const duplicateArm = armSessionOwnership().then((pid) => { extraGuardian = pid; return false; }, () => true);
    guardian = await firstArm;
    pendingRefusals = { overwrite, clear, arm: await duplicateArm };
    // This fixture represents a completed launch, rather than a failed join.
    if (initialId) { setSessionContainerId(initialId); setSessionCleanupEnabled(true); await confirmSessionOwnership(); }
} else {
    guardian = await armSessionOwnership();
    if (initialId) { setSessionContainerId(initialId); setSessionCleanupEnabled(true); await confirmSessionOwnership(); }
}
process.send({ event: 'ready', lock, guardian, pendingRefusals, extraGuardian });
const hold = setInterval(() => {}, 1000);
process.on('message', async (message) => {
    try {
        if (message.event === 'direct-disconnect') directGuardian.disconnect();
        if (message.event === 'clear') {
            clearSession();
            process.send({ event: 'cleared' });
        }
        if (message.event === 'active-refusals') {
            let overwrite = false;
            let arm = false;
            try { setSession(lock + '.other', project, profile); } catch { overwrite = true; }
            try { extraGuardian = await armSessionOwnership(); } catch { arm = true; }
            process.send({ event: 'refused', overwrite, arm, extraGuardian });
        }
        if (message.event === 'cleanup') {
            cleanupSession();
            cleanupSession();
            clearInterval(hold);
            process.send({ event: 'cleaned' }, () => process.exit(0));
        }
        if (message.event === 'blocked-update') {
            setSessionContainerId(message.id);
            // The new captured identity has completed its fixture launch; its
            // own permission ACK remains queued while synchronous setup blocks.
            setSessionCleanupEnabled(true);
            // Real synchronous setup blocks the owner's event loop while the
            // independently running guardian sends its update acknowledgement.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500);
            await confirmSessionOwnership();
            process.send({ event: 'updated' });
        }
    } catch (error) { console.error(error); process.exitCode = 1; process.emit('SIGTERM'); }
});
`);
    });

    afterEach(async () => {
        // Only exact children and guardian PIDs learned from our own READY
        // messages are eligible for signals. Never scan or kill by command/name.
        for (const owner of owners) {
            if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill("SIGKILL");
        }
        for (const owner of owners) {
            await eventually(() => owner.child.exitCode !== null || owner.child.signalCode !== null, "owned child exit");
        }
        for (const [pid, token] of guardians) {
            // Numeric grandchild PIDs are safe to signal only while their
            // native process identity still matches our READY observation.
            if (token && linuxStartToken(pid) === token) process.kill(pid, "SIGKILL");
            await eventually(() => token ? linuxStartToken(pid) !== token : !running(pid), "owned guardian exit");
        }
        owners.length = 0;
        guardians.clear();
        rmSync(root, { recursive: true, force: true });
    });

    // The owned fake runtime uses a POSIX executable, like the existing shutdown cases.
    it.skipIf(process.platform === "win32").each([false, true])("READY avoids held cleanup loading and terminal exit awaits it (loader rejects %s)", async rejectLoad => {
        const trace = join(root, "guardian-loads.jsonl");
        const held = join(root, "cleanup-held");
        const release = join(root, "cleanup-release");
        const loader = join(root, "cleanup-loader.mjs");
        const preload = join(root, "cleanup-register.mjs");
        const cleanupUrl = pathToFileURL(join(distribution, "composition/session-cleanup.js")).href;
        writeFileSync(trace, "");
        writeFileSync(loader, `
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
export async function load(url, context, nextLoad) {
    appendFileSync(${JSON.stringify(trace)}, JSON.stringify(url) + '\\n');
    if (url === ${JSON.stringify(cleanupUrl)}) {
        writeFileSync(${JSON.stringify(held)}, url);
        while (!existsSync(${JSON.stringify(release)})) await new Promise(resolve => setTimeout(resolve, 10));
        if (${rejectLoad}) throw new Error('owned deferred cleanup loader rejection');
    }
    return nextLoad(url, context);
}
`);
        writeFileSync(preload, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(loader).href)}, import.meta.url);`);
        const project = join(root, "project");
        const projectId = `${basename(project).toLowerCase().replace(/[^a-z0-9-]/g, "-")}-${createHash("sha256").update(project).digest("hex").slice(0, 12)}`;
        const locks = join(home, ".ccc", "run", "locks");
        mkdirSync(locks, { recursive: true });
        const lock = join(locks, `${projectId}--loader-proof.lock`);
        writeFileSync(lock, String(process.pid));
        const receipt = captureNativeSessionOwnership(lock);
        const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href,
            join(distribution, "session-ownership-guardian.js"), String(process.pid)], {
            cwd: root,
            env: { HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
                PATH: process.platform === "win32" ? `${bin};${dirname(process.execPath)}` : `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
                CCC_RUNTIME: "docker", CCC_TEST_RUNTIME_LOG: log, CCC_DEVICE_BROKER_AUTO_START: "0",
                ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const owner: Owner = { child, messages: [], output: "" };
        owners.push(owner);
        child.stderr!.on("data", chunk => { owner.output += String(chunk); });
        child.on("error", error => { owner.output += error.message; });
        child.on("message", message => { owner.messages.push(message); });
        const started = Date.now();
        child.send({ type: "init", binding: { lockFile: lock, projectPath: project }, receipt, runtimeInvocation: fixtureInvocation(join(bin, "docker"), home) });
        await eventually(() => owner.messages.some(message => (message as { type?: string }).type === "ready"),
            `native guardian READY while cleanup loader held: ${owner.output}`, 5000);
        expect(Date.now() - started).toBeLessThan(5000);
        expect(existsSync(held)).toBe(false);
        const startupLoads = readFileSync(trace, "utf8").trim().split("\n").map(line => JSON.parse(line) as string);
        expect(startupLoads).toContain(pathToFileURL(join(distribution, "composition/session-ownership-native.js")).href);
        expect(startupLoads.some(url => /session-cleanup|device-lab-admin|device-lab-broker/.test(url))).toBe(false);
        child.send({ type: "update", sequence: 1, containerId: idA, cleanupEnabled: true });
        await eventually(() => owner.messages.some(message => (message as { type?: string }).type === "ack"), "captured ID ACK", 5000);
        child.disconnect();
        await eventually(() => existsSync(held), "authorized cleanup reaches actual held module");
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(child.exitCode).toBeNull();
        expect(child.signalCode).toBeNull();
        expect(stops()).toEqual([]);
        expect(existsSync(lock)).toBe(true);
        writeFileSync(release, "release");
        await eventually(() => child.exitCode !== null || child.signalCode !== null, "deferred cleanup terminal exit");
        expect(child.signalCode).toBeNull();
        expect(child.exitCode).toBe(rejectLoad ? 1 : 0);
        expect(stops()).toEqual(rejectLoad ? [] : [["stop", idA]]);
        expect(existsSync(lock)).toBe(rejectLoad);
        if (rejectLoad) expect(owner.output).toContain("Session ownership guardian failure:");
    });

    function calls(): string[][] {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    }

    function stops(): string[][] {
        return calls().filter((args) => args[0] === "stop");
    }

    function launch(profile = "", containerId = "", project = "project", failStop = false, mode = "facade"): Owner {
        expect(existsSync(join(distribution, "session-ownership-guardian.js")), "build must emit the guardian entry").toBe(true);
        const child = spawn(process.execPath, [ownerScript, join(root, project), profile, containerId, mode], {
            cwd: root,
            env: {
                HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
                PATH: process.platform === "win32" ? `${bin};${dirname(process.execPath)}`
                    : `${bin}:${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`,
                CCC_RUNTIME: "docker", CCC_TEST_RUNTIME_LOG: log, MISE_DISABLE: "1",
                CCC_TEST_STOP_FAIL: failStop ? "1" : "0",
                CCC_DEVICE_BROKER_AUTO_START: "0",
                ...(mode === "replacement" ? {
                    NODE_OPTIONS: `--import=${pathToFileURL(guardianGateScript).href}`,
                    CCC_TEST_GUARDIAN_GATE: join(root, "guardian-gate"),
                } : {}),
                ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        const owner: Owner = { child, messages: [], output: "" };
        owners.push(owner);
        child.stdout!.on("data", (chunk) => { owner.output += String(chunk); });
        child.stderr!.on("data", (chunk) => { owner.output += String(chunk); });
        child.on("error", (error) => { owner.output += error.message; });
        child.on("message", (message) => {
            owner.messages.push(message);
            const ready = message as Partial<Ready>;
            const extra = (message as { extraGuardian?: number }).extraGuardian;
            // A regression that unexpectedly arms twice must still let the
            // fixture join every exact monitor it created before failing.
            if (Number.isInteger(extra)) guardians.set(extra!, linuxStartToken(extra!));
            if (ready.event === "ready" && Number.isInteger(ready.guardian)) {
                guardians.set(ready.guardian!, linuxStartToken(ready.guardian!));
                owner.ready = ready as Ready;
            }
        });
        return owner;
    }

    async function ready(owner: Owner): Promise<Owner & { ready: Ready }> {
        const child = owner.child;
        const diagnostic = () => JSON.stringify({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
            phase: owner.messages.filter(message => (message as { event?: string }).event === "phase").at(-1) ?? "before fixture phase",
            messages: owner.messages, stderrAndOutput: owner.output });
        try {
            await eventually(() => {
                if (child.exitCode !== null || child.signalCode !== null) throw new Error("Owner exited before READY");
                return owner.ready !== undefined;
            }, "built owner READY");
        } catch (error) {
            throw new Error(`${error instanceof Error ? error.message : String(error)}: ${diagnostic()}`, { cause: error });
        }
        expect(owner.ready!.guardian).toBeGreaterThan(0);
        expect(owner.ready!.guardian).not.toBe(child.pid);
        expect(running(owner.ready!.guardian)).toBe(true);
        if (process.platform === "linux") expect(guardians.get(owner.ready!.guardian)).toMatch(/^[0-9]+$/);
        expect(existsSync(owner.ready!.lock)).toBe(true);
        return owner as Owner & { ready: Ready };
    }

    async function start(profile = "", containerId = "", project = "project", failStop = false, direct = false, pending = false): Promise<Owner & { ready: Ready }> {
        return ready(launch(profile, containerId, project, failStop, direct ? "direct" : pending ? "pending" : "facade"));
    }

    async function frame(owner: Owner, event: string): Promise<{ event: string; lock: string; fallbackError?: boolean; active?: string[]; predecessorPresent?: boolean }> {
        await eventually(() => {
            if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error(`Owner exited before ${event}: ${owner.output}`);
            return owner.messages.some((message) => (message as { event?: string }).event === event);
        }, `owned fixture ${event}`);
        return owner.messages.find((message) => (message as { event?: string }).event === event) as { event: string; lock: string; fallbackError?: boolean; active?: string[]; predecessorPresent?: boolean };
    }

    async function kill(owner: Owner): Promise<void> {
        expect(owner.child.kill("SIGKILL")).toBe(true);
        await eventually(() => owner.child.signalCode !== null, "SIGKILL owner exit");
    }

    it("removes a ready owner's claim after SIGKILL without another CCC query", async () => {
        const owner = await start();
        await kill(owner);
        await eventually(() => !existsSync(owner.ready.lock), "autonomous claim removal");
        await eventually(() => !running(owner.ready.guardian), "guardian completion");
        expect(calls()).toEqual([]); // No acknowledged ID means no runtime discovery or stop.
    });

    it.skipIf(process.platform === "win32")("preserves another host owner and stops only the final acknowledged exact ID", async () => {
        const first = await start("", idA);
        const last = await start("", idB);
        await kill(first);
        await eventually(() => !existsSync(first.ready.lock), "first claim removal");
        await eventually(() => !running(first.ready.guardian), "first guardian exit");
        expect(existsSync(last.ready.lock)).toBe(true);
        expect(running(last.ready.guardian)).toBe(true);
        expect(stops()).toEqual([]);
        await kill(last);
        await eventually(() => !existsSync(last.ready.lock), "last claim removal");
        await eventually(() => !running(last.ready.guardian), "last guardian exit");
        expect(stops()).toEqual([["stop", idB]]);
        // Device cleanup may detect runtime flavor. Container name discovery
        // (ps/inspect) and any other runtime operation remain forbidden here.
        const metadata = new Set([
            JSON.stringify(["--version"]),
            JSON.stringify(["info", "--format", "{{.OperatingSystem}}"]),
            JSON.stringify(["info", "--format", "{{json .SecurityOptions}}"]),
        ]);
        expect(calls().filter((args) => !metadata.has(JSON.stringify(args)))).toEqual(stops());
    });

    it.skipIf(process.platform === "win32")("isolates profile and sibling project ownership", async () => {
        const base = await start("", idA);
        const profile = await start("work", idB);
        const sibling = await start("", "", "sibling");
        await kill(base);
        await eventually(() => !existsSync(base.ready.lock), "base claim removal");
        await eventually(() => !running(base.ready.guardian), "base guardian exit");
        expect(existsSync(profile.ready.lock)).toBe(true);
        expect(existsSync(sibling.ready.lock)).toBe(true);
        expect(stops()).toEqual([["stop", idA]]);
        await kill(profile);
        await eventually(() => !existsSync(profile.ready.lock), "profile claim removal");
        await eventually(() => !running(profile.ready.guardian), "profile guardian exit");
        expect(existsSync(sibling.ready.lock)).toBe(true);
        expect(stops()).toEqual([["stop", idA], ["stop", idB]]);
    });

    it.skipIf(process.platform === "win32")("normal cleanup stops once and releases the guardian", async () => {
        const owner = await start("", idA);
        owner.child.send({ event: "cleanup" });
        await eventually(() => owner.child.exitCode !== null, "normal owner exit");
        expect(owner.child.exitCode, owner.output).toBe(0);
        await eventually(() => !running(owner.ready.guardian), "released guardian exit");
        expect(existsSync(owner.ready.lock)).toBe(false);
        expect(stops()).toEqual([["stop", idA]]);
    });

    it.skipIf(process.platform === "win32")("preserves a same-path successor even when its record bytes match", async () => {
        const owner = await start("", idA);
        const bytes = readFileSync(owner.ready.lock);
        const replacement = `${owner.ready.lock}.replacement`;
        writeFileSync(replacement, bytes);
        renameSync(replacement, owner.ready.lock);
        await kill(owner);
        await eventually(() => !running(owner.ready.guardian), "guardian receipt rejection exit");
        expect(readFileSync(owner.ready.lock)).toEqual(bytes);
        expect(stops()).toEqual([]);
    });

    it.skipIf(process.platform !== "linux")("surfaces unexpected guardian death and performs owned failure cleanup", async () => {
        const owner = await start("", idA);
        expect(linuxStartToken(owner.ready.guardian)).toBe(guardians.get(owner.ready.guardian));
        process.kill(owner.ready.guardian, "SIGKILL");
        await eventually(() => owner.child.exitCode !== null, "owner failure after monitor loss");
        expect(owner.child.exitCode, owner.output).toBe(1);
        expect(owner.output).toContain("Host session ownership monitor failed");
        expect(existsSync(owner.ready.lock)).toBe(false);
        expect(stops()).toEqual([["stop", idA]]);
    });

    it.skipIf(process.platform === "win32")("accepts an acknowledged update queued during synchronous setup longer than five seconds", async () => {
        const owner = await start("", idA);
        owner.child.send({ event: "blocked-update", id: idB });
        await eventually(() => {
            if (owner.child.exitCode !== null || owner.child.signalCode !== null) throw new Error(`False ACK failure after synchronous setup: ${owner.output}`);
            return owner.messages.some((message) => (message as { event?: string }).event === "updated");
        }, "acknowledgement after synchronous setup");
        expect(existsSync(owner.ready.lock)).toBe(true);
        expect(stops()).toEqual([]);
        await kill(owner);
        await eventually(() => !existsSync(owner.ready.lock), "final updated-ID cleanup");
        await eventually(() => !running(owner.ready.guardian), "updated guardian exit");
        expect(stops()).toEqual([["stop", idB]]);
    });

    it.skipIf(process.platform === "win32")("retains an ended host claim after three failed exact-ID shutdown attempts and logs the failure", async () => {
        const owner = await start("", idA, "project", true);
        await kill(owner);
        expect(existsSync(owner.ready.lock)).toBe(true);
        await eventually(() => !running(owner.ready.guardian), "bounded failed-cleanup guardian exit");
        await eventually(() => owner.output.includes("Session ownership guardian failure:"), "visible ended-host cleanup failure");
        expect(existsSync(owner.ready.lock)).toBe(true);
        expect(stops()).toEqual(Array.from({ length: 3 }, () => ["stop", idA]));
        // Process disappearance alone does not establish a grandchild exit code.
    });

    it.skipIf(process.platform === "win32")("the emitted guardian reports nonzero OS exit status when disconnected cleanup fails", async () => {
        const owner = await start("", idB, "project", true, true);
        owner.child.send({ event: "direct-disconnect" });
        await eventually(() => owner.messages.some((message) => (message as { event?: string }).event === "guardian-exit"), "joined guardian failure status");
        const result = owner.messages.find((message) => (message as { event?: string }).event === "guardian-exit") as { code: number | null; signal: string | null };
        expect(result.code).toBe(1);
        expect(result.signal).toBeNull();
        expect(existsSync(owner.ready.lock)).toBe(true);
        expect(owner.output).toContain("Session ownership guardian failure:");
        expect(stops()).toEqual(Array.from({ length: 3 }, () => ["stop", idB]));
    });

    it.skipIf(process.platform === "win32")("clearing an active session cleans its claim and stops once before releasing protection", async () => {
        const owner = await start("", idA);
        owner.child.send({ event: "clear" });
        await eventually(() => owner.messages.some((message) => (message as { event?: string }).event === "cleared"), "active clear completion");
        expect(existsSync(owner.ready.lock)).toBe(false);
        expect(stops()).toEqual([["stop", idA]]);
        await eventually(() => !running(owner.ready.guardian), "cleared guardian release");
        expect(owner.child.exitCode).toBeNull();
        expect(owner.child.signalCode).toBeNull();
        await kill(owner);
        expect(stops()).toEqual([["stop", idA]]);
    });

    it.skipIf(process.platform === "win32")("refuses active session overwrite and duplicate arm while retaining the original protection", async () => {
        const owner = await start("", idA);
        owner.child.send({ event: "active-refusals" });
        await eventually(() => owner.messages.some((message) => (message as { event?: string }).event === "refused"), "active ownership refusals");
        expect(owner.messages.find((message) => (message as { event?: string }).event === "refused"))
            .toEqual({ event: "refused", overwrite: true, arm: true });
        expect(existsSync(owner.ready.lock)).toBe(true);
        expect(running(owner.ready.guardian)).toBe(true);
        expect(existsSync(`${owner.ready.lock}.other`)).toBe(false);
        expect(stops()).toEqual([]);
        await kill(owner);
        await eventually(() => !existsSync(owner.ready.lock), "original ownership autonomous cleanup");
        await eventually(() => !running(owner.ready.guardian), "original ownership guardian completion");
        expect(stops()).toEqual([["stop", idA]]);
    });

    it.skipIf(process.platform === "win32")("refuses overwrite, clear and duplicate arm during the pending READY handshake", async () => {
        const owner = await start("", idB, "project", false, false, true);
        expect(owner.ready.pendingRefusals).toEqual({ overwrite: true, arm: true, clear: true });
        expect(existsSync(`${owner.ready.lock}.other`)).toBe(false);
        expect(stops()).toEqual([]);
        await kill(owner);
        await eventually(() => !existsSync(owner.ready.lock), "pending-handshake original claim cleanup");
        await eventually(() => !running(owner.ready.guardian), "pending-handshake guardian completion");
        expect(stops()).toEqual([["stop", idB]]);
    });

    it.skipIf(process.platform !== "linux")("atomic acquisition hands off an existing ID before pruning a dead predecessor", async () => {
        const predecessor = await start("", idA);
        const successor = launch("", idA, "project", false, "acquire");
        const inspected = await frame(successor, "inspecting");
        const guard = `${predecessor.ready.lock.slice(0, predecessor.ready.lock.lastIndexOf("--"))}.container-lifecycle.guard`;
        expect((JSON.parse(readFileSync(guard, "utf8")) as { pid: number }).pid).toBe(successor.child.pid);
        expect(existsSync(inspected.lock)).toBe(true);
        await kill(predecessor);
        // The inspection rendezvous still holds the real lifecycle guard;
        // neither reconciliation nor predecessor cleanup can consume its ID.
        expect(existsSync(predecessor.ready.lock)).toBe(true);
        expect(running(predecessor.ready.guardian)).toBe(true);
        expect(stops()).toEqual([]);
        successor.child.send({ event: "resume-inspection" });
        const acquired = await ready(successor);
        expect(acquired.ready.lock).toBe(inspected.lock);
        await eventually(() => !existsSync(predecessor.ready.lock), "post-ACK predecessor pruning");
        await eventually(() => !running(predecessor.ready.guardian), "predecessor guardian after handoff");
        expect(stops()).toEqual([]);
        // Acquisition captures idA without authority; the successful fixture
        // explicitly acknowledges launch permission before it reports READY.
        await kill(acquired);
        await eventually(() => !existsSync(acquired.ready.lock), "acquired owner autonomous cleanup");
        await eventually(() => !running(acquired.ready.guardian), "acquired guardian exit");
        expect(stops()).toEqual([["stop", idA]]);
    });

    it.skipIf(process.platform !== "linux").each(["SIGKILL", "SIGTERM"] as const)("failed join followed by %s releases its claim without stopping the captured background ID", async signal => {
        const candidate = launch("", idA, "project", false, "acquire-join");
        const inspected = await frame(candidate, "inspecting");
        candidate.child.send({ event: "resume-inspection" });
        const acquired = await ready(candidate);
        expect(acquired.ready.lock).toBe(inspected.lock);
        candidate.child.kill(signal);
        await eventually(() => candidate.child.exitCode !== null || candidate.child.signalCode !== null, "failed join owner exit");
        await eventually(() => !existsSync(acquired.ready.lock), "failed join claim release");
        await eventually(() => !running(acquired.ready.guardian), "failed join guardian exit");
        expect(stops()).toEqual([]);
        expect(calls().filter(args => args[0] !== "--version")).toEqual([]);
    });

    it.skipIf(process.platform !== "linux")("pre-ACK acquisition failure preserves the predecessor's authority to stop its ID", async () => {
        const predecessor = await start("", idA);
        const candidate = launch("", idB, "project", false, "acquire-fail");
        const inspected = await frame(candidate, "inspecting");
        const guard = `${predecessor.ready.lock.slice(0, predecessor.ready.lock.lastIndexOf("--"))}.container-lifecycle.guard`;
        expect((JSON.parse(readFileSync(guard, "utf8")) as { pid: number }).pid).toBe(candidate.child.pid);
        await kill(predecessor);
        expect(existsSync(predecessor.ready.lock)).toBe(true);
        expect(stops()).toEqual([]);
        candidate.child.send({ event: "resume-inspection", predecessorLock: predecessor.ready.lock });
        const observed = await frame(candidate, "diagnostic-observed");
        expect(observed.active).not.toContain(basename(predecessor.ready.lock));
        expect(observed.active).toContain(basename(inspected.lock));
        expect(observed.predecessorPresent).toBe(true);
        expect(existsSync(predecessor.ready.lock)).toBe(true);
        expect(stops()).toEqual([]);
        candidate.child.send({ event: "fail-inspection" });
        await frame(candidate, "acquisition-failed");
        expect(existsSync(inspected.lock)).toBe(false);
        await eventually(() => !existsSync(predecessor.ready.lock), "preserved predecessor's ended-owner cleanup");
        await eventually(() => !running(predecessor.ready.guardian), "preserved predecessor guardian exit");
        // If failed acquisition pruned A first, A's receipt check would reject
        // cleanup and this acknowledged ID could never be stopped.
        expect(stops()).toEqual([["stop", idA]]);
        expect(candidate.ready).toBeUndefined();
    });

    it.skipIf(process.platform !== "linux").each(["SIGINT", "SIGTERM", "SIGHUP"] as const)("emitted %s during inspection waits for owned rollback and preserves the foreign owner", async signal => {
        const predecessor = await start("", idA);
        const candidate = launch("", idB, "project", false, "acquire-signal");
        const inspected = await frame(candidate, "inspecting");
        const guard = `${predecessor.ready.lock.slice(0, predecessor.ready.lock.lastIndexOf("--"))}.container-lifecycle.guard`;
        expect((JSON.parse(readFileSync(guard, "utf8")) as { pid: number }).pid).toBe(candidate.child.pid);
        expect(candidate.child.kill(signal)).toBe(true);
        await frame(candidate, "signal-observed");
        expect(candidate.child.exitCode).toBeNull();
        expect(candidate.child.signalCode).toBeNull();
        expect(existsSync(inspected.lock)).toBe(true);
        expect(existsSync(guard)).toBe(true);
        expect(existsSync(predecessor.ready.lock)).toBe(true);
        expect(stops()).toEqual([]);
        candidate.child.send({ event: "resume-inspection" });
        await eventually(() => candidate.child.exitCode !== null || candidate.child.signalCode !== null, "interrupted acquisition settles and exits");
        expect(candidate.child.signalCode, candidate.output).toBeNull();
        expect(candidate.child.exitCode, candidate.output).toBe(0);
        expect(existsSync(inspected.lock)).toBe(false);
        expect(existsSync(guard)).toBe(false);
        expect(existsSync(predecessor.ready.lock)).toBe(true);
        expect(running(predecessor.ready.guardian)).toBe(true);
        expect(stops()).toEqual([]);
        expect(candidate.ready).toBeUndefined();
        await kill(predecessor);
        await eventually(() => !existsSync(predecessor.ready.lock), "preserved foreign owner cleanup");
        await eventually(() => !running(predecessor.ready.guardian), "preserved foreign guardian completion");
        expect(stops()).toEqual([["stop", idA]]);
    });

    it.skipIf(process.platform !== "linux")("pending READY replacement and fallback cleanup preserve the successor and its resources", async () => {
        const owner = launch("", idA, "project", false, "replacement");
        const arming = await frame(owner, "arming");
        const gate = join(root, "guardian-gate");
        await eventually(() => existsSync(`${gate}.entered`), "native guardian bootstrap rendezvous");
        const monitor = JSON.parse(readFileSync(`${gate}.entered`, "utf8")) as { pid: number; parent: number };
        expect(monitor.parent).toBe(owner.child.pid);
        expect(running(monitor.pid)).toBe(true);
        const token = linuxStartToken(monitor.pid);
        expect(token).toMatch(/^[0-9]+$/);
        guardians.set(monitor.pid, token);
        const bytes = readFileSync(arming.lock);
        const replacement = `${arming.lock}.replacement`;
        writeFileSync(replacement, bytes);
        renameSync(replacement, arming.lock);
        // The preload gate delays the actual emitted entry, without replacing
        // its IPC, validation, cleanup adapters, or runtime implementation.
        writeFileSync(`${gate}.release`, "release");
        const failed = await frame(owner, "replacement-failed");
        expect(failed.fallbackError).toBe(true);
        await eventually(() => !running(monitor.pid), "rejected guardian disposal");
        expect(readFileSync(arming.lock)).toEqual(bytes);
        expect(calls()).toEqual([]);
        expect(owner.ready).toBeUndefined();
    });
});
