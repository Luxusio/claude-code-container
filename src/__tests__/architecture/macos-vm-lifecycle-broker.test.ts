import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as crypto from "crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeviceBrokerServer, type BrokerProcessTreeCleanup, type DeviceBrokerOptions } from "../../../packages/device-lab/src/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { backendRoot, close, listen, ownerRpcEndpoint, ownerRpcHeaders, writeBrokerDevices } from "../helpers/host-broker-test-fixture.js";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { withSharedMutationLockAsync } from "@ccc/device-lab/providers/state/shared-mutation-lock.mjs";

vi.mock("os", async original => ({ ...await original<typeof import("node:os")>(), totalmem: () => 64 * 1024 ** 3, freemem: () => 48 * 1024 ** 3 }));
vi.mock("crypto", async original => ({ ...await original<typeof import("crypto")>() }));
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
async function start(runner?: NonNullable<DeviceBrokerOptions["commandRunner"]>, options: Partial<DeviceBrokerOptions> = {}) {
    server = createDeviceBrokerServer({ cwd: home, host: "127.0.0.1", port: 0, platform: "darwin", providerPaths: { tart: "/fixture/tart", vz: "/fixture/vz", utmctl: "/fixture/utmctl" }, commandRunner: runner, ...options });
    return listen(server);
}
async function invoke(base: string, command: string, extra: Record<string, unknown> = {}, authenticated = true) {
    const response = await fetch(ownerRpcEndpoint(base, owner), {
        method: "POST", headers: authenticated ? ownerRpcHeaders(owner) : { "content-type": "application/json" },
        body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "macos-vm", command, ...(command === "device_create" ? {} : { deviceId: "unit" }), ...extra } }),
    });
    return { status: response.status, body: await response.json() };
}
async function cleanup(base: string) {
    const response = await fetch(ownerRpcEndpoint(base, owner), { method: "POST", headers: ownerRpcHeaders(owner),
        body: JSON.stringify({ method: "broker.cleanup.owner", params: { backend: "macos-vm", stopDevices: true } }) });
    return { status: response.status, body: await response.json() };
}
const successfulRunner = (): NonNullable<DeviceBrokerOptions["commandRunner"]> => command => ({ ...command, status: 0, stdout: "", stderr: "" });
describe("authenticated macOS broker lifecycle", () => {
    it("regression: Tart image clone receives a provisioning budget through the authenticated dispatcher", async () => {
        const runner = vi.fn(successfulRunner()), base = await start(runner);
        const created = await invoke(base, "device_create", { name: "Cold image clone", provider: "tart", image: "base-image" });
        expect(created.status).toBe(200);
        expect(runner).toHaveBeenCalledOnce();
        expect(runner.mock.calls[0][0]).toMatchObject({ provider: "tart", args: ["clone", "base-image", expect.any(String)] });
        expect(runner.mock.calls[0][1]).toMatchObject({ timeoutMs: 600000 });
        expect(devices()[0]).toMatchObject({ provider: "tart", status: "stopped" });
    });

    it.each([undefined, "auto"])("regression: default or automatic Tart provider gets clone provisioning time (%s)", async provider => {
        const runner = vi.fn(successfulRunner()), base = await start(runner);
        const result = await invoke(base, "device_create", { name: "Default clone", image: "base-image", ...(provider === undefined ? {} : { provider }) });
        expect(result.status).toBe(200);
        expect(runner.mock.calls[0][1]).toMatchObject({ timeoutMs: 600000 });
        expect(devices()[0]).not.toHaveProperty("requestTimeoutMs");
        expect(devices()[0]).not.toHaveProperty("remainingMs");
    });

    it.each([
        { commandTimeoutMs: 5000, requestTimeoutMs: 20000, expected: 5000 },
        { commandTimeoutMs: 12000, requestTimeoutMs: 4000, expected: 4000 },
    ])("regression: clone honors explicit native and parent caps %j", async ({ commandTimeoutMs, requestTimeoutMs, expected }) => {
        const runner = vi.fn(successfulRunner()), base = await start(runner, { commandTimeoutMs, hyperVMonotonicNow: () => 0 });
        expect((await invoke(base, "device_create", { name: "Bounded clone", provider: "tart", image: "base-image", requestTimeoutMs })).status).toBe(200);
        expect(runner.mock.calls[0][1]).toMatchObject({ timeoutMs: expected });
        expect(devices()[0]).not.toHaveProperty("requestTimeoutMs");
    });

    it.each([false, true])("regression: elapsed device-lock wait shrinks clone allowance and expired=%s dispatches nothing", async expired => {
        writeBrokerDevices(owner, "macos", []);
        const admissionUuid = "12345678-1234-4123-8123-123456789abc";
        const generatedDeviceId = `macos-${admissionUuid}`;
        const lockFile = join(backendRoot(owner, "macos"), "operations", `${createHash("sha256").update(generatedDeviceId).digest("hex").slice(0, 32)}.lock`);
        let release!: () => void, entered!: () => void, clock = 0;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const held = withSharedMutationLockAsync(lockFile, async () => { entered(); await gate; });
        await ready;
        const monotonicNow = vi.fn(() => clock), runner = vi.fn(successfulRunner());
        let pending: ReturnType<typeof invoke> | undefined;
        let restoreUuid: (() => void) | undefined;
        try {
            const base = await start(runner, { hyperVMonotonicNow: monotonicNow });
            // Provision authentication before controlling only the next creation admission UUID.
            ownerRpcHeaders(owner);
            const uuidSpy = vi.spyOn(crypto, "randomUUID").mockReturnValueOnce(admissionUuid);
            restoreUuid = () => uuidSpy.mockRestore();
            const observationsBefore = monotonicNow.mock.calls.length;
            pending = invoke(base, "device_create", { name: "Locked clone", provider: "tart", image: "base-image", requestTimeoutMs: 10000 });
            await vi.waitFor(() => expect(monotonicNow.mock.calls.length).toBeGreaterThan(observationsBefore));
            expect(runner).not.toHaveBeenCalled();
            clock = expired ? 10001 : 2500;
            release(); await held;
            const result = await pending;
            if (expired) {
                expect(result.body).toMatchObject({ ok: false, error: "macos-tart-create-budget-exhausted" });
                expect(runner).not.toHaveBeenCalled();
                expect(devices()).toEqual([]);
            } else {
                expect(result.status).toBe(200);
                expect(result.body.result.device.id).toBe(generatedDeviceId);
                expect(runner).toHaveBeenCalledOnce();
                expect(runner.mock.calls[0][1]).toMatchObject({ timeoutMs: 7500 });
                const remaining = runner.mock.calls[0][1]?.remainingMs;
                expect(remaining?.()).toBe(7500);
                clock += 1000;
                expect(remaining?.()).toBe(6500);
            }
        } finally {
            release(); await held;
            try { await pending?.catch(() => undefined); }
            finally { restoreUuid?.(); }
        }
    });

    it("regression: authenticated owner queue spends Tart clone allowance before lifecycle dispatch", async () => {
        const original = device();
        writeBrokerDevices(owner, "macos", [original]);
        let release!: () => void, entered!: () => void, received!: () => void, clock = 0;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const firstEntered = new Promise<void>(resolve => { entered = resolve; });
        const secondReceived = new Promise<void>(resolve => { received = resolve; });
        const runner = vi.fn(successfulRunner());
        const deviceToolRunner: NonNullable<DeviceBrokerOptions["deviceToolRunner"]> = async () => {
            entered();
            await gate;
            return { status: 200, payload: { ok: true, result: { stdout: "held owner operation completed" } } };
        };
        const base = await start(runner, { deviceToolRunner, hyperVMonotonicNow: () => clock });
        let first: Promise<Response> | undefined, queued: ReturnType<typeof invoke> | undefined;
        try {
            first = fetch(ownerRpcEndpoint(base, owner), { method: "POST", headers: ownerRpcHeaders(owner), body: JSON.stringify({
                method: "broker.device.tool.invoke", params: { backend: "macos-vm", deviceId: original.id, tool: "device_exec", command: "owned fixture operation" },
            }) });
            await firstEntered;
            // Observe the real second HTTP body, then let authentication and queue admission settle.
            server!.once("request", request => request.once("end", received));
            let settled = false;
            queued = invoke(base, "device_create", { name: "Queued clone", provider: "tart", image: "base-image", requestTimeoutMs: 10000 })
                .finally(() => { settled = true; });
            await secondReceived;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(settled).toBe(false);
            expect(runner).not.toHaveBeenCalled();
            clock = 10001;
            release();
            expect((await first).status).toBe(200);
            const result = await queued;
            expect(result).toMatchObject({ status: 504, body: { ok: false, error: "macos-tart-create-budget-exhausted" } });
            expect(runner).not.toHaveBeenCalled();
            expect(devices()).toEqual([original]);
        } finally {
            release();
            await first?.catch(() => undefined);
            await queued?.catch(() => undefined);
        }
    });

    it("regression: default native runner refuses clone admission without room for identity-checked cleanup", async () => {
        const base = await start(undefined, { hyperVMonotonicNow: () => 0 });
        const result = await invoke(base, "device_create", { name: "Unsafe short clone", provider: "tart", image: "base-image", requestTimeoutMs: 1001 });
        expect(result.body).toMatchObject({ ok: false, error: "macos-tart-create-budget-exhausted" });
        expect(existsSync(stateFile())).toBe(false);
    });

    it.each([0, -1, "4000", 630001, null])("regression: invalid cross-process clone duration %j is rejected before execution", async requestTimeoutMs => {
        const runner = vi.fn(successfulRunner()), base = await start(runner);
        const result = await invoke(base, "device_create", { name: "Invalid duration", provider: "tart", image: "base-image", requestTimeoutMs });
        expect(result.status).toBe(400);
        expect(runner).not.toHaveBeenCalled();
        expect(existsSync(stateFile())).toBe(false);
    });

    it("regression: failed clone preserves timeout and cleanup refusal without publication, replay or delete", async () => {
        writeBrokerDevices(owner, "macos", []);
        const cleanup: BrokerProcessTreeCleanup = { attempted: false, ok: false, pid: 4242, signal: "SIGKILL", platform: "darwin", error: "spawned-process-identity-unavailable" };
        const runner = vi.fn<NonNullable<DeviceBrokerOptions["commandRunner"]>>(command => ({ ...command, status: null,
            stdout: "", stderr: "native clone timed out; cleanup identity was not confirmed", timedOut: true,
            cleanup,
        }));
        const base = await start(runner), result = await invoke(base, "device_create", { name: "Failed clone", provider: "tart", image: "base-image" });
        expect(result.status).toBe(502);
        expect(result.body).toMatchObject({ ok: false, error: "provider-command-failed" });
        expect(JSON.stringify(result.body)).toContain("cleanup identity was not confirmed");
        expect(runner.mock.calls.map(([command]) => command.args?.[0])).toEqual(["clone"]);
        expect(devices()).toEqual([]);
    });

    it.each([
        ["vz", "device_create writes owner-scoped broker metadata"],
        ["tart", "macOS VM device_create without image writes owner-scoped broker metadata"],
    ])("keeps %s definition creation provider-free and executes metadata-only deletion", async (provider, description) => {
        const runner = vi.fn(successfulRunner()), base = await start(runner);
        const created = await invoke(base, "device_create", { name: "Unit", provider });
        expect(created.status).toBe(200);
        expect(created.body.result.providerCommand).toMatchObject({ mode: "noop", provider: "host-broker-state", reason: description });
        expect(runner).not.toHaveBeenCalled();
        const stored = devices()[0];
        delete stored.providerInstance;
        writeBrokerDevices(owner, "macos", [stored]);
        const deleted = await invoke(base, "device_delete", { deviceId: stored.id, confirmDestructive: true });
        expect(deleted.status).toBe(200);
        expect(devices()).toEqual([]);
        expect(runner).toHaveBeenCalledOnce();
        expect(runner.mock.calls[0][0]).toEqual({
            mode: "noop", provider: "host-broker-state",
            reason: "Stopped macOS VM delete without providerInstance deletes only owner broker metadata",
        });
    });
    it("publishes create/start/stop/delete through the actual HTTP dispatcher", async () => {
        const runner = vi.fn<NonNullable<DeviceBrokerOptions["commandRunner"]>>(command => ({
            ...command, status: 0, stdout: command.args?.[0] === "ip" ? "192.0.2.20" : "", stderr: "",
        }));
        const base = await start(runner);
        const created = await invoke(base, "device_create", { name: "Unit", provider: "tart", image: "base-image" });
        expect(created.status).toBe(200);
        const deviceId = created.body.result.device.id;
        expect(deviceId).toMatch(/^macos-[0-9a-f-]{36}$/);
        expect(devices()[0]).toMatchObject({ id: deviceId, status: "stopped", provider: "tart" });
        expect((await invoke(base, "device_start", { deviceId, waitForBoot: true, bootTimeoutMs: 1000 })).status).toBe(200);
        expect(devices()[0]).toMatchObject({
            status: "running", bootReady: true, ssh: { host: "192.0.2.20" },
            lastBootCheck: { ready: true, ip: "192.0.2.20", result: {
                provider: "tart", executable: "/fixture/tart", status: 0, stdout: "192.0.2.20",
            } },
        });
        expect(devices()[0]).not.toHaveProperty("lastBootCheck.result.receipt");
        for (const field of ["ok", "createdUdid", "resourceMissing", "address"]) {
            expect(devices()[0]).not.toHaveProperty(`lastBootCheck.result.${field}`);
        }
        expect((await invoke(base, "device_stop", { deviceId })).status).toBe(200);
        expect(devices()[0]).toMatchObject({ status: "stopped", recording: null });
        expect((await invoke(base, "device_delete", { deviceId, confirmDestructive: true })).status).toBe(200);
        expect(devices()).toEqual([]);
        expect(runner.mock.calls.map(([command]) => command.args?.[0])).toEqual(["clone", "run", "ip", "stop", "delete"]);
    });
    it.each(["vz", "utmctl"] as const)("finalizes a successful finite %s start with explicitly skipped readiness", async provider => {
        const original = {...device(), provider};
        writeBrokerDevices(owner, "macos", [original]);
        const runner = vi.fn<NonNullable<DeviceBrokerOptions["commandRunner"]>>(command => {
            expect(devices()[0]).toMatchObject({status: "starting", lifecycle: {runtimeId: expect.any(String), operation: "start", claimedAt: expect.any(String)}});
            return {...command, status: 0, stdout: "", stderr: ""};
        });
        const base = await start(runner), result = await invoke(base, "device_start", {waitForBoot: true, bootTimeoutMs: 1000});
        expect(result).toMatchObject({status: 200, body: {ok: true, result: {invoked: true,
            device: {id: original.id, status: "running", bootReady: false, lastBootCheck: {ready: false, skipped: true}},
            execution: {mode: "exec", mutatesHost: true}}}});
        expect(devices()[0]).toMatchObject({...original, status: "running", bootReady: false, lastBootCheck: {ready: false, skipped: true}});
        expect(devices()[0].lifecycle ?? null).toBeNull();
        expect(runner).toHaveBeenCalledOnce();
        expect(runner.mock.calls[0][0]).toMatchObject({mode: "exec", provider, executable: "/fixture/" + provider, args: ["start", original.providerInstance]});
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
    it("keeps an owned pending record when the provider refuses start after possible dispatch", async () => {
        writeBrokerDevices(owner, "macos", [device()]);
        const base = await start(command => ({ ...command, status: 7, stdout: "", stderr: "provider refused" }));
        const result = await invoke(base, "device_start", { waitForBoot: false });
        expect(result.status).toBe(502); expect(result.body.error).toBe("provider-command-failed");
        expect(result.body.result).toMatchObject({ invoked: true, execution: { mutatesHost: true }, device: { status: "starting" } });
        expect(devices()[0]).toMatchObject({ status: "starting", providerInstance: "owned-unit",
            lifecycle: { runtimeId: expect.any(String), operation: "start", claimedAt: expect.any(String) } });
    });
    it.each([true, false])("retains a timed-out start for fresh owner cleanup; confirmed stop=%s", async confirmed => {
        const original = { ...device(), preferences: { keep: "original" }, ssh: { password: "macos-recovery-private-secret" } };
        writeBrokerDevices(owner, "macos", [original]);
        const runner = vi.fn<NonNullable<DeviceBrokerOptions["commandRunner"]>>(command => ({ ...command,
            status: command.args?.[0] === "stop" && !confirmed ? 7 : 0, stdout: "", stderr: "" }));
        const base = await start(runner);
        const failed = await invoke(base, "device_start", { waitForBoot: true, bootTimeoutMs: 1000 });
        expect(failed).toMatchObject({ status: 502, body: { ok: false, error: "provider-command-failed",
            result: { invoked: true, device: { status: "starting" }, execution: { mutatesHost: true } } } });
        const pending = devices()[0];
        expect(pending).toMatchObject({ ...original, status: "starting", lifecycle: { runtimeId: expect.any(String), operation: "start", claimedAt: expect.any(String) } });
        expect(JSON.stringify(failed.body)).not.toContain("macos-recovery-private-secret");
        const beforeRepeated = runner.mock.calls.length;
        expect((await invoke(base, "device_start", { waitForBoot: false })).status).toBe(409);
        expect(runner).toHaveBeenCalledTimes(beforeRepeated);
        expect(devices()).toEqual([pending]);
        const stopped = await cleanup(base);
        expect(stopped).toMatchObject({ status: 200, body: { ok: confirmed, result: { failed: confirmed ? 0 : 1 } } });
        expect(runner.mock.calls.filter(([command]) => command.args?.[0] === "stop")).toHaveLength(1);
        if (confirmed) {
            expect(devices()[0]).toMatchObject({ id: "unit", status: "stopped", preferences: original.preferences });
            expect(devices()[0].lifecycle ?? null).toBeNull();
            runner.mockImplementation(command => ({ ...command, status: 7, stdout: "", stderr: "" }));
            await invoke(base, "device_start", { waitForBoot: false });
            expect((devices()[0].lifecycle as {runtimeId: string}).runtimeId).not.toBe((pending.lifecycle as {runtimeId: string}).runtimeId);
        } else expect(devices()).toEqual([pending]);
    });
    it("redacts an unknown native start throw while retaining dispatched recovery facts", async () => {
        writeBrokerDevices(owner, "macos", [device()]);
        const base = await start(() => { throw Error("private-macos-native-launch-secret"); });
        const result = await invoke(base, "device_start", { waitForBoot: false });
        expect(result).toMatchObject({ status: 502, body: { ok: false, result: { invoked: true, device: { status: "starting" }, execution: { mutatesHost: true } } } });
        expect(JSON.stringify(result.body)).not.toContain("private-macos-native-launch-secret");
        expect(result.body).not.toHaveProperty("cause");
        expect(devices()[0]).toHaveProperty("lifecycle.operation", "start");
    });
    it.each([["invalid", 409, "owner-devices-state-invalid"], ["large", 413, "owner-devices-file-too-large"]] as const)("keeps known %s publication status with partial launch evidence", async (fault, status, error) => {
        writeBrokerDevices(owner, "macos", [device()]);
        const runner = vi.fn<NonNullable<DeviceBrokerOptions["commandRunner"]>>(command => {
            if (command.args?.[0] === "run") {
                writeFileSync(stateFile(), fault === "invalid" ? "{" : " ".repeat(256 * 1024 + 1));
            }
            return { ...command, status: 0, stdout: "", stderr: "" };
        });
        const base = await start(runner), result = await invoke(base, "device_start", { waitForBoot: false });
        expect(result).toMatchObject({ status, body: { ok: false, error, result: { invoked: true, execution: { mutatesHost: true } } } });
        expect(runner.mock.calls.map(([command]) => command.args?.[0])).toEqual(["run"]);
    });
    it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)("keeps known unreadable publication status503 with partial launch evidence", async () => {
        writeBrokerDevices(owner, "macos", [device()]);
        const runner = vi.fn<NonNullable<DeviceBrokerOptions["commandRunner"]>>(command => {
            if (command.args?.[0] === "run") chmodSync(stateFile(), 0);
            return {...command, status: 0, stdout: "", stderr: ""};
        });
        const base = await start(runner);
        try {
            expect(await invoke(base, "device_start", {waitForBoot: false})).toMatchObject({status: 503, body: {ok: false,
                error: "owner-devices-state-read-failed", result: {invoked: true, execution: {mutatesHost: true}}}});
            expect(runner.mock.calls.map(([command]) => command.args?.[0])).toEqual(["run"]);
        } finally {chmodSync(stateFile(), 0o600);}
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
        expect(result.body.result).toMatchObject({ invoked: true, execution: { mutatesHost: true } });
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
