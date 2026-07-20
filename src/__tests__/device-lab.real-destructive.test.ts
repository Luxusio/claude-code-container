import { describe, expect, it } from "vitest";
import {
    androidEmulatorE2ECapability,
    runAndroidEmulatorE2E,
} from "../../scripts/real-tests/android-emulator-e2e.ts";
import {
    macosVmE2ECapability,
    runMacosVmE2E,
} from "../../scripts/real-tests/macos-vm-e2e.ts";

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const androidCap = androidEmulatorE2ECapability(level);
const macosCap = macosVmE2ECapability(level);
const androidDestructiveEnabled = level >= 3 && androidCap.available;
const macosDestructiveEnabled = level >= 3 && macosCap.available;

describe.runIf(level >= 3)("level 3 destructive and physical-device integration", () => {
    it.skipIf(!androidDestructiveEnabled)(
        androidDestructiveEnabled
            ? `drives destructive Android emulator controls on an owned disposable emulator (${androidCap.systemImage.package})`
            : `skips destructive Android emulator controls E2E (${androidCap.reason})`,
        async () => {
            const result = await runAndroidEmulatorE2E({ level, bootTimeoutMs: 180000, destructive: true });
            expect(result).toEqual(expect.objectContaining({
                status: "PASS",
                systemImage: androidCap.systemImage.package,
            }));
        },
        240000,
    );

    it.skipIf(!macosDestructiveEnabled)(
        macosDestructiveEnabled
            ? `creates and deletes an extra Tart snapshot clone for a disposable macOS VM (${macosCap.source})`
            : `skips destructive macOS VM snapshot E2E (${macosCap.reason})`,
        async () => {
            const result = await runMacosVmE2E({ level, snapshot: true });
            expect(result).toEqual(expect.objectContaining({
                status: "PASS",
                provider: "tart",
                snapshot: true,
            }));
        },
        1200000,
    );
});
