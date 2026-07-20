import { runMacosVmE2E } from "./macos-vm-e2e.ts";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.ts";

export const name = "level 2 macOS VM Tart E2E";

export async function run() {
    return runProviderMcpMatrix(runMacosVmE2E, {}, {
        source: "macOS VM source MCP",
        packaged: "macOS VM packaged MCP",
    });
}
