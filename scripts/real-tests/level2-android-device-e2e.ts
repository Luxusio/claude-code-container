import { run as runAndroidDeviceE2E } from "./android-device-e2e.ts";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.ts";

export const name = "level 2 Android physical device ADB E2E";

export async function run() {
    return runProviderMcpMatrix(runAndroidDeviceE2E, {}, {
        source: "Android physical source MCP",
        packaged: "Android physical packaged MCP",
    });
}
