import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceBrokerServer, type DeviceBrokerOptions } from "../../../packages/device-lab/src/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { backendRoot, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "../helpers/host-broker-test-fixture.js";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";

vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), totalmem: () => 64 * 1024 ** 3, freemem: () => 48 * 1024 ** 3 }));
let home: string, restore: () => void, owner: string;
let server: ReturnType<typeof createDeviceBrokerServer> | undefined;
beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ccc-macos-broker-"));
    restore = isolateDeviceLabTestEnvironment(home);
    owner = deviceLabOwnerId(home);
});
afterEach(async () => {
    try { if (server?.listening) await close(server); }
    finally { server = undefined; restore(); rmSync(home, { recursive: true, force: true }); }
});
const stateFile = () => join(backendRoot(owner, "macos"), "devices.json");
const devices = (): Array<Record<string, unknown>> => JSON.parse(readFileSync(stateFile(), "utf8")).devices;
const device = () => ({ id: "unit", name: "Unit", backend: "macos-vm", provider: "tart", providerInstance: "owned-unit", status: "stopped", createdAt: "2026-10-10T00:00:00.000Z", recording: null });
async function start(runner: NonNullable<DeviceBrokerOptions["commandRunner"]>) {
    server = createDeviceBrokerServer({ cwd: home, host: "127.0.0.1", port: 0, platform: "darwin", providerPaths: { tart: "/fixture/tart" }, commandRunner: runner });
    return listen(server);
}
async function invoke(base: string, command: string, extra: Record<string, unknown> = {}, authenticated = true) {
    const response = await fetch(ownerRpcEndpoint(base, owner), {
        method: "POST", headers: authenticated ? ownerRpcHeaders(owner) : { "content-type": "application/json" },
        body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "macos-vm", command, deviceId: "unit", ...extra } }),
    });
    return { status: response.status, body: await response.json() };
}
const successfulRunner = (): NonNullable<DeviceBrokerOptions["commandRunner"]> => command => ({ ...command, status: 0, stdout: "", stderr: "" });
describe("authenticated macOS broker lifecycle", () => {
    it("publishes create/start/stop/delete through the actual HTTP dispatcher", async () => {
        const runner = vi.fn(successfulRunner()), base = await start(runner);
        expect((await invoke(base, "device_create", { name: "Unit", provider: "tart", image: "base-image" })).status).toBe(200);
        expect(devices()[0]).toMatchObject({ id: "unit", status: "stopped", provider: "tart" });
        expect((await invoke(base, "device_start", { waitForBoot: false })).status).toBe(200);
        expect(devices()[0].status).toBe("running");
        expect((await invoke(base, "device_stop")).status).toBe(200);
        expect(devices()[0]).toMatchObject({ status: "stopped", recording: null });
        expect((await invoke(base, "device_delete", { confirmDestructive: true })).status).toBe(200);
        expect(devices()).toEqual([]);
        expect(runner.mock.calls.map(([command]) => command.args?.[0])).toEqual(["clone", "run", "stop", "delete"]);
    });
    it("rejects unauthenticated mutation before invoking a provider", async () => {
        writeBrokerDevices(owner, "macos", [device()]);
        const runner = vi.fn(successfulRunner()), base = await start(runner);
        expect((await invoke(base, "device_start", {}, false)).status).toBe(401);
        expect(devices()[0].status).toBe("stopped");
        expect(runner).not.toHaveBeenCalled();
    });
    it("keeps create credentials private when claiming the cloned device fails", async () => {
        writeBrokerDevices(owner, "macos", []);
        const password = "fixture-private-macos-password";
        const runner = vi.fn<NonNullable<DeviceBrokerOptions["commandRunner"]>>(command => {
            if (command.args?.[0] === "clone") writeFileSync(stateFile(), "{");
            return { ...command, status: 0, stdout: "", stderr: "" };
        });
        const base = await start(runner);
        const result = await invoke(base, "device_create", {
            name: "Unit", provider: "tart", image: "base-image",
            sshHost: "127.0.0.1", sshUser: "guest", sshPassword: password,
        });
        expect(result).toMatchObject({ status: 409, body: {
            ok: false, error: "owner-devices-state-invalid", backend: "macos-vm", stateKey: "macos",
            rollback: { attempted: true, ok: true },
        } });
        expect(runner.mock.calls.map(([command]) => command.args?.[0])).toEqual(["clone", "delete"]);
        expect(result.body).not.toHaveProperty("plan");
        expect(result.body).not.toHaveProperty("cause");
        expect(JSON.stringify(result.body)).not.toContain(password);
    });
    it("keeps the current record when the provider refuses start", async () => {
        writeBrokerDevices(owner, "macos", [device()]);
        const base = await start(command => ({ ...command, status: 7, stdout: "", stderr: "provider refused" }));
        const result = await invoke(base, "device_start", { waitForBoot: false });
        expect(result.status).toBe(502); expect(result.body.error).toBe("provider-command-failed");
        expect(devices()[0]).toMatchObject({ status: "stopped", providerInstance: "owned-unit" });
    });
    it("refuses to publish over a successor after provider execution", async () => {
        writeBrokerDevices(owner, "macos", [device()]);
        const successor = { ...device(), providerInstance: "successor-unit", successorMarker: true };
        const base = await start(command => {
            writeBrokerDevices(owner, "macos", [successor]);
            return { ...command, status: 0, stdout: "", stderr: "" };
        });
        const result = await invoke(base, "device_start", { waitForBoot: false });
        expect(result.status).toBe(409); expect(result.body.error).toBe("owner-device-state-conflict");
        expect(devices()).toEqual([successor]);
    });
    it("blocks an unowned recording before stop and provider effects", async () => {
        const current = { ...device(), status: "running", recording: { authority: "other" } };
        writeBrokerDevices(owner, "macos", [current]);
        const runner = vi.fn(successfulRunner()), base = await start(runner);
        const result = await invoke(base, "device_stop");
        expect(result.status).toBe(502); expect(result.body.error).toBe("auxiliary-runtime-cleanup-failed");
        expect(runner).not.toHaveBeenCalled(); expect(devices()).toEqual([current]);
    });
});
