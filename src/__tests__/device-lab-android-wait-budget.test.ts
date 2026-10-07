import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import * as emulatorState from "@ccc/device-lab/providers/state/android-state.mjs";
import * as physicalState from "@ccc/device-lab/providers/state/android-device-state.mjs";
import * as leases from "@ccc/device-lab/providers/state/physical-lease-store.mjs";
import * as store from "@ccc/device-lab/providers/state/device-store.mjs";
import { handleAndroidTool } from "@ccc/device-lab/providers/backends/android.mjs";
import { handleAndroidRealTool } from "@ccc/device-lab/providers/backends/android-device.mjs";

const device = { id: "wait-phone", serial: "serial ; literal", leaseClaimId: "claim", leaseClaimNonce: "nonce" };
const result = (stdout = "", status: number | null = 0, extra = {}) => ({ stdout, stderr: "", status, signal: null, ...extra });
const payload = (response: any) => JSON.parse(response.content[0].text);
let time = 0;
let clock: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
    time = 0;
    clock = vi.spyOn(performance, "now").mockImplementation(() => time);
    vi.spyOn(commands, "commandPath").mockImplementation((name: string) => `/fixture/${name}`);
    vi.spyOn(emulatorState, "findAndroidDevice").mockReturnValue(device);
    vi.spyOn(physicalState, "findAndroidRealDevice").mockReturnValue(device);
    vi.spyOn(leases, "heartbeatPhysicalLease").mockReturnValue({ ok: true, lease: {} });
    vi.spyOn(store, "withOwnerDeviceOperation").mockImplementation((_backend: string, _id: string, fn: () => any) => fn());
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

for (const [backend, handle] of [["android-emulator", handleAndroidTool], ["android-device", handleAndroidRealTool]] as const) {
    describe(`${backend} actual mobile handlers share one polling budget`, () => {
        const call = (name: string, options = {}) => handle(name, { backend, deviceId: device.id, text: "needle", packageName: "com.fixture.app", ...options });
        it("decreases one budget across dump, exec-out read and fallback while preserving serial argv", async () => {
            const run = vi.spyOn(commands, "runWithTimeout").mockImplementation((_exe, _args, timeout) => {
                const index = run.mock.calls.length;
                expect(timeout).toBe([100, 70, 40][index - 1]);
                time += 30;
                return index === 2 ? result("", 2) : result(index === 3 ? "<node text='needle'/>" : "dumped");
            });
            expect(payload(await call("mobile_wait_for_text", { timeoutMs: 100 }))).toMatchObject({ found: true });
            expect(run.mock.calls.map((args) => args[1])).toEqual([
                ["-s", device.serial, "shell", "uiautomator", "dump", `/sdcard/window-${device.id}.xml`],
                ["-s", device.serial, "exec-out", "cat", `/sdcard/window-${device.id}.xml`],
                ["-s", device.serial, "shell", "cat", `/sdcard/window-${device.id}.xml`],
            ]);
        });
        it("does not start fallback or sleep after read consumes the remaining budget", async () => {
            const run = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => {
                time += 50;
                return run.mock.calls.length === 1 ? result() : result("", null, { error: new Error("read timed out") });
            });
            const response = await call("mobile_wait_for_text", { timeoutMs: 100 });
            expect(response?.isError).toBe(true);
            expect(JSON.stringify(response)).toContain("timed out");
            expect(run).toHaveBeenCalledTimes(2);
        });
        it("caps the final sleep to remaining time and reports valid app absence", async () => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const timer = vi.spyOn(globalThis, "setTimeout");
            const run = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => { time = 70; return result("", 1); });
            const pending = call("mobile_wait_for_app", { timeoutMs: 100, intervalMs: 900 });
            await Promise.resolve();
            expect(timer).toHaveBeenCalledWith(expect.any(Function), 30);
            time = 100;
            await vi.runAllTimersAsync();
            expect(payload(await pending)).toMatchObject({ running: false, timeoutMs: 100 });
            expect(run).toHaveBeenCalledTimes(1);
        });
        it.each(["failed-then-successful", "successful-then-failed"])("uses latest app observation: %s", async (order) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const schedule = globalThis.setTimeout;
            vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
                schedule(() => { time += delay; callback(); }, delay)) as typeof setTimeout);
            const bad = result("", 1, { stderr: "device disconnected" });
            const run = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => {
                const first = run.mock.calls.length === 1;
                time = first ? 10 : 100;
                return (order === "failed-then-successful") === first ? bad : result("", 1);
            });
            const pending = call("mobile_wait_for_app", { timeoutMs: 100, intervalMs: 10 });
            await vi.runAllTimersAsync();
            const response = await pending;
            expect(run).toHaveBeenCalledTimes(2);
            expect(response?.isError).toBe(order === "successful-then-failed");
            if (order === "failed-then-successful") expect(payload(response).running).toBe(false);
            else expect(JSON.stringify(response)).toContain("device disconnected");
        });
        it.each(["failed-then-successful", "successful-then-failed"])("uses latest UI observation: %s", async (order) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const schedule = globalThis.setTimeout;
            vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay: number) =>
                schedule(() => { time += delay; callback(); }, delay)) as typeof setTimeout);
            let observation = 0;
            const run = vi.spyOn(commands, "runWithTimeout").mockImplementation((_exe, args) => {
                if (args.includes("uiautomator")) {
                    observation++;
                    const failure = (order === "failed-then-successful") === (observation === 1);
                    time = observation === 1 ? 10 : failure ? 100 : 90;
                    return failure ? result("", 2, { stderr: "UI unavailable" }) : result();
                }
                time = observation === 1 ? 10 : 100;
                return result("<node text='unrelated'/>");
            });
            const pending = call("mobile_wait_for_text", { timeoutMs: 100, intervalMs: 10 });
            await vi.runAllTimersAsync();
            const response = await pending;
            expect(observation).toBe(2);
            expect(run).toHaveBeenCalledTimes(3);
            expect(response?.isError).toBe(order === "successful-then-failed");
            if (order === "failed-then-successful") expect(payload(response)).toMatchObject({ found: false, source: "<node text='unrelated'/>" });
            else expect(JSON.stringify(response)).toContain("UI unavailable");
        });
        it.each([[0, 1], [-1, 1], [NaN, 500], [Infinity, 500], ["2", 500], [90000, 60000]])("normalizes interval %s to %s", async (intervalMs, expected) => {
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const timer = vi.spyOn(globalThis, "setTimeout");
            vi.spyOn(commands, "runWithTimeout").mockReturnValue(result("", 1));
            const pending = call("mobile_wait_for_app", { timeoutMs: 100000, intervalMs });
            await Promise.resolve();
            expect(timer).toHaveBeenCalledWith(expect.any(Function), expected);
            time = 100000;
            await vi.runAllTimersAsync();
            expect(payload(await pending).running).toBe(false);
        });
        it.each([
            result("", null, { error: new Error("spawn ENOENT") }),
            result("", null, { error: new Error("ETIMEDOUT") }),
            result("", null, { signal: "SIGTERM" }),
            result("unexpected stdout", 1),
        ])("reports command failure rather than app absence %#", async (failure) => {
            vi.spyOn(commands, "runWithTimeout").mockImplementation(() => { time = 100; return failure; });
            const response = await call("mobile_wait_for_app", { timeoutMs: 100 });
            expect(response?.isError).toBe(true);
            expect(JSON.stringify(response)).not.toContain('"running": false');
        });
        it.each([[0, 1], [-2, 1], [NaN, 10000], [Infinity, 10000], ["20", 10000], [900000, 120000]])("normalizes timeout %s to bounded subprocess budget %s", async (timeoutMs, expected) => {
            const run = vi.spyOn(commands, "runWithTimeout").mockReturnValue(result("123\n"));
            expect(payload(await call("mobile_wait_for_app", { timeoutMs })).running).toBe(true);
            expect(run.mock.calls[0][2]).toBe(expected);
        });
        it("clamps total requested timeout to ten minutes independently of per-command cap", async () => {
            const run = vi.spyOn(commands, "runWithTimeout").mockImplementation(() => { time = 600000; return result("", 1); });
            expect(payload(await call("mobile_wait_for_app", { timeoutMs: 900000 })).timeoutMs).toBe(600000);
            expect(run.mock.calls[0][2]).toBe(120000);
        });
        it("leaves standalone UI dump on existing command defaults", async () => {
            const run = vi.spyOn(commands, "run").mockImplementation((_exe, args) => result(args.includes("cat") ? "<node/>" : "dumped"));
            const bounded = vi.spyOn(commands, "runWithTimeout");
            expect(payload(await call("mobile_dump_ui"))).toHaveProperty("source", "<node/>");
            expect(run).toHaveBeenCalledTimes(2);
            expect(run.mock.calls.every((args) => args.length === 2)).toBe(true);
            expect(bounded).not.toHaveBeenCalled();
        });
    });
}

