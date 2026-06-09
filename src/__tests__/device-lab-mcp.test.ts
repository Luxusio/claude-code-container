import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { handleMacosTool } from "../../device-lab-mcp/src/backends/macos-vm.mjs";

const repoRoot = join(__dirname, "../..");
const TIMEOUT = 30000;

describe("device-lab MCP", () => {
    let client: Client;
    let homeDir: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-test-"));
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: "/tmp/ccc-device-lab-empty-path",
                NODE_ENV: "test",
            },
        });

        client = new Client(
            { name: "ccc-device-lab-test-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("lists foundation device-lab and current display tools", { timeout: TIMEOUT }, async () => {
        const result = await client.listTools();
        const names = result.tools.map((tool) => tool.name);

        expect(names).toContain("device_backends");
        expect(names).toContain("device_list");
        expect(names).toContain("device_inventory");
        expect(names).toContain("display_current");
        expect(names).toContain("display_screenshot");
        expect(names).toContain("display_click");
        expect(names).toContain("device_create");
        expect(names).toContain("device_delete");
        expect(names).toContain("device_start");
        expect(names).toContain("device_stop");
        expect(names).toContain("device_status");
        expect(names).toContain("device_exec");
        expect(names).toContain("device_screenshot");
        expect(names).toContain("device_upload");
        expect(names).toContain("device_download");
        expect(names).toContain("device_reset");
        expect(names).toContain("device_install_app");
        expect(names).toContain("device_launch_app");
        expect(names).toContain("mobile_session_status");
        expect(names).toContain("mobile_dump_ui");
        expect(names).toContain("mobile_tap");
        expect(names).toContain("mobile_double_tap");
        expect(names).toContain("mobile_long_press");
        expect(names).toContain("mobile_swipe");
        expect(names).toContain("mobile_type_text");
        expect(names).toContain("mobile_key");
        expect(names).toContain("mobile_home");
        expect(names).toContain("mobile_back");
        expect(names).toContain("mobile_forward");
        expect(names).toContain("mobile_recents");
        expect(names).toContain("mobile_power");
        expect(names).toContain("mobile_lock");
        expect(names).toContain("mobile_unlock");
        expect(names).toContain("mobile_open_url");
        expect(names).toContain("mobile_install_app");
        expect(names).toContain("mobile_launch_app");
        expect(names).toContain("mobile_uninstall_app");
        expect(names).toContain("mobile_stop_app");
        expect(names).toContain("mobile_clear_app_data");
        expect(names).toContain("mobile_screenshot");
    });

    it("reports backends without starting heavyweight devices", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({ name: "device_backends", arguments: {} });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            ownerId?: string;
            backends?: Array<{ name: string; available: boolean; status?: string }>;
        };

        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.backends?.map((backend) => backend.name)).toEqual([
            "x11-current-display",
            "android-emulator",
            "ios-simulator",
            "windows-sandbox",
            "macos-vm",
        ]);
        expect(payload.backends?.find((backend) => backend.name === "android-emulator")?.status).toBe("missing-prerequisites");
        expect(payload.backends?.find((backend) => backend.name === "ios-simulator")?.status).toBe("missing-prerequisites");
        expect(payload.backends?.find((backend) => backend.name === "windows-sandbox")?.status).toBe("missing-prerequisites");
        expect(payload.backends?.find((backend) => backend.name === "macos-vm")?.status).toBe("missing-prerequisites");
    });

    it("lists only the current non-creatable X11 display in the foundation slice", { timeout: TIMEOUT }, async () => {
        const result = await client.callTool({ name: "device_list", arguments: {} });
        expect(result.isError).not.toBe(true);

        const content = result.content as Array<{ type: string; text?: string }>;
        const payload = JSON.parse(content[0].text ?? "{}") as {
            devices?: Array<{ id: string; kind: string; creatable: boolean; lifecycle: string }>;
        };

        expect(payload.devices).toEqual([
            expect.objectContaining({
                id: "x11-current-display",
                kind: "display",
                creatable: false,
                lifecycle: "current",
            }),
        ]);
    });

    it("creates, lists, inspects, and deletes owner-scoped Android definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Pixel Test",
                avdName: "Pixel_Test_API_35",
                port: 5580,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; avdName: string; serial: string; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "android-pixel-test",
            avdName: "Pixel_Test_API_35",
            serial: "emulator-5580",
            status: "stopped",
        }));

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "android-pixel-test", backend: "android-emulator" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("android-pixel-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["adb", "emulator"]);

        const mobileStatus = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(mobileStatus.isError).not.toBe(true);
        const mobile = JSON.parse(((mobileStatus.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            appium: { available: boolean; missing: string[] };
            session: unknown;
            lazy: boolean;
        };
        expect(mobile.lazy).toBe(true);
        expect(mobile.session).toBeNull();
        expect(mobile.appium.available).toBe(false);
        expect(mobile.appium.missing).toContain("adb");

        const tap = await client.callTool({
            name: "mobile_tap",
            arguments: { deviceId: "android-pixel-test", x: 10, y: 20 },
        });
        expect(tap.isError).toBe(true);
        expect((tap.content as Array<{ text?: string }>)[0].text).toContain("Android backend missing prerequisites: adb");

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("missing prerequisites");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-test" },
        });
        expect(deleted.isError).not.toBe(true);

        const afterDelete = await client.callTool({ name: "device_list", arguments: {} });
        const finalList = JSON.parse(((afterDelete.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string }>;
        };
        expect(finalList.devices.map((device) => device.id)).not.toContain("android-pixel-test");
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped iOS definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iPhone Test",
                simulatorName: "iPhone 15",
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; simulatorName: string; status: string; platform: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "ios-iphone-test",
            simulatorName: "iPhone 15",
            status: "stopped",
            platform: "ios",
        }));

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "ios-iphone-test", backend: "ios-simulator" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("ios-iphone-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["xcrun"]);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const screenshot = await client.callTool({
            name: "device_screenshot",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(screenshot.isError).toBe(true);
        expect((screenshot.content as Array<{ text?: string }>)[0].text).toContain("iOS Simulator backend missing prerequisites");

        const session = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(session.isError).not.toBe(true);
        const sessionPayload = JSON.parse(((session.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deviceId: string;
            appium: { available: boolean; missing: string[] };
            session: unknown;
            automationName: string;
            lazy: boolean;
        };
        expect(sessionPayload.deviceId).toBe("ios-iphone-test");
        expect(sessionPayload.automationName).toBe("XCUITest");
        expect(sessionPayload.session).toBeNull();
        expect(sessionPayload.lazy).toBe(true);
        expect(sessionPayload.appium.available).toBe(false);
        expect(sessionPayload.appium.missing).toEqual(expect.arrayContaining(["xcrun", "appium", "appium-xcuitest-driver", "xcodebuild"]));

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(dumpUi.isError).toBe(true);
        expect((dumpUi.content as Array<{ text?: string }>)[0].text).toContain("iOS Appium/XCUITest layer missing prerequisites");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-iphone-test" },
        });
        expect(deleted.isError).not.toBe(true);
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped Windows Sandbox definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Test",
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 4096,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; status: string; platform: string; networking: boolean; helper: { status: string; guestScratchDir: string } };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "windows-win-test",
            status: "stopped",
            platform: "windows",
            networking: false,
        }));
        expect(created.device.helper).toEqual(expect.objectContaining({
            status: "planned",
            guestScratchDir: "C:\\ccc\\scratch",
        }));

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "windows-win-test", backend: "windows-sandbox" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("windows-win-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["wsb"]);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Windows Sandbox backend missing prerequisites");

        const exec = await client.callTool({
            name: "device_exec",
            arguments: { deviceId: "windows-win-test", command: "whoami" },
        });
        expect(exec.isError).toBe(true);
        expect((exec.content as Array<{ text?: string }>)[0].text).toContain("requires the future CCC guest helper");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "windows-win-test" },
        });
        expect(deleted.isError).not.toBe(true);
    });

    it("creates, lists, inspects, starts with diagnostics, and deletes owner-scoped macOS VM definitions", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "macos-vm",
                name: "Mac Test",
                provider: "auto",
                image: "macos-restore-image",
                memoryMb: 8192,
                cpus: 4,
            },
        });
        expect(create.isError).not.toBe(true);

        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: {
                id: string;
                status: string;
                platform: string;
                provider: string;
                providerPlan: { requestedProvider: string; selectedProvider: string | null; missing: string[]; helper: { status: string } };
            };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "macos-mac-test",
            status: "stopped",
            platform: "macos",
            provider: "auto",
        }));
        expect(created.device.providerPlan).toEqual(expect.objectContaining({
            requestedProvider: "auto",
            selectedProvider: null,
            missing: ["macos-host"],
        }));
        expect(created.device.providerPlan.helper.status).toBe("planned");

        const list = await client.callTool({ name: "device_list", arguments: {} });
        const listed = JSON.parse(((list.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            devices: Array<{ id: string; backend?: string }>;
        };
        expect(listed.devices).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: "macos-mac-test", backend: "macos-vm" }),
        ]));

        const status = await client.callTool({
            name: "device_status",
            arguments: { deviceId: "macos-mac-test" },
        });
        expect(status.isError).not.toBe(true);
        const inspected = JSON.parse(((status.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string };
            backend: { status: string; missing: string[] };
        };
        expect(inspected.device.id).toBe("macos-mac-test");
        expect(inspected.backend.status).toBe("missing-prerequisites");
        expect(inspected.backend.missing).toEqual(["macos-host"]);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "macos-mac-test" },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("macOS VM backend missing prerequisites");

        const exec = await client.callTool({
            name: "device_exec",
            arguments: { deviceId: "macos-mac-test", command: "whoami" },
        });
        expect(exec.isError).toBe(true);
        expect((exec.content as Array<{ text?: string }>)[0].text).toContain("requires the future CCC guest helper");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "macos-mac-test" },
        });
        expect(deleted.isError).not.toBe(true);
    });
});

