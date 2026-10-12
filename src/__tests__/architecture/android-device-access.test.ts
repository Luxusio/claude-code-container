import { describe, expect, it } from "vitest";
import { createAndroidDeviceAccess } from "../../../packages/device-lab/providers/application/android-device-access.mjs";
import type { AndroidEmulatorAccessPorts, AndroidPhysicalAccessPorts } from "../../../packages/device-lab/providers/ports/android-device-access.mjs";

const device = { id: "guest", port: 5580 };
const ready = { device, native: {} };
function emulatorPorts(): AndroidEmulatorAccessPorts {
    return {
        variant: "emulator", device: () => device, discovery: () => ({ adbAvailable: true, native: {} }),
        target: () => ({ kind: "ready", target: ready }), targetForDevice: () => ready,
        uiPath: () => "/sdcard/window.xml",
        executeShell: () => { throw new Error("unexpected-shell"); },
        dumpUi: () => ({ ok: true, value: undefined }),
        readUi: () => { throw new Error("unexpected-ui-read"); },
        observeApp: () => { throw new Error("unexpected-app-observation"); },
        capture: () => { throw new Error("unexpected-screenshot"); },
        budget: () => { throw new Error("standalone-request-must-not-acquire-a-wait-budget"); },
    };
}

describe("Android device access policy", () => {
    it("returns a failed UI dump before starting either read", () => {
        const command = { status: 2, stdout: "", stderr: "dump unavailable" };
        const ports = emulatorPorts();
        ports.dumpUi = () => ({ ok: false, diagnostic: command });
        expect(createAndroidDeviceAccess(ports).request("mobile_dump_ui", { deviceId: device.id })).toEqual({ kind: "native-failure", diagnostic: command });
    });

    it("reports the shell read failure when both UI reads fail", () => {
        const command = { status: 4, stdout: "", stderr: "shell read denied" };
        const ports = emulatorPorts();
        const modes: string[] = [];
        ports.readUi = (_target, _path, mode) => { modes.push(mode); return { ok: false, diagnostic: mode === "fallback" ? command : { status: 3 } }; };
        expect(createAndroidDeviceAccess(ports).request("mobile_dump_ui", { deviceId: device.id })).toEqual({ kind: "native-failure", diagnostic: command });
        expect(modes).toEqual(["primary", "fallback"]);
    });

    it("retains adapter-qualified screenshot failure evidence", () => {
        const facts = { status: 7, byteLength: 3, prefix: [97, 98, 99], base64: "YWJj", stdoutText: "abc", stderrText: "capture denied" };
        const ports = emulatorPorts();
        expect(createAndroidDeviceAccess({ ...ports, capture: () => ({ kind: "native-failure", diagnostic: facts }) }).request("device_screenshot", { deviceId: device.id })).toEqual({ kind: "native-failure", diagnostic: facts });
    });

    it("preserves the existing empty image result for a successful empty screenshot", () => {
        const ports = emulatorPorts();
        expect(createAndroidDeviceAccess({ ...ports, capture: () => ({ kind: "image", data: "" }) })
            .request("device_screenshot", { deviceId: device.id })).toEqual({ kind: "image", data: "" });
    });

    it("leaves unknown plain status and session targets untouched before discovery", () => {
        const ports = emulatorPorts();
        ports.device = () => undefined;
        ports.discovery = () => { throw new Error("unknown-target-must-not-discover"); };
        const app = createAndroidDeviceAccess(ports);
        expect(app.request("device_status", { deviceId: "missing" })).toBeUndefined();
        expect(app.request("mobile_session_status", { deviceId: "missing" })).toBeUndefined();
    });

    it("returns physical status without get-state when ADB is unavailable after lease admission", () => {
        let leaseAdmitted = false;
        const base = emulatorPorts();
        const ports: AndroidPhysicalAccessPorts = {
            ...base, variant: "physical",
            refreshLease: () => { leaseAdmitted = true; return { ok: true }; },
            discovery: () => { expect(leaseAdmitted).toBe(true); return { adbAvailable: false, native: {} }; },
            hostState: () => { throw new Error("missing-adb-must-not-probe-get-state"); },
        };
        expect(createAndroidDeviceAccess(ports).request("device_status", { deviceId: device.id })).toMatchObject({ kind: "status", hostState: null });
    });
});
