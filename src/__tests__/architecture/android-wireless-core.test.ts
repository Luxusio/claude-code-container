import { describe, expect, it } from "vitest";
import { parseAndroidWifiEndpoint } from "../../../packages/device-lab/providers/domain/android-wireless.mjs";
import { createAndroidWirelessApplication } from "../../../packages/device-lab/providers/application/android-wireless.mjs";
import type { AndroidWirelessEvidence, AndroidWirelessPorts } from "../../../packages/device-lab/providers/ports/android-wireless.mjs";
import type { AndroidHostDevice, HostDevices } from "../../../packages/device-lab/providers/ports/device-observation.mjs";

function fixture() {
    const calls: unknown[][] = [];
    const target = { native: "selected-adb" };
    const evidence: AndroidWirelessEvidence = { provider: "adb", args: ["native"], status: 0, stdout: "", stderr: "", signal: null, error: null };
    const inventory: HostDevices<AndroidHostDevice> = { available: true, missing: [], devices: [{ serial: "USB", state: "device" }] };
    const ports: AndroidWirelessPorts<typeof target> = {
        discover() { calls.push(["discover"]); return { available: true, target }; },
        listDevices(selected) { calls.push(["inventory", selected]); return inventory; },
        tcpip(selected, serial, port, timeout) { calls.push(["tcpip", selected, serial, port, timeout]); return { ok: true, evidence }; },
        pair(selected, endpoint, code, timeout) { calls.push(["pair", selected, endpoint, code, timeout]); return { ok: true, evidence }; },
        connect(selected, endpoint, timeout) { calls.push(["connect", selected, endpoint, timeout]); return { ok: true, evidence }; },
    };
    return { ports, evidence, target, inventory, calls };
}

describe("Android wireless policy over normalized observations", () => {
    it("formats IPv6 and honors embedded ports while refusing invalid endpoint ports", () => {
        expect(parseAndroidWifiEndpoint("[2001:db8::1]:4321", 5555)).toEqual({ host: "2001:db8::1", port: 4321 });
        expect(parseAndroidWifiEndpoint("2001:db8::1", 5555)).toEqual({ host: "2001:db8::1", port: 5555 });
        expect(parseAndroidWifiEndpoint("host:65536", 5555)).toBeNull();
        expect(parseAndroidWifiEndpoint("host:0", 5555)).toBeNull();
    });

    it("ignores other backends before discovery and refuses missing adb without inventory or mutation", () => {
        const f = fixture(), app = createAndroidWirelessApplication(f.ports);
        expect(app.handle({ backend: "ios-device" })).toBeUndefined();
        expect(f.calls).toEqual([]);
        f.ports.discover = () => ({ available: false });
        expect(app.handle({ action: "connect", host: "host" })).toMatchObject({ kind: "refused", error: "android-wireless-missing-adb" });
        expect(f.calls).toEqual([]);
    });

    it("status retains unavailable inventory as a successful observation without running a mutation", () => {
        const f = fixture();
        const unavailable = { available: false, missing: [], devices: [], error: "inventory unavailable" };
        f.ports.listDevices = selected => { f.calls.push(["inventory", selected]); return unavailable; };
        expect(createAndroidWirelessApplication(f.ports).handle({ action: "status", timeoutMs: 1 })).toEqual({ kind: "status", hostDevices: unavailable });
        expect(f.calls).toEqual([["discover"], ["inventory", f.target]]);
    });

    it("connect uses serial precedence and carries attachment guidance without inspecting successful evidence", () => {
        const f = fixture();
        const contradictory = { ...f.evidence, status: 23, stderr: "diagnostic only" };
        f.ports.connect = (selected, endpoint, timeout) => { f.calls.push(["connect", selected, endpoint, timeout]); return { ok: true, evidence: contradictory }; };
        const result = createAndroidWirelessApplication(f.ports).handle({ action: "connect", serial: "[2001:db8::2]:4321", host: "ignored", port: 5555, timeoutMs: 777 });
        expect(result).toEqual({ kind: "completed", action: "connect", target: "[2001:db8::2]:4321", connection: contradictory,
            attachNext: { tool: "device_attach", arguments: { backend: "android-device", connection: "wifi", host: "2001:db8::2", port: 4321 } } });
        expect(f.calls).toEqual([["discover"], ["connect", f.target, "[2001:db8::2]:4321", 777]]);
    });

    it("uses the default connect port and forwards the mutation timeout to its native leaf", () => {
        const f = fixture();
        expect(createAndroidWirelessApplication(f.ports).handle({ action: "connect", host: "192.0.2.1" })).toMatchObject({ kind: "completed", target: "192.0.2.1:5555" });
        expect(f.calls).toEqual([["discover"], ["connect", f.target, "192.0.2.1:5555", 15000]]);
    });

    it.each(["usb-tcpip", "pair"] as const)("%s preparation happens before a later optional-target refusal", action => {
        const f = fixture();
        const args = action === "usb-tcpip"
            ? { action, serial: "USB", connect: true, timeoutMs: 91 }
            : { action, pairHost: "2001:db8::9", pairPort: 37099, pairingCode: "123456", connect: true, timeoutMs: 91 };
        const result = createAndroidWirelessApplication(f.ports).handle(args);
        expect(result).toEqual({ kind: "refused", error: "android-wireless-connect-requires-host", preparation: { kind: action === "pair" ? "pair" : "tcpip", evidence: f.evidence } });
        expect(f.calls).toEqual([["discover"], action === "pair"
            ? ["pair", f.target, "[2001:db8::9]:37099", "123456", 91]
            : ["tcpip", f.target, "USB", 5555, 91]]);
    });

    it.each(["usb-tcpip", "pair"] as const)("failed %s fact prevents connection even if its receipt reports exit zero", action => {
        const f = fixture();
        f.ports.tcpip = () => ({ ok: false, evidence: f.evidence });
        f.ports.pair = () => ({ ok: false, evidence: f.evidence });
        f.ports.connect = () => { throw new Error("preparation-failure-must-not-connect"); };
        const args = action === "usb-tcpip" ? { action, serial: "USB", host: "host" }
            : { action, pairHost: "host", pairPort: 37099, pairingCode: "123456", host: "host" };
        expect(createAndroidWirelessApplication(f.ports).handle(args)).toEqual({ kind: "command-failed", error: `android-wireless-${action}-failed`, evidence: f.evidence });
    });

    it("failed connection retains the exact completed preparation evidence", () => {
        const f = fixture();
        const paired = { ...f.evidence, args: ["pair", "host:37099", "[redacted]"], stdout: "[redacted]" };
        f.ports.pair = () => ({ ok: true, evidence: paired });
        f.ports.connect = () => ({ ok: false, evidence: f.evidence });
        expect(createAndroidWirelessApplication(f.ports).handle({ action: "pair", pairHost: "host", pairPort: 37099, pairingCode: "123456", host: "host" }))
            .toEqual({ kind: "command-failed", error: "android-wireless-connect-failed", evidence: f.evidence, preparation: { kind: "pair", evidence: paired } });
    });

    it("successful preparation alone completes without creating an attachment or running connect", () => {
        const f = fixture();
        const result = createAndroidWirelessApplication(f.ports).handle({ action: "usb-tcpip", serial: "USB", port: 5556 });
        expect(result).toEqual({ kind: "completed", action: "usb-tcpip", serial: "USB", preparation: { kind: "tcpip", evidence: f.evidence } });
        expect(f.calls).toEqual([["discover"], ["tcpip", f.target, "USB", 5556, 15000]]);
    });
});
