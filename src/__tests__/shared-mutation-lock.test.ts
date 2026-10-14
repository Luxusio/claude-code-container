import { appendFileSync, existsSync, linkSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { hostname, tmpdir } from "os";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    copyFileAtomically as copyNestedFileAtomically,
    withSharedMutationLock as withNestedSharedMutationLock,
    withSharedMutationLockAsync,
    writeFileAtomically as writeNestedFileAtomically,
} from "@ccc/device-lab/providers/state/shared-mutation-lock.mjs";
import {
    copyFileAtomically as copyHostFileAtomically,
    withSharedMutationLock as withHostSharedMutationLock,
    withSharedMutationLockAsync as withHostSharedMutationLockAsync,
    writeFileAtomically as writeHostFileAtomically,
} from "@ccc/device-lab/device-lab-shared-state.js";
import { readDeviceRuntimeProcessIdentity } from "@ccc/device-lab/device-lab-process-identity.js";
import { readProcessIdentity } from "@ccc/device-lab/providers/state/process-identity.mjs";

const withSharedMutationLock = withNestedSharedMutationLock;
let tokenCounter = 0;

function testToken(): string {
    tokenCounter += 1;
    return tokenCounter.toString(16).padStart(32, "0");
}

const nativeLockModules = [
    ["host", "../../packages/device-lab/dist/device-lab-shared-state.js"],
    ["direct", "../../packages/device-lab/providers/state/shared-mutation-lock.mjs"],
] as const;

type NativeLockScenario = "stale" | "malformed" | "publication";
const nativeLockChild = String.raw`
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { join } from "node:path";
    const [file, moduleUrl, root, role, mode, scenario, ownerDeathArchiveJson] = process.argv.slice(1);
    const ownerDeathArchive = ownerDeathArchiveJson ? JSON.parse(ownerDeathArchiveJson) : undefined;
    const native = { openSync: fs.openSync, writeFileSync: fs.writeFileSync, closeSync: fs.closeSync,
        renameSync: fs.renameSync, rmSync: fs.rmSync, readFileSync: fs.readFileSync };
    const marker = (event, text = "") => {
        const path = join(root, role + "-" + event);
        native.writeFileSync(path + ".writing", text);
        native.renameSync(path + ".writing", path);
    };
    const pause = new Int32Array(new SharedArrayBuffer(4));
    function gate(event) {
        const until = Date.now() + 25000;
        while (!fs.existsSync(join(root, role + "-" + event))) {
            if (Date.now() >= until) throw new Error(role + " gate timeout: " + event);
            Atomics.wait(pause, 0, 0, 5);
        }
    }
    const callbackEvent = event => {
        fs.appendFileSync(join(root, "callbacks.jsonl"), JSON.stringify({ role, event, pid: process.pid }) + "\n");
        marker(event, ownToken);
    };
    let descriptor, ownToken = "", pausedOpen = false, pausedMove = false, pausedRelease = false, pausedOwnerDeath = false;
    fs.openSync = function(path, flags, ...args) {
        if (path === file && flags === "wx") marker("attempted");
        const fd = native.openSync(path, flags, ...args);
        if (path === file && flags === "wx") {
            descriptor = fd;
            if (role === "A" && scenario === "publication" && !pausedOpen) {
                pausedOpen = true; marker("opened"); gate("write");
            }
        }
        return fd;
    };
    fs.writeFileSync = function(path, text, ...args) {
        native.writeFileSync(path, text, ...args);
        if (path === descriptor) ownToken = JSON.parse(String(text)).token;
    };
    fs.closeSync = function(fd) {
        native.closeSync(fd);
        if (fd === descriptor) { descriptor = undefined; marker("published", ownToken); }
    };
    fs.renameSync = function(source, destination) {
        const suffix = scenario === "malformed" ? ".malformed" : ".stale";
        if (role === "A" && scenario !== "publication" && !pausedMove && source === file && String(destination).endsWith(suffix)) {
            pausedMove = true; marker("observed"); gate("before-move");
            native.renameSync(source, destination);
            marker("moved", JSON.stringify({ path: destination, record: JSON.parse(native.readFileSync(destination, "utf8")) }));
            gate("after-move");
            return;
        }
        native.renameSync(source, destination);
    };
    fs.rmSync = function(path, ...args) {
        if (role === "C" && ownerDeathArchive && !pausedOwnerDeath && path === ownerDeathArchive.path) {
            let record;
            try { record = JSON.parse(native.readFileSync(path, "utf8")); } catch {}
            if (record?.token === ownerDeathArchive.token && record?.pid === ownerDeathArchive.pid) {
                // Production has qualified this archive dead; let the controller join and journal B first.
                pausedOwnerDeath = true;
                marker("dead-archive-paused", JSON.stringify({ path, token: record.token, pid: record.pid }));
                gate("dead-archive-remove");
            }
        }
        if (role === "B" && !pausedRelease && String(path).startsWith(file + ".")) {
            let record;
            try { record = JSON.parse(native.readFileSync(path, "utf8")); } catch {}
            if (record?.token === ownToken) {
                pausedRelease = true; marker("release-paused", String(path)); gate("release");
            }
        }
        native.rmSync(path, ...args);
    };
    syncBuiltinESMExports();
    const api = await import(moduleUrl);
    const operation = () => {
        callbackEvent("enter");
        if (role === "B" || role === "C") gate("leave");
        callbackEvent("exit");
        return role;
    };
    const options = { waitMs: 20000, staleMs: 1 };
    try {
        const result = mode === "sync" ? api.withSharedMutationLock(file, operation, options)
            : await api.withSharedMutationLockAsync(file, operation, options);
        if (result !== role) throw new Error("wrong native callback result");
        marker("done");
    } catch (error) {
        marker("failed", String(error?.stack || error));
        throw error;
    }
`;

function startNativeLockChild(file: string, modulePath: string, root: string, role: "A" | "B" | "C", mode: "sync" | "async", scenario: NativeLockScenario, ownerDeathArchive?: { path: string; token: string; pid: number }) {
    let terminal = false;
    let child!: ReturnType<typeof execFile>;
    const done = new Promise<{ error: Error | null; stdout: string; stderr: string }>(resolve => {
        child = execFile(process.execPath, ["--input-type=module", "-e", nativeLockChild, file, new URL(modulePath, import.meta.url).href, root, role, mode, scenario, ...(ownerDeathArchive ? [JSON.stringify(ownerDeathArchive)] : [])], {
            cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 30_000, windowsHide: true,
        }, (error, stdout, stderr) => { terminal = true; resolve({ error, stdout: String(stdout), stderr: String(stderr) }); });
    });
    return { child, done, terminal: () => terminal };
}

async function awaitNativeMarker(root: string, event: string, children: ReturnType<typeof startNativeLockChild>[]) {
    const until = performance.now() + 15_000;
    while (!existsSync(join(root, event))) {
        for (const child of children) {
            if (child.terminal()) {
                const outcome = await child.done;
                if (outcome.error) throw new Error(`Native lock child failed awaiting ${event}: ${outcome.stderr || outcome.stdout || outcome.error.message}`, { cause: outcome.error });
            }
        }
        if (performance.now() >= until) throw new Error(`Native lock schedule timed out awaiting ${event}`);
        await new Promise(resolve => setTimeout(resolve, 5));
    }
}

