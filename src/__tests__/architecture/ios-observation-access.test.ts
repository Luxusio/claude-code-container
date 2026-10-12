import { describe, expect, it, vi } from "vitest";
import { createIosObservationAccess } from "../../../packages/device-lab/providers/application/ios-observation-access.mjs";
import type { IosAccessDevice, IosSimulatorAccessPorts, IosPhysicalAccessPorts, IosAccessAppiumEffect, IosAccessAppiumResult, IosAccessSimulatorResult } from "../../../packages/device-lab/providers/ports/ios-observation-access.mjs";

function simulatorPorts(device: IosAccessDevice): IosSimulatorAccessPorts<IosAccessDevice, object> {
    return {
        kind: "simulator", findDevice: () => device,
        discovery: () => ({ available: true, missing: [] }),
        appiumDiscovery: () => ({ available: true, missing: [] }),
        backend: () => ({ name: "ios-simulator" }), targetStatus: value => value,
        withDeviceOperation: async (_id, operation) => operation(),
        waitBudget: () => ({ timeoutMs: 100, remaining: () => 100, requestTimeout: () => 100, pause: async () => {} }),
        appiumEffect: async effect => (effect.kind === "create-session" ? { sessionId: "new-session" } : undefined) as IosAccessAppiumResult<typeof effect>,
        spawnServer: () => ({ pid: 42, onExit: () => undefined, unref: () => undefined, abortStartup: () => undefined }),
        inspectRuntime: () => ({ status: "match" }), waitIdentity: async () => ({ pid: 42, startToken: "owned-start" }),
        refreshRuntime: value => value, terminateRuntime: async () => ({ exited: true }), isAlive: () => true,
        publishAppium: (_id, _expected, replacement) => ({ committed: true, device: { ...device, appium: replacement } }),
        updateAppiumPort: () => device,
        guardObservation: () => undefined, checkObservation: () => undefined,
        timestamp: () => "2026-10-11T00:00:00.000Z", runtimeId: () => "new-runtime", portForDevice: () => 4723,
        serverUrlForPort: port => `http://127.0.0.1:${port}`,
        pause: async () => {}, diagnostic: text => text,
        jsonResult: value => value, textResult: (ok, message) => ({ ok, message }),
        commandFailure: command => ({ ok: false, command }), imageResult: data => ({ data }),
        verifyTarget: () => ({ target: "OWNED-UDID" }),
        simulatorEffect: effect => ({ ok: true, status: 0, stdout: "", stderr: "", ...(effect.kind === "app-container" ? { path: "/container" } : {}) }) as IosAccessSimulatorResult<typeof effect>, missingPrerequisites: () => ({ ok: false }),
        reconcileDevice: value => value,
        pathInContainer: (_root, requested) => ({ path: `/container/${requested}` }), guardRead: () => ({}),
        listArgumentError: () => null, listDirectory: () => ({ entries: [] }),
        stageScreenshot: () => ({ path: "/owned-stage/screenshot.png", dispose: () => undefined }),
        readScreenshot: () => ({ ok: false, message: "screenshot missing" }), publishErased: () => device,
    };
}