describe("macOS VM backend with fake Tart provider", () => {
    let homeDir: string;
    let binDir: string;
    let logPath: string;
    let oldHome: string | undefined;
    let oldPath: string | undefined;
    let platformSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(() => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-macos-bin-"));
        logPath = join(homeDir, "fake-tart.log");
        const tartPath = join(binDir, "tart");
        writeFileSync(tartPath, `#!/bin/sh
echo "tart $*" >> "$FAKE_TART_LOG"
exit 0
`);
        chmodSync(tartPath, 0o755);

        oldHome = process.env.HOME;
        oldPath = process.env.PATH;
        process.env.HOME = homeDir;
        process.env.PATH = binDir;
        process.env.FAKE_TART_LOG = logPath;
        platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    });

    afterAll(() => {
        platformSpy?.mockRestore();
        process.env.HOME = oldHome;
        process.env.PATH = oldPath;
        delete process.env.FAKE_TART_LOG;
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    });

    it("plans, starts, stops, and diagnoses helper-required operations without provider calls on create", async () => {
        const create = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Fake Tart",
            provider: "auto",
            image: "ghcr.io/example/macos:latest",
            memoryMb: 4096,
            cpus: 2,
        });
        expect(create?.isError).not.toBe(true);
        const created = JSON.parse(((create?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; providerPlan: { selectedProvider: string; providerInstance: string; startCommand: { args: string[] }; helper: { workspaceDir: string } } };
        };
        expect(created.device.id).toBe("macos-fake-tart");
        expect(created.device.providerPlan.selectedProvider).toBe("tart");
        expect(created.device.providerPlan.providerInstance).toContain("macos-fake-tart");
        expect(created.device.providerPlan.startCommand.args).toEqual(["run", created.device.providerPlan.providerInstance]);
        expect(created.device.providerPlan.helper.workspaceDir).toContain("macos-fake-tart");
        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("tart run");

        const start = await handleMacosTool("device_start", { deviceId: "macos-fake-tart" });
        expect(start?.isError).not.toBe(true);
        const started = JSON.parse(((start?.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; provider: string; providerInstance: string };
        };
        expect(started.device.status).toBe("running");
        expect(started.device.provider).toBe("tart");

        const exec = await handleMacosTool("device_exec", { deviceId: "macos-fake-tart", command: "whoami" });
        expect(exec?.isError).toBe(true);
        expect((exec?.content as Array<{ text?: string }>)[0].text).toContain("requires the future CCC guest helper");

        const stop = await handleMacosTool("device_stop", { deviceId: "macos-fake-tart" });
        expect(stop?.isError).not.toBe(true);
        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`tart run ${started.device.providerInstance}`);
        expect(log).toContain(`tart stop ${started.device.providerInstance}`);

        const deleted = await handleMacosTool("device_delete", { deviceId: "macos-fake-tart" });
        expect(deleted?.isError).not.toBe(true);
    });
});

