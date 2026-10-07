import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as commands from "@ccc/device-lab/providers/commands.mjs";
import { waitForAndroidText } from "@ccc/device-lab/providers/backends/android-wait.mjs";

const fixture = vi.hoisted(() => ({ root: "", callTool: vi.fn() }));
vi.mock("../../scripts/real-tests/device-lab-mcp-client.ts", async importOriginal => ({
    ...await importOriginal<typeof import("../../scripts/real-tests/device-lab-mcp-client.ts")>(),
    withDeviceLabMcp: async (callback: (client: { callTool: typeof fixture.callTool }) => unknown) =>
        callback({ callTool: fixture.callTool }),
}));
vi.mock("../../scripts/real-tests/helpers.ts", async importOriginal => ({
    ...await importOriginal<typeof import("../../scripts/real-tests/helpers.ts")>(),
    realProviderTempRoot: () => fixture.root,
}));

const { runAndroidEmulatorE2E } = await import("../../scripts/real-tests/android-emulator-e2e.ts");
const payload = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const run = () => runAndroidEmulatorE2E({ brokerOnly: true, systemImage: "system-images;android-35;google_apis;x86_64" });

describe("Android real E2E fixture cleanup", () => {
    let createdId: string;
    beforeEach(() => {
        fixture.root = mkdtempSync(join(tmpdir(), "ccc-e2e-cleanup-test-"));
        fixture.callTool.mockReset();
        createdId = "";
        for (const prefix of ["CCC_REAL_ANDROID_", "CCC_REAL_DEVICE_LAB_ANDROID_"]) {
            for (const suffix of ["APK", "PACKAGE", "PERMISSION"]) vi.stubEnv(`${prefix}${suffix}`, "");
        }
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            if (tool === "create_android_emulator") {
                expect(args).toEqual({ detail: true, name: expect.any(String),
                    deviceId: expect.stringMatching(/^android-real-e2e-\d+$/),
                    systemImage: "system-images;android-35;google_apis;x86_64" });
                createdId = String(args.deviceId);
                return payload({ device: { deviceId: createdId, port: 5554, provisioned: true } });
            }
            if (tool === "devices") {
                expect(args).toEqual({ view: "available", detail: true, backend: "android-emulator" });
                throw new Error("primary-inventory-failure");
            }
            if (tool === "stop") return payload({ device: { deviceId: createdId, status: "stopped" } });
            if (tool === "delete") return payload({ deleted: createdId, avdDeleted: true });
            throw new Error(`unexpected tool ${tool}`);
        });
    });
    afterEach(() => {
        rmSync(fixture.root, { recursive: true, force: true });
        vi.unstubAllEnvs();
    });

    const cleanupCalls = () => fixture.callTool.mock.calls.filter(([tool]) => tool === "stop" || tool === "delete");
    const assertOwnedCleanup = () => {
        expect(cleanupCalls()).toEqual([
            ["stop", expect.objectContaining({ detail: true, deviceId: createdId })],
            ["delete", expect.objectContaining({ detail: true, deviceId: createdId,
                force: true, deleteAvd: true, confirmDestructive: true })],
        ]);
        expect(readdirSync(fixture.root)).toEqual([]);
    };

    it("cleans normalized creation without ok after a later failure and preserves that failure", async () => {
        await expect(run()).rejects.toThrow("devices: primary-inventory-failure");
        assertOwnedCleanup();
    });

    it("establishes ownership before validating secondary created-device fields", async () => {
        fixture.callTool.mockImplementationOnce(async (_tool: string, args: Record<string, unknown>) => {
            createdId = String(args.deviceId);
            return payload({ device: { deviceId: createdId, port: "invalid", provisioned: false } });
        });
        await expect(run()).rejects.toThrow("create_android_emulator");
        assertOwnedCleanup();
        expect(fixture.callTool.mock.calls.some(([tool]) => tool === "devices")).toBe(false);
    });

    it.each(["mcp-error", "structured-error", "wrong-identity"])("never cleans an unowned fixture after %s creation", async kind => {
        fixture.callTool.mockImplementationOnce(async (_tool: string, args: Record<string, unknown>) => {
            const device = { deviceId: kind === "wrong-identity" ? "unrelated-device" : args.deviceId, port: 5554, provisioned: true };
            return kind === "mcp-error" ? { ...payload({ device, error: "create-failed" }), isError: true }
                : payload({ ...(kind === "structured-error" ? { ok: false, error: "create-failed" } : {}), device });
        });
        await expect(run()).rejects.toThrow("create_android_emulator");
        expect(fixture.callTool.mock.calls).toHaveLength(1);
        expect(cleanupCalls()).toEqual([]);
        expect(readdirSync(fixture.root)).toEqual([]);
    });

    it.each(["mcp-error", "structured-error", "throw"])("reports %s stop/delete failures alongside the primary failure and attempts both", async kind => {
        const normal = fixture.callTool.getMockImplementation()!;
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            if (tool !== "stop" && tool !== "delete") return normal(tool, args);
            const error = `${tool}-cleanup-failed`;
            if (kind === "throw") throw new Error(error);
            return { ...payload({ ok: false, error }), ...(kind === "mcp-error" ? { isError: true } : {}) };
        });
        const failure = await run().then(() => "unexpected success", error => String(error));
        expect(failure).toContain("primary-inventory-failure");
        expect(failure).toContain("stop-cleanup-failed");
        expect(failure).toContain("delete-cleanup-failed");
        assertOwnedCleanup();
    });

    it("does not accept successful-looking cleanup replies for a different fixture", async () => {
        const normal = fixture.callTool.getMockImplementation()!;
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            if (tool === "stop") return payload({ device: { deviceId: "unrelated-device", status: "stopped" } });
            if (tool === "delete") return payload({ deleted: "unrelated-device", avdDeleted: true });
            return normal(tool, args);
        });
        const failure = await run().then(() => "unexpected success", error => String(error));
        expect(failure).toContain("primary-inventory-failure");
        expect(failure).toContain("cleanup failed");
        expect(failure).toContain("device stop");
        expect(failure).toContain("device/AVD delete");
        assertOwnedCleanup();
    });

    it.each(["wrong-identity", "stopped", "missing-device"])("rejects %s status before device operations", async kind => {
        const normal = fixture.callTool.getMockImplementation()!;
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, unknown>) => {
            if (tool === "devices") {
                expect(args).toEqual({ view: "available", detail: true, backend: "android-emulator" });
                return payload({ devices: [{ deviceId: createdId }] });
            }
            if (tool === "start") return payload({ device: { deviceId: createdId, status: "running" }, boot: { ready: true } });
            if (tool === "status") return payload(kind === "missing-device" ? {} : {
                device: { deviceId: kind === "wrong-identity" ? "unrelated-device" : createdId,
                    status: kind === "stopped" ? "stopped" : "running" },
            });
            return normal(tool, args);
        });
        await expect(run()).rejects.toThrow("status:");
        expect(fixture.callTool.mock.calls.filter(([tool]) => tool === "status")).toHaveLength(1);
        expect(fixture.callTool.mock.calls.some(([tool]) => tool === "exec")).toBe(false);
        assertOwnedCleanup();
    });

    it.each(["mcp-error", "structured-error"])("continues fixture cleanup after %s recording-stop failure", async kind => {
        const normal = fixture.callTool.getMockImplementation()!;
        let uploaded = Buffer.alloc(0);
        let uploadedRemotePath = "";
        fixture.callTool.mockImplementation(async (tool: string, args: Record<string, any>) => {
            if (["create_android_emulator", "stop", "delete"].includes(tool)) return normal(tool, args);
            if (tool === "devices") {
                expect(args).toEqual({ view: "available", detail: true, backend: "android-emulator" });
                return payload({ devices: [{ deviceId: createdId }] });
            }
            if (tool === "start") return payload({ device: { deviceId: createdId, status: "running" }, boot: { ready: true } });
            if (tool === "status") return payload({ device: { deviceId: createdId, status: "running" } });
            if (tool === "exec") return payload({ stdout: "ccc-adb-e2e-ok" });
            if (tool === "upload") {
                uploaded = readFileSync(args.localPath);
                uploadedRemotePath = args.remotePath;
                return payload({ provider: "adb", uploaded: { localPath: args.localPath, remotePath: args.remotePath } });
            }
            if (tool === "download") {
                writeFileSync(args.localPath, uploaded);
                return payload({ provider: "adb", downloaded: { localPath: args.localPath, remotePath: args.remotePath } });
            }
            if (tool === "list_files") return payload({ entries: [{ name: uploadedRemotePath.split("/").at(-1), type: "file" }] });
            if (tool === "ui") return payload({ provider: "adb-uiautomator", source: '<node text="Fixture"/>' });
            if (tool === "wait_for_text") {
                // Exercise the real shrinking-budget observer with a slow valid dump.
                // A five-second E2E budget would time out before the XML can be read.
                let elapsed = 0;
                const clock = vi.spyOn(performance, "now").mockImplementation(() => elapsed);
                const adb = vi.spyOn(commands, "runWithTimeout").mockImplementation((_executable, argv, timeoutMs) => {
                    const dump = argv.includes("uiautomator");
                    const duration = dump ? 7000 : 100;
                    elapsed += Math.min(duration, timeoutMs);
                    return timeoutMs < duration
                        ? { status: null, stdout: "", stderr: "", error: Object.assign(new Error("ADB ETIMEDOUT"), { code: "ETIMEDOUT" }) }
                        : { status: 0, stdout: dump ? "UI hierarchy dumped" : '<node text="Fixture"/>', stderr: "" };
                });
                try {
                    const observed = await waitForAndroidText("fixture-adb", ["-s", "fixture-emulator"], "/sdcard/fixture.xml", args.text, args.timeoutMs, args.intervalMs);
                    expect(observed).toMatchObject({ found: true });
                    expect(adb).toHaveBeenCalledTimes(2);
                    expect(elapsed).toBe(7100);
                    return payload({ ...observed, provider: "adb-uiautomator", text: args.text });
                } finally {
                    adb.mockRestore();
                    clock.mockRestore();
                }
            }
            if (tool === "record_video" && args.action === "start") return payload({ recording: { provider: "adb-screenrecord", active: true } });
            if (tool === "record_video" && args.action === "status") throw new Error("primary-recording-status-failure");
            if (tool === "record_video" && args.action === "stop") return {
                ...payload({ ok: false, error: "recording-stop-failed" }),
                ...(kind === "mcp-error" ? { isError: true } : {}),
            };

            if (tool === "click") {
                expect(args).toEqual(args.count === 2
                    ? { count: 2, detail: true, deviceId: createdId, x: 30, y: 30 }
                    : { detail: true, deviceId: createdId, x: 20, y: 20 });
            }
            const successes: Record<string, unknown> = {
                home: { status: 0 },
                click: args.count === 2 ? { doubleTapped: { x: args.x, y: args.y } } : { status: 0 },
                long_press: { longPressed: { x: args.x, y: args.y, durationMs: args.durationMs } },
                swipe: { swiped: { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, durationMs: args.durationMs } },
                drag: { dragged: { x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2, durationMs: args.durationMs } },
                type: { typed: true }, key: { status: 0 },
                back: { back: true }, forward: { forward: true }, recents: { recents: true },
                lock: { locked: true }, unlock: { unlocked: true },
                set_orientation: { orientation: args.orientation }, open_url: { openedUrl: args.url },
                set_location: { provider: "adb-emulator", location: { latitude: args.latitude, longitude: args.longitude, altitude: args.altitude } },
                set_battery: { battery: { level: args.level, status: args.status, charging: args.charging } },
                install_app: { installed: args.path },
                launch_app: { launched: args.appId },
                wait_for_app: { appId: args.appId, running: true, pid: "1234" },
                permission: { permission: { appId: args.appId, permission: args.permission, action: args.action } },
                stop_app: { stopped: args.appId },
                clear_app_data: { reset: { appId: args.appId } }, uninstall_app: { uninstalled: args.appId },
            };
            if (!(tool in successes)) throw new Error(`unexpected tool before recording: ${tool}`);
            return payload({ provider: "adb", ...(successes[tool] as object) });
        });
        const failure = await run().then(() => "unexpected success", error => String(error));
        // The current public status contract carries device identity/state, not routing authority.
        // It is inspected once; no redundant legacy session-status request is needed.
        expect(fixture.callTool.mock.calls.filter(([tool]) => tool === "status")).toHaveLength(1);
        expect(fixture.callTool).toHaveBeenCalledWith("ui", { detail: true, deviceId: createdId });
        expect(failure).toContain("record_video: primary-recording-status-failure");
        expect(failure).toContain("recording stop");
        expect(failure).toContain("recording-stop-failed");
        expect(fixture.callTool.mock.calls.slice(-4).map(([tool, args]) => [tool, args.action])).toEqual([
            ["record_video", "status"], ["record_video", "stop"], ["stop", undefined], ["delete", undefined],
        ]);
        expect(fixture.callTool).toHaveBeenCalledWith("record_video", { action: "stop",
            detail: true, deviceId: createdId,
        });
        assertOwnedCleanup();
    });
});
