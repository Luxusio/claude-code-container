import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const repoRoot = join(__dirname, "../../..");
export const TIMEOUT = 30000;

export interface DeviceLabMcpTestContext {
    client: Client;
    homeDir: string;
    pathDir: string;
    originalHome: string | undefined;
}

export async function createDeviceLabMcpTestContext(): Promise<DeviceLabMcpTestContext> {
    const originalHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-test-"));
    process.env.HOME = homeDir;
    const pathDir = join(homeDir, "bin");
    mkdirSync(pathDir, { recursive: true });
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(repoRoot, "device-lab-mcp/server.mjs")],
        env: {
            HOME: homeDir,
            PATH: pathDir,
            NODE_ENV: "test",
        },
    });

    const client = new Client(
        { name: "ccc-device-lab-test-client", version: "1.0.0" },
        { capabilities: {} },
    );

    await client.connect(transport);
    return { client, homeDir, pathDir, originalHome };
}

export async function cleanupDeviceLabMcpTestContext(context: DeviceLabMcpTestContext | undefined) {
    if (!context) return;
    await context?.client.close();
    rmSync(context.homeDir, { recursive: true, force: true });
    if (context.originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = context.originalHome;
}
