import { describe, expect, it, vi } from "vitest";
import { createAndroidAppManagement } from "../../../packages/device-lab/providers/application/android-app-management.mjs";
import { createIosAppManagement } from "../../../packages/device-lab/providers/application/ios-app-management.mjs";
import type { AndroidAppManagementPorts, IosSimulatorAppManagementPorts, IosPhysicalAppManagementPorts, IosAppReset, MobileCommandReceipt, MobileTargetObservation } from "../../../packages/device-lab/providers/ports/mobile-app-management.d.mts";

function android(variant: "emulator" | "physical" = "emulator") {
    const target = { device: { id: "owned", serial: "selected-serial" }, adb: "/sdk/adb" };
    const ports = {
        variant,
        target: vi.fn((_id: unknown): MobileTargetObservation<typeof target> => ({ kind: "ready", target })),
        execute: vi.fn((_target: typeof target, _args: (string | undefined)[], _timeout: unknown): MobileCommandReceipt => ({ status: 0, stdout: "native output", stderr: "native warning" })),
    } satisfies AndroidAppManagementPorts<typeof target>;
    return { target, ports, application: createAndroidAppManagement(ports) };
}

function simulator() {
    const device = { id: "owned", simulatorName: "ccc-owner-phone", udid: "OWNED-UDID" };
    let cleared = false;
    let published: IosAppReset | undefined;
    const ports = {
        variant: "simulator",
        device: vi.fn((_id: unknown): typeof device | undefined => device),
        discovery: () => ({ available: true as const, xcrun: "/sdk/xcrun", missing: [] }),
        ownedTarget: () => ({ ok: true as const, target: "OWNED-UDID" }),
        execute: vi.fn((_xcrun: string, _args: (string | undefined)[], _timeout: number | undefined): MobileCommandReceipt => ({ status: 0, stdout: "native output", stderr: "" })),
        resolveAppContainer: () => ({ ok: true as const, containerRoot: "/owned/container" }),
        containAppContainer: vi.fn((_root: string): { ok: true } | { ok: false; message: string } => ({ ok: true })),
        clearAppContainer: (_root: string): undefined => { cleared = true; },
        publishAppReset: vi.fn((_id: unknown, reset: IosAppReset, _updatedAt: string) => {
            expect(cleared).toBe(true);
            published = reset;
            return device;
        }),
        clock: () => "2026-10-11T12:00:00.000Z",
    } satisfies IosSimulatorAppManagementPorts<typeof device>;
    return { device, ports, application: createIosAppManagement(ports), cleared: () => cleared, published: () => published };
}

function physical() {
    const device = { id: "owned", udid: "OWNED-PHYSICAL-UDID" };
    const session = { serverUrl: "http://127.0.0.1:4723", sessionId: "verified-owned-session" };
    const ports = {
        variant: "physical",
        device: vi.fn((_id: unknown): typeof device | undefined => device),
        xcrun: () => "/sdk/xcrun",
        execute: vi.fn((_xcrun: string, _args: (string | undefined)[], _timeout: number | undefined): MobileCommandReceipt => ({ status: 0, stdout: "", stderr: "" })),
        session: vi.fn(async (_id: unknown): Promise<{ kind: "ready"; session: typeof session } | { kind: "refused"; message: string }> => ({ kind: "ready", session })),
        request: vi.fn(async (_session: typeof session, _path: "/execute/sync", _body: { script: "mobile: terminateApp"; args: [{ bundleId: string }] }): Promise<unknown> => ({ value: true })),
    } satisfies IosPhysicalAppManagementPorts<typeof device, typeof session>;
    return { device, session, ports, application: createIosAppManagement(ports) };
}

