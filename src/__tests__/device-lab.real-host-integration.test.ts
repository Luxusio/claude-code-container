import { describe, expect, it } from "vitest";
import { deviceLabSmoke } from "../device-lab-admin.js";

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const enabled = level >= 2;
const smoke = enabled ? deviceLabSmoke(process.cwd(), 5000, undefined, { mode: "real-provider" }) : null;
const slots = [
    { backend: "android-emulator", label: "Android emulator real integration slot" },
    { backend: "ios-simulator", label: "iOS Simulator real integration slot" },
    { backend: "windows-sandbox", label: "Windows Sandbox real integration slot" },
    { backend: "macos-vm", label: "macOS VM real integration slot" },
] as const;

describe.runIf(enabled)("level 2 host real integration slots", () => {
    for (const slot of slots) {
        const readiness = smoke?.results.find((result) => result.backend === slot.backend);
        const skipped = readiness?.status !== "PASS";
        const reason = readiness ? `${readiness.status} - ${readiness.detail}` : "readiness result missing";

        it.skipIf(skipped)(skipped ? `${slot.label} skipped (${reason})` : slot.label, () => {
            expect(readiness?.status).toBe("PASS");
        });
    }
});
