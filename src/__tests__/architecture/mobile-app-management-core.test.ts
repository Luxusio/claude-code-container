import { describe, expect, it, vi } from "vitest";
import { createAndroidAppManagement } from "../../../packages/device-lab/providers/application/android-app-management.mjs";
import { createIosAppManagement } from "../../../packages/device-lab/providers/application/ios-app-management.mjs";
import type { AndroidAppEffect, AndroidAppManagementPorts, IosSimulatorAppManagementPorts, IosPhysicalAppManagementPorts, IosSimulatorAppEffect, IosPhysicalAppEffect, IosAppCommandObservation, IosAppTerminationObservation, IosAppSessionObservation, IosOwnedTarget, IosAppContainerObservation, IosAppReset, MobileCommandReceipt, MobileTargetObservation } from "../../../packages/device-lab/providers/ports/mobile-app-management.d.mts";

function android(variant: "emulator" | "physical" = "emulator") {
    const target = Symbol("native selected target");
    const ports = {
        variant,
        target: vi.fn((_id: unknown): MobileTargetObservation<typeof target> => ({ kind: "ready", target })),
        perform: vi.fn((_target: typeof target, _effect: AndroidAppEffect): { kind: "succeeded" | "failed"; command: MobileCommandReceipt } => ({ kind: "succeeded", command: { status: 0, stdout: "native output", stderr: "native warning" } })),
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
        discovery: vi.fn(() => ({ available: true, missing: [] as string[] })),
        ownedTarget: vi.fn((_device: typeof device): IosOwnedTarget => ({ ok: true, target: "OWNED-UDID" })),
        perform: vi.fn((_target: string, _effect: IosSimulatorAppEffect): IosAppCommandObservation => ({ kind: "succeeded", command: { status: 0, stdout: "native output", stderr: "" } })),
        resolveAppContainer: vi.fn((_target: string, _bundleId: string, _type: string): IosAppContainerObservation => ({ ok: true, containerRoot: "/owned/container" })),
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
        available: vi.fn(() => true),
        perform: vi.fn((_device: typeof device, _effect: IosPhysicalAppEffect): IosAppCommandObservation => ({ kind: "succeeded", command: { status: 0, stdout: "", stderr: "" } })),
        session: vi.fn(async (_id: unknown): Promise<IosAppSessionObservation<typeof session>> => ({ kind: "ready", session })),
        terminateApp: vi.fn(async (_session: typeof session, _bundleId: string): Promise<IosAppTerminationObservation> => ({ kind: "succeeded" })),
    } satisfies IosPhysicalAppManagementPorts<typeof device, typeof session>;
    return { device, session, ports, application: createIosAppManagement(ports) };
}

