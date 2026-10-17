import { describe, expect, it, vi } from "vitest";
import { createSharedMutationLock } from "../../../packages/device-lab/providers/application/shared-mutation-lock.mjs";
import { readLockPublicationTimes } from "../../../packages/device-lab/providers/adapters/lock-publication-times.mjs";
import type { LockProcessIdentity, LockPublicationTimes, LockReadObservation, SharedMutationLockPorts } from "../../../packages/device-lab/providers/ports/shared-mutation-lock.mjs";

const identity: LockProcessIdentity = { pid: 123, startToken: "native-birth", commandHash: "a".repeat(64) };
let fixtureNumber = 0;

function fixture(variant: "typescript" | "provider") {
    let now = 100_000;
    const records = new Map<string, LockReadObservation>();
    const descriptors = new Map<number, string>();
    let descriptor = 0;
    let activeFile = "";
    let archiveNumber = 0;
    let token = 0;
    const observationWaits: { milliseconds: number; signal: AbortSignal; pending: boolean; wake(): void }[] = [];
    const file = `/identity-${++fixtureNumber}.lock`;
    const ports: SharedMutationLockPorts<[]> = {
        variant, key: value => value, ownerContext: () => [], runOwnerContext: (_key, _token, operation) => operation(),
        capture: () => [], check: () => undefined,
        token: () => (++token).toString(16).padStart(32, "0"), pid: () => identity.pid,
        host: () => "test-host", boot: () => "test-boot", platform: () => "win32", timestamp: () => new Date(now).toISOString(),
        now: () => now, monotonic: () => now,
        pauseSync: ms => { now += ms; },
        pause: (milliseconds, signal?: AbortSignal) => {
            if (!signal) { now += milliseconds; return Promise.resolve(undefined); }
            return new Promise<undefined>((resolve, reject) => {
                const settle = (aborted: boolean): void => {
                    if (!wait.pending) return;
                    wait.pending = false;
                    signal.removeEventListener("abort", abort);
                    if (aborted) reject(Object.assign(new Error("observation wait aborted"), { name: "AbortError" }));
                    else resolve(undefined);
                };
                const abort = () => settle(true);
                const wait = { milliseconds, signal, pending: true, wake: () => settle(false) };
                observationWaits.push(wait);
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
            });
        },
        openClaim: path => { if (records.has(path)) throw Object.assign(new Error("occupied"), { code: "EEXIST" }); records.set(path, { kind: "malformed" }); descriptors.set(++descriptor, path); return descriptor; },
        writeClaim: (fd, text) => { activeFile = descriptors.get(fd)!; records.set(activeFile, { kind: "value", value: JSON.parse(text) }); }, closeClaim: () => undefined,
        readRaw: path => records.get(path) ?? { kind: "missing" },
        mtime: () => now - 5000, alive: () => true,
        identitySync: vi.fn(() => identity), identityAsync: vi.fn(async () => identity),
        observe: vi.fn(() => "unavailable" as const), matches: (expected, current) => expected.startToken === current.startToken,
        moveQualified: (path, expected) => { const raw = records.get(path); if (raw?.kind !== "value" || (raw.value as Record<string, unknown>).token !== expected) return false; records.delete(path); return true; },
        moveMalformed: () => false,
        archives: path => [...records.keys()].filter(candidate => candidate.startsWith(`${path}.`)),
        removeArchive: (_file, path, expected) => { const raw = records.get(path); if (!raw) return false; if (expected === null ? raw.kind !== "malformed" : raw.kind !== "value" || (raw.value as Record<string, unknown>).token !== expected) return false; records.delete(path); return true; },
        errorCode: error => (error as { code?: string }).code,
        timeout: () => Object.assign(new Error("timeout"), { code: "shared-mutation-lock-timeout" }),
    };
    function archive(raw: LockReadObservation) { const path = `${file}.${(++archiveNumber).toString(16).padStart(16, "0")}.stale`; records.set(path, raw); return path; }
    function displace() { const raw = records.get(file); if (!raw) throw new Error("no candidate to displace"); records.delete(file); return archive(raw); }
    return { ports, app: createSharedMutationLock(ports), file, records, archive, displace, observationWaits,
        record: () => { const raw = records.get(activeFile || file); return raw?.kind === "value" ? { ...(raw.value as Record<string, unknown>) } : {}; },
        advance: (ms: number) => { now += ms; }, seed: (value: Record<string, unknown>) => { activeFile = file; records.set(file, { kind: "value", value }); } };
}

function elapsedFixture(variant: "typescript" | "provider") {
    const f = fixture(variant);
    let wall = Date.UTC(2026, 9, 17, 12), elapsed = 1000;
    const pauses: number[] = [];
    const observationPause = f.ports.pause;
    const advance = (ms: number) => { elapsed += ms; wall += ms; };
    f.ports.now = () => wall;
    f.ports.monotonic = () => elapsed;
    f.ports.timestamp = () => new Date(wall).toISOString();
    f.ports.mtime = () => wall - 5000;
    f.ports.pauseSync = ms => { pauses.push(ms); advance(ms); };
    f.ports.pause = (ms, signal) => {
        if (signal) return observationPause(ms, signal);
        f.ports.pauseSync(ms);
        return Promise.resolve(undefined);
    };
    return { ...f, advance, pauses, jumpWall: (ms: number) => { wall += ms; } };
}

async function flushIdentityWork() {
    for (let turn = 0; turn < 24; turn++) await Promise.resolve();
}

