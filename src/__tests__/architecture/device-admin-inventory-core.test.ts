import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import ts from "typescript";
import { createDeviceAdminInventory } from "../../application/device-admin-inventory.js";
import { admitDeviceAdminInventoryCommand, classifyDeviceAdminTools, deviceAdminLabel } from "../../domain/device-admin-inventory.js";
import type { DeviceAdminBackend, DeviceAdminInventoryPorts, DeviceAdminRecord } from "../../ports/device-admin-inventory.js";

// Verbatim selected original bodies from adopted720 src/device-lab-admin.ts,
// whole source SHA036c2b22...617a3. Only native import aliases are supplied by ports.
// This immutable oracle is independent of candidate policy and ignored Task files.
const ORIGINAL_CONTROL = "const DEVICE_BACKENDS=ports.backends,deviceLabOwnerId=ports.resolveOwnerId,readDevices=ports.readDevices,commandPath=ports.commandPath,allOwnerIds=ports.enumerateOwnerIds;\nfunction backendToolSnapshot(backend: Backend): BackendToolSnapshot {\n    const tools = Object.fromEntries(backend.tools.map((tool) => [tool, commandPath(tool)])) as Record<string, string | null>;\n    if (backend.name === \"macos-vm\") {\n        const providerAvailable = backend.tools.some((tool) => Boolean(tools[tool]));\n        return {\n            tools,\n            missing: providerAvailable ? [] : [...backend.tools],\n            available: providerAvailable,\n        };\n    }\n    const missing = backend.tools.filter((tool) => !tools[tool]);\n    return {\n        tools,\n        missing,\n        available: missing.length === 0,\n    };\n}\n\n\nfunction deviceLabSnapshot(cwd = process.cwd(), profile?: string) {\n    const ownerId = deviceLabOwnerId(cwd, profile);\n    const backends = DEVICE_BACKENDS.map((backend) => {\n        const devices = readDevices(ownerId, backend.stateKey);\n        const snapshot = backendToolSnapshot(backend);\n        return {\n            ...backend,\n            devices,\n            tools: snapshot.tools,\n            missing: snapshot.missing,\n            available: snapshot.available,\n        };\n    });\n    return { ownerId, backends };\n}\n\nfunction deviceLabAllOwnersSnapshot(): { owners: AdminOwnerSnapshot[] } {\n    const owners = allOwnerIds().map((ownerId) => ({\n        ownerId,\n        backends: DEVICE_BACKENDS.map((backend) => ({\n            stateKey: backend.stateKey,\n            name: backend.name,\n            devices: readDevices(ownerId, backend.stateKey),\n        })),\n    }));\n    return { owners };\n}\n\nfunction deviceLabel(device: unknown): string {\n    if (!device || typeof device !== \"object\") return \"(unknown)\";\n    const d = device as Record<string, unknown>;\n    return [\n        d.id,\n        d.name ? `name=${d.name}` : null,\n        d.status ? `status=${d.status}` : null,\n        d.platform ? `platform=${d.platform}` : null,\n    ].filter(Boolean).join(\"  \");\n}\n\n\nfunction formatDevicesStatus(cwd = process.cwd(), profile?: string): string {\n    const snapshot = deviceLabSnapshot(cwd, profile);\n    const lines = [\n        \"=== CCC Devices Status ===\",\n        \"\",\n        `owner: ${snapshot.ownerId}`,\n        \"\",\n        \"Backends:\",\n    ];\n    for (const backend of snapshot.backends) {\n        lines.push(`  ${backend.name}: ${backend.devices.length} device(s), ${backend.available ? \"available\" : `missing ${backend.missing.join(\", \")}`}`);\n    }\n    return `${lines.join(\"\\n\")}\\n`;\n}\n\nfunction formatDevicesList(cwd = process.cwd(), profile?: string): string {\n    const snapshot = deviceLabSnapshot(cwd, profile);\n    const lines = [\n        \"=== CCC Devices ===\",\n        \"\",\n        `owner: ${snapshot.ownerId}`,\n        \"\",\n    ];\n    for (const backend of snapshot.backends) {\n        lines.push(`${backend.name}:`);\n        if (backend.devices.length === 0) {\n            lines.push(\"  (none)\");\n        } else {\n            for (const device of backend.devices) lines.push(`  ${deviceLabel(device)}`);\n        }\n    }\n    return `${lines.join(\"\\n\")}\\n`;\n}\n\nfunction formatDevicesAllProjectsList(): string {\n    const snapshot = deviceLabAllOwnersSnapshot();\n    const lines = [\n        \"=== CCC Devices: All Projects ===\",\n        \"\",\n    ];\n    if (snapshot.owners.length === 0) {\n        lines.push(\"(none)\");\n        return `${lines.join(\"\\n\")}\\n`;\n    }\n    for (const owner of snapshot.owners) {\n        lines.push(`project: ${owner.ownerId}`);\n        for (const backend of owner.backends) {\n            lines.push(`${backend.name}:`);\n            if (backend.devices.length === 0) {\n                lines.push(\"  (none)\");\n            } else {\n                for (const device of backend.devices) lines.push(`  ${deviceLabel(device)}`);\n            }\n        }\n        lines.push(\"\");\n    }\n    return `${lines.join(\"\\n\").trimEnd()}\\n`;\n}\n\n\nreturn {snapshot:deviceLabSnapshot,allOwnersSnapshot:deviceLabAllOwnersSnapshot,formatStatus:formatDevicesStatus,formatList:formatDevicesList,formatAllProjectsList:formatDevicesAllProjectsList};";
const ORIGINAL_CONTROL_SHA = "8ed2f78aa7e5efca0ef1eaf7ab2f8a3b545708d165c1db5c1dbe9f49a37b4411";
type App = ReturnType<typeof createDeviceAdminInventory<DeviceAdminBackend>>;
function original(ports: DeviceAdminInventoryPorts): App {
    const code = ts.transpileModule("function captured(ports){" + ORIGINAL_CONTROL + "}", {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    return new Function("ports", code + ";return captured(ports);")(ports) as App;
}
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

describe("Admin inventory inward policy against immutable original bodies", () => {
    it("authenticates the historical control and constructs without observations", () => {
        expect(createHash("sha256").update(ORIGINAL_CONTROL).digest("hex")).toBe(ORIGINAL_CONTROL_SHA);
        const f = fixture(); createDeviceAdminInventory(f.ports); expect(f.trace).toEqual([]);
    });
    it.each(["snapshot", "allOwnersSnapshot", "formatStatus", "formatList", "formatAllProjectsList"] as const)(
        "preserves original %s values, ordering, owner selection and trailing newline", method => {
            const before = fixture(), after = fixture();
            const old = original(before.ports), current = createDeviceAdminInventory(after.ports);
            const a = method === "allOwnersSnapshot" || method === "formatAllProjectsList" ? old[method]() : old[method]("raw-cwd", "work");
            const b = method === "allOwnersSnapshot" || method === "formatAllProjectsList" ? current[method]() : current[method]("raw-cwd", "work");
            expect(b).toEqual(a); expect(after.trace).toEqual(before.trace);
            if (typeof b === "string") { expect(b.endsWith("\n")).toBe(true); expect(b.endsWith("\n\n")).toBe(false); }
        },
    );
    it("reads records before individual executable observations and retains the raw device array", () => {
        const f = fixture(), snapshot = createDeviceAdminInventory(f.ports).snapshot("cwd");
        expect(f.trace).toEqual([["owner", "cwd", undefined], ["read", "owner", "android"], ["executable", "adb"], ["executable", "emulator"],
            ["read", "owner", "macos"], ["executable", "tart"], ["executable", "vz"], ["read", "owner", "empty"]]);
        expect(snapshot.backends[0].devices).toBe(f.devices);
        expect(snapshot.backends[0]).toMatchObject({ available: false, missing: ["emulator"] });
        expect(snapshot.backends[1]).toMatchObject({ available: true, missing: [] });
        expect(snapshot.backends[2]).toMatchObject({ available: true, missing: [] });
    });
    it("all-owner listing observes only enumeration and record reads in their original order", () => {
        const f = fixture(); const result = createDeviceAdminInventory(f.ports).allOwnersSnapshot();
        expect(result.owners.map(owner => owner.ownerId)).toEqual(["z-owner", "a-owner"]);
        expect(f.trace).toEqual([["enumerate"], ...["z-owner", "a-owner"].flatMap(owner => backends.map(b => ["read", owner, b.stateKey]))]);
    });
    it.each(["formatStatus", "formatList", "formatAllProjectsList"] as const)("keeps empty %s text", method => {
        const a = fixture({ empty: true, owners: [] }), b = fixture({ empty: true, owners: [] });
        const before = original(a.ports), after = createDeviceAdminInventory(b.ports);
        expect(method === "formatAllProjectsList" ? after[method]() : after[method]("cwd")).toBe(method === "formatAllProjectsList" ? before[method]() : before[method]("cwd"));
        expect(b.trace).toEqual(a.trace);
    });
    it.each(["owner", "enumeration", "read", "executable", "label"] as const)("preserves raw %s faults and the completed observation prefix", fault => {
        const raw = new Error("raw-" + fault), a = fixture({ fault, raw }), b = fixture({ fault, raw });
        const method = fault === "enumeration" ? "formatAllProjectsList" : "formatList";
        for (const app of [original(a.ports), createDeviceAdminInventory(b.ports)]) {
            let error: unknown; try { method === "formatAllProjectsList" ? app[method]() : app[method]("cwd", "work"); } catch (e) { error = e; }
            expect(error).toBe(raw);
        }
        expect(b.trace).toEqual(a.trace);
    });
    it("keeps the native macOS any-provider and other-backend all-prerequisite rule", () => {
        const tools = { tart: null, vz: "/allocated/vz" };
        expect(classifyDeviceAdminTools(backends[1], tools)).toEqual({ tools, available: true, missing: [] });
        expect(classifyDeviceAdminTools(backends[1], tools).tools).toBe(tools);
        expect(classifyDeviceAdminTools(backends[0], { adb: null, emulator: null })).toMatchObject({ available: false, missing: ["adb", "emulator"] });
        expect(classifyDeviceAdminTools(backends[2], {})).toMatchObject({ available: true, missing: [] });
    });
    it("preserves label truthiness, raw field evaluation and the original field order", () => {
        expect(deviceAdminLabel(null)).toBe("(unknown)"); expect(deviceAdminLabel("raw")).toBe("(unknown)");
        expect(deviceAdminLabel({ id: "d", name: "raw", status: "running", platform: "linux" })).toBe("d  name=raw  status=running  platform=linux");
        expect(deviceAdminLabel({ id: "", name: "", status: "", platform: "" })).toBe("");
        const trace: string[] = []; const record = Object.fromEntries([]) as Record<string, unknown>;
        for (const name of ["id", "name", "status", "platform"]) Object.defineProperty(record, name, { get() { trace.push(name); return name; } });
        expect(deviceAdminLabel(record)).toBe("id  name=name  status=status  platform=platform");
        expect(trace).toEqual(["id", "name", "name", "status", "status", "platform", "platform"]);
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
        else {
            const old = original(fixture().ports);
            expect(result).toEqual({ ok: true, text: admitted === "status" ? old.formatStatus("cwd", "work") : admitted === "list" ? old.formatList("cwd", "work") : old.formatAllProjectsList() });
        }
    });
    it("uses an already admitted command without re-reading argument getters", () => {
        const args = new Proxy(["list"], { get(_target, key) { if (key === "0") throw new Error("argument re-read"); return Reflect.get(_target, key); } });
        const f = fixture(); expect(createDeviceAdminInventory(f.ports).command(args, "cwd", undefined, "list")?.ok).toBe(true);
    });
});

