import { describe, expect, it } from "vitest";
import { createFocusedInventory, createOwnerInventory } from "@ccc/device-lab/device-lab/application/broker-observation-inventory.js";
import type { OwnerInventoryPorts } from "@ccc/device-lab/device-lab/ports/broker-observation.js";

function fixture() {
    const trace: string[] = [];
    const devices = [{ id: "one" }, { id: "two" }, { id: "three" }];
    type Ports = OwnerInventoryPorts<string, { id: string }>;
    const ports: { -readonly [Key in keyof Ports]: Ports[Key] } = {
        root: () => { trace.push("root"); return "root"; },
        file: (_root, _owner, key) => { trace.push("file:" + key); return key; },
        exists: key => { trace.push("exists:" + key); return true; },
        stat: key => { trace.push("stat:" + key); return { size: 10 }; },
        read: key => { trace.push("read:" + key); return devices; },
        redact: device => { trace.push("redact:" + device.id); return device; },
        errorCode: () => { trace.push("classify"); return null; },
        ownerRoot: () => { trace.push("owner-root"); return "owner-root"; },
    };
    return { trace, devices, ports, read: (redact = false) => createOwnerInventory(ports, { stateKeys: ["first", "second"], maxBytes: 10, maxDevices: 2 })("owner", redact) };
}

describe("broker owner inventory inward policy", () => {
    it("reads exactly in key order, caps before optional redaction and preserves device references", () => {
        const f = fixture(); const inventory = f.read(true);
        expect(f.trace).toEqual(["root", "file:first", "exists:first", "stat:first", "read:first", "redact:one", "redact:two", "file:second", "exists:second", "stat:second", "read:second", "redact:one", "redact:two", "owner-root"]);
        expect(inventory.backends[0]).toMatchObject({ exists: true, truncated: true, totalDevices: 3, maxDevices: 2 });
        expect(inventory.backends[0].devices[0]).toBe(f.devices[0]); expect(inventory.backends[0].devices).not.toBe(f.devices);
    });
    it("does not read an oversized or missing file", () => {
        const f = fixture(); f.ports.stat = () => ({ size: 11 }); f.ports.exists = key => key === "first";
        expect(f.read().backends).toEqual([{ stateKey: "first", devices: [], exists: true, truncated: true, error: "inventory-file-too-large", maxBytes: 10, bytes: 11 }, { stateKey: "second", devices: [], exists: false }]);
        expect(f.trace.some(step => step.startsWith("read:"))).toBe(false);
    });
    it("classifies stat/read/redactor exceptions but leaves existence and classifier faults outside the catch", () => {
        for (const stage of ["stat", "read", "redact"] as const) {
            const f = fixture(); const failure = {}; f.ports[stage] = () => { throw failure; };
            expect(f.read(true).backends.map(entry => "error" in entry ? entry.error : null)).toEqual(["inventory-read-failed", "inventory-read-failed"]);
        }
        const f = fixture(); const failure = {}; f.ports.exists = () => { throw failure; };
        expect(() => f.read()).toThrow();
        f.ports.exists = () => true; f.ports.stat = () => { throw {}; }; f.ports.errorCode = () => { throw failure; };
        try { f.read(); throw new Error("unexpected success"); } catch (error) { expect(error).toBe(failure); }
    });
    it("observes an oversized stat size again for the returned byte count", () => {
        const f = fixture(); let reads = 0; f.ports.stat = () => ({ get size() { return ++reads === 1 ? 11 : 12; } });
        expect(f.read().backends[0]).toMatchObject({ bytes: 12 });
    });
});

describe("focused broker inventory ordering", () => {
    it.each(["android-device", "android-emulator", "ios-device", "linux-vm"])("queries only the selected native facet after the owner snapshot: %s", backend => {
        const f = fixture();
        const query = createFocusedInventory({
            inventory: () => { f.trace.push("snapshot"); return f.read(); },
            androidHost: () => { f.trace.push("adb"); return { devices: ["host"] }; },
            androidChoices: () => { f.trace.push("sdk"); return { choices: ["sdk"] }; },
            backend: entry => entry.stateKey,
        });
        const result = query("owner", { backend, stateKey: "first", tool: "device_inventory" }, {});
        expect(result.devices).toEqual(f.devices.slice(0, 2));
        expect(f.trace[0]).toBe("snapshot");
        expect(f.trace.filter(step => step === "adb" || step === "sdk")).toEqual(backend === "android-device" ? ["adb"] : backend === "android-emulator" ? ["sdk"] : []);
        expect(f.trace.indexOf("owner-root")).toBeLessThan(backend === "android-device" ? f.trace.indexOf("adb") : backend === "android-emulator" ? f.trace.indexOf("sdk") : f.trace.length);
    });
});
