import { describe, expect, it } from "vitest";
import { createDeviceObservation } from "../../../packages/device-lab/providers/application/device-observation.mjs";
import type { AndroidObservationPorts, HostAvds, HostDevices, IosHostDevice, IosObservationPorts, IosPhysicalObservationPorts, ObservationRecord, SimulatorObservation } from "../../../packages/device-lab/providers/ports/device-observation.mjs";

const common = { ownerId: () => "owner", now: () => 1000, readPhysicalLeases: () => [], capabilities: [] };
function androidFixture() {
    let emulator: string | null = "selected-emulator";
    let avds: HostAvds = { available: true, missing: [], avds: [] };
    const calls: string[] = [];
    const ports: AndroidObservationPorts = {
        ...common, kind: "android-emulator", records: () => [],
        executable: name => name === "emulator" ? emulator : name,
        hostAvds(command) { calls.push(command); return avds; },
        creationFacts: () => ({ systemImages: [], deviceProfiles: [] }),
    };
    return { ports, calls, emulator: (value: string | null) => { emulator = value; }, avds: (value: HostAvds) => { avds = value; } };
}
function iosFixture() {
    let records: ObservationRecord[] = [
        { id: "first", udid: "udid-first", simulatorName: "owned-first", status: "stopped", updatedAt: "first-version" },
        { id: "second", udid: "udid-second", simulatorName: "owned-second", status: "stopped", updatedAt: "second-version" },
    ];
    let observation: SimulatorObservation = { ok: true, detail: "", evidence: { native: "first" } };
    let status: "booted" | "stopped" | "unknown" = "booted";
    const calls: unknown[][] = [];
    const ports: IosObservationPorts = {
        ...common, kind: "ios-simulator", records: () => records,
        executable(name) { calls.push(["discovery", name]); return "selected-xcrun"; },
        listOwnedSimulators(command) { calls.push(["owned-query", command]); return observation; },
        simulatorCatalog(command) { calls.push(["catalog-query", command]); return observation; },
        ownedTarget(command, device, captured) { calls.push(["target", command, device.id, captured]); return { matched: true, status, name: device.simulatorName }; },
        publishObserved(device, nextStatus, name) {
            calls.push(["publish", device, nextStatus, name]);
            return { ...device, status: nextStatus, simulatorName: name };
        },
    };
    return { ports, calls, records: (value: ObservationRecord[]) => { records = value; },
        state: (value: typeof status) => { status = value; },
        observation: (value: SimulatorObservation) => { observation = value; }, snapshot: () => observation };
}

describe("mobile inventories compose normalized native observations", () => {
    it("keeps unavailable AVD inventory distinct from successful empty and missing emulator", () => {
        const f = androidFixture(), app = createDeviceObservation(f.ports);
        const failed: HostAvds = { available: false, missing: [], avds: [], error: "query unavailable" };
        f.avds(failed);
        expect(app.inventory()?.hostAvds).toBe(failed);
        f.avds({ available: true, missing: [], avds: [] });
        expect(app.inventory()?.hostAvds).toEqual({ available: true, missing: [], avds: [] });
        f.emulator(null);
        expect(app.inventory()?.hostAvds).toEqual({ available: false, missing: ["emulator"], avds: [] });
        expect(f.calls).toEqual(["selected-emulator", "selected-emulator"]);
    });

    it("backend mismatch returns before inventory discovery or host observation", () => {
        const f = androidFixture();
        f.ports.executable = () => { throw new Error("wrong-backend-must-not-discover"); };
        expect(createDeviceObservation(f.ports).inventory({ backend: "ios-simulator" })).toBeUndefined();
        expect(f.calls).toEqual([]);
    });

    it("empty and identity-only owned simulator listings do not discover or query tools", () => {
        const f = iosFixture(), app = createDeviceObservation(f.ports);
        expect(app.owned({ identityOnly: true })).toHaveLength(2);
        f.records([]);
        expect(app.owned()).toEqual([]);
        expect(f.calls).toEqual([]);
    });

    it("one owned observation serves all records and the next operation refreshes it", () => {
        const f = iosFixture(), app = createDeviceObservation(f.ports), first = f.snapshot();
        expect(app.owned().map(device => device.status)).toEqual(["booted", "booted"]);
        expect(f.calls.filter(row => row[0] === "owned-query")).toEqual([["owned-query", "selected-xcrun"]]);
        expect(f.calls.filter(row => row[0] === "target").map(row => row[3])).toEqual([first, first]);
        f.calls.length = 0;
        const second = { ok: true, detail: "", evidence: { native: "second" } };
        f.observation(second); f.state("unknown");
        expect(app.owned().map(device => device.status)).toEqual(["unknown", "unknown"]);
        expect(f.calls.filter(row => row[0] === "discovery")).toHaveLength(1);
        expect(f.calls.filter(row => row[0] === "owned-query")).toHaveLength(1);
        expect(f.calls.filter(row => row[0] === "target").map(row => row[3])).toEqual([second, second]);
    });

    it("catalog composition reuses its captured observation for reconciliation without a second owned query", () => {
        const f = iosFixture();
        const captured = f.snapshot();
        const value = createDeviceObservation(f.ports).inventory();
        expect(value?.catalog).toBe(captured);
        expect(value?.devices.map(device => device.status)).toEqual(["booted", "booted"]);
        expect(value).not.toHaveProperty("hostSimulators");
        expect(f.calls.filter(row => row[0] === "catalog-query")).toEqual([["catalog-query", "selected-xcrun"]]);
        expect(f.calls.filter(row => row[0] === "owned-query")).toEqual([]);
        expect(f.calls.filter(row => row[0] === "target").map(row => row[3])).toEqual([captured, captured]);
    });

    it("unmatched targets and unavailable simulator discovery never publish a replacement", () => {
        const f = iosFixture(), app = createDeviceObservation(f.ports);
        f.ports.ownedTarget = () => ({ matched: false });
        expect(app.owned().map(device => device.status)).toEqual(["stopped", "stopped"]);
        expect(f.calls.some(row => row[0] === "publish")).toBe(false);
        f.calls.length = 0;
        f.ports.executable = () => null;
        f.ports.ownedTarget = () => { throw new Error("missing-tool-must-not-resolve-target"); };
        expect(app.owned().map(device => device.status)).toEqual(["stopped", "stopped"]);
        expect(f.calls).toEqual([]);
    });

    it("a refused current-record publication retains the captured device instead of inventing the observed state", () => {
        const f = iosFixture();
        f.ports.publishObserved = () => null;
        expect(createDeviceObservation(f.ports).owned().map(device => device.status)).toEqual(["stopped", "stopped"]);
    });

    it("physical iOS inventory carries unavailable facts and skips the host query when xcrun is missing", () => {
        let available = true;
        const calls: string[] = [];
        const inventory: HostDevices<IosHostDevice> = { available: false, missing: [], devices: [], error: "xctrace unavailable" };
        const ports: IosPhysicalObservationPorts = {
            ...common, kind: "ios-device", records: () => [], executable: () => "selected-xcodebuild",
            simulatorPrerequisites: () => ({ available, missing: available ? [] : ["xcrun"], xcrun: available ? "selected-xcrun" : null }),
            hostDevices(command) { calls.push(command); return inventory; },
        };
        const app = createDeviceObservation(ports);
        expect(app.inventory()?.hostDevices).toBe(inventory);
        available = false;
        expect(app.inventory()?.hostDevices).toEqual({ available: false, missing: ["xcrun"], devices: [] });
        expect(calls).toEqual(["selected-xcrun"]);
    });
});
