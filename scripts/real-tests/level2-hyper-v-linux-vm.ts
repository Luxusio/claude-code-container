import { runHyperVLinuxVmE2E } from "./hyper-v-linux-vm-e2e.ts";
import { runProviderMcpMatrix } from "./provider-mcp-matrix.ts";

export const name = "level 2 Hyper-V Linux VM E2E";

export async function run() {
    return runProviderMcpMatrix(runHyperVLinuxVmE2E, {}, {
        packaged: "Hyper-V Linux VM packaged MCP",
    });
}
