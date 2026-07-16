import { EventEmitter } from "events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    androidWindowsHiddenLauncherScript,
    materializeAndroidWindowsHiddenLauncher,
    removeAndroidWindowsHiddenLauncher,
    scheduleAndroidWindowsHiddenLauncherCleanup,
} from "../../device-lab-mcp/src/backends/android.mjs";

describe("device-lab MCP direct Android Windows launcher", () => {
    let home: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        originalHome = process.env.HOME;
        home = mkdtempSync(join(tmpdir(), "ccc-android-launcher-"));
        process.env.HOME = home;
    });

    afterEach(() => {
        vi.useRealTimers();
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(home, { recursive: true, force: true });
    });

    it("creates unique single-link launchers with exact content", () => {
        const device = { id: "android-pixel" };
        const executable = "C:\\Android SDK\\emulator.exe";
        const args = ["-avd", "Pixel 8"];
        const first = materializeAndroidWindowsHiddenLauncher(device, executable, args);
        const second = materializeAndroidWindowsHiddenLauncher(device, executable, args);

        expect(first).not.toBe(second);
        expect(first).toMatch(/ccc-android-emulator-[a-f0-9]{32}\.vbs$/);
        expect(lstatSync(first)).toEqual(expect.objectContaining({ nlink: 1 }));
        expect(readFileSync(first, "utf8")).toBe(androidWindowsHiddenLauncherScript(executable, args));

        removeAndroidWindowsHiddenLauncher(first);
        removeAndroidWindowsHiddenLauncher(second);
    });

    it("preserves an existing launcher when an exclusive-name collision occurs", () => {
        const randomId = "a".repeat(32);
        const options = { randomId: () => randomId };
        const existing = materializeAndroidWindowsHiddenLauncher(
            { id: "android-pixel" },
            "emulator.exe",
            ["-avd", "Original"],
            options,
        );
        const original = readFileSync(existing, "utf8");

        expect(() => materializeAndroidWindowsHiddenLauncher(
            { id: "android-pixel" },
            "emulator.exe",
            ["-avd", "Replacement"],
            options,
        )).toThrow("android-launcher-create-failed");
        expect(readFileSync(existing, "utf8")).toBe(original);
        removeAndroidWindowsHiddenLauncher(existing);
    });

    it.runIf(process.platform !== "win32")("refuses linked launcher parents without mutating their targets", () => {
        const external = join(home, "external");
        const marker = join(external, "preserve.txt");
        mkdirSync(external);
        writeFileSync(marker, "preserve");
        symlinkSync(external, join(home, ".ccc"));

        expect(() => materializeAndroidWindowsHiddenLauncher(
            { id: "android-pixel" },
            "C:\\Android\\emulator.exe",
            ["-avd", "Pixel"],
        )).toThrow("android-launcher-directory-invalid");
        expect(readdirSync(external)).toEqual(["preserve.txt"]);
        expect(readFileSync(marker, "utf8")).toBe("preserve");
    });

    it("rejects device ids that escape the owner launcher namespace", () => {
        expect(() => materializeAndroidWindowsHiddenLauncher(
            { id: "../../../../outside" },
            "C:\\Android\\emulator.exe",
            ["-avd", "Pixel"],
        )).toThrow("android-launcher-device-id-invalid");
    });

    it("removes launchers on wrapper close and on the bounded fallback", () => {
        const first = materializeAndroidWindowsHiddenLauncher({ id: "android-pixel" }, "emulator.exe", []);
        const firstChild = new EventEmitter();
        scheduleAndroidWindowsHiddenLauncherCleanup(first, firstChild, 60_000);
        firstChild.emit("close");
        expect(existsSync(first)).toBe(false);

        vi.useFakeTimers();
        const second = materializeAndroidWindowsHiddenLauncher({ id: "android-pixel" }, "emulator.exe", []);
        scheduleAndroidWindowsHiddenLauncherCleanup(second, new EventEmitter(), 1000);
        vi.advanceTimersByTime(999);
        expect(existsSync(second)).toBe(true);
        vi.advanceTimersByTime(1);
        expect(existsSync(second)).toBe(false);
    });
});
