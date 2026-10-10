import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";

const commands = vi.hoisted(() => ({ timed: vi.fn(), run: vi.fn() }));
vi.mock("../../../packages/device-lab/providers/commands.mjs", () => ({
    commandPath: (name: string) => name === "tart" ? "/fixture/tart" : null,
    run: commands.run,
    runWithTimeout: commands.timed,
}));
type Device = Record<string, unknown>;
type Reply = { isError?: boolean; content: Array<{ text: string }> };
// Vitest imports the actual facade; only its command leaves are doubled.
const { handleMacosTool } = await vi.importActual<{
    handleMacosTool(name: string, args: Record<string, unknown>): Promise<Reply | undefined>;
}>("../../../packages/device-lab/providers/backends/macos-vm.mjs");
const state = await vi.importActual<{
    findMacosDevice(id: string): Device | undefined;
    updateMacosDevice(id: string, update: (device: Device) => Device): Device;
}>("../../../packages/device-lab/providers/state/macos-state.mjs");
let home: string, restore: () => void;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ccc-macos-facade-"));
    restore = isolateDeviceLabTestEnvironment(home);
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    commands.timed.mockReset().mockReturnValue({ status: 0, stdout: "", stderr: "" });
    commands.run.mockReset().mockImplementation(() => { throw Error("Unexpected command"); });
});
afterEach(() => { vi.restoreAllMocks(); restore(); rmSync(home, { recursive: true, force: true }); });
const create = (extra: Record<string, unknown> = {}) => handleMacosTool("device_create", {
    backend: "macos-vm", deviceId: "unit", name: "Unit", provider: "tart", ...extra,
});
function payload(reply: Reply | undefined) {
    expect(reply?.isError).not.toBe(true);
    if (!reply) throw Error("Missing facade response");
    return JSON.parse(reply.content[0].text);
}
describe("macOS current native facade", () => {
    it("creates, stops and removes owner metadata without touching an unmanaged provider resource", async () => {
        expect(payload(await create()).device).toMatchObject({ id: "unit", status: "stopped" });
        expect(payload(await handleMacosTool("device_stop", { deviceId: "unit" })).device.status).toBe("stopped");
        payload(await handleMacosTool("device_delete", { deviceId: "unit" }));
        expect(state.findMacosDevice("unit")).toBeUndefined();
        expect(commands.timed).not.toHaveBeenCalled();
    });
    it("clones and deletes only its managed Tart instance", async () => {
        const created = payload(await create({ sourceImage: "base-image" }));
        const instance = created.device.providerInstance;
        expect(created.device.providerResourceManaged).toBe(true);
        expect(commands.timed).toHaveBeenCalledWith("/fixture/tart", ["clone", "base-image", instance], 600000);
        payload(await handleMacosTool("device_delete", { deviceId: "unit" }));
        expect(commands.timed).toHaveBeenCalledWith("/fixture/tart", ["delete", instance], 60000);
        expect(state.findMacosDevice("unit")).toBeUndefined();
    });
    it("refuses destructive deletion of a running device", async () => {
        await create(); state.updateMacosDevice("unit", device => ({ ...device, status: "running" }));
        const reply = await handleMacosTool("device_delete", { deviceId: "unit" });
        expect(reply?.isError).toBe(true);
        expect(state.findMacosDevice("unit")?.status).toBe("running");
        expect(commands.timed).not.toHaveBeenCalled();
    });
    it("does not publish stopped state over a successor installed during the provider stop", async () => {
        await create(); state.updateMacosDevice("unit", device => ({ ...device, status: "running", providerInstance: "owned-unit" }));
        const claimedAt = new Date().toISOString();
        commands.timed.mockImplementation(() => {
            state.updateMacosDevice("unit", device => ({ ...device, status: "running", providerInstance: "successor", successorMarker: true, lifecycle: { runtimeId: "successor-runtime", operation: "start", claimedAt } }));
            return { status: 0, stdout: "", stderr: "" };
        });
        expect((await handleMacosTool("device_stop", { deviceId: "unit" }))?.isError).toBe(true);
        expect(state.findMacosDevice("unit")).toMatchObject({ status: "running", providerInstance: "successor", successorMarker: true, lifecycle: { runtimeId: "successor-runtime", operation: "start", claimedAt } });
    });
    it("reports clone failure without claiming a device", async () => {
        commands.timed.mockReturnValue({ status: 7, stdout: "", stderr: "clone refused" });
        expect((await create({ sourceImage: "base-image" }))?.isError).toBe(true);
        expect(state.findMacosDevice("unit")).toBeUndefined();
    });
});
