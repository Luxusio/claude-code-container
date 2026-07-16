import { androidEmulatorE2ECapability, runAndroidEmulatorE2E } from "./android-emulator-e2e.mjs";
import { macosVmE2ECapability, runMacosVmE2E } from "./macos-vm-e2e.mjs";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.mjs";
import { aggregateStepResult } from "./result-status.mjs";

export const name = "level 3 destructive provider E2E";

export async function run() {
    const android = androidEmulatorE2ECapability(3);
    const macos = macosVmE2ECapability(3);
    const steps = [];
    const androidResult = android.available
        ? await runProviderMcpMatrix(runAndroidEmulatorE2E, { level: 3, destructive: true }, {
            source: "Android destructive source MCP",
            packaged: "Android destructive packaged MCP",
        })
        : { status: "SKIP", reason: android.reason };
    steps.push({ name: "Android emulator destructive controls E2E", status: androidResult.status, reason: androidResult.reason, detail: androidResult.detail });
    const macosResult = macos.available
        ? await runProviderMcpMatrix(runMacosVmE2E, { level: 3, snapshot: true, imageTools: true }, {
            source: "macOS destructive source MCP",
            packaged: "macOS destructive packaged MCP",
        })
        : { status: "SKIP", reason: macos.reason };
    steps.push({ name: "macOS VM snapshot E2E", status: macosResult.status, reason: macosResult.reason, detail: macosResult.detail });
    return { ...aggregateStepResult(steps), steps };
}
