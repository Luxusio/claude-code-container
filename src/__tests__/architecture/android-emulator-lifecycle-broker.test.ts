import type { Server } from "node:http";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { ANDROID_SYSTEM_IMAGE, androidRawState, androidStatePath, privateBrokerHome } from "../helpers/android-emulator-lifecycle-fixture.js";

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
    cleanup(): Promise<Rpc>;
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
            cleanup: async () => {
                const response = await fetch(endpoint, { method: "POST", headers,
                    body: JSON.stringify({ method: "broker.cleanup.owner", params: { backend: "android-emulator", stopDevices: true } }) });
                return { status: response.status, body: await response.json() as Record<string, unknown> };
            },
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
            // the direct binding independently confirms its native stop facts.
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

    it.each([
        ["missing header", { stdout: "emulator-5668 offline\n" }],
        ["inexact header", { stdout: "List of devices attached extra\n" }],
        ["timed out", { stdout: "List of devices attached\n", timedOut: true }],
        ["output limited", { stdout: "List of devices attached\n", outputLimitExceeded: true }],
        ["native error at status zero", { stdout: "List of devices attached\n", error: "inventory failed" }],
    ] as const)("refuses %s native stop inventory before process observation and publication", async (_label, inventory) => {
        await withBroker("broker-inventory-refusal", async c => {
            const original = { id: "android-inventory-refusal", backend: "android-emulator", avdName: `ccc-${c.ownerId}-inventory-refusal`, port: 5668, status: "running" };
            c.write([original]);
            c.setRunner(command => ({ ...command, status: 0, stderr: "",
                ...(command.args?.[0] === "devices" ? inventory : { stdout: "" }) }));
            const result = await c.rpc({ command: "device_stop", deviceId: original.id });
            expect(result).toMatchObject({ status: 502, body: { ok: false, error: "android-emulator-stop-unconfirmed", detail: "inventory-unavailable" } });
            expect(c.calls.filter(row => row.command.args?.[0] === "devices")).toHaveLength(1);
            expect(c.calls.some(row => row.command.provider === "process-inventory")).toBe(false);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([original]);
        });
    });

    it("keeps an offline serial present until a later complete exact-header inventory omits it", async () => {
        await withBroker("broker-offline-inventory", async c => {
            const original = { id: "android-offline-inventory", backend: "android-emulator", avdName: `ccc-${c.ownerId}-offline-inventory`, port: 5670, status: "running" };
            let inventories = 0;
            c.write([original]);
            c.setRunner(command => ({ ...command, status: 0, stderr: "",
                stdout: command.args?.[0] === "devices"
                    ? ++inventories === 1 ? "  List of devices attached  \r\nemulator-5670 offline\r\n" : "List of devices attached\nemulator-5670-other offline\n"
                    : "" }));
            const result = await c.rpc({ command: "device_stop", deviceId: original.id });
            expect(result).toMatchObject({ status: 200, body: { ok: true, result: { device: { status: "stopped" } } } });
            expect(inventories).toBe(2);
            expect(c.calls.filter(row => row.command.args?.[0] === "devices").map(row => row.options.timeoutMs)).toEqual([10000, 10000]);
            expect(c.calls.filter(row => row.command.provider === "process-inventory")).toHaveLength(2);
        });
    });

    it.each([undefined, true])("replays native boot deadline evidence without adding semantic fields (timedOut=%s)", async timedOut => {
        await withBroker("broker-boot-deadline", async c => {
            const original = { id: "android-boot-deadline", backend: "android-emulator", avdName: `ccc-${c.ownerId}-boot-deadline`, port: 5672, status: "stopped" };
            c.write([original]);
            c.setRunner(command => ({ ...command, status: 0, stderr: "native boot stderr",
                stdout: command.args?.[0] === "devices" ? "List of devices attached\n" : command.args?.includes("sys.boot_completed") ? "0\n" : "",
                ...(command.args?.includes("sys.boot_completed") ? { executable: "/native/adb", pid: 2718, signal: "SIGTERM", outputLimitExceeded: true,
                    ...(timedOut === undefined ? {} : { timedOut }) } : {}) }));
            const result = await c.rpc({ command: "device_start", deviceId: original.id, waitForBoot: true, bootTimeoutMs: 1000 });
            const error = `Timed out waiting for Android emulator emulator-${original.port} to boot`;
            expect(result).toMatchObject({ status: 502, body: { ok: false, result: {
                boot: { ready: false, skipped: false, provider: "adb", error: { mode: "exec", provider: "adb", status: 0, stdout: "0\n", stderr: "native boot stderr", error, executable: "/native/adb", pid: 2718, signal: "SIGTERM", outputLimitExceeded: true } },
                execution: { command: { androidBoot: { ok: false, ready: false, error: { error } } } },
            } } });
            const payload = result.body.result as { boot: { error: Record<string, unknown> }; execution: { command: { androidBoot: Record<string, unknown> & { attempts: Record<string, unknown>[] } } } };
            for (const field of ["ok", "available", "serialPresent", "ready", "receipt"]) expect(payload.boot.error).not.toHaveProperty(field);
            const attempts = payload.execution.command.androidBoot.attempts;
            // Native pacing may wake before a fractional deadline; only retained evidence is bounded.
            expect(attempts.length).toBeGreaterThan(0); expect(attempts.length).toBeLessThanOrEqual(8);
            for (const attempt of attempts) {
                expect(attempt).toMatchObject({ mode: "exec", provider: "adb", executable: "/native/adb",
                    args: ["-s", `emulator-${original.port}`, "shell", "getprop", "sys.boot_completed"],
                    status: 0, stdout: "0\n", stderr: "native boot stderr", pid: 2718, signal: "SIGTERM", outputLimitExceeded: true });
                for (const field of ["ok", "available", "serialPresent", "ready", "receipt"]) expect(attempt).not.toHaveProperty(field);
                if (timedOut === undefined) expect(attempt).not.toHaveProperty("timedOut");
                else expect(attempt.timedOut).toBe(true);
            }
            for (const field of ["reason", "serial", "last"]) expect(payload.execution.command.androidBoot).not.toHaveProperty(field);
            if (timedOut === undefined) expect(payload.boot.error).not.toHaveProperty("timedOut");
            else expect(payload.boot.error.timedOut).toBe(true);
            expect(result).toHaveProperty("body.result.execution.mutatesHost", true);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([expect.objectContaining({ ...original, status: "starting",
                lifecycle: { runtimeId: expect.any(String), operation: "start", claimedAt: expect.any(String) } })]);
        });
    });

    it.each([true, false])("retains a timed-out start for fresh owner cleanup; confirmed stop=%s", async confirmed => {
        await withBroker("broker-start-recovery", async c => {
            const original = { id: "android-recoverable", backend: "android-emulator", avdName: `ccc-${c.ownerId}-recoverable`, port: 5672, status: "stopped",
                preferences: { keep: "original" }, ssh: { password: "android-recovery-secret" } };
            c.write([original]);
            c.setRunner(command => ({ ...command, status: 0, stderr: "", stdout: command.args?.[0] === "devices" ? "List of devices attached\n" : command.args?.includes("sys.boot_completed") ? "0\n" : "" }));
            const failed = await c.rpc({ command: "device_start", deviceId: original.id, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(failed).toMatchObject({ status: 502, body: { ok: false, result: { device: { status: "starting" }, execution: { mutatesHost: true } } } });
            const pending = androidRawState(c.home, c.ownerId).devices[0];
            expect(pending).toMatchObject({ ...original, status: "starting", lifecycle: { runtimeId: expect.any(String), operation: "start", claimedAt: expect.any(String) } });
            expect(JSON.stringify(failed.body)).not.toContain("android-recovery-secret");
            const launchCount = c.calls.filter(row => row.command.provider === "emulator").length;
            const repeated = await c.rpc({ command: "device_start", deviceId: original.id, waitForBoot: false });
            expect(repeated.status).toBe(409);
            expect(c.calls.filter(row => row.command.provider === "emulator")).toHaveLength(launchCount);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([pending]);
            c.setRunner(command => ({ ...command, status: command.args?.includes("kill") && !confirmed ? 7 : 0, stderr: "",
                stdout: command.args?.[0] === "devices" ? `List of devices attached\n${confirmed ? "" : "emulator-5672 device\n"}` : "" }));
            const cleanup = await c.cleanup();
            expect(cleanup).toMatchObject({ status: 200, body: { ok: confirmed, result: { failed: confirmed ? 0 : 1 } } });
            expect(c.calls.filter(row => row.command.args?.includes("kill"))).toHaveLength(1);
            if (confirmed) {
                expect(androidRawState(c.home, c.ownerId).devices[0]).toMatchObject({ id: original.id, status: "stopped", preferences: original.preferences });
                expect(androidRawState(c.home, c.ownerId).devices[0].lifecycle ?? null).toBeNull();
                c.setRunner(command => { if (command.provider === "emulator") throw Error("second-owned-launch"); return { ...command, status: 0, stdout: "List of devices attached\n", stderr: "" }; });
                await c.rpc({ command: "device_start", deviceId: original.id, waitForBoot: false });
                expect((androidRawState(c.home, c.ownerId).devices[0].lifecycle as {runtimeId: string}).runtimeId).not.toBe((pending.lifecycle as {runtimeId: string}).runtimeId);
            } else expect(androidRawState(c.home, c.ownerId).devices).toEqual([pending]);
        });
    });

    it("redacts an unknown native start throw while retaining dispatched recovery facts", async () => {
        await withBroker("broker-start-throw", async c => {
            const original = { id: "android-start-throw", backend: "android-emulator", avdName: `ccc-${c.ownerId}-throw`, port: 5672, status: "stopped" };
            c.write([original]);
            c.setRunner(command => { if (command.provider === "emulator") throw Error("private-native-launch-secret"); return { ...command, status: 0, stdout: "List of devices attached\n", stderr: "" }; });
            const result = await c.rpc({ command: "device_start", deviceId: original.id, waitForBoot: false });
            expect(result).toMatchObject({ status: 502, body: { ok: false, result: { device: { status: "starting" }, invoked: true, execution: { mutatesHost: true } } } });
            expect(JSON.stringify(result.body)).not.toContain("private-native-launch-secret");
            expect(result.body).not.toHaveProperty("cause");
            expect(androidRawState(c.home, c.ownerId).devices[0]).toHaveProperty("lifecycle.operation", "start");
        });
    });

    it.each([["invalid", 409, "owner-devices-state-invalid"], ["large", 413, "owner-devices-file-too-large"]] as const)("keeps known %s reservation status before detached launch", async (fault, status, error) => {
        await withBroker("broker-start-reservation-error", async c => {
            const secret = "private-android-reservation-secret";
            const original = {id: "android-reservation-error", backend: "android-emulator", avdName: `ccc-${c.ownerId}-reservation-error`, port: 5672, status: "stopped", ssh: {password: secret}};
            c.write([original]);
            const path = androidStatePath(c.home, c.ownerId), poisoned = fault === "invalid" ? "{" + secret : secret + " ".repeat(256 * 1024 + 1);
            c.setRunner(command => {
                if (command.provider === "adb" && command.args?.[0] === "devices") writeFileSync(path, poisoned);
                return {...command, status: 0, stdout: "List of devices attached\n", stderr: ""};
            });
            const result = await c.rpc({command: "device_start", deviceId: original.id, waitForBoot: false});
            expect(result).toMatchObject({status, body: {ok: false, error, result: {invoked: false, execution: {mutatesHost: false}}}});
            expect(c.calls.filter(row => row.command.provider === "emulator")).toEqual([]);
            expect(c.calls.filter(row => row.command.provider === "adb" && row.command.args?.[0] === "devices")).toHaveLength(1);
            expect(readFileSync(path, "utf8")).toBe(poisoned);
            expect(result.body).not.toHaveProperty("cause");
            expect(JSON.stringify(result.body)).not.toContain(secret);
            expect(JSON.stringify(result.body)).not.toContain(c.home);
        });
    });

    it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("keeps known unreadable reservation status503 before detached launch", async () => {
        await withBroker("broker-start-reservation-unreadable", async c => {
            const secret = "private-android-unreadable-reservation-secret";
            const original = {id: "android-reservation-unreadable", backend: "android-emulator", avdName: `ccc-${c.ownerId}-reservation-unreadable`, port: 5672, status: "stopped", ssh: {password: secret}};
            c.write([original]);
            const path = androidStatePath(c.home, c.ownerId), before = readFileSync(path, "utf8");
            c.setRunner(command => {
                if (command.provider === "adb" && command.args?.[0] === "devices") chmodSync(path, 0);
                return {...command, status: 0, stdout: "List of devices attached\n", stderr: ""};
            });
            try {
                const result = await c.rpc({command: "device_start", deviceId: original.id, waitForBoot: false});
                expect(result).toMatchObject({status: 503, body: {ok: false, error: "owner-devices-state-read-failed", result: {invoked: false, execution: {mutatesHost: false}}}});
                expect(c.calls.filter(row => row.command.provider === "emulator")).toEqual([]);
                expect(c.calls.filter(row => row.command.provider === "adb" && row.command.args?.[0] === "devices")).toHaveLength(1);
                expect(result.body).not.toHaveProperty("cause");
                expect(JSON.stringify(result.body)).not.toContain(secret);
                expect(JSON.stringify(result.body)).not.toContain(c.home);
            } finally {chmodSync(path, 0o600);}
            expect(readFileSync(path, "utf8")).toBe(before);
        });
    });

    it("rejects legitimate near-limit reservation growth with413 and no detached launch", async () => {
        await withBroker("broker-start-reservation-growth", async c => {
            const secret = "private-android-reservation-growth-secret", limit = 256 * 1024;
            const original = {id: "android-reservation-growth", backend: "android-emulator", avdName: `ccc-${c.ownerId}-reservation-growth`, port: 5672, status: "stopped", ssh: {password: secret}};
            const sibling = {id: "unrelated-padding", status: "stopped", padding: ""};
            const records = [original, sibling];
            sibling.padding = "x".repeat(limit - 16 - Buffer.byteLength(JSON.stringify({devices: records}, null, 2)));
            expect(Buffer.byteLength(JSON.stringify({devices: records}, null, 2))).toBe(limit - 16);
            c.write(records);
            const path = androidStatePath(c.home, c.ownerId), before = readFileSync(path, "utf8");
            const result = await c.rpc({command: "device_start", deviceId: original.id, waitForBoot: false});
            expect(result).toMatchObject({status: 413, body: {ok: false, error: "owner-devices-file-too-large", result: {invoked: false, execution: {mutatesHost: false}}}});
            expect(c.calls.filter(row => row.command.provider === "emulator")).toEqual([]);
            expect(readFileSync(path, "utf8")).toBe(before);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual(records);
            expect(result.body).not.toHaveProperty("cause");
            expect(JSON.stringify(result.body)).not.toContain(secret);
        });
    });

    it.each([["invalid", 409, "owner-devices-state-invalid"], ["large", 413, "owner-devices-file-too-large"]] as const)("keeps known %s publication status with partial launch evidence", async (fault, status, error) => {
        await withBroker("broker-start-state-error", async c => {
            const original = { id: "android-start-state-error", backend: "android-emulator", avdName: `ccc-${c.ownerId}-state-error`, port: 5672, status: "stopped" };
            c.write([original]);
            c.setRunner(command => {
                if (command.provider === "emulator") {
                    const path = androidStatePath(c.home, c.ownerId);
                    writeFileSync(path, fault === "invalid" ? "{" : " ".repeat(256 * 1024 + 1));
                }
                return { ...command, status: 0, stdout: "List of devices attached\n", stderr: "" };
            });
            const result = await c.rpc({ command: "device_start", deviceId: original.id, waitForBoot: false });
            expect(result).toMatchObject({ status, body: { ok: false, error, result: { invoked: true, execution: { mutatesHost: true } } } });
            expect(c.calls.filter(row => row.command.args?.includes("kill"))).toEqual([]);
        });
    });
    it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("keeps known unreadable publication status503 with partial launch evidence", async () => {
        await withBroker("broker-start-state-unreadable", async c => {
            const original = {id: "android-start-unreadable", backend: "android-emulator", avdName: `ccc-${c.ownerId}-unreadable`, port: 5672, status: "stopped"};
            c.write([original]);
            const path = androidStatePath(c.home, c.ownerId);
            c.setRunner(command => {
                if (command.provider === "emulator") chmodSync(path, 0);
                return {...command, status: 0, stdout: "List of devices attached\n", stderr: ""};
            });
            try {
                expect(await c.rpc({command: "device_start", deviceId: original.id, waitForBoot: false})).toMatchObject({status: 503, body: {ok: false,
                    error: "owner-devices-state-read-failed", result: {invoked: true, execution: {mutatesHost: true}}}});
                expect(c.calls.filter(row => row.command.args?.includes("kill"))).toEqual([]);
            } finally {chmodSync(path, 0o600);}
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

    it("redacts an existing device when a native create races its identity claim", async () => {
        await withBroker("broker-claim-redaction", async c => {
            const avdName = `ccc-${c.ownerId}-claim-conflict`, password = "fixture-private-android-password";
            const existing = { id: "android-retained", backend: "android-emulator", avdName, status: "stopped",
                privateRoot: join(c.home, "retained-private"), ssh: { user: "guest", password } };
            c.setRunner(command => {
                if (command.provider === "avdmanager" && command.args?.[0] === "create") c.write([existing]);
                return { ...command, status: 0, stdout: command.provider === "adb" ? "List of devices attached\n" : "", stderr: "" };
            });
            const result = await c.rpc({ command: "device_create", deviceId: "android-new", name: "New", avdName,
                port: 5676, createAvd: true, systemImage: ANDROID_SYSTEM_IMAGE });
            expect(result).toMatchObject({ status: 409, body: { ok: false, error: "owner-device-identity-conflict",
                existing: { id: existing.id, ssh: { user: "guest", passwordConfigured: true } } } });
            expect(result.body.existing).not.toHaveProperty("privateRoot");
            expect(result.body.existing).not.toHaveProperty("ssh.password");
            expect(JSON.stringify(result.body)).not.toContain(password);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([existing]);
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
            expect(stopped.body).toHaveProperty("result.auxiliaryCleanup.ok", true);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([successor]);
        });
    });

    it("retains successful boot evidence when start cannot publish over a successor", async () => {
        await withBroker("broker-start-successor", async c => {
            const deviceId = "android-start-successor";
            const original = { id: deviceId, backend: "android-emulator", avdName: `ccc-${c.ownerId}-boot-successor`,
                port: 5678, status: "stopped" };
            const successor = { ...original, generation: "successor" };
            c.write([original]);
            c.setRunner(command => {
                if (command.provider === "emulator") c.write([successor]);
                return { ...command, status: 0,
                    stdout: command.args?.[0] === "devices" ? "List of devices attached\n" : command.args?.includes("sys.boot_completed") ? "1\n" : "",
                    stderr: "", ...(command.args?.includes("sys.boot_completed") ? { timedOut: true, outputLimitExceeded: true, pid: 31337 } : {}) };
            });
            const result = await c.rpc({ command: "device_start", deviceId, waitForBoot: true, bootTimeoutMs: 1000 });
            expect(result).toMatchObject({ status: 409, body: { ok: false, error: "owner-device-state-conflict",
                result: { device: successor, boot: { ready: true, provider: "adb", result: { status: 0, stdout: "1\n" } } } } });
            const boot = (result.body.result as { boot: { result: Record<string, unknown> } }).boot.result;
            expect(boot).toMatchObject({ status: 0, timedOut: true, outputLimitExceeded: true, pid: 31337 });
            for (const field of ["ok", "available", "serialPresent", "ready", "receipt"]) expect(boot).not.toHaveProperty(field);
            expect(androidRawState(c.home, c.ownerId).devices).toEqual([successor]);
        });
    });
});
