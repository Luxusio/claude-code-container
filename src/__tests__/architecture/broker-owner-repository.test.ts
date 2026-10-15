import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { createBrokerOwnerRepository } from "@ccc/device-lab/device-lab/application/broker-owner-repository.js";
import type { BrokerOwnerRepositoryPorts } from "@ccc/device-lab/device-lab/ports/broker-owner-repository.js";

function repository(initial: unknown[] = []) {
    let stored = structuredClone(initial);
    let published: unknown[] | undefined;
    const ports: BrokerOwnerRepositoryPorts = {
        withLock: (_owner, _state, operation) => operation(), read: () => stored,
        validate: () => undefined,
        publish: (_owner, _state, devices) => { published = structuredClone(devices); stored = published; return undefined; },
        equal: isDeepStrictEqual, timestamp: () => "repository-time",
    };
    return { ports, app: createBrokerOwnerRepository(ports), stored: () => stored, published: () => published };
}

describe("broker owner repository publication", () => {
    it("refuses an expired claim after acquiring the inventory lock without publishing", () => {
        const existing = { id: "retained", revision: 1 }, claimed = { id: "new", vmId: "owned-vm" };
        const f = repository([existing]);
        let now = 17.25, locked = false, qualified = false;
        const deadline = now + 5000, expired = new Error("hyper-v-operation-deadline-exceeded");
        const read = f.ports.read;
        f.ports.withLock = (_owner, _state, operation) => {
            locked = true; now = deadline + 0.25;
            try { return operation(); } finally { locked = false; }
        };
        f.ports.read = (...args) => { expect(locked).toBe(true); qualified = true; return read(...args); };
        const beforePublish = vi.fn(() => {
            expect(locked).toBe(true); expect(qualified).toBe(true);
            if (now >= deadline) throw expired;
            return undefined;
        });

        expect(() => f.app.claim("owner", "windows-vm", claimed, ["id", "vmId"], beforePublish)).toThrow(expired);
        expect(beforePublish).toHaveBeenCalledOnce();
        expect(f.published()).toBeUndefined();
        expect(f.stored()).toEqual([existing]);
    });

    it.each(["id", "vmId"])("qualifies a claim %s conflict before consulting the optional publication guard", field => {
        const existing = { id: "owned", vmId: "original-vm" };
        const claimed = { id: field === "id" ? existing.id : "new", vmId: field === "vmId" ? existing.vmId : "new-vm" };
        const f = repository([existing]);
        const beforePublish = vi.fn((): undefined => { throw new Error("guard must not supersede an identity conflict"); });
        expect(f.app.claim("owner", "windows-vm", claimed, ["id", "vmId"], beforePublish)).toMatchObject({
            ok: false, field, existing,
        });
        expect(beforePublish).not.toHaveBeenCalled();
        expect(f.published()).toBeUndefined();
        expect(f.stored()).toEqual([existing]);
    });

    it("publishes an unchanged owner list, including an empty list", () => {
        const empty = repository();
        expect(empty.app.mutate("owner", "android", devices => devices)).toEqual([]);
        expect(empty.published()).toEqual([]);
        const current = repository([{ id: "one", name: "retained" }]);
        current.app.mutate("owner", "android", devices => devices);
        expect(current.published()).toEqual([{ id: "one", name: "retained" }]);
    });

    it("rejects duplicate IDs before publishing a mutation", () => {
        const f = repository([{ id: "one" }]);
        expect(() => f.app.mutate("owner", "android", devices => [...devices, { id: "one" }])).toThrow("owner-device-id-conflict:one");
        expect(f.published()).toBeUndefined();
        expect(f.stored()).toEqual([{ id: "one" }]);
    });

    it.each(["read", "update", "validate", "publish"] as const)("propagates a %s failure without manufacturing a result", phase => {
        const f = repository([{ id: "one" }]), fault = new Error(`${phase} failed`);
        const fail = () => { throw fault; };
        if (phase === "read") f.ports.read = fail;
        if (phase === "validate") f.ports.validate = fail;
        if (phase === "publish") f.ports.publish = fail;
        let observed: unknown;
        try { f.app.mutate("owner", "android", phase === "update" ? fail : devices => devices); }
        catch (error) { observed = error; }
        expect(observed).toBe(fault);
        expect(f.published()).toBeUndefined();
    });

    it("does not publish lifecycle missing-record or full-record successor conflicts", () => {
        const successor = { id: "one", createdAt: "new", status: "running" };
        const f = repository([successor]);
        expect(f.app.transitionLifecycle("owner", "android", "absent", {}, () => null)).toEqual({ found: false, matched: false, device: null });
        expect(f.app.transitionLifecycle("owner", "android", "one", { ...successor, createdAt: "old" }, () => null)).toEqual({ found: true, matched: false, device: successor });
        expect(f.published()).toBeUndefined();
    });

    it("removes the captured lifecycle record while retaining unrelated devices", () => {
        const captured = { id: "one", createdAt: "old" }, foreign = { id: "other", status: "running" };
        const f = repository([foreign, captured]);
        expect(f.app.transitionLifecycle("owner", "android", "one", captured, () => null)).toEqual({ found: true, matched: true, device: null });
        expect(f.stored()).toEqual([foreign]);
    });

    it("distinguishes ID and compound identity claims and skips incomplete selectors", () => {
        const existing = { id: "one", provider: "tart", instance: "owned" };
        const f = repository([existing]);
        expect(f.app.claim("owner", "macos", { ...existing }, ["id"])).toMatchObject({ ok: false, error: "owner-device-id-conflict", field: "id", value: "one", existing });
        expect(f.app.claim("owner", "macos", { ...existing, id: "two" }, [["provider", "instance"]])).toMatchObject({ ok: false, error: "owner-device-identity-conflict", field: "provider+instance", value: { provider: "tart", instance: "owned" }, existing });
        expect(f.published()).toBeUndefined();
        const incomplete = { id: "two", provider: "tart", instance: null };
        expect(f.app.claim("owner", "macos", incomplete, ["id", ["provider", "instance"]])).toEqual({ ok: true, device: incomplete });
        expect(f.stored()).toEqual([existing, incomplete]);
    });

    it("reattaches exactly one matching detached physical record and refuses ambiguous ownership", () => {
        const detached = { id: "phone", serial: "serial", status: "detached" };
        const replacement = { ...detached, status: "attached", leaseClaimId: "new-claim" };
        const fresh = repository();
        expect(fresh.app.claimOrReattachPhysical("owner", "android-device", replacement, "serial")).toEqual({ ok: true, device: replacement, reattached: false });
        expect(fresh.stored()).toEqual([replacement]);
        const f = repository([detached, { id: "other", serial: "other" }]);
        expect(f.app.claimOrReattachPhysical("owner", "android-device", replacement, "serial")).toEqual({ ok: true, device: replacement, reattached: true });
        expect(f.stored()).toEqual([replacement, { id: "other", serial: "other" }]);
        const ambiguous = repository([detached, { id: "another", serial: "serial", status: "detached" }]);
        expect(ambiguous.app.claimOrReattachPhysical("owner", "android-device", replacement, "serial")).toMatchObject({ ok: false, error: "owner-device-already-attached" });
        expect(ambiguous.published()).toBeUndefined();
    });

    it("publishes unchanged snapshot conflicts while returning the current successor", () => {
        const successor = { id: "one", incarnationId: "new" };
        const f = repository([successor]);
        expect(f.app.transitionSnapshot("owner", "windows-vm", "one", { id: "one", incarnationId: "old" }, { id: "one" })).toEqual({ found: true, matched: false, device: successor });
        expect(f.published()).toEqual([successor]);
        const replacement = { ...successor, activeSnapshotId: "checkpoint" };
        expect(f.app.transitionSnapshot("owner", "windows-vm", "one", successor, replacement)).toEqual({ found: true, matched: true, device: replacement });
        expect(f.stored()).toEqual([replacement]);
    });

    it("publishes missing snapshot and runtime transitions with their distinct empty carriers", () => {
        const f = repository();
        expect(f.app.transitionSnapshot("owner", "windows-vm", "absent", {}, {})).toEqual({ found: false, matched: false, device: null });
        expect(f.published()).toEqual([]);
        const recording = repository();
        expect(recording.app.transitionRecording("owner", "android", "absent", null, null, { stateKey: "android", backend: "android-emulator", device: { id: "absent", backend: "android-emulator" } })).toEqual({ found: false, matched: false, currentRecording: null, device: null });
        expect(recording.published()).toEqual([]);
        const appium = repository();
        expect(appium.app.transitionAppium("owner", "android", "absent", null, null)).toEqual({ found: false, matched: false, currentAppium: null, device: null });
        expect(appium.published()).toEqual([]);
    });

    it("preserves current runtime generations on mismatches while still publishing the unchanged list", () => {
        const recording = { runtimeId: "new-recording" }, appium = { runtimeId: "new-appium" };
        const f = repository([{ id: "one", recording, appium, name: "current" }]);
        expect(f.app.transitionRecording("owner", "android", "one", { runtimeId: "old" }, null, { stateKey: "android", backend: "android-emulator", device: { id: "one", recording, appium, name: "current" } })).toEqual({ found: true, matched: false, currentRecording: recording, device: null });
        expect(f.published()).toEqual([{ id: "one", recording, appium, name: "current" }]);
        const appiumRepository = repository([{ id: "one", recording, appium, name: "current" }]);
        expect(appiumRepository.app.transitionAppium("owner", "android", "one", { runtimeId: "old" }, null)).toEqual({ found: true, matched: false, currentAppium: appium, device: null });
        expect(appiumRepository.published()).toEqual([{ id: "one", recording, appium, name: "current" }]);
    });

    it("updates matching runtimes without losing unrelated current fields and honors Appium's timestamp", () => {
        const recording = { runtimeId: "recording" }, appium = { runtimeId: "appium" };
        const f = repository([{ id: "one", recording, appium, name: "current", custom: 42 }]);
        f.app.transitionRecording("owner", "android", "one", recording, null, { stateKey: "android", backend: "android-emulator", device: { id: "one", recording, appium, name: "current", custom: 42 } });
        expect(f.stored()).toEqual([{ id: "one", recording: null, appium, name: "current", custom: 42, updatedAt: "repository-time" }]);
        const replacement = { runtimeId: "next", port: 4723, updatedAt: "runtime-time" };
        f.app.transitionAppium("owner", "android", "one", appium, replacement);
        expect(f.stored()).toEqual([{ id: "one", recording: null, appium: replacement, appiumPort: 4723, name: "current", custom: 42, updatedAt: "runtime-time" }]);
    });

    it.each([
        { incarnationId: "successor-device" }, { serial: "successor-serial" },
        { leaseClaimId: "successor-claim" }, { leaseClaimNonce: "successor-nonce" },
    ])("refuses an atomic copied-receipt publication against a replacement physical target: %j", changed => {
        const pending = { runtimeId: "recording", active: false, artifactCopyPending: true, stoppedAt: "verified-stop", remotePath: "/sdcard/video.mp4", localPath: "/private/video.mp4" };
        const captured = { id: "phone", backend: "android-device", serial: "serial", incarnationId: "captured-device", leaseClaimId: "claim", leaseClaimNonce: "nonce", status: "attached", recording: pending };
        const successor = { ...captured, ...changed }, unrelated = { id: "other", status: "running" };
        const f = repository([unrelated, successor]);
        let locked = false;
        const publish = f.ports.publish;
        f.ports.withLock = (_owner, _state, operation) => {
            locked = true;
            try { return operation(); } finally { locked = false; }
        };
        f.ports.read = () => { expect(locked).toBe(true); return [unrelated, successor]; };
        f.ports.publish = (...args) => { expect(locked).toBe(true); return publish(...args); };
        expect(f.app.transitionRecording("owner", "android-device", "phone", pending, { ...pending, artifactCopied: true }, {
            stateKey: "android-device", backend: "android-device", device: captured,
        })).toEqual({ found: true, matched: false, currentRecording: pending, device: null });
        expect(f.stored()).toEqual([unrelated, successor]);
        expect(f.published()).toEqual([unrelated, successor]);
    });

    it("merges snapshot repair into current fields with repository clock precedence", () => {
        const f = repository([{ id: "one", name: "current", custom: 42 }]);
        expect(f.app.mergeSnapshotRepair("owner", "windows-vm", "one", { id: "one", name: "old" }, { status: "stopped", updatedAt: "patch-time" })).toEqual({ id: "one", name: "current", custom: 42, status: "stopped", updatedAt: "repository-time" });
        expect(f.stored()).toEqual([{ id: "one", name: "current", custom: 42, status: "stopped", updatedAt: "repository-time" }]);
    });

    it("applies selected updates and replay merges without removing another device or a successor claim", () => {
        const f = repository([{ id: "one", createdAt: "new", name: "current" }, { id: "other" }]);
        f.app.updateDevice("owner", "android", "one", current => ({ ...current, sshReady: true }));
        f.app.replayPublish("owner", "android", "one", { status: "stopped" });
        f.app.removeMatchingClaim("owner", "android", "one", "old");
        expect(f.stored()).toEqual([{ id: "one", createdAt: "new", name: "current", sshReady: true, status: "stopped" }, { id: "other" }]);
        f.app.removeMatchingClaim("owner", "android", "one", "new");
        expect(f.stored()).toEqual([{ id: "other" }]);
        f.app.removeDevice("owner", "android", "other");
        expect(f.stored()).toEqual([]);
    });
});
