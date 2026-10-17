import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import * as nativeFs from "fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";

const commands = vi.hoisted(() => ({ timed: vi.fn(), run: vi.fn(), spawn: vi.fn(), executables: new Map<string, string>() }));
vi.mock("../../../packages/device-lab/providers/commands.mjs", () => ({
    commandPath: (name: string) => commands.executables.get(name) ?? null,
    run: commands.run,
    runWithTimeout: commands.timed,
}));
vi.mock("child_process", async original => ({ ...await original<Record<string, unknown>>(), spawn: commands.spawn }));
vi.mock("fs", async original => ({ ...await original<typeof import("fs")>() }));
type Device = Record<string, unknown>;
type Reply = { isError?: boolean; content: Array<{ text: string }> };
// Vitest imports the actual facade; only its command leaves are doubled.
const { handleMacosTool, waitForMacosGuestHelper } = await vi.importActual<{
    handleMacosTool(name: string, args: Record<string, unknown>): Promise<Reply | undefined>;
    waitForMacosGuestHelper(device: Device, deadlineAt: number): Promise<{ ok: boolean }>;
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
    commands.spawn.mockReset(); commands.executables.clear(); commands.executables.set("tart", "/fixture/tart");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); restore(); rmSync(home, { recursive: true, force: true }); });
