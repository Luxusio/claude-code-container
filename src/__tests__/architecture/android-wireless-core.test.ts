import { describe, expect, it } from "vitest";
import { parseAndroidWifiEndpoint } from "../../../packages/device-lab/providers/domain/android-wireless.mjs";
import { createAndroidWirelessApplication } from "../../../packages/device-lab/providers/application/android-wireless.mjs";

function fixture() {
    const receipt = { provider: "adb" as const, args: ["native"], status: 0, stdout: "", stderr: "", signal: null, error: null };
    const ports = {
        discover: () => ({ available: true as const, target: { native: "owned" } }),
        listDevices: () => ({ status: 0, stdout: "List of devices attached\nUSB device\n", stderr: "" }),
        tcpip: (_target: object, _serial: string, _port: number, _timeout: unknown) => receipt,
        pair: (_target: object, _endpoint: string, _code: string | number, _timeout: unknown) => receipt,
        connect: (_target: object, _endpoint: string, _timeout: unknown) => receipt,
        jsonResult: (value: object) => value,
        textResult: (_ok: boolean, text: string): object => JSON.parse(text),
    };
    return { ports, receipt };
}
describe("Android wireless policy", () => {
    it("admits IPv6 endpoints and refuses out-of-range ports", () => {
        expect(parseAndroidWifiEndpoint("[2001:db8::1]:4321", 5555)).toEqual({ host: "2001:db8::1", port: 4321 });
        expect(parseAndroidWifiEndpoint("host:65536", 5555)).toBeNull();
    });
    it("reports inventory without attaching devices", () => {
        const { ports } = fixture();
        expect(createAndroidWirelessApplication(ports).handle({ action: "status" })).toMatchObject({ ok: true, hostDevices: { available: true } });
    });
    it("uses the default connection port and retains attachment guidance", () => {
        const { ports, receipt } = fixture();
        ports.connect = (_target, endpoint) => { expect(endpoint).toBe("192.0.2.1:5555"); return receipt; };
        expect(createAndroidWirelessApplication(ports).handle({ action: "connect", host: "192.0.2.1" })).toMatchObject({ ok: true, target: "192.0.2.1:5555", stateMutated: false });
    });
    it("does not connect after pairing fails", () => {
        const { ports, receipt } = fixture();
        ports.pair = () => ({ ...receipt, status: 7, stderr: "pair refused" });
        ports.connect = () => { throw new Error("failed-pair-must-not-connect"); };
        expect(createAndroidWirelessApplication(ports).handle({ action: "pair", pairHost: "host", pairPort: 37099, pairingCode: "123456", host: "host" })).toMatchObject({ ok: false, error: "android-wireless-pair-failed" });
    });
    it("retains native redacted pair evidence when follow-up connection fails", () => {
        const { ports, receipt } = fixture();
        ports.pair = () => ({ ...receipt, args: ["pair", "host:37099", "[redacted]"], stdout: "[redacted]", stderr: "[redacted]" });
        ports.connect = () => ({ ...receipt, status: 8, stderr: "connect refused" });
        expect(createAndroidWirelessApplication(ports).handle({ action: "pair", pairHost: "host", pairPort: 37099, pairingCode: "123456", host: "host" })).toMatchObject({ ok: false, error: "android-wireless-connect-failed", pair: { stdout: "[redacted]" } });
    });
});
