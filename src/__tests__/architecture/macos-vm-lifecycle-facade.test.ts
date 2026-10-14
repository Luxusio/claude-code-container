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
    readMacosDevices(): Device[];
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
    backend: "macos-vm", name: "Unit", provider: "tart", ...extra,
});
function payload(reply: Reply | undefined) {
    expect(reply?.isError).not.toBe(true);
    if (!reply) throw Error("Missing facade response");
    return JSON.parse(reply.content[0].text);
}
describe("macOS current native facade", () => {
    it("uses default native entropy for same-name definitions, images and clones", async () => {
        const name = "Same 名称 with spaces";
        const first = payload(await create({ name }));
        const second = payload(await create({ name }));
        const image = payload(await handleMacosTool("device_base_image_create", { backend: "macos-vm", name, sourceImage: "base-image", provider: "tart" }));
        const imageAgain = payload(await handleMacosTool("device_base_image_create", { backend: "macos-vm", name, sourceImage: "base-image", provider: "tart" }));
        const clone = payload(await handleMacosTool("device_base_image_clone", { backend: "macos-vm", name, sourceDeviceId: image.device.id }));
        const cloneAgain = payload(await handleMacosTool("device_base_image_clone", { backend: "macos-vm", name, sourceDeviceId: image.device.id }));
        const born = [first, second, image, imageAgain, clone, cloneAgain].map(reply => reply.device);
        expect(new Set(born.map(device => device.id)).size).toBe(6);
        expect(new Set(born.map(device => device.providerInstance)).size).toBe(6);
        expect(new Set(born.map(device => device.providerPlan.helper.workspaceDir)).size).toBe(6);
        for (const device of born) {
            expect(device.id).toMatch(/^macos-[0-9a-f-]{36}$/);
            expect(device.name).toBe(name);
        }
        payload(await handleMacosTool("device_delete", { deviceId: first.device.id }));
        const replacement = payload(await create({ name }));
        expect(replacement.device.id).not.toBe(first.device.id);
        const before = state.readMacosDevices();
        commands.timed.mockClear();
        const stale = await handleMacosTool("device_start", { deviceId: first.device.id });
        expect(stale === undefined || stale.isError === true).toBe(true);
        expect(commands.timed).not.toHaveBeenCalled();
        expect(commands.run).not.toHaveBeenCalled();
        expect(state.readMacosDevices()).toEqual(before);
    });
    it.each(["device_create", "device_base_image_create", "device_base_image_clone"])("refuses caller IDs in %s before provider or metadata effects", async tool => {
        const before = state.readMacosDevices();
        const result = await handleMacosTool(tool, { backend: "macos-vm", name: "Chosen", deviceId: "historical", sourceImage: "base-image", sourceDeviceId: "missing", force: true });
        expect(result?.isError).toBe(true);
        expect(state.readMacosDevices()).toEqual(before);
        expect(commands.timed).not.toHaveBeenCalled();
        expect(commands.run).not.toHaveBeenCalled();
    });

    it("creates, stops and removes owner metadata without touching an unmanaged provider resource", async () => {
        const created = payload(await create());
        const deviceId = created.device.id;
        expect(created.device).toMatchObject({ id: expect.stringMatching(/^macos-[0-9a-f-]{36}$/), status: "stopped" });
        expect(payload(await handleMacosTool("device_stop", { deviceId })).device.status).toBe("stopped");
        payload(await handleMacosTool("device_delete", { deviceId }));
        expect(state.findMacosDevice(deviceId)).toBeUndefined();
        expect(commands.timed).not.toHaveBeenCalled();
    });
    it("clones and deletes only its managed Tart instance", async () => {
        const created = payload(await create({ sourceImage: "base-image" }));
        const deviceId = created.device.id;
        const instance = created.device.providerInstance;
        expect(created.device.providerResourceManaged).toBe(true);
        expect(commands.timed).toHaveBeenCalledWith("/fixture/tart", ["clone", "base-image", instance], 600000);
        payload(await handleMacosTool("device_delete", { deviceId }));
        expect(commands.timed).toHaveBeenCalledWith("/fixture/tart", ["delete", instance], 60000);
        expect(state.findMacosDevice(deviceId)).toBeUndefined();
    });
    it("refuses destructive deletion of a running device", async () => {
        const deviceId = payload(await create()).device.id; state.updateMacosDevice(deviceId, device => ({ ...device, status: "running" }));
        const reply = await handleMacosTool("device_delete", { deviceId });
        expect(reply?.isError).toBe(true);
        expect(state.findMacosDevice(deviceId)?.status).toBe("running");
        expect(commands.timed).not.toHaveBeenCalled();
    });
    it("does not publish stopped state over a successor installed during the provider stop", async () => {
        const deviceId = payload(await create()).device.id; state.updateMacosDevice(deviceId, device => ({ ...device, status: "running", providerInstance: "owned-unit" }));
        const claimedAt = new Date().toISOString();
        commands.timed.mockImplementation(() => {
            state.updateMacosDevice(deviceId, device => ({ ...device, status: "running", providerInstance: "successor", successorMarker: true, lifecycle: { runtimeId: "successor-runtime", operation: "start", claimedAt } }));
            return { status: 0, stdout: "", stderr: "" };
        });
        expect((await handleMacosTool("device_stop", { deviceId }))?.isError).toBe(true);
        expect(state.findMacosDevice(deviceId)).toMatchObject({ status: "running", providerInstance: "successor", successorMarker: true, lifecycle: { runtimeId: "successor-runtime", operation: "start", claimedAt } });
    });
    it("reports clone failure without claiming a device", async () => {
        commands.timed.mockReturnValue({ status: 7, stdout: "", stderr: "clone refused" });
        expect((await create({ sourceImage: "base-image" }))?.isError).toBe(true);
        expect(state.readMacosDevices()).toEqual([]);
        expect(commands.timed.mock.calls.map(([, args]) => args[0])).toEqual(["clone"]);
    });
});
