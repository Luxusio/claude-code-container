import * as childProcess from "child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as mcpClient from "../../scripts/real-tests/device-lab-mcp-client.ts";
import {
    iosRealDeviceE2ECapability,
    iosSimulatorE2ECapability,
    parseXctracePhysicalIosDevices,
    parseIosSimulatorStopWithObservation,
    runIosRealDeviceE2E,
    runIosSimulatorE2E,
} from "../../scripts/real-tests/ios-e2e.ts";

vi.mock("child_process", { spy: true });

describe("failed iOS stop observation before cleanup", () => {
    const udid = "PRIVATE-OWNED-UDID";
    const simulatorName = "ccc-owner-PRIVATE-SIMULATOR";
    const stopResult = { isError: true };
    let failure: Error;
    let parser: ReturnType<typeof vi.spyOn>;
    let native: ReturnType<typeof vi.spyOn>;

    const inventory = (devices: unknown[]) => ({ status: 0, signal: null, stderr: "PRIVATE-STDERR",
        stdout: JSON.stringify({ devices: { "PRIVATE-RUNTIME": devices }, privateField: "PRIVATE-INVENTORY" }) });
    const device = (state: string) => ({ udid, name: simulatorName, state, privateField: "PRIVATE-DEVICE" });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
        failure = new Error("original stop failure");
        parser = vi.spyOn(mcpClient, "parseContractToolPayload").mockImplementation(() => { throw failure; });
        native = vi.spyOn(childProcess, "spawnSync");
        native.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    async function observeFailure() {
        let caught: unknown;
        const operation = parseIosSimulatorStopWithObservation(stopResult, "/PRIVATE-XCRUN", udid, simulatorName)
            .catch(error => { caught = error; });
        await vi.runAllTimersAsync();
        await operation;
        expect(caught).toBe(failure);
        expect(failure.message.startsWith("original stop failure afterStop=")).toBe(true);
        const summary = JSON.parse(failure.message.split(" afterStop=")[1]);
        expect(failure.message).not.toContain("PRIVATE");
        return summary;
    }

    it("returns a successful stop unchanged without issuing an observation", async () => {
        const stop = { device: { deviceId: "ios-fixture", status: "stopped" } };
        parser.mockReturnValue(stop);
        await expect(parseIosSimulatorStopWithObservation(stopResult, "/PRIVATE-XCRUN", udid, simulatorName)).resolves.toBe(stop);
        expect(parser).toHaveBeenCalledWith("stop", stopResult);
        expect(native).not.toHaveBeenCalled();
    });

    it("retains the failed stop after natural Shutdown and observes before finally cleanup", async () => {
        const order: string[] = [];
        const states = ["Booted", "Shutting Down", "Shutdown"];
        native.mockImplementation(() => {
            const state = states.shift() || "Shutdown";
            order.push(state);
            vi.advanceTimersByTime(100);
            return inventory([device(state)]) as any;
        });
        let caught: unknown;
        const operation = parseIosSimulatorStopWithObservation(stopResult, "/PRIVATE-XCRUN", udid, simulatorName)
            .finally(() => { order.push("cleanup"); }).catch(error => { caught = error; });
        await vi.runAllTimersAsync();
        await operation;
        expect(caught).toBe(failure);
        expect(order).toEqual(["Booted", "Shutting Down", "Shutdown", "cleanup"]);
        const summary = JSON.parse(failure.message.split(" afterStop=")[1]);
        expect(summary).toMatchObject({ attempts: 3, firstState: "Booted", lastState: "Shutdown",
            native: { status: 0, signal: null, timedOut: false } });
        expect(summary.changes.map((change: any) => change.state)).toEqual(["Booted", "Shutting Down", "Shutdown"]);
        expect(summary.elapsedMs).toBeGreaterThan(0);
        expect(summary.elapsedMs).toBeLessThanOrEqual(10000);
        expect(native).toHaveBeenCalledTimes(3);
        for (const [executable, args] of native.mock.calls) {
            expect(executable).toBe("/PRIVATE-XCRUN");
            expect(args).toEqual(["simctl", "list", "devices", udid, "-j"]);
        }
        expect(failure.message).not.toContain("PRIVATE");
    });

    it("keeps identity failures, malformed data and unsupported states closed without exporting inventory", async () => {
        const receipts = [
            inventory([]),
            inventory([device("Booted"), device("Booted")]),
            inventory([{ ...device("Booted"), name: "PRIVATE-RENAMED" }]),
            { status: 0, signal: null, stdout: "PRIVATE-INVALID-JSON", stderr: "PRIVATE-STDERR" },
            inventory([device("PRIVATE-STATE")]),
            inventory([{ ...device("Booted"), state: ["Booted"] }]),
            { status: 7, signal: null, stdout: "PRIVATE-OUTPUT", stderr: "PRIVATE-ERROR" },
            inventory([device("Shutdown")]),
        ];
        native.mockImplementation(() => {
            vi.advanceTimersByTime(100);
            return receipts.shift() as any;
        });
        const summary = await observeFailure();
        expect(summary.attempts).toBe(8);
        expect(summary.firstState).toBe("missing");
        expect(summary.lastState).toBe("Shutdown");
        expect(summary.changes.map((change: any) => change.state)).toEqual([
            "missing", "identity-mismatch", "invalid", "unknown", "unavailable", "Shutdown",
        ]);
    });

    it("caps each read by the shrinking ten-second window and retains only native timeout facts", async () => {
        const starts: number[] = [];
        const timerNow = performance.now.bind(performance);
        let nativeElapsedMs = 0;
        vi.spyOn(performance, "now").mockImplementation(() => timerNow() + nativeElapsedMs);
        native.mockImplementation((_executable: unknown, _args: unknown, options: any) => {
            starts.push(performance.now());
            const late = options.timeout < 700;
            nativeElapsedMs += Math.min(700, options.timeout);
            return late ? { status: null, signal: "SIGTERM", stdout: "PRIVATE-OUTPUT", stderr: "PRIVATE-STDERR",
                error: { code: "ETIMEDOUT", message: "PRIVATE-ERROR", path: "/PRIVATE-PATH" } } as any
                : inventory([device("Booted")]) as any;
        });
        const summary = await observeFailure();
        expect(native.mock.calls.length).toBeGreaterThan(1);
        expect(native.mock.calls.length).toBeLessThanOrEqual(24);
        const timeouts = native.mock.calls.map((call: any[]) => call[2].timeout);
        for (let index = 0; index < timeouts.length; index++) {
            expect(timeouts[index]).toBeGreaterThan(0);
            expect(timeouts[index]).toBeLessThanOrEqual(10000 - starts[index]);
            if (index) expect(timeouts[index]).toBeLessThan(timeouts[index - 1]);
        }
        expect(summary.elapsedMs).toBe(10000);
        expect(summary).toMatchObject({ firstState: "Booted", lastState: "unavailable",
            native: { status: null, signal: "SIGTERM", timedOut: true } });
    });

    it("omits invalid native fields instead of exposing receipt properties", async () => {
        native.mockImplementation(() => {
            vi.advanceTimersByTime(10000);
            return { status: Number.MAX_SAFE_INTEGER + 1, signal: "PRIVATE-SIGNAL", timedOut: "PRIVATE-TIMEOUT",
                stdout: "PRIVATE-OUTPUT", stderr: "PRIVATE-STDERR", executable: "/PRIVATE-PATH" } as any;
        });
        const summary = await observeFailure();
        expect(summary).toMatchObject({ attempts: 1, firstState: "unavailable", lastState: "unavailable",
            native: { status: null, signal: null, timedOut: false } });
    });

    it("preserves the original failure and cleanup when an observation throws", async () => {
        native.mockImplementation(() => { throw new Error("PRIVATE-OBSERVATION-ERROR"); });
        let cleanup = false;
        await expect(parseIosSimulatorStopWithObservation(stopResult, "/PRIVATE-XCRUN", udid, simulatorName)
            .finally(() => { cleanup = true; })).rejects.toBe(failure);
        expect(cleanup).toBe(true);
        expect(failure.message).toBe("original stop failure");
    });
});

