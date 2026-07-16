import { spawnSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceLabSmoke } from "../device-lab-admin.js";

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

describe("deviceLabSmoke command discovery", () => {
    beforeEach(() => {
        setPlatform("win32");
        spawnSyncMock.mockReset();
        spawnSyncMock.mockImplementation((command, args) => {
            if (command === "where") {
                const tool = Array.isArray(args) ? args[0] : undefined;
                if (tool === "wsb") {
                    return {
                        status: 0,
                        stdout: "C:\\Tools\\wsb.exe\r\nC:\\Other\\wsb.exe\r\n",
                    } as ReturnType<typeof spawnSync>;
                }
                return { status: 1 } as ReturnType<typeof spawnSync>;
            }
            return { status: 0, stdout: "ok\n", stderr: "" } as ReturnType<typeof spawnSync>;
        });
    });

    afterEach(() => {
        setPlatform(originalPlatform);
        if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
        else process.env.LOCALAPPDATA = originalLocalAppData;
        if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = null;
    });

    it("uses a CRLF-trimmed Windows where path for real-provider smoke commands", () => {
        const smoke = deviceLabSmoke("/project/windows-smoke", 100, undefined, { mode: "real-provider" });
        const windows = smoke.results.find((result) => result.backend === "windows-sandbox");

        expect(windows).toEqual(expect.objectContaining({ status: "PASS" }));
        expect(windows?.commands?.[0].command).toBe("C:\\Tools\\wsb.exe --help");
        expect(spawnSyncMock).toHaveBeenCalledWith(
            "C:\\Tools\\wsb.exe",
            ["--help"],
            expect.objectContaining({ timeout: 100, windowsHide: true }),
        );
        for (const call of spawnSyncMock.mock.calls) {
            expect(call[2]).toEqual(expect.objectContaining({ windowsHide: true }));
        }
    });

    it("discovers Android Studio SDK tools from LOCALAPPDATA when they are not on PATH", () => {
        tempRoot = join(tmpdir(), `ccc-android-sdk-${Date.now()}`);
        const sdk = join(tempRoot, "Android", "Sdk");
        mkdirSync(join(sdk, "platform-tools"), { recursive: true });
        mkdirSync(join(sdk, "emulator"), { recursive: true });
        mkdirSync(join(sdk, "cmdline-tools", "13.0", "bin"), { recursive: true });
        writeFileSync(join(sdk, "platform-tools", "adb.exe"), "");
        writeFileSync(join(sdk, "emulator", "emulator.exe"), "");
        writeFileSync(join(sdk, "cmdline-tools", "13.0", "bin", "avdmanager.bat"), "");
        process.env.LOCALAPPDATA = tempRoot;
        spawnSyncMock.mockImplementation((command, args) => {
            if (command === "where") return { status: 1 } as ReturnType<typeof spawnSync>;
            return { status: 0, stdout: "ok\n", stderr: "" } as ReturnType<typeof spawnSync>;
        });

        const smoke = deviceLabSmoke("/project/android-sdk-smoke", 100, undefined, { mode: "real-provider" });
        const android = smoke.results.find((result) => result.backend === "android-emulator");
        const physical = smoke.results.find((result) => result.backend === "android-device");

        expect(android).toEqual(expect.objectContaining({ status: "PASS" }));
        expect(physical).toEqual(expect.objectContaining({ status: "PASS" }));
        expect(android?.commands?.map((command) => command.command)).toEqual(expect.arrayContaining([
            `${join(sdk, "platform-tools", "adb.exe")} version`,
            `${join(sdk, "emulator", "emulator.exe")} -list-avds`,
        ]));
    });
});
