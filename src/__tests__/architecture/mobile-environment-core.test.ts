import { describe, expect, it } from "vitest";
import { createAndroidEnvironment } from "../../../packages/device-lab/providers/application/android-environment.mjs";
import { createIosEnvironment } from "../../../packages/device-lab/providers/application/ios-environment.mjs";
import type { AndroidEmulatorEnvironmentPorts, AndroidPhysicalEnvironmentPorts, IosSimulatorEnvironmentPorts, EnvironmentCommandReceipt } from "../../../packages/device-lab/providers/ports/mobile-environment.mjs";

const command: EnvironmentCommandReceipt = { status: 0, stdout: "ok\n", stderr: "" };
const failed: EnvironmentCommandReceipt = { status: null, stdout: "partial", stderr: "denied" };
const success = { kind: "succeeded" as const, command };
const failure = { kind: "failed" as const, command: failed };
const forbidden = () => { throw new Error("unexpected native effect"); };
function android(overrides: Partial<AndroidEmulatorEnvironmentPorts<string>> = {}): AndroidEmulatorEnvironmentPorts<string> {
    return { variant: "emulator", target: () => ({ kind: "ready", target: "opaque" }), setLocation: forbidden, setBattery: forbidden,
        tryAirplaneMode: forbidden, setAirplaneSetting: forbidden, broadcastAirplaneMode: forbidden, setRadio: forbidden,
        writeClipboard: forbidden, readClipboard: forbidden, ...overrides };
}
function ios(overrides: Partial<IosSimulatorEnvironmentPorts> = {}): IosSimulatorEnvironmentPorts {
    return { variant: "simulator", device: () => ({ id: "guest" }), target: () => ({ kind: "ready", target: "opaque" }),
        setLocation: forbidden, writeClipboard: forbidden, readClipboard: forbidden, ...overrides };
}

