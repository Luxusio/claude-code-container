import type { Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { ANDROID_SYSTEM_IMAGE, androidRawState, privateBrokerHome } from "../helpers/android-emulator-lifecycle-fixture.js";

type NativeCommand = { mode: string; provider: string; executable?: string; args?: string[]; input?: string; reason?: string; [key: string]: unknown };
type NativeResult = NativeCommand & { status: number | null; stdout: string; stderr: string; error?: string };
type Runner = (command: NativeCommand, options: { timeoutMs: number; outputLimit: number }) => NativeResult;
type BrokerModule = { createDeviceBrokerServer(options: { cwd: string; host: string; port: number; providerPaths: Record<string, string>; commandRunner: Runner }): Server };
type HostFixture = {
    listen(server: Server): Promise<string>; close(server: Server): Promise<void>;
    ownerRpcEndpoint(base: string, ownerId: string): string; ownerRpcHeaders(ownerId: string): Record<string, string>;
    writeBrokerDevices(ownerId: string, stateKey: string, devices: unknown[]): string;
};
type Rpc = { status: number; body: Record<string, unknown> };
type BrokerControl = {
    ownerId: string; home: string; calls: Array<{ command: NativeCommand; options: { timeoutMs: number; outputLimit: number } }>;
    denied: { provider: number }; rpc(params: Record<string, unknown>, authenticated?: boolean): Promise<Rpc>;
    write(devices: unknown[]): void; setRunner(runner: Runner): void;
};
const project = fileURLToPath(new URL("../../../", import.meta.url));
const hostFixturePath = "../helpers/host-broker-test-fixture.js";

async function withBroker(name: string, check: (c: BrokerControl) => Promise<void>): Promise<void> {
    const fixture = privateBrokerHome(), restore = isolateDeviceLabTestEnvironment(fixture.home), failures: unknown[] = [];
    const sentinel = join(fixture.home, "unknown-retained"); writeFileSync(sentinel, "unallocated resource retained\n");
    let server: Server | undefined, host: HostFixture | undefined;
    const calls: BrokerControl["calls"] = [], denied = { provider: 0 }, outcomes: unknown[] = [];
    let running = false;
    let effect: Runner = command => {
        if (command.provider === "emulator") running = true;
        if (command.args?.includes("kill")) running = false;
        const isState = command.args?.includes("get-state");
        return { ...command, status: isState && !running ? 1 : 0,
            stdout: command.args?.[0] === "devices" ? "List of devices attached\n" : isState ? (running ? "device\n" : "") : command.args?.includes("sys.boot_completed") ? "1\n" : "original raw output\n",
            stderr: isState && !running ? "device not found" : "" };
    };
    try {
        // Genuine emitted broker, existing authenticated owner/native fixture.
        // A structural boundary avoids pulling native JS into core checkJs.
        const brokerUrl = pathToFileURL(join(project, "packages/device-lab/dist/device-lab-broker.js")).href;
        const ownerUrl = pathToFileURL(join(project, "packages/device-lab/dist/device-lab-owner.js")).href;
        const broker = await import(brokerUrl) as BrokerModule;
        const owner = await import(ownerUrl) as { deviceLabOwnerId(cwd: string): string };
        host = await import(hostFixturePath) as HostFixture;
        const cwd = "/project/android-original-" + basename(fixture.home), ownerId = owner.deviceLabOwnerId(cwd);
        server = broker.createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0,
            providerPaths: { adb: "/fake/adb", emulator: "/fake/emulator", avdmanager: "/fake/avdmanager" },
            commandRunner: (command, options) => {
                if (!["adb", "emulator", "avdmanager", "process-inventory", "host-broker-state"].includes(command.provider)) {
                    denied.provider++; throw Error("DENIED provider " + command.provider);
                }
                calls.push({ command, options }); return effect(command, options);
            },
        });
        const base = await host.listen(server), endpoint = host.ownerRpcEndpoint(base, ownerId), headers = host.ownerRpcHeaders(ownerId);
        const control: BrokerControl = {
            ownerId, home: fixture.home, calls, denied, write: devices => { host!.writeBrokerDevices(ownerId, "android", devices); },
            setRunner: runner => { effect = runner; },
            rpc: async (params, authenticated = true) => {
                const response = await fetch(endpoint, { method: "POST", headers: authenticated ? headers : { "content-type": "application/json" },
                    body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "android-emulator", ...params } }) });
                const result = { status: response.status, body: await response.json() as Record<string, unknown> };
                outcomes.push({ params, result }); return result;
            },
        };
        await check(control);
        expect(denied).toEqual({ provider: 0 });
        expect(readFileSync(sentinel, "utf8")).toBe("unallocated resource retained\n");

    } catch (error) { failures.push(error); }
    finally {
        try { if (server && host) await host.close(server); } catch (error) { failures.push(error); }

        try { restore(); } catch (error) { failures.push(error); }
        try { fixture.remove(); } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, name + ": assertion precedes cleanup failures");
}

