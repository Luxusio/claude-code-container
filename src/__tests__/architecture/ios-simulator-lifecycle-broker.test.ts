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
    status(): Promise<number>;
    records(): unknown[]; write(records: unknown[]): string; setNative(effect: (command: NativeCommand) => NativeResult): void;
};
async function withHttp(check: (control: HttpControl) => Promise<void>, options: { commandTimeoutMs?: number; now?: () => number } = {}): Promise<void> {
    const home = mkdtempSync(join(tmpdir(), "ccc-ios-broker-lifecycle-"));
    const restore = isolateDeviceLabTestEnvironment(home), errors: unknown[] = [];
    const cwd = join(home, "project"); mkdirSync(cwd);
    const ownerId = deviceLabOwnerId(cwd), calls: HttpControl["calls"] = [], denied = { provider: 0 };
    let server: Server | undefined;
    let effect = (command: NativeCommand): NativeResult => ({ ...command, status: 0, stderr: "",
        stdout: command.args?.[1] === "list" ? JSON.stringify({ devices: { runtime: [{ name: `ccc-${ownerId}-broker`, udid: "created-udid", state: "Shutdown" }] } })
            : command.args?.[1] === "create" ? " created-udid\n" : "raw output\n" });
    try {
        server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, providerPaths: { xcrun: "/allocated/xcrun" },
            ...(options.commandTimeoutMs === undefined ? {} : { commandTimeoutMs: options.commandTimeoutMs }),
            ...(options.now ? { hyperVMonotonicNow: options.now } : {}),
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
            async status() { return (await fetch(`${base}/status`)).status; },
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
                return { ...command, status: 0, stdout: command.args?.[1] === "list" ? JSON.stringify({ devices: { runtime: [{ name: original.simulatorName, udid: original.udid, state: "Shutdown" }] } }) : "raw shutdown", stderr: "" };
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
    it("retains the operation lock and serves HTTP while awaiting native shutdown instead of publishing on exit 0", async () => {
        await withHttp(async c => {
            const original = { id: "ios-broker", backend: "ios-simulator", simulatorName: `ccc-${c.ownerId}-broker`, udid: "created-udid", status: "running" };
            c.write([original]);
            let shutdowns = 0, allowShutdown = false;
            let observedBooted!: () => void;
            const firstBooted = new Promise<void>(resolve => { observedBooted = resolve; });
            c.setNative(command => {
                if (command.args?.[1] === "shutdown") shutdowns++;
                if (command.args?.[1] === "list" && shutdowns > 0 && !allowShutdown) observedBooted();
                return { ...command, status: 0, stderr: "", stdout: command.args?.[1] === "list"
                    ? JSON.stringify({ devices: { runtime: [{ name: original.simulatorName, udid: original.udid, state: shutdowns > 0 && allowShutdown ? "Shutdown" : "Booted" }] } }) : "" };
            });
            const firstStop = c.invoke({ command: "device_stop", deviceId: original.id });
            let queuedStop: Promise<RpcResult> | undefined;
            try {
                await Promise.race([firstBooted, firstStop.then(() => { throw new Error("stop settled before observing native Booted"); })]);
                expect(c.records()).toEqual([original]);
                expect(await c.status()).toBe(200);
                queuedStop = c.invoke({ command: "device_stop", deviceId: original.id });
                expect(await c.status()).toBe(200);
                expect(shutdowns).toBe(1);
                expect(c.records()).toEqual([original]);
                allowShutdown = true;
                expect(await firstStop).toMatchObject({ status: 200, payload: { result: { device: { status: "stopped" }, shutdown: { ok: true, lastState: "Shutdown" } } } });
                expect(await queuedStop).toMatchObject({ status: 200 });
                expect(shutdowns).toBe(2);
                expect(c.calls.filter(call => call.command.args?.[1] === "shutdown").every(call => JSON.stringify(call.command.args) === JSON.stringify(["simctl", "shutdown", original.udid]))).toBe(true);
            } finally {
                allowShutdown = true;
                await Promise.allSettled([firstStop, ...(queuedStop ? [queuedStop] : [])]);
            }
        });
    }, 30000);
    it.each(["native-failure", "malformed-json", "missing", "duplicate", "renamed", "missing-state", "unexpected-state", "name-selected-replacement"])(
        "refuses stopped publication for %s after successful shutdown without exposing raw inventory diagnostics", async mode => {
            await withHttp(async c => {
                const original = { id: "ios-broker", backend: "ios-simulator", simulatorName: `ccc-${c.ownerId}-broker`,
                    ...(mode === "name-selected-replacement" ? {} : { udid: "created-udid" }), status: "running" };
                c.write([original]); let shutdowns = 0;
                c.setNative(command => {
                    if (command.args?.[1] === "shutdown") shutdowns++;
                    if (command.args?.[1] !== "list") return { ...command, status: 0, stdout: "", stderr: "" };
                    let host: Record<string, unknown> = { name: original.simulatorName, udid: "created-udid", state: "Shutdown" };
                    let hosts: Record<string, unknown>[] = [host];
                    if (shutdowns > 0) {
                        if (mode === "native-failure") return { ...command, status: 7, stdout: "PRIVATE-INVENTORY-STDOUT", stderr: "PRIVATE-INVENTORY-STDERR", error: "PRIVATE-INVENTORY-ERROR" };
                        if (mode === "malformed-json") return { ...command, status: 0, stdout: "PRIVATE-INVENTORY-MALFORMED", stderr: "" };
                        if (mode === "missing") hosts = [];
                        if (mode === "duplicate") hosts = [host, { ...host }];
                        if (mode === "renamed") host.name = `ccc-${c.ownerId}-different-target`;
                        if (mode === "missing-state") delete host.state;
                        if (mode === "unexpected-state") host.state = "Booting";
                        if (mode === "name-selected-replacement") host.udid = "replacement-udid";
                    }
                    return { ...command, status: 0, stdout: JSON.stringify({ devices: { runtime: hosts } }), stderr: "" };
                });
                const failed = await c.invoke({ command: "device_stop", deviceId: original.id });
                expect(failed).toMatchObject({ status: 502, payload: { ok: false, error: "ios-simulator-shutdown-not-confirmed",
                    result: { recoveryRequired: true, shutdown: { ok: false, reason: "observation-failed" }, execution: { command: { status: 0 } } } } });
                expect(shutdowns).toBe(1); expect(c.records()).toEqual([original]);
                expect(JSON.stringify(failed.payload)).not.toContain("PRIVATE-INVENTORY");
                expect(c.calls.filter(call => call.command.args?.[1] === "shutdown").map(call => call.command.args)).toEqual([["simctl", "shutdown", "created-udid"]]);
            });
        }, 30000,
    );
    it("keeps a native shutdown failure distinct and performs no post-shutdown inventory", async () => {
        await withHttp(async c => {
            const original = { id: "ios-broker", backend: "ios-simulator", simulatorName: `ccc-${c.ownerId}-broker`, udid: "created-udid", status: "running" };
            c.write([original]); let shutdownCalled = false, inventoryAfterShutdown = 0;
            c.setNative(command => {
                if (command.args?.[1] === "shutdown") { shutdownCalled = true; return { ...command, status: 7, stdout: "", stderr: "native shutdown failed" }; }
                if (shutdownCalled && command.args?.[1] === "list") inventoryAfterShutdown++;
                return { ...command, status: 0, stdout: JSON.stringify({ devices: { runtime: [{ name: original.simulatorName, udid: original.udid, state: "Booted" }] } }), stderr: "" };
            });
            const failed = await c.invoke({ command: "device_stop", deviceId: original.id });
            expect(failed).toMatchObject({ status: 502, payload: { error: "provider-command-failed", result: { execution: { command: { status: 7 } } } } });
            expect((failed.payload.result as Record<string, unknown>)).not.toHaveProperty("shutdown");
            expect(inventoryAfterShutdown).toBe(0); expect(c.records()).toEqual([original]);
        });
    }, 30000);
    it("rejects a late native Shutdown while retaining the original exit 0 and unmodified record", async () => {
        let clock = 0;
        await withHttp(async c => {
            const original = { id: "ios-broker", backend: "ios-simulator", simulatorName: `ccc-${c.ownerId}-broker`, udid: "created-udid", status: "running" };
            c.write([original]); let shutdownCalled = false;
            c.setNative(command => {
                if (command.args?.[1] === "shutdown") { shutdownCalled = true; clock += 40; }
                else if (shutdownCalled && command.args?.[1] === "list") clock += 60;
                return { ...command, status: 0, stderr: "", stdout: command.args?.[1] === "list" ? JSON.stringify({ devices: { runtime: [{ name: original.simulatorName, udid: original.udid, state: "Shutdown" }] } }) : "" };
            });
            expect(await c.invoke({ command: "device_stop", deviceId: original.id })).toMatchObject({ status: 502, payload: { error: "ios-simulator-shutdown-not-confirmed", result: { shutdown: { ok: false, reason: "timed-out" }, execution: { command: { status: 0 } } } } });
            expect(c.records()).toEqual([original]);
            const shutdownIndex = c.calls.findIndex(call => call.command.args?.[1] === "shutdown");
            expect(c.calls[shutdownIndex].timeoutMs).toBe(100);
            expect(c.calls[shutdownIndex + 1].timeoutMs).toBe(60);
        }, { commandTimeoutMs: 100, now: () => clock });
    }, 30000);
});