describe("mobile environment semantic policy", () => {
    it("branches on native observations and carries receipts without diagnosing their status", () => {
        const oddSuccess = { status: 7, stdout: "native success evidence" };
        const oddFailure = { status: 0, stderr: "native semantic failure" };
        const app = createAndroidEnvironment(android({ readClipboard: () => ({ kind: "succeeded", command: oddSuccess }), writeClipboard: () => ({ kind: "failed", command: oddFailure }) }));
        expect(app.request("mobile_get_clipboard", {})).toEqual({ kind: "clipboard-read", command: oddSuccess });
        expect(app.request("mobile_set_clipboard", { text: "data" })).toEqual({ kind: "command-failure", command: oddFailure });
    });
    it("rejects invalid networks before admission and leaves unhandled names untouched", () => {
        const app = createAndroidEnvironment(android({ target: forbidden }));
        for (const args of [{}, { wifi: "yes" }, { data: 0 }, { airplaneMode: null }]) expect(app.request("mobile_set_network", args)).toEqual({ kind: "refused", message: "Android network control requires boolean wifi, data or airplaneMode" });
        expect(app.request("unhandled", {})).toBeUndefined();
    });
    it("preserves unknown and refused admission without effects", () => {
        expect(createAndroidEnvironment(android({ target: () => ({ kind: "unknown" }) })).request("mobile_set_battery", {})).toBeUndefined();
        expect(createAndroidEnvironment(android({ target: () => ({ kind: "refused", message: "lease denied" }) })).request("mobile_set_battery", {})).toEqual({ kind: "refused", message: "lease denied" });
    });
    it("admits an empty battery request before refusing without effects", () => {
        const calls: unknown[] = [];
        const app = createAndroidEnvironment(android({ target: id => { calls.push(id); return { kind: "ready", target: "opaque" }; } }));
        expect(app.request("mobile_set_battery", { deviceId: "guest" })).toEqual({ kind: "refused", message: "Android battery control requires level, status, or charging" });
        expect(calls).toEqual(["guest"]);
    });
    it("applies level, status, charging in order with original receipts", () => {
        const calls: unknown[] = [];
        const result = createAndroidEnvironment(android({ setBattery: (target, setting) => { calls.push([target, setting]); return success; } })).request("mobile_set_battery", { level: 0, status: 2, charging: false });
        expect(calls).toEqual([["opaque", { setting: "level", value: 0 }], ["opaque", { setting: "status", value: 2 }], ["opaque", { setting: "charging", value: false }]]);
        expect(result).toEqual({ kind: "battery-set", battery: { level: 0, status: 2, charging: false }, commands: [command, command, command] });
        if (result?.kind === "battery-set") expect(result.commands[0]).toBe(command);
    });
    it.each(["level", "status", "charging"])("stops battery changes at failed %s", setting => {
        const calls: string[] = [];
        const app = createAndroidEnvironment(android({ setBattery: (_t, value) => { calls.push(value.setting); return value.setting === setting ? failure : success; } }));
        expect(app.request("mobile_set_battery", { level: 42, status: 2, charging: true })).toEqual({ kind: "command-failure", command: failed });
        expect(calls).toEqual(["level", "status", "charging"].slice(0, ["level", "status", "charging"].indexOf(setting) + 1));
    });
    it("passes Android coordinates, preserves unavailable observations and undefined defaults", () => {
        const calls: unknown[] = [];
        const app = createAndroidEnvironment(android({ setLocation: (target, value) => { calls.push([target, value]); return success; } }));
        const location = { latitude: 35, longitude: 129, altitude: 0 };
        expect(app.request("mobile_set_location", location)).toEqual({ kind: "location-set", location, command });
        expect(calls).toEqual([["opaque", location]]);
        expect(app.request("mobile_set_location", {})).toEqual({ kind: "location-set", location: { latitude: undefined, longitude: undefined, altitude: undefined }, command });
        expect(createAndroidEnvironment(android({ setLocation: () => ({ kind: "unavailable" }) })).request("mobile_set_location", location)).toEqual({ kind: "refused", message: "Android location requires an emulator serial or port" });
        expect(createAndroidEnvironment(android({ setLocation: () => failure })).request("mobile_set_location", {})).toEqual({ kind: "command-failure", command: failed });
        expect(createAndroidEnvironment(android({ setBattery: () => success })).request("mobile_set_battery", { charging: false })).toEqual({ kind: "battery-set", battery: { level: undefined, status: undefined, charging: false }, commands: [command] });
    });
    it("uses modern airplane success without legacy effects", () => {
        const calls: unknown[] = [];
        const app = createAndroidEnvironment(android({ tryAirplaneMode: (_t, enabled) => { calls.push(enabled); return success; } }));
        expect(app.request("mobile_toggle_airplane_mode", { enabled: true })).toEqual({ kind: "airplane-set", enabled: true, route: "modern", command });
        expect(calls).toEqual([true]);
    });
    it("falls back in order and returns the final broadcast receipt", () => {
        const calls: unknown[] = [];
        const broadcast = { status: 0, stdout: "broadcast", stderr: "" };
        const app = createAndroidEnvironment(android({ tryAirplaneMode: (_t, enabled) => { calls.push(["modern", enabled]); return failure; }, setAirplaneSetting: (_t, enabled) => { calls.push(["setting", enabled]); return success; }, broadcastAirplaneMode: (_t, enabled) => { calls.push(["broadcast", enabled]); return { kind: "succeeded", command: broadcast }; } }));
        expect(app.request("mobile_toggle_airplane_mode", { enabled: false })).toEqual({ kind: "airplane-set", enabled: false, route: "legacy", command: broadcast });
        expect(calls).toEqual([["modern", false], ["setting", false], ["broadcast", false]]);
    });
    it.each(["setting", "broadcast"])("stops network fallback at %s with accurate partial application", stage => {
        const app = createAndroidEnvironment(android({ tryAirplaneMode: () => failure, setAirplaneSetting: () => stage === "setting" ? failure : success, broadcastAirplaneMode: stage === "setting" ? forbidden : () => failure }));
        expect(app.request("mobile_set_network", { airplaneMode: true, wifi: false, data: true })).toEqual(stage === "setting" ? { kind: "network-failure", stage: "airplane-setting", command: failed } : { kind: "network-failure", stage: "airplane-broadcast", command: failed, applied: ["airplane-setting"] });
    });
    it.each(["wifi", "data"])("stops at failed %s and retains successful effects", stage => {
        const calls: unknown[] = [];
        const app = createAndroidEnvironment(android({ tryAirplaneMode: () => success, setRadio: (_t, setting, enabled) => { calls.push([setting, enabled]); return setting === stage ? failure : success; } }));
        expect(app.request("mobile_set_network", { airplaneMode: false, wifi: false, data: true })).toEqual({ kind: "network-failure", stage, command: failed, applied: stage === "wifi" ? ["airplane"] : ["airplane", "wifi"] });
        expect(calls).toEqual(stage === "wifi" ? [["wifi", false]] : [["wifi", false], ["data", true]]);
    });
    it("applies wifi then data and keeps omitted network values undefined", () => {
        const calls: unknown[] = [];
        const app = createAndroidEnvironment(android({ setRadio: (_t, setting, enabled) => { calls.push([setting, enabled]); return success; } }));
        expect(app.request("mobile_set_network", { wifi: true, data: false })).toEqual({ kind: "network-set", network: { wifi: true, data: false, airplaneMode: undefined } });
        expect(calls).toEqual([["wifi", true], ["data", false]]);
    });
    it("continues radios after successful legacy fallback and records no omitted airplane effect", () => {
        const calls: string[] = [];
        const app = createAndroidEnvironment(android({ tryAirplaneMode: () => { calls.push("modern"); return failure; }, setAirplaneSetting: () => { calls.push("setting"); return success; }, broadcastAirplaneMode: () => { calls.push("broadcast"); return success; }, setRadio: (_t, setting) => { calls.push(setting); return success; } }));
        expect(app.request("mobile_set_network", { airplaneMode: true, wifi: false, data: true })).toEqual({ kind: "network-set", network: { airplaneMode: true, wifi: false, data: true } });
        expect(calls).toEqual(["modern", "setting", "broadcast", "wifi", "data"]);
        expect(createAndroidEnvironment(android({ setRadio: () => failure })).request("mobile_set_network", { wifi: false })).toEqual({ kind: "network-failure", stage: "wifi", command: failed, applied: [] });
    });
    it("uses physical Android lookup alone for unsupported controls", () => {
        const ports: AndroidPhysicalEnvironmentPorts = { variant: "physical", device: id => id === "phone" ? { id } : undefined, target: forbidden, writeClipboard: forbidden, readClipboard: forbidden };
        const app = createAndroidEnvironment(ports);
        for (const name of ["mobile_set_location", "mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode"]) {
            expect(app.request(name, { deviceId: "phone" })).toEqual({ kind: "refused", message: `Android real devices do not support ${name} safely through the base ADB layer; use an emulator or a dedicated device-farm controller.` });
            expect(app.request(name, { deviceId: "missing" })).toBeUndefined();
        }
    });
    it.each(["Android", "iOS"])("preserves %s clipboard bytes and String conversion", platform => {
        const text = "한글 'quote'\nsecond line\n";
        const read = { status: 0, stdout: text, stderr: "" };
        const written: string[] = [];
        const leaves = { writeClipboard: (_target: unknown, value: string) => { written.push(value); return success; }, readClipboard: () => ({ kind: "succeeded" as const, command: read }) };
        const app = platform === "Android" ? createAndroidEnvironment(android(leaves)) : createIosEnvironment(ios(leaves));
        for (const value of [42, text, undefined]) expect(app.request("mobile_set_clipboard", { text: value })).toEqual({ kind: "clipboard-set", command });
        expect(written).toEqual(["42", text, "undefined"]);
        const result = app.request("mobile_get_clipboard", {});
        expect(result).toEqual({ kind: "clipboard-read", command: read });
        if (result?.kind === "clipboard-read") expect(result.command).toBe(read);
    });
    it.each(["Android", "iOS"])("preserves %s clipboard command failures", platform => {
        const leaves = { writeClipboard: () => failure, readClipboard: () => failure };
        const app = platform === "Android" ? createAndroidEnvironment(android(leaves)) : createIosEnvironment(ios(leaves));
        for (const name of ["mobile_set_clipboard", "mobile_get_clipboard"]) expect(app.request(name, {})).toEqual({ kind: "command-failure", command: failed });
    });
    it("looks up iOS device before target and preserves missing/refused observations", () => {
        const calls: string[] = [];
        const app = createIosEnvironment(ios({ device: () => { calls.push("lookup"); return { id: "guest" }; }, target: device => { calls.push(device.id); return { kind: "missing-prerequisites", missing: ["xcrun"] }; } }));
        expect(app.request("mobile_get_clipboard", {})).toEqual({ kind: "missing-prerequisites", missing: ["xcrun"] });
        expect(calls).toEqual(["lookup", "guest"]);
        expect(createIosEnvironment(ios({ target: () => ({ kind: "refused", message: "not owned" }) })).request("mobile_get_clipboard", {})).toEqual({ kind: "refused", message: "not owned" });
        expect(createIosEnvironment(ios({ device: () => undefined, target: forbidden })).request("mobile_get_clipboard", {})).toBeUndefined();
    });
    it("passes iOS coordinates without altitude and retains failures", () => {
        const calls: unknown[] = [];
        const app = createIosEnvironment(ios({ setLocation: (_target, value) => { calls.push(value); return success; } }));
        expect(app.request("mobile_set_location", { latitude: 35, longitude: 129, altitude: 7 })).toEqual({ kind: "location-set", location: { latitude: 35, longitude: 129 }, command });
        expect(calls).toEqual([{ latitude: 35, longitude: 129 }]);
        expect(createIosEnvironment(ios({ setLocation: () => failure })).request("mobile_set_location", {})).toEqual({ kind: "command-failure", command: failed });
    });
    it("refuses unsupported iOS controls after lookup without discovery", () => {
        for (const name of ["mobile_set_battery", "mobile_set_network", "mobile_toggle_airplane_mode"]) {
            expect(createIosEnvironment(ios({ target: forbidden })).request(name, {})).toEqual({ kind: "refused", message: `iOS Simulator does not support ${name} through base simctl; use Appium/XCUITest support when available.` });
            expect(createIosEnvironment(ios({ device: () => undefined, target: forbidden })).request(name, {})).toBeUndefined();
        }
        const app = createIosEnvironment({ variant: "physical", device: (id: string | undefined) => id === "phone" ? { id } : undefined });
        expect(app.request("mobile_get_clipboard", { deviceId: "phone" })).toEqual({ kind: "refused", message: "iOS real devices do not support mobile_get_clipboard through CCC because the action is unavailable or unsafe for physical devices." });
        expect(app.request("mobile_get_clipboard", { deviceId: "missing" })).toBeUndefined();
        expect(createIosEnvironment(ios({ device: forbidden })).request("unhandled", {})).toBeUndefined();
    });
    it("propagates thrown native errors without replaying fallback", () => {
        const error = new Error("native programming error");
        const app = createAndroidEnvironment(android({ tryAirplaneMode: () => { throw error; } }));
        expect(() => app.request("mobile_toggle_airplane_mode", { enabled: true })).toThrow(error);
    });
});