describe("mobile app management applications", () => {
    it("preserves unknown target fallthrough and native target refusal before execution", () => {
        const { ports, application } = android();
        ports.target.mockReturnValueOnce({ kind: "unknown" }).mockReturnValueOnce({ kind: "refused", message: "attachment lease lost" });
        ports.perform.mockImplementation(() => { throw new Error("Refused targets must not perform effects"); });
        expect(application.request("device_launch_app", { deviceId: "absent" })).toBeUndefined();
        expect(application.request("device_install_app", { deviceId: "foreign" })).toEqual({ kind: "refused", message: "attachment lease lost" });
        expect(application.request("device_launch_app", { deviceId: "owned" })).toEqual({ kind: "refused", message: "Android app launch requires packageName or component" });
        expect(application.request("unhandled_app_action", { deviceId: "owned" })).toBeUndefined();
        expect(ports.target).toHaveBeenCalledTimes(4);
        expect(ports.target).toHaveBeenLastCalledWith("owned");
        expect(ports.perform).not.toHaveBeenCalled();
    });

    it("preserves direct replace=false, default replacement, and the mobile alias replacement rule", () => {
        const { ports, application } = android();
        const command = { status: 0 };
        ports.perform.mockReturnValue({ kind: "succeeded", command });
        const effect = { kind: "install", path: "/app.apk", replace: false, helperTimeoutMs: 1700 };
        expect(application.request("device_install_app", { path: "/app.apk", replace: false, helperTimeoutMs: 1700 })).toEqual({ kind: "completed", effect, command });
        expect(ports.perform.mock.calls[0][1]).toEqual(effect);
        expect(application.request("device_install_app", { path: "/app.apk" })).toMatchObject({ kind: "completed", effect: { kind: "install", path: "/app.apk", replace: true } });
        expect(application.request("mobile_install_app", { path: "/app.apk", replace: false })).toMatchObject({ kind: "completed", effect: { kind: "install", path: "/app.apk", replace: true } });
    });

    it("selects a component before a package and preserves zero-exit launch failure diagnostics", () => {
        const { ports, target, application } = android();
        const failure = { status: 0, stdout: "Error: Activity class com.example/.Missing does not exist.", stderr: "native diagnostic" };
        ports.perform.mockImplementation((selected, effect) => {
            expect(selected).toBe(target);
            expect(effect).toEqual({ kind: "launch-component", component: "com.example/.Missing" });
            return { kind: "failed", command: failure };
        });
        expect(application.request("device_launch_app", { packageName: "unused.package", component: "com.example/.Missing" })).toEqual({ kind: "command-failure", command: failure });
    });

    it("returns failed ADB commands without claiming successful app mutation", () => {
        const { ports, application } = android("physical");
        const failure = { status: 7, stdout: "partial operation", stderr: "permission denied" };
        ports.perform.mockReturnValue({ kind: "failed", command: failure });
        expect(application.request("mobile_clear_app_data", { packageName: "com.example.App" })).toEqual({ kind: "command-failure", command: failure });
        expect(ports.perform).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["device_launch_app", { packageName: "app" }, { kind: "launch-package", packageName: "app" }],
        ["mobile_launch_app", { component: "app/.Main" }, { kind: "launch-component", component: "app/.Main" }],
        ["mobile_uninstall_app", { packageName: "app" }, { kind: "uninstall", packageName: "app" }],
        ["mobile_stop_app", { packageName: "app" }, { kind: "stop", packageName: "app" }],
        ["device_reset", { packageName: "app" }, { kind: "clear-data", packageName: "app" }],
        ["mobile_clear_app_data", { packageName: "app" }, { kind: "clear-data", packageName: "app" }],
        ["mobile_grant_permission", { packageName: "app", permission: "permission" }, { kind: "permission", packageName: "app", permission: "permission", action: "grant" }],
        ["mobile_revoke_permission", { packageName: "app", permission: "permission" }, { kind: "permission", packageName: "app", permission: "permission", action: "revoke" }],
        ["mobile_open_url", { url: "custom://app" }, { kind: "open-url", url: "custom://app" }],
        ["mobile_open_url", {}, { kind: "open-url", url: undefined }],
    ] as const)("passes semantic data for %s without an install budget", (name, args, effect) => {
        for (const variant of ["emulator", "physical"] as const) {
            const { target, ports, application } = android(variant);
            const command = { status: 0, stdout: "Error: Activity class app/.Main does not exist." };
            // The native observation owns diagnosis; core must not reinterpret receipt streams.
            ports.perform.mockReturnValue({ kind: "succeeded", command });
            expect(application.request(name, { ...args, helperTimeoutMs: 900 })).toEqual({ kind: "completed", effect, command });
            expect(ports.perform).toHaveBeenCalledExactlyOnceWith(target, effect);
        }
    });

    it.each([
        ["device_launch_app", "emulator", {}, "Android app launch requires packageName or component"],
        ["mobile_launch_app", "physical", {}, "Android app launch requires packageName or component"],
        ["mobile_uninstall_app", "emulator", {}, "Android app uninstall requires packageName"],
        ["mobile_stop_app", "emulator", {}, "Android app stop requires packageName"],
        ["mobile_stop_app", "physical", {}, "Android mobile_stop_app requires packageName"],
        ["device_reset", "physical", {}, "Android reset requires packageName to clear app data"],
        ["mobile_clear_app_data", "emulator", {}, "Android reset requires packageName to clear app data"],
        ["mobile_clear_app_data", "physical", {}, "Android mobile_clear_app_data requires packageName"],
        ["mobile_grant_permission", "emulator", { packageName: "app" }, "Android mobile_grant_permission requires packageName and permission"],
        ["mobile_grant_permission", "physical", { permission: "permission" }, "Android mobile_grant_permission requires packageName and permission"],
        ["mobile_revoke_permission", "emulator", { packageName: "app" }, "Android mobile_revoke_permission requires packageName and permission"],
        ["mobile_revoke_permission", "physical", { permission: "permission" }, "Android mobile_revoke_permission requires packageName and permission"],
    ] as const)("refuses missing requirements for %s on %s before any effect", (name, variant, args, message) => {
        const { ports, application } = android(variant);
        expect(application.request(name, args)).toEqual({ kind: "refused", message });
        expect(ports.target).toHaveBeenCalledTimes(1);
        expect(ports.perform).not.toHaveBeenCalled();
    });

    it.each([undefined, 0, false, "", "invalid", 1700])("passes install budget %s unchanged without adding path validation", (helperTimeoutMs) => {
        const { target, ports, application } = android();
        expect(application.request("device_install_app", { helperTimeoutMs })).toMatchObject({ kind: "completed", effect: { kind: "install", path: undefined, replace: true } });
        expect(ports.perform).toHaveBeenCalledExactlyOnceWith(target, { kind: "install", path: undefined, replace: true, helperTimeoutMs });
    });

    it.each([0, 7, null])("retains the original failed mutation receipt at status %s", (status) => {
        const { ports, application } = android();
        const command = { status, stdout: "partial operation", stderr: "native diagnosis", signal: "SIGTERM" };
        ports.perform.mockReturnValue({ kind: "failed", command });
        const outcome = application.request("mobile_uninstall_app", { packageName: "app" });
        expect(outcome).toEqual({ kind: "command-failure", command });
        expect(outcome && "command" in outcome && outcome.command).toBe(command);
        expect(ports.perform).toHaveBeenCalledTimes(1);
    });

    it("passes simulator install semantics and preserves its provider-free result", async () => {
        const { ports, application } = simulator();
        ports.perform.mockImplementation((target, effect) => {
            expect(target).toBe("OWNED-UDID");
            expect(effect).toEqual({ kind: "install", path: "/Test.app" });
            return { kind: "succeeded", command: { status: 0, stdout: "installed", stderr: "warning" } };
        });
        expect(await application.request("device_install_app", { deviceId: "owned", path: "/Test.app" })).toEqual({ kind: "json", payload: { installed: "/Test.app", stdout: "installed", stderr: "warning" } });
    });

    it("preserves unknown iOS targets and physical missing-argument refusal before discovery", async () => {
        const sim = simulator();
        sim.ports.device.mockReturnValueOnce(undefined);
        sim.ports.perform.mockImplementation(() => { throw new Error("Unknown simulator must not execute"); });
        expect(await sim.application.request("device_install_app", { deviceId: "absent", path: "/Test.app" })).toBeUndefined();
        const real = physical();
        real.ports.device.mockReturnValueOnce(undefined);
        real.ports.available.mockImplementation(() => { throw new Error("Missing app arguments must be refused before discovery"); });
        expect(await real.application.request("device_launch_app", { deviceId: "absent" })).toBeUndefined();
        expect(await real.application.request("device_install_app", { deviceId: "owned" })).toEqual({ kind: "text", message: "iOS real-device device_install_app requires path" });
        expect(await real.application.request("mobile_launch_app", { deviceId: "owned" })).toEqual({ kind: "text", message: "iOS real-device mobile_launch_app requires bundleId" });
    });

    it("requires simulator prerequisites and an owned target before any mutation", async () => {
        const f = simulator();
        f.ports.discovery.mockReturnValueOnce({ available: false, missing: ["simctl"] });
        expect(await f.application.request("mobile_launch_app", { bundleId: "app" })).toEqual({ kind: "text", message: "iOS Simulator backend missing prerequisites: simctl" });
        f.ports.ownedTarget.mockReturnValue({ ok: false, message: "simulator belongs to another owner" });
        expect(await f.application.request("mobile_launch_app", { bundleId: "app" })).toEqual({ kind: "text", message: "simulator belongs to another owner" });
        expect(f.ports.perform).not.toHaveBeenCalled();
        expect(f.cleared()).toBe(false);
    });

    it.each([
        ["mobile_launch_app", { bundleId: "app" }, { kind: "launch", bundleId: "app" }],
        ["mobile_stop_app", { bundleId: "app" }, { kind: "stop", bundleId: "app" }],
        ["mobile_uninstall_app", { bundleId: "app" }, { kind: "uninstall", bundleId: "app" }],
        ["mobile_grant_permission", { bundleId: "app", service: "camera" }, { kind: "permission", bundleId: "app", service: "camera", action: "grant" }],
        ["mobile_revoke_permission", { bundleId: "app", service: "camera" }, { kind: "permission", bundleId: "app", service: "camera", action: "revoke" }],
        ["mobile_open_url", { url: "custom://app" }, { kind: "open-url", url: "custom://app" }],
    ] as const)("preserves normalized simulator failure for %s", async (name, args, effect) => {
        const f = simulator();
        const command = { status: 0, stdout: "partial", stderr: "native failure" };
        f.ports.perform.mockReturnValue({ kind: "failed", command });
        expect(await f.application.request(name, args)).toEqual({ kind: "command-failure", command });
        expect(f.ports.perform).toHaveBeenCalledExactlyOnceWith("OWNED-UDID", effect);
    });

    it("requires physical prerequisites and preserves normalized command failures", async () => {
        const f = physical();
        f.ports.available.mockReturnValueOnce(false);
        expect(await f.application.request("device_install_app", { path: "/Test.app" })).toEqual({ kind: "text", message: "iOS real-device backend missing prerequisites: xcrun" });
        expect(f.ports.perform).not.toHaveBeenCalled();
        const command = { status: 0, stderr: "native launch failed" };
        f.ports.perform.mockReturnValue({ kind: "failed", command });
        expect(await f.application.request("mobile_launch_app", { bundleId: "app" })).toEqual({ kind: "command-failure", command });
        expect(f.ports.perform).toHaveBeenCalledExactlyOnceWith(f.device, { kind: "launch", bundleId: "app" });
    });

    it("retains failed container lookup without clearing or publishing", async () => {
        const f = simulator();
        const command = { status: 1, stderr: "container unavailable" };
        f.ports.resolveAppContainer.mockReturnValue({ ok: false, command });
        expect(await f.application.request("device_reset", { bundleId: "app", containerType: "groups" })).toEqual({ kind: "command-failure", command });
        expect(f.ports.resolveAppContainer).toHaveBeenCalledExactlyOnceWith("OWNED-UDID", "app", "groups");
        expect(f.cleared()).toBe(false);
        expect(f.published()).toBeUndefined();
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
        ports.perform.mockImplementation(() => { throw new Error("Unsupported physical control must not execute"); });
        ports.terminateApp.mockImplementation(async () => { throw new Error("Unsupported physical control must not contact Appium"); });
        expect(await application.request("mobile_uninstall_app", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "text", message: "iOS real devices do not support mobile_uninstall_app through CCC because the action is unavailable or unsafe for physical devices." });
        expect(await application.request("mobile_clear_app_data", { deviceId: "owned", bundleId: "com.example.App" })).toBeUndefined();
    });

    it("requires a verified physical session and translates native terminate request failures", async () => {
        const { ports, session, application } = physical();
        ports.session.mockResolvedValueOnce({ kind: "refused", message: "session belongs to a successor" });
        ports.terminateApp.mockImplementation(async (selected, bundleId) => {
            expect(selected).toBe(session);
            expect(bundleId).toBe("com.example.App");
            return { kind: "failed", message: "session connection closed" };
        });
        expect(await application.request("mobile_stop_app", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "text", message: "session belongs to a successor" });
        expect(ports.terminateApp).not.toHaveBeenCalled();
        expect(await application.request("mobile_stop_app", { deviceId: "owned", bundleId: "com.example.App" })).toEqual({ kind: "text", message: "iOS real-device Appium request failed: session connection closed" });
    });

    it("falls through an unknown physical session and completes verified termination", async () => {
        const f = physical();
        f.ports.session.mockResolvedValueOnce({ kind: "unknown" });
        expect(await f.application.request("mobile_stop_app", { deviceId: "owned", bundleId: "app" })).toBeUndefined();
        expect(f.ports.terminateApp).not.toHaveBeenCalled();
        expect(await f.application.request("mobile_stop_app", { deviceId: "owned", bundleId: "app" })).toEqual({ kind: "json", payload: { stopped: "app", provider: "appium-xcuitest", physical: true } });
        expect(f.ports.terminateApp).toHaveBeenCalledExactlyOnceWith(f.session, "app");
    });
});