const create = (extra: Record<string, unknown> = {}) => handleMacosTool("device_create", {
    backend: "macos-vm", name: "Unit", provider: "tart", ...extra,
});
function payload(reply: Reply | undefined) {
    expect(reply?.isError).not.toBe(true);
    if (!reply) throw Error("Missing facade response");
    return JSON.parse(reply.content[0].text);
}
function failurePayload(reply: Reply | undefined) {
    expect(reply?.isError).toBe(true);
    return JSON.parse(reply!.content[0].text);
}
async function startNativeFixture(extra: Record<string, unknown> = {}) {
    const created = payload(await create({ sshHost: "192.0.2.44", sshUser: "guest", ...extra }));
    const deviceId: string = created.device.id;
    state.updateMacosDevice(deviceId, device => ({ ...device, softnet: false }));
    commands.executables.set("ssh", "/fixture/ssh"); commands.executables.set("scp", "/fixture/scp");
    vi.stubEnv("CCC_MACOS_VM_IP_TIMEOUT_MS", "10000"); vi.stubEnv("CCC_MACOS_VM_HELPER_TIMEOUT_MS", "30000");
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-17T12:00:00.000Z"));
    let elapsed = 17.25;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    const child = Object.assign(new EventEmitter(), { pid: 71, unref: vi.fn() });
    commands.spawn.mockReturnValue(child); commands.timed.mockClear();
    return {
        deviceId, child,
        advance: (milliseconds: number) => { elapsed += milliseconds; },
        read: () => state.findMacosDevice(deviceId),
        async begin(args: Record<string, unknown> = {}) {
            const pending = handleMacosTool("device_start", { deviceId, bootTimeoutMs: 1000.9, ...args });
            // The create above warms only the real owner-process lock identity;
            // subsequent acquisition and launch settle through microtasks.
            for (let attempts = 0; attempts < 100 && commands.spawn.mock.calls.length === 0; attempts++) await Promise.resolve();
            expect(commands.spawn).toHaveBeenCalledTimes(1);
            elapsed += 200;
            await vi.advanceTimersByTimeAsync(200);
            return { pending };
        },
    };
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

    it("uses the actual relative native route with retained IP10000 and SCP/chmod30000 caps", async () => {
        const f = await startNativeFixture();
        commands.timed.mockImplementation((_command, args) => ({ status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "helper ready", stderr: "" }));
        const { pending } = await f.begin({ bootTimeoutMs: 60000 });
        expect(payload(await pending).device).toMatchObject({ status: "running", bootReady: true });
        expect(commands.timed.mock.calls.map(([command, args, timeout]) => [command, args[0], timeout])).toEqual([
            ["/fixture/tart", "ip", 10000], ["/fixture/scp", "-P", 30000], ["/fixture/ssh", "-p", 30000],
        ]);
        expect(f.child.unref).toHaveBeenCalledTimes(1);
    });

    it("handles an asynchronous native error when an admitted spawn exhausts the settling allowance", async () => {
        const f = await startNativeFixture(), failure = new Error("admitted provider spawn rejected");
        let unhandled: unknown, handled = false;
        commands.spawn.mockImplementationOnce(() => {
            f.advance(1001);
            queueMicrotask(() => {
                try { handled = f.child.emit("error", failure); }
                catch (error) { unhandled = error; }
            });
            return f.child;
        });
        const { pending } = await f.begin(), result = await pending;
        expect(unhandled).toBeUndefined(); expect(handled).toBe(true);
        expect(result?.isError).toBe(true);
        expect(result?.content[0].text).toContain(failure.message);
        expect(commands.timed).not.toHaveBeenCalled();
        expect(f.read()).toMatchObject({ status: "stopped" });
        expect(f.read()?.runtime).toBeUndefined(); expect(f.read()?.lifecycle).toBeUndefined();
    });

    it("keeps an exhausted admitted spawn observable without an unhandled later child error", async () => {
        const f = await startNativeFixture();
        commands.spawn.mockImplementationOnce(() => { f.advance(1001); return f.child; });
        const { pending } = await f.begin();
        expect(failurePayload(await pending)).toMatchObject({ error: "macos-boot-not-ready" });
        expect(f.read()).toMatchObject({ status: "starting", bootReady: false, runtime: { providerPid: 71 } });
        expect(() => f.child.emit("error", new Error("later provider error"))).not.toThrow();
        expect(commands.timed).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps relative native caps when environment timeouts exceed 10000/30000", async () => {
        const f = await startNativeFixture();
        vi.stubEnv("CCC_MACOS_VM_IP_TIMEOUT_MS", "60000"); vi.stubEnv("CCC_MACOS_VM_HELPER_TIMEOUT_MS", "120000");
        commands.timed.mockImplementation((_command, args) => ({ status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "ready", stderr: "" }));
        const { pending } = await f.begin({ bootTimeoutMs: 300000 });
        expect(payload(await pending).device).toMatchObject({ status: "running", bootReady: true });
        expect(commands.timed.mock.calls.map(([, , timeout]) => timeout)).toEqual([10000, 30000, 30000]);
    });

    it("preserves the exported numeric helper's environment timeout above the relative-only cap", async () => {
        const f = await startNativeFixture(), device = f.read();
        if (!device) throw new Error("Expected an owned native helper target");
        vi.stubEnv("CCC_MACOS_VM_HELPER_TIMEOUT_MS", "60000");
        commands.timed.mockReturnValue({ status: 0, stdout: "ready", stderr: "" });
        expect(await waitForMacosGuestHelper(device, Date.now() + 90000)).toMatchObject({ ok: true });
        expect(commands.timed.mock.calls.map(([command, , timeout]) => [command, timeout])).toEqual([["/fixture/scp", 60000], ["/fixture/ssh", 60000]]);
        expect(commands.spawn).not.toHaveBeenCalled();
    });

    it.each(["scp", "chmod"])("refuses native %s after password askpass preparation consumes the remainder", async stage => {
        const f = await startNativeFixture({ sshPassword: "fixture-only-password" }), rename = nativeFs.renameSync;
        let copied = false, expiredDuringPreparation = false;
        vi.spyOn(nativeFs, "renameSync").mockImplementation((source, destination) => {
            rename(source, destination);
            if (String(destination).endsWith("ssh-askpass.sh") && (stage === "scp" || copied)) {
                f.advance(801); expiredDuringPreparation = true;
            }
        });
        commands.timed.mockImplementation((command, args) => {
            if (command === "/fixture/scp") copied = true;
            return { status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "ready", stderr: "" };
        });
        const { pending } = await f.begin();
        expect(failurePayload(await pending)).toMatchObject({ error: "macos-helper-readiness-timeout" });
        expect(expiredDuringPreparation).toBe(true);
        expect(commands.timed.mock.calls.map(([command]) => command)).toEqual(stage === "scp" ? ["/fixture/tart"] : ["/fixture/tart", "/fixture/scp"]);
        expect(f.read()).toMatchObject({ status: "running", bootReady: true, runtime: { providerPid: 71 } });
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["scp", "chmod"])("samples native %s timeout after partial askpass preparation cost", async stage => {
        const f = await startNativeFixture({ sshPassword: "fixture-only-password" }), rename = nativeFs.renameSync;
        let copied = false, charged = false;
        vi.spyOn(nativeFs, "renameSync").mockImplementation((source, destination) => {
            rename(source, destination);
            if (!charged && String(destination).endsWith("ssh-askpass.sh") && (stage === "scp" || copied)) { f.advance(100); charged = true; }
        });
        commands.timed.mockImplementation((command, args) => {
            if (command === "/fixture/scp") copied = true;
            return { status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "ready", stderr: "" };
        });
        const { pending } = await f.begin();
        expect(payload(await pending).device).toMatchObject({ status: "running", bootReady: true });
        expect(charged).toBe(true);
        expect(commands.timed.mock.calls.map(([, , timeout]) => timeout)).toEqual(stage === "scp" ? [800, 700, 700] : [800, 800, 700]);
    });

    it.each([1, -1])("keeps wall timestamps separate while native commands share fractional remaining time: wall=%s", async direction => {
        const f = await startNativeFixture();
        commands.timed.mockImplementation((command, args) => {
            if (args[0] === "ip") { f.advance(200); vi.setSystemTime(Date.now() + direction * 86400000); }
            if (command === "/fixture/scp") f.advance(100);
            return { status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "ready", stderr: "" };
        });
        const { pending } = await f.begin();
        const result = payload(await pending);
        expect(result.device).toMatchObject({ status: "running", bootReady: true });
        expect(commands.timed.mock.calls.map(([, , timeout]) => timeout)).toEqual([800, 600, 500]);
        expect(result.device.helper.provisioning.updatedAt).toBe(new Date(Date.now()).toISOString());
        expect(result.device.helper.provisioning.updatedAt).toMatch(direction === 1 ? /^2026-10-18T/ : /^2026-10-16T/);
    });

    it.each(["ip", "scp", "chmod"])("rejects native %s success returned after the shared allowance without another effect", async stage => {
        const f = await startNativeFixture();
        commands.timed.mockImplementation((command, args) => {
            if (stage === "ip" && args[0] === "ip" || stage === "scp" && command === "/fixture/scp" || stage === "chmod" && command === "/fixture/ssh") f.advance(801);
            return { status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "late success", stderr: "" };
        });
        const { pending } = await f.begin();
        expect(failurePayload(await pending)).toMatchObject({ error: stage === "ip" ? "macos-boot-not-ready" : "macos-helper-readiness-timeout" });
        expect(commands.timed.mock.calls.map(([command]) => command)).toEqual(stage === "ip" ? ["/fixture/tart"] : stage === "scp" ? ["/fixture/tart", "/fixture/scp"] : ["/fixture/tart", "/fixture/scp", "/fixture/ssh"]);
        expect(f.read()).toMatchObject({ status: stage === "ip" ? "starting" : "running", bootReady: stage !== "ip", runtime: { providerPid: 71 } });
        expect(f.read()?.lifecycle).toBeUndefined();
        expect(commands.timed.mock.calls.some(([, args]) => args[0] === "stop")).toBe(false);
    });

    it.each(["scp", "chmod"])("preserves an admitted native %s failure after its allowance expires", async stage => {
        const f = await startNativeFixture(), failure = { status: 9, stdout: "partial", stderr: "Permission denied" };
        commands.timed.mockImplementation((command, args) => {
            if (command === (stage === "scp" ? "/fixture/scp" : "/fixture/ssh")) { f.advance(801); return failure; }
            return { status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "", stderr: "" };
        });
        const { pending } = await f.begin();
        expect(failurePayload(await pending)).toMatchObject({ error: stage === "scp" ? "macos-helper-scp-failed" : "macos-helper-chmod-failed", command: failure });
        expect(f.read()).toMatchObject({ status: "running", bootReady: true, runtime: { providerPid: 71 } });
    });

    it.each(["scp", "chmod"])("preserves a transient native %s failure returned after expiry without another retry or sleep", async stage => {
        const f = await startNativeFixture(), failure = { status: 255, stdout: "partial native output", stderr: "Connection refused" };
        commands.timed.mockImplementation((command, args) => {
            if (command === (stage === "scp" ? "/fixture/scp" : "/fixture/ssh")) { f.advance(801); return failure; }
            return { status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "", stderr: "" };
        });
        const { pending } = await f.begin();
        expect(failurePayload(await pending)).toMatchObject({ error: stage === "scp" ? "macos-helper-scp-failed" : "macos-helper-chmod-failed", command: failure });
        expect(commands.timed.mock.calls.map(([command]) => command)).toEqual(stage === "scp"
            ? ["/fixture/tart", "/fixture/scp"] : ["/fixture/tart", "/fixture/scp", "/fixture/ssh"]);
        expect(vi.getTimerCount()).toBe(0);
        expect(f.read()).toMatchObject({ status: "running", bootReady: true, runtime: { providerPid: 71 } });
        expect(f.read()?.lifecycle).toBeUndefined();
    });

    it.each(["scp", "chmod"])("returns readiness timeout when a timely transient %s failure is followed by an overlong retry sleep", async stage => {
        const f = await startNativeFixture(), failure = { status: 255, stdout: "", stderr: "Connection refused" };
        commands.timed.mockImplementation((command, args) => command === (stage === "scp" ? "/fixture/scp" : "/fixture/ssh")
            ? failure : { status: 0, stdout: args[0] === "ip" ? "192.0.2.44" : "", stderr: "" });
        const { pending } = await f.begin();
        expect(vi.getTimerCount()).toBe(1);
        f.advance(801); await vi.advanceTimersByTimeAsync(500);
        expect(failurePayload(await pending)).toMatchObject({ error: "macos-helper-readiness-timeout" });
        expect(commands.timed.mock.calls.map(([command]) => command)).toEqual(stage === "scp"
            ? ["/fixture/tart", "/fixture/scp"] : ["/fixture/tart", "/fixture/scp", "/fixture/ssh"]);
        expect(vi.getTimerCount()).toBe(0);
        expect(f.read()).toMatchObject({ status: "running", bootReady: true, runtime: { providerPid: 71 } });
    });

    it("bounds actual IP poll sleeps by 5000 and remaining time without an expired final lookup", async () => {
        const f = await startNativeFixture();
        commands.timed.mockReturnValue({ status: 1, stdout: "", stderr: "not booted" });
        const { pending } = await f.begin({ bootTimeoutMs: 6200 });
        expect(commands.timed).toHaveBeenCalledTimes(2);
        f.advance(4999); await vi.advanceTimersByTimeAsync(4999); expect(commands.timed).toHaveBeenCalledTimes(2);
        f.advance(1); await vi.advanceTimersByTimeAsync(1); expect(commands.timed).toHaveBeenCalledTimes(4);
        f.advance(1000); await vi.advanceTimersByTimeAsync(1000);
        expect(failurePayload(await pending)).toMatchObject({ error: "macos-boot-not-ready" });
        expect(commands.timed.mock.calls.map(([, , timeout]) => timeout)).toEqual([6000, 6000, 1000, 1000]);
        expect(f.read()).toMatchObject({ status: "starting", bootReady: false, runtime: { providerPid: 71 } });
    });

    it.each([false, true])("keeps waitForBoot:false on bounded one-shot provisioning without IP or helper retries: failure=%s", async fails => {
        const f = await startNativeFixture();
        commands.timed.mockImplementation(command => command === "/fixture/scp" && fails
            ? { status: 255, stdout: "", stderr: "Connection refused" } : { status: 0, stdout: "ready", stderr: "" });
        const { pending } = await f.begin({ waitForBoot: false });
        if (fails) expect(failurePayload(await pending)).toMatchObject({ error: "macos-helper-scp-failed" });
        else expect(payload(await pending).device).toMatchObject({ status: "running", bootReady: false });
        expect(commands.timed.mock.calls.map(([command, , timeout]) => [command, timeout])).toEqual(fails ? [["/fixture/scp", 800]] : [["/fixture/scp", 800], ["/fixture/ssh", 800]]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