describe("iOS observation and access", () => {
    it("starts a session for the admitted owned target on the selected port", async () => {
        const device = { id: "owned", udid: "OWNED-UDID", appiumPort: 4823 };
        const ports = simulatorPorts(device);
        const allocatedPorts: number[] = [];
        const spawn = ports.spawnServer;
        ports.spawnServer = port => { allocatedPorts.push(port); return spawn(port); };
        ports.verifyTarget = owned => ({ target: owned.udid! });
        const effects: IosAccessAppiumEffect[] = [];
        const effect = ports.appiumEffect;
        ports.appiumEffect = request => { effects.push(request); return effect(request); };
        expect(await createIosObservationAccess(ports).ensureSession("owned")).toMatchObject({
            serverUrl: "http://127.0.0.1:4823", sessionId: "new-session",
        });
        expect(allocatedPorts).toEqual([4823]);
        expect(effects).toContainEqual({ kind: "create-session", serverUrl: "http://127.0.0.1:4823",
            target: "OWNED-UDID", deviceName: "owned", physical: false });
    });

    it.each(["device_exec", "device_screenshot", "device_reset", "mobile_wait_for_app", "mobile_dump_ui"])(
        "refuses %s when the owned simulator target cannot be admitted", async name => {
            const ports = simulatorPorts({ id: "owned" });
            ports.verifyTarget = () => ({ error: "owned target disappeared" });
            ports.spawnServer = () => { throw new Error("rejected target must not allocate a server"); };
            ports.appiumEffect = async () => { throw new Error("rejected target must not contact Appium"); };
            ports.simulatorEffect = () => { throw new Error("rejected target must not execute simulator effects"); };
            ports.stageScreenshot = () => { throw new Error("rejected target must not allocate screenshot staging"); };
            expect(await createIosObservationAccess(ports).request(name, {
                deviceId: "owned", eraseSimulator: true, bundleId: "com.wanted", command: "pwd",
            })).toEqual({ ok: false, message: "owned target disappeared" });
        },
    );

    it("reports physical host presence from native discovery without starting automation", async () => {
        const device = { id: "phone", udid: "PHONE-UDID" };
        const discovery = { available: true, missing: [] };
        const hostDevice = { udid: "PHONE-UDID", name: "Connected phone" };
        const ports: IosPhysicalAccessPorts<IosAccessDevice, object> = {
            ...simulatorPorts(device), kind: "physical", discovery: () => discovery,
            refreshLease: () => { throw new Error("passive status must not acquire a lease"); },
            hostDevices: () => [hostDevice],
        };
        ports.spawnServer = () => { throw new Error("passive status must not start automation"); };
        ports.appiumEffect = async () => { throw new Error("passive status must not contact Appium"); };
        expect(await createIosObservationAccess(ports).request("device_status", { deviceId: "phone" }))
            .toMatchObject({ device, hostDevice, appium: { lazy: true, physical: true } });
    });

    it("rejects a positive simulator probe completed at the deadline and starts no fallback", async () => {
        const ports = simulatorPorts({ id: "owned" });
        let remaining = 10;
        ports.waitBudget = () => ({ timeoutMs: 10, remaining: () => remaining, requestTimeout: () => remaining, pause: async () => undefined });
        const probes = vi.fn(() => undefined);
        ports.simulatorEffect = effect => {
            probes(); remaining = 0;
            return { kind: "present", pid: "123", receipt: { status: 0, stdout: "123\n", stderr: "" } } as IosAccessSimulatorResult<typeof effect>;
        };
        const observed = await createIosObservationAccess(ports).waitForApp("OWNED-UDID", "com.wanted", 10);
        expect(observed).toMatchObject({ running: false, timeoutMs: 10 });
        expect(probes).toHaveBeenCalledTimes(1);
    });

    it.each([
        { activeApp: { bundleId: "com.other", bundleID: "com.wanted" }, bundleIds: ["com.other", "com.wanted"], found: true },
        { activeApp: {}, bundleIds: [], found: false },
        { activeApp: { bundleId: 42, bundleID: null }, bundleIds: [], found: false },
    ])("matches physical app identities and preserves the original observation: %j", async ({ activeApp, bundleIds, found }) => {
        const device = { id: "phone", appium: { serverUrl: "http://existing", sessionId: "existing-session" } };
        const ports: IosPhysicalAccessPorts<IosAccessDevice, object> = {
            ...simulatorPorts(device), kind: "physical", refreshLease: () => ({ ok: true }), hostDevices: () => [],
        };
        let remaining = 100;
        ports.waitBudget = () => ({ timeoutMs: 100, remaining: () => remaining, requestTimeout: () => remaining, pause: async () => { remaining = 0; } });
        ports.appiumEffect = async effect => (effect.kind === "active-app" ? { bundleIds, activeApp } : undefined) as IosAccessAppiumResult<typeof effect>;
        const observed = await createIosObservationAccess(ports).request("mobile_wait_for_app", { deviceId: "phone", bundleId: "com.wanted" });
        expect(observed).toEqual({ found, bundleId: "com.wanted", activeApp, provider: "appium-xcuitest", physical: true,
            ...(found ? {} : { timeoutMs: 100 }) });
    });

    it("reuses a healthy session without startup or publication", async () => {
        const device = { id: "owned", appium: { serverUrl: "http://existing", sessionId: "existing-session" } };
        const ports = simulatorPorts(device);
        ports.spawnServer = () => { throw new Error("healthy session must not spawn"); };
        ports.publishAppium = () => { throw new Error("healthy session must not publish"); };
        expect(await createIosObservationAccess(ports).ensureSession("owned")).toEqual({
            device, serverUrl: "http://existing", sessionId: "existing-session",
        });
    });

    it.each(["missing-id", "rejected", "server-unready"])("cleans owned startup after %s without publishing a session", async failure => {
        const ports = simulatorPorts({ id: "owned" });
        const publish = vi.fn(ports.publishAppium), terminate = vi.fn(ports.terminateRuntime);
        ports.publishAppium = publish; ports.terminateRuntime = terminate;
        ports.appiumEffect = async effect => {
            if (failure === "server-unready" && effect.kind === "server-status") throw new Error("unready");
            if (effect.kind === "create-session") {
                if (failure === "rejected") throw new Error("session rejected");
                return { sessionId: null } as IosAccessAppiumResult<typeof effect>;
            }
            return undefined as IosAccessAppiumResult<typeof effect>;
        };
        expect(await createIosObservationAccess(ports).ensureSession("owned")).toEqual({ error:
            failure === "missing-id" ? "Appium did not return a session id" : failure === "rejected"
                ? "Appium session creation failed: session rejected" : "Appium server did not become ready on http://127.0.0.1:4723",
        });
        expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "new-runtime", pid: 42 }), "iOS Simulator Appium startup");
        expect(publish.mock.calls.every(call => call[2] === null)).toBe(true);
    });

    it.each(["success", "native-failure", "throw"])("disposes screenshot staging after %s", async outcome => {
        const ports = simulatorPorts({ id: "owned" });
        const dispose = vi.fn<() => undefined>(() => undefined);
        ports.stageScreenshot = () => ({ path: "/owned-stage/screenshot.png", dispose });
        ports.readScreenshot = () => ({ data: "png" });
        ports.simulatorEffect = effect => {
            if (outcome === "throw") throw new Error("capture threw");
            return { ok: outcome === "success", status: outcome === "success" ? 0 : 7, stdout: "", stderr: "" } as IosAccessSimulatorResult<typeof effect>;
        };
        const pending = createIosObservationAccess(ports).request("device_screenshot", { deviceId: "owned" });
        if (outcome === "throw") await expect(pending).rejects.toThrow("capture threw");
        else expect(await pending).toEqual(outcome === "success" ? { data: "png" }
            : { ok: false, command: { ok: false, status: 7, stdout: "", stderr: "" } });
        expect(dispose).toHaveBeenCalledTimes(1);
    });

    it.each([0, 10])("does not accept source matches after a %s ms observation budget", async allowance => {
        const ports = simulatorPorts({ id: "owned", appium: { serverUrl: "http://existing", sessionId: "existing-session" } });
        let remaining = allowance;
        ports.waitBudget = () => ({ timeoutMs: allowance, remaining: () => remaining, requestTimeout: () => remaining, pause: async () => { remaining = 0; } });
        const sources: string[] = [];
        ports.appiumEffect = async effect => {
            if (effect.kind === "source") { sources.push(effect.kind); remaining = 0; return { source: "needle" } as IosAccessAppiumResult<typeof effect>; }
            return undefined as IosAccessAppiumResult<typeof effect>;
        };
        expect(await createIosObservationAccess(ports).request("mobile_wait_for_text", { deviceId: "owned", text: "needle" })).toMatchObject({ ok: false });
        expect(sources).toHaveLength(allowance === 0 ? 0 : 1);
    });

    it("refuses stale process cleanup when owned identity has changed", async () => {
        const ports = simulatorPorts({ id: "owned" });
        ports.inspectRuntime = () => ({ status: "mismatch" });
        const effect = vi.fn((_effect: IosAccessAppiumEffect) => undefined), terminate = vi.fn(ports.terminateRuntime);
        const originalEffect = ports.appiumEffect;
        ports.appiumEffect = request => { effect(request); return originalEffect(request); }; ports.terminateRuntime = terminate;
        expect(await createIosObservationAccess(ports).stopOwnedAppium({ runtimeId: "owned", processOwner: "device-lab-mcp", startedBy: "direct-provider", serverPid: 42, processIdentity: {}, serverUrl: "http://owned", sessionId: "session" }, "cleanup")).toMatchObject({ exited: false, reason: "runtime-process-identity-mismatch" });
        expect(effect).not.toHaveBeenCalled(); expect(terminate).not.toHaveBeenCalled();
    });
    it("does not allocate a server or session after stale reconciliation finds the record missing", async () => {
        const oldAppium = { runtimeId: "old-runtime", processOwner: "device-lab-mcp", startedBy: "direct-provider",
            serverPid: 41, processIdentity: { pid: 41 }, serverUrl: "http://old-server", sessionId: "old-session" };
        const ports = simulatorPorts({ id: "owned", udid: "OWNED-UDID", appium: oldAppium });
        ports.publishAppium = () => ({ committed: true, device: null });
        ports.spawnServer = () => { throw new Error("missing record must not spawn a new server"); };
        const request = vi.fn((_effect: IosAccessAppiumEffect) => undefined);
        ports.appiumEffect = async effect => {
            request(effect);
            if (effect.kind === "server-status") throw new Error("stale server");
            if (effect.kind === "delete-session") return undefined as IosAccessAppiumResult<typeof effect>;
            throw new Error("missing record must not create a session");
        };
        const terminate = vi.fn(ports.terminateRuntime);
        ports.terminateRuntime = terminate;
        expect(await createIosObservationAccess(ports).ensureSession("owned")).toEqual({ unknown: true });
        expect(request).toHaveBeenCalledWith({ kind: "delete-session", serverUrl: "http://old-server", sessionId: "old-session" });
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
        ports.simulatorEffect = effect => ({ ok: false, status: 7, stdout: "", stderr: "erase refused" }) as IosAccessSimulatorResult<typeof effect>;
        ports.publishErased = () => { throw new Error("failed erase must not publish"); };
        expect(await createIosObservationAccess(ports).request("device_reset", { deviceId: "owned", eraseSimulator: true })).toEqual({
            ok: false, command: { ok: false, status: 7, stdout: "", stderr: "erase refused" },
        });
        expect(device).toEqual({ id: "owned", status: "booted" });
    });

    it("cleans up the newly allocated session and server when publication loses to a successor", async () => {
        const successor = { id: "owned", appium: { runtimeId: "successor", sessionId: "successor-session" } };
        const ports = simulatorPorts({ id: "owned", udid: "OWNED-UDID" });
        ports.publishAppium = (_id, _expected, replacement) => replacement === null
            ? { committed: true, device: { id: "owned", udid: "OWNED-UDID", appium: null } }
            : { committed: false, device: successor };
        const request = vi.fn((_effect: IosAccessAppiumEffect) => undefined), terminate = vi.fn(ports.terminateRuntime);
        const originalEffect = ports.appiumEffect;
        ports.appiumEffect = effect => { request(effect); return originalEffect(effect); }; ports.terminateRuntime = terminate;
        expect(await createIosObservationAccess(ports).ensureSession("owned")).toEqual({
            error: "iOS Simulator Appium state changed before the new session was committed",
        });
        expect(request).toHaveBeenCalledWith({ kind: "delete-session", serverUrl: "http://127.0.0.1:4723", sessionId: "new-session" });
        expect(terminate).toHaveBeenCalledWith(expect.objectContaining({ runtimeId: "new-runtime", serverPid: 42 }),
            "iOS Simulator Appium superseded startup");
        expect(successor).toEqual({ id: "owned", appium: { runtimeId: "successor", sessionId: "successor-session" } });
    });
});
