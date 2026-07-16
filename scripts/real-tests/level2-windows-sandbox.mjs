import { runWindowsSandboxE2E } from "./windows-sandbox-e2e.mjs";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.mjs";

export const name = "level 2 Windows Sandbox helper E2E";

export async function run() {
    return runProviderMcpMatrix(runWindowsSandboxE2E, {}, {
        source: "Windows Sandbox source MCP",
        packaged: "Windows Sandbox packaged MCP",
    });
}
