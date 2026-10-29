import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { deviceLabTestHomeEnvironment, isolateDeviceLabTestEnvironment } from "./device-lab-test-environment.js";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { createRequire } from "node:module";
import { tmpdir } from "os";
import { basename, dirname, join, resolve } from "path";
import {pathToFileURL} from "node:url";
import { createBrokerApiClient } from "../../../scripts/real-tests/broker-api-client.js";
import { copyWritableTestTree } from "./writable-test-copy.js";

const fixtureRequire = createRequire(import.meta.url);
function installedDependencyRoot(specifier: string, packageName: string): string {
    let directory = dirname(fixtureRequire.resolve(specifier));
    while (true) {
        try {
            if (JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).name === packageName) return directory;
        } catch { /* Continue through nested package boundaries. */ }
        const parent = dirname(directory);
        if (parent === directory) throw new Error(`Fixture dependency root not found: ${packageName}`);
        directory = parent;
    }
}

const clientBrokerModules = new WeakMap<Client, string>();
const clientEnvironments = new WeakMap<Client, NodeJS.ProcessEnv>();
const internalClients = new WeakMap<Client, ReturnType<typeof createBrokerApiClient>>();
export function callInternalBroker(client: Client, request: { operation: string; arguments?: Record<string, unknown> }) {
    const env = clientEnvironments.get(client);
    if (!env) throw new Error("Internal broker fixture requires an isolated client environment");
    let internal = internalClients.get(client);
    if (!internal) { internal = createBrokerApiClient(env, clientBrokerModules.get(client)); internalClients.set(client, internal); }
    return internal.call(request.operation, request.arguments || {});
}

export const repoRoot = join(__dirname, "../../..");
export const TIMEOUT = 30000;

export function expectedDeviceLabMcpOwnerBasis(cwd = repoRoot, profile?: string): string {
    const resolved = resolve(cwd);
    const name = basename(resolved).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const hash = createHash("sha256").update(resolved).digest("hex").slice(0, 12);
    const projectId = /^\/project\/[a-z0-9-]{0,255}-[a-f0-9]{12}$/.test(cwd)
        ? cwd.slice("/project/".length) : `${name}-${hash}`;
    const containerName = profile ? `ccc-${projectId}--p--${profile}` : `ccc-${projectId}`;
    return `${containerName}:/project/${projectId}`;
}

export interface DeviceLabMcpTestContext {
    client: Client;
    homeDir: string;
    pathDir: string;
    originalHome: string | undefined;
    restoreEnvironment: () => void;
}

export interface DeviceLabMcpTestContextOptions {
    env?: Record<string, string>;
    setupHome?: (homeDir: string) => void;
    defaultImplicitBroker?: boolean;
    rawPublicCalls?: boolean;
    isolatedLauncher?: boolean;
    serverPath?: string;
    /** Bind the internal lifecycle worker to its produced API, independently of the public server entry. */
    internalBrokerModuleUrl?: string;
}

export function installDefaultImplicitBroker(client: Client, value: boolean) {
    const originalCallTool = client.callTool.bind(client);
    client.callTool = ((request: Parameters<Client["callTool"]>[0], ...rest: Parameters<Client["callTool"]> extends [unknown, ...infer R] ? R : never) => {
        const args = request && typeof request === "object" && request.arguments && typeof request.arguments === "object"
            ? request.arguments as Record<string, unknown>
            : {};
        const hasRouteDecision = "broker" in args || "viaBroker" in args || "implicitBroker" in args || "autolaunch" in args;
        // Provider/routing suites inspect diagnostic contracts. Public-output suites
        // override detail:false (or use a raw client) to exercise the minimal surface.
        const nextRequest = { ...request, arguments: {
            detail: true,
            ...args,
            ...(!hasRouteDecision ? { implicitBroker: value } : {}),
        } };
        return originalCallTool(nextRequest, ...rest);
    }) as Client["callTool"];
}

