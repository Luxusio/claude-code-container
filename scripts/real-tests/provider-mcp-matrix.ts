import { join } from "path";
import { repoRoot } from "./helpers.ts";
import { aggregateStepResult } from "./result-status.ts";

export const packagedDeviceLabMcpServer = join(repoRoot, "dist", "device-lab-mcp", "server.mjs");

export function providerMcpSessionOptions(options: any = {}, defaultName: string) {
    return {
        name: options.mcpName || defaultName,
        ...(options.serverPath ? { serverPath: options.serverPath } : {}),
    };
}

function matrixSteps(label, result) {
    if (!Array.isArray(result?.steps)) {
        return [{ name: label, status: result?.status || "FAIL", reason: result?.reason, detail: result?.detail }];
    }
    return result.steps.map((step) => ({ ...step, name: `${label}: ${step.name}` }));
}

export async function runProviderMcpMatrix(runScenario: (options: any) => Promise<any>, options: any = {}, labels: any = {}) {
    const packaged = await runScenario({
        ...options,
        serverPath: packagedDeviceLabMcpServer,
        mcpName: labels.packagedMcpName || "ccc-real-provider-packaged-mcp-e2e",
    });
    const steps = [
        ...matrixSteps(labels.packaged || "packaged MCP", packaged),
    ];
    return {
        ...aggregateStepResult(steps),
        steps,
    };
}
