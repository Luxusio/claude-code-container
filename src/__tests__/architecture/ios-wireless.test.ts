import { describe, expect, it } from "vitest";
import { createIosWirelessApplication } from "../../../packages/device-lab/providers/application/ios-wireless.mjs";
import type { IosWirelessInventory, IosWirelessPorts } from "../../../packages/device-lab/providers/ports/ios-wireless.mjs";

const unexpected = (): never => { throw new Error("Refused wireless action must not observe the host"); };
const wifi = { name: "Network iPhone", udid: "wifi-udid", version: "17.5", connection: "wifi", raw: "Network iPhone (17.5) (wifi-udid) (Network)" };
const usb = { name: "Network Named USB iPhone", udid: "usb-udid", version: "17.5", connection: "usb", raw: "Network Named USB iPhone (17.5) (usb-udid)" };
const inventory = { available: true, missing: [], devices: [usb, wifi], source: "owned-native-observation" };
const ports: IosWirelessPorts = { discover: () => ({ xcrun: "/fixture/xcrun" }), listDevices: () => inventory };

describe("iOS provider wireless application", () => {
    it("leaves unknown backends unhandled and refuses non-status actions before discovery", () => {
        const app = createIosWirelessApplication({ discover: unexpected, listDevices: unexpected });
        expect(app.request({ backend: "android-device", action: "status" })).toBeUndefined();
        const refused = app.request({ action: "connect", udid: wifi.udid });
        if (refused?.kind !== "text") throw new Error("Expected provider wireless refusal");
        expect(JSON.parse(refused.message)).toMatchObject({
            ok: false, backend: "ios-device", action: "connect", udid: wifi.udid,
            error: "ios-wireless-pairing-requires-xcode-trust",
            attachFlow: "Run device_inventory for backend ios-device, confirm the UDID is visible as a network device through xctrace, then call device_attach with connection=wifi.",
        });
        expect(JSON.parse(refused.message)).not.toHaveProperty("networkVisible");
    });

    it("reports missing xcrun without attempting an inventory observation", () => {
        const result = createIosWirelessApplication({ discover: () => ({ xcrun: null }), listDevices: unexpected }).request();
        if (result?.kind !== "text") throw new Error("Expected missing-prerequisite refusal");
        expect(JSON.parse(result.message)).toMatchObject({ ok: false, backend: "ios-device", action: "status", error: "ios-wireless-missing-xcrun", missing: ["xcrun"] });
    });

    it.each([
        [{ available: false, missing: [], devices: [], error: "xctrace observation denied" }, "xctrace observation denied"],
        [{ available: false, missing: ["xcrun", "device visibility"], devices: [] }, "xcrun, device visibility"],
    ] satisfies Array<[IosWirelessInventory, string]>)("reports failed inventory with its actionable detail", (observation, detail) => {
        const result = createIosWirelessApplication({ ...ports, listDevices: () => observation }).request();
        if (result?.kind !== "text") throw new Error("Expected inventory failure");
        expect(JSON.parse(result.message)).toEqual({ ok: false, backend: "ios-device", action: "status", error: "ios-wireless-inventory-failed", detail });
    });

    it("uses selected transport rather than the display name and retains observed inventory metadata", () => {
        const app = createIosWirelessApplication(ports);
        expect(app.request({ udid: usb.udid })).toMatchObject({ kind: "json", payload: { selected: usb, udid: usb.udid, networkVisible: false, inventory } });
        expect(app.request({ udid: wifi.udid })).toMatchObject({ kind: "json", payload: {
            ok: true, backend: "ios-device", provider: "xcrun-xctrace", selected: wifi, networkVisible: true,
            supportedActions: ["status"], unsupportedActions: ["pair", "connect", "usb-tcpip"], inventory,
        } });
    });

    it("reports any visible WiFi device when no requested UDID is selected", () => {
        const app = createIosWirelessApplication(ports);
        expect(app.request({ udid: "unknown-udid" })).toMatchObject({ kind: "json", payload: { selected: null, udid: "unknown-udid", networkVisible: true } });
        expect(app.request()).toMatchObject({ kind: "json", payload: { selected: null, udid: null, networkVisible: true } });
        expect(createIosWirelessApplication({ ...ports, listDevices: () => ({ available: true, missing: [], devices: [usb] }) }).request()).toMatchObject({ kind: "json", payload: { selected: null, networkVisible: false } });
    });
});
