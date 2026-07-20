import { join } from "path";
import { repoRoot } from "./helpers.ts";
import { runBrokerE2E } from "./level2-broker-e2e.ts";

export const name = "level 2 packaged host broker MCP E2E";

export async function run() {
    return runBrokerE2E({
        name: "ccc-level2-packaged-host-broker-mcp-e2e",
        serverPath: join(repoRoot, "dist", "device-lab-mcp", "server.mjs"),
    });
}
