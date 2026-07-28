import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { basename, join, resolve } from "path";

export const repoRoot = join(__dirname, "../../..");
export const TIMEOUT = 30000;

export function expectedDeviceLabMcpOwnerBasis(cwd = repoRoot, profile?: string): string {
    const resolved = resolve(cwd);
    const name = basename(resolved).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    const projectId = `${name}-${hash}`;
    const containerName = profile ? `ccc-${projectId}--p--${profile}` : `ccc-${projectId}`;
    return `${containerName}:/project/${projectId}`;
}

export interface DeviceLabMcpTestContext {
    client: Client;
    homeDir: string;
    pathDir: string;
    originalHome: string | undefined;
}

export interface DeviceLabMcpTestContextOptions {
    env?: Record<string, string>;
    setupHome?: (homeDir: string) => void;
    defaultImplicitBroker?: boolean;
}

export function installDefaultImplicitBroker(client: Client, value: boolean) {
    const originalCallTool = client.callTool.bind(client);
    client.callTool = ((request: Parameters<Client["callTool"]>[0], ...rest: Parameters<Client["callTool"]> extends [unknown, ...infer R] ? R : never) => {
        const args = request && typeof request === "object" && request.arguments && typeof request.arguments === "object"
            ? request.arguments as Record<string, unknown>
            : {};
        const hasRouteDecision = "broker" in args || "viaBroker" in args || "implicitBroker" in args || "autolaunch" in args;
        const nextRequest = hasRouteDecision
            ? request
            : { ...request, arguments: { ...args, implicitBroker: value } };
        return originalCallTool(nextRequest, ...rest);
    }) as Client["callTool"];
}

export async function createDeviceLabMcpTestContext(options: DeviceLabMcpTestContextOptions = {}): Promise<DeviceLabMcpTestContext> {
    const originalHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-test-"));
    process.env.HOME = homeDir;
    const pathDir = join(homeDir, "bin");
    mkdirSync(pathDir, { recursive: true });
    options.setupHome?.(homeDir);
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [join(repoRoot, "device-lab-mcp/server.mjs")],
        env: {
            HOME: homeDir,
            PATH: pathDir,
            NODE_ENV: "test",
            CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER: "1",
            ...options.env,
        },
    });

    const client = new Client(
        { name: "ccc-device-lab-test-client", version: "1.0.0" },
        { capabilities: {} },
    );

    await client.connect(transport);
    const defaultImplicitBroker = options.defaultImplicitBroker ?? false;
    if (typeof defaultImplicitBroker === "boolean") installDefaultImplicitBroker(client, defaultImplicitBroker);
    return { client, homeDir, pathDir, originalHome };
}

export async function cleanupDeviceLabMcpTestContext(context: DeviceLabMcpTestContext | undefined) {
    if (!context) return;
    await context?.client.close();
    rmSync(context.homeDir, { recursive: true, force: true });
    if (context.originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = context.originalHome;
}
