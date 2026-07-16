import { spawn } from "child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve } from "path";
import { pathToFileURL } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    claimPhysicalLease,
    heartbeatPhysicalLease,
    prunePhysicalLeases,
    readPhysicalLeases,
    releasePhysicalLease,
    startPhysicalLeaseHeartbeat,
    stopPhysicalLeaseHeartbeat,
} from "../../device-lab-mcp/src/state/physical-lease-store.mjs";
import { ownerId } from "../../device-lab-mcp/src/context.mjs";

describe("device-lab MCP direct physical lease store", () => {
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        process.env.HOME = mkdtempSync(join(tmpdir(), "ccc-physical-lease-store-test-home-"));
    });

    afterEach(() => {
        vi.useRealTimers();
        if (process.env.HOME) rmSync(process.env.HOME, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
    });

    function lockPath(backend: string, hardwareId: string) {
        return join(homedir(), ".ccc/devices/physical-leases", backend, "locks", `${encodeURIComponent(hardwareId)}.json`);
    }

    function runLeaseChild(profile: string, hardwareId: string) {
        const moduleUrl = pathToFileURL(resolve("device-lab-mcp/src/state/physical-lease-store.mjs")).href;
        const script = `import { claimPhysicalLease } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(claimPhysicalLease("android-device", ${JSON.stringify(hardwareId)}, ${JSON.stringify(`device-${profile}`)}, { ttlMs: 60000 })));`;
        return new Promise<Record<string, unknown>>((resolveChild, rejectChild) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
                env: { ...process.env, HOME: process.env.HOME, CCC_PROFILE: profile },
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                rejectChild(new Error(`physical lease child timed out: ${profile}`));
            }, 10000);
            child.stdout.on("data", (chunk) => { stdout += chunk; });
            child.stderr.on("data", (chunk) => { stderr += chunk; });
            child.on("error", rejectChild);
            child.on("close", (status) => {
                clearTimeout(timer);
                if (status !== 0) {
                    rejectChild(new Error(`physical lease child failed (${status}): ${stderr}`));
                    return;
                }
                resolveChild(JSON.parse(stdout.trim()));
            });
        });
    }

    it("claims, heartbeats, lists, and releases leases with TTL metadata", () => {
        const claimed = claimPhysicalLease("android-device", "USB123", "android-usb", { ttlMs: 60000 });
        expect(claimed).toEqual(expect.objectContaining({
            ok: true,
            lease: expect.objectContaining({
                ownerId: ownerId(),
                hardwareId: "USB123",
                ttlMs: 60000,
                heartbeatAt: expect.any(String),
                expiresAt: expect.any(String),
            }),
        }));

        const firstExpires = Date.parse(claimed.lease.expiresAt);
        const heartbeat = heartbeatPhysicalLease("android-device", "USB123", "android-usb", { ttlMs: 120000 });
        expect(heartbeat).toEqual(expect.objectContaining({
            ok: true,
            heartbeat: true,
            lease: expect.objectContaining({ ttlMs: 120000, expiresAt: expect.any(String) }),
        }));
        expect(Date.parse(heartbeat.lease.expiresAt)).toBeGreaterThan(firstExpires);
        expect(readPhysicalLeases("android-device")).toEqual([
            expect.objectContaining({ hardwareId: "USB123", ttlMs: 120000 }),
        ]);

        expect(releasePhysicalLease("android-device", "USB123", "android-usb")).toBe(true);
        expect(existsSync(lockPath("android-device", "USB123"))).toBe(false);
        expect(readPhysicalLeases("android-device")).toEqual([]);
    });

    it("fences same-owner attach operations and token-bound lease mutations", () => {
        const claimed = claimPhysicalLease("android-device", "USB-FENCED", "android-fenced", {
            ttlMs: 60000,
            claimNonce: "attach-operation-a",
        });
        expect(claimed).toEqual(expect.objectContaining({
            ok: true,
            lease: expect.objectContaining({ claimNonce: "attach-operation-a", claimId: expect.any(String) }),
        }));

        expect(claimPhysicalLease("android-device", "USB-FENCED", "android-fenced", {
            ttlMs: 60000,
            claimNonce: "attach-operation-b",
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "physical-lease-operation-conflict",
        }));
        expect(claimPhysicalLease("android-device", "USB-FENCED", "android-other", { ttlMs: 60000 })).toEqual(expect.objectContaining({
            ok: false,
            error: "physical-lease-device-mismatch",
        }));

        expect(heartbeatPhysicalLease("android-device", "USB-FENCED", "android-fenced", {
            ttlMs: 60000,
            claimId: "wrong-claim",
            claimNonce: "attach-operation-a",
        })).toEqual(expect.objectContaining({ ok: false, error: "physical-lease-claim-mismatch" }));
        expect(releasePhysicalLease("android-device", "USB-FENCED", "android-fenced", {
            claimId: claimed.lease.claimId,
            claimNonce: "attach-operation-b",
        })).toBe(false);
        expect(existsSync(lockPath("android-device", "USB-FENCED"))).toBe(true);
        expect(releasePhysicalLease("android-device", "USB-FENCED", "android-fenced", {
            claimId: claimed.lease.claimId,
            claimNonce: "attach-operation-a",
        })).toBe(true);
    });

    it("fails closed on malformed or linked authoritative lease locks", () => {
        const malformedHardware = "USB-MALFORMED";
        const malformedFile = lockPath("android-device", malformedHardware);
        mkdirSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks"), { recursive: true });
        writeFileSync(malformedFile, "{not-json");

        expect(() => claimPhysicalLease("android-device", malformedHardware, "replacement")).toThrow("physical-lease-state-invalid");
        expect(readFileSync(malformedFile, "utf8")).toBe("{not-json");

        const target = join(homedir(), "external-lease.json");
        const targetLease = {
            backend: "android-device",
            hardwareId: "USB-LINKED",
            ownerId: "foreign-owner",
            deviceId: "foreign-device",
            updatedAt: new Date().toISOString(),
            ttlMs: 60000,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
        writeFileSync(target, JSON.stringify(targetLease));
        for (const kind of ["symbolic", "hard"] as const) {
            const hardwareId = `USB-${kind.toUpperCase()}`;
            const file = lockPath("android-device", hardwareId);
            if (kind === "symbolic") symlinkSync(target, file);
            else linkSync(target, file);
            expect(() => claimPhysicalLease("android-device", hardwareId, "replacement")).toThrow("physical-lease-state-invalid");
            expect(JSON.parse(readFileSync(target, "utf8"))).toEqual(targetLease);
        }
    });

    it.runIf(process.platform !== "win32")("rejects linked direct-provider lease directories", () => {
        const physicalRoot = join(homedir(), ".ccc/devices/physical-leases");
        const backendRoot = join(physicalRoot, "android-device");
        const externalLocks = mkdtempSync(join(tmpdir(), "ccc-direct-external-locks-"));
        const externalRoot = mkdtempSync(join(tmpdir(), "ccc-direct-external-lease-root-"));
        try {
            mkdirSync(backendRoot, { recursive: true });
            symlinkSync(externalLocks, join(backendRoot, "locks"));
            expect(() => claimPhysicalLease("android-device", "LINKED-DIRECT", "linked-direct-device"))
                .toThrow("physical-lease-directory-path-invalid");
            expect(readdirSync(externalLocks)).toEqual([]);

            rmSync(physicalRoot, { recursive: true, force: true });
            symlinkSync(externalRoot, physicalRoot);
            expect(() => readPhysicalLeases("android-device")).toThrow("physical-lease-directory-path-invalid");
            expect(readdirSync(externalRoot)).toEqual([]);
        } finally {
            rmSync(externalLocks, { recursive: true, force: true });
            rmSync(externalRoot, { recursive: true, force: true });
        }
    });

    it("preserves a malformed diagnostic aggregate while maintaining the authoritative lock", () => {
        const aggregateFile = join(homedir(), ".ccc/devices/physical-leases/android-device.json");
        mkdirSync(join(homedir(), ".ccc/devices/physical-leases"), { recursive: true });
        writeFileSync(aggregateFile, "{broken-aggregate");

        const claimed = claimPhysicalLease("android-device", "USB-AGGREGATE", "android-aggregate", { ttlMs: 60000 });

        expect(claimed).toEqual(expect.objectContaining({ ok: true }));
        expect(readFileSync(aggregateFile, "utf8")).toBe("{broken-aggregate");
        expect(JSON.parse(readFileSync(lockPath("android-device", "USB-AGGREGATE"), "utf8"))).toEqual(expect.objectContaining({
            ownerId: ownerId(),
            deviceId: "android-aggregate",
        }));
        expect(() => readPhysicalLeases("android-device")).toThrow("physical-lease-aggregate-state-invalid");
    });

    it("recovers expired foreign locks while preserving active foreign conflicts", () => {
        const expired = "FOREIGN-EXPIRED";
        const active = "FOREIGN-ACTIVE";
        mkdirSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks"), { recursive: true });
        writeFileSync(lockPath("android-device", expired), JSON.stringify({
            backend: "android-device",
            hardwareId: expired,
            ownerId: "foreign-owner",
            deviceId: "foreign-expired",
            updatedAt: "2000-01-01T00:00:00.000Z",
            ttlMs: 60000,
            expiresAt: "2000-01-01T00:01:00.000Z",
        }));
        writeFileSync(lockPath("android-device", active), JSON.stringify({
            backend: "android-device",
            hardwareId: active,
            ownerId: "foreign-owner",
            deviceId: "foreign-active",
            updatedAt: new Date().toISOString(),
            ttlMs: 60000,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
        }));

        const recovered = claimPhysicalLease("android-device", expired, "android-recovered");
        expect(recovered).toEqual(expect.objectContaining({
            ok: true,
            lease: expect.objectContaining({ hardwareId: expired, ownerId: ownerId(), deviceId: "android-recovered" }),
        }));
        expect(JSON.parse(readFileSync(lockPath("android-device", expired), "utf8")).ownerId).toBe(ownerId());

        const conflict = claimPhysicalLease("android-device", active, "android-conflict");
        expect(conflict).toEqual(expect.objectContaining({
            ok: false,
            conflict: expect.objectContaining({ ownerId: "foreign-owner", hardwareId: active }),
        }));
    });

    it("rebinds expired same-owner locks to the new claim device id", () => {
        const hardwareId = "OWN-STALE";
        mkdirSync(join(homedir(), ".ccc/devices/physical-leases/android-device/locks"), { recursive: true });
        writeFileSync(lockPath("android-device", hardwareId), JSON.stringify({
            backend: "android-device",
            hardwareId,
            ownerId: ownerId(),
            deviceId: "old-device",
            updatedAt: "2000-01-01T00:00:00.000Z",
            ttlMs: 60000,
            expiresAt: "2000-01-01T00:01:00.000Z",
        }));

        const rebound = claimPhysicalLease("android-device", hardwareId, "new-device", { ttlMs: 60000 });

        expect(rebound).toEqual(expect.objectContaining({
            ok: true,
            lease: expect.objectContaining({ hardwareId, ownerId: ownerId(), deviceId: "new-device" }),
        }));
        expect(JSON.parse(readFileSync(lockPath("android-device", hardwareId), "utf8"))).toEqual(expect.objectContaining({
            ownerId: ownerId(),
            deviceId: "new-device",
        }));
    });

    it("keeps active foreign locks when pruning stale owner aggregate entries", () => {
        const hardwareId = "RECOVERED-BY-FOREIGN";
        const staleOwnerLease = {
            backend: "ios-device",
            hardwareId,
            ownerId: ownerId(),
            deviceId: "old-owner-device",
            updatedAt: "2000-01-01T00:00:00.000Z",
            ttlMs: 60000,
            expiresAt: "2000-01-01T00:01:00.000Z",
        };
        const activeForeignLock = {
            backend: "ios-device",
            hardwareId,
            ownerId: "foreign-owner",
            deviceId: "foreign-active-device",
            updatedAt: new Date().toISOString(),
            ttlMs: 60000,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
        };
        mkdirSync(join(homedir(), ".ccc/devices/physical-leases/ios-device/locks"), { recursive: true });
        writeFileSync(lockPath("ios-device", hardwareId), JSON.stringify(activeForeignLock));
        writeFileSync(join(homedir(), ".ccc/devices/physical-leases/ios-device.json"), JSON.stringify({ leases: [staleOwnerLease] }));

        expect(prunePhysicalLeases("ios-device")).toEqual([]);
        expect(JSON.parse(readFileSync(lockPath("ios-device", hardwareId), "utf8"))).toEqual(expect.objectContaining({
            ownerId: "foreign-owner",
            deviceId: "foreign-active-device",
        }));
        expect(readPhysicalLeases("ios-device")).toEqual([]);
    });

    it("can keep direct-provider attach leases alive with a managed heartbeat timer", () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-06-16T00:00:00.000Z"));
        const claimed = claimPhysicalLease("android-device", "USB-HEARTBEAT", "android-heartbeat", { ttlMs: 60000 });
        const firstExpiresAt = Date.parse(claimed.lease.expiresAt);

        expect(startPhysicalLeaseHeartbeat("android-device", "USB-HEARTBEAT", "android-heartbeat", { ttlMs: 60000, intervalMs: 1000 })).toEqual(expect.objectContaining({
            ok: true,
            heartbeatManaged: true,
        }));

        vi.advanceTimersByTime(1000);
        expect(Date.parse(JSON.parse(readFileSync(lockPath("android-device", "USB-HEARTBEAT"), "utf8")).expiresAt)).toBeGreaterThan(firstExpiresAt);
        expect(stopPhysicalLeaseHeartbeat("android-device", "USB-HEARTBEAT", "android-heartbeat")).toBe(true);
    });

    it("preserves cross-owner aggregate entries and permits one winner per hardware across processes", { timeout: 30000 }, async () => {
        const distinctClaims = await Promise.all(Array.from({ length: 16 }, (_, index) => runLeaseChild(`aggregate-${index}`, `USB-${index}`)));
        expect(distinctClaims.every((claim) => claim.ok === true)).toBe(true);
        const aggregate = JSON.parse(readFileSync(join(homedir(), ".ccc/devices/physical-leases/android-device.json"), "utf8")) as { leases: Array<{ hardwareId: string; claimId?: string }> };
        expect(aggregate.leases).toHaveLength(16);
        expect(new Set(aggregate.leases.map((lease) => lease.hardwareId)).size).toBe(16);
        expect(aggregate.leases.every((lease) => typeof lease.claimId === "string" && lease.claimId.length > 0)).toBe(true);

        const contested = await Promise.all(Array.from({ length: 16 }, (_, index) => runLeaseChild(`contest-${index}`, "USB-CONTESTED")));
        expect(contested.filter((claim) => claim.ok === true)).toHaveLength(1);
        expect(contested.filter((claim) => claim.ok === false && claim.conflict)).toHaveLength(15);
        const lockDirectory = join(homedir(), ".ccc/devices/physical-leases/android-device/locks");
        expect(readdirSync(lockDirectory).filter((name) => name.includes("mutation.lock"))).toEqual([]);
        expect(readdirSync(join(homedir(), ".ccc/devices/physical-leases")).filter((name) => name.includes("mutation.lock"))).toEqual([]);
    });

    it("heartbeats reject foreign and expired owner leases, and prune removes expired owner aggregate locks", () => {
        const ownExpired = "OWN-EXPIRED";
        const foreign = "FOREIGN";
        mkdirSync(join(homedir(), ".ccc/devices/physical-leases/ios-device/locks"), { recursive: true });
        const expiredLease = {
            backend: "ios-device",
            hardwareId: ownExpired,
            ownerId: ownerId(),
            deviceId: "ios-expired",
            updatedAt: "2000-01-01T00:00:00.000Z",
            ttlMs: 60000,
            expiresAt: "2000-01-01T00:01:00.000Z",
        };
        writeFileSync(lockPath("ios-device", ownExpired), JSON.stringify(expiredLease));
        writeFileSync(lockPath("ios-device", foreign), JSON.stringify({
            backend: "ios-device",
            hardwareId: foreign,
            ownerId: "foreign-owner",
            deviceId: "ios-foreign",
            updatedAt: new Date().toISOString(),
            ttlMs: 60000,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
        }));
        writeFileSync(join(homedir(), ".ccc/devices/physical-leases/ios-device.json"), JSON.stringify({ leases: [expiredLease] }));

        expect(heartbeatPhysicalLease("ios-device", foreign, "ios-foreign")).toEqual(expect.objectContaining({
            ok: false,
            conflict: expect.objectContaining({ ownerId: "foreign-owner" }),
        }));
        expect(heartbeatPhysicalLease("ios-device", ownExpired, "ios-expired")).toEqual(expect.objectContaining({
            ok: false,
            error: "physical-lease-expired",
            pruned: true,
        }));

        writeFileSync(lockPath("ios-device", ownExpired), JSON.stringify(expiredLease));
        writeFileSync(join(homedir(), ".ccc/devices/physical-leases/ios-device.json"), JSON.stringify({ leases: [expiredLease] }));
        expect(prunePhysicalLeases("ios-device")).toEqual([
            expect.objectContaining({ hardwareId: ownExpired, expired: true }),
        ]);
        expect(existsSync(lockPath("ios-device", ownExpired))).toBe(false);
        expect(readPhysicalLeases("ios-device")).toEqual([]);
    });
});
