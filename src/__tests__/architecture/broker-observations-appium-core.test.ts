import { describe, expect, it } from "vitest";
import { createAppiumObservations } from "@ccc/device-lab/device-lab/application/broker-observation-appium.js";

const request = { backend: "android-emulator", stateKey: "android", deviceId: "owned" };
describe("broker Appium metadata observation", () => {
    it("returns the exact matching record and metadata without live queries", () => {
        const appium = { serverUrl: "synthetic", sessionId: "id" }; const device = { id: "owned", appium };
        const observe = createAppiumObservations({ read: (owner, key) => { expect([owner, key]).toEqual(["owner", "android"]); return [{ id: "other" }, device]; } });
        const result = observe.status("owner", request); expect(result.kind).toBe("observed");
        if (result.kind === "observed") { expect(result.value.device).toBe(device); expect(result.value.appium).toBe(appium); }
    });
    it.each([false, 0, "", null, undefined])("preserves non-nullish appium value %j", appium => {
        const observe = createAppiumObservations({ read: () => [{ id: "owned", appium }] });
        const result = observe.status("owner", request);
        if (result.kind !== "observed") throw new Error("missing record"); expect(result.value.appium).toBe(appium ?? null);
    });
    it("lists idle records and reads projection getters before rejecting an invalid id", () => {
        const trace: string[] = [];
        const invalid = { get id() { trace.push("id"); return 1; }, get status() { trace.push("status"); return 0; }, get appium() { trace.push("appium"); return false; } };
        const array = Object.assign([], { id: "array", status: "", appium: false });
        const observe = createAppiumObservations({ read: () => [invalid, { id: "idle" }, array, null, 2] });
        expect(observe.list("owner", request)).toEqual({ kind: "observed", value: { ownerId: "owner", backend: "android-emulator", stateKey: "android", sessions: [
            { deviceId: "idle", status: null, appium: null }, { deviceId: "array", status: "", appium: false },
        ] } });
        expect(trace).toEqual(["id", "status", "appium"]);
    });
    it("catches only the owner read and relays projection exceptions unchanged", () => {
        const sentinel = {}; const failed = createAppiumObservations({ read: () => { throw sentinel; } });
        expect(failed.status("owner", request)).toEqual({ kind: "read-failed", error: sentinel });
        const projected = createAppiumObservations({ read: () => [{ id: 1, get status() { throw sentinel; } }] });
        try { projected.list("owner", request); throw new Error("unexpected success"); } catch (error) { expect(error).toBe(sentinel); }
    });
    it("distinguishes missing device from present idle metadata", () => {
        const observe = createAppiumObservations({ read: () => [] }); expect(observe.status("owner", request)).toEqual({ kind: "not-found" });
        expect(observe.list("owner", request)).toMatchObject({ kind: "observed", value: { sessions: [] } });
    });
});