describe("real iOS device auto-selection", () => {
    it("selects only physical iOS UDIDs from the xctrace device section", () => {
        expect(parseXctracePhysicalIosDevices(`== Devices ==
Luxusui-MacBookPro (15.5) (12345678-1234-1234-1234-123456789abc)
Test iPhone (18.5) (00008110-001234567890801E)
== Simulators ==
iPhone 16 Pro Simulator (18.5) (aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)
`)).toEqual([{ name: "Test iPhone", udid: "00008110-001234567890801E" }]);
    });
});

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const simulatorCap = iosSimulatorE2ECapability(level);
const realCap = iosRealDeviceE2ECapability(level);

describe.runIf(level >= 2)("level 2 real iOS provider E2E", () => {
    it.skipIf(!simulatorCap.available)(
        simulatorCap.available
            ? `creates, boots, drives, screenshots, stops, and deletes iOS Simulator (${simulatorCap.runtime.identifier})`
            : `skips iOS Simulator E2E (${simulatorCap.reason})`,
        async () => {
            const result = await runIosSimulatorE2E({ level, bootTimeoutMs: 180000 });
            expect(result).toEqual(expect.objectContaining({
                status: "PASS",
                runtime: simulatorCap.runtime.identifier,
                deviceType: simulatorCap.deviceType.identifier,
                deviceId: expect.stringContaining("ios-real-e2e-"),
            }));
        },
        240000,
    );

    it.skipIf(!realCap.available)(
        realCap.available
            ? `attaches, inspects, no-op starts/stops, and detaches real iOS device (${realCap.udid})`
            : `skips real iOS device E2E (${realCap.reason})`,
        async () => {
            const result = await runIosRealDeviceE2E({ level });
            expect(result).toEqual(expect.objectContaining({
                status: "PASS",
                udid: realCap.udid,
                deviceId: expect.stringContaining("ios-device-real-e2e-"),
            }));
        },
        60000,
    );
});
