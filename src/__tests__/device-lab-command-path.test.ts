import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    DEVICE_COMMAND_DISCOVERY_TIMEOUT_MS,
    DEVICE_COMMAND_MAX_BUFFER_BYTES,
    DEVICE_COMMAND_MAX_BUFFER_LIMIT_BYTES,
    DEVICE_COMMAND_MAX_TIMEOUT_MS,
    DEVICE_COMMAND_TIMEOUT_MS,
    commandPath as mcpCommandPath,
    run,
    runBuffer,
    runWithInput,
    runWithTimeout,
} from "../../device-lab-mcp/src/commands.mjs";
import { commandPath as realTestCommandPath, hiddenSpawnSync } from "../../scripts/real-tests/helpers.ts";

vi.mock("child_process", () => ({
    spawnSync: vi.fn(),
}));

const spawnSyncMock = vi.mocked(spawnSync);
const originalPlatform = process.platform;
const originalLocalAppData = process.env.LOCALAPPDATA;
let tempRoot: string | null = null;

function setPlatform(platform: NodeJS.Platform) {
    Object.defineProperty(process, "platform", {
        configurable: true,
        value: platform,
    });
}

describe("device-lab commandPath", () => {
    beforeEach(() => {
        spawnSyncMock.mockReset();
    });

    afterEach(() => {
        setPlatform(originalPlatform);
        if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = originalLocalAppData;
        if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = null;
    });

    it("trims Windows where CRLF output before returning the first command path", () => {
        setPlatform("win32");
        spawnSyncMock.mockReturnValue({
            status: 0,
            stdout: "C:\\Tools\\wsb.exe\r\nC:\\Other\\wsb.exe\r\n",
        } as ReturnType<typeof spawnSync>);

        expect(mcpCommandPath("wsb")).toBe("C:\\Tools\\wsb.exe");
        expect(realTestCommandPath("wsb")).toBe("C:\\Tools\\wsb.exe");
        expect(spawnSyncMock.mock.calls[0][2]).toEqual(expect.objectContaining({
            maxBuffer: 1024 * 1024,
            timeout: DEVICE_COMMAND_DISCOVERY_TIMEOUT_MS,
            windowsHide: true,
        }));
        expect(spawnSyncMock.mock.calls[1][2]).toEqual(expect.objectContaining({ windowsHide: true }));
    });

    it("hides direct MCP helper command windows", () => {
        spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>);

        run("adb", ["devices"]);
        runWithTimeout("adb", ["shell", "echo ok"], 1000);
        runWithInput("avdmanager", ["create", "avd"], "no\n");
        runBuffer("adb", ["exec-out", "screencap", "-p"], { maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });

        expect(spawnSyncMock).toHaveBeenCalledTimes(4);
        for (const call of spawnSyncMock.mock.calls) {
            expect(call[2]).toEqual(expect.objectContaining({ windowsHide: true }));
        }
        expect(spawnSyncMock.mock.calls[3][2]).toEqual(expect.objectContaining({
            maxBuffer: 32 * 1024 * 1024,
            timeout: 30_000,
        }));
        expect(spawnSyncMock.mock.calls[0][2]).toEqual(expect.objectContaining({
            maxBuffer: DEVICE_COMMAND_MAX_BUFFER_BYTES,
            timeout: DEVICE_COMMAND_TIMEOUT_MS,
        }));
        expect(spawnSyncMock.mock.calls[1][2]).toEqual(expect.objectContaining({
            maxBuffer: DEVICE_COMMAND_MAX_BUFFER_BYTES,
            timeout: 1000,
        }));
        expect(spawnSyncMock.mock.calls[2][2]).toEqual(expect.objectContaining({
            maxBuffer: DEVICE_COMMAND_MAX_BUFFER_BYTES,
            timeout: DEVICE_COMMAND_TIMEOUT_MS,
        }));
    });

    it("clamps explicit command execution bounds", () => {
        spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>);

        runWithTimeout("adb", ["devices"], Number.MAX_SAFE_INTEGER, { maxBuffer: Number.MAX_SAFE_INTEGER });
        runBuffer("adb", ["devices"], { timeout: Number.POSITIVE_INFINITY, maxBuffer: -1 });
        runWithTimeout("adb", ["devices"], 0.5, { maxBuffer: 0.5 });

        expect(spawnSyncMock.mock.calls[0][2]).toEqual(expect.objectContaining({
            maxBuffer: DEVICE_COMMAND_MAX_BUFFER_LIMIT_BYTES,
            timeout: DEVICE_COMMAND_MAX_TIMEOUT_MS,
        }));
        expect(spawnSyncMock.mock.calls[1][2]).toEqual(expect.objectContaining({
            maxBuffer: DEVICE_COMMAND_MAX_BUFFER_BYTES,
            timeout: DEVICE_COMMAND_TIMEOUT_MS,
        }));
        expect(spawnSyncMock.mock.calls[2][2]).toEqual(expect.objectContaining({
            maxBuffer: 1,
            timeout: 1,
        }));
    });

    it("hides real-test provider command windows", () => {
        spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>);

        hiddenSpawnSync("wsb", ["list", "--raw"], { encoding: "utf-8", timeout: 1000 });

        expect(spawnSyncMock).toHaveBeenCalledWith("wsb", ["list", "--raw"], expect.objectContaining({
            encoding: "utf-8",
            timeout: 1000,
            windowsHide: true,
        }));
    });

    it("wraps direct MCP Windows batch commands through cmd.exe", () => {
        setPlatform("win32");
        spawnSyncMock.mockReturnValue({ status: 0, stdout: "", stderr: "" } as ReturnType<typeof spawnSync>);

        runWithInput("C:\\Users\\TestUser\\Android Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat", ["create", "avd", "--name", "ccc smoke"], "no\n");

        expect(spawnSyncMock).toHaveBeenCalledWith("cmd.exe", [
            "/d",
            "/s",
            "/c",
            "\"C:\\Users\\TestUser\\Android Sdk\\cmdline-tools\\latest\\bin\\avdmanager.bat\" create avd --name \"ccc smoke\"",
        ], expect.objectContaining({
            input: "no\n",
            windowsHide: true,
        }));
    });

    it("returns null instead of throwing when command discovery cannot produce stdout", () => {
        setPlatform("win32");
        spawnSyncMock.mockReturnValue({
            status: null,
            error: new Error("spawn where ENOENT"),
        } as ReturnType<typeof spawnSync>);

        expect(mcpCommandPath("wsb")).toBeNull();
        expect(realTestCommandPath("wsb")).toBeNull();
    });

    it("rejects shell syntax in command discovery without spawning", () => {
        setPlatform("linux");

        expect(mcpCommandPath("adb; touch /tmp/not-allowed")).toBeNull();
        expect(spawnSyncMock).not.toHaveBeenCalled();
    });

    it("falls back to WindowsApps execution aliases when where misses wsb", () => {
        setPlatform("win32");
        tempRoot = join(tmpdir(), `ccc-command-path-windowsapps-${Date.now()}`);
        const windowsApps = join(tempRoot, "Microsoft", "WindowsApps");
        mkdirSync(windowsApps, { recursive: true });
        const wsb = join(windowsApps, "wsb.exe");
        writeFileSync(wsb, "");
        process.env.LOCALAPPDATA = tempRoot;
        spawnSyncMock.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

        expect(mcpCommandPath("wsb")).toBe(wsb);
        expect(realTestCommandPath("wsb")).toBe(wsb);
    });

    it("falls back to Android Studio SDK tool locations on Windows", () => {
        setPlatform("win32");
        tempRoot = join(tmpdir(), `ccc-command-path-android-sdk-${Date.now()}`);
        const sdk = join(tempRoot, "Android", "Sdk");
        mkdirSync(join(sdk, "platform-tools"), { recursive: true });
        writeFileSync(join(sdk, "platform-tools", "adb.exe"), "");
        process.env.LOCALAPPDATA = tempRoot;
        spawnSyncMock.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

        expect(mcpCommandPath("adb")).toBe(join(sdk, "platform-tools", "adb.exe"));
        expect(realTestCommandPath("adb")).toBe(join(sdk, "platform-tools", "adb.exe"));
    });

    it("discovers Android command-line tool batch files from versioned cmdline-tools on Windows", () => {
        setPlatform("win32");
        tempRoot = join(tmpdir(), `ccc-command-path-android-sdk-bat-${Date.now()}`);
        const sdk = join(tempRoot, "Android", "Sdk");
        mkdirSync(join(sdk, "cmdline-tools", "13.0", "bin"), { recursive: true });
        writeFileSync(join(sdk, "cmdline-tools", "13.0", "bin", "avdmanager.bat"), "");
        process.env.LOCALAPPDATA = tempRoot;
        spawnSyncMock.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);

        expect(mcpCommandPath("avdmanager")).toBe(join(sdk, "cmdline-tools", "13.0", "bin", "avdmanager.bat"));
        expect(realTestCommandPath("avdmanager")).toBe(join(sdk, "cmdline-tools", "13.0", "bin", "avdmanager.bat"));
    });
});
