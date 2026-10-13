import { describe, expect, it, vi } from "vitest";
import { createSharedMutationLock } from "../../../packages/device-lab/providers/application/shared-mutation-lock.mjs";
import { readLockPublicationTimes } from "../../../packages/device-lab/providers/adapters/lock-publication-times.mjs";
import type { LockProcessIdentity, LockPublicationTimes, SharedMutationLockPorts } from "../../../packages/device-lab/providers/ports/shared-mutation-lock.mjs";

const identity: LockProcessIdentity = { pid: 123, startToken: "native-birth", commandHash: "a".repeat(64) };
let fixtureNumber = 0;

function fixture(variant: "typescript" | "provider") {
    let now = 100_000;
    let claim: Record<string, unknown> | undefined;
    let token = 0;
    const file = `/identity-${++fixtureNumber}.lock`;
    const ports: SharedMutationLockPorts<[]> = {
        variant, key: value => value, ownerContext: () => [], runOwnerContext: (_key, _token, operation) => operation(),
        capture: () => [], check: () => undefined,
        token: () => (++token).toString(16).padStart(32, "0"), pid: () => identity.pid,
        host: () => "test-host", boot: () => "test-boot", platform: () => "win32", timestamp: () => new Date(now).toISOString(),
        now: () => now, monotonic: () => now,
        pauseSync: ms => { now += ms; }, pause: async ms => { now += ms; return undefined; },
        openClaim: () => { if (claim) throw Object.assign(new Error("occupied"), { code: "EEXIST" }); return 1; },
        writeClaim: (_fd, text) => { claim = JSON.parse(text); }, closeClaim: () => undefined,
        readRaw: () => claim ? { kind: "value", value: claim } : { kind: "missing" },
        mtime: () => now - 5000, alive: () => true,
        identitySync: vi.fn(() => identity), identityAsync: vi.fn(async () => identity),
        publicationTimes: vi.fn(readLockPublicationTimes),
        observe: vi.fn(() => "unavailable" as const), matches: (expected, current) => expected.startToken === current.startToken,
        moveQualified: (_file, expected) => { if (claim?.token !== expected) return false; claim = undefined; return true; },
        moveMalformed: () => false,
        errorCode: error => (error as { code?: string }).code,
        timeout: () => Object.assign(new Error("timeout"), { code: "shared-mutation-lock-timeout" }),
    };
    return { ports, app: createSharedMutationLock(ports), file, record: () => ({ ...claim }), advance: (ms: number) => { now += ms; }, seed: (value: Record<string, unknown>) => { claim = value; } };
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
    ] as const)("bounds contended %s acquisition with a %s explicit budget without fresh observations", async (mode, warmth) => {
        const f = fixture(variant);
        if (warmth === "warm") await f.app.withLockAsync(f.file, f.record);
        vi.mocked(f.ports.identitySync).mockClear();
        vi.mocked(f.ports.identityAsync).mockClear();
        const legacy = { token: "f".repeat(32), pid: 456, host: "test-host", createdAt: "2026-10-12T14:51:20.492Z", processIdentityStatus: "unavailable" };
        f.seed(legacy);
        f.ports.openClaim = vi.fn(f.ports.openClaim);
        vi.mocked(f.ports.publicationTimes).mockReturnValue({ kind: "known", processStartedAtMs: 51_001, claimCreatedAtMs: 50_000 });
        const deadline = f.ports.now() + 30;
        const options = { waitMs: 30, waitBudget: { remaining: () => deadline - f.ports.now() } };
        const operation = vi.fn();
        if (mode === "sync") {
            expect(() => f.app.withLock(f.file, operation, options)).toThrow(expect.objectContaining({ code: "shared-mutation-lock-timeout" }));
        } else {
            await expect(f.app.withLockAsync(f.file, operation, options)).rejects.toMatchObject({ code: "shared-mutation-lock-timeout" });
        }
        expect(f.ports.openClaim).toHaveBeenCalled();
        expect(operation).not.toHaveBeenCalled();
        expect(f.record()).toEqual(legacy);
        expect(f.ports.identitySync).not.toHaveBeenCalled();
        expect(f.ports.identityAsync).not.toHaveBeenCalled();
        expect(f.ports.publicationTimes).not.toHaveBeenCalled();
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