describe("physical clipboard public handler", () => {
    it.each(["", "한글 📋\nsecond line\n"])("returns exact clipboard text %j after lease validation", async (text) => {
        const run = vi.spyOn(commands, "run").mockReturnValue(result(text));
        const response = await handleAndroidRealTool("mobile_get_clipboard", { backend: "android-device", deviceId: device.id });
        expect(response?.isError).toBe(false);
        expect(payload(response).text).toBe(text);
        expect(leases.heartbeatPhysicalLease).toHaveBeenCalled();
        expect(run.mock.calls[0][1]).toEqual(["-s", device.serial, "shell", "cmd", "clipboard", "get"]);
    });
    it("does not turn command failure or lost lease into empty clipboard success", async () => {
        const run = vi.spyOn(commands, "run").mockReturnValue(result("", 4, { stderr: "clipboard denied" }));
        const args = { backend: "android-device", deviceId: device.id };
        expect((await handleAndroidRealTool("mobile_get_clipboard", args))?.isError).toBe(true);
        vi.mocked(leases.heartbeatPhysicalLease).mockReturnValue({ ok: false, error: "lease changed" });
        run.mockClear();
        expect((await handleAndroidRealTool("mobile_get_clipboard", args))?.isError).toBe(true);
        expect(run).not.toHaveBeenCalled();
    });
});

it.skipIf(process.platform === "win32")("bounds an actual slow adb child at the wait deadline", async () => {
    clock.mockRestore();
    const root = mkdtempSync(join(tmpdir(), "ccc-adb-budget-"));
    const adb = join(root, "adb");
    writeFileSync(adb, `#!${process.execPath}\nsetTimeout(() => process.stdout.write('123'), 3000);\n`);
    chmodSync(adb, 0o755);
    vi.mocked(commands.commandPath).mockReturnValue(adb);
    const start = performance.now();
    try {
        const response = await handleAndroidTool("mobile_wait_for_app", { backend: "android-emulator", deviceId: device.id, packageName: "com.fixture", timeoutMs: 120 });
        expect(response?.isError).toBe(true);
        expect(JSON.stringify(response)).toContain("ETIMEDOUT");
        expect(performance.now() - start).toBeLessThan(1500);
    } finally { rmSync(root, { recursive: true, force: true }); }
});