describe("device-lab MCP with fake Windows Sandbox CLI", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-windows-bin-"));
        logPath = join(homeDir, "fake-windows.log");

        const wsbPath = join(binDir, "wsb");
        writeFileSync(wsbPath, `#!/bin/sh
echo "wsb $*" >> "$FAKE_WINDOWS_LOG"
exit 0
`);
        chmodSync(wsbPath, 0o755);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_WINDOWS_LOG: logPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-windows-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("writes owner-scoped Windows Sandbox config with helper bootstrap only on explicit start", { timeout: TIMEOUT }, async () => {
        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "windows-sandbox",
                name: "Win Helper",
                networking: false,
                clipboard: false,
                vgpu: false,
                memoryMb: 2048,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; helper: { scratchDir: string; toolsDir: string; hostHelperScript: string } };
        };
        expect(created.device.id).toBe("windows-win-helper");
        expect(created.device.helper.scratchDir).toContain("windows-win-helper");

        expect(readFileSync(logPath, { encoding: "utf-8", flag: "a+" })).not.toContain("wsb start");

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { configPath: string; helper: { hostHelperScript: string } };
        };
        const config = readFileSync(started.device.configPath, "utf-8");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\scratch</SandboxFolder>");
        expect(config).toContain("<SandboxFolder>C:\\ccc\\tools</SandboxFolder>");
        expect(config).toContain("<ReadOnly>true</ReadOnly>");
        expect(config).toContain("<LogonCommand>");
        expect(config).toContain("ccc-guest-helper.ps1");
        expect(readFileSync(started.device.helper.hostHelperScript, "utf-8")).toContain("CCC guest helper placeholder");

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`wsb start ${started.device.configPath}`);

        const screenshot = await client.callTool({
            name: "device_screenshot",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(screenshot.isError).toBe(true);
        expect((screenshot.content as Array<{ text?: string }>)[0].text).toContain("requires the future CCC guest helper");

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "windows-win-helper" },
        });
        expect(stop.isError).not.toBe(true);
    });
});

