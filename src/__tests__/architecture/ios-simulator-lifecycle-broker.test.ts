import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { backendRoot, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "../helpers/host-broker-test-fixture.js";
import { createDeviceBrokerServer } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";

type NativeCommand = { mode: string; provider: string; executable?: string; args?: string[]; [key: string]: unknown };
type NativeResult = NativeCommand & { status: number; stdout: string; stderr: string; error?: string };
type RpcResult = { status: number; payload: Record<string, unknown> };
type HttpControl = {
    home: string; ownerId: string; calls: Array<{ command: NativeCommand; timeoutMs: number; outputLimit: number }>;
    denied: { provider: number }; invoke(params: Record<string, unknown>, authenticated?: boolean): Promise<RpcResult>;
    records(): unknown[]; write(records: unknown[]): string; setNative(effect: (command: NativeCommand) => NativeResult): void;
};
async function withHttp(check: (control: HttpControl) => Promise<void>): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "ccc-ios-broker-lifecycle-"));
    const restore = isolateDeviceLabTestEnvironment(home), errors: unknown[] = [];
    const cwd = join(home, "project"); mkdirSync(cwd);
    const ownerId = deviceLabOwnerId(cwd), calls: HttpControl["calls"] = [], denied = { provider: 0 };
    let server: Server | undefined;
    let effect = (command: NativeCommand): NativeResult => ({ ...command, status: 0, stderr: "",
        stdout: command.args?.[1] === "list" ? JSON.stringify({ devices: { runtime: [{ name: `ccc-${ownerId}-broker`, udid: "created-udid" }] } })
            : command.args?.[1] === "create" ? " created-udid\n" : "raw output\n" });
    try {
        server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, providerPaths: { xcrun: "/allocated/xcrun" },
            commandRunner(command, options) {
                if (!["xcrun", "simctl", "host-broker-state"].includes(command.provider)) { denied.provider++; throw Error("DENIED native provider"); }
                calls.push({ command, ...options }); return effect(command);
            },
        });
        const base = await listen(server), endpoint = ownerRpcEndpoint(base, ownerId), headers = ownerRpcHeaders(ownerId);
        const root = backendRoot(ownerId, "ios"), records = () => existsSync(join(root, "devices.json"))
            ? (JSON.parse(readFileSync(join(root, "devices.json"), "utf8")) as { devices: unknown[] }).devices : [];
        const controller: HttpControl = { home, ownerId, calls, denied, records,
            write: value => join(writeBrokerDevices(ownerId, "ios", value), "devices.json"), setNative: value => { effect = value; },
            async invoke(params, authenticated = true) {
                const response = await fetch(endpoint, { method: "POST", headers: authenticated ? headers : { "content-type": "application/json" },
                    body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "ios-simulator", ...params } }) });
                const payload = await response.json() as Record<string, unknown>;
                expect(denied).toEqual({ provider: 0 }); return { status: response.status, payload };
            },
        };
        expect(calls).toEqual([]); expect(denied).toEqual({ provider: 0 });
        await check(controller); expect(denied).toEqual({ provider: 0 });
    } catch (error) { errors.push(error); }
    finally {
        try { if (server) await close(server); } catch (error) { errors.push(error); }
        try { restore(); } catch (error) { errors.push(error); }
        try { rmSync(home, { recursive: true, force: true }); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "iOS assertion precedes owned listener/home teardown errors");
}

describe("iOS authenticated broker lifecycle", () => {
    it("dispatches four operations with broker-only defaults, auth, dry-run and duplicate classification", async () => {
        await withHttp(async c => {
            const create = { command: "device_create", deviceId: "ios-broker", name: "Broker", createSimulator: true, deviceType: "phone-type", runtime: "runtime-id" };
            expect((await c.invoke(create, false)).status).toBe(401); expect(c.calls).toEqual([]);
            const dry = await c.invoke({ ...create, dryRun: true }); expect(dry).toMatchObject({ status: 200, payload: { result: { invoked: false, dryRun: true } } });
            expect(c.records()).toEqual([]); expect(c.calls).toEqual([]);
            const created = await c.invoke(create); expect(created).toMatchObject({ status: 200, payload: { result: { device: { id: "ios-broker", udid: "created-udid", authority: "host-broker", status: "stopped" } } } });
            expect(c.calls[0]).toMatchObject({ command: { provider: "simctl", args: ["simctl", "create", `ccc-${c.ownerId}-broker`, "phone-type", "runtime-id"] }, timeoutMs: 5000, outputLimit: 32768 });
            expect((await c.invoke(create)).status).toBe(409);
            const start = await c.invoke({ command: "device_start", deviceId: "ios-broker", waitForBoot: true });
            expect(start).toMatchObject({ status: 200, payload: { result: { device: { status: "running" }, invoked: true } } });
            expect(c.calls.some(row => row.command.args?.includes("bootstatus"))).toBe(false);
            expect(await c.invoke({ command: "device_stop", deviceId: "ios-broker" })).toMatchObject({ status: 200, payload: { result: { device: { status: "stopped" }, invoked: true } } });
            const before = c.calls.length;
            expect(await c.invoke({ command: "device_stop", deviceId: "ios-broker" })).toMatchObject({ status: 200, payload: { result: { invoked: true, execution: { mode: "exec" } } } });
            expect(c.calls.length).toBeGreaterThan(before);
            expect(await c.invoke({ command: "device_delete", deviceId: "ios-broker", confirmDestructive: true })).toMatchObject({ status: 200, payload: { result: { device: null } } });
            expect(c.records()).toEqual([]);
        });
    }, 30000);
    it("uses real owner/simulator guard before boot and real full-record CAS after shutdown", async () => {
        await withHttp(async c => {
            const original = { id: "ios-broker", backend: "ios-simulator", simulatorName: `ccc-${c.ownerId}-broker`, udid: "created-udid", status: "running", extra: { raw: "old" } };
            c.write([{ ...original, simulatorName: "foreign-simulator" }]);
            const denied = await c.invoke({ command: "device_start", deviceId: original.id });
            expect(denied).toMatchObject({ status: 400, payload: { error: "ios-simulator-not-owner-scoped" } }); expect(c.calls).toEqual([]);
            c.write([original]); const winner = { ...original, name: "Successor", extra: { raw: "winner" } };
            c.setNative(command => {
                if (command.args?.[1] === "shutdown") c.write([winner]);
                return { ...command, status: 0, stdout: command.args?.[1] === "list" ? JSON.stringify({ devices: { runtime: [{ name: original.simulatorName, udid: original.udid }] } }) : "raw shutdown", stderr: "" };
            });
            expect(await c.invoke({ command: "device_stop", deviceId: original.id })).toMatchObject({ status: 409, payload: { error: "owner-device-state-conflict", result: { invoked: true } } });
            expect(c.records()).toEqual([winner]);
        });
    }, 30000);
    it("executes actual malformed/linked native-state guards without provider effects", async () => {
        await withHttp(async c => {
            const file = c.write([]); writeFileSync(file, "malformed raw owner file");
            expect((await c.invoke({ command: "device_start", deviceId: "ios-broker" })).status).toBeGreaterThanOrEqual(400); expect(c.calls).toEqual([]);
            const target = join(c.home, "allocated-external-state.json"); writeFileSync(target, '{"devices":[]}');
            rmSync(file); symlinkSync(target, file);
            expect((await c.invoke({ command: "device_start", deviceId: "ios-broker" })).status).toBeGreaterThanOrEqual(400); expect(c.calls).toEqual([]);
            expect(readFileSync(target, "utf8")).toBe('{"devices":[]}');
        });
    }, 30000);
});
