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
        publicationTimes: vi.fn(readLockPublicationTimes),
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

describe.each(["typescript", "provider"] as const)("%s Windows own guard identity", variant => {
    it.each([
        ["later process", "windows:2026-10-12T14:52:34.0000000Z", true],
        ["original process", "windows:2026-10-12T14:50:00.0000000Z", false],
        ["ambiguous start", "windows:unavailable", false],
        ["start without timezone", "windows:2026-10-12T14:52:34", false],
    ])("qualifies an identity-unavailable claim against a %s", async (_label, startToken, reclaimed) => {
        const f = fixture(variant);
        const legacy = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "2026-10-12T14:51:20.492Z", processIdentityStatus: "unavailable" };
        f.seed(legacy);
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === 456 ? { ...identity, pid, startToken } : identity);
        const operation = vi.fn(() => "recovered");
        const result = f.app.withLockAsync(f.file, operation, { waitMs: 30 });
        if (reclaimed) {
            await expect(result).resolves.toBe("recovered");
            expect(operation).toHaveBeenCalledOnce();
        } else {
            await expect(result).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(operation).not.toHaveBeenCalled();
            expect(f.record()).toEqual(legacy);
        }
    });
    it.each<{ label: string; times: LockPublicationTimes; reclaimed: boolean }>([
        { label: "original owner", times: { kind: "known", processStartedAtMs: 49_000, claimCreatedAtMs: 50_000 }, reclaimed: false },
        { label: "owner born at publication", times: { kind: "known", processStartedAtMs: 50_000, claimCreatedAtMs: 50_000 }, reclaimed: false },
        { label: "owner born within the tolerance", times: { kind: "known", processStartedAtMs: 50_999, claimCreatedAtMs: 50_000 }, reclaimed: false },
        { label: "owner born exactly 1000ms after publication", times: { kind: "known", processStartedAtMs: 51_000, claimCreatedAtMs: 50_000 }, reclaimed: false },
        { label: "replacement born 1001ms after publication", times: { kind: "known", processStartedAtMs: 51_001, claimCreatedAtMs: 50_000 }, reclaimed: true },
        { label: "unavailable publication observation", times: { kind: "unavailable" }, reclaimed: false },
    ])("uses injected publication facts for an opaque $label", async ({ times, reclaimed }) => {
        const f = fixture(variant);
        const current = { ...identity, pid: 456, startToken: "opaque-native-process-generation" };
        const legacy = { token: "f".repeat(32), pid: current.pid, host: "test-host", createdAt: "opaque-publication-time", processIdentityStatus: "unavailable" };
        f.seed(legacy);
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === current.pid ? current : identity);
        vi.mocked(f.ports.publicationTimes).mockReturnValue(times);
        const operation = vi.fn(() => "recovered");
        const result = f.app.withLockAsync(f.file, operation, { waitMs: 30 });
        if (reclaimed) {
            await expect(result).resolves.toBe("recovered");
            expect(operation).toHaveBeenCalledOnce();
            expect(f.ports.readRaw(f.file)).toEqual({ kind: "missing" });
        } else {
            await expect(result).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(operation).not.toHaveBeenCalled();
            expect(f.record()).toEqual(legacy);
        }
        expect(f.ports.publicationTimes).toHaveBeenCalledWith(current, legacy.createdAt);
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
        expect(f.ports.publicationTimes).not.toHaveBeenCalled();
    });

    it("protects the recorded original owner without consulting publication times", async () => {
        const f = fixture(variant);
        const original = { ...identity, pid: 456, startToken: "opaque-original-generation" };
        const claim = { token: "f".repeat(32), pid: original.pid, host: "test-host", createdAt: "opaque-publication-time", processIdentityStatus: "recorded", processIdentity: original };
        f.seed(claim);
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === original.pid ? original : identity);
        vi.mocked(f.ports.publicationTimes).mockReturnValue({ kind: "known", processStartedAtMs: 51_001, claimCreatedAtMs: 50_000 });
        const operation = vi.fn();
        await expect(f.app.withLockAsync(f.file, operation, { waitMs: 30 })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(claim);
        expect(f.ports.publicationTimes).not.toHaveBeenCalled();
    });

    it("keeps synchronous acquisition from probing a live Windows legacy owner", () => {
        const f = fixture(variant);
        const legacy = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "2026-10-12T14:51:20.492Z", processIdentityStatus: "unavailable" };
        f.seed(legacy);
        vi.mocked(f.ports.publicationTimes).mockReturnValue({ kind: "known", processStartedAtMs: 51_001, claimCreatedAtMs: 50_000 });
        const operation = vi.fn();
        expect(() => f.app.withLock(f.file, operation, { waitMs: 30 })).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(legacy);
        expect(f.ports.identityAsync).not.toHaveBeenCalled();
        expect(f.ports.publicationTimes).not.toHaveBeenCalled();
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
            expect(f.ports.publicationTimes).not.toHaveBeenCalled();
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

    it.each(["active", "archived"] as const)("retains a cold budgeted %s Windows owner after wall rollback despite a later apparent process birth", async location => {
        const f = fixture(variant);
        const initialWall = Date.UTC(2026, 9, 16, 12);
        const processStartedAtMs = initialWall - 1000;
        const ownerIdentity = { ...identity, startToken: `windows:${new Date(processStartedAtMs).toISOString()}` };
        let wallNow = initialWall, monotonicNow = 17.25, ownerPath = f.file;
        let releaseOwner!: () => void, ownerEntered!: () => void;
        const ownerGate = new Promise<void>(resolve => { releaseOwner = resolve; });
        const ownerReady = new Promise<void>(resolve => { ownerEntered = resolve; });
        const pause = f.ports.pause;
        f.ports.now = () => wallNow;
        f.ports.monotonic = () => monotonicNow;
        f.ports.timestamp = () => {
            wallNow -= 60_000;
            return new Date(wallNow).toISOString();
        };
        f.ports.mtime = () => wallNow - 5000;
        f.ports.alive = () => true;
        f.ports.pause = (milliseconds, signal) => {
            if (signal) return pause(milliseconds, signal);
            monotonicNow += milliseconds;
            wallNow -= 86_400_000;
            return Promise.resolve(undefined);
        };
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => pid === ownerIdentity.pid ? ownerIdentity : { ...identity, pid });
        const owner = f.app.withLockAsync(f.file, async () => {
            if (location === "archived") ownerPath = f.displace();
            ownerEntered();
            await ownerGate;
            return "owner";
        }, { waitMs: 1000, waitBudget: { remaining: () => 1000 } });
        await ownerReady;
        try {
            const published = f.app.readLock(ownerPath)!;
            expect(published).toMatchObject({ pid: ownerIdentity.pid, processIdentityStatus: "unavailable" });
            expect(published).not.toHaveProperty("processIdentity");
            expect(readLockPublicationTimes(ownerIdentity, published.createdAt)).toEqual({
                kind: "known", processStartedAtMs, claimCreatedAtMs: initialWall - 60_000,
            });
            const contenderToken = "e".repeat(32);
            f.ports.moveQualified = vi.fn(f.ports.moveQualified);
            f.ports.moveMalformed = vi.fn(f.ports.moveMalformed);
            f.ports.removeArchive = vi.fn(f.ports.removeArchive);
            const contender = createSharedMutationLock({ ...f.ports, pid: () => 456, token: () => contenderToken });
            const operation = vi.fn(() => "unexpected admission");
            const deadline = monotonicNow + 47;
            await expect(contender.withLockAsync(f.file, operation, {
                waitMs: 1000, waitBudget: { remaining: () => deadline - monotonicNow },
            })).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });

            expect(monotonicNow).toBe(deadline);
            expect(wallNow).toBeLessThan(initialWall - 60_000);
            expect(operation).not.toHaveBeenCalled();
            expect(f.records.get(ownerPath)).toEqual({ kind: "value", value: published });
            expect(f.ports.moveMalformed).not.toHaveBeenCalled();
            expect(f.ports.removeArchive).not.toHaveBeenCalled();
            if (location === "archived") {
                expect(f.ports.moveQualified).toHaveBeenCalledExactlyOnceWith(f.file, contenderToken, "release", []);
                expect(f.records.has(f.file)).toBe(false);
            } else expect(f.ports.moveQualified).not.toHaveBeenCalled();
        } finally {
            releaseOwner();
            await owner;
        }
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
        f.ports.pause = async ms => { f.advance(ms); candidatePaused(); await pauseGate; return undefined; };
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
        ["original archived process", 50_000, false],
        ["replacement within tolerance", 51_000, false],
        ["replacement strictly after tolerance", 51_001, true],
        ["unknown publication facts", null, false],
    ] as const)("qualifies a Windows legacy %s using the existing publication policy", async (_label, processStartedAtMs, recovered) => {
        const f = fixture(variant);
        const owner = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "opaque-native-publication", processIdentityStatus: "unavailable" };
        const archived = f.archive({ kind: "value", value: owner });
        vi.mocked(f.ports.identityAsync).mockImplementation(async pid => ({ ...identity, pid }));
        vi.mocked(f.ports.publicationTimes).mockReturnValue(processStartedAtMs === null ? { kind: "unavailable" } : { kind: "known", processStartedAtMs, claimCreatedAtMs: 50_000 });
        const operation = vi.fn(() => "recovered");
        const result = f.app.withLockAsync(f.file, operation, { waitMs: 30, staleMs: 1 });
        if (recovered) {
            await expect(result).resolves.toBe("recovered");
            expect(f.records.has(archived)).toBe(false);
        } else {
            await expect(result).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(operation).not.toHaveBeenCalled();
            expect(f.records.get(archived)).toEqual({ kind: "value", value: owner });
        }
        expect(f.ports.publicationTimes).toHaveBeenCalledWith({ ...identity, pid: owner.pid }, owner.createdAt);
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
            f.ports.removeArchive = vi.fn(f.ports.removeArchive);
            expect(await acquire(f, () => "entered", { waitMs: 100, staleMs: 1 })).toBe("entered");
            expect(f.records.has(f.file)).toBe(false);
            if (state === "missing") expect(f.ports.removeArchive).not.toHaveBeenCalled();
            else {
                expect(f.records.has(archived)).toBe(false);
                expect(f.ports.removeArchive).toHaveBeenCalledWith(f.file, archived, state === "malformed" ? null : owner.token, []);
            }
        });

        it(`${mode} preserves the 100ms malformed floor before archived recovery`, async () => {
            const f = fixture(variant);
            const archived = f.archive({ kind: "malformed" });
            const born = f.ports.now() - 70;
            f.ports.mtime = path => path === archived ? born : f.ports.now() - 5000;
            const operation = vi.fn();
            await expect(acquire(f, operation, { waitMs: 20, staleMs: 1, waitBudget: { remaining: () => born + 90 - f.ports.now() } }))
                .rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
            expect(operation).not.toHaveBeenCalled();
            expect(f.records.has(archived)).toBe(true);
            f.advance(30);
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
        expect(readLockPublicationTimes({ ...identity, startToken }, "2026-10-12T14:51:20.492Z")).toEqual({
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
