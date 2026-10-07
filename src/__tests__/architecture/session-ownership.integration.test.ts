import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// These children import the shipped JavaScript, outside Vitest's source aliases.
// After SIGKILL the observer uses only native filesystem/process operations:
// no session query can reconcile the claim on behalf of the guardian.
const distribution = fileURLToPath(new URL("../../../dist/", import.meta.url));
const idA = "a".repeat(64);
const idB = "b".repeat(64);

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
const args = process.argv.slice(2);
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
import { setRuntimeOverride } from ${moduleUrl("container-runtime.js")};
import { captureNativeSessionOwnership } from ${moduleUrl("adapters/session-ownership.js")};
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
const [project, profileArg, initialId, mode] = process.argv.slice(2);
const profile = profileArg || undefined;
setRuntimeOverride('docker');
let lock;
if (!mode.startsWith('acquire')) {
    lock = createSessionLock(getProjectId(project), profile);
    setSession(lock, project, profile);
}
setupSignalHandlers();
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
    directGuardian.send({ type: 'init', binding: { lockFile: lock, projectPath: project, profile }, receipt: captureNativeSessionOwnership(lock) });
    await ready;
    const acknowledged = waitFrame('ack');
    directGuardian.send({ type: 'update', sequence: 1, containerId: initialId, runtime: 'docker', cleanupEnabled: true });
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
        await eventually(() => {
            if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Owner exited before READY: ${owner.output}`);
            return owner.ready !== undefined;
        }, "built owner READY");
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

    it.skipIf(process.platform === "win32")("removes an ended host claim despite failed exact-ID shutdown and logs the failure", async () => {
        const owner = await start("", idA, "project", true);
        await kill(owner);
        await eventually(() => !existsSync(owner.ready.lock), "ended owner claim removal after failed stop");
        await eventually(() => !running(owner.ready.guardian), "bounded failed-cleanup guardian exit");
        await eventually(() => owner.output.includes("Ended host session cleanup failed"), "visible ended-host cleanup failure");
        expect(stops()).toEqual([["stop", idA]]);
        // Process disappearance alone does not establish a grandchild exit code.
    });

    it.skipIf(process.platform === "win32")("the emitted guardian reports nonzero OS exit status when disconnected cleanup fails", async () => {
        const owner = await start("", idB, "project", true, true);
        owner.child.send({ event: "direct-disconnect" });
        await eventually(() => owner.messages.some((message) => (message as { event?: string }).event === "guardian-exit"), "joined guardian failure status");
        const result = owner.messages.find((message) => (message as { event?: string }).event === "guardian-exit") as { code: number | null; signal: string | null };
        expect(result.code).toBe(1);
        expect(result.signal).toBeNull();
        expect(existsSync(owner.ready.lock)).toBe(false);
        expect(owner.output).toContain("Ended host session cleanup failed");
        expect(stops()).toEqual([["stop", idB]]);
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