describe.each(["typescript", "provider"] as const)("%s captured acquisition allowance", variant => {
    for (const mode of ["sync", "async"] as const) {
        async function acquire(f: ReturnType<typeof elapsedFixture>, operation: () => unknown, options: { waitMs: number; staleMs?: number; waitBudget?: { remaining(): number } }) {
            return mode === "sync" ? f.app.withLock(f.file, operation, options) : f.app.withLockAsync(f.file, operation, options);
        }

        it.each([-60_000, 60_000])(`${mode} bounds contention and its final pause when wall time jumps by %s during acquisition`, async jump => {
            const f = elapsedFixture(variant);
            const owner = { token: "f".repeat(32), pid: 456, host: "foreign-host" };
            f.seed(owner);
            const pause = f.ports.pauseSync;
            f.ports.pauseSync = ms => {
                if (f.pauses.length > 20) throw new Error("elapsed acquisition allowance was renewed");
                pause(ms);
                if (f.pauses.length === 1) f.jumpWall(jump);
            };
            const started = f.ports.monotonic();
            const operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 27 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(f.ports.monotonic() - started).toBe(27);
            expect(f.pauses).toEqual([10, 10, 7]);
            expect(operation).not.toHaveBeenCalled();
            expect(f.record()).toEqual(owner);
        });

        it(`${mode} refuses a new claim when the owner releases at the captured deadline`, async () => {
            const f = elapsedFixture(variant);
            f.seed({ token: "f".repeat(32), pid: 456, host: "foreign-host" });
            const started = f.ports.monotonic(), pause = f.ports.pauseSync;
            f.ports.openClaim = vi.fn(f.ports.openClaim);
            f.ports.pauseSync = ms => { pause(ms); if (f.ports.monotonic() - started >= 17) f.records.delete(f.file); };
            const operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 17 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(f.pauses).toEqual([10, 7]);
            expect(f.ports.openClaim).toHaveBeenCalledTimes(2);
            expect(operation).not.toHaveBeenCalled();
            expect(f.records.size).toBe(0);
        });

        it(`${mode} permanently captures a parent shrink before its later growth`, async () => {
            const f = elapsedFixture(variant);
            f.seed({ token: "f".repeat(32), pid: 456, host: "foreign-host" });
            let parent = 100;
            const read = f.ports.readRaw, pause = f.ports.pauseSync;
            f.ports.readRaw = path => { parent = 7; return read(path); };
            f.ports.pauseSync = ms => { pause(ms); parent = 1000; f.records.delete(f.file); };
            const started = f.ports.monotonic(), operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 100, waitBudget: { remaining: () => parent } }))
                .rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(f.ports.monotonic() - started).toBe(7);
            expect(f.pauses).toEqual([7]);
            expect(operation).not.toHaveBeenCalled();
        });

        it.each([0, -10])(`${mode} preserves immediate qualified recovery without polling at waitMs %s`, async waitMs => {
            for (const state of ["empty", "exited", "malformed", "live", "unknown", "foreign"] as const) {
                const f = elapsedFixture(variant);
                const owner = { token: "f".repeat(32), pid: 456, host: state === "foreign" ? "foreign-host" : "test-host" };
                if (state === "malformed") f.records.set(f.file, { kind: "malformed" });
                else if (state === "unknown") f.records.set(f.file, { kind: "unavailable" });
                else if (state !== "empty") f.seed(owner);
                f.ports.alive = pid => state !== "exited" || pid !== owner.pid;
                f.ports.moveMalformed = vi.fn(path => { if (f.records.get(path)?.kind !== "malformed") return false; f.records.delete(path); return true; });
                const operation = vi.fn(() => "immediate");
                if (state === "empty" || state === "exited" || state === "malformed") {
                    expect(await acquire(f, operation, { waitMs, staleMs: 1 })).toBe("immediate");
                    expect(operation).toHaveBeenCalledOnce();
                    expect(f.records.size).toBe(0);
                } else {
                    await expect(acquire(f, operation, { waitMs, staleMs: 1 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                    expect(operation).not.toHaveBeenCalled();
                    expect(f.records.has(f.file)).toBe(true);
                }
                expect(f.pauses, state).toEqual([]);
            }
        });

        it(`${mode} refuses an exhausted explicit parent before acquiring any capabilities`, async () => {
            const f = elapsedFixture(variant);
            f.ports.token = vi.fn(f.ports.token);
            f.ports.capture = vi.fn(f.ports.capture);
            f.ports.openClaim = vi.fn(f.ports.openClaim);
            const operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 100, waitBudget: { remaining: () => 0 } }))
                .rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            for (const effect of [f.ports.token, f.ports.capture, f.ports.openClaim, f.ports.identitySync, f.ports.identityAsync, operation]) expect(effect).not.toHaveBeenCalled();
            expect(f.records.size).toBe(0);
        });

        it.each([-600_000, 600_000])(`${mode} retries unavailable own identity after elapsed sixty seconds despite wall jump %s`, async jump => {
            const f = elapsedFixture(variant);
            vi.mocked(f.ports.identitySync).mockReturnValueOnce(null);
            vi.mocked(f.ports.identityAsync).mockResolvedValueOnce(null);
            expect(await acquire(f, f.record, { waitMs: 0 })).toMatchObject({ processIdentityStatus: "unavailable" });
            f.jumpWall(jump);
            f.advance(59_999);
            expect(await acquire(f, f.record, { waitMs: 0 })).toMatchObject({ processIdentityStatus: "unavailable" });
            expect(mode === "sync" ? f.ports.identitySync : f.ports.identityAsync).toHaveBeenCalledTimes(1);
            f.advance(1);
            expect(await acquire(f, f.record, { waitMs: 0 })).toMatchObject({ processIdentity: identity });
            expect(mode === "sync" ? f.ports.identitySync : f.ports.identityAsync).toHaveBeenCalledTimes(2);
        });

        it.each([-60_000, 60_000])(`${mode} expires owner observations by elapsed time despite wall jump %s`, async jump => {
            for (const initialStatus of ["match", "unavailable"] as const) {
                const f = elapsedFixture(variant);
                f.ports.platform = () => "linux";
                f.app.withLock(f.file, () => undefined, { waitMs: 0 });
                const ownerIdentity = { ...identity, pid: 456, startToken: "owner-generation" };
                const owner = { token: "f".repeat(32), pid: 456, host: "test-host", processIdentity: ownerIdentity };
                f.seed(owner);
                let expired = false;
                vi.mocked(f.ports.observe).mockImplementation(() => expired ? "mismatch" : initialStatus);
                vi.mocked(f.ports.identityAsync).mockImplementation(async pid => initialStatus === "unavailable" && !expired ? null : { ...ownerIdentity, pid, ...(expired ? { startToken: "replacement" } : {}) });
                const operation = vi.fn(() => "recovered");
                await expect(acquire(f, operation, { waitMs: 0 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                f.jumpWall(jump);
                const lifetime = mode === "async" && initialStatus === "unavailable" ? 30_000 : 1000;
                f.advance(lifetime - 1);
                await expect(acquire(f, operation, { waitMs: 0 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                const observe = mode === "sync" ? f.ports.observe : f.ports.identityAsync;
                expect(observe).toHaveBeenCalledTimes(1);
                f.advance(1);
                expired = true;
                expect(await acquire(f, operation, { waitMs: 0 })).toBe("recovered");
                expect(observe).toHaveBeenCalledTimes(2);
                expect(f.records.size).toBe(0);
            }
        });

        it.each(["active", "archived"] as const)(`${mode} keeps malformed ${"%s"} grace on wall time and publishes wall timestamps`, async location => {
            for (const offset of [-70, 60_000]) {
                const f = elapsedFixture(variant);
                const path = location === "active" ? f.file : f.archive({ kind: "malformed" });
                f.records.set(path, { kind: "malformed" });
                const modified = f.ports.now() + offset;
                f.ports.mtime = () => modified;
                f.ports.moveMalformed = target => { if (f.records.get(target)?.kind !== "malformed") return false; f.records.delete(target); return true; };
                f.ports.monotonic = () => 999_999_999;
                await expect(acquire(f, () => "too young", { waitMs: 0, staleMs: 1 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
                expect(f.records.has(path)).toBe(true);
                f.jumpWall(modified + 100 - f.ports.now());
                const timestamp = new Date(f.ports.now()).toISOString();
                expect(await acquire(f, f.record, { waitMs: 0, staleMs: 1 })).toMatchObject({ createdAt: timestamp, processIdentity: identity });
                expect(f.records.size).toBe(0);
            }
        });
    }

    it("charges a cold synchronous identity probe before granting claim authority", () => {
        const f = elapsedFixture(variant);
        vi.mocked(f.ports.identitySync).mockImplementation(() => { f.advance(17); return identity; });
        f.ports.openClaim = vi.fn(f.ports.openClaim);
        const operation = vi.fn();
        expect(() => f.app.withLock(f.file, operation, { waitMs: 17 })).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
        expect(f.ports.openClaim).not.toHaveBeenCalled();
        expect(operation).not.toHaveBeenCalled();
        expect(f.records.size).toBe(0);
    });

    it.each(["cold", "pending"] as const)("bounds %s own async identity by the caller's captured allowance", async warmth => {
        const f = elapsedFixture(variant);
        let finish!: (value: LockProcessIdentity) => void;
        const probe = new Promise<LockProcessIdentity>(resolve => { finish = resolve; });
        vi.mocked(f.ports.identityAsync).mockReturnValue(probe);
        let earlier: Promise<unknown> | undefined;
        if (warmth === "pending") { earlier = f.app.withLockAsync(`${f.file}.earlier`, () => "earlier", { waitMs: 1000 }); await flushIdentityWork(); }
        const operation = vi.fn();
        const bounded = f.app.withLockAsync(f.file, operation, { waitMs: 17 }).then(value => value, error => error);
        try {
            await flushIdentityWork();
            const timer = f.observationWaits.find(wait => wait.pending && wait.milliseconds === 17);
            f.advance(17);
            if (timer) timer.wake();
            else finish(identity);
            const result = await bounded;
            expect(result).toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(timer, "ordinary identity waiting must have a cancellable acquisition deadline").toBeDefined();
            expect(operation).not.toHaveBeenCalled();
            expect(f.records.has(f.file)).toBe(false);
        } finally {
            finish(identity);
            for (const wait of f.observationWaits) if (wait.pending) wait.wake();
            await Promise.all([bounded, earlier]);
        }
        expect(f.ports.identityAsync).toHaveBeenCalledOnce();
        expect(operation).not.toHaveBeenCalled();
        expect(f.records.size).toBe(0);
        expect(f.observationWaits.every(wait => !wait.pending && wait.signal.aborted)).toBe(true);
    });

    it.each(["active", "archived"] as const)("rejects a late synchronous %s mismatch without granting stale authority", location => {
        const f = elapsedFixture(variant);
        f.ports.platform = () => "linux";
        f.app.withLock(f.file, () => undefined);
        const owner = { token: "f".repeat(32), pid: 456, host: "test-host", processIdentity: { ...identity, pid: 456 } };
        const path = location === "active" ? f.file : f.archive({ kind: "value", value: owner });
        f.records.set(path, { kind: "value", value: owner });
        vi.mocked(f.ports.observe).mockImplementation(() => { f.advance(17); return "mismatch"; });
        f.ports.moveQualified = vi.fn(f.ports.moveQualified);
        f.ports.removeArchive = vi.fn(f.ports.removeArchive);
        const operation = vi.fn();
        expect(() => f.app.withLock(f.file, operation, { waitMs: 17 })).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
        expect(operation).not.toHaveBeenCalled();
        expect(f.records.get(path)).toEqual({ kind: "value", value: owner });
        expect(f.ports.removeArchive).not.toHaveBeenCalled();
        expect(vi.mocked(f.ports.moveQualified).mock.calls.every(([, , suffix]) => suffix === "release")).toBe(true);
        if (location === "archived") expect(f.records.has(f.file)).toBe(false);
    });

    it.each(["active", "archived"] as const)("settles a late ordinary async %s observation without reclaiming it", async location => {
        const f = elapsedFixture(variant);
        f.app.withLock(f.file, () => undefined);
        const ownerIdentity = { ...identity, pid: 456, startToken: "original" };
        const owner = { token: "f".repeat(32), pid: 456, host: "test-host", processIdentity: ownerIdentity };
        const path = location === "active" ? f.file : f.archive({ kind: "value", value: owner });
        f.records.set(path, { kind: "value", value: owner });
        let finish!: (value: LockProcessIdentity) => void;
        const probe = new Promise<LockProcessIdentity>(resolve => { finish = resolve; });
        vi.mocked(f.ports.identityAsync).mockReturnValue(probe);
        f.ports.removeArchive = vi.fn(f.ports.removeArchive);
        f.ports.moveQualified = vi.fn(f.ports.moveQualified);
        const operation = vi.fn();
        const bounded = f.app.withLockAsync(f.file, operation, { waitMs: 17 }).then(value => value, error => error);
        try {
            await flushIdentityWork();
            const timer = f.observationWaits.find(wait => wait.pending && wait.milliseconds === 17);
            f.advance(17);
            if (timer) timer.wake();
            else finish({ ...ownerIdentity, startToken: "replacement" });
            expect(await bounded).toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(timer).toBeDefined();
        } finally {
            finish({ ...ownerIdentity, startToken: "replacement" });
            for (const wait of f.observationWaits) if (wait.pending) wait.wake();
            await bounded;
            await flushIdentityWork();
        }
        expect(operation).not.toHaveBeenCalled();
        expect(f.records.get(path)).toEqual({ kind: "value", value: owner });
        expect(f.ports.removeArchive).not.toHaveBeenCalled();
        expect(vi.mocked(f.ports.moveQualified).mock.calls.every(([, , suffix]) => suffix === "release")).toBe(true);
        if (location === "archived") expect(f.records.has(f.file)).toBe(false);
        expect(f.observationWaits.every(wait => !wait.pending && wait.signal.aborted)).toBe(true);
    });

    it("does not queue or later dispatch an ordinary timed owner probe behind four occupied slots", async () => {
        const f = elapsedFixture(variant);
        f.app.withLock(f.file, () => undefined);
        let finish!: () => void;
        const gate = new Promise<void>(resolve => { finish = resolve; });
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => { await gate; return { ...identity, pid }; });
        const callers: Promise<unknown>[] = [];
        const operation = vi.fn();
        const files: string[] = [];
        try {
            for (let index = 0; index < 5; index++) {
                const path = `${f.file}.owner-${index}`;
                files.push(path);
                const pid = 456 + index;
                f.records.set(path, { kind: "value", value: { token: "f".repeat(32), pid, host: "test-host", processIdentity: { ...identity, pid } } });
                callers.push(f.app.withLockAsync(path, operation, { waitMs: 17 }).then(value => value, error => error));
                await flushIdentityWork();
            }
            expect(f.ports.identityAsync).toHaveBeenCalledTimes(4);
            f.advance(17);
            for (const wait of f.observationWaits) if (wait.pending) wait.wake();
            const bounded = await Promise.race([callers[4], new Promise(resolve => setTimeout(() => resolve("still queued after expiry"), 30))]);
            expect(bounded).toMatchObject({ code: "shared-mutation-lock-timeout" });
        } finally {
            finish();
            for (const wait of f.observationWaits) if (wait.pending) wait.wake();
            await Promise.all(callers);
            await flushIdentityWork();
        }
        expect(f.ports.identityAsync).toHaveBeenCalledTimes(4);
        expect(operation).not.toHaveBeenCalled();
        for (const path of files) expect(f.records.get(path)).toMatchObject({ kind: "value", value: { token: "f".repeat(32) } });
        expect(f.observationWaits.every(wait => !wait.pending && wait.signal.aborted)).toBe(true);
    });

    it.each([false, true])("releases exact overdue ownership and preserves successors after an operation failure: %s", async fails => {
        for (const mode of ["sync", "async"] as const) {
            const f = elapsedFixture(variant);
            const primary = new Error("operation-primary");
            const successor = { token: "e".repeat(32), pid: 456, host: "foreign-host" };
            let owned = "", foreign = "";
            const operation = () => {
                f.advance(1000);
                owned = f.displace();
                f.seed(successor);
                foreign = f.archive({ kind: "value", value: successor });
                if (fails) throw primary;
                return "completed";
            };
            const result = mode === "sync"
                ? Promise.resolve().then(() => f.app.withLock(f.file, operation, { waitMs: 17 }))
                : f.app.withLockAsync(f.file, operation, { waitMs: 17 });
            if (fails) await expect(result).rejects.toBe(primary);
            else expect(await result).toBe("completed");
            expect(f.records.has(owned)).toBe(false);
            expect(f.records.get(f.file)).toEqual({ kind: "value", value: successor });
            expect(f.records.get(foreign)).toEqual({ kind: "value", value: successor });
        }
    });
});

describe.each(["typescript", "provider"] as const)("%s Windows own guard identity", variant => {
    it.each([
        ["later process", "windows:2026-10-12T14:52:34.0000000Z"],
        ["original process", "windows:2026-10-12T14:50:00.0000000Z"],
        ["process born at publication", "windows:2026-10-12T14:51:20.492Z"],
        ["process born 999ms after publication", "windows:2026-10-12T14:51:21.491Z"],
        ["process born 1000ms after publication", "windows:2026-10-12T14:51:21.492Z"],
        ["process born 1001ms after publication", "windows:2026-10-12T14:51:21.493Z"],
        ["ambiguous start", "windows:unavailable"],
        ["start without timezone", "windows:2026-10-12T14:52:34"],
    ])("retains an identity-unavailable live claim despite a %s observation", async (_label, startToken) => {
        const f = fixture(variant);
        const legacy = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "2026-10-12T14:51:20.492Z", processIdentityStatus: "unavailable" };
        f.seed(legacy);
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === 456 ? { ...identity, pid, startToken } : identity);
        const operation = vi.fn(() => "recovered");
        await expect(f.app.withLockAsync(f.file, operation, { waitMs: 30 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(legacy);
        expect(vi.mocked(f.ports.identityAsync).mock.calls.every(([pid]) => pid === identity.pid)).toBe(true);
    });
    it.each(["opaque-publication-time", undefined, ""])("retains a live identity-less claim with publication %s without probing it", async createdAt => {
        const f = fixture(variant);
        const current = { ...identity, pid: 456, startToken: "opaque-native-process-generation" };
        const legacy = { token: "f".repeat(32), pid: current.pid, host: "test-host", ...(createdAt === undefined ? {} : { createdAt }), processIdentityStatus: "unavailable" };
        f.seed(legacy);
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === current.pid ? current : identity);
        const operation = vi.fn(() => "recovered");
        await expect(f.app.withLockAsync(f.file, operation, { waitMs: 30 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(legacy);
        expect(vi.mocked(f.ports.identityAsync).mock.calls.every(([pid]) => pid === identity.pid)).toBe(true);
        expect(f.ports.observe).not.toHaveBeenCalled();
    });

    it("protects an identity-unavailable live owner when its current identity cannot be read", async () => {
        const f = fixture(variant);
        const legacy = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "2026-10-12T14:51:20.492Z", processIdentityStatus: "unavailable" };
        f.seed(legacy);
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === legacy.pid ? null : identity);
        const operation = vi.fn();
        await expect(f.app.withLockAsync(f.file, operation, { waitMs: 30 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(legacy);
        expect(vi.mocked(f.ports.identityAsync).mock.calls.every(([pid]) => pid === identity.pid)).toBe(true);
    });

    it("protects the original owner using its recorded identity", async () => {
        const f = fixture(variant);
        const original = { ...identity, pid: 456, startToken: "opaque-original-generation" };
        const claim = { token: "f".repeat(32), pid: original.pid, host: "test-host", createdAt: "opaque-publication-time", processIdentityStatus: "recorded", processIdentity: original };
        f.seed(claim);
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === original.pid ? original : identity);
        const operation = vi.fn();
        await expect(f.app.withLockAsync(f.file, operation, { waitMs: 30 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(claim);
    });

    it("keeps synchronous acquisition from probing a live Windows legacy owner", () => {
        const f = fixture(variant);
        const legacy = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "2026-10-12T14:51:20.492Z", processIdentityStatus: "unavailable" };
        f.seed(legacy);
        const operation = vi.fn();
        expect(() => f.app.withLock(f.file, operation, { waitMs: 30 })).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(legacy);
        expect(f.ports.identityAsync).not.toHaveBeenCalled();
    });

    it.each([
        ["sync", "cold"], ["async", "cold"], ["sync", "warm"], ["async", "warm"],
    ] as const)("bounds contended %s acquisition with a %s budget while retaining a live identity-less Windows owner", async (mode, warmth) => {
        const f = fixture(variant);
        if (warmth === "warm") await f.app.withLockAsync(f.file, f.record);
        vi.mocked(f.ports.identitySync).mockClear();
        vi.mocked(f.ports.identityAsync).mockClear();
        const legacy = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "2026-10-12T14:51:20.492Z", processIdentityStatus: "unavailable" };
        const current = { ...identity, pid: legacy.pid, startToken: "windows:2026-10-12T14:52:34.0000000Z" };
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === legacy.pid ? current : identity);
        f.seed(legacy);
        f.ports.openClaim = vi.fn(f.ports.openClaim);
        f.ports.moveQualified = vi.fn(f.ports.moveQualified);
        f.ports.moveMalformed = vi.fn(f.ports.moveMalformed);
        f.ports.removeArchive = vi.fn(f.ports.removeArchive);
        const deadline = f.ports.now() + 30;
        const options = { waitMs: 30, waitBudget: { remaining: () => deadline - f.ports.now() } };
        const operation = vi.fn(() => "unexpected admission");
        if (mode === "sync") {
            expect(() => f.app.withLock(f.file, operation, options)).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
            expect(f.ports.identityAsync).not.toHaveBeenCalled();
        } else {
            await expect(f.app.withLockAsync(f.file, operation, options)).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        }
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(legacy);
        expect(f.ports.now()).toBe(deadline);
        expect(f.ports.moveQualified).not.toHaveBeenCalled();
        expect(f.ports.moveMalformed).not.toHaveBeenCalled();
        expect(f.ports.removeArchive).not.toHaveBeenCalled();
        expect(f.ports.openClaim).toHaveBeenCalled();
        expect(f.ports.identitySync).not.toHaveBeenCalled();
        expect(f.ports.observe).not.toHaveBeenCalled();
    });

    it.each([
        ["active", "sync", false], ["active", "async", false],
        ["archived", "sync", false], ["archived", "async", false],
        ["active", "sync", true], ["active", "async", true],
        ["archived", "sync", true], ["archived", "async", true],
    ] as const)("retains a cold %s Windows owner after wall rollback against a %s contender (budgeted: %s)", async (location, mode, budgeted) => {
        const f = fixture(variant);
        const initialWall = Date.UTC(2026, 9, 16, 12);
        const processStartedAtMs = initialWall - 1000;
        const ownerIdentity = { ...identity, startToken: `windows:${new Date(processStartedAtMs).toISOString()}` };
        let wallNow = initialWall, monotonicNow = 17.25, ownerPath = f.file, publications = 0;
        let releaseOwner!: () => void, ownerEntered!: () => void;
        const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
        const ownerReady = new Promise<void>(resolve => { ownerEntered = resolve; });
        const pause = f.ports.pause;
        f.ports.now = () => wallNow;
        f.ports.monotonic = () => monotonicNow;
        f.ports.timestamp = () => {
            if (publications++ === 0) wallNow -= 60_000;
            return new Date(wallNow).toISOString();
        };
        f.ports.mtime = () => wallNow - 5000;
        f.ports.alive = () => true;
        f.ports.pause = (milliseconds, signal) => {
            if (signal) return pause(milliseconds, signal);
            monotonicNow += milliseconds;
            wallNow += milliseconds;
            return Promise.resolve(undefined);
        };
        f.ports.pauseSync = milliseconds => { monotonicNow += milliseconds; wallNow += milliseconds; };
        vi.mocked(f.ports.identityAsync).mockResolvedValue(null);
        const owner = f.app.withLockAsync(f.file, async () => {
            if (location === "archived") ownerPath = f.displace();
            ownerEntered();
            await ownerGate;
            return "owner";
        }, { waitMs: 1000 });
        await ownerReady;
        try {
            const published = f.app.readLock(ownerPath)!;
            expect(published).toMatchObject({ pid: ownerIdentity.pid, processIdentityStatus: "unavailable" });
            expect(published).not.toHaveProperty("processIdentity");
            expect(readLockPublicationTimes(ownerIdentity, published.createdAt)).toEqual({
                kind: "known", processStartedAtMs, claimCreatedAtMs: initialWall - 60_000,
            });
            vi.mocked(f.ports.identityAsync).mockClear().mockImplementation(async pid => pid === ownerIdentity.pid ? ownerIdentity : { ...identity, pid });
            vi.mocked(f.ports.identitySync).mockClear().mockImplementation(pid => ({ ...identity, pid }));
            const contenderToken = "e".repeat(32);
            f.ports.moveQualified = vi.fn(f.ports.moveQualified);
            f.ports.moveMalformed = vi.fn(f.ports.moveMalformed);
            f.ports.removeArchive = vi.fn(f.ports.removeArchive);
            // A separate runtime has its own local ownership keys, but observes the same native claim.
            const contender = createSharedMutationLock({ ...f.ports, key: path => `contender:${path}`, pid: () => 456, token: () => contenderToken });
            const operation = vi.fn(() => "unexpected admission");
            const deadline = monotonicNow + 30;
            const options = { waitMs: 30, ...(budgeted ? { waitBudget: { remaining: () => deadline - monotonicNow } } : {}) };
            if (mode === "sync") expect(() => contender.withLock(f.file, operation, options)).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
            else await expect(contender.withLockAsync(f.file, operation, options)).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });

            expect(monotonicNow).toBe(deadline);
            expect(wallNow).toBe(initialWall - 60_000 + 30);
            expect(operation).not.toHaveBeenCalled();
            expect(f.records.get(ownerPath)).toEqual({ kind: "value", value: published });
            expect(f.ports.moveMalformed).not.toHaveBeenCalled();
            expect(f.ports.removeArchive).not.toHaveBeenCalled();
            if (location === "archived") {
                expect(f.ports.moveQualified).toHaveBeenCalledExactlyOnceWith(f.file, contenderToken, "release", []);
                expect(f.records.has(f.file)).toBe(false);
            } else expect(f.ports.moveQualified).not.toHaveBeenCalled();
            expect(vi.mocked(f.ports.identityAsync).mock.calls.every(([pid]) => pid === 456)).toBe(true);
            expect(vi.mocked(f.ports.identitySync).mock.calls.every(([pid]) => pid === 456)).toBe(true);
            expect(f.ports.observe).not.toHaveBeenCalled();
        } finally {
            releaseOwner();
            await owner;
        }
        expect(f.records.size).toBe(0);
    });

    it.each(["success", "failure", "timeout"] as const)("cancels the concurrent owner-observation wait after %s without late reclamation", async outcome => {
        const f = fixture(variant);
        const savedIdentity = { ...identity, pid: 456, startToken: "original-generation" };
        const owner = { token: "f".repeat(32), pid: savedIdentity.pid, host: "test-host", processIdentity: savedIdentity };
        f.seed(owner);
        let finishProbe!: (value: LockProcessIdentity) => void;
        let failProbe!: (error: Error) => void;
        let probeStarted!: () => void;
        const started = new Promise<void>(resolve => { probeStarted = resolve; });
        const probe = new Promise<LockProcessIdentity>((resolve, reject) => { finishProbe = resolve; failProbe = reject; });
        const replacement = { ...savedIdentity, startToken: "replacement-generation" };
        const probeFailure = new Error("owner-identity-observation-failed");
        vi.mocked(f.ports.identityAsync).mockImplementation(async () => { probeStarted(); return probe; });
        const startedAt = f.ports.now();
        const deadline = startedAt + 47;
        const operation = vi.fn(() => "recovered");
        const pending = f.app.withLockAsync(f.file, operation, {
            waitMs: 1000, waitBudget: { remaining: () => deadline - f.ports.now() },
        }).then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
        try {
            await started;
            expect(f.ports.now()).toBe(startedAt);
            expect(f.observationWaits).toHaveLength(1);
            const firstWait = f.observationWaits[0]!;
            expect(firstWait).toMatchObject({ milliseconds: 47, pending: true });
            if (outcome === "success") finishProbe(replacement);
            else if (outcome === "failure") failProbe(probeFailure);
            else {
                f.advance(20);
                firstWait.wake();
                await Promise.resolve();
                expect(f.observationWaits).toHaveLength(2);
                const remainingWait = f.observationWaits[1]!;
                expect(remainingWait).toMatchObject({ milliseconds: 27, pending: true });
                expect(operation).not.toHaveBeenCalled();
                expect(f.record()).toEqual(owner);
                f.advance(27);
                remainingWait.wake();
            }
            const result = await pending;
            expect(f.observationWaits.every(wait => !wait.pending && wait.signal.aborted)).toBe(true);
            if (outcome === "success") {
                expect(result).toEqual({ ok: true, value: "recovered" });
                expect(operation).toHaveBeenCalledOnce();
                expect(f.records.size).toBe(0);
            } else {
                expect(result.ok).toBe(false);
                if (!result.ok) {
                    if (outcome === "failure") expect(result.error).toBe(probeFailure);
                    else expect(result.error).toMatchObject({ code: "shared-mutation-lock-timeout" });
                }
                expect(operation).not.toHaveBeenCalled();
                expect(f.record()).toEqual(owner);
                if (outcome === "timeout") {
                    expect(f.ports.now()).toBe(deadline);
                    finishProbe(replacement);
                    await probe;
                    await new Promise(resolve => setTimeout(resolve, 0));
                    expect(operation).not.toHaveBeenCalled();
                    expect(f.record()).toEqual(owner);
                    expect(f.observationWaits.every(wait => !wait.pending && wait.signal.aborted)).toBe(true);
                }
            }
            expect(f.ports.identityAsync).toHaveBeenCalledExactlyOnceWith(owner.pid);
            expect(f.ports.identitySync).not.toHaveBeenCalled();
            expect(f.ports.observe).not.toHaveBeenCalled();
        } finally {
            f.advance(Math.max(0, deadline - f.ports.now()));
            finishProbe(replacement);
            for (const wait of f.observationWaits) if (wait.pending) wait.wake();
            await pending;
        }
    });

    it("finishes a slow cold identity probe before exposing an empty claimed guard", () => {
        const f = fixture(variant);
        const events: string[] = [];
        const open = f.ports.openClaim;
        let claimed = false;
        f.ports.openClaim = file => {
            events.push("claim");
            claimed = true;
            return open(file);
        };
        vi.mocked(f.ports.identitySync).mockImplementation(() => {
            events.push("probe-start");
            expect(claimed, "a slow native probe must not leave an empty claim visible to competing acquisitions").toBe(false);
            expect(f.ports.readRaw(f.file)).toEqual({ kind: "missing" });
            f.advance(1500);
            expect(claimed).toBe(false);
            events.push("probe-complete");
            return identity;
        });
        const receipt = f.app.withLock(f.file, () => {
            events.push("operation");
            return f.record();
        }, { waitMs: 10_000 });
        expect(events).toEqual(["probe-start", "probe-complete", "claim", "operation"]);
        expect(receipt).toMatchObject({ processIdentityStatus: "recorded", processIdentity: identity });
        expect(f.ports.readRaw(f.file)).toEqual({ kind: "missing" });
    });

    it("records cold synchronous native identity and reuses it", () => {
        const f = fixture(variant);
        expect(f.app.withLock(f.file, f.record)).toMatchObject({ processIdentityStatus: "recorded", processIdentity: identity });
        expect(f.app.withLock(f.file, f.record)).toMatchObject({ processIdentity: identity });
        expect(f.ports.identitySync).toHaveBeenCalledExactlyOnceWith(identity.pid);
        expect(f.ports.identityAsync).not.toHaveBeenCalled();
    });

    it("publishes unavailable identity and throttles retries for sixty seconds", () => {
        const f = fixture(variant);
        vi.mocked(f.ports.identitySync).mockReturnValueOnce(null);
        const unavailable = f.app.withLock(f.file, f.record);
        expect(unavailable.processIdentityStatus).toBe("unavailable");
        expect(unavailable).not.toHaveProperty("processIdentity");
        f.advance(59_999);
        expect(f.app.withLock(f.file, f.record)).toMatchObject({ processIdentityStatus: "unavailable" });
        expect(f.ports.identitySync).toHaveBeenCalledTimes(1);
        f.advance(1);
        expect(f.app.withLock(f.file, f.record)).toMatchObject({ processIdentityStatus: "recorded", processIdentity: identity });
        expect(f.ports.identitySync).toHaveBeenCalledTimes(2);
    });

    it("shares unavailable retry throttling between async and sync claims", async () => {
        const f = fixture(variant);
        vi.mocked(f.ports.identityAsync).mockResolvedValueOnce(null);
        expect(await f.app.withLockAsync(f.file, f.record)).toMatchObject({ processIdentityStatus: "unavailable" });
        f.advance(59_999);
        expect(f.app.withLock(f.file, f.record)).toMatchObject({ processIdentityStatus: "unavailable" });
        expect(await f.app.withLockAsync(f.file, f.record)).toMatchObject({ processIdentityStatus: "unavailable" });
        expect(f.ports.identitySync).not.toHaveBeenCalled();
        expect(f.ports.identityAsync).toHaveBeenCalledTimes(1);
        f.advance(1);
        expect(await f.app.withLockAsync(f.file, f.record)).toMatchObject({ processIdentity: identity });
        expect(f.ports.identityAsync).toHaveBeenCalledTimes(2);
    });

    it("avoids native probes for cold explicit-budget sync and async claims", async () => {
        const f = fixture(variant);
        const options = { waitBudget: { remaining: () => 100 } };
        for (const record of [f.app.withLock(f.file, f.record, options), await f.app.withLockAsync(f.file, f.record, options)]) {
            expect(record).toMatchObject({ processIdentityStatus: "unavailable" });
            expect(record).not.toHaveProperty("processIdentity");
        }
        expect(f.ports.identitySync).not.toHaveBeenCalled();
        expect(f.ports.identityAsync).not.toHaveBeenCalled();
        expect(f.app.withLock(f.file, f.record)).toMatchObject({ processIdentity: identity });
        expect(f.ports.identitySync).toHaveBeenCalledTimes(1);
    });

    it("reuses warm identity for explicit-budget sync and async claims", async () => {
        const f = fixture(variant);
        await f.app.withLockAsync(f.file, f.record);
        const options = { waitBudget: { remaining: () => 100 } };
        expect(f.app.withLock(f.file, f.record, options)).toMatchObject({ processIdentity: identity });
        expect(await f.app.withLockAsync(f.file, f.record, options)).toMatchObject({ processIdentity: identity });
        expect(f.ports.identityAsync).toHaveBeenCalledExactlyOnceWith(identity.pid);
        expect(f.ports.identitySync).not.toHaveBeenCalled();
    });

    it("retains a positive synchronous identity when an earlier async probe becomes unavailable", async () => {
        const f = fixture(variant);
        let resolveProbe!: (value: LockProcessIdentity | null) => void;
        let probeStarted!: () => void;
        const started = new Promise<void>(resolve => { probeStarted = resolve; });
        vi.mocked(f.ports.identityAsync).mockImplementation(() => {
            probeStarted();
            return new Promise(resolve => { resolveProbe = resolve; });
        });
        const pendingClaim = f.app.withLockAsync(`${f.file}.pending`, f.record);
        await started;
        expect(f.app.withLock(f.file, f.record)).toMatchObject({ processIdentityStatus: "recorded", processIdentity: identity });
        resolveProbe(null);
        expect(await pendingClaim).toMatchObject({ processIdentityStatus: "recorded", processIdentity: identity });
        const options = { waitBudget: { remaining: () => 100 } };
        expect(f.app.withLock(f.file, f.record, options)).toMatchObject({ processIdentity: identity });
        expect(await f.app.withLockAsync(f.file, f.record, options)).toMatchObject({ processIdentity: identity });
        expect(f.ports.identitySync).toHaveBeenCalledTimes(1);
        expect(f.ports.identityAsync).toHaveBeenCalledTimes(1);
    });
});

describe.each(["typescript", "provider"] as const)("%s valid claim ownership before age grace", variant => {
    it.each([
        ["exited", "sync", "young"],
        ["authoritative-reboot", "sync", "future"],
        ["recorded-mismatch", "async", "future"],
    ] as const)("recovers an active %s owner through %s acquisition with a %s mtime", async (proof, mode, age) => {
        const f = fixture(variant);
        f.ports.platform = () => "linux";
        const owner = { token: "f".repeat(32), pid: 456, host: "test-host",
            bootId: proof === "authoritative-reboot" ? "11111111-1111-1111-1111-111111111111" : "test-boot",
            processIdentity: { ...identity, pid: 456, startToken: "old-generation" } };
        f.seed(owner);
        const started = f.ports.now();
        f.ports.mtime = () => age === "young" ? started - 50 : started + 60_000;
        if (proof === "exited") f.ports.alive = pid => pid !== owner.pid;
        if (proof === "authoritative-reboot") f.ports.boot = () => "22222222-2222-2222-2222-222222222222";
        if (proof === "recorded-mismatch") vi.mocked(f.ports.identityAsync).mockImplementation(async pid => ({ ...identity, pid }));
        f.ports.moveQualified = vi.fn(f.ports.moveQualified);
        const operation = vi.fn(() => "recovered");
        const options = { waitMs: 1, staleMs: 60_000 };
        expect(mode === "sync" ? f.app.withLock(f.file, operation, options) : await f.app.withLockAsync(f.file, operation, options)).toBe("recovered");
        expect(operation).toHaveBeenCalledOnce();
        expect(f.ports.now()).toBe(started);
        expect(f.ports.moveQualified).toHaveBeenCalledWith(f.file, owner.token, "stale", []);
        expect(f.records.size).toBe(0);
    });
});

describe.each(["typescript", "provider"] as const)("%s archived claim admission", variant => {
    it.each(["value", "missing", "malformed", "invalid-record", "unavailable", "native-fault"] as const)("keeps %s archive observation distinct from malformed recovery permission", state => {
        const f = fixture(variant);
        const admitted = { token: "f".repeat(32), pid: 456, host: "test-host" };
        const raw: LockReadObservation = state === "value" ? { kind: "value", value: admitted }
            : state === "invalid-record" ? { kind: "value", value: { ...admitted, pid: "not-a-pid" } }
            : state === "native-fault" ? { kind: "unavailable" } : { kind: state };
        const archived = f.archive(raw);
        if (state === "native-fault") f.ports.readRaw = () => { throw Object.assign(new Error("native archive read failed"), { code: "EIO" }); };
        expect(f.app.readObservation(archived)).toEqual(state === "invalid-record" ? { kind: "malformed" } : state === "native-fault" ? { kind: "unavailable" } : raw);
        expect(f.app.readLock(archived)).toEqual(state === "value" ? admitted : null);
    });

    it("retains every active local token while an owner is archived and an independent candidate waits", async () => {
        const f = fixture(variant);
        let releaseOwner!: () => void, releasePause!: () => void, ownerEntered!: () => void, candidatePaused!: () => void;
        const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
        const ownerReady = new Promise<void>(resolve => { ownerEntered = resolve; });
        const pauseGate = new Promise<void>(resolve => { releasePause = resolve; });
        const paused = new Promise<void>(resolve => { candidatePaused = resolve; });
        const observationPause = f.ports.pause;
        f.ports.pause = async (ms, signal) => {
            if (signal) return observationPause(ms, signal);
            f.advance(ms); candidatePaused(); await pauseGate; return undefined;
        };
        const owner = f.app.withLockAsync(f.file, async () => { f.displace(); ownerEntered(); await ownerGate; return "owner"; });
        await ownerReady;
        const contender = f.app.withLockAsync(f.file, () => "candidate", { waitMs: 100 });
        await paused;
        try {
            expect(() => f.app.withLock(f.file, () => "unexpected")).toThrow(expect.objectContaining({ code: "shared-mutation-lock-self-contention" }));
            releaseOwner();
            expect(await owner).toBe("owner");
            expect(() => f.app.withLock(f.file, () => "unexpected")).toThrow(expect.objectContaining({ code: "shared-mutation-lock-self-contention" }));
        } finally { releaseOwner(); releasePause(); }
        expect(await contender).toBe("candidate");
        expect(f.records.size).toBe(0);
        expect(f.app.withLock(f.file, () => "released")).toBe("released");
    });

    it.each([
        ["original archived process", "windows:1970-01-01T00:00:50.000Z"],
        ["process born exactly 1000ms after publication", "windows:1970-01-01T00:00:51.000Z"],
        ["process born 1001ms after publication", "windows:1970-01-01T00:00:51.001Z"],
        ["unknown process birth", "opaque-native-birth"],
    ] as const)("retains a live Windows legacy archive despite a %s observation", async (_label, startToken) => {
        const f = fixture(variant);
        const owner = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "1970-01-01T00:00:50.000Z", processIdentityStatus: "unavailable" };
        const archived = f.archive({ kind: "value", value: owner });
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => ({ ...identity, pid, startToken }));
        const operation = vi.fn(() => "recovered");
        await expect(f.app.withLockAsync(f.file, operation, { waitMs: 30, staleMs: 1 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        expect(operation).not.toHaveBeenCalled();
        expect(f.records.get(archived)).toEqual({ kind: "value", value: owner });
        expect(f.records.has(f.file)).toBe(false);
        expect(vi.mocked(f.ports.identityAsync).mock.calls.every(([pid]) => pid === identity.pid)).toBe(true);
    });

    for (const mode of ["sync", "async"] as const) {
        async function acquire(f: ReturnType<typeof fixture>, operation: () => unknown, options: { waitMs?: number; staleMs?: number; waitBudget?: { remaining(): number } } = {}) {
            if (mode === "sync") return f.app.withLock(f.file, operation, options);
            return f.app.withLockAsync(f.file, operation, options);
        }

        it.each(["live", "foreign", "unavailable-read", "read-fault", "unavailable-identity"] as const)(`${mode} retains a %s archive through the complete caller budget`, async state => {
            const f = fixture(variant);
            const owner = { token: "f".repeat(32), pid: 456, host: state === "foreign" ? "foreign-host" : "test-host",
                processIdentity: { ...identity, pid: 456 }, processIdentityStatus: "recorded" };
            const archived = f.archive(state === "unavailable-read" || state === "read-fault" ? { kind: "unavailable" } : { kind: "value", value: owner });
            const read = f.ports.readRaw;
            if (state === "read-fault") f.ports.readRaw = path => { if (path === archived) throw Object.assign(new Error("native read denied"), { code: "EACCES" }); return read(path); };
            if (state === "foreign") f.ports.alive = () => false;
            vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === owner.pid && state === "unavailable-identity" ? null : { ...identity, pid });
            f.ports.removeArchive = vi.fn(f.ports.removeArchive);
            f.ports.openClaim = vi.fn(f.ports.openClaim);
            const started = f.ports.now();
            const operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 1000, staleMs: 1, waitBudget: { remaining: () => 47 - (f.ports.now() - started) } }))
                .rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(f.ports.now() - started).toBe(47);
            expect(operation).not.toHaveBeenCalled();
            expect(f.ports.openClaim).toHaveBeenCalledOnce();
            expect(f.records.has(archived)).toBe(true);
            expect(f.records.has(f.file)).toBe(false);
            expect(f.ports.removeArchive).not.toHaveBeenCalled();
        });

        it.each(["exited", "recorded-mismatch", "authoritative-reboot", "malformed", "missing"] as const)(`${mode} recovers only qualified %s archive evidence`, async state => {
            const f = fixture(variant);
            f.ports.platform = () => "linux";
            const owner = { token: "f".repeat(32), pid: 456, host: "test-host", bootId: state === "authoritative-reboot" ? "11111111-1111-1111-1111-111111111111" : "test-boot",
                processIdentity: { ...identity, pid: 456, startToken: state === "recorded-mismatch" ? "old-generation" : identity.startToken } };
            if (state === "authoritative-reboot") f.ports.boot = () => "22222222-2222-2222-2222-222222222222";
            if (state === "exited") f.ports.alive = pid => pid !== owner.pid;
            if (state === "recorded-mismatch") {
                vi.mocked(f.ports.observe).mockReturnValue("mismatch");
                vi.mocked(f.ports.identityAsync).mockImplementation(async pid => ({ ...identity, pid }));
            }
            const archived = f.archive(state === "malformed" ? { kind: "malformed" } : state === "missing" ? { kind: "missing" } : { kind: "value", value: owner });
            if (state !== "malformed" && state !== "missing") {
                const future = f.ports.now() + 60_000;
                f.ports.mtime = path => path === archived ? future : f.ports.now() - 5000;
            }
            f.ports.removeArchive = vi.fn(f.ports.removeArchive);
            expect(await acquire(f, () => "entered", { waitMs: 100, staleMs: 1 })).toBe("entered");
            expect(f.records.has(f.file)).toBe(false);
            if (state === "missing") expect(f.ports.removeArchive).not.toHaveBeenCalled();
            else {
                expect(f.records.has(archived)).toBe(false);
                expect(f.ports.removeArchive).toHaveBeenCalledWith(f.file, archived, state === "malformed" ? null : owner.token, []);
            }
        });

        it.each(["recent", "future"] as const)(`${mode} preserves malformed %s publication grace before archived recovery`, async age => {
            const f = fixture(variant);
            const archived = f.archive({ kind: "malformed" });
            const started = f.ports.now();
            const born = started + (age === "recent" ? -70 : 60_000);
            f.ports.mtime = path => path === archived ? born : f.ports.now() - 5000;
            const operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 20, staleMs: 1, waitBudget: { remaining: () => started + 20 - f.ports.now() } }))
                .rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(operation).not.toHaveBeenCalled();
            expect(f.records.has(archived)).toBe(true);
            f.advance(born + 100 - f.ports.now());
            expect(await acquire(f, () => "aged", { staleMs: 1 })).toBe("aged");
            expect(f.records.has(archived)).toBe(false);
        });

        it(`${mode} cleans a displaced candidate and retries within its original budget`, async () => {
            const f = fixture(variant);
            const successor = { token: "e".repeat(32), pid: 456, host: "foreign-host" };
            let displaced: string | undefined;
            f.ports.closeClaim = () => { if (!displaced) { displaced = f.displace(); f.seed(successor); } };
            const originalPause = f.ports.pauseSync;
            const originalAsyncPause = f.ports.pause;
            const started = f.ports.now();
            if (mode === "sync") f.ports.pauseSync = ms => { originalPause(ms); if (f.ports.now() - started >= 30) f.records.delete(f.file); };
            else f.ports.pause = async (ms, signal?: AbortSignal) => { if (signal) return originalAsyncPause(ms, signal); await f.ports.pauseSync(ms); if (f.ports.now() - started >= 30) f.records.delete(f.file); return undefined; };
            f.ports.openClaim = vi.fn(f.ports.openClaim);
            const operation = vi.fn(() => f.record());
            const admitted = await acquire(f, operation, { waitMs: 1000, waitBudget: { remaining: () => 47 - (f.ports.now() - started) } });
            expect(admitted).toMatchObject({ pid: identity.pid, host: "test-host" });
            expect(operation).toHaveBeenCalledOnce();
            expect(vi.mocked(f.ports.openClaim).mock.calls.length).toBeGreaterThan(1);
            expect(f.ports.now() - started).toBe(30);
            expect(f.records.size).toBe(0);
            expect(displaced).toBeDefined();
        });

        it(`${mode} never admits a displaced publication or renews its deadline behind a successor`, async () => {
            const f = fixture(variant);
            const successor = { token: "e".repeat(32), pid: 456, host: "foreign-host" };
            let displaced: string | undefined;
            f.ports.closeClaim = () => { displaced = f.displace(); f.seed(successor); };
            const started = f.ports.now();
            const operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 47, waitBudget: { remaining: () => 47 - (f.ports.now() - started) } }))
                .rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(operation).not.toHaveBeenCalled();
            expect(f.ports.now() - started).toBe(47);
            expect(f.records.get(f.file)).toEqual({ kind: "value", value: successor });
            expect(f.records.has(displaced!)).toBe(false);
        });

        it(`${mode} releases main first and then exact own archives without restoring or removing successors`, async () => {
            const f = fixture(variant);
            const events: string[] = [];
            const move = f.ports.moveQualified, remove = f.ports.removeArchive;
            f.ports.moveQualified = (...args) => { events.push("main"); return move(...args); };
            f.ports.removeArchive = (...args) => { events.push("archive"); return remove(...args); };
            const successor = { token: "e".repeat(32), pid: 456, host: "foreign-host" };
            let owned = "", foreign = "";
            expect(await acquire(f, () => {
                owned = f.displace();
                f.seed(successor);
                foreign = f.archive({ kind: "value", value: successor });
                return "complete";
            })).toBe("complete");
            expect(events).toEqual(["main", "archive"]);
            expect(f.records.has(owned)).toBe(false);
            expect(f.records.get(f.file)).toEqual({ kind: "value", value: successor });
            expect(f.records.get(foreign)).toEqual({ kind: "value", value: successor });
        });

        it.each([false, true])(`${mode} reports failed exact own archive cleanup (primary failure: %s)`, async fails => {
            const f = fixture(variant);
            const primary = Object.assign(new Error("operation failed"), { code: "operation-primary" });
            let owned = "";
            f.ports.removeArchive = () => false;
            let observed: unknown;
            try { await acquire(f, () => { owned = f.displace(); if (fails) throw primary; return "success"; }); }
            catch (error) { observed = error; }
            expect(f.records.has(owned)).toBe(true);
            expect(f.records.has(f.file)).toBe(false);
            if (fails) {
                expect(observed).toBeInstanceOf(AggregateError);
                expect((observed as AggregateError).cause).toBe(primary);
                expect((observed as AggregateError).errors[0]).toBe(primary);
                expect((observed as AggregateError).errors[1]).toMatchObject({ code: "shared-mutation-lock-release-failed" });
                expect(observed).toMatchObject({ code: primary.code });
            } else expect(observed).toMatchObject({ code: "shared-mutation-lock-release-failed" });
        });
    }
});

