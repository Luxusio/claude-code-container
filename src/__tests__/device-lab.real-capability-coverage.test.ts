import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { androidBackend } from "../../device-lab-mcp/src/backends/android.mjs";
import { androidRealBackend } from "../../device-lab-mcp/src/backends/android-device.mjs";
import { windowsBackend } from "../../device-lab-mcp/src/backends/windows-sandbox.mjs";
import { androidDeviceE2ECapability, androidDevicePayload, androidDeviceReportedPathMatches, androidDeviceStartSucceeded, androidDeviceStatusCommand, androidDeviceStopPreservedPhysicalDevice } from "../../scripts/real-tests/android-device-e2e.mjs";
import {
    ANDROID_APP_FIXTURE_PACKAGE,
    ANDROID_APP_FIXTURE_PERMISSION,
    ANDROID_APP_FIXTURE_SHA256,
    materializeAndroidAppFixture,
} from "../../scripts/real-tests/android-app-fixture.mjs";

function scriptedToolCalls(relativePath: string) {
    const source = readFileSync(join(process.cwd(), relativePath), "utf-8");
    return new Set([...source.matchAll(/callTool\(\s*["']([a-z][a-z0-9_]+)["']/g)].map((match) => match[1]));
}

describe("real provider capability coverage", () => {
    it.each([
        ["Android emulator", androidBackend().capabilities, "scripts/real-tests/android-emulator-e2e.mjs"],
        ["Android physical device", androidRealBackend().capabilities, "scripts/real-tests/android-device-e2e.mjs"],
        ["Windows Sandbox", windowsBackend().capabilities, "scripts/real-tests/windows-sandbox-e2e.mjs"],
    ])("keeps every advertised %s capability in its real E2E scenario", (_provider, capabilities, script) => {
        const calls = scriptedToolCalls(script as string);
        expect((capabilities as string[]).filter((tool) => !calls.has(tool))).toEqual([]);
    });

    it("allows broker-routed Android physical E2E when this process has no local adb", () => {
        const previousSerial = process.env.CCC_REAL_ANDROID_DEVICE_SERIAL;
        process.env.CCC_REAL_ANDROID_DEVICE_SERIAL = "broker-visible-device";
        try {
            expect(androidDeviceE2ECapability(2)).toEqual(expect.objectContaining({
                available: true,
                reason: "ready",
                serial: "broker-visible-device",
            }));
        } finally {
            if (previousSerial === undefined) delete process.env.CCC_REAL_ANDROID_DEVICE_SERIAL;
            else process.env.CCC_REAL_ANDROID_DEVICE_SERIAL = previousSerial;
        }
    });

    it("normalizes direct and broker-wrapped Android physical tool payloads", () => {
        const direct = { provider: "adb", status: 0 };
        expect(androidDevicePayload(direct)).toBe(direct);
        expect(androidDevicePayload({ ok: true, result: direct })).toBe(direct);
        expect(() => androidDevicePayload({
            ok: false,
            error: "device-lab-backend-tool-failed",
            body: { detail: "device-lab backend tool timed out after 30000ms" },
        })).toThrow("device-lab-backend-tool-failed: device-lab backend tool timed out after 30000ms");
    });

    it("normalizes direct and broker-routed Android physical status commands", () => {
        const command = { status: 0, stdout: "device" };
        expect(androidDeviceStatusCommand({ hostState: command })).toBe(command);
        expect(androidDeviceStatusCommand({ execution: { command } })).toBe(command);
    });

    it("accepts direct and broker-routed Android physical start success", () => {
        expect(androidDeviceStartSucceeded({ alreadyAttached: true })).toBe(true);
        expect(androidDeviceStartSucceeded({
            device: { status: "attached" },
            execution: { command: { status: 0, stdout: "device\r\n" } },
        })).toBe(true);
    });

    it("recognizes direct and broker-routed physical stop as non-powering", () => {
        expect(androidDeviceStopPreservedPhysicalDevice({ physicalDevicePoweredOff: false })).toBe(true);
        expect(androidDeviceStopPreservedPhysicalDevice({
            providerCommand: { mode: "noop" },
            execution: { command: { status: 0, stdout: "physical Android stop/delete does not power off or disconnect the real device" } },
        })).toBe(true);
        expect(androidDeviceStopPreservedPhysicalDevice({
            providerCommand: { mode: "exec" },
            execution: { command: { status: 0 } },
        })).toBe(false);
    });

    it("matches broker-reported Windows recording paths to the shared project artifact", () => {
        expect(androidDeviceReportedPathMatches("C:\\project\\results\\physical.mp4", "/project/results/physical.mp4")).toBe(true);
        expect(androidDeviceReportedPathMatches("/project/results/physical.mp4", "/project/results/physical.mp4")).toBe(true);
        expect(androidDeviceReportedPathMatches("C:\\project\\results\\other.mp4", "/project/results/physical.mp4")).toBe(false);
    });

    it("materializes the deterministic Android app fixture used by app capability tests", () => {
        const outputDir = mkdtempSync(join(tmpdir(), "ccc-android-fixture-test-"));
        try {
            const fixture = materializeAndroidAppFixture(outputDir);
            const apk = readFileSync(fixture.path);
            expect(apk.subarray(0, 2).toString("ascii")).toBe("PK");
            expect(createHash("sha256").update(apk).digest("hex")).toBe(ANDROID_APP_FIXTURE_SHA256);
            expect(fixture.packageName).toBe(ANDROID_APP_FIXTURE_PACKAGE);
            expect(fixture.permission).toBe(ANDROID_APP_FIXTURE_PERMISSION);
            expect(fixture.signatureSchemes).toEqual(["v1", "v2", "v3"]);
        } finally {
            rmSync(outputDir, { recursive: true, force: true });
        }
    });
});
