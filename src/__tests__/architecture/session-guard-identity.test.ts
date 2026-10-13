import { describe, expect, it, vi } from "vitest";
import { createSharedMutationLock } from "../../../packages/device-lab/providers/application/shared-mutation-lock.mjs";
import type { LockProcessIdentity, SharedMutationLockPorts } from "../../../packages/device-lab/providers/ports/shared-mutation-lock.mjs";

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
        observe: vi.fn(() => "unavailable" as const), matches: (expected, current) => expected.startToken === current.startToken,
        moveQualified: (_file, expected) => { if (claim?.token !== expected) return false; claim = undefined; return true; },
        moveMalformed: () => false,
        errorCode: error => (error as { code?: string }).code,
        timeout: () => Object.assign(new Error("timeout"), { code: "shared-mutation-lock-timeout" }),
    };
    return { ports, app: createSharedMutationLock(ports), file, record: () => ({ ...claim }), advance: (ms: number) => { now += ms; } };
}

describe.each(["typescript", "provider"] as const)("%s Windows own guard identity", variant => {
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
