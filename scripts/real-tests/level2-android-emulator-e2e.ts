import { runAndroidEmulatorE2E } from "./android-emulator-e2e.ts";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.ts";

export const name = "level 2 Android emulator ADB E2E";

export async function run() {
    if (Number(process.env.CCC_TEST_LEVEL || "0") >= 3) {
        return { status: "SKIP", reason: "covered by the level 3 comprehensive Android emulator capability run" };
    }
    return runProviderMcpMatrix(runAndroidEmulatorE2E, {}, {
        source: "Android emulator source MCP",
        packaged: "Android emulator packaged MCP",
    });
}
