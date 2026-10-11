import { describe, expect, it } from "vitest";
import { createAndroidDeviceAccess } from "../../../packages/device-lab/providers/application/android-device-access.mjs";
import type { AndroidEmulatorAccessPorts, AndroidPhysicalAccessPorts, AndroidAccessReceipt, AndroidScreenshotFacts } from "../../../packages/device-lab/providers/ports/android-device-access.mjs";

const device = { id: "guest", port: 5580 };
const ready = { device, adb: "adb" };
function emulatorPorts(execute: (args: (string | undefined)[]) => AndroidAccessReceipt): AndroidEmulatorAccessPorts {
    return {
        variant: "emulator", device: () => device, discovery: () => ({ adb: "adb" }),
        backend: () => ({ name: "android" }), publicDevice: (value) => value,
        appium: () => ({ available: false, missing: ["appium"], tools: { appium: null, adb: "adb" } }),
        target: () => ({ kind: "ready", target: ready }), execute: (_target, args) => execute(args),
        capture: () => { throw new Error("unexpected-screenshot"); },
        budget: () => { throw new Error("standalone-request-must-not-acquire-a-wait-budget"); },
        executeTimed: () => { throw new Error("standalone-request-must-not-use-timed-wait-command"); },
    };
}

describe("Android device access policy", () => {
    it("returns a failed UI dump before starting either read", () => {
        const command = { status: 2, stdout: "", stderr: "dump unavailable" };
        const ports = emulatorPorts((args) => {
            if (args.includes("uiautomator")) return command;
            throw new Error("failed-dump-must-not-read-ui");
        });
        expect(createAndroidDeviceAccess(ports).request("mobile_dump_ui", { deviceId: device.id })).toEqual({ kind: "command-failure", command });
    });

    it("reports the shell read failure when both UI reads fail", () => {
        const command = { status: 4, stdout: "", stderr: "shell read denied" };
        const ports = emulatorPorts((args) => {
            if (args.includes("uiautomator")) return { status: 0, stdout: "dump complete", stderr: "" };
            if (args[0] === "exec-out") return { status: 3, stdout: "", stderr: "exec-out unsupported" };
            if (args[0] === "shell" && args[1] === "cat") return command;
            throw new Error("unexpected-ui-command");
        });
        expect(createAndroidDeviceAccess(ports).request("mobile_dump_ui", { deviceId: device.id })).toEqual({ kind: "command-failure", command });
    });

    it("rejects a failed non-PNG screenshot with the native diagnostic", () => {
        const facts: AndroidScreenshotFacts = { status: 7, byteLength: 3, prefix: [97, 98, 99], base64: "YWJj", stdoutText: "abc", stderrText: "capture denied" };
        const ports = emulatorPorts(() => { throw new Error("screenshot-must-not-use-text-command"); });
        expect(createAndroidDeviceAccess({ ...ports, capture: () => facts }).request("device_screenshot", { deviceId: device.id })).toEqual({ kind: "text", message: "Error: capture denied" });
    });

    it("preserves the existing empty image result for a successful empty screenshot", () => {
        const ports = emulatorPorts(() => { throw new Error("screenshot-must-not-use-text-command"); });
        expect(createAndroidDeviceAccess({ ...ports, capture: () => ({ status: 0, byteLength: 0, prefix: [], base64: "", stdoutText: "", stderrText: "" }) })
            .request("device_screenshot", { deviceId: device.id })).toEqual({ kind: "image", data: "" });
    });

    it("leaves unknown plain status and session targets untouched before discovery", () => {
        const ports = emulatorPorts(() => { throw new Error("unknown-target-must-not-execute"); });
        ports.device = () => undefined;
        ports.discovery = () => { throw new Error("unknown-target-must-not-discover"); };
        ports.appium = () => { throw new Error("unknown-target-must-not-observe-appium"); };
        const app = createAndroidDeviceAccess(ports);
        expect(app.request("device_status", { deviceId: "missing" })).toBeUndefined();
        expect(app.request("mobile_session_status", { deviceId: "missing" })).toBeUndefined();
    });

    it("returns physical status without get-state when ADB is unavailable after lease admission", () => {
        let leaseAdmitted = false;
        const base = emulatorPorts(() => { throw new Error("status-must-not-execute-text-command"); });
        const ports: AndroidPhysicalAccessPorts = {
            ...base, variant: "physical",
            refreshLease: () => { leaseAdmitted = true; return { ok: true }; },
            discovery: () => { expect(leaseAdmitted).toBe(true); return { adb: null }; },
            hostState: () => { throw new Error("missing-adb-must-not-probe-get-state"); },
        };
        expect(createAndroidDeviceAccess(ports).request("device_status", { deviceId: device.id })).toMatchObject({ kind: "json", payload: { hostState: null } });
    });
});
