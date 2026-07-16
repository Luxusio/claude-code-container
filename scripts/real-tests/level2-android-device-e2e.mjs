import { run as runAndroidDeviceE2E } from "./android-device-e2e.mjs";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.mjs";

export const name = "level 2 Android physical device ADB E2E";

export async function run() {
    return runProviderMcpMatrix(runAndroidDeviceE2E, {}, {
        source: "Android physical source MCP",
        packaged: "Android physical packaged MCP",
    });
}
