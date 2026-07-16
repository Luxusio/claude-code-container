import { describe, expect, it } from "vitest";
import {
    iosRealDeviceE2ECapability,
    iosSimulatorE2ECapability,
    runIosRealDeviceE2E,
    runIosSimulatorE2E,
} from "../../scripts/real-tests/ios-e2e.mjs";

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
