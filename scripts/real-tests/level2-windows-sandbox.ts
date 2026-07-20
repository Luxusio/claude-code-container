import { runWindowsSandboxE2E } from "./windows-sandbox-e2e.ts";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.ts";

export const name = "level 2 Windows Sandbox helper E2E";

export async function run() {
    return runProviderMcpMatrix(runWindowsSandboxE2E, {}, {
        source: "Windows Sandbox source MCP",
        packaged: "Windows Sandbox packaged MCP",
    });
}