export async function createDeviceLabMcpTestContext(options: DeviceLabMcpTestContextOptions = {}): Promise<DeviceLabMcpTestContext> {
    const originalHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-test-"));
    const restoreEnvironment = isolateDeviceLabTestEnvironment(homeDir);
    const pathDir = join(homeDir, "bin");
    mkdirSync(pathDir, { recursive: true });
    // A container's real owner credential must not override these synthetic
    // owners. Redirect only the conventional mount; validation stays enabled.
    const preload = join(homeDir, "isolate-broker-auth.cjs");
    const absentMount = join(homeDir, "absent-conventional-mount");
    writeFileSync(preload, `const fs=require('fs');const root=${JSON.stringify(absentMount)};for(const key of ['existsSync','lstatSync','openSync']){const original=fs[key];fs[key]=function(file,...args){const path=String(file).replaceAll('\\\\','/').replace(/^[A-Za-z]:/,'');const mount='/run/ccc-device-broker-auth';return original.call(fs,path===mount||path.startsWith(mount+'/')?root+path.slice(mount.length):file,...args)}}require('module').syncBuiltinESMExports();`);
    let serverPath = options.serverPath || join(repoRoot, "device-lab-mcp/server.mjs");
    let brokerModuleUrl: string | undefined;
    if (options.isolatedLauncher) {
        const fixtureRoot = join(homeDir, "adapter");
        const dependencies = join(fixtureRoot, "node_modules");
        copyWritableTestTree(join(repoRoot, "device-lab-mcp"), fixtureRoot, {recursive:true,
            filter: path => !path.split(/[\\/]/).includes("node_modules") && !path.split(/[\\/]/).includes("dist")});
        const core = join(dependencies, "@ccc/device-lab");
        copyWritableTestTree(join(repoRoot, "packages/device-lab"), core, {recursive:true,
            filter: path => !path.split(/[\\/]/).includes("node_modules")});
        symlinkSync(installedDependencyRoot("pngjs", "pngjs"), join(dependencies, "pngjs"), "junction");
        symlinkSync(join(repoRoot, "packages/hyper-v"), join(dependencies, "@ccc/hyper-v"), "junction");
        mkdirSync(join(dependencies, "@modelcontextprotocol"), {recursive:true});
        symlinkSync(installedDependencyRoot("@modelcontextprotocol/sdk/server/index.js", "@modelcontextprotocol/sdk"), join(dependencies, "@modelcontextprotocol/sdk"), "junction");
        const entry = join(core, "dist/broker-entry.js");
        writeFileSync(join(core, "dist/real-broker-entry.js"), readFileSync(entry));
        writeFileSync(entry, `import {createRequire} from 'node:module';import {existsSync,readFileSync} from 'node:fs';
const require=createRequire(import.meta.url);const fake=${JSON.stringify(join(pathDir,"ccc"))};
if(existsSync(fake)){eval(readFileSync(fake,'utf8').replace(/^#![^\\n]*\\n/,''));}else{await import('./real-broker-entry.js');}`);
        serverPath = join(fixtureRoot, "server.mjs");
        brokerModuleUrl = pathToFileURL(join(fixtureRoot, "src/broker.mjs")).href;
    }
    options.setupHome?.(homeDir);
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [serverPath],
        env: {
            ...deviceLabTestHomeEnvironment(homeDir),
            PATH: pathDir,
            NODE_ENV: "test",
            NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
            CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER: "1",
            ...options.env,
        },
    });

    const client = new Client(
        { name: "ccc-device-lab-test-client", version: "1.0.0" },
        { capabilities: {} },
    );

    try {
        await client.connect(transport);
    } catch (error) {
        await client.close().catch(() => {});
        restoreEnvironment();
        rmSync(homeDir, { recursive: true, force: true });
        throw error;
    }
    const internalBrokerModuleUrl = options.internalBrokerModuleUrl || brokerModuleUrl;
    if (internalBrokerModuleUrl) clientBrokerModules.set(client, internalBrokerModuleUrl);
    clientEnvironments.set(client, {
        ...deviceLabTestHomeEnvironment(homeDir), PATH: pathDir, NODE_ENV: "test",
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
        CCC_DEVICE_LAB_TEST_ALLOW_UNVERIFIED_BROKER: "1", ...options.env,
    });
    const defaultImplicitBroker = options.defaultImplicitBroker ?? false;
    if (!options.rawPublicCalls) installDefaultImplicitBroker(client, defaultImplicitBroker);
    return { client, homeDir, pathDir, originalHome, restoreEnvironment };
}

export async function cleanupDeviceLabMcpTestContext(context: DeviceLabMcpTestContext | undefined) {
    if (!context) return;
    try {
        await internalClients.get(context.client)?.close();
        await context.client.close();
    } finally {
        context.restoreEnvironment();
        rmSync(context.homeDir, { recursive: true, force: true });
    }
}