describe("device-lab MCP with fake Android SDK", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-android-bin-"));
        logPath = join(homeDir, "fake-android.log");

        const writeScript = (name: string, body: string) => {
            const path = join(binDir, name);
            writeFileSync(path, `#!/bin/sh\n${body}\n`);
            chmodSync(path, 0o755);
        };

        writeScript("emulator", `
echo "emulator $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-list-avds" ]; then
  echo "host_pixel"
  echo "ccc-external-other"
  exit 0
fi
exit 0
`);
        writeScript("adb", `
echo "adb $*" >> "$FAKE_ANDROID_LOG"
if [ "$1" = "-s" ]; then
  shift
  shift
fi
if [ "$1" = "shell" ] && [ "$2" = "getprop" ] && [ "$3" = "sys.boot_completed" ]; then
  echo "1"
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "uiautomator" ] && [ "$3" = "dump" ]; then
  echo "UI hierchary dumped to: $4"
  exit 0
fi
if [ "$1" = "exec-out" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ] && [ "$2" = "cat" ]; then
  printf '%s\\n' '<hierarchy><node text="Hello" resource-id="com.example:id/title"/></hierarchy>'
  exit 0
fi
if [ "$1" = "shell" ]; then
  echo "ok"
  exit 0
fi
exit 0
`);
        writeScript("avdmanager", `
echo "avdmanager $*" >> "$FAKE_ANDROID_LOG"
exit 0
`);

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_ANDROID_LOG: logPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-android-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("discovers avdmanager and reports Android host AVD inventory without starting emulators", { timeout: TIMEOUT }, async () => {
        const backends = await client.callTool({ name: "device_backends", arguments: {} });
        const backendPayload = JSON.parse(((backends.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            backends: Array<{
                name: string;
                status: string;
                tools: { adb?: string; emulator?: string; avdmanager?: string };
                provisioning: { available: boolean; missing: string[] };
            }>;
        };
        const android = backendPayload.backends.find((backend) => backend.name === "android-emulator");
        expect(android).toEqual(expect.objectContaining({
            status: "available",
            provisioning: { available: true, missing: [] },
        }));
        expect(android?.tools.avdmanager).toBe(join(binDir, "avdmanager"));

        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        expect(inventory.isError).not.toBe(true);
        const payload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            hostAvds: { available: boolean; avds: string[] };
            devices: Array<{ id: string }>;
        };
        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.hostAvds).toEqual({ available: true, missing: [], avds: ["host_pixel", "ccc-external-other"] });
        expect(payload.devices).toEqual([]);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("emulator -list-avds");
        expect(log).not.toContain("emulator -avd");
    });

    it("creates and deletes owner-prefixed AVDs through avdmanager only when requested", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const avdName = `ccc-${ownerId}-pixel-owned`;

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Pixel Owned",
                avdName,
                port: 5582,
                systemImage: "system-images;android-35;google_apis;x86_64",
                deviceProfile: "pixel_6",
                createAvd: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; avdName: string; provisioned: boolean; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "android-pixel-owned",
            avdName,
            provisioned: true,
            status: "stopped",
        }));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-pixel-owned", bootTimeoutMs: 1000 },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; bootReady: boolean };
            boot: { ready: boolean };
        };
        expect(started.boot.ready).toBe(true);
        expect(started.device.status).toBe("running");
        expect(started.device.bootReady).toBe(true);

        const primitiveCalls = [
            ["mobile_tap", { deviceId: "android-pixel-owned", x: 10, y: 20 }],
            ["mobile_double_tap", { deviceId: "android-pixel-owned", x: 11, y: 21 }],
            ["mobile_long_press", { deviceId: "android-pixel-owned", x: 12, y: 22, durationMs: 900 }],
            ["mobile_swipe", { deviceId: "android-pixel-owned", x1: 1, y1: 2, x2: 30, y2: 40, durationMs: 500 }],
            ["mobile_type_text", { deviceId: "android-pixel-owned", text: "hello world" }],
            ["mobile_key", { deviceId: "android-pixel-owned", keyCode: 82 }],
            ["mobile_home", { deviceId: "android-pixel-owned" }],
            ["mobile_back", { deviceId: "android-pixel-owned" }],
            ["mobile_forward", { deviceId: "android-pixel-owned" }],
            ["mobile_recents", { deviceId: "android-pixel-owned" }],
            ["mobile_power", { deviceId: "android-pixel-owned" }],
            ["mobile_lock", { deviceId: "android-pixel-owned" }],
            ["mobile_unlock", { deviceId: "android-pixel-owned" }],
            ["mobile_open_url", { deviceId: "android-pixel-owned", url: "https://example.test/path" }],
        ] as const;
        for (const [name, callArgs] of primitiveCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }
        const screenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(dumpUi.isError).not.toBe(true);
        const dumpPayload = JSON.parse(((dumpUi.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            provider: string;
            source: string;
            remotePath: string;
        };
        expect(dumpPayload.provider).toBe("adb-uiautomator");
        expect(dumpPayload.source).toContain("<hierarchy>");
        expect(dumpPayload.remotePath).toContain("android-pixel-owned");

        const fileAndAppCalls = [
            ["device_upload", { deviceId: "android-pixel-owned", localPath: "/tmp/local.txt", remotePath: "/sdcard/local.txt" }],
            ["device_download", { deviceId: "android-pixel-owned", remotePath: "/sdcard/remote.txt", localPath: "/tmp/remote.txt" }],
            ["device_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Test.apk" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.test" }],
            ["device_launch_app", { deviceId: "android-pixel-owned", component: "com.example.test/.MainActivity" }],
            ["device_reset", { deviceId: "android-pixel-owned", packageName: "com.example.test" }],
            ["mobile_install_app", { deviceId: "android-pixel-owned", path: "/tmp/Mobile.apk" }],
            ["mobile_launch_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_uninstall_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_stop_app", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
            ["mobile_clear_app_data", { deviceId: "android-pixel-owned", packageName: "com.example.mobile" }],
        ] as const;
        for (const [name, callArgs] of fileAndAppCalls) {
            const action = await client.callTool({ name, arguments: callArgs });
            expect(action.isError).not.toBe(true);
        }

        const deleteWhileRunning = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true },
        });
        expect(deleteWhileRunning.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "android-pixel-owned" },
        });
        expect(stop.isError).not.toBe(true);

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-pixel-owned", deleteAvd: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            avdDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: "android-pixel-owned", avdDeleted: true });

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`avdmanager create avd --name ${avdName} --package system-images;android-35;google_apis;x86_64 --force --device pixel_6`);
        expect(log).toContain(`emulator -avd ${avdName}`);
        expect(log).toContain("adb -s emulator-5582 shell getprop sys.boot_completed");
        expect(log).toContain("adb -s emulator-5582 shell input tap 10 20");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 12 22 12 22 900");
        expect(log).toContain("adb -s emulator-5582 shell input swipe 1 2 30 40 500");
        expect(log).toContain("adb -s emulator-5582 shell input text hello%sworld");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 82");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 3");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 4");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 125");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 187");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 26");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 223");
        expect(log).toContain("adb -s emulator-5582 shell input keyevent 224");
        expect(log).toContain("adb -s emulator-5582 shell am start -a android.intent.action.VIEW -d https://example.test/path");
        expect(log).toContain("adb -s emulator-5582 exec-out screencap -p");
        expect(log).toContain("adb -s emulator-5582 shell uiautomator dump /sdcard/window-android-pixel-owned.xml");
        expect(log).toContain("adb -s emulator-5582 exec-out cat /sdcard/window-android-pixel-owned.xml");
        expect(log).toContain("adb -s emulator-5582 push /tmp/local.txt /sdcard/local.txt");
        expect(log).toContain("adb -s emulator-5582 pull /sdcard/remote.txt /tmp/remote.txt");
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Test.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.test 1");
        expect(log).toContain("adb -s emulator-5582 shell am start -n com.example.test/.MainActivity");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.test");
        expect(log).toContain("adb -s emulator-5582 install -r /tmp/Mobile.apk");
        expect(log).toContain("adb -s emulator-5582 shell monkey -p com.example.mobile 1");
        expect(log).toContain("adb -s emulator-5582 uninstall com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell am force-stop com.example.mobile");
        expect(log).toContain("adb -s emulator-5582 shell pm clear com.example.mobile");
        expect(log).toContain(`avdmanager delete avd --name ${avdName}`);
        expect(log).not.toContain("appium");
    });

    it("refuses avdmanager create/delete for non-owned Android AVD names", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "android-emulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const metadataOnlyAvd = `ccc-${ownerId}-metadata-only`;

        const metadataWithSystemImage = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Metadata System Image",
                avdName: metadataOnlyAvd,
                systemImage: "system-images;android-35;google_apis;x86_64",
            },
        });
        expect(metadataWithSystemImage.isError).not.toBe(true);
        const metadataPayload = JSON.parse(((metadataWithSystemImage.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { provisioned: boolean; systemImage: string };
        };
        expect(metadataPayload.device.provisioned).toBe(false);
        expect(metadataPayload.device.systemImage).toBe("system-images;android-35;google_apis;x86_64");

        const metadataSystemImageDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-metadata-system-image" },
        });
        expect(metadataSystemImageDeleted.isError).not.toBe(true);

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Foreign Create",
                avdName: "foreign-avd",
                systemImage: "system-images;android-35;google_apis;x86_64",
                createAvd: true,
            },
        });
        expect(create.isError).toBe(true);
        expect((create.content as Array<{ text?: string }>)[0].text).toContain("Refusing to create non-owned Android AVD name");

        const metadataOnly = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "android-emulator",
                name: "Foreign Metadata",
                avdName: "foreign-avd",
            },
        });
        expect(metadataOnly.isError).not.toBe(true);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "android-foreign-metadata", bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start non-owned Android AVD name");

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata", deleteAvd: true },
        });
        expect(deleted.isError).toBe(true);
        expect((deleted.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete non-owned Android AVD name");

        const metadataDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "android-foreign-metadata" },
        });
        expect(metadataDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`avdmanager create avd --name ${metadataOnlyAvd}`);
        expect(log).not.toContain("emulator -avd foreign-avd");
    });
});

