import { describe, expect, it } from "vitest";
import { createBrokerAppiumApplication } from "../../../packages/device-lab/src/device-lab/application/broker-appium.js";
import { validateAppiumRequestParams, type BrokerAppiumResponse } from "../../../packages/device-lab/src/device-lab/domain/broker-appium.js";
import type { BrokerAppiumPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-appium.js";

function appiumCapabilityContracts<Runtime>(ports: BrokerAppiumPorts<Runtime>): void {
    const app = createBrokerAppiumApplication(ports);
    const params = { backend: "android-emulator", deviceId: "pixel" };
    const responses: Promise<BrokerAppiumResponse>[] = [
        app.start("owner", params), app.stop("owner", params),
        app.ensureSession("owner", params), app.deleteSession("owner", params),
        app.request("owner", { ...params, method: "GET", path: "/source" }),
        app.record("owner", { ...params, sessionId: "session" }), app.clear("owner", params),
    ];
    const { publish: _publish, ...withoutPublication } = ports;
    // @ts-expect-error State publication must retain its expected-generation authority.
    createBrokerAppiumApplication(withoutPublication);
    const { withDeviceOperation: _deviceLock, ...withoutDeviceLock } = ports;
    // @ts-expect-error Appium mutations require the owner/device operation lock.
    createBrokerAppiumApplication(withoutDeviceLock);
    const { withInstallLock: _installLock, ...withoutInstallLock } = ports;
    // @ts-expect-error Managed runtime installation requires the shared native install lock.
    createBrokerAppiumApplication(withoutInstallLock);
    // @ts-expect-error Native publication must return a settled generation comparison.
    createBrokerAppiumApplication({ ...ports, publish: async () => ({ found: true, matched: true, currentAppium: null, device: null }) });
    // @ts-expect-error Manifest publication must settle before npm execution or runtime reuse.
    createBrokerAppiumApplication({ ...ports, writeManifest: async () => undefined });
    // @ts-expect-error Synchronous installation commands require a concrete completed execution.
    createBrokerAppiumApplication({ ...ports, installRuntime: async () => ({ status: 0, receipt: {} }) });
    const { launchServer, ...withoutLaunch } = ports;
    // @ts-expect-error Server launch is a required finite native effect.
    createBrokerAppiumApplication(withoutLaunch);
    // @ts-expect-error Instrumentation reset settles each effect before the next step.
    createBrokerAppiumApplication({ ...ports, resetInstrumentation: async () => ({ status: 0, receipt: {} }) });
    // @ts-expect-error The core cannot construct an arbitrary native process recipe.
    ports.execute({ executable: "appium", args: [] });
    // @ts-expect-error CCC HTTP payloads are rendered outside the application.
    const payload = (awaited: BrokerAppiumResponse) => awaited.payload;
    // @ts-expect-error Operation locks and cleanup settle before the response is available.
    const synchronous: BrokerAppiumResponse = app.stop("owner", params);
    void [responses, _publish, _deviceLock, _installLock, synchronous, launchServer, payload];
}
void appiumCapabilityContracts;

describe("Appium request contracts", () => {
    it("rejects upstream DELETE commands while session deletion remains a separate broker operation", () => {
        expect(validateAppiumRequestParams({ backend: "android-emulator", deviceId: "pixel", method: "DELETE", path: "/source" })).toEqual({
            ok: false, reason: "invalid", error: "invalid-appium-request-method", allowed: ["GET", "POST"],
        });
    });

    it("rejects a path escaping the broker-owned WebDriver session", () => {
        expect(validateAppiumRequestParams({ backend: "android-emulator", deviceId: "pixel", method: "GET", path: "/../source" })).toEqual({
            ok: false, reason: "invalid", error: "invalid-appium-request-path",
        });
    });
});
