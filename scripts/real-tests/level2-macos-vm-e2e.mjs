import { runMacosVmE2E } from "./macos-vm-e2e.mjs";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.mjs";

export const name = "level 2 macOS VM Tart E2E";

export async function run() {
    return runProviderMcpMatrix(runMacosVmE2E, {}, {
        source: "macOS VM source MCP",
        packaged: "macOS VM packaged MCP",
    });
}
