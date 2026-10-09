import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { existsSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, mkdtempSync, rmSync, renameSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { inspectProcessIdentity } from "@ccc/device-lab/providers/state/process-identity.mjs";
import {
    cleanupFakeIosMcpContext, createFakeIosMcpContext, fakeIosFixtureDiagnostics,
    joinFakeIosFixtureChild, observeFakeIosFixtureAllocation, TIMEOUT, type FakeIosMcpContext, type FakeIosLifetimeEffects,
} from "./helpers/fake-ios-mcp-fixture.js";

const contexts: FakeIosMcpContext[] = [];
const children: ChildProcess[] = [];
const originalMarkers = new Map<FakeIosMcpContext, Map<string, string>>();
const originalJournals = new Map<FakeIosMcpContext, { path: string; bytes: string; backup?: string }>();
async function until(test: () => boolean): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!test()) { if (Date.now() >= deadline) throw new Error("fixture control readiness10s"); await new Promise(resolve => setTimeout(resolve, 20)); }
}
async function context(): Promise<FakeIosMcpContext> {
    const value = await createFakeIosMcpContext({ connect: async () => undefined });
    contexts.push(value); return value;
}
async function port(): Promise<number> {
    const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("owned control address unavailable");
    await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
async function appium(value: FakeIosMcpContext, selectedPort?: number) {
    return observeFakeIosFixtureAllocation(value, async () => {
    const requested = selectedPort ?? await port();
    const child = spawn(join(value.binDir, "appium"), ["server", "--port", String(requested)], {
        env: { ...process.env, HOME: value.homeDir, FAKE_IOS_LOG: value.logPath }, stdio: "ignore",
    });
    children.push(child);
    await until(() => existsSync(join(value.homeDir, `fake-ios-appium-${child.pid}.pid`)));
    const marker = join(value.homeDir, `fake-ios-appium-${child.pid}.pid`);
    const saved = originalMarkers.get(value) ?? new Map<string, string>();
    saved.set(marker, readFileSync(marker, "utf8")); originalMarkers.set(value, saved);
    const journalPath = join(value.homeDir, "fake-ios-allocation.jsonl");
    originalJournals.set(value, { path: journalPath, bytes: readFileSync(journalPath, "utf8") });
    return { child, marker, requested };
    });
}
function controls(overrides: Partial<FakeIosLifetimeEffects> = {}) {
    const attempts = { signal: 0, remove: 0 };
    const effects: FakeIosLifetimeEffects = {
        inspect: (identity, pid) => inspectProcessIdentity(identity, pid),
        signal: () => { attempts.signal++; throw new Error("negative signal attempted"); },
        remove: () => { attempts.remove++; throw new Error("negative removal attempted"); },
        ...overrides,
    };
    return { attempts, effects };
}
afterEach(async () => {
    const deadline = Date.now() + TIMEOUT;
    for (const child of children.splice(0)) await joinFakeIosFixtureChild(child, deadline);
    for (const value of contexts.splice(0)) {
        // Restore only the original authenticated records AFTER independently
        // joining control children. Missing/forged markers never authorize kills.
        const journal = originalJournals.get(value);
        if (journal) {
            if (journal.backup) {
                try { unlinkSync(journal.path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
                renameSync(journal.backup, journal.path); // Restore the original inode, not a replacement oracle.
            }
            writeFileSync(journal.path, journal.bytes);
        }
        originalJournals.delete(value);
        for (const [marker, bytes] of originalMarkers.get(value) ?? []) {
            try { unlinkSync(marker); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            writeFileSync(marker, bytes);
        }
        originalMarkers.delete(value);
        await cleanupFakeIosMcpContext(value, { deadline });
    }
    originalMarkers.clear(); originalJournals.clear();
    vi.restoreAllMocks();
});

describe.skipIf(process.platform === "win32")("fake iOS fixture owned lifetime (POSIX generated shell)", () => {
    it("records listening and joins its actual owned Appium before removal", { timeout: TIMEOUT }, async () => {
        const value = await context(); const running = await appium(value);
        await until(() => fakeIosFixtureDiagnostics(value).includes('"phase":"listening"'));
        const terminal = new Promise(resolve => running.child.once("exit", resolve));
        await cleanupFakeIosMcpContext(value); await terminal;
        expect(existsSync(value.homeDir)).toBe(false); expect(existsSync(value.binDir)).toBe(false);
        contexts.splice(contexts.indexOf(value), 1);
    });
    it("captures failed-listen code from an exactly owned busy listener", { timeout: TIMEOUT }, async () => {
        const value = await context(), listener = createServer();
        await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
        try {
            const address = listener.address(); if (!address || typeof address === "string") throw new Error("owned address unavailable");
            const running = await appium(value, address.port);
            await until(() => running.child.exitCode !== null);
            expect(fakeIosFixtureDiagnostics(value)).toContain("EADDRINUSE");
            expect(fakeIosFixtureDiagnostics(value)).not.toContain("appium-session-body");
        } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
    });
    it.each(["malformed", "symlink", "foreign", "wrong-pid", "stale"])("refuses %s marker without any signal/removal", { timeout: TIMEOUT }, async kind => {
        const value = await context(), running = await appium(value);
        const original = readFileSync(running.marker, "utf8"); const marker = JSON.parse(original);
        if (kind === "malformed") writeFileSync(running.marker, "not-json");
        else if (kind === "symlink") { unlinkSync(running.marker); symlinkSync(value.logPath, running.marker); }
        else writeFileSync(running.marker, JSON.stringify(kind === "foreign" ? { ...marker, token: "foreign" }
            : kind === "wrong-pid" ? { ...marker, pid: process.pid } : { ...marker, identity: { ...marker.identity, startToken: marker.identity.startToken + "-stale" } }));
        const fenced = controls();
        await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow();
        expect(fenced.attempts).toEqual({ signal: 0, remove: 0 }); expect(existsSync(value.homeDir)).toBe(true);
    });
    it.each(["unavailable", "successor"])("fails closed on %s identity immediately before signal", { timeout: TIMEOUT }, async kind => {
        const value = await context(); const running = await appium(value); let changed = false;
        const fenced = controls({ beforeSignal: () => {
            changed = true;
            const marker = JSON.parse(readFileSync(running.marker, "utf8"));
            writeFileSync(running.marker, JSON.stringify({ ...marker, token: "successor-generation" }));
        }, inspect: (identity, pid) =>
            kind === "unavailable" ? { status: "unavailable", liveness: "unknown" }
                : changed ? { status: "mismatch", liveness: "alive" } : inspectProcessIdentity(identity, pid) });
        await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow();
        expect(fenced.attempts).toEqual({ signal: 0, remove: 0 }); expect(existsSync(value.homeDir)).toBe(true);
    });
    it("partial SDK transport startup failure joins its actually allocated Node child", { timeout: TIMEOUT }, async () => {
        let allocated: FakeIosMcpContext | undefined;
        const primary = new Error("primary post-spawn connect failure");
        await expect(createFakeIosMcpContext({ onAllocated: value => { allocated = value; },
            connect: async (_client, transport) => { await transport.start(); throw primary; },
        })).rejects.toBe(primary);
        expect(allocated).toBeDefined(); expect(existsSync(allocated!.homeDir)).toBe(false);
        expect(existsSync(allocated!.binDir)).toBe(false);
    });
    it("rejects redirected ordinary context paths before foreign reads or effects", { timeout: TIMEOUT }, async () => {
        const value = await context(), running = await appium(value);
        const original = { homeDir: value.homeDir, binDir: value.binDir, logPath: value.logPath };
        const foreign = mkdtempSync(join(tmpdir(), "ccc-ios-foreign-control-"));
        writeFileSync(join(foreign, "foreign-evidence"), "preserved");
        try {
            value.homeDir = foreign; value.binDir = foreign; value.logPath = join(foreign, "foreign-evidence");
            const fenced = controls();
            await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow("ownership unavailable");
            expect(fenced.attempts).toEqual({ signal: 0, remove: 0 });
            expect(readFileSync(join(foreign, "foreign-evidence"), "utf8")).toBe("preserved");
            expect(fakeIosFixtureDiagnostics(value)).toContain("context replaced");
            expect(running.child.exitCode).toBeNull();
        } finally { Object.assign(value, original); rmSync(foreign, { recursive: true, force: true }); }
    });
    it("retains live allocation evidence when its PID marker disappears", { timeout: TIMEOUT }, async () => {
        const value = await context(), running = await appium(value);
        await until(() => fakeIosFixtureDiagnostics(value).includes('"phase":"listening"'));
        unlinkSync(running.marker);
        const fenced = controls();
        await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow("missing Appium allocation marker");
        expect(fenced.attempts).toEqual({ signal: 0, remove: 0 });
        expect(existsSync(value.homeDir)).toBe(true); expect(running.child.exitCode).toBeNull();
    });
    it.each(["missing", "symlink", "replaced", "truncated", "partial", "malformed", "foreign", "overcount"])("unknown %s allocation journal never authorizes a live process or removal", { timeout: TIMEOUT }, async kind => {
        const value = await context(), running = await appium(value);
        await until(() => fakeIosFixtureDiagnostics(value).includes('"phase":"listening"'));
        const journal = originalJournals.get(value)!;
        const [header, record] = journal.bytes.trimEnd().split("\n");
        unlinkSync(running.marker); // Independent journal must account for this still-live generation.
        if (["missing", "symlink", "replaced"].includes(kind)) {
            journal.backup = journal.path + ".original-control";
            renameSync(journal.path, journal.backup);
            if (kind === "symlink") symlinkSync(journal.backup, journal.path);
            if (kind === "replaced") writeFileSync(journal.path, journal.bytes);
        } else if (kind === "truncated") {
            await new Promise(resolve => setTimeout(resolve, 20));
            writeFileSync(journal.path, header + "\n"); // Even valid known-empty text cannot erase allocations.
        } else if (kind === "partial") writeFileSync(journal.path, journal.bytes.slice(0, -3));
        else if (kind === "malformed") writeFileSync(journal.path, header + "\n{invalid}\n");
        else if (kind === "foreign") writeFileSync(journal.path, JSON.stringify({ ...JSON.parse(header), token: "foreign" }) + "\n" + record + "\n");
        else writeFileSync(journal.path, header + "\n" + Array.from({ length: 65 }, () => record).join("\n") + "\n");
        const fenced = controls();
        await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow("UNKNOWN allocation coverage");
        expect(fenced.attempts).toEqual({ signal: 0, remove: 0 });
        expect(existsSync(value.homeDir)).toBe(true); expect(running.child.exitCode).toBeNull();
        // afterEach joins this exact ChildProcess first, then restores its original evidence.
    });
    it("synchronous pending-start blocks cleanup during the actual Node identity pause", { timeout: TIMEOUT }, async () => {
        const value = await context(), pause = join(value.homeDir, "fake-ios-startup-pause");
        writeFileSync(pause, "owned pause");
        const starting = appium(value);
        try {
            await until(() => readFileSync(join(value.homeDir, "fake-ios-allocation.jsonl"), "utf8").includes('"kind":"pending"'));
            const fenced = controls();
            await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow("UNKNOWN allocation coverage");
            expect(fenced.attempts).toEqual({ signal: 0, remove: 0 }); expect(existsSync(value.homeDir)).toBe(true);
            expect(children.at(-1)?.exitCode).toBeNull();
        } finally { unlinkSync(pause); await starting; }
    });
    it("trusted history rejects a valid nonempty prefix that loses a second live generation", { timeout: TIMEOUT }, async () => {
        const value = await context();
        const first = await appium(value);
        await until(() => fakeIosFixtureDiagnostics(value).includes('"phase":"listening"'));
        const prefix = readFileSync(join(value.homeDir, "fake-ios-allocation.jsonl"), "utf8");
        const second = await appium(value);
        unlinkSync(second.marker);
        writeFileSync(join(value.homeDir, "fake-ios-allocation.jsonl"), prefix); // Complete valid first generation, same inode.
        const fenced = controls();
        await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow("UNKNOWN allocation coverage");
        expect(fenced.attempts).toEqual({ signal: 0, remove: 0 });
        expect(first.child.exitCode).toBeNull(); expect(second.child.exitCode).toBeNull();
        expect(existsSync(value.homeDir)).toBe(true);
    });
    it("caught throwing signal remains counted and cannot lead to removal", { timeout: TIMEOUT }, async () => {
        const value = await context(), running = await appium(value);
        await until(() => fakeIosFixtureDiagnostics(value).includes('"phase":"listening"'));
        const fenced = controls();
        await expect(cleanupFakeIosMcpContext(value, { effects: fenced.effects })).rejects.toThrow("negative signal attempted");
        expect(fenced.attempts).toEqual({ signal: 1, remove: 0 });
        expect(existsSync(value.homeDir)).toBe(true); expect(existsSync(running.marker)).toBe(true);
        expect(running.child.exitCode).toBeNull();
    });
    it("client-close fault does not skip own server shutdown or mask its cause", { timeout: TIMEOUT }, async () => {
        const value = await context(), running = await appium(value);
        await until(() => fakeIosFixtureDiagnostics(value).includes('"phase":"listening"'));
        vi.spyOn(value.client, "close").mockRejectedValue(new Error("primary close fault"));
        await expect(cleanupFakeIosMcpContext(value)).rejects.toThrow("primary close fault");
        await until(() => running.child.exitCode !== null || running.child.signalCode !== null);
        expect(existsSync(value.homeDir)).toBe(false); contexts.splice(contexts.indexOf(value), 1);
    });

});

// Portable allocation-only failure: no POSIX command or child is started.
it("partial connect failure cleans allocations and preserves the primary error", { timeout: TIMEOUT }, async () => {
        let allocated: FakeIosMcpContext | undefined;
        const primary = new Error("primary connect failure");
        await expect(createFakeIosMcpContext({ onAllocated: value => { allocated = value; }, connect: async () => { throw primary; } })).rejects.toBe(primary);
        expect(allocated).toBeDefined(); expect(existsSync(allocated!.homeDir)).toBe(false); expect(existsSync(allocated!.binDir)).toBe(false);
    });
