import { describe, expect, it } from "vitest";
import { TOOLS, CREATE_TOOL_BACKENDS, toolOperation } from "../../device-lab-mcp/src/tools.mjs";
import { normalizePublicToolArgs, toolInputError, flowStepArguments } from "../../device-lab-mcp/src/tool-arguments.mjs";
import { evaluateDestructivePolicy } from "../../device-lab-mcp/src/policy/destructive.mjs";
import { implicitBrokerProbeOptions } from "../../device-lab-mcp/src/broker.mjs";

describe("preparation-free public contract", () => {
    it.each(Object.entries(CREATE_TOOL_BACKENDS))("routes %s without a public backend selector", (name, backend) => {
        const schema = TOOLS.find(tool => tool.name === name)!.inputSchema;
        expect(schema.required).toEqual(["name"]);
        expect(schema.properties).not.toHaveProperty("backend");
        expect(toolOperation(name)).toBe("device_create");
        expect(normalizePublicToolArgs(name, { name: "Test" }).backend).toBe(backend);
        expect(toolInputError(name, { name: "Test", backend })).toBeTruthy();
    });
    it.each(["create_windows_vm", "create_linux_vm", "create_macos_vm"])("%s refuses caller IDs even when empty, malformed or forced", name => {
        const input = { name: "重复 VM name", ...(name === "create_macos_vm" ? { image: "fixture-image" } : {}) };
        expect(toolInputError(name, input)).toBeNull();
        expect(normalizePublicToolArgs(name, input)).not.toHaveProperty("deviceId");
        for (const deviceId of ["chosen-id", "", null, undefined, "../outside"]) {
            expect(toolInputError(name, { ...input, deviceId }), String(deviceId)).toContain("deviceId");
            expect(toolInputError(name, { ...input, deviceId, force: true }), String(deviceId)).toBeTruthy();
        }
    });
    it("preserves caller IDs on non-VM creation", () => {
        const android = { name: "Phone", deviceId: "existing-phone", avdName: "Existing_Phone" };
        expect(toolInputError("create_android_emulator", android)).toBeNull();
        expect(normalizePublicToolArgs("create_android_emulator", android)).toMatchObject({ deviceId: "existing-phone" });
        const ios = { name: "Phone", deviceId: "existing-ios", udid: "Existing-iPhone" };
        expect(toolInputError("create_ios_simulator", ios)).toBeNull();
        expect(normalizePublicToolArgs("create_ios_simulator", ios)).toMatchObject({ deviceId: "existing-ios" });
        const sandbox = { name: "Desktop", deviceId: "legacy-sandbox" };
        expect(toolInputError("create_windows_sandbox", sandbox)).toBeNull();
        expect(normalizePublicToolArgs("create_windows_sandbox", sandbox)).toMatchObject({ deviceId: "legacy-sandbox" });
    });
    it("rejects the removed create alias and confines nesting to Windows VMs", () => {
        expect(toolInputError("create", { name: "Test", backend: "windows-vm" })).toContain("Unknown tool");
        expect(toolInputError("create_windows_vm", { name: "Test", nestedVirtualization: true })).toBeNull();
        expect(toolInputError("create_windows_vm", { name: "Test", nestedVirtualization: "true" })).toBeTruthy();
        expect(toolInputError("create_linux_vm", { name: "Test", nestedVirtualization: true })).toBeTruthy();
    });
    it("removes staging tools and helper timeout details from discovery and calls", () => {
        for (const name of ["workspace_sync", "artifacts_export"]) {
            expect(TOOLS.some(t => t.name === name)).toBe(false);
            expect(toolInputError(name, { deviceId: "vm" })).toContain("Unknown tool");
        }
        expect(JSON.stringify(TOOLS)).not.toContain("helperTimeoutMs");
        expect(toolInputError("screenshot", { deviceId: "vm", helperTimeoutMs: 100 })).toContain("timeoutMs");
    });
    it("translates operation deadlines consistently for standalone and flow calls", () => {
        const args = { deviceId: "vm", timeoutMs: 2500 };
        expect(normalizePublicToolArgs("screenshot", args)).toMatchObject({ timeoutMs: 2500, helperTimeoutMs: 2500, rpcTimeoutMs: 32500 });
        const step = flowStepArguments("screenshot", { deviceId: "vm" }, { timeoutMs: 2500 });
        expect(step).toEqual({ deviceId: "vm", timeoutMs: 2500 });
        expect(normalizePublicToolArgs("screenshot", step)).toMatchObject({ deviceId: "vm", helperTimeoutMs: 2500 });
        expect(args).not.toHaveProperty("helperTimeoutMs");
        expect(toolInputError("screenshot", { ...args, timeoutMs: -1 })).toContain("timeoutMs");
        expect(toolInputError("screenshot", { ...args, timeoutMs: 300001 })).toContain("timeoutMs");
    });
    it("keeps full simulator erasure separate from app clearing and retains confirmation", () => {
        expect(toolInputError("reset", { deviceId: "sim", bundleId: "app" })).toContain("clear_app_data");
        const args = normalizePublicToolArgs("reset", { deviceId: "sim" });
        expect(args).toEqual({ deviceId: "sim", eraseSimulator: true });
        expect(evaluateDestructivePolicy("device_reset", args).ok).toBe(false);
        expect(evaluateDestructivePolicy("device_reset", { ...args, confirmDestructive: true }).ok).toBe(true);
        expect(normalizePublicToolArgs("clear_app_data", { deviceId: "sim", appId: "app" })).not.toHaveProperty("eraseSimulator");
    });
    it.each(["exec", "wait_for_text", "wait_for_app", "screenshot"])("separates a short %s deadline from broker discovery", (name) => {
        const args = { deviceId: "vm", timeoutMs: 1, hostCandidates: ["127.0.0.1"],
            ...(name === "wait_for_app" ? { appId: "example.app" } : {}),
        };
        const normalized = normalizePublicToolArgs(name, args);
        expect(normalized.timeoutMs).toBe(1);
        const probe = implicitBrokerProbeOptions(normalized);
        expect(probe).toMatchObject({ brokerProbeTimeoutMs: 1000 });
        expect({ ...normalized, ...probe }).toMatchObject({ timeoutMs: 1, brokerProbeTimeoutMs: 1000 });
        expect(implicitBrokerProbeOptions(args)?.timeoutMs).toBe(1);
        expect(args).not.toHaveProperty("brokerProbeTimeoutMs");
        expect(toolInputError(name, { ...args, brokerProbeTimeoutMs: 1 })).toContain("internal option");
    });
    it("creates mobile resources without public provisioning switches", () => {
        const android = { name: "Test", systemImage: "system-images;android-35;google_apis;x86_64" };
        expect(toolInputError("create_android_emulator", android)).toBeNull();
        expect(normalizePublicToolArgs("create_android_emulator", android)).toMatchObject({ backend: "android-emulator", createAvd: true });
        const ios = { name: "Test", deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16", runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0" };
        expect(toolInputError("create_ios_simulator", ios)).toBeNull();
        expect(normalizePublicToolArgs("create_ios_simulator", ios)).toMatchObject({ backend: "ios-simulator", createSimulator: true });
        expect(toolInputError("create_android_emulator", { ...android, createAvd: true })).toBeTruthy();
        expect(toolInputError("create_android_emulator", {  name: "Test" })).toContain("systemImage");
        expect(toolInputError("create_ios_simulator", {  name: "Test" })).toContain("deviceType");
    });
    it("preserves explicit existing device reuse and rejects cross-platform inputs", () => {
        expect(normalizePublicToolArgs("create_android_emulator", {  name: "Existing", avdName: "existing" })).toMatchObject({ createAvd: false });
        expect(normalizePublicToolArgs("create_ios_simulator", {  name: "Existing", udid: "existing" })).toMatchObject({ createSimulator: false });
        expect(toolInputError("create_windows_sandbox", {  name: "Win", systemImage: "android" })).toBeTruthy();
        expect(toolInputError("create_linux_vm", {  provider: "container-qemu", name: "QEMU", sourceImage: "/tmp/base.qcow2", dryRun: true })).toContain("does not support dryRun");
    });
});
