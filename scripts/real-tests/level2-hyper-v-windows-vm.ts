import { runHyperVWindowsVmE2E } from "./hyper-v-windows-vm-e2e.ts";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.ts";

export const name = "level 2 Hyper-V Windows VM E2E";

export async function run() {
    return runProviderMcpMatrix(runHyperVWindowsVmE2E, {}, {
        packaged: "Hyper-V Windows VM packaged MCP",
    });
}
