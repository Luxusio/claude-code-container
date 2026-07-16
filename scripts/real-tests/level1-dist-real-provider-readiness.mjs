import { runRealProviderReadiness } from "./level1-real-provider-readiness.mjs";
import { packagedDeviceLabMcpServer } from "./provider-mcp-matrix.mjs";

export const name = "level 1 packaged real-provider readiness";

export async function run() {
    return runRealProviderReadiness({
        mcpName: "ccc-packaged-real-provider-readiness",
        serverPath: packagedDeviceLabMcpServer,
    });
}
