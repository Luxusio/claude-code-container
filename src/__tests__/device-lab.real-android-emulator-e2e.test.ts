import { describe, expect, it } from "vitest";
import {
    androidEmulatorE2ECapability,
    runAndroidEmulatorE2E,
} from "../../scripts/real-tests/android-emulator-e2e.mjs";
import { androidBackend } from "../../device-lab-mcp/src/backends/android.mjs";

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const cap = androidEmulatorE2ECapability(level);
const title = cap.available
    ? `creates, boots, drives, screenshots, stops, and deletes Android emulator ADB E2E (${cap.systemImage.package})`
    : `skips Android emulator ADB E2E (${cap.reason})`;

describe.runIf(level >= 2)("level 2 real Android emulator ADB E2E", () => {
    it.skipIf(!cap.available)(title, async () => {
        const result = await runAndroidEmulatorE2E({ level, bootTimeoutMs: 180000 });
        expect(result).toEqual(expect.objectContaining({ status: "PASS" }));
        expect(result).toEqual(expect.objectContaining({
            systemImage: cap.systemImage.package,
            port: expect.any(Number),
            appArtifact: "verified",
            appPermission: "verified",
            verifiedCapabilities: expect.arrayContaining(androidBackend().capabilities.filter((tool) => ![
                "mobile_power",
                "mobile_set_network",
                "mobile_toggle_airplane_mode",
            ].includes(tool))),
        }));
    }, 240000);
});
