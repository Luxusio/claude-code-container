import { describe, expect, it } from "vitest";
import { createAndroidPreviewPortAllocation, createLifecyclePreview } from "@ccc/device-lab/device-lab/application/broker-observation-command-plan.js";
import { hyperVPreviewConflicts, type LifecyclePreviewRequest } from "@ccc/device-lab/device-lab/domain/broker-observation-command-plan.js";
import type { LifecyclePreviewPorts, ProviderPlanObservation } from "@ccc/device-lab/device-lab/ports/broker-observation.js";

type Allocation = { ok: true; port: number } | { ok: false; error: string };
function fixture(devices: unknown[] = []) {
    const trace: string[] = [];
    type Ports = LifecyclePreviewPorts<LifecyclePreviewRequest, object, unknown, unknown, ProviderPlanObservation, Allocation>;
    const ports: { -readonly [Key in keyof Ports]: Ports[Key] } = {
        read: () => { trace.push("read"); return devices; },
        hyperV: parsed => parsed.backend === "windows-vm" || parsed.backend === "linux-vm",
        validIncarnation: () => true, incarnation: () => "current", conflicts: () => [],
        androidPort: () => { trace.push("allocate"); return { ok: true, port: 5554 }; },
        createDefinition: (_owner, parsed) => { trace.push("define:" + parsed.create?.port); return { id: parsed.deviceId }; },
        assertWritable: produce => { trace.push("capacity"); produce(); },
        redactDevice: device => { trace.push("redact-device"); return device; },
        redactHyperVDevice: device => { trace.push("redact-hyper-device"); return device; },
        redactCreate: parsed => { trace.push("redact-create"); return parsed.create; },
        publicHyperVCreate: parsed => { trace.push("redact-hyper-create"); return parsed.create; },
        maskedHyperVPlan: () => { trace.push("mask"); return { mode: "masked", provider: "hyper-v" }; },
        createPlan: () => { trace.push("create-plan"); return { mode: "intent", provider: "synthetic" }; },
        existingPlan: () => { trace.push("existing-plan"); return { mode: "intent", provider: "synthetic" }; },
        attachmentMatches: () => { trace.push("attachment"); return true; },
    };
    const run = (extra: Partial<LifecyclePreviewRequest> = {}, context: object | undefined = {}, redact = true) => createLifecyclePreview(ports)("owner", {
        backend: "android-emulator", stateKey: "android", command: "device_create", deviceId: "device", force: false, dryRun: true, create: { name: "device" }, ...extra,
    }, context, redact);
    return { trace, ports, run };
}

