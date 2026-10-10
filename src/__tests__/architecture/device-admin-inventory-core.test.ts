import { describe, expect, it } from "vitest";
import { createDeviceAdminInventory } from "../../application/device-admin-inventory.js";
import { admitDeviceAdminInventoryCommand, classifyDeviceAdminTools, deviceAdminLabel } from "../../domain/device-admin-inventory.js";
import type { DeviceAdminBackend, DeviceAdminInventoryPorts, DeviceAdminRecord } from "../../ports/device-admin-inventory.js";

const backends: DeviceAdminBackend[] = [
    { stateKey: "android", name: "android-emulator", tools: ["adb", "emulator"] },
    { stateKey: "macos", name: "macos-vm", tools: ["tart", "vz"] },
    { stateKey: "empty", name: "empty-backend", tools: [] },
];
type Mode = { empty?: boolean; owners?: string[]; available?: string[]; fault?: "owner" | "enumeration" | "read" | "executable" | "label"; raw?: Error };
function fixture(mode: Mode = {}) {
    const trace: unknown[][] = [];
    const raw = mode.raw ?? new Error("raw-inventory");
    const devices: DeviceAdminRecord[] = [{ id: "z", name: "raw name", status: "running", platform: "linux", extra: "opaque" }, { id: "a" }];
    if (mode.fault === "label") Object.defineProperty(devices[0], "name", { get() { trace.push(["name:get"]); throw raw; } });
    const ports: DeviceAdminInventoryPorts = {
        backends: mode.empty ? [] : backends,
        resolveOwnerId(cwd, profile) { trace.push(["owner", cwd, profile]); if (mode.fault === "owner") throw raw; return "owner"; },
        enumerateOwnerIds() { trace.push(["enumerate"]); if (mode.fault === "enumeration") throw raw; return mode.owners ?? ["z-owner", "a-owner"]; },
        readDevices(owner, state) { trace.push(["read", owner, state]); if (mode.fault === "read") throw raw; return state === "android" ? devices : []; },
        commandPath(tool) { trace.push(["executable", tool]); if (mode.fault === "executable") throw raw; return (mode.available ?? ["adb", "vz"]).includes(tool) ? "/allocated/" + tool : null; },
    };
    return { ports, trace, raw, devices };
}

describe("Admin inventory inward policy current policy", () => {
    it("constructs without observations", () => {
        const f = fixture(); createDeviceAdminInventory(f.ports); expect(f.trace).toEqual([]);
    });
    it("reads records before individual executable observations and retains the raw device array", () => {
        const f = fixture(), snapshot = createDeviceAdminInventory(f.ports).snapshot("cwd");
        expect(f.trace).toEqual([["owner", "cwd", undefined], ["read", "owner", "android"], ["executable", "adb"], ["executable", "emulator"],
            ["read", "owner", "macos"], ["executable", "tart"], ["executable", "vz"], ["read", "owner", "empty"]]);
        expect(snapshot.backends[0].devices).toBe(f.devices);
        expect(snapshot.backends[0]).toMatchObject({ available: false, missing: ["emulator"] });
        expect(snapshot.backends[1]).toMatchObject({ available: true, missing: [] });
        expect(snapshot.backends[2]).toMatchObject({ available: true, missing: [] });
    });
    it("all-owner listing observes only enumeration and record reads in backend order", () => {
        const f = fixture(); const result = createDeviceAdminInventory(f.ports).allOwnersSnapshot();
        expect(result.owners.map(owner => owner.ownerId)).toEqual(["z-owner", "a-owner"]);
        expect(f.trace).toEqual([["enumerate"], ...["z-owner", "a-owner"].flatMap(owner => backends.map(b => ["read", owner, b.stateKey]))]);
    });
    it("propagates a native read failure", () => {
        const f = fixture({fault:"read"});
        expect(() => createDeviceAdminInventory(f.ports).snapshot("cwd")).toThrow(f.raw);
    });
    it("keeps the native macOS any-provider and other-backend all-prerequisite rule", () => {
        const tools = { tart: null, vz: "/allocated/vz" };
        expect(classifyDeviceAdminTools(backends[1], tools)).toEqual({ tools, available: true, missing: [] });
        expect(classifyDeviceAdminTools(backends[1], tools).tools).toBe(tools);
        expect(classifyDeviceAdminTools(backends[0], { adb: null, emulator: null })).toMatchObject({ available: false, missing: ["adb", "emulator"] });
        expect(classifyDeviceAdminTools(backends[2], {})).toMatchObject({ available: true, missing: [] });
    });
    it("formats current device labels", () => {
        expect(deviceAdminLabel(null)).toBe("(unknown)"); expect(deviceAdminLabel("raw")).toBe("(unknown)");
        expect(deviceAdminLabel({ id: "d", name: "raw", status: "running", platform: "linux" })).toBe("d  name=raw  status=running  platform=linux");
        expect(deviceAdminLabel({ id: "", name: "", status: "", platform: "" })).toBe("");
    });
    it.each([
        [[], "status"], [["status", "ignored"], "status"], [["list"], "list"], [["list", "--all-projects"], "all-projects"],
        [["list", "--all"], "invalid-list"], [["list", "--all-projects", "extra"], "invalid-list"], [["list", "--all-projects", "--all-projects"], "invalid-list"],
        [["backends"], null],
    ] as Array<[string[], "status" | "list" | "all-projects" | "invalid-list" | null]>)("keeps exact command admission %j", (args, admitted) => {
        expect(admitDeviceAdminInventoryCommand(args)).toBe(admitted);
        const f = fixture(), app = createDeviceAdminInventory(f.ports);
        const result = app.command(args, "cwd", "work");
        if (admitted === null) { expect(result).toBeNull(); expect(f.trace).toEqual([]); }
        else if (admitted === "invalid-list") { expect(result).toEqual({ ok: false, text: "Usage: ccc devices list [--all-projects]" }); expect(f.trace).toEqual([]); }
        else { expect(result?.ok).toBe(true); expect(typeof result?.text).toBe("string"); }
    });
});