describe("Android emulator lifecycle original authenticated broker witnesses", () => {
    it("actual four command bindings preserve defaults, boot/stop observations and publication", async () => {
        await withBroker("broker-four", async c => {
            const deviceId = "android-broker-original-four", avdName = `ccc-${c.ownerId}-original-four`;
            const created = await c.rpc({ command: "device_create", deviceId, name: "Original Four", avdName, port: 5668, systemImage: ANDROID_SYSTEM_IMAGE, deviceProfile: "pixel_6", createAvd: true });
            expect(created).toMatchObject({ status: 200, body: { ok: true, result: { device: { id: deviceId, status: "stopped", headless: true, authority: "host-broker" } } } });
            expect(c.calls.slice(0, 2)).toMatchObject([
                { command: { provider: "adb", args: ["devices", "-l"] }, options: { timeoutMs: 10000 } },
                { command: { provider: "avdmanager", args: ["create", "avd", "--name", avdName, "--package", ANDROID_SYSTEM_IMAGE, "--force", "--device", "pixel_6"], input: "no\n" }, options: { timeoutMs: 300000 } },
            ]);
            const started = await c.rpc({ command: "device_start", deviceId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(started).toMatchObject({ status: 200, body: { ok: true, result: { device: { status: "running", bootReady: true } } } });
            const stopped = await c.rpc({ command: "device_stop", deviceId });
            expect(stopped).toMatchObject({ status: 200, body: { ok: true, result: { device: { status: "stopped", recording: null, bootReady: false } } } });
            expect((stopped.body.result as { device: unknown }).device).not.toHaveProperty("appium");
            const stoppedAgain = await c.rpc({ command: "device_stop", deviceId });
            expect(stoppedAgain).toMatchObject({ status: 200, body: { ok: true, result: { device: { status: "stopped", recording: null } } } });
            const deleted = await c.rpc({ command: "device_delete", deviceId, deleteAvd: false, confirmDestructive: true });
            expect(deleted).toMatchObject({ status: 200, body: { ok: true, result: { device: null } } });
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([]);
            expect(c.calls.some(row => row.command.provider === "emulator" && row.command.mode === "detached")).toBe(true);
            expect(c.calls.some(row => row.command.args?.includes("sys.boot_completed"))).toBe(true);
            // Broker confirms stop with both complete ADB and process inventory;
            // the direct binding separately uses get-state before emu kill.
            expect(c.calls.filter(row => row.command.provider === "process-inventory")).toHaveLength(2);
        });
    });

    it("authentication and odd-port refusal precede provider effects; dry run preserves state", async () => {
        await withBroker("broker-order", async c => {
            const unauthorized = await c.rpc({ command: "device_create", deviceId: "android-auth", name: "Auth", port: 5555 }, false);
            expect(unauthorized.status).toBe(401); expect(c.calls).toEqual([]);
            const invalid = await c.rpc({ command: "device_create", deviceId: "android-invalid", name: "Invalid", port: 5555 });
            expect(invalid).toMatchObject({ status: 400, body: { ok: false, error: "invalid-android-emulator-port", allowed: "even integer 5554-5682" } });
            expect(c.calls).toEqual([]);
            const dryRun = await c.rpc({ command: "device_create", deviceId: "android-dry", name: "Dry", port: 5670, dryRun: true, createAvd: true, systemImage: ANDROID_SYSTEM_IMAGE });
            expect(dryRun).toMatchObject({ status: 200, body: { ok: true } });
            expect(c.calls.some(row => row.command.provider === "avdmanager")).toBe(false);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([]);
        });
    });

    it("create failure retains raw diagnostics and performs owned compensation before publication", async () => {
        await withBroker("broker-compensation", async c => {
            c.setRunner(command => ({ ...command, status: command.provider === "avdmanager" ? 17 : 0,
                stdout: command.provider === "adb" ? "List of devices attached\n" : "raw create stdout", stderr: command.provider === "avdmanager" ? "raw create stderr" : "",
                ...(command.provider === "avdmanager" ? { error: "raw create error" } : {}) }));
            const failed = await c.rpc({ command: "device_create", deviceId: "android-broker-partial", name: "Partial", createAvd: true, systemImage: ANDROID_SYSTEM_IMAGE, port: 5672 });
            expect(failed).toMatchObject({ status: 502, body: { ok: false, error: "provider-command-failed", detail: "error: raw create error\nstderr: raw create stderr\nstdout: raw create stdout", rollback: { ok: true, artifactsRemoved: 0 } } });
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([]);
        });
    });

    it("complete-record CAS preserves a successor written during successful native stop", async () => {
        await withBroker("broker-successor", async c => {
            const deviceId = "android-broker-successor";
            const original = { id: deviceId, backend: "android-emulator", name: "Original", avdName: `ccc-${c.ownerId}-original`, port: 5674, status: "running", extra: { raw: "old" } };
            const successor = { ...original, name: "Successor", status: "stopped", extra: { raw: "successor" }, createdAt: "successor-incarnation" };
            c.write([original]);
            let injected = false;
            c.setRunner(command => {
                if (command.args?.includes("kill")) { c.write([successor]); injected = true; }
                return { ...command, status: command.args?.includes("get-state") ? 1 : 0,
                    stdout: command.args?.[0] === "devices" ? "List of devices attached\n" : "", stderr: command.args?.includes("get-state") ? "device not found" : "" };
            });
            const stopped = await c.rpc({ command: "device_stop", deviceId });
            expect(injected).toBe(true);
            expect(stopped).toMatchObject({ status: 409, body: { ok: false, error: "owner-device-state-conflict" } });
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([successor]);
        });
    });
});
