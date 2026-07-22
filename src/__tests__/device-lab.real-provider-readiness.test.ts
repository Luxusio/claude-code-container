import { describe, expect, it } from "vitest";
import { deviceLabSmoke } from "../device-lab-admin.js";

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const enabled = level >= 1;
const lifecycleCommandPattern = /\b(start|run|launch|boot|delete|stop|shutdown)\b/i;
const expectedBackends = [
    { backend: "android-emulator", label: "Android emulator" },
    { backend: "android-device", label: "Android physical device" },
    { backend: "ios-simulator", label: "iOS Simulator" },
    { backend: "ios-device", label: "iOS physical device" },
    { backend: "windows-sandbox", label: "Windows Sandbox" },
    { backend: "windows-vm", label: "Hyper-V Windows VM" },
    { backend: "linux-vm", label: "Hyper-V Linux VM" },
    { backend: "macos-vm", label: "macOS VM" },
] as const;
const smoke = enabled ? deviceLabSmoke(process.cwd(), 5000, undefined, { mode: "real-provider" }) : null;

function commandArgsText(command: string): string {
    const firstSpace = command.indexOf(" ");
    return firstSpace === -1 ? "" : command.slice(firstSpace + 1);
}

describe.runIf(enabled)("level 1 real-provider readiness", () => {
    it("reports the expected backend readiness matrix", () => {
        expect(smoke?.mode).toBe("real-provider");
        expect(smoke?.results.map((result) => result.backend).sort()).toEqual(expectedBackends.map((item) => item.backend).sort());
    });

    for (const item of expectedBackends) {
        const result = smoke?.results.find((candidate) => candidate.backend === item.backend);
        const skipped = result?.status === "SKIP";
        const title = skipped
            ? `${item.label} readiness skipped (${result.detail})`
            : `${item.label} readiness`;

        it.skipIf(skipped)(title, () => {
            expect(result).toBeDefined();
            expect(result?.status).toBe("PASS");
            for (const command of result?.commands || []) {
                expect(commandArgsText(command.command)).not.toMatch(lifecycleCommandPattern);
            }
        });
    }
});
