import { runIosRealDeviceE2E, runIosSimulatorE2E } from "./ios-e2e.mjs";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.mjs";
import { aggregateStepResult } from "./result-status.mjs";

export const name = "level 2 iOS provider E2E";

export async function run() {
    const simulator = await runProviderMcpMatrix(runIosSimulatorE2E, {}, {
        source: "iOS Simulator source MCP",
        packaged: "iOS Simulator packaged MCP",
    });
    const realDevice = await runProviderMcpMatrix(runIosRealDeviceE2E, {}, {
        source: "iOS physical source MCP",
        packaged: "iOS physical packaged MCP",
    });
    const steps = [
        { name: "iOS Simulator E2E", status: simulator.status, reason: simulator.reason, detail: simulator.detail },
        { name: "iOS real-device E2E", status: realDevice.status, reason: realDevice.reason, detail: realDevice.detail },
    ];
    return { ...aggregateStepResult(steps), steps };
}