function expectNativeCallbacksSerialized(root: string, expected: string[]) {
    const events = readFileSync(join(root, "callbacks.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { role: string; event: string });
    let active: string | undefined;
    const entered: string[] = [];
    for (const event of events) {
        if (event.event === "enter") { expect(active, `${event.role} entered while ${active} remained active`).toBeUndefined(); active = event.role; entered.push(event.role); }
        else { expect(active).toBe(event.role); active = undefined; }
    }
    expect(active).toBeUndefined();
    expect(entered.sort()).toEqual([...expected].sort());
}

describe("device-lab shared mutation lock", () => {
    const roots: string[] = [];

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    function lockPath() {
        const root = mkdtempSync(join(tmpdir(), "ccc-shared-mutation-lock-"));
        roots.push(root);
        return join(root, "state.mutation.lock");
    }

    async function runNativeDisplacement(modulePath: string, mode: "sync" | "async", scenario: "stale" | "malformed", death?: "reclaimer" | "owner") {
        const file = lockPath(), root = dirname(file);
        const children: ReturnType<typeof startNativeLockChild>[] = [];
        const expectedTerminated = new Set<ReturnType<typeof startNativeLockChild>>();
        const old = new Date(Date.now() - 5000);
        writeFileSync(file, scenario === "malformed" ? "" : JSON.stringify({ token: testToken(), pid: 2147483647, host: hostname(), createdAt: old.toISOString() }));
        utimesSync(file, old, old);
        const signal = (event: string) => writeFileSync(join(root, event), "");
        const wait = (event: string) => awaitNativeMarker(root, event, children.filter(child => !expectedTerminated.has(child)));
        const start = (role: "A" | "B" | "C", ownerDeathArchive?: { path: string; token: string; pid: number }) => { const child = startNativeLockChild(file, modulePath, root, role, mode, scenario, ownerDeathArchive); children.push(child); return child; };
        try {
            const a = start("A");
            await wait("A-observed");
            const b = start("B");
            await wait("B-enter");
            const ownerToken = readFileSync(join(root, "B-enter"), "utf8");
            expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(ownerToken);
            signal("A-before-move");
            await wait("A-moved");
            const moved = JSON.parse(readFileSync(join(root, "A-moved"), "utf8")) as { path: string; record: { token: string; pid: number } };
            expect(moved.record.token).toBe(ownerToken);
            expect(JSON.parse(readFileSync(moved.path, "utf8")).token).toBe(ownerToken);
            expect(existsSync(file)).toBe(false);
            if (death === "reclaimer") { expectedTerminated.add(a); a.child.kill("SIGKILL"); expect((await a.done).error).not.toBeNull(); }
            let ownerDeathArchive: { path: string; token: string; pid: number } | undefined;
            let ownerArchiveBytes: string | undefined;
            if (death === "owner") {
                const ownerEntries = readFileSync(join(root, "callbacks.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line) as { role: string; event: string; pid: number }).filter(event => event.role === "B" && event.event === "enter");
                expect(ownerEntries).toHaveLength(1);
                expect(b.child.pid).toBeGreaterThan(0);
                expect(ownerEntries[0].pid).toBe(b.child.pid);
                expect(moved.record.pid).toBe(b.child.pid);
                ownerDeathArchive = { path: moved.path, token: ownerToken, pid: ownerEntries[0].pid };
                ownerArchiveBytes = readFileSync(moved.path, "utf8");
                expect(JSON.parse(ownerArchiveBytes)).toMatchObject({ token: ownerToken, pid: b.child.pid });
            }
            const c = start("C", ownerDeathArchive);
            await wait("C-published");
            const candidateToken = readFileSync(join(root, "C-published"), "utf8");
            expect(candidateToken).not.toBe(ownerToken);
            expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(candidateToken);
            await new Promise(resolve => setTimeout(resolve, 150));
            expect(existsSync(join(root, "C-enter")), "a real published candidate must wait while B operates from its displaced record").toBe(false);
            expect(existsSync(join(root, "A-enter"))).toBe(false);
            if (death === "owner") {
                expect(existsSync(join(root, "C-dead-archive-paused"))).toBe(false);
                expect(readFileSync(moved.path, "utf8")).toBe(ownerArchiveBytes);
                expectedTerminated.add(b);
                b.child.kill("SIGKILL");
                expect((await b.done).error).not.toBeNull();
                appendFileSync(join(root, "callbacks.jsonl"), `${JSON.stringify({ role: "B", event: "terminated" })}\n`);
                expect(b.terminal()).toBe(true);
                await wait("C-dead-archive-paused");
                expect(JSON.parse(readFileSync(join(root, "C-dead-archive-paused"), "utf8"))).toEqual(ownerDeathArchive);
                expect(readFileSync(moved.path, "utf8")).toBe(ownerArchiveBytes);
                signal("C-dead-archive-remove");
                signal("A-after-move");
            } else {
                if (death !== "reclaimer") signal("A-after-move");
                signal("B-leave");
                await wait("B-release-paused");
                expect(existsSync(join(root, "B-exit"))).toBe(true);
                expect(JSON.parse(readFileSync(moved.path, "utf8")).token).toBe(ownerToken);
                await new Promise(resolve => setTimeout(resolve, 50));
                expect(existsSync(join(root, "C-enter")), "B's callback exit alone cannot erase surviving owned release evidence").toBe(false);
                expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(candidateToken);
                signal("B-release");
                const result = await b.done;
                expect(result.error, result.stderr || result.stdout).toBeNull();
                expect(existsSync(moved.path)).toBe(false);
            }
            await wait("C-enter");
            expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(candidateToken);
            signal("C-leave");
            for (const child of children) {
                const outcome = await child.done;
                if ((child === a && death === "reclaimer") || (child === b && death === "owner")) continue;
                expect(outcome.error, outcome.stderr || outcome.stdout).toBeNull();
            }
            expect(children.every(child => child.terminal())).toBe(true);
            expectNativeCallbacksSerialized(root, death === "reclaimer" ? ["B", "C"] : ["A", "B", "C"]);
            expect(readdirSync(root).filter(name => name.startsWith("state.mutation.lock"))).toEqual([]);
            expect(c.terminal()).toBe(true);
        } finally {
            for (const event of ["A-before-move", "A-after-move", "A-write", "B-leave", "B-release", "C-leave", "C-dead-archive-remove"]) signal(event);
            for (const child of children) if (!child.terminal()) child.child.kill("SIGKILL");
            await Promise.all(children.map(child => child.done));
        }
    }

    for (const [label, modulePath] of nativeLockModules) {
        for (const mode of ["sync", "async"] as const) {
            it(`${label} ${mode} serializes three actual native contenders when a delayed stale reclaimer moves a live owner`, async () => {
                await runNativeDisplacement(modulePath, mode, "stale");
            }, 60_000);

            it(`${label} ${mode} requalifies a real claim displaced before descriptor publication finishes`, async () => {
                const file = lockPath(), root = dirname(file);
                const children: ReturnType<typeof startNativeLockChild>[] = [];
                const signal = (event: string) => writeFileSync(join(root, event), "");
                const wait = (event: string) => awaitNativeMarker(root, event, children);
                const start = (role: "A" | "B" | "C") => { const child = startNativeLockChild(file, modulePath, root, role, mode, "publication"); children.push(child); return child; };
                try {
                    start("A");
                    await wait("A-opened");
                    expect(readFileSync(file, "utf8")).toBe("");
                    const old = new Date(Date.now() - 5000);
                    utimesSync(file, old, old);
                    const b = start("B");
                    await wait("B-enter");
                    const ownerToken = readFileSync(join(root, "B-enter"), "utf8");
                    const c = start("C");
                    await wait("C-attempted");
                    signal("A-write");
                    await wait("A-published");
                    await new Promise(resolve => setTimeout(resolve, 150));
                    expect(existsSync(join(root, "A-enter")), "writing a displaced native descriptor cannot authorize callback entry").toBe(false);
                    expect(existsSync(join(root, "C-enter"))).toBe(false);
                    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(ownerToken);
                    signal("B-leave");
                    await wait("B-release-paused");
                    await new Promise(resolve => setTimeout(resolve, 50));
                    expect(existsSync(join(root, "A-enter"))).toBe(false);
                    expect(existsSync(join(root, "C-enter"))).toBe(false);
                    signal("B-release");
                    expect((await b.done).error).toBeNull();
                    await wait("C-enter");
                    signal("C-leave");
                    for (const child of children) {
                        const outcome = await child.done;
                        expect(outcome.error, outcome.stderr || outcome.stdout).toBeNull();
                    }
                    expect(c.terminal()).toBe(true);
                    expect(children.every(child => child.terminal())).toBe(true);
                    expectNativeCallbacksSerialized(root, ["A", "B", "C"]);
                    expect(readdirSync(root).filter(name => name.startsWith("state.mutation.lock"))).toEqual([]);
                } finally {
                    for (const event of ["A-write", "B-leave", "B-release", "C-leave"]) signal(event);
                    for (const child of children) if (!child.terminal()) child.child.kill("SIGKILL");
                    await Promise.all(children.map(child => child.done));
                }
            }, 60_000);
        }
    }

    for (const [label, modulePath, mode] of [
        ["host", nativeLockModules[0][1], "sync"],
        ["direct", nativeLockModules[1][1], "async"],
    ] as const) {
        it(`${label} ${mode} protects a complete owner captured by a delayed malformed reclaimer`, async () => {
            await runNativeDisplacement(modulePath, mode, "malformed");
        }, 60_000);
        it(`${label} ${mode} retains the displaced owner's barrier after the reclaimer dies`, async () => {
            await runNativeDisplacement(modulePath, mode, "stale", "reclaimer");
        }, 60_000);
        it(`${label} ${mode} recovers the archived owner only after its real child has exited`, async () => {
            await runNativeDisplacement(modulePath, mode, "stale", "owner");
        }, 60_000);
    }

    function linkedBackendPath() {
        const root = mkdtempSync(join(tmpdir(), "ccc-linked-backend-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-linked-backend-external-"));
        roots.push(root, external);
        const owner = join(root, ".ccc", "devices", "owners", "test-owner");
        const backend = join(owner, "android");
        writeFileSync(join(root, "source.txt"), "trusted-source");
        mkdirSync(owner, { recursive: true });
        symlinkSync(external, backend, process.platform === "win32" ? "junction" : "dir");
        return { root, external, backend, source: join(root, "source.txt") };
    }

    for (const [label, sync, asyncLock] of [
        ["host", withHostSharedMutationLock, withHostSharedMutationLockAsync],
        ["direct", withNestedSharedMutationLock, withSharedMutationLockAsync],
    ] as const) {
        it(`${label} refuses expired budgets before entering an uncontended callback`, async () => {
            const callback = vi.fn();
            const options = { waitBudget: { remaining: () => 0 } };
            expect(() => sync(lockPath(), callback, options)).toThrow();
            await expect(asyncLock(lockPath(), callback, options)).rejects.toThrow();
            expect(callback).not.toHaveBeenCalled();
        });
        it(`${label} bounds contended acquisition and never enters after the owner releases`, async () => {
            const file = lockPath();
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const ready = new Promise<void>((resolve) => { entered = resolve; });
            const owner = asyncLock(file, async () => { entered(); await gate; });
            await ready;
            const callback = vi.fn();
            const deadline = performance.now() + 40;
            const options = { waitBudget: { remaining: () => Math.max(0, deadline - performance.now()) } };
            try {
                await expect(asyncLock(file, callback, options)).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                expect(performance.now() - deadline).toBeLessThan(1000);
            } finally { release(); await owner; }
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(callback).not.toHaveBeenCalled();
        });
    }

    for (const [label, sync, asyncLock] of [
        ["host", withHostSharedMutationLock, withHostSharedMutationLockAsync],
        ["direct", withNestedSharedMutationLock, withSharedMutationLockAsync],
    ] as const) {
        it(`${label} retains established live and foreign archive names for the full sync and async budget`, async () => {
            for (const mode of ["sync", "async"] as const) {
                for (const [nonce, suffix, foreign] of [
                    ["0123456789abcdef", "stale", false],
                    ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "release", true],
                    ["a".repeat(32), "malformed", false],
                    ["11111111-2222-3333-4444-555555555555", "malformed", true],
                ] as const) {
                    const file = lockPath();
                    const archived = `${process.platform === "win32" ? file.replace("state.mutation.lock", "STATE.MUTATION.LOCK") : file}.${nonce}.${suffix}`;
                    const contents = JSON.stringify({ token: testToken(), pid: foreign ? 2147483647 : process.pid, host: foreign ? `${hostname()}-foreign` : hostname() });
                    writeFileSync(archived, contents);
                    const old = new Date(Date.now() - 5000);
                    utimesSync(archived, old, old);
                    const started = performance.now(), deadline = started + 47;
                    const operation = vi.fn();
                    const options = { waitMs: 1000, staleMs: 1, waitBudget: { remaining: () => Math.max(0, deadline - performance.now()) } };
                    if (mode === "sync") expect(() => sync(file, operation, options)).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
                    else await expect(asyncLock(file, operation, options)).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                    expect(performance.now() - started).toBeGreaterThanOrEqual(42);
                    expect(performance.now() - started).toBeLessThan(1000);
                    expect(operation).not.toHaveBeenCalled();
                    expect(readFileSync(archived, "utf8")).toBe(contents);
                    expect(existsSync(file)).toBe(false);
                }
            }
        });

        it(`${label} excludes temporary files and another lock's archives from its admission evidence`, async () => {
            for (const mode of ["sync", "async"] as const) {
                const file = lockPath();
                const unrelated = [ `${file}.${process.pid}.0123456789abcdef.tmp`, `${file}-other.0123456789abcdef.stale`, `${file}.not-a-native-nonce.stale` ];
                const contents = JSON.stringify({ token: testToken(), pid: process.pid, host: hostname() });
                for (const path of unrelated) writeFileSync(path, contents);
                const options = { waitBudget: { remaining: () => 1000 } };
                expect(mode === "sync" ? sync(file, () => "entered", options) : await asyncLock(file, () => "entered", options)).toBe("entered");
                expect(existsSync(file)).toBe(false);
                for (const path of unrelated) expect(readFileSync(path, "utf8")).toBe(contents);
            }
        });

        it(`${label} retains multiply linked archived bytes as uncertain native evidence`, async () => {
            for (const mode of ["sync", "async"] as const) {
                const file = lockPath(), archived = `${file}.0123456789abcdef.stale`, external = `${file}.external`;
                const contents = JSON.stringify({ token: testToken(), pid: 2147483647, host: hostname() });
                writeFileSync(external, contents);
                linkSync(external, archived);
                const old = new Date(Date.now() - 5000);
                utimesSync(archived, old, old);
                const deadline = performance.now() + 47;
                const operation = vi.fn();
                const options = { staleMs: 1, waitBudget: { remaining: () => Math.max(0, deadline - performance.now()) } };
                if (mode === "sync") expect(() => sync(file, operation, options)).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
                else await expect(asyncLock(file, operation, options)).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                expect(operation).not.toHaveBeenCalled();
                expect(readFileSync(archived, "utf8")).toBe(contents);
                expect(readFileSync(external, "utf8")).toBe(contents);
                expect(existsSync(file)).toBe(false);
            }
        });
    }

    it("both native facades preserve primary failure and report surviving own archive cleanup failure", async () => {
        for (const implementation of ["host", "provider"] as const) {
            for (const asynchronous of [false, true]) {
                for (const fails of [false, true]) {
                    const file = lockPath(), archived = `${file}.0123456789abcdef.stale`;
                    const primary = Object.assign(new Error("operation failed after displacement"), { code: "primary-operation" });
                    const nativeFailure = Object.assign(new Error("owned archive removal denied"), { code: "EIO" });
                    let ownToken = "";
                    vi.resetModules();
                    vi.doMock("fs", async importOriginal => {
                        const actual = await importOriginal<typeof import("fs")>();
                        return { ...actual, rmSync(path: import("fs").PathLike, options?: import("fs").RmOptions) {
                            if (path === archived) throw nativeFailure;
                            actual.rmSync(path, options);
                        } };
                    });
                    try {
                        const api = implementation === "host"
                            ? await import("@ccc/device-lab/device-lab-shared-state.js?owned-archive-failure")
                            : await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?owned-archive-failure");
                        const operation = () => {
                            ownToken = JSON.parse(readFileSync(file, "utf8")).token;
                            renameSync(file, archived);
                            if (fails) throw primary;
                            return "complete";
                        };
                        let observed: unknown;
                        try {
                            if (asynchronous) await api.withSharedMutationLockAsync(file, operation, { waitBudget: { remaining: () => 1000 } });
                            else api.withSharedMutationLock(file, operation, { waitBudget: { remaining: () => 1000 } });
                        } catch (error) { observed = error; }
                        const release = fails ? (observed as AggregateError).errors?.[1] : observed;
                        expect(release).toMatchObject({ code: "shared-mutation-lock-release-failed" });
                        expect((release as Error).cause).toBe(nativeFailure);
                        if (fails) {
                            expect(observed).toBeInstanceOf(AggregateError);
                            expect((observed as AggregateError).cause).toBe(primary);
                            expect((observed as AggregateError).errors[0]).toBe(primary);
                            expect((observed as AggregateError).errors).toHaveLength(2);
                            expect(observed).toMatchObject({ code: primary.code });
                        }
                        expect(existsSync(file)).toBe(false);
                        expect(JSON.parse(readFileSync(archived, "utf8")).token).toBe(ownToken);
                    } finally { vi.doUnmock("fs"); vi.resetModules(); }
                }
            }
        }
    });

    it("preserves stale and malformed host locks when automatic reclamation is disabled", () => {
        for (const contents of ["", JSON.stringify({ token: testToken(), pid: 2147483647, host: hostname() })]) {
            const file = lockPath();
            writeFileSync(file, contents);
            const old = new Date(Date.now() - 5000);
            utimesSync(file, old, old);
            const callback = vi.fn();
            expect(() => withHostSharedMutationLock(file, callback, {
                waitMs: 1, staleMs: 1, reclaimStale: false,
            })).toThrow(/Timed out acquiring shared mutation lock/);
            expect(callback).not.toHaveBeenCalled();
            expect(readFileSync(file, "utf8")).toBe(contents);
        }
    });

    it.each([
        ["host", "../../packages/device-lab/dist/device-lab-shared-state.js"],
        ["direct", "../../packages/device-lab/providers/state/shared-mutation-lock.mjs"],
    ])("%s preserves native identity from a fresh async acquisition in subsequent sync claims", async (_label, modulePath) => {
        const file = lockPath();
        const script = `
            import assert from "node:assert/strict";
            import { existsSync, readFileSync } from "node:fs";
            const { withSharedMutationLock, withSharedMutationLockAsync } = await import(process.argv[2]);
            const file = process.argv[1];
            const record = () => JSON.parse(readFileSync(file, "utf8"));
            const cold = withSharedMutationLock(file, record);
            assert.equal(existsSync(file), false, "cold sync claim must release its token");
            if (process.platform === "win32") {
                assert.equal(cold.processIdentityStatus, "recorded", "cold Windows sync claim must record native identity");
                assert.ok(cold.processIdentity, "Native Windows cold synchronous process identity is unavailable");
                assert.equal(cold.processIdentity.pid, process.pid);
                assert.ok(cold.processIdentity.startToken.length > 0);
                assert.match(cold.processIdentity.commandHash, /^[a-f0-9]{64}$/);
            }
            const captured = await withSharedMutationLockAsync(file, record, { waitMs: 15000 });
            assert.equal(existsSync(file), false, "async claim must release its token");
            const identity = captured.processIdentity;
            if (process.platform === "win32") assert.deepEqual(identity, cold.processIdentity, "async claim must retain cold synchronous native identity");
            assert.ok(identity, "Native " + process.platform + " async process identity is unavailable; cold/warm qualification cannot pass");
            assert.equal(identity.pid, process.pid);
            assert.equal(typeof identity.startToken, "string");
            assert.ok(identity.startToken.length > 0);
            assert.match(identity.commandHash, /^[a-f0-9]{64}$/);
            assert.notEqual(captured.processIdentityStatus, "unavailable");
            const warm = withSharedMutationLock(file, record);
            assert.deepEqual(warm.processIdentity, identity, "warm sync claim must publish the captured native identity");
            assert.notEqual(warm.processIdentityStatus, "unavailable");
            assert.equal(existsSync(file), false, "warm sync claim must release its token");
        `;
        await new Promise<void>((resolve, reject) => {
            execFile(process.execPath, ["--input-type=module", "-e", script, file, new URL(modulePath, import.meta.url).href], {
                cwd: fileURLToPath(new URL("../../", import.meta.url)),
                timeout: 30_000,
                windowsHide: true,
            }, (error, stdout, stderr) => {
                if (error) reject(new Error(`${_label} native cold/async/warm identity regression failed: ${stderr || stdout || error.message}`, { cause: error }));
                else resolve();
            });
        });
    }, 35_000);

    it("removes its token-fenced lock after the operation", async () => {
        for (const [acquire, acquireAsync, readIdentity] of [
            [withHostSharedMutationLock, withHostSharedMutationLockAsync, readDeviceRuntimeProcessIdentity],
            [withNestedSharedMutationLock, withSharedMutationLockAsync, readProcessIdentity],
        ] as const) {
            const file = lockPath();
            const captured = await acquireAsync(file, () => JSON.parse(readFileSync(file, "utf8")), { waitMs: 15_000 });
            expect(existsSync(file)).toBe(false);
            const result = acquire(file, () => {
                const lock = JSON.parse(readFileSync(file, "utf8"));
                expect(lock).toEqual(expect.objectContaining({ token: expect.any(String), pid: process.pid, host: hostname(), bootId: expect.any(String) }));
                if (process.platform === "win32") {
                    expect(captured.processIdentity, "Native Windows async identity must be available for warm publication qualification").toBeTruthy();
                    expect(lock.processIdentityStatus).not.toBe("unavailable");
                    expect(lock.processIdentity).toEqual(captured.processIdentity);
                    expect(lock.processIdentity).toEqual(readIdentity(process.pid));
                } else if (readIdentity(process.pid)) {
                    expect(lock.processIdentity).toEqual(readIdentity(process.pid));
                }
                return "done";
            });
            expect(result).toBe("done");
            expect(existsSync(file)).toBe(false);
        }
    }, 35_000);

    it("recovers an old malformed lock without removing a live lock", () => {
        const malformed = lockPath();
        writeFileSync(malformed, "");
        const old = new Date(Date.now() - 5000);
        utimesSync(malformed, old, old);
        expect(withSharedMutationLock(malformed, () => "recovered", { waitMs: 1000, staleMs: 1000 })).toBe("recovered");
        expect(existsSync(malformed)).toBe(false);

        const live = lockPath();
        const record = {
            token: testToken(),
            pid: process.pid,
            host: hostname(),
            createdAt: new Date().toISOString(),
            processIdentity: readProcessIdentity(process.pid),
        };
        writeFileSync(live, JSON.stringify(record));
        expect(() => withSharedMutationLock(live, () => "unexpected", { waitMs: 30, staleMs: 1 })).toThrow(/Timed out acquiring shared mutation lock/);
        expect(JSON.parse(readFileSync(live, "utf8"))).toEqual(record);
    });

    it("does not steal aged legacy locks while their PID is alive", () => {
        for (const acquire of [withHostSharedMutationLock, withNestedSharedMutationLock]) {
            const file = lockPath();
            const record = { token: testToken(), pid: process.pid, host: hostname() };
            writeFileSync(file, JSON.stringify(record));
            const old = new Date(Date.now() - 5000);
            utimesSync(file, old, old);
            expect(() => acquire(file, () => "unexpected", { waitMs: 30, staleMs: 1 }))
                .toThrow(/Timed out acquiring shared mutation lock/);
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
        }
    });

    it("keeps identity-matched locks live and reclaims only positively observed reused-PID identities", async () => {
        const variants = [
            { acquire: withHostSharedMutationLock, acquireAsync: withHostSharedMutationLockAsync, readIdentity: readDeviceRuntimeProcessIdentity },
            { acquire: withNestedSharedMutationLock, acquireAsync: withSharedMutationLockAsync, readIdentity: readProcessIdentity },
        ];
        for (const { acquire, acquireAsync, readIdentity } of variants) {
            const processIdentity = readIdentity(process.pid);
            if (!processIdentity) continue;

            const live = lockPath();
            const liveRecord = { token: testToken(), pid: process.pid, host: hostname(), processIdentity };
            writeFileSync(live, JSON.stringify(liveRecord));
            const old = new Date(Date.now() - 5000);
            utimesSync(live, old, old);
            expect(() => acquire(live, () => "unexpected", { waitMs: 30, staleMs: 1 }))
                .toThrow(/Timed out acquiring shared mutation lock/);
            expect(JSON.parse(readFileSync(live, "utf8"))).toEqual(liveRecord);

            const reused = lockPath();
            const reusedRecord = {
                token: testToken(),
                pid: process.pid,
                host: hostname(),
                processIdentity: { ...processIdentity, startToken: `${processIdentity.startToken}-previous` },
            };
            writeFileSync(reused, JSON.stringify(reusedRecord));
            utimesSync(reused, old, old);
            if (process.platform === "win32") {
                const callback = vi.fn();
                expect(() => acquire(reused, callback, { waitMs: 30, staleMs: 60_000 }))
                    .toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
                expect(callback).not.toHaveBeenCalled();
                expect(JSON.parse(readFileSync(reused, "utf8"))).toEqual(reusedRecord);
            } else {
                expect(acquire(reused, () => "recovered", { waitMs: 1000, staleMs: 60_000 })).toBe("recovered");
            }
            if (process.platform !== "win32") {
                writeFileSync(reused, JSON.stringify(reusedRecord));
                utimesSync(reused, old, old);
            }
            expect(await acquireAsync(reused, () => "recovered asynchronously", { waitMs: 15_000, staleMs: 60_000 }))
                .toBe("recovered asynchronously");
            expect(existsSync(reused)).toBe(false);
        }
    }, 45_000);

    it("never age-reclaims identity-unavailable live owners", () => {
        for (const acquire of [withHostSharedMutationLock, withNestedSharedMutationLock]) {
            const live = lockPath();
            const record = {
                token: testToken(),
                pid: process.pid,
                host: hostname(),
                processIdentityStatus: "unavailable",
            };
            writeFileSync(live, JSON.stringify(record));
            const fiveHoursOld = new Date(Date.now() - 5 * 60 * 60 * 1000);
            utimesSync(live, fiveHoursOld, fiveHoursOld);
            expect(() => acquire(live, () => "unexpected", { waitMs: 30, staleMs: 1 }))
                .toThrow(/Timed out acquiring shared mutation lock/);

            const veryOld = lockPath();
            const veryOldRecord = { ...record, token: testToken() };
            writeFileSync(veryOld, JSON.stringify(veryOldRecord));
            const nineHoursOld = new Date(Date.now() - 9 * 60 * 60 * 1000);
            utimesSync(veryOld, nineHoursOld, nineHoursOld);
            expect(() => acquire(veryOld, () => "unexpected", { waitMs: 30, staleMs: 1 }))
                .toThrow(/Timed out acquiring shared mutation lock/);
            expect(JSON.parse(readFileSync(veryOld, "utf8"))).toEqual(veryOldRecord);
        }
    });

    it.each(["Z", "X", "R", "S", "malformed", "incomplete-Z", "denied"])("both native facades qualify %s owners with unavailable identity in sync and async acquisition", async state => {
        const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
        Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
        const ownerPid = 424242;
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        vi.resetModules();
        vi.doMock("fs", async original => {
            const actual = await original<typeof import("fs")>();
            return { ...actual, readFileSync(path: import("fs").PathOrFileDescriptor, options?: unknown) {
                if (path === `/proc/${ownerPid}/stat`) {
                    if (state === "denied") throw Object.assign(new Error("denied"), { code: "EACCES" });
                    return state === "malformed" ? "unreadable stat" : state === "incomplete-Z" ? `${ownerPid} (owner) Z 0` : `${ownerPid} (owner) ${[state, ...Array(18).fill("0"), "987"].join(" ")}`;
                }
                return actual.readFileSync(path, options as never);
            } };
        });
        try {
            const host = await import("@ccc/device-lab/device-lab-shared-state.js?owner-state");
            const direct = await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?owner-state");
            for (const acquire of [host.withSharedMutationLock, host.withSharedMutationLockAsync, direct.withSharedMutationLock, direct.withSharedMutationLockAsync]) {
                const file = lockPath();
                const bytes = JSON.stringify({ token: testToken(), pid: ownerPid, host: hostname(), processIdentityStatus: "unavailable" });
                writeFileSync(file, bytes);
                const old = new Date(Date.now() - 1000);
                utimesSync(file, old, old);
                const callback = vi.fn(() => "admitted");
                if (state === "Z" || state === "X") {
                    expect(await acquire(file, callback, { waitMs: 100 })).toBe("admitted");
                    expect(callback).toHaveBeenCalledTimes(1);
                    expect(existsSync(file)).toBe(false);
                } else {
                    let failure: unknown;
                    try { await acquire(file, callback, { waitMs: 30, staleMs: 1 }); } catch (error) { failure = error; }
                    expect(failure).toMatchObject({ code: "shared-mutation-lock-timeout" });
                    expect(callback).not.toHaveBeenCalled();
                    expect(readFileSync(file, "utf8")).toBe(bytes);
                }
            }
        } finally {
            vi.doUnmock("fs"); vi.resetModules(); kill.mockRestore();
            Object.defineProperty(process, "platform", platform);
        }
    });

    it("preserves foreign-host boot identities even when the file is very old", async () => {
        for (const acquire of [withHostSharedMutationLockAsync, withSharedMutationLockAsync]) {
            const file = lockPath();
            const bytes = JSON.stringify({ token: testToken(), pid: process.pid, host: `${hostname()}-foreign`, bootId: "foreign-boot" });
            writeFileSync(file, bytes);
            const old = new Date(Date.now() - 9 * 60 * 60 * 1000);
            utimesSync(file, old, old);
            const callback = vi.fn();
            await expect(acquire(file, callback, { waitMs: 30, staleMs: 1 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(callback).not.toHaveBeenCalled();
            expect(readFileSync(file, "utf8")).toBe(bytes);
        }
    });

    it("preserves aged local owners when native liveness cannot be observed", async () => {
        const kill = vi.spyOn(process, "kill").mockImplementation(() => {
            throw Object.assign(new Error("liveness probe unavailable"), { code: "EIO" });
        });
        try {
            for (const acquire of [withHostSharedMutationLock, withNestedSharedMutationLock,
                withHostSharedMutationLockAsync, withSharedMutationLockAsync]) {
                const file = lockPath();
                const bytes = JSON.stringify({ token: testToken(), pid: 2147483647, host: hostname(), processIdentityStatus: "unavailable" });
                writeFileSync(file, bytes);
                const old = new Date(Date.now() - 9 * 60 * 60 * 1000);
                utimesSync(file, old, old);
                const callback = vi.fn();
                let observed: unknown;
                try { await acquire(file, callback, { waitMs: 30, staleMs: 1 }); }
                catch (error) { observed = error; }
                expect(observed).toMatchObject({ code: "shared-mutation-lock-timeout" });
                expect(callback).not.toHaveBeenCalled();
                expect(readFileSync(file, "utf8")).toBe(bytes);
            }
            expect(kill).toHaveBeenCalledWith(2147483647, 0);
        } finally { kill.mockRestore(); }
    });

    it("refuses same-process synchronous contention across host/direct wrappers and normalized aliases", async () => {
        for (const ownerLock of [withHostSharedMutationLockAsync, withSharedMutationLockAsync]) {
            const file = lockPath();
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<void>(resolve => { entered = resolve; });
            const owner = ownerLock(file, async () => { entered(); await gate; });
            await ready;
            const bytes = readFileSync(file, "utf8");
            try {
                for (const contender of [withHostSharedMutationLock, withNestedSharedMutationLock]) {
                    const callback = vi.fn();
                    const alias = `${dirname(file)}/../${dirname(file).split(/[\\/]/).pop()}/state.mutation.lock`;
                    expect(() => contender(alias, callback, { waitMs: 1000 })).toThrow(expect.objectContaining({ code: "shared-mutation-lock-self-contention" }));
                    expect(() => contender(file, callback, { waitBudget: { remaining: () => 0 } })).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
                    expect(callback).not.toHaveBeenCalled();
                    expect(readFileSync(file, "utf8")).toBe(bytes);
                }
            } finally { release(); await owner; }
            expect(withNestedSharedMutationLock(file, () => "released")).toBe("released");
        }
    });

    it("refuses local synchronous contention through a physical alias above the fenced home", async () => {
        for (const ownerLock of [withHostSharedMutationLockAsync, withSharedMutationLockAsync]) {
            const root = mkdtempSync(join(tmpdir(), "ccc-lock-physical-alias-"));
            const aliasParent = mkdtempSync(join(tmpdir(), "ccc-lock-alias-parent-"));
            roots.push(aliasParent, root);
            const directory = join(root, "home", ".ccc", "locks");
            mkdirSync(directory, { recursive: true });
            const alias = join(aliasParent, "root-alias");
            symlinkSync(root, alias, process.platform === "win32" ? "junction" : "dir");
            const file = join(directory, "shared.guard");
            const aliasedFile = join(alias, "home", ".ccc", "locks", "shared.guard");
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<void>(resolve => { entered = resolve; });
            const owner = ownerLock(file, async () => { entered(); await gate; });
            await ready;
            const bytes = readFileSync(file, "utf8");
            try {
                for (const contender of [withHostSharedMutationLock, withNestedSharedMutationLock]) {
                    const callback = vi.fn();
                    expect(() => contender(aliasedFile, callback, { waitMs: 1000 }))
                        .toThrow(expect.objectContaining({ code: "shared-mutation-lock-self-contention" }));
                    expect(callback).not.toHaveBeenCalled();
                    expect(readFileSync(file, "utf8")).toBe(bytes);
                    expect(readFileSync(aliasedFile, "utf8")).toBe(bytes);
                }
            } finally { release(); await owner; }
            expect(existsSync(file)).toBe(false);
            expect(withHostSharedMutationLock(aliasedFile, () => "released")).toBe("released");
            expect(existsSync(file)).toBe(false);
        }
    });

    for (const [label, ownerLock, descendantLock] of [
        ["host to direct", withHostSharedMutationLockAsync, withSharedMutationLockAsync],
        ["direct to host", withSharedMutationLockAsync, withHostSharedMutationLockAsync],
    ] as const) {
        it.each([false, true])(`${label} refuses async A to B to A descendants (physical alias: %s)`, async physicalAlias => {
            const file = lockPath();
            let descendantFile = file;
            if (physicalAlias) {
                const aliasParent = mkdtempSync(join(tmpdir(), "ccc-async-lock-alias-"));
                roots.push(aliasParent);
                const alias = join(aliasParent, "owner-directory");
                symlinkSync(dirname(file), alias, process.platform === "win32" ? "junction" : "dir");
                descendantFile = join(alias, "state.mutation.lock");
            }
            const other = lockPath();
            await ownerLock(file, async () => {
                const bytes = readFileSync(file, "utf8");
                const directCallback = vi.fn();
                await expect(descendantLock(descendantFile, directCallback, { waitMs: 200 }))
                    .rejects.toMatchObject({ code: "shared-mutation-lock-self-contention" });
                expect(directCallback).not.toHaveBeenCalled();
                expect(readFileSync(file, "utf8")).toBe(bytes);
                await descendantLock(other, async () => {
                    await Promise.resolve();
                    const callback = vi.fn();
                    await expect(descendantLock(descendantFile, callback, { waitMs: 200 }))
                        .rejects.toMatchObject({ code: "shared-mutation-lock-self-contention" });
                    await expect(descendantLock(descendantFile, callback, { waitBudget: { remaining: () => 0 } }))
                        .rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                    expect(callback).not.toHaveBeenCalled();
                    expect(readFileSync(file, "utf8")).toBe(bytes);
                });
                expect(readFileSync(file, "utf8")).toBe(bytes);
            });
            expect(existsSync(file)).toBe(false);
            expect(existsSync(other)).toBe(false);
        });

        it(`${label} serializes an unrelated async caller until release`, async () => {
            const file = lockPath();
            let release!: () => void;
            let entered!: () => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<void>(resolve => { entered = resolve; });
            const owner = ownerLock(file, async () => { entered(); await gate; });
            await ready;
            const bytes = readFileSync(file, "utf8");
            const callback = vi.fn(() => "waiter admitted");
            const waiter = descendantLock(file, callback, { waitMs: 1500 });
            try {
                await new Promise(resolve => setTimeout(resolve, 25));
                expect(callback).not.toHaveBeenCalled();
                expect(readFileSync(file, "utf8")).toBe(bytes);
            } finally { release(); await owner; }
            expect(await waiter).toBe("waiter admitted");
            expect(callback).toHaveBeenCalledTimes(1);
            expect(existsSync(file)).toBe(false);
        });

        it(`${label} reacquires from an inherited context after its owner released`, async () => {
            const file = lockPath();
            let resume!: () => void;
            const gate = new Promise<void>(resolve => { resume = resolve; });
            let later!: Promise<string>;
            const callback = vi.fn(() => "reacquired");
            await ownerLock(file, async () => {
                later = (async () => {
                    await gate;
                    return descendantLock(file, callback, { waitMs: 1000 });
                })();
            });
            expect(existsSync(file)).toBe(false);
            resume();
            expect(await later).toBe("reacquired");
            expect(callback).toHaveBeenCalledTimes(1);
            expect(existsSync(file)).toBe(false);
        });
    }

    it("refuses async descendants started inside synchronous callbacks across facades", async () => {
        for (const [sync, asyncLock] of [
            [withHostSharedMutationLock, withSharedMutationLockAsync],
            [withNestedSharedMutationLock, withHostSharedMutationLockAsync],
        ] as const) {
            const file = lockPath();
            const callback = vi.fn();
            let refused!: Promise<void>;
            sync(file, () => {
                const bytes = readFileSync(file, "utf8");
                refused = expect(asyncLock(file, callback, { waitMs: 200 }))
                    .rejects.toMatchObject({ code: "shared-mutation-lock-self-contention" });
                expect(readFileSync(file, "utf8")).toBe(bytes);
            });
            await refused;
            expect(callback).not.toHaveBeenCalled();
            expect(existsSync(file)).toBe(false);
        }
    });

    it.each(["fallback-matched", "fallback-unavailable", "uuid-reboot"] as const)("qualifies live-owner boot evidence conservatively for %s", async evidence => {
        const currentUuid = "11111111-2222-4333-8444-555555555555";
        const previousUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        vi.resetModules();
        vi.doMock("fs", async importOriginal => {
            const actual = await importOriginal<typeof import("fs")>();
            return { ...actual, readFileSync(path: import("fs").PathOrFileDescriptor, options?: unknown) {
                if (path === "/proc/sys/kernel/random/boot_id") {
                    if (evidence === "uuid-reboot") return currentUuid;
                    throw Object.assign(new Error("boot UUID unavailable"), { code: "ENOENT" });
                }
                return actual.readFileSync(path, options as never);
            } };
        });
        try {
            const host = await import("@ccc/device-lab/device-lab-shared-state.js?boot-evidence");
            const direct = await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?boot-evidence");
            for (const [sync, asyncLock] of [
                [host.withSharedMutationLock, host.withSharedMutationLockAsync],
                [direct.withSharedMutationLock, direct.withSharedMutationLockAsync],
            ] as const) {
                const file = lockPath();
                const captured = await asyncLock(file, () => JSON.parse(readFileSync(file, "utf8")), { waitMs: 15_000 });
                if (evidence === "fallback-matched") {
                    expect(captured.processIdentity, "native async identity must qualify matched-owner preservation").toBeTruthy();
                }
                const bootId = evidence === "uuid-reboot" ? previousUuid
                    : `${hostname()}:${Number(String(captured.bootId).split(":").pop()) - 120}`;
                const bytes = JSON.stringify({ ...captured, token: testToken(), bootId,
                    ...(evidence === "fallback-unavailable" ? { processIdentity: undefined, processIdentityStatus: "unavailable" } : {}) });
                for (const acquire of [sync, asyncLock]) {
                    writeFileSync(file, bytes);
                    const old = new Date(Date.now() - 9 * 60 * 60 * 1000);
                    utimesSync(file, old, old);
                    const callback = vi.fn(() => "recovered");
                    let result: unknown;
                    let failure: unknown;
                    try { result = await acquire(file, callback, { waitMs: 200, staleMs: 1 }); }
                    catch (error) { failure = error; }
                    if (evidence === "uuid-reboot") {
                        expect(failure).toBeUndefined();
                        expect(result).toBe("recovered");
                        expect(callback).toHaveBeenCalledTimes(1);
                        expect(existsSync(file)).toBe(false);
                    } else {
                        expect(failure).toMatchObject({ code: "shared-mutation-lock-timeout" });
                        expect(callback).not.toHaveBeenCalled();
                        expect(readFileSync(file, "utf8")).toBe(bytes);
                    }
                }
            }
        } finally { vi.doUnmock("fs"); vi.resetModules(); }
    }, 40_000);

    it.each(["write", "close", "post-admission"] as const)("cleans complete claims after %s failure without losing the primary error", async stage => {
        for (const implementation of ["host", "provider"] as const) {
            for (const asynchronous of [false, true]) {
                for (const outcome of ["release", "successor", "release-failure"] as const) {
                    const file = lockPath();
                    const primary = Object.freeze(new Error(`${stage} failed`));
                    const successor = JSON.stringify({ token: testToken(), pid: process.pid, host: hostname() });
                    let descriptor: number | undefined;
                    let published = false;
                    let injected = false;
                    vi.resetModules();
                    vi.doMock("fs", async importOriginal => {
                        const actual = await importOriginal<typeof import("fs")>();
                        return { ...actual,
                            openSync(path: import("fs").PathLike, flags: string | number, mode?: import("fs").Mode) {
                                const fd = actual.openSync(path, flags, mode);
                                if (path === file && flags === "wx") descriptor = fd;
                                return fd;
                            },
                            writeFileSync(path: import("fs").PathOrFileDescriptor, value: string | NodeJS.ArrayBufferView, options?: import("fs").WriteFileOptions) {
                                actual.writeFileSync(path, value, options);
                                if (path === descriptor) {
                                    published = true;
                                    if (outcome === "successor") { actual.rmSync(file); actual.writeFileSync(file, successor); }
                                    if (stage === "write") throw primary;
                                }
                            },
                            closeSync(fd: number) {
                                actual.closeSync(fd);
                                if (fd === descriptor && stage === "close" && !injected) {
                                    injected = true;
                                    throw primary;
                                }
                            },
                            renameSync(source: string, destination: string) {
                                if (source === file && destination.endsWith(".release") && outcome === "release-failure") {
                                    throw Object.assign(new Error("release denied"), { code: "EIO" });
                                }
                                actual.renameSync(source, destination);
                            },
                        };
                    });
                    try {
                        const api = implementation === "host"
                            ? await import("@ccc/device-lab/device-lab-shared-state.js?claim-failure")
                            : await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?claim-failure");
                        const callback = vi.fn();
                        const options = { waitBudget: { remaining() {
                            if (stage === "post-admission" && published && !injected) { injected = true; throw primary; }
                            return 1000;
                        } } };
                        let observed: unknown;
                        try {
                            if (asynchronous) await api.withSharedMutationLockAsync(file, callback, options);
                            else api.withSharedMutationLock(file, callback, options);
                        } catch (error) { observed = error; }
                        expect(callback).not.toHaveBeenCalled();
                        if (outcome === "release-failure") {
                            expect(observed).toBeInstanceOf(AggregateError);
                            expect((observed as AggregateError).cause).toBe(primary);
                            expect((observed as AggregateError).errors[0]).toBe(primary);
                            expect((observed as AggregateError).errors[1]).toMatchObject({ code: "shared-mutation-lock-release-failed" });
                            expect(existsSync(file)).toBe(true);
                        } else {
                            expect(observed).toBe(primary);
                            if (outcome === "successor") expect(readFileSync(file, "utf8")).toBe(successor);
                            else expect(existsSync(file)).toBe(false);
                        }
                    } finally { vi.doUnmock("fs"); vi.resetModules(); }
                }
            }
        }
    });

    it("reports exact-token release failure and preserves missing or successor release outcomes", async () => {
        for (const implementation of ["host", "provider"] as const) {
            for (const asynchronous of [false, true]) {
                for (const outcome of ["owned", "missing", "successor"] as const) {
                    const file = lockPath();
                    const successor = JSON.stringify({ token: testToken(), pid: process.pid, host: hostname() });
                    vi.resetModules();
                    vi.doMock("fs", async importOriginal => {
                        const actual = await importOriginal<typeof import("fs")>();
                        return { ...actual, renameSync(source: string, destination: string) {
                            if (source === file && destination.endsWith(".release")) throw Object.assign(new Error("release denied"), { code: "EIO" });
                            actual.renameSync(source, destination);
                        } };
                    });
                    try {
                        const api = implementation === "host"
                            ? await import("@ccc/device-lab/device-lab-shared-state.js?release-failure")
                            : await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?release-failure");
                        const callback = vi.fn(() => {
                            if (outcome !== "owned") rmSync(file);
                            if (outcome === "successor") writeFileSync(file, successor);
                            return "done";
                        });
                        const invoke = () => asynchronous ? api.withSharedMutationLockAsync(file, callback) : api.withSharedMutationLock(file, callback);
                        if (outcome === "owned") {
                            if (asynchronous) await expect(invoke()).rejects.toMatchObject({ code: "shared-mutation-lock-release-failed" });
                            else expect(invoke).toThrow(expect.objectContaining({ code: "shared-mutation-lock-release-failed" }));
                            expect(existsSync(file)).toBe(true);
                        } else {
                            expect(await invoke()).toBe("done");
                            if (outcome === "successor") expect(readFileSync(file, "utf8")).toBe(successor);
                            else expect(existsSync(file)).toBe(false);
                        }
                        expect(callback).toHaveBeenCalledTimes(1);
                    } finally { vi.doUnmock("fs"); vi.resetModules(); }
                }
            }
        }
    });

    it("treats malformed identity as malformed data instead of a PID mismatch", () => {
        const file = lockPath();
        writeFileSync(file, JSON.stringify({
            token: testToken(),
            pid: process.pid,
            host: hostname(),
            processIdentity: {},
        }));
        expect(() => withSharedMutationLock(file, () => "unexpected", { waitMs: 30, staleMs: 60_000 }))
            .toThrow(/Timed out acquiring shared mutation lock/);
        expect(existsSync(file)).toBe(true);

        const old = new Date(Date.now() - 2000);
        utimesSync(file, old, old);
        expect(withSharedMutationLock(file, () => "recovered", { waitMs: 1000, staleMs: 60_000 })).toBe("recovered");
    });

    it("does not derive recovery paths from an untrusted lock token", () => {
        const file = lockPath();
        const victim = join(dirname(file), "victim.txt");
        writeFileSync(victim, "preserved");
        writeFileSync(file, JSON.stringify({ token: "../../victim.txt", pid: 2147483647, host: hostname() }));
        const old = new Date(Date.now() - 2000);
        utimesSync(file, old, old);

        expect(withSharedMutationLock(file, () => "recovered", { waitMs: 1000, staleMs: 1 })).toBe("recovered");
        expect(readFileSync(victim, "utf8")).toBe("preserved");
    });

    it("keeps async lock identity lookup off the event loop", async () => {
        vi.resetModules();
        vi.doMock("@ccc/device-lab/providers/state/process-identity.mjs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("@ccc/device-lab/providers/state/process-identity.mjs")>();
            return {
                ...actual,
                readProcessIdentity() {
                    throw new Error("synchronous identity lookup must not run");
                },
                async readProcessIdentityAsync(pid: number) {
                    await new Promise((resolve) => setTimeout(resolve, 30));
                    return actual.readProcessIdentity(pid);
                },
            };
        });
        try {
            const asyncModule = await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?async-process-identity");
            const file = lockPath();
            let timerFired = false;
            const timer = new Promise<void>((resolve) => setTimeout(() => {
                timerFired = true;
                resolve();
            }, 5));
            await Promise.all([asyncModule.withSharedMutationLockAsync(file, () => undefined), timer]);
            expect(timerFired).toBe(true);
        } finally {
            vi.doUnmock("@ccc/device-lab/providers/state/process-identity.mjs");
            vi.resetModules();
        }
    });

    it("deduplicates concurrent async observations and backs off unavailable identity", async () => {
        const processIdentity = readProcessIdentity(process.pid);
        if (!processIdentity) return;
        let asyncReadCount = 0;
        let activeReads = 0;
        let maxActiveReads = 0;
        vi.resetModules();
        vi.doMock("@ccc/device-lab/providers/state/process-identity.mjs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("@ccc/device-lab/providers/state/process-identity.mjs")>();
            return {
                ...actual,
                readProcessIdentity() {
                    throw new Error("synchronous identity lookup must not run");
                },
                async readProcessIdentityAsync() {
                    asyncReadCount += 1;
                    activeReads += 1;
                    maxActiveReads = Math.max(maxActiveReads, activeReads);
                    try {
                        await new Promise((resolve) => setTimeout(resolve, 20));
                        return null;
                    } finally {
                        activeReads -= 1;
                    }
                },
            };
        });
        try {
            const asyncModule = await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?async-process-identity-dedup");
            const files = Array.from({ length: 10 }, (_, index) => {
                const file = lockPath();
                writeFileSync(file, JSON.stringify({
                    token: testToken(),
                    pid: process.pid,
                    host: hostname(),
                    processIdentity: index === 0
                        ? processIdentity
                        : { ...processIdentity, startToken: `${processIdentity.startToken}-alternate-${index}` },
                }));
                return file;
            });
            const old = new Date(Date.now() - 5000);
            for (const file of files) utimesSync(file, old, old);

            const waiter = (file: string) => asyncModule.withSharedMutationLockAsync(
                file,
                () => "unexpected",
                { waitMs: 160, staleMs: 60_000 },
            );
            const waiters = [waiter(files[0]), waiter(files[1]), waiter(files[0]), ...files.slice(2).map(waiter)];
            await Promise.all(waiters.map((waiter) => expect(waiter).rejects.toMatchObject({
                code: "shared-mutation-lock-timeout",
            })));
            // One shared candidate-record lookup plus one observation per
            // owner key. A/B/A must not start a second A probe, and ten unique
            // owners must never exceed the four-probe global ceiling.
            expect(asyncReadCount).toBe(11);
            expect(maxActiveReads).toBe(4);
        } finally {
            vi.doUnmock("@ccc/device-lab/providers/state/process-identity.mjs");
            vi.resetModules();
        }
    });

    it("deduplicates interleaved host-source async observations", async () => {
        const processIdentity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!processIdentity) return;
        let asyncReadCount = 0;
        vi.resetModules();
        vi.doMock("@ccc/device-lab/device-lab-process-identity.js", async (importOriginal) => {
            const actual = await importOriginal<typeof import("@ccc/device-lab/device-lab-process-identity.js")>();
            return {
                ...actual,
                readDeviceRuntimeProcessIdentity() {
                    throw new Error("synchronous identity lookup must not run");
                },
                async readDeviceRuntimeProcessIdentityAsync() {
                    asyncReadCount += 1;
                    await new Promise((resolve) => setTimeout(resolve, 20));
                    return null;
                },
            };
        });
        try {
            const asyncModule = await import("@ccc/device-lab/device-lab-shared-state.js?async-process-identity-dedup");
            const fileA = lockPath();
            const fileB = lockPath();
            const records = [
                { token: testToken(), pid: process.pid, host: hostname(), processIdentity },
                {
                    token: testToken(),
                    pid: process.pid,
                    host: hostname(),
                    processIdentity: { ...processIdentity, startToken: `${processIdentity.startToken}-alternate` },
                },
            ];
            writeFileSync(fileA, JSON.stringify(records[0]));
            writeFileSync(fileB, JSON.stringify(records[1]));
            const old = new Date(Date.now() - 5000);
            utimesSync(fileA, old, old);
            utimesSync(fileB, old, old);

            const waiter = (file: string) => asyncModule.withSharedMutationLockAsync(
                file,
                () => "unexpected",
                { waitMs: 80, staleMs: 60_000 },
            );
            const waiters = [waiter(fileA), waiter(fileB), waiter(fileA), waiter(fileB), waiter(fileA)];
            await Promise.all(waiters.map((pending) => expect(pending).rejects.toMatchObject({
                code: "shared-mutation-lock-timeout",
            })));
            expect(asyncReadCount).toBe(3);
        } finally {
            vi.doUnmock("@ccc/device-lab/device-lab-process-identity.js");
            vi.resetModules();
        }
    });

    it("keeps budgeted host locks out of an occupied async identity queue and preserves the live owner", async () => {
        const identity = readDeviceRuntimeProcessIdentity(process.pid);
        if (!identity) return;
        let release!: () => void;
        let occupied!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const allSlotsOccupied = new Promise<void>((resolve) => { occupied = resolve; });
        let probes = 0;
        let blockedProbes = 0;
        vi.resetModules();
        vi.doMock("@ccc/device-lab/device-lab-process-identity.js", async (importOriginal) => {
            const actual = await importOriginal<typeof import("@ccc/device-lab/device-lab-process-identity.js")>();
            return {
                ...actual,
                async readDeviceRuntimeProcessIdentityAsync() {
                    probes++;
                    if (probes === 1) return identity;
                    blockedProbes++;
                    if (blockedProbes === 4) occupied();
                    await gate;
                    return null;
                },
            };
        });
        const waiters: Promise<unknown>[] = [];
        let bounded: Promise<unknown> | undefined;
        try {
            const module = await import("@ccc/device-lab/device-lab-shared-state.js?bounded-identity-queue");
            // Ordinary acquisition still uses the asynchronous identity reader.
            await module.withSharedMutationLockAsync(lockPath(), () => undefined);
            expect(probes).toBe(1);
            for (let index = 0; index < 4; index++) {
                const file = lockPath();
                writeFileSync(file, JSON.stringify({ token: testToken(), pid: process.pid, host: hostname(),
                    processIdentity: { ...identity, startToken: `${identity.startToken}-queue-${index}` } }));
                const old = new Date(Date.now() - 5000);
                utimesSync(file, old, old);
                waiters.push(module.withSharedMutationLockAsync(file, () => undefined, { waitMs: 40 })
                    .catch((error) => error));
            }
            await allSlotsOccupied;
            expect(probes).toBe(5);
            const file = lockPath();
            const record = { token: testToken(), pid: process.pid, host: hostname(), processIdentity: identity };
            writeFileSync(file, JSON.stringify(record));
            const old = new Date(Date.now() - 5000);
            utimesSync(file, old, old);
            const callback = vi.fn();
            const deadline = performance.now() + 30;
            bounded = module.withSharedMutationLockAsync(file, callback, {
                waitBudget: { remaining: () => Math.max(0, deadline - performance.now()) },
            }).then(() => "entered", (error) => error.code);
            const outcome = await Promise.race([
                bounded,
                new Promise((resolve) => setTimeout(() => resolve("still queued after deadline"), 150)),
            ]);
            expect(outcome).toBe("shared-mutation-lock-timeout");
            expect(callback).not.toHaveBeenCalled();
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(record);
            release();
            await Promise.all([...waiters, bounded]);
            // Releasing occupied slots must not launch a stale fifth owner probe.
            expect(probes).toBe(5);
            expect(callback).not.toHaveBeenCalled();
        } finally {
            release();
            await Promise.all([...waiters, bounded]);
            vi.doUnmock("@ccc/device-lab/device-lab-process-identity.js");
            vi.resetModules();
        }
    });

    it("never restores a mismatched moved lock over a live successor", async () => {
        const file = lockPath();
        const stale = { token: testToken(), pid: 2147483647, host: hostname() };
        const movedMismatch = { token: testToken(), pid: process.pid, host: hostname() };
        const successor = { token: testToken(), pid: process.pid, host: hostname() };
        writeFileSync(file, JSON.stringify(stale));
        const old = new Date(Date.now() - 5000);
        utimesSync(file, old, old);

        vi.resetModules();
        vi.doMock("fs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("fs")>();
            return {
                ...actual,
                renameSync(source: string, destination: string) {
                    if (source === file && destination.startsWith(`${file}.`) && destination.endsWith(".stale")) {
                        writeFileSync(file, JSON.stringify(movedMismatch));
                        actual.renameSync(source, destination);
                        writeFileSync(file, JSON.stringify(successor));
                        return;
                    }
                    actual.renameSync(source, destination);
                },
            };
        });

        try {
            const racedModule = await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?recovery-race");
            let entered = false;
            expect(() => racedModule.withSharedMutationLock(file, () => {
                entered = true;
            }, { waitMs: 30, staleMs: 1 })).toThrow(/Timed out acquiring shared mutation lock/);
            expect(entered).toBe(false);
            expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(successor);
        } finally {
            vi.doUnmock("fs");
            vi.resetModules();
        }
    });

    it.runIf(process.platform !== "win32")("does not follow linked lock records or use the target modification time", () => {
        for (const acquire of [withHostSharedMutationLock, withNestedSharedMutationLock]) {
            const file = lockPath();
            const target = `${file}.external`;
            const targetContents = JSON.stringify({ token: testToken(), pid: process.pid, host: hostname() });
            writeFileSync(target, targetContents);
            symlinkSync(target, file);
            const old = new Date(Date.now() - 5000);
            lutimesSync(file, old, old);

            expect(acquire(file, () => "recovered", { waitMs: 500, staleMs: 1000 })).toBe("recovered");
            expect(existsSync(file)).toBe(false);
            expect(readFileSync(target, "utf8")).toBe(targetContents);
        }
    });

    it.runIf(process.platform !== "win32")("rejects a linked .ccc/locks directory", () => {
        for (const acquire of [withHostSharedMutationLock, withNestedSharedMutationLock]) {
            const root = mkdtempSync(join(tmpdir(), "ccc-linked-session-lock-root-"));
            const external = mkdtempSync(join(tmpdir(), "ccc-linked-session-lock-external-"));
            roots.push(root, external);
            const cccRoot = join(root, ".ccc");
            mkdirSync(cccRoot, { recursive: true });
            symlinkSync(external, join(cccRoot, "locks"), "dir");
            const file = join(cccRoot, "locks", "container.lock");

            expect(() => acquire(file, () => "unexpected", { waitMs: 30 }))
                .toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
            expect(readdirSync(external)).toEqual([]);
        }
    });

    it.runIf(process.platform !== "win32")("rejects a linked .ccc/device-broker-private directory", () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-linked-broker-private-root-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-linked-broker-private-external-"));
        roots.push(root, external);
        const cccRoot = join(root, ".ccc");
        mkdirSync(cccRoot, { recursive: true });
        symlinkSync(external, join(cccRoot, "device-broker-private"), "dir");
        const file = join(cccRoot, "device-broker-private", "network", "hyper-v.json");

        expect(() => writeHostFileAtomically(file, "{}"))
            .toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
        expect(readdirSync(external)).toEqual([]);
    });

    it("holds an async lock until the operation settles and serializes a waiter", async () => {
        const file = lockPath();
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
        const order: string[] = [];
        const first = withSharedMutationLockAsync(file, async () => {
            order.push("first-enter");
            entered();
            await gate;
            order.push("first-exit");
        }, { waitMs: 1000 });
        await firstEntered;
        expect(existsSync(file)).toBe(true);

        const second = withHostSharedMutationLockAsync(file, async () => {
            order.push("second-enter");
        }, { waitMs: 1000 });
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(order).toEqual(["first-enter"]);

        release();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-enter", "first-exit", "second-enter"]);
        expect(existsSync(file)).toBe(false);
    });

    it("releases an async lock when the operation rejects", async () => {
        const file = lockPath();
        await expect(withSharedMutationLockAsync(file, async () => {
            throw new Error("operation failed");
        })).rejects.toThrow("operation failed");
        expect(existsSync(file)).toBe(false);
    });

    it.each(["transient", "permanent", "nonretryable", "stage-write"] as const)("preserves atomic publication outcomes after a %s failure", async failure => {
        for (const implementation of ["host", "provider"] as const) {
            const destination = lockPath();
            writeFileSync(destination, "original bytes");
            const fault = Object.assign(new Error("atomic publication denied"), { code: failure === "nonretryable" || failure === "stage-write" ? "EIO" : "EBUSY" });
            let now = Date.now();
            let transientPending = true;
            const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
            vi.resetModules();
            vi.doMock("fs", async importOriginal => {
                const actual = await importOriginal<typeof import("fs")>();
                return { ...actual, writeFileSync(path: import("fs").PathOrFileDescriptor, value: string | NodeJS.ArrayBufferView, options?: import("fs").WriteFileOptions) {
                    if (failure === "stage-write" && typeof path === "string" && path.startsWith(`${destination}.`) && path.endsWith(".tmp")) {
                        actual.writeFileSync(path, "partial stage bytes", options);
                        throw fault;
                    }
                    actual.writeFileSync(path, value, options);
                }, renameSync(source: string, target: string) {
                    if (target === destination && source.endsWith(".tmp")) {
                        if (failure === "permanent") { now += 3000; throw fault; }
                        if (failure === "nonretryable") throw fault;
                        if (transientPending) { transientPending = false; throw fault; }
                    }
                    actual.renameSync(source, target);
                } };
            });
            try {
                const api = implementation === "host"
                    ? await import("@ccc/device-lab/device-lab-shared-state.js?rename-fault")
                    : await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?rename-fault");
                if (failure === "transient") {
                    api.writeFileAtomically(destination, "published bytes");
                    expect(readFileSync(destination, "utf8")).toBe("published bytes");
                } else {
                    let observed: unknown;
                    try { api.writeFileAtomically(destination, "unpublished bytes"); } catch (error) { observed = error; }
                    expect(observed).toBe(fault);
                    expect(readFileSync(destination, "utf8")).toBe("original bytes");
                }
                expect(readdirSync(dirname(destination))).toEqual(["state.mutation.lock"]);
            } finally {
                vi.doUnmock("fs");
                vi.resetModules();
                clock.mockRestore();
            }
        }
    });

    it("copies exact bounded bytes and preserves the previous destination when the source exceeds the limit", () => {
        const bytes = Buffer.from("é🐋\0binary", "utf8");
        for (const copy of [copyHostFileAtomically, copyNestedFileAtomically]) {
            const destination = lockPath();
            const source = join(dirname(destination), "source.bin");
            writeFileSync(source, bytes);
            writeFileSync(destination, "original bytes");
            expect(copy(source, destination, { prefix: "bounded-copy", limitBytes: bytes.length })).toBe(bytes.length);
            expect(readFileSync(destination)).toEqual(bytes);
            writeFileSync(destination, "preserved after limit refusal");
            expect(() => copy(source, destination, { prefix: "bounded-copy", limitBytes: bytes.length - 1 })).toThrow("bounded-copy-file-too-large");
            expect(readFileSync(destination, "utf8")).toBe("preserved after limit refusal");
            expect(readdirSync(dirname(destination)).sort()).toEqual(["source.bin", "state.mutation.lock"]);
        }
    });

    it.each(["short", "zero", "write-failure", "cleanup-failure"] as const)("preserves streamed-copy publication and owned-stage outcomes after %s writes", async outcome => {
        for (const implementation of ["host", "provider"] as const) {
            const destination = lockPath();
            const source = join(dirname(destination), "source.bin");
            const bytes = Buffer.from("copy bytes");
            writeFileSync(source, bytes);
            writeFileSync(destination, "original bytes");
            const writeFailure = new Error("native output write failed");
            const cleanupFailure = new Error("owned stage removal failed");
            let stage: string | undefined;
            let output: number | undefined;
            let partialWritten = false;
            vi.resetModules();
            vi.doMock("fs", async importOriginal => {
                const actual = await importOriginal<typeof import("fs")>();
                return {
                    ...actual,
                    openSync(path: import("fs").PathLike, flags: string | number, mode?: import("fs").Mode) {
                        const descriptor = actual.openSync(path, flags, mode);
                        if (typeof path === "string" && path.startsWith(`${destination}.`) && path.endsWith(".tmp")) { stage = path; output = descriptor; }
                        return descriptor;
                    },
                    writeSync(descriptor: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) {
                        if (descriptor !== output) return actual.writeSync(descriptor, buffer, offset, length, position);
                        expect(readFileSync(destination, "utf8")).toBe("original bytes");
                        if (outcome === "zero") return 0;
                        if (outcome !== "short" && partialWritten) throw writeFailure;
                        partialWritten = true;
                        return actual.writeSync(descriptor, buffer, offset, Math.min(2, length), position);
                    },
                    rmSync(path: import("fs").PathLike, options?: import("fs").RmOptions) {
                        if (outcome === "cleanup-failure" && path === stage) throw cleanupFailure;
                        actual.rmSync(path, options);
                    },
                };
            });
            try {
                const api = implementation === "host"
                    ? await import("@ccc/device-lab/device-lab-shared-state.js?copy-progress")
                    : await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?copy-progress");
                if (outcome === "short") {
                    expect(api.copyFileAtomically(source, destination, { prefix: "progress-copy", limitBytes: bytes.length })).toBe(bytes.length);
                    expect(readFileSync(destination)).toEqual(bytes);
                } else {
                    let observed: unknown;
                    try { api.copyFileAtomically(source, destination, { prefix: "progress-copy", limitBytes: bytes.length }); } catch (error) { observed = error; }
                    if (outcome === "zero") expect(observed).toMatchObject({ message: "progress-copy-write-failed" });
                    else expect(observed).toBe(outcome === "cleanup-failure" ? cleanupFailure : writeFailure);
                    expect(readFileSync(destination, "utf8")).toBe("original bytes");
                }
                if (!stage) throw new Error("Copy did not allocate its native output stage");
                expect(existsSync(stage)).toBe(outcome === "cleanup-failure");
            } finally {
                vi.doUnmock("fs");
                vi.resetModules();
                if (stage) rmSync(stage, { force: true });
            }
        }
    });

    it.runIf(process.platform !== "win32")("atomically replaces a linked copy destination without modifying its target", () => {
        for (const copy of [copyHostFileAtomically, copyNestedFileAtomically]) {
            const file = lockPath();
            const root = dirname(file);
            const source = join(root, `source-${Math.random()}`);
            const destination = join(root, `destination-${Math.random()}`);
            const target = join(root, `external-${Math.random()}`);
            writeFileSync(source, "trusted-source");
            writeFileSync(target, "external-target");
            symlinkSync(target, destination);

            expect(copy(source, destination, { prefix: "copy-test", limitBytes: 64 })).toBe(14);
            expect(readFileSync(destination, "utf8")).toBe("trusted-source");
            expect(readFileSync(target, "utf8")).toBe("external-target");
            expect(readdirSync(root).some((name) => name.includes(".tmp"))).toBe(false);
        }
    });

    it.runIf(process.platform !== "win32")("rejects linked and multiply-linked copy sources", () => {
        for (const copy of [copyHostFileAtomically, copyNestedFileAtomically]) {
            const file = lockPath();
            const root = dirname(file);
            const source = join(root, `source-${Math.random()}`);
            const linked = join(root, `linked-${Math.random()}`);
            const hardLinked = join(root, `hard-linked-${Math.random()}`);
            const destination = join(root, `destination-${Math.random()}`);
            writeFileSync(source, "trusted-source");
            writeFileSync(destination, "preserved");
            symlinkSync(source, linked);
            expect(() => copy(linked, destination, { prefix: "copy-test", limitBytes: 64 })).toThrow("copy-test-state-invalid");
            expect(readFileSync(destination, "utf8")).toBe("preserved");
            linkSync(source, hardLinked);
            expect(() => copy(source, destination, { prefix: "copy-test", limitBytes: 64 })).toThrow("copy-test-state-invalid");
            expect(readFileSync(destination, "utf8")).toBe("preserved");
        }
    });

    it.runIf(process.platform === "linux")("bounds streamed copies even when the source reports an initial size of zero", () => {
        for (const copy of [copyHostFileAtomically, copyNestedFileAtomically]) {
            const destination = lockPath();
            writeFileSync(destination, "preserved");
            expect(() => copy("/proc/self/status", destination, { prefix: "copy-test", limitBytes: 32 })).toThrow("copy-test-file-too-large");
            expect(readFileSync(destination, "utf8")).toBe("preserved");
        }
    });

    it("returns a stable error code when async lock acquisition times out", async () => {
        const file = lockPath();
        let release!: () => void;
        let entered!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
        const first = withSharedMutationLockAsync(file, async () => {
            entered();
            await gate;
        }, { waitMs: 1000 });
        await firstEntered;

        await expect(withSharedMutationLockAsync(file, () => undefined, { waitMs: 20 })).rejects.toMatchObject({
            code: "shared-mutation-lock-timeout",
        });
        release();
        await first;
        expect(existsSync(file)).toBe(false);
    });

    it("revalidates TS lock ancestors after acquisition before entering the operation", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-ts-lock-acquire-replacement-"));
        roots.push(root);
        const backend = join(root, ".ccc", "devices", "owners", "test-owner", "android");
        const displaced = `${backend}.displaced`;
        const file = join(backend, "devices.mutation.lock");
        mkdirSync(backend, { recursive: true });

        let acquiredFd: number | null = null;
        vi.resetModules();
        vi.doMock("fs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("fs")>();
            return {
                ...actual,
                openSync(path: import("fs").PathLike, flags: import("fs").OpenMode, mode?: import("fs").Mode) {
                    const fd = actual.openSync(path, flags, mode);
                    if (path === file && flags === "wx") acquiredFd = fd;
                    return fd;
                },
                closeSync(fd: number) {
                    actual.closeSync(fd);
                    if (fd === acquiredFd) {
                        acquiredFd = null;
                        actual.renameSync(backend, displaced);
                        actual.mkdirSync(backend);
                    }
                },
            };
        });

        try {
            const racedModule = await import("@ccc/device-lab/device-lab-shared-state.js?ts-lock-acquire-replacement");
            let entered = false;
            expect(() => racedModule.withSharedMutationLock(file, () => {
                entered = true;
            })).toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
            expect(entered).toBe(false);
            expect(readdirSync(backend)).toEqual([]);
            expect(existsSync(join(displaced, "devices.mutation.lock"))).toBe(true);
        } finally {
            vi.doUnmock("fs");
            vi.resetModules();
        }
    });

    it("uses birth time to reject replacements when filesystem IDs are unavailable", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-ts-zero-file-id-"));
        roots.push(root);
        const backend = join(root, ".ccc", "devices", "owners", "test-owner", "android");
        const file = join(backend, "devices.mutation.lock");
        mkdirSync(backend, { recursive: true });
        let replaced = false;

        vi.resetModules();
        vi.doMock("fs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("fs")>();
            return {
                ...actual,
                lstatSync(path: import("fs").PathLike, options?: import("fs").StatOptions) {
                    const stats = actual.lstatSync(path, options as never);
                    const birthtimeMs = replaced ? 200 : 100;
                    return new Proxy(stats, {
                        get(target, property, receiver) {
                            if (property === "dev" || property === "ino") return 0;
                            if (property === "birthtimeMs") return birthtimeMs;
                            const value = Reflect.get(target, property, receiver);
                            return typeof value === "function" ? value.bind(target) : value;
                        },
                    });
                },
            };
        });

        try {
            const module = await import("@ccc/device-lab/device-lab-shared-state.js?zero-file-id-replacement");
            const identities = module.secureStateParentDirectory(file);
            expect(identities.length).toBeGreaterThan(0);
            expect(identities.every((identity) => identity.stats?.dev === 0 && identity.stats?.ino === 0)).toBe(true);
            replaced = true;
            expect(() => module.assertStateDirectoriesUnchanged(identities))
                .toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
        } finally {
            vi.doUnmock("fs");
            vi.resetModules();
        }
    });

    it("does not release a TS lock token through a replaced ancestor namespace", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-ts-lock-release-replacement-"));
        roots.push(root);
        const backend = join(root, ".ccc", "devices", "owners", "test-owner", "android");
        const displaced = `${backend}.displaced`;
        const file = join(backend, "devices.mutation.lock");
        mkdirSync(backend, { recursive: true });
        const successor = { token: testToken(), pid: process.pid, host: hostname() };

        await expect(withHostSharedMutationLockAsync(file, async () => {
            renameSync(backend, displaced);
            mkdirSync(backend);
            writeFileSync(file, JSON.stringify(successor));
        })).rejects.toMatchObject({ code: "device-lab-state-directory-invalid" });

        expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(successor);
        expect(existsSync(join(displaced, "devices.mutation.lock"))).toBe(true);
    });

    it("rejects an owner-writable backend link before lock, stage, or final writes", async () => {
        const operations = [
            ({ backend }: ReturnType<typeof linkedBackendPath>) => writeNestedFileAtomically(join(backend, "devices.json"), "{}"),
            ({ backend, source }: ReturnType<typeof linkedBackendPath>) => copyNestedFileAtomically(source, join(backend, "devices.json"), { prefix: "linked-backend", limitBytes: 64 }),
            ({ backend }: ReturnType<typeof linkedBackendPath>) => withNestedSharedMutationLock(join(backend, "devices.mutation.lock"), () => "unexpected"),
        ];

        for (const operation of operations) {
            const paths = linkedBackendPath();
            expect(() => operation(paths)).toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
            expect(readdirSync(paths.external)).toEqual([]);
        }

        const paths = linkedBackendPath();
        await expect(withSharedMutationLockAsync(join(paths.backend, "devices.mutation.lock"), async () => "unexpected"))
            .rejects.toMatchObject({ code: "device-lab-state-directory-invalid" });
        expect(readdirSync(paths.external)).toEqual([]);
    });

    it("detects a backend directory replacement between staging and rename", async () => {
        const root = mkdtempSync(join(tmpdir(), "ccc-backend-replacement-"));
        const external = mkdtempSync(join(tmpdir(), "ccc-backend-replacement-external-"));
        roots.push(root, external);
        const backend = join(root, ".ccc", "devices", "owners", "test-owner", "android");
        const destination = join(backend, "devices.json");
        mkdirSync(backend, { recursive: true });

        vi.resetModules();
        vi.doMock("fs", async (importOriginal) => {
            const actual = await importOriginal<typeof import("fs")>();
            return {
                ...actual,
                writeFileSync(file: import("fs").PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: import("fs").WriteFileOptions) {
                    actual.writeFileSync(file, data, options);
                    if (typeof file === "string" && file.startsWith(`${destination}.`) && file.endsWith(".tmp")) {
                        actual.rmSync(backend, { recursive: true, force: true });
                        actual.symlinkSync(external, backend, process.platform === "win32" ? "junction" : "dir");
                    }
                },
            };
        });

        try {
            const racedModule = await import("@ccc/device-lab/providers/state/shared-mutation-lock.mjs?backend-replacement-race");
            expect(() => racedModule.writeFileAtomically(destination, "escaped"))
                .toThrow(expect.objectContaining({ code: "device-lab-state-directory-invalid" }));
            expect(readdirSync(external)).toEqual([]);
        } finally {
            vi.doUnmock("fs");
            vi.resetModules();
        }
    });
});
