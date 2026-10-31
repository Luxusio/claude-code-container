import { directorySymlink } from "./helpers/file-symlink-fixture.js";
import { isolateDeviceLabTestEnvironment } from "./helpers/device-lab-test-environment.js";
import { EventEmitter } from "events";
import { performance } from "node:perf_hooks";
import type { ChildProcess } from "node:child_process";
import * as nativeCommands from "@ccc/device-lab/providers/commands.mjs";
import * as nativeWindows from "@ccc/device-lab/providers/state/windows-system-powershell.mjs";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    androidWindowsHiddenLauncherScript,
    materializeAndroidWindowsHiddenLauncher,
    removeAndroidWindowsHiddenLauncher,
    scheduleAndroidWindowsHiddenLauncherCleanup,
} from "@ccc/device-lab/providers/backends/android.mjs";

const rollbackBinding = vi.hoisted(() => ({
    terminate: undefined as undefined | ((child: ChildProcess) => Promise<{ok: boolean; exited: boolean; [key: string]: unknown}>),
}));
vi.mock("@ccc/device-lab/providers/application/lifecycle/android-emulator-lifecycle.mjs", async original => {
    const actual = await original<typeof import("@ccc/device-lab/providers/application/lifecycle/android-emulator-lifecycle.mjs")>();
    return {...actual, createAndroidEmulatorLifecycle: (ports: Parameters<typeof actual.createAndroidEmulatorLifecycle>[0]) => {
        rollbackBinding.terminate = ports.terminateFreshAndroidEmulatorProcessTree;
        return actual.createAndroidEmulatorLifecycle(ports);
    }};
});
vi.mock("@ccc/device-lab/providers/commands.mjs", async original => ({...await original<typeof import("@ccc/device-lab/providers/commands.mjs")>()}));
vi.mock("@ccc/device-lab/providers/state/windows-system-powershell.mjs", async original => ({...await original<typeof import("@ccc/device-lab/providers/state/windows-system-powershell.mjs")>()}));

describe("device-lab MCP direct Android Windows launcher", () => {
    let home: string;
    let originalHomeRestore: (() => void) | undefined;

    beforeEach(() => {

        home = mkdtempSync(join(tmpdir(), "ccc-android-launcher-"));
        originalHomeRestore = isolateDeviceLabTestEnvironment(home);
    });

    afterEach(() => {
        vi.useRealTimers();
        originalHomeRestore?.();
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
        directorySymlink(external, join(home, ".ccc"));

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


describe("direct Android fresh Windows rollback bounds", () => {
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

    function rollbackFixture(options: {status?: number; resolverElapsed?: number; commandElapsed?: number} = {}) {
        vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
        let now = 0, settled = false;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        const executable = "C:\\Windows\\System32\\taskkill.exe";
        const resolveExecutable = vi.spyOn(nativeWindows, "canonicalWindowsSystemExecutablePath").mockImplementation(() => {
            now += options.resolverElapsed ?? 0; return executable;
        });
        const run = vi.spyOn(nativeCommands, "run").mockImplementation(() => {
            now += options.commandElapsed ?? 0;
            return {status: options.status ?? 0, stdout: "", stderr: "", signal: null, pid: 0, output: [null, "", ""]};
        });
        const child = Object.assign(new EventEmitter(), {pid: 424242, exitCode: null as number | null, signalCode: null as string | null});
        return {
            child, run, resolveExecutable, executable,
            setNow: (milliseconds: number) => { now = milliseconds; },
            settled: () => settled,
            start: () => {
                if (!rollbackBinding.terminate) throw new Error("Native Android rollback was not composed");
                return rollbackBinding.terminate(child as unknown as ChildProcess).finally(() => { settled = true; });
            },
        };
    }

    it.each([0, 1])("does not extend exit grace when native tree termination returns status %s immediately", async status => {
        const f = rollbackFixture({status}), pending = f.start();
        expect(f.resolveExecutable).toHaveBeenCalledExactlyOnceWith("taskkill.exe");
        expect(f.run).toHaveBeenCalledExactlyOnceWith(f.executable, ["/PID", String(f.child.pid), "/T", "/F"], {timeout: 10_000});
        f.setNow(2999); await vi.advanceTimersByTimeAsync(2999);
        expect(f.settled()).toBe(false);
        f.setNow(3000); await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ok: false, exited: false, status});
        expect(f.child.listenerCount("close")).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });

    it.each([2999, 3000])("qualifies the exact child close at elapsed %s against the exit phase", async elapsed => {
        const f = rollbackFixture(), pending = f.start();
        expect(f.settled()).toBe(false);
        f.setNow(elapsed); f.child.emit("close", 0, null);
        expect(await pending).toMatchObject({ok: elapsed < 3000, exited: elapsed < 3000});
        expect(f.child.listenerCount("close")).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });

    it("caps both the native command and exit observation at the original aggregate ceiling", async () => {
        const f = rollbackFixture({resolverElapsed: 12_000, commandElapsed: 500}), pending = f.start();
        expect(f.run).toHaveBeenCalledExactlyOnceWith(f.executable, ["/PID", String(f.child.pid), "/T", "/F"], {timeout: 1000});
        f.setNow(12_999); await vi.advanceTimersByTimeAsync(499);
        expect(f.settled()).toBe(false);
        f.setNow(13_000); f.child.emit("close", 0, null);
        expect(await pending).toMatchObject({ok: false, exited: false});
        expect(f.child.listenerCount("close")).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });

    it("never dispatches a PID-addressed tree command after its exact child has already ended", async () => {
        const f = rollbackFixture(); f.child.exitCode = 0;
        expect(await f.start()).toMatchObject({ok: false, exited: true, reason: "fresh-root-exited-before-tree-cleanup"});
        expect(f.run).not.toHaveBeenCalled();
        expect(f.child.listenerCount("close")).toBe(0); expect(vi.getTimerCount()).toBe(0);
    });
});
