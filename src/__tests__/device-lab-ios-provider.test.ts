import { describe, expect, it } from "vitest";
import { iosSimulatorCreateCommand, iosSimulatorCreatedUdid, iosSimulatorDeleteCommand } from "../device-lab/providers/ios-simulator.js";

describe("iOS Simulator host provider adapter", () => {
    it("plans owner-scoped create/delete commands and parses the created UDID", () => {
        expect(iosSimulatorCreateCommand({
            simulatorName: "ccc-owner-test",
            ownerPrefix: "ccc-owner-",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-5",
            executable: "/usr/bin/xcrun",
        })).toEqual({
            mode: "exec",
            provider: "simctl",
            executable: "/usr/bin/xcrun",
            args: ["simctl", "create", "ccc-owner-test", "com.apple.CoreSimulator.SimDeviceType.iPhone-16", "com.apple.CoreSimulator.SimRuntime.iOS-18-5"],
        });
        expect(iosSimulatorCreatedUdid("SIM-UDID\n")).toBe("SIM-UDID");
        expect(iosSimulatorCreatedUdid("bad output value\n")).toBeNull();
        expect(iosSimulatorDeleteCommand("/usr/bin/xcrun", "SIM-UDID")).toEqual({
            mode: "exec", provider: "simctl", executable: "/usr/bin/xcrun", args: ["simctl", "delete", "SIM-UDID"],
        });
    });

    it("rejects incomplete and non-owner-scoped create plans", () => {
        expect(iosSimulatorCreateCommand({ simulatorName: "ccc-owner-test", ownerPrefix: "ccc-owner-", executable: "xcrun" })).toEqual({
            error: "missing-provider-metadata", missing: ["deviceType", "runtime"],
        });
        expect(iosSimulatorCreateCommand({ simulatorName: "user-vm", ownerPrefix: "ccc-owner-", deviceType: "type", runtime: "runtime", executable: "xcrun" })).toEqual({
            error: "ios-simulator-not-owner-scoped", missing: ["owner-prefixed simulatorName"],
        });
    });
});
