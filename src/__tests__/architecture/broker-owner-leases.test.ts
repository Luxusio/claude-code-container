import { describe, expect, it } from "vitest";
import { createBrokerOwnerApplication } from "../../../packages/device-lab/src/device-lab/application/broker-owner.js";
import { createBrokerPhysicalLeasesApplication } from "../../../packages/device-lab/src/device-lab/application/broker-physical-leases.js";
import type { BrokerOwnerRegistration } from "../../../packages/device-lab/src/device-lab/domain/broker-owner.js";
import { validateLeaseParams, type PhysicalLeaseRecord, type LeaseWaitBudget } from "../../../packages/device-lab/src/device-lab/domain/broker-physical-leases.js";
import type { BrokerOwnerPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-owner.js";
import type { BrokerPhysicalLeasePorts } from "../../../packages/device-lab/src/device-lab/ports/broker-physical-leases.js";

const ownerId = "1111111111111111", otherOwner = "2222222222222222";
const now = "2026-10-10T12:00:00.000Z";
function ownerFixture() {
    let registration: BrokerOwnerRegistration | null = null, secret: string | null = null;
    let authLocked = false, quarantinePresent = false;
    const published: BrokerOwnerRegistration[] = [];
    const ports: BrokerOwnerPorts = {
        resolveHostPath: cwd => cwd, projectMountPath: () => "/project/fixture",
        identity: (mount, profile) => mount === "/project/fixture" ? { ownerId: profile === "work" ? otherOwner : ownerId, ownerBasis: `${mount}:${profile || "default"}`, projectMountPath: mount, ...(profile ? { profile } : {}) } : null,
        hostProjectMountPath: host => host === "/host/project" || host === "/project/fixture" ? "/project/fixture" : null,
        prepareRegistrations: () => undefined, registrationFile: id => `owners/${id}`,
        readRegistration: () => registration,
        writeRegistration: (_file, record) => { published.push(record); registration = record; return undefined; },
        withRegistrationLock: (_file, operation) => operation(), timestamp: () => now,
        authFile: id => `auth/${id}`, inspectAuthDirectory: () => true, prepareAuthDirectory: () => undefined,
        readSecret: () => secret,
        withAuthLock: (_file, operation) => { authLocked = true; try { return operation(); } finally { authLocked = false; } },
        removeAbandonedAuthArtifacts: () => undefined,
        quarantineAuth: () => { quarantinePresent = true; return { path: "invalid", dev: 1, ino: 2, uid: 3, nlink: 1, kind: "file" }; },
        newSecret: () => "a".repeat(64),
        publishSecret: (_file, record) => { secret = record.secret; return undefined; },
        removeQuarantine: () => { quarantinePresent = false; return undefined; },
    };
    return { ports, published, app: createBrokerOwnerApplication(ports), setRegistration: (record: BrokerOwnerRegistration | null) => { registration = record; }, read: () => registration, secret: () => secret, quarantined: () => quarantinePresent, authLocked: () => authLocked };
}

type Timer = { callback: () => undefined; intervalMs: number; active: boolean; unreferenced: boolean };
function leaseFixture() {
    const records = new Map<string, PhysicalLeaseRecord>();
    const writes: PhysicalLeaseRecord[] = [], removed: string[] = [], cancelled: Timer[] = [];
    const timers: Timer[] = [];
    let clock = Date.parse(now);
    let locked = false, beforeLock: (() => void) | undefined;
    const ports: BrokerPhysicalLeasePorts<Timer> = {
        prepareDirectory: () => ({ ok: true, exists: true }), inspectDirectory: () => ({ ok: true, exists: true }),
        scan: () => ({ ok: true, entries: [...records.keys()].map(hardwareId => ({ hardwareId, file: hardwareId })) }),
        leaseFile: (_backend, hardwareId) => hardwareId,
        withHardwareLock: (_backend, _hardwareId, operation) => { beforeLock?.(); locked = true; try { return operation(); } finally { locked = false; } },
        read: file => { expect(locked).toBe(true); return records.get(file) || null; },
        write: (file, record) => { expect(locked).toBe(true); writes.push(record); records.set(file, record); return undefined; },
        remove: file => { expect(locked).toBe(true); removed.push(file); records.delete(file); return undefined; },
        fileExists: file => records.has(file), timestamp: () => new Date(clock).toISOString(), nowMs: () => clock, newClaimId: () => "new-claim",
        parse: produce => Date.parse(produce()), epoch: () => "1970-01-01T00:00:00.000Z", expiryFrom: (timestamp, ttl) => new Date(Date.parse(timestamp) + ttl).toISOString(),
        schedule: (callback, intervalMs) => { const handle: Timer = { callback, intervalMs, active: true, unreferenced: false }; timers.push(handle); return {handle}; },
        cancel: timer => { timer.active = false; cancelled.push(timer); return undefined; },
        unref: timer => { timer.unreferenced = true; return undefined; },
    };
    return { ports, records, writes, removed, cancelled, timers, advance: (ms: number) => { clock += ms; }, app: createBrokerPhysicalLeasesApplication(ports), onLock: (operation: () => void) => { beforeLock = operation; } };
}
function lease(overrides: PhysicalLeaseRecord = {}): PhysicalLeaseRecord {
    return { backend: "android-device", hardwareId: "phone", ownerId, deviceId: "device", claimId: "old-claim", claimNonce: "operation", claimedAt: now, heartbeatAt: now, updatedAt: now, expiresAt: "2026-10-10T13:00:00.000Z", ttlMs: 3600000, ...overrides };
}
const request = { backend: "android-device", hardwareId: "phone", deviceId: "device", claimId: "old-claim", claimNonce: "operation", ttlMs: 60000 };

describe("broker owner registration and resolution", () => {
    it("reuses an equivalent registration while retaining its canonical host path", () => {
        const f = ownerFixture();
        const first = f.app.register("/host/project");
        expect(first).toMatchObject({ ownerId, hostProjectPath: "/host/project", projectMountPath: "/project/fixture" });
        expect(f.app.register("/project/fixture", undefined, ownerId)).toBe(first);
        expect(f.read()).toBe(first);
        expect(f.published).toEqual([first]);
    });
    it("refuses an expected-owner mismatch without publishing registration or auth", () => {
        const f = ownerFixture();
        expect(() => f.app.register("/host/project", undefined, otherOwner)).toThrow("device-broker-owner-registration-mismatch");
        expect(f.published).toEqual([]);
        expect(f.secret()).toBeNull();
    });
    it("resolves the registered canonical profile and provisions its secret", () => {
        const f = ownerFixture();
        const registration = f.app.register("/host/project", "work", otherOwner);
        expect(f.app.validateRegistration(registration, otherOwner)).toBe(registration);
        expect(f.app.resolve({ projectMountPath: "/project/fixture", profile: "work" })).toMatchObject({ status: 200, payload: { ok: true, result: { ownerId: otherOwner, projectMountPath: "/project/fixture", profile: "work" } } });
        expect(f.secret()).toBe("a".repeat(64));
    });
    it("refuses an unregistered or inconsistent owner scope without provisioning a credential", () => {
        const f = ownerFixture();
        expect(f.app.resolve({ projectMountPath: "/project/fixture" })).toMatchObject({ status: 404, payload: { ok: false, error: "project-owner-unavailable" } });
        f.app.register("/host/project");
        f.setRegistration({ ...f.read()!, ownerBasis: "foreign-basis" });
        expect(f.app.resolve({ projectMountPath: "/project/fixture" })).toMatchObject({ status: 404, payload: { ok: false, error: "project-owner-unavailable" } });
        expect(f.secret()).toBeNull();
    });
    it("cleans quarantine after successful publication and reuses the published credential", () => {
        const f = ownerFixture();
        expect(f.app.secret(ownerId)).toBe("a".repeat(64));
        expect(f.quarantined()).toBe(false);
        f.ports.newSecret = () => { throw new Error("existing secret must be reused"); };
        expect(f.app.secret(ownerId)).toBe("a".repeat(64));
        expect(f.authLocked()).toBe(false);
    });
    it("retains invalid quarantine evidence on failed publication and releases the auth lock", () => {
        const f = ownerFixture(), fault = new Error("secret publication");
        f.ports.publishSecret = () => { throw fault; };
        let caught: unknown;
        try { f.app.secret(ownerId); } catch (error) { caught = error; }
        expect(caught).toBe(fault);
        expect(f.secret()).toBeNull();
        expect(f.quarantined()).toBe(true);
        expect(f.authLocked()).toBe(false);
    });
});

describe("broker physical lease mutations", () => {
    it("creates a claim, refreshes its heartbeat and releases only its owned record", () => {
        const f = leaseFixture();
        expect(f.app.claim(ownerId, { ...request, claimId: undefined })).toMatchObject({ kind: "claimed", created: true, lease: { claimId: "new-claim", deviceId: "device" } });
        expect(f.app.heartbeat(ownerId, { ...request, claimId: "new-claim" })).toMatchObject({ kind: "renewed", lease: { claimId: "new-claim", expiresAt: "2026-10-10T12:01:00.000Z" } });
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device", {ttlMs: 60000, claimId: "new-claim", claimNonce: "operation"});
        expect(f.app.release(ownerId, { ...request, claimId: "new-claim" })).toMatchObject({ kind: "released" });
        expect(f.records.has("phone")).toBe(false);
        expect(f.cancelled).toEqual([f.timers[0]]);
    });
    it("refuses a foreign owner before refreshing or releasing its lease", () => {
        const f = leaseFixture(), foreign = lease({ ownerId: otherOwner }); f.records.set("phone", foreign);
        expect(f.app.claim(ownerId, request)).toMatchObject({ kind: "conflict", error: "physical-lease-conflict" });
        expect(f.app.heartbeat(ownerId, request)).toMatchObject({ kind: "forbidden", error: "physical-lease-owned-by-another-owner" });
        expect(f.app.release(ownerId, request)).toMatchObject({ kind: "forbidden", error: "physical-lease-owned-by-another-owner" });
        expect(f.records.get("phone")).toBe(foreign);
        expect(f.writes).toEqual([]); expect(f.removed).toEqual([]); expect(f.cancelled).toEqual([]);
    });
    it("uses the same-hardware successor reread under the lock to reject a stale release", () => {
        const f = leaseFixture(); f.records.set("phone", lease());
        const successor = lease({ claimId: "successor-claim", claimNonce: "successor-operation" });
        f.onLock(() => { f.records.set("phone", successor); });
        expect(f.app.release(ownerId, request)).toMatchObject({ kind: "conflict", error: "physical-lease-claim-mismatch" });
        expect(f.records.get("phone")).toBe(successor);
        expect(f.removed).toEqual([]); expect(f.cancelled).toEqual([]);
    });
    it("replaces expired claims with a new generation and preserves requested connection metadata", () => {
        const f = leaseFixture(); f.records.set("phone", lease({ expiresAt: "2000-01-01T00:00:00.000Z" }));
        expect(f.app.claim(ownerId, { ...request, claimNonce: "replacement", connection: "wifi", transport: { host: "example", port: 5555 } })).toMatchObject({ kind: "claimed", created: true, lease: { claimId: "new-claim", claimNonce: "replacement", connection: "wifi", transport: { host: "example", port: 5555 } } });
    });
    it("passes the heartbeat deadline to the native lock and makes no mutation after lock refusal", () => {
        const f = leaseFixture(), fault = new Error("lease lock deadline"), budget: LeaseWaitBudget = { remaining: () => 0 };
        f.records.set("phone", lease());
        f.ports.withHardwareLock = (_backend, _hardware, _operation, received) => { expect(received).toBe(budget); throw fault; };
        expect(() => f.app.heartbeat(ownerId, request, budget)).toThrow(fault);
        expect(f.writes).toEqual([]); expect(f.removed).toEqual([]); expect(f.cancelled).toEqual([]);
    });
    it("does not attest expiry removal or cancel heartbeat when native removal fails", () => {
        const f = leaseFixture(), expired = lease({ expiresAt: "2000-01-01T00:00:00.000Z" }), fault = new Error("remove denied");
        f.records.set("phone", expired); f.ports.remove = () => { throw fault; };
        expect(f.app.heartbeat(ownerId, request)).toMatchObject({ kind: "expired", error: "physical-lease-expired", pruned: false });
        expect(f.records.get("phone")).toBe(expired);
        expect(() => f.app.release(ownerId, request)).toThrow(fault);
        expect(f.cancelled).toEqual([]);
    });
    it("reports only successful prune removals and leaves a failed record retryable", () => {
        const f = leaseFixture();
        f.records.set("first", lease({ hardwareId: "first", expiresAt: "2000-01-01T00:00:00.000Z" }));
        const denied = lease({ hardwareId: "second", expiresAt: "2000-01-01T00:00:00.000Z" }); f.records.set("second", denied);
        const remove = f.ports.remove;
        f.ports.remove = file => { if (file === "second") throw new Error("second removal"); return remove(file); };
        expect(f.app.prune(ownerId, { backend: "android-device" })).toMatchObject({ kind: "pruned", leases: [{ hardwareId: "first", expired: true }] });
        expect(f.records.has("first")).toBe(false); expect(f.records.get("second")).toBe(denied);
    });
    it("preserves prior prune effects when a later hardware lock fails", () => {
        const f = leaseFixture(), fault = new Error("later lock");
        for (const hardwareId of ["first", "second"]) f.records.set(hardwareId, lease({ hardwareId, expiresAt: "2000-01-01T00:00:00.000Z" }));
        const nativeLock = f.ports.withHardwareLock;
        f.ports.withHardwareLock = (backend, hardware, operation, budget) => { if (hardware === "second") throw fault; return nativeLock(backend, hardware, operation, budget); };
        expect(() => f.app.prune(ownerId, { backend: "android-device" })).toThrow(fault);
        expect(f.records.has("first")).toBe(false); expect(f.records.has("second")).toBe(true);
    });
});


describe("broker managed physical lease renewal", () => {
    it("does not allocate timers for construction, claims or RPC heartbeat", () => {
        const f = leaseFixture();
        f.app.claim(ownerId, {...request, claimId: undefined});
        f.app.heartbeat(ownerId, {...request, claimId: "new-claim"});
        expect(f.timers).toEqual([]);
    });
    it("uses the default TTL and cap, and refreshes the owned lease on its callback", () => {
        const f = leaseFixture(); f.records.set("phone", lease());
        expect(f.app.startHeartbeat(ownerId, request.backend, "phone", "device", {claimId: "old-claim", claimNonce: "operation"})).toEqual({ttlMs: 3600000, intervalMs: 300000});
        expect(f.timers[0].unreferenced).toBe(true);
        f.advance(300000); f.timers[0].callback();
        expect(f.records.get("phone")).toMatchObject({ownerId, claimId: "old-claim", claimNonce: "operation", heartbeatAt: "2026-10-10T12:05:00.000Z", expiresAt: "2026-10-10T13:05:00.000Z"});
        expect(f.timers[0].active).toBe(true);
    });
    it("uses custom TTL and the ten-second floor", () => {
        const f = leaseFixture(); f.records.set("phone", lease());
        expect(f.app.startHeartbeat(ownerId, request.backend, "phone", "device", {ttlMs: 30000})).toEqual({ttlMs: 30000, intervalMs: 10000});
        f.advance(10000); f.timers[0].callback();
        expect(f.records.get("phone")).toMatchObject({ttlMs: 30000, expiresAt: "2026-10-10T12:00:40.000Z"});
    });
    it("replaces only the same composite key and stops all independent timers", () => {
        const f = leaseFixture();
        f.app.startHeartbeat(ownerId, "android-device", "phone", "device");
        f.app.startHeartbeat(ownerId, "android-device", "phone", "device");
        f.app.startHeartbeat(otherOwner, "android-device", "phone", "device");
        f.app.startHeartbeat(ownerId, "ios-device", "phone", "device");
        f.app.startHeartbeat(ownerId, "android-device", "second", "device");
        f.app.startHeartbeat(ownerId, "android-device", "phone", "second");
        expect(f.timers.map(timer => timer.active)).toEqual([false, true, true, true, true, true]);
        f.app.stopAllHeartbeats();
        expect(f.timers.every(timer => !timer.active)).toBe(true);
        expect(f.app.stopHeartbeat(ownerId, "android-device", "phone", "device")).toBe(false);
    });
    it.each<[string, PhysicalLeaseRecord | null]>([
        ["missing", null],
        ["foreign", lease({ownerId: otherOwner})],
        ["device", lease({deviceId: "successor"})],
        ["claim", lease({claimId: "successor"})],
        ["nonce", lease({claimNonce: "successor"})],
    ])("stops a %s renewal without publishing or removing a conflicting lease", (_name, record) => {
        const f = leaseFixture(); if (record) f.records.set("phone", record);
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device", {ttlMs: 60000, claimId: "old-claim", claimNonce: "operation"});
        f.timers[0].callback();
        expect(f.timers[0].active).toBe(false);
        expect(f.writes).toEqual([]); expect(f.removed).toEqual([]);
        expect(f.records.get("phone")).toBe(record || undefined);
    });
    it("leaves pruned timer cancellation to the next failed renewal", () => {
        const f = leaseFixture(); f.records.set("phone", lease({expiresAt: "2000-01-01T00:00:00.000Z"}));
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device");
        f.app.prune(ownerId, {backend: request.backend});
        expect(f.records.has("phone")).toBe(false); expect(f.timers[0].active).toBe(true);
        f.timers[0].callback(); expect(f.timers[0].active).toBe(false);
    });
    it("cancels expired renewal even when guarded prune cannot remove the record", () => {
        const f = leaseFixture(), expired = lease({expiresAt: "2000-01-01T00:00:00.000Z"}); f.records.set("phone", expired);
        f.ports.remove = () => { throw new Error("native removal"); };
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device", {claimId: "old-claim", claimNonce: "operation"});
        f.timers[0].callback();
        expect(f.records.get("phone")).toBe(expired); expect(f.timers[0].active).toBe(false);
    });
    it("retains renewal after failed release and restarts it after successful restoration", () => {
        const f = leaseFixture(), original = lease(), fault = new Error("native removal"); f.records.set("phone", original);
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device", {claimId: "old-claim", claimNonce: "operation"});
        const remove = f.ports.remove; f.ports.remove = () => { throw fault; };
        expect(() => f.app.release(ownerId, request)).toThrow(fault); expect(f.timers[0].active).toBe(true);
        f.ports.remove = remove; f.app.release(ownerId, request); expect(f.timers[0].active).toBe(false);
        const parsed = validateLeaseParams(request, "release"); if (!parsed.ok) throw new Error("invalid fixture");
        f.ports.withHardwareLock(request.backend, "phone", () => {
            expect(f.app.restoreReleased(ownerId, parsed, "phone", original)).toMatchObject({attempted: true, ok: true, heartbeat: {ttlMs: 3600000, intervalMs: 300000}});
        });
        expect(f.timers[1].active).toBe(true); f.timers[1].callback();
        expect(f.records.get("phone")).toMatchObject({claimId: "old-claim", claimNonce: "operation"});
    });
    it("propagates callback faults while retaining the registered renewal", () => {
        const f = leaseFixture(), fault = new Error("native read");
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device");
        f.ports.read = () => { throw fault; };
        expect(() => f.timers[0].callback()).toThrow(fault); expect(f.timers[0].active).toBe(true);
        expect(f.app.stopHeartbeat(ownerId, request.backend, "phone", "device")).toBe(true);
    });
    it("retains registration when cancellation fails and permits a later retry", () => {
        const f = leaseFixture(), fault = new Error("cancel denied");
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device");
        const cancel = f.ports.cancel; f.ports.cancel = () => { throw fault; };
        expect(() => f.app.stopHeartbeat(ownerId, request.backend, "phone", "device")).toThrow(fault);
        expect(f.timers[0].active).toBe(true);
        f.ports.cancel = cancel;
        expect(f.app.stopHeartbeat(ownerId, request.backend, "phone", "device")).toBe(true);
    });
    it("preserves replacement cancellation before a failed new allocation", () => {
        const f = leaseFixture(), fault = new Error("schedule denied");
        f.app.startHeartbeat(ownerId, request.backend, "phone", "device");
        f.ports.schedule = () => { throw fault; };
        expect(() => f.app.startHeartbeat(ownerId, request.backend, "phone", "device")).toThrow(fault);
        expect(f.timers[0].active).toBe(false);
        expect(f.app.stopHeartbeat(ownerId, request.backend, "phone", "device")).toBe(false);
    });
    it("propagates unref failure without claiming an allocated timer was registered", () => {
        const f = leaseFixture(), fault = new Error("unref denied");
        f.ports.unref = () => { throw fault; };
        expect(() => f.app.startHeartbeat(ownerId, request.backend, "phone", "device")).toThrow(fault);
        expect(f.timers[0].active).toBe(true);
        expect(f.app.stopHeartbeat(ownerId, request.backend, "phone", "device")).toBe(false);
    });
});
