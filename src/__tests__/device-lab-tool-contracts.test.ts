import { describe, expect, it } from "vitest";
import {
    DEVICE_LAB_OUTPUT_CONTRACTS,
    hasDeviceLabOutputContract,
    validateDeviceLabToolOutput,
} from "../../device-lab-mcp/src/contracts/tool-contracts.mjs";
import { TOOLS } from "../../device-lab-mcp/src/tools.mjs";

describe("canonical public input schemas", () => {
    it("exposes only unique action names with explicit targets", () => {
        const names = TOOLS.map(tool => tool.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names.every(name => !/^(device|mobile|display)_/.test(name))).toBe(true);
        for (const name of ["click", "move", "type", "key", "screenshot", "status"]) {
            expect(TOOLS.find(tool => tool.name === name)?.inputSchema.required).toContain("deviceId");
        }
    });
    it.each(["create_windows_vm", "create_linux_vm", "create_macos_vm"])("%s issues identity at creation instead of advertising a chosen ID", name => {
        const schema = TOOLS.find(tool => tool.name === name)!.inputSchema;
        expect(schema.properties).not.toHaveProperty("deviceId");
        expect(schema.required).toEqual(["name"]);
    });
    it("keeps explicit IDs for non-VM creation and removes public generation selectors", () => {
        for (const name of ["create_android_emulator", "create_ios_simulator", "create_windows_sandbox"]) {
            expect(TOOLS.find(tool => tool.name === name)!.inputSchema.properties).toHaveProperty("deviceId");
        }
        for (const tool of TOOLS) {
            expect(tool.inputSchema.properties, tool.name).not.toHaveProperty("incarnationId");
            expect(tool.description, tool.name).not.toContain("incarnationId");
        }
    });
});

describe("device-lab public output contracts", () => {
    it.each([
        ["devices", [{}], {}],
        ["cursor_position", { x: "bad", y: null }, {}],
        ["wait_for_text", {}, {}],
        ["wait_for_app", { matched: true, running: false }, {}],
        ["record_video", {}, { action: "stop" }],
        ["record_video", { recording: {} }, { action: "status" }],
        ["list_files", { entries: [{ nonsense: true }] }, {}],
        ["screenshot", { isError: true, content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }, {}],
        ["screenshot", { content: [{ type: "image" }] }, {}],
        ["status", { id: "display", kind: "display", ok: false }, {}],
    ])("rejects unusable %s observations", (tool, payload, args) => {
        expect(() => validateDeviceLabToolOutput(tool as keyof typeof DEVICE_LAB_OUTPUT_CONTRACTS, payload, args as Record<string, unknown>)).toThrow("response contract violation");
    });

    it.each([
        ["devices", [{ deviceId: "phone", backend: "android-device" }], {}],
        ["devices", [], {}],
        ["cursor_position", { x: 0, y: -2 }, {}],
        ["cursor_position", { cursor: { x: 0, y: -2 }, provider: "windows-helper" }, { detail: true }],
        ["wait_for_text", { matched: false, found: false, reason: "wait-condition-not-met" }, {}],
        ["wait_for_app", { running: true }, {}],
        ["record_video", { recording: null }, { action: "status" }],
        ["record_video", { stopped: false }, { action: "stop" }],
        ["record_video", { recording: { active: false, localPath: "/movie.mp4" } }, { action: "stop" }],
        ["list_files", { entries: [{ name: "file", type: "file", size: 0 }], truncated: false }, {}],
        ["screenshot", { content: [{ type: "image", data: "AA==", mimeType: "image/png" }] }, {}],
    ])("accepts useful %s observations", (tool, payload, args) => {
        expect(validateDeviceLabToolOutput(tool as keyof typeof DEVICE_LAB_OUTPUT_CONTRACTS, payload, args as Record<string, unknown>)).toEqual(payload);
    });
    it("maps lifecycle and mobile session tools to explicit contracts", () => {
        expect(DEVICE_LAB_OUTPUT_CONTRACTS).toEqual(expect.objectContaining({
            create_android_emulator: "lifecycle-device-v1",
            create_ios_simulator: "lifecycle-device-v1",
            create_linux_vm: "lifecycle-device-v1",
            create_macos_vm: "create_macos_vm-group-v1",
            create_windows_sandbox: "lifecycle-device-v1",
            create_windows_vm: "lifecycle-device-v1",
            status: "lifecycle-device-v1",
            start: "lifecycle-device-v1",
            stop: "lifecycle-device-v1",
            delete: "lifecycle-delete-v1",
            snapshot: "snapshot-group-v1",
        }));
        expect(hasDeviceLabOutputContract("start")).toBe(true);
        expect(hasDeviceLabOutputContract("click")).toBe(true);
        expect(hasDeviceLabOutputContract("not_a_public_tool")).toBe(false);
        expect(hasDeviceLabOutputContract("create")).toBe(false);
        expect(hasDeviceLabOutputContract("device_create")).toBe(false);
    });

    it("validates both UI forms and rejects arbitrary empty data", () => {
        expect(validateDeviceLabToolOutput("ui", { source: "<hierarchy/>" })).toEqual({ source: "<hierarchy/>" });
        const desktop = { accessibility: { root: { name: "Desktop" }, nodeCount: 1 } };
        expect(validateDeviceLabToolOutput("ui", desktop)).toEqual(desktop);
        expect(() => validateDeviceLabToolOutput("ui", {})).toThrow("required mobile source or desktop accessibility tree");
    });
    it("covers every advertised tool exactly once", () => {
        const accepted = TOOLS.map((tool: { name: string }) => tool.name).sort();
        const contracted = Object.keys(DEVICE_LAB_OUTPUT_CONTRACTS).sort();
        expect(contracted).toEqual(accepted);
        expect(contracted).toHaveLength(TOOLS.length);
        expect(TOOLS.every((tool: { name: string }) => contracted.includes(tool.name))).toBe(true);
    });

    it("returns typed lifecycle and session payloads", () => {
        const lifecycle = validateDeviceLabToolOutput("start", {
            device: { deviceId: "ios-contract", status: "running" },
        });
        const session = validateDeviceLabToolOutput("status", {
            device: { deviceId: "ios-contract" },
            automation: { session: null },
        });

        expect(lifecycle.device.deviceId).toBe("ios-contract");
        expect(session.device.deviceId).toBe("ios-contract");
    });

    it("reports the tool and missing field instead of leaking undefined access errors", () => {
        expect(() => validateDeviceLabToolOutput("status", { routedBy: "broker" }))
            .toThrow("status response contract violation: required device field is missing");
        expect(() => validateDeviceLabToolOutput("status", { session: null }))
            .toThrow("status response contract violation: required device field is missing");
        expect(() => validateDeviceLabToolOutput("start", { ok: false, error: "provider-command-failed" }))
            .toThrow("start response contract violation: operation failed (provider-command-failed)");
    });
});
