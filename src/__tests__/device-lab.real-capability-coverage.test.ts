import { createHash } from "crypto";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { androidBackend } from "../../device-lab-mcp/src/backends/android.mjs";
import { windowsBackend } from "../../device-lab-mcp/src/backends/windows-sandbox.mjs";
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
        ["Windows Sandbox", windowsBackend().capabilities, "scripts/real-tests/windows-sandbox-e2e.mjs"],
    ])("keeps every advertised %s capability in its real E2E scenario", (_provider, capabilities, script) => {
        const calls = scriptedToolCalls(script as string);
        expect((capabilities as string[]).filter((tool) => !calls.has(tool))).toEqual([]);
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
        } finally {
            rmSync(outputDir, { recursive: true, force: true });
        }
    });
});
