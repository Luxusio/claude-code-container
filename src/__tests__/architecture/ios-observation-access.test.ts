import { describe, expect, it, vi } from "vitest";
import { createIosObservationAccess } from "../../../packages/device-lab/providers/application/ios-observation-access.mjs";
import type { IosAccessDevice, IosSimulatorAccessPorts } from "../../../packages/device-lab/providers/ports/ios-observation-access.mjs";

function simulatorPorts(device: IosAccessDevice): IosSimulatorAccessPorts<IosAccessDevice, object> {
    return {
        kind: "simulator", findDevice: () => device,
        discovery: () => ({ available: true, xcrun: "xcrun", missing: [] }),
        appiumDiscovery: () => ({ available: true, xcrun: "xcrun", appium: "appium", missing: [] }),
        backend: () => ({ name: "ios-simulator" }), targetStatus: value => value,
        withDeviceOperation: async (_id, operation) => operation(),
        waitBudget: () => ({ timeoutMs: 100, remaining: () => 100, requestTimeout: () => 100, pause: async () => {} }),
        requestHttp: async (_url, options) => options.method === "POST" ? { value: { sessionId: "new-session" } } : { value: { ready: true } },
        spawnServer: () => ({ pid: 42, onExit: () => undefined, unref: () => undefined, abortStartup: () => undefined }),
        inspectRuntime: () => ({ status: "match" }), waitIdentity: async () => ({ pid: 42, startToken: "owned-start" }),
        refreshRuntime: value => value, terminateRuntime: async () => ({ exited: true }), isAlive: () => true,
        publishAppium: (_id, _expected, replacement) => ({ committed: true, device: { ...device, appium: replacement } }),
        updateAppiumPort: () => device,
        guardObservation: () => undefined, checkObservation: () => undefined,
        timestamp: () => "2026-10-11T00:00:00.000Z", runtimeId: () => "new-runtime", portForDevice: () => 4723,
        pause: async () => {}, diagnostic: text => text,
        jsonResult: value => value, textResult: (ok, message) => ({ ok, message }),
        commandFailure: command => ({ ok: false, command }), imageResult: data => ({ data }),
        verifyTarget: () => ({ target: "OWNED-UDID" }),
        execute: () => ({ status: 0, stdout: "", stderr: "" }), missingPrerequisites: () => ({ ok: false }),
        reconcileDevice: value => value,
        appContainer: () => ({ status: 0, stdout: "/container\n", stderr: "" }),
        pathInContainer: (_root, requested) => ({ path: `/container/${requested}` }), guardRead: () => ({}),
        listArgumentError: () => null, listDirectory: () => ({ entries: [] }),
        stageScreenshot: () => ({ path: "/owned-stage/screenshot.png", dispose: () => undefined }),
        readScreenshot: () => ({ ok: false, message: "screenshot missing" }), publishErased: () => device,
    };
}

describe("iOS observation and access", () => {
    it("does not allocate a server or session after stale reconciliation finds the record missing", async () => {
        const oldAppium = { runtimeId: "old-runtime", processOwner: "device-lab-mcp", startedBy: "direct-provider",
            serverPid: 41, processIdentity: { pid: 41 }, serverUrl: "http://old-server", sessionId: "old-session" };
        const ports = simulatorPorts({ id: "owned", udid: "OWNED-UDID", appium: oldAppium });
        ports.publishAppium = () => ({ committed: true, device: null });
        ports.spawnServer = () => { throw new Error("missing record must not spawn a new server"); };
        const request = vi.fn<IosSimulatorAccessPorts<IosAccessDevice, object>["requestHttp"]>(async (url, options) => {
            if (options.method === "GET" && url === "http://old-server/status") throw new Error("stale server");
            if (options.method === "DELETE" && url === "http://old-server/session/old-session") return { value: null };
            throw new Error("missing record must not create a session");
        });
        const terminate = vi.fn(ports.terminateRuntime);
        ports.requestHttp = request; ports.terminateRuntime = terminate;
        expect(await createIosObservationAccess(ports).ensureSession("owned")).toEqual({ unknown: true });
        expect(request).toHaveBeenCalledWith("http://old-server/session/old-session", { method: "DELETE" });
        expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "old-runtime", pid: 41 }), "iOS Simulator stale Appium");
    });

    it("disposes the allocated screenshot stage even when the image is missing", async () => {
        const ports = simulatorPorts({ id: "owned" });
        const dispose = vi.fn<() => undefined>(() => undefined);
        ports.stageScreenshot = () => ({ path: "/owned-stage/screenshot.png", dispose });
        expect(await createIosObservationAccess(ports).request("device_screenshot", { deviceId: "owned" })).toEqual({
            ok: false, message: "screenshot missing",
        });
        expect(dispose).toHaveBeenCalled();
    });

    it("keeps the current definition when erase returns a native failure", async () => {
        const device = { id: "owned", status: "booted" };
        const ports = simulatorPorts(device);
        ports.execute = () => ({ status: 7, stdout: "", stderr: "erase refused" });
        ports.publishErased = () => { throw new Error("failed erase must not publish"); };
        expect(await createIosObservationAccess(ports).request("device_reset", { deviceId: "owned", eraseSimulator: true })).toEqual({
            ok: false, command: { status: 7, stdout: "", stderr: "erase refused" },
        });
        expect(device).toEqual({ id: "owned", status: "booted" });
    });

    it("cleans up the newly allocated session and server when publication loses to a successor", async () => {
        const successor = { id: "owned", appium: { runtimeId: "successor", sessionId: "successor-session" } };
        const ports = simulatorPorts({ id: "owned", udid: "OWNED-UDID" });
        ports.publishAppium = (_id, _expected, replacement) => replacement === null
            ? { committed: true, device: { id: "owned", udid: "OWNED-UDID", appium: null } }
            : { committed: false, device: successor };
        const request = vi.fn(ports.requestHttp), terminate = vi.fn(ports.terminateRuntime);
        ports.requestHttp = request; ports.terminateRuntime = terminate;
        expect(await createIosObservationAccess(ports).ensureSession("owned")).toEqual({
            error: "iOS Simulator Appium state changed before the new session was committed",
        });
        expect(request).toHaveBeenCalledWith("http://127.0.0.1:4723/session/new-session", expect.objectContaining({ method: "DELETE" }));
        expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "new-runtime", serverPid: 42 }),
            "iOS Simulator Appium superseded startup");
        expect(successor).toEqual({ id: "owned", appium: { runtimeId: "successor", sessionId: "successor-session" } });
    });
});