describe("mobile app management applications", () => {
    it("preserves unknown target fallthrough and native target refusal before execution", () => {
        const { ports, application } = android();
        ports.target.mockReturnValueOnce({ kind: "unknown" }).mockReturnValueOnce({ kind: "refused", message: "attachment lease lost" });
        ports.execute.mockImplementation(() => { throw new Error("Refused targets must not execute ADB"); });
        expect(application.request("device_launch_app", { deviceId: "absent" })).toBeUndefined();
        expect(application.request("device_install_app", { deviceId: "foreign", path: "/app.apk" })).toEqual({ kind: "text", message: "attachment lease lost" });
        expect(application.request("device_launch_app", { deviceId: "owned" })).toEqual({ kind: "text", message: "Android app launch requires packageName or component" });
    });

    it("preserves direct replace=false, default replacement, and the mobile alias replacement rule", () => {
        const { ports, application } = android();
        ports.execute.mockImplementation((_target, args, timeout) => {
            expect(timeout).toBe(1700);
            expect(args).toEqual(["install", "/app.apk"]);
            return { status: 0 };
        });
        expect(application.request("device_install_app", { path: "/app.apk", replace: false, helperTimeoutMs: 1700 })).toMatchObject({ kind: "json", payload: { installed: "/app.apk" } });
        ports.execute.mockImplementation((_target, args) => { expect(args).toEqual(["install", "-r", "/app.apk"]); return { status: 0 }; });
        application.request("device_install_app", { path: "/app.apk" });
        application.request("mobile_install_app", { path: "/app.apk", replace: false });
    });

    it("selects a component before a package and preserves zero-exit launch failure diagnostics", () => {
        const { ports, target, application } = android();
        const failure = { status: 0, stdout: "Error: Activity class com.example/.Missing does not exist.", stderr: "native diagnostic" };
        ports.execute.mockImplementation((selected, args) => {
            expect(selected).toBe(target);
            expect(args).toEqual(["shell", "am", "start", "-n", "com.example/.Missing"]);
            return failure;
        });
        expect(application.request("device_launch_app", { packageName: "unused.package", component: "com.example/.Missing" })).toEqual({ kind: "command-failure", command: failure });
    });

    it("returns failed ADB commands without claiming successful app mutation", () => {
        const { ports, application } = android("physical");
        const failure = { status: 7, stdout: "partial operation", stderr: "permission denied" };
        ports.execute.mockReturnValue(failure);
        expect(application.request("mobile_clear_app_data", { packageName: "com.example.App" })).toEqual({ kind: "command-failure", command: failure });
    });

    it("bounds simulator install and preserves its provider-free result", async () => {
        const { ports, application } = simulator();
        ports.execute.mockImplementation((xcrun, args, timeout) => {
            expect(xcrun).toBe("/sdk/xcrun");
            expect(args).toEqual(["simctl", "install", "OWNED-UDID", "/Test.app"]);
            expect(timeout).toBe(300_000);
            return { status: 0, stdout: "installed", stderr: "warning" };
        });
        expect(await application.request("device_install_app", { deviceId: "owned", path: "/Test.app" })).toEqual({ kind: "json", payload: { installed: "/Test.app", stdout: "installed", stderr: "warning" } });
    });

    it("preserves unknown iOS targets and physical missing-argument refusal before discovery", async () => {
        const sim = simulator();
        sim.ports.device.mockReturnValueOnce(undefined);
        sim.ports.execute.mockImplementation(() => { throw new Error("Unknown simulator must not execute"); });
        expect(await sim.application.request("device_install_app", { deviceId: "absent", path: "/Test.app" })).toBeUndefined();
        const real = physical();
        real.ports.device.mockReturnValueOnce(undefined);
        real.ports.xcrun = () => { throw new Error("Missing app arguments must be refused before discovery"); };
        expect(await real.application.request("device_launch_app", { deviceId: "absent" })).toBeUndefined();
        expect(await real.application.request("device_install_app", { deviceId: "owned" })).toEqual({ kind: "text", message: "iOS real-device device_install_app requires path" });
        expect(await real.application.request("mobile_launch_app", { deviceId: "owned" })).toEqual({ kind: "text", message: "iOS real-device mobile_launch_app requires bundleId" });
    });

    it("refuses a container outside native containment without clearing or publishing", async () => {
        const f = simulator();
        f.ports.containAppContainer.mockReturnValue({ ok: false, message: "container escapes owned root" });
        expect(await f.application.request("mobile_clear_app_data", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "text", message: "container escapes owned root" });
        expect(f.cleared()).toBe(false);
        expect(f.published()).toBeUndefined();
    });

    it("publishes the cleared container with the current default data type", async () => {
        const f = simulator();
        expect(await f.application.request("mobile_clear_app_data", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "json", payload: {
            reset: { bundleId: "com.example.App", containerType: "data" }, containerRoot: "/owned/container", device: f.device, provider: "simctl-app-container",
        } });
        expect(f.published()).toEqual({ bundleId: "com.example.App", containerType: "data", containerRoot: "/owned/container", resetAt: "2026-10-11T12:00:00.000Z" });
    });

    it("retains completed clearing when subsequent owner publication throws", async () => {
        const f = simulator();
        const failure = new Error("owner state publication failed");
        f.ports.publishAppReset.mockImplementation(() => { expect(f.cleared()).toBe(true); throw failure; });
        await expect(f.application.request("mobile_clear_app_data", { deviceId: "owned", bundleId: "com.example.App" })).rejects.toBe(failure);
        expect(f.cleared()).toBe(true);
        expect(f.published()).toBeUndefined();
    });

    it("preserves physical unsupported controls and clear-data fallthrough without native effects", async () => {
        const { ports, application } = physical();
        ports.execute.mockImplementation(() => { throw new Error("Unsupported physical control must not execute"); });
        ports.request.mockImplementation(async () => { throw new Error("Unsupported physical control must not contact Appium"); });
        expect(await application.request("mobile_uninstall_app", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "text", message: "iOS real devices do not support mobile_uninstall_app through CCC because the action is unavailable or unsafe for physical devices." });
        expect(await application.request("mobile_clear_app_data", { deviceId: "owned", bundleId: "com.example.App" })).toBeUndefined();
    });

    it("requires a verified physical session and translates native terminate request failures", async () => {
        const { ports, session, application } = physical();
        ports.session.mockResolvedValueOnce({ kind: "refused", message: "session belongs to a successor" });
        ports.request.mockImplementation(async (selected, path, body) => {
            expect(selected).toBe(session);
            expect(path).toBe("/execute/sync");
            expect(body).toEqual({ script: "mobile: terminateApp", args: [{ bundleId: "com.example.App" }] });
            throw new Error("session connection closed");
        });
        expect(await application.request("mobile_stop_app", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "text", message: "session belongs to a successor" });
        expect(await application.request("mobile_stop_app", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "text", message: "iOS real-device Appium request failed: session connection closed" });
    });
});