describe("native lock publication timestamp observations", () => {
    it.each([
        ["UTC", "windows:2026-10-12T14:52:34.492Z"],
        ["positive offset", "windows:2026-10-12T20:22:34.492+05:30"],
        ["negative offset", "windows:2026-10-12T10:52:34.492-04:00"],
        ["seven fractional digits", "windows:2026-10-12T14:52:34.4921234Z"],
        ["seven fractional digits and an offset", "windows:2026-10-12T20:22:34.4921234+05:30"],
    ])("normalizes a %s native start token", (_label, startToken) => {
        const observation: LockPublicationTimes = readLockPublicationTimes({ ...identity, startToken }, "2026-10-12T14:51:20.492Z");
        expect(observation).toEqual({
            kind: "known",
            processStartedAtMs: Date.UTC(2026, 9, 12, 14, 52, 34, 492),
            claimCreatedAtMs: Date.UTC(2026, 9, 12, 14, 51, 20, 492),
        });
    });

    it("preserves timezone-less claim publication compatibility", () => {
        expect(readLockPublicationTimes({ ...identity, startToken: "windows:2026-10-12T14:52:34.0000000Z" }, "2026-10-12T14:51:20.492")).toEqual({
            kind: "known",
            processStartedAtMs: Date.UTC(2026, 9, 12, 14, 52, 34),
            claimCreatedAtMs: new Date(2026, 9, 12, 14, 51, 20, 492).getTime(),
        });
    });

    it.each([
        ["unknown native token", "native-birth"],
        ["malformed token", "windows:unavailable"],
        ["invalid native date", "windows:2026-99-12T14:52:34.0000000Z"],
        ["invalid native time", "windows:2026-10-12T99:52:34.0000000Z"],
        ["native token without timezone", "windows:2026-10-12T14:52:34.0000000"],
    ])("reports unavailable for a %s", (_label, startToken) => {
        expect(readLockPublicationTimes({ ...identity, startToken }, "2026-10-12T14:51:20.492Z")).toEqual({ kind: "unavailable" });
    });

    it.each([
        ["absent", undefined],
        ["empty", ""],
        ["malformed", "opaque-publication-time"],
        ["invalid date", "2026-99-12T14:51:20.492Z"],
    ])("reports unavailable for an %s claim publication", (_label, createdAt) => {
        expect(readLockPublicationTimes({ ...identity, startToken: "windows:2026-10-12T14:52:34.0000000Z" }, createdAt)).toEqual({ kind: "unavailable" });
    });
});