describe("complete inward lifecycle preview", () => {
    it("allocates without reservation, checks capacity then discloses before native intent", () => {
        const f = fixture(); expect(f.run().kind).toBe("create");
        expect(f.trace).toEqual(["read", "allocate", "define:5554", "capacity", "redact-device", "redact-create", "create-plan"]);
    });
    it("withholds later observations after allocation or capacity failure", () => {
        const f = fixture(); f.ports.androidPort = () => ({ ok: false, error: "conflict" }); expect(f.run().kind).toBe("allocation-failed"); expect(f.trace).toEqual(["read"]);
        const g = fixture(); const sentinel = {}; g.ports.assertWritable = () => { throw sentinel; };
        expect(g.run()).toEqual({ kind: "state-failed", error: sentinel }); expect(g.trace).not.toContain("create-plan");
    });
    it("keeps disclosure errors outside the capacity catch and before provider queries", () => {
        const f = fixture(); const sentinel = {}; f.ports.redactDevice = () => { throw sentinel; };
        try { f.run(); throw new Error("unexpected success"); } catch (error) { expect(error).toBe(sentinel); }
        expect(f.trace).not.toContain("create-plan");
    });
    it("uses redaction mutations in the subsequent existing-device query", () => {
        const device = { id: "device", status: "before" }; const f = fixture([device]);
        f.ports.redactDevice = value => { (value as typeof device).status = "after"; return value; };
        f.ports.existingPlan = (_owner, _parsed, value) => { expect(value).toBe(device); expect(device.status).toBe("after"); return { mode: "intent", provider: "synthetic" }; };
        expect(f.run({ command: "device_status" }).kind).toBe("existing");
    });
    it("skips Hyper-V native encoders for redacted plans and keeps unnormalized plans deferred", () => {
        const f = fixture(); const result = f.run({ backend: "linux-vm", stateKey: "linux-vm" }); expect(result.kind).toBe("create");
        expect(f.trace.slice(-3)).toEqual(["redact-device", "redact-hyper-create", "mask"]); expect(f.trace).not.toContain("create-plan");
        const g = fixture(); const deferred = createLifecyclePreview(g.ports)("owner", { backend: "android-emulator", stateKey: "android", command: "device_create", deviceId: "device", force: false, dryRun: true, create: { name: "device" } }, undefined, true); if (deferred.kind !== "create") throw new Error("unexpected refusal");
        expect(deferred.value.providerPlan).toBeNull(); expect(deferred.value.providerAvailable).toBe(false); expect(g.trace).not.toContain("create-plan");
    });
    it("preserves native missing-provider evidence inside a successful plan", () => {
        const f = fixture([{ id: "device" }]); const evidence = { error: "missing-provider-metadata", missing: ["udid"] };
        f.ports.existingPlan = () => evidence; const result = f.run({ backend: "ios-simulator", stateKey: "ios", command: "device_stop" });
        if (result.kind !== "existing") throw new Error("unexpected refusal"); expect(result.value.providerPlan).toBe(evidence);
    });
    it("requires exact incarnation only for an existing Hyper-V mutation", () => {
        const f = fixture([{ id: "device" }]); f.ports.validIncarnation = () => false;
        expect(f.run({ backend: "linux-vm", command: "device_stop" }).kind).toBe("incarnation-required");
        f.ports.validIncarnation = () => true; expect(f.run({ backend: "linux-vm", command: "device_stop", expectedIncarnationId: "other" }).kind).toBe("incarnation-conflict");
        expect(f.run({ backend: "linux-vm", command: "device_status" }).kind).toBe("existing");
    });
    it("preserves create/missing-delete idempotency and non-Hyper-V existence refusal", () => {
        const f = fixture([{ id: "device" }]); expect(f.run().kind).toBe("already-exists"); expect(f.run({ backend: "linux-vm" }).kind).toBe("equivalent-create");
        f.ports.conflicts = () => ["cpus"]; expect(f.run({ backend: "linux-vm" })).toEqual({ kind: "configuration-conflict", conflicts: ["cpus"] });
        const g = fixture(); expect(g.run({ backend: "linux-vm", command: "device_delete" }).kind).toBe("missing-delete"); expect(g.run({ command: "device_status" }).kind).toBe("not-found");
    });
    it("checks physical attachment before the record-status refusal", () => {
        const f = fixture([{ id: "device", status: "detached" }]); expect(f.run({ backend: "android-device", stateKey: "android-device", command: "device_start" }).kind).toBe("not-attached"); expect(f.trace).toEqual(["read", "attachment"]);
    });
});

describe("shared deterministic Android preview allocation", () => {
    it("rejects invalid requests before reading state and picks the deterministic next free slot", () => {
        const trace: string[] = []; const used = new Set([5554]);
        const allocate = createAndroidPreviewPortAllocation({ valid: (port: unknown): port is number => typeof port === "number" && port % 2 === 0,
            allocated: () => { trace.push("read"); return used; }, inventoryError: () => "unavailable", seed: () => 0 }, 5554, 5558);
        const parsed = { backend: "android-emulator", stateKey: "android", command: "device_create", deviceId: "device", force: false, dryRun: true, create: { port: 1 } };
        expect(allocate("owner", parsed, [])).toEqual({ kind: "invalid" }); expect(trace).toEqual([]);
        expect(allocate("owner", { ...parsed, create: {} }, [5556])).toEqual({ kind: "allocated", port: 5558 }); expect(used.has(5556)).toBe(true);
        expect(allocate("owner", { ...parsed, create: { port: 5554 } }, [])).toEqual({ kind: "conflict", port: 5554 });
    });
    it("keeps exact ordered Hyper-V configuration comparisons", () => {
        const parsed = { backend: "linux-vm", stateKey: "linux-vm", command: "device_create", deviceId: "device", force: false, dryRun: true, create: { baseImageSha256: "ABC", sourceImage: "source" } };
        expect(hyperVPreviewConflicts({}, parsed, () => ({ generation: 2 }))).toEqual(["name", "profile", "memoryMb", "cpus", "networking", "generation", "baseImageSha256", "sourceImage"]);
    });
});
