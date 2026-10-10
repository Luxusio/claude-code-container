import { describe, expect, it } from "vitest";
import { createAndroidEnvironment } from "../../../packages/device-lab/providers/application/android-environment.mjs";
import { createIosEnvironment } from "../../../packages/device-lab/providers/application/ios-environment.mjs";
import type { AndroidEmulatorEnvironmentPorts, AndroidPhysicalEnvironmentPorts, IosSimulatorEnvironmentPorts, EnvironmentCommandReceipt } from "../../../packages/device-lab/providers/ports/mobile-environment.mjs";

const success: EnvironmentCommandReceipt = { status: 0, stdout: "ok\n", stderr: "" };
function androidPorts(execute: (args: string[]) => EnvironmentCommandReceipt): AndroidEmulatorEnvironmentPorts {
    return {
        variant: "emulator", target: () => ({ kind: "ready", target: { device: { id: "guest", port: 5580 }, adb: "adb" } }),
        execute: (_target, args) => execute(args), serial: () => "emulator-5580",
        executeEmulator: (_target, _serial, args) => execute(args),
    };
}
function iosPorts(execute: (args: string[], input?: string) => EnvironmentCommandReceipt): IosSimulatorEnvironmentPorts {
    return {
        variant: "simulator", device: () => ({ id: "guest" }),
        discovery: () => ({ available: true, xcrun: "xcrun", missing: [] }),
        ownedTarget: () => ({ ok: true, target: "OWNED-UDID" }),
        execute: (_xcrun, args) => execute(args), executeWithInput: (_xcrun, args, input) => execute(args, input),
    };
}

describe("mobile environment policy", () => {
    it("stops network fallback before broadcast or radios when the legacy setting fails", () => {
        const command = { status: 7, stdout: "", stderr: "setting refused" };
        const app = createAndroidEnvironment(androidPorts((args) => {
            if (args.includes("connectivity")) return { status: 1, stderr: "old Android" };
            if (args.includes("settings")) return command;
            throw new Error("failed-setting-must-not-broadcast-or-change-radios");
        }));
        expect(app.request("mobile_set_network", { deviceId: "guest", airplaneMode: true, wifi: false, data: true })).toEqual({
            kind: "json", payload: { ok: false, error: "android-network-command-failed", detail: "airplaneMode.setting", status: 7, stderr: "setting refused" },
        });
    });

    it("refuses empty battery settings without executing commands", () => {
        const app = createAndroidEnvironment(androidPorts(() => { throw new Error("empty-battery-must-not-execute"); }));
        expect(app.request("mobile_set_battery", { deviceId: "guest" })).toEqual({ kind: "text", message: "Android battery control requires level, status, or charging" });
    });

    it("stops the battery sequence after a level failure instead of changing status or charging", () => {
        const command = { status: 1, stdout: "", stderr: "battery denied" };
        const app = createAndroidEnvironment(androidPorts((args) => {
            if (args.includes("level")) return command;
            throw new Error("later-battery-setting-must-not-execute");
        }));
        expect(app.request("mobile_set_battery", { deviceId: "guest", level: 42, status: 2, charging: false })).toEqual({ kind: "command-failure", command });
    });

    it("refuses emulator location without a qualified serial", () => {
        const ports = androidPorts(() => { throw new Error("missing-serial-must-not-execute"); });
        expect(createAndroidEnvironment({ ...ports, serial: () => null }).request("mobile_set_location", { latitude: 35, longitude: 129 })).toEqual({ kind: "text", message: "Android location requires an emulator serial or port" });
    });

    it("uses plain physical lookup for unsupported environment controls and preserves unknown fallthrough", () => {
        const ports: AndroidPhysicalEnvironmentPorts = {
            variant: "physical", device: (id) => id === "phone" ? { id } : undefined,
            target: () => { throw new Error("refusal-must-not-acquire-a-lease-or-adb"); },
            execute: () => { throw new Error("unsupported-physical-control-must-not-execute"); },
        };
        const app = createAndroidEnvironment(ports);
        expect(app.request("mobile_set_location", { deviceId: "phone", latitude: 35, longitude: 129 })).toEqual({ kind: "text", message: "Android real devices do not support mobile_set_location safely through the base ADB layer; use an emulator or a dedicated device-farm controller." });
        expect(app.request("mobile_set_location", { deviceId: "missing" })).toBeUndefined();
    });

    it("preserves Android clipboard read bytes and coerces write text into command data", () => {
        const text = "한글 'quote'\nsecond line\n";
        let written: string | undefined;
        const app = createAndroidEnvironment(androidPorts((args) => {
            if (args.includes("set")) { written = args.at(-1); return success; }
            return { status: 0, stdout: text, stderr: "" };
        }));
        expect(app.request("mobile_set_clipboard", { text: 42 })).toMatchObject({ kind: "json", payload: { clipboard: { set: true }, provider: "adb", status: 0 } });
        expect(written).toBe("42");
        expect(app.request("mobile_get_clipboard", {})).toEqual({ kind: "json", payload: { text, provider: "adb", stderr: "", status: 0 } });
    });

    it("preserves Simulator clipboard stdin and stdout bytes with distinct status projections", () => {
        const text = "한글 'quote'\nsecond line\n";
        let written: string | undefined;
        const app = createIosEnvironment(iosPorts((args, input) => {
            if (args.includes("pbcopy")) { written = input; return { status: 0, stdout: "", stderr: "" }; }
            return { status: 0, stdout: text, stderr: "" };
        }));
        expect(app.request("mobile_set_clipboard", { text })).toEqual({ kind: "json", payload: { clipboard: { set: true }, provider: "simctl", stdout: "", stderr: "" } });
        expect(written).toBe(text);
        expect(app.request("mobile_get_clipboard", {})).toEqual({ kind: "json", payload: { text, provider: "simctl", stderr: "", status: 0 } });
    });

    it("preserves a failed Simulator command instead of projecting clipboard success", () => {
        const command = { status: 1, stdout: "partial", stderr: "pasteboard unavailable" };
        const app = createIosEnvironment(iosPorts(() => command));
        expect(app.request("mobile_get_clipboard", {})).toEqual({ kind: "command-failure", command });
    });

    it("refuses known Simulator battery controls without discovery and leaves unknown targets untouched", () => {
        const ports = iosPorts(() => { throw new Error("unsupported-simulator-control-must-not-execute"); });
        const app = createIosEnvironment({ ...ports, device: (id) => id === "guest" ? { id } : undefined,
            discovery: () => { throw new Error("unsupported-control-must-not-discover"); } });
        expect(app.request("mobile_set_battery", { deviceId: "guest", level: 42 })).toEqual({ kind: "text", message: "iOS Simulator does not support mobile_set_battery through base simctl; use Appium/XCUITest support when available." });
        expect(app.request("mobile_set_battery", { deviceId: "missing" })).toBeUndefined();
    });

    it("keeps physical iOS clipboard unsupported while preserving unknown fallthrough", () => {
        const app = createIosEnvironment({ variant: "physical", device: (id) => id === "phone" ? { id } : undefined });
        expect(app.request("mobile_get_clipboard", { deviceId: "phone" })).toEqual({ kind: "text", message: "iOS real devices do not support mobile_get_clipboard through CCC because the action is unavailable or unsafe for physical devices." });
        expect(app.request("mobile_get_clipboard", { deviceId: "missing" })).toBeUndefined();
    });
});