describe("device-lab MCP with fake iOS simctl", () => {
    let client: Client;
    let homeDir: string;
    let binDir: string;
    let logPath: string;

    beforeAll(async () => {
        homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-home-"));
        binDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-ios-bin-"));
        logPath = join(homeDir, "fake-ios.log");

        const xcrunPath = join(binDir, "xcrun");
        writeFileSync(xcrunPath, `#!/bin/sh
echo "xcrun $*" >> "$FAKE_IOS_LOG"
if [ "$1" = "simctl" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-17-0":[{"name":"host iPhone","udid":"HOST-UDID","state":"Shutdown"}]},"runtimes":[{"identifier":"com.apple.CoreSimulator.SimRuntime.iOS-17-0","name":"iOS 17.0","isAvailable":true}],"devicetypes":[{"identifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-15","name":"iPhone 15"}]}'
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "create" ]; then
  echo "CREATED-IOS-UDID"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "boot" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "bootstatus" ]; then
  echo "Booted"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "shutdown" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "delete" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "spawn" ]; then
  echo "ok"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "io" ] && [ "$4" = "screenshot" ]; then
  printf 'fakepng' > "$5"
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "openurl" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "install" ]; then
  exit 0
fi
if [ "$1" = "simctl" ] && [ "$2" = "launch" ]; then
  echo "$4: 123"
  exit 0
fi
exit 0
`);
        chmodSync(xcrunPath, 0o755);
        for (const name of ["appium", "appium-xcuitest-driver", "xcodebuild"]) {
            const toolPath = join(binDir, name);
            writeFileSync(toolPath, `#!/bin/sh
echo "${name} $*" >> "$FAKE_IOS_LOG"
exit 0
`);
            chmodSync(toolPath, 0o755);
        }

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                HOME: homeDir,
                PATH: binDir,
                NODE_ENV: "test",
                FAKE_IOS_LOG: logPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-ios-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
    }, TIMEOUT);

    afterAll(async () => {
        await client?.close();
        if (homeDir) rmSync(homeDir, { recursive: true, force: true });
        if (binDir) rmSync(binDir, { recursive: true, force: true });
    }, TIMEOUT);

    it("reports iOS simctl inventory without booting simulators", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        expect(inventory.isError).not.toBe(true);
        const payload = JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            ownerId: string;
            hostSimulators: {
                available: boolean;
                devices: Record<string, Array<{ name: string; udid: string; state: string }>>;
                runtimes: Array<{ identifier: string }>;
                deviceTypes: Array<{ identifier: string }>;
            };
            devices: Array<{ id: string }>;
            discovery: { available: boolean; xcrun: string };
        };
        expect(payload.ownerId).toMatch(/^[a-f0-9]{16}$/);
        expect(payload.discovery).toEqual({ available: true, missing: [], xcrun: join(binDir, "xcrun") });
        expect(payload.hostSimulators.available).toBe(true);
        expect(payload.hostSimulators.runtimes[0].identifier).toBe("com.apple.CoreSimulator.SimRuntime.iOS-17-0");
        expect(payload.hostSimulators.deviceTypes[0].identifier).toBe("com.apple.CoreSimulator.SimDeviceType.iPhone-15");
        expect(payload.devices).toEqual([]);

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain("xcrun simctl list -j");
        expect(log).not.toContain("xcrun simctl boot ");
        expect(log).not.toContain("xcrun simctl create ");
    });

    it("creates, boots, stops, and deletes owner-prefixed iOS simulators only when explicit", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const simulatorName = `ccc-${ownerId}-iphone-owned`;

        const create = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iPhone Owned",
                simulatorName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(create.isError).not.toBe(true);
        const created = JSON.parse(((create.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { id: string; simulatorName: string; udid: string; provisioning: string; status: string };
        };
        expect(created.device).toEqual(expect.objectContaining({
            id: "ios-iphone-owned",
            simulatorName,
            udid: "CREATED-IOS-UDID",
            provisioning: "created",
            status: "stopped",
        }));

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "ios-iphone-owned", bootTimeoutMs: 1000 },
        });
        expect(start.isError).not.toBe(true);
        const started = JSON.parse(((start.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { status: string; bootReady: boolean };
            boot: { ready: boolean };
        };
        expect(started.boot.ready).toBe(true);
        expect(started.device.status).toBe("booted");
        expect(started.device.bootReady).toBe(true);

        const openUrl = await client.callTool({
            name: "mobile_open_url",
            arguments: { deviceId: "ios-iphone-owned", url: "https://example.test/ios" },
        });
        expect(openUrl.isError).not.toBe(true);
        const openUrlPayload = JSON.parse(((openUrl.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            openedUrl: string;
            provider: string;
        };
        expect(openUrlPayload).toEqual(expect.objectContaining({
            openedUrl: "https://example.test/ios",
            provider: "simctl",
        }));

        const installApp = await client.callTool({
            name: "mobile_install_app",
            arguments: { deviceId: "ios-iphone-owned", path: "/tmp/Test.app" },
        });
        expect(installApp.isError).not.toBe(true);

        const launchApp = await client.callTool({
            name: "mobile_launch_app",
            arguments: { deviceId: "ios-iphone-owned", bundleId: "com.example.Test" },
        });
        expect(launchApp.isError).not.toBe(true);

        const commonInstall = await client.callTool({
            name: "device_install_app",
            arguments: { deviceId: "ios-iphone-owned", path: "/tmp/Common.app" },
        });
        expect(commonInstall.isError).not.toBe(true);

        const commonLaunch = await client.callTool({
            name: "device_launch_app",
            arguments: { deviceId: "ios-iphone-owned", bundleId: "com.example.Common" },
        });
        expect(commonLaunch.isError).not.toBe(true);

        const upload = await client.callTool({
            name: "device_upload",
            arguments: { deviceId: "ios-iphone-owned", localPath: "/tmp/local.txt", remotePath: "/tmp/remote.txt" },
        });
        expect(upload.isError).toBe(true);
        expect((upload.content as Array<{ text?: string }>)[0].text).toContain("file transfer requires an app container target");

        const download = await client.callTool({
            name: "device_download",
            arguments: { deviceId: "ios-iphone-owned", remotePath: "/tmp/remote.txt", localPath: "/tmp/local.txt" },
        });
        expect(download.isError).toBe(true);
        expect((download.content as Array<{ text?: string }>)[0].text).toContain("file transfer requires an app container target");

        const reset = await client.callTool({
            name: "device_reset",
            arguments: { deviceId: "ios-iphone-owned", bundleId: "com.example.Test" },
        });
        expect(reset.isError).toBe(true);
        expect((reset.content as Array<{ text?: string }>)[0].text).toContain("future explicit simulator erase");

        const screenshot = await client.callTool({
            name: "mobile_screenshot",
            arguments: { deviceId: "ios-iphone-owned" },
        });
        expect(screenshot.isError).not.toBe(true);
        expect((screenshot.content as Array<{ type: string }>)[0].type).toBe("image");

        const session = await client.callTool({
            name: "mobile_session_status",
            arguments: { deviceId: "ios-iphone-owned" },
        });
        expect(session.isError).not.toBe(true);
        const sessionPayload = JSON.parse(((session.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            appium: { available: boolean; appium: string; xcuitestDriver: string; xcodebuild: string; xcrun: string; missing: string[] };
            session: unknown;
            automationName: string;
            lazy: boolean;
        };
        expect(sessionPayload.appium).toEqual({
            available: true,
            missing: [],
            appium: join(binDir, "appium"),
            xcuitestDriver: join(binDir, "appium-xcuitest-driver"),
            xcodebuild: join(binDir, "xcodebuild"),
            xcrun: join(binDir, "xcrun"),
        });
        expect(sessionPayload.session).toBeNull();
        expect(sessionPayload.automationName).toBe("XCUITest");
        expect(sessionPayload.lazy).toBe(true);

        const dumpUi = await client.callTool({
            name: "mobile_dump_ui",
            arguments: { deviceId: "ios-iphone-owned" },
        });
        expect(dumpUi.isError).toBe(true);
        expect((dumpUi.content as Array<{ text?: string }>)[0].text).toContain("session creation is deferred");

        const unsupportedTap = await client.callTool({
            name: "mobile_tap",
            arguments: { deviceId: "ios-iphone-owned", x: 10, y: 20 },
        });
        expect(unsupportedTap.isError).toBe(true);
        expect((unsupportedTap.content as Array<{ text?: string }>)[0].text).toContain("does not support mobile_tap through base simctl");

        const deleteWhileBooted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-iphone-owned", deleteSimulator: true },
        });
        expect(deleteWhileBooted.isError).toBe(true);

        const stop = await client.callTool({
            name: "device_stop",
            arguments: { deviceId: "ios-iphone-owned" },
        });
        expect(stop.isError).not.toBe(true);

        const deleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-iphone-owned", deleteSimulator: true },
        });
        expect(deleted.isError).not.toBe(true);
        const deletedPayload = JSON.parse(((deleted.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            deleted: string;
            simulatorDeleted: boolean;
        };
        expect(deletedPayload).toEqual({ deleted: "ios-iphone-owned", simulatorDeleted: true });

        const log = readFileSync(logPath, "utf-8");
        expect(log).toContain(`xcrun simctl create ${simulatorName} com.apple.CoreSimulator.SimDeviceType.iPhone-15 com.apple.CoreSimulator.SimRuntime.iOS-17-0`);
        expect(log).toContain("xcrun simctl boot CREATED-IOS-UDID");
        expect(log).toContain("xcrun simctl bootstatus CREATED-IOS-UDID -b");
        expect(log).toContain("xcrun simctl openurl CREATED-IOS-UDID https://example.test/ios");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Test.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Test");
        expect(log).toContain("xcrun simctl install CREATED-IOS-UDID /tmp/Common.app");
        expect(log).toContain("xcrun simctl launch CREATED-IOS-UDID com.example.Common");
        expect(log).toContain("xcrun simctl io CREATED-IOS-UDID screenshot ");
        expect(log).toContain("xcrun simctl delete CREATED-IOS-UDID");
        expect(log).not.toContain("appium server");
        expect(log).not.toContain("Android backend missing prerequisites");
    });

    it("keeps metadata-only iOS definitions lazy and refuses non-owned simulator operations", { timeout: TIMEOUT }, async () => {
        const inventory = await client.callTool({
            name: "device_inventory",
            arguments: { backend: "ios-simulator" },
        });
        const ownerId = (JSON.parse(((inventory.content as Array<{ text?: string }>)[0].text ?? "{}")) as { ownerId: string }).ownerId;
        const metadataOnlyName = `ccc-${ownerId}-ios-metadata-only`;

        const metadataOnly = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "iOS Metadata Only",
                simulatorName: metadataOnlyName,
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
            },
        });
        expect(metadataOnly.isError).not.toBe(true);
        const metadataPayload = JSON.parse(((metadataOnly.content as Array<{ text?: string }>)[0].text ?? "{}")) as {
            device: { provisioning: string; udid: string | null };
        };
        expect(metadataPayload.device.provisioning).toBe("definition-only");
        expect(metadataPayload.device.udid).toBeNull();

        const metadataDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-ios-metadata-only" },
        });
        expect(metadataDeleted.isError).not.toBe(true);

        const foreignCreate = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "Foreign iOS Create",
                simulatorName: "foreign-ios",
                deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
                runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
                createSimulator: true,
            },
        });
        expect(foreignCreate.isError).toBe(true);
        expect((foreignCreate.content as Array<{ text?: string }>)[0].text).toContain("Refusing to create non-owned iOS Simulator name");

        const foreignMetadata = await client.callTool({
            name: "device_create",
            arguments: {
                backend: "ios-simulator",
                name: "Foreign iOS Metadata",
                simulatorName: "foreign-ios",
                udid: "FOREIGN-UDID",
            },
        });
        expect(foreignMetadata.isError).not.toBe(true);

        const start = await client.callTool({
            name: "device_start",
            arguments: { deviceId: "ios-foreign-ios-metadata", bootTimeoutMs: 1000 },
        });
        expect(start.isError).toBe(true);
        expect((start.content as Array<{ text?: string }>)[0].text).toContain("Refusing to start non-owned iOS Simulator name");

        const deleteSimulator = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata", deleteSimulator: true },
        });
        expect(deleteSimulator.isError).toBe(true);
        expect((deleteSimulator.content as Array<{ text?: string }>)[0].text).toContain("Refusing to delete non-owned iOS Simulator name");

        const foreignDeleted = await client.callTool({
            name: "device_delete",
            arguments: { deviceId: "ios-foreign-ios-metadata" },
        });
        expect(foreignDeleted.isError).not.toBe(true);

        const log = readFileSync(logPath, "utf-8");
        expect(log).not.toContain(`xcrun simctl create ${metadataOnlyName}`);
        expect(log).not.toContain("xcrun simctl boot FOREIGN-UDID");
        expect(log).not.toContain("xcrun simctl delete FOREIGN-UDID");
    });
});
