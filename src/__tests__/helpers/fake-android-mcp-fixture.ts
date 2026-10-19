import { nodeProviderFixturePreloadSource } from "./node-provider-fixture.js";
import { fakeAndroidProviderScript, fakeAndroidLauncherPreloadSource } from "./fake-android-provider-script.js";
import { deviceLabTestHomeEnvironment } from "./device-lab-test-environment.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { installDefaultImplicitBroker, repoRoot, TIMEOUT } from "./device-lab-mcp-fixture.js";

export { TIMEOUT };

export interface FakeAndroidMcpContext {
    client: Client;
    homeDir: string;
    binDir: string;
    logPath: string;
}

export async function createFakeAndroidMcpContext(options: { platform?: "win32"; entrypoint?: string } = {}): Promise<FakeAndroidMcpContext> {
    let client: Client | undefined;
    let homeDir = "";
    let binDir = "";
    let logPath = "";
        homeDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-device-lab-android-home-")));
        binDir = realpathSync.native(mkdtempSync(join(tmpdir(), "ccc-device-lab-android-bin-")));
        logPath = join(homeDir, "fake-android.log");
        writeFileSync(logPath, "");
        const imageDir = join(homeDir, "Android", "Sdk", "system-images", "android-35", "google_apis", "x86_64");
        mkdirSync(imageDir, { recursive: true });
        writeFileSync(join(imageDir, "system.img"), "fixture image");
        for (const serial of ["R5CREAL123", "192.168.1.50:5555", "192.168.1.60:5555", "R5LEASED999"]) {
            writeFileSync(join(homeDir, `fake-adb-active-${encodeURIComponent(serial)}`), "1");
        }
        // The initial host emulator is an explicit member of this SDK world;
        // inventory and console identity disappear together after a real kill.
        writeFileSync(join(homeDir, "fake-adb-active-emulator-5554"), "host_pixel");

        for (const name of ["emulator", "adb", "avdmanager"]) {
            const path = join(binDir, name);
            writeFileSync(path, `#!${process.execPath}\nconst tool = ${JSON.stringify(name)};\n${fakeAndroidProviderScript}`);
            chmodSync(path, 0o755);
        }
        const preload = join(homeDir, "node-provider-routing.cjs");
        writeFileSync(preload, nodeProviderFixturePreloadSource(binDir) + fakeAndroidLauncherPreloadSource(binDir)
            + (options.platform ? `\nObject.defineProperty(process, "platform", { value: ${JSON.stringify(options.platform)} });\n` : ""));

        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [options.entrypoint || join(repoRoot, "device-lab-mcp/server.mjs")],
            env: {
                ...deviceLabTestHomeEnvironment(homeDir),
                PATH: binDir,
                NODE_ENV: "test",
                NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
                FAKE_ANDROID_LOG: logPath,
            },
        });

        client = new Client(
            { name: "ccc-device-lab-android-fake-client", version: "1.0.0" },
            { capabilities: {} },
        );

        await client.connect(transport);
        installDefaultImplicitBroker(client, false);
    if (!client) throw new Error("fake Android MCP client was not created");
    return { client, homeDir, binDir, logPath };
}

export async function cleanupFakeAndroidMcpContext(context: FakeAndroidMcpContext | undefined) {
    if (!context) return;
    await context.client.close();
    rmSync(context.homeDir, { recursive: true, force: true });
    rmSync(context.binDir, { recursive: true, force: true });
}
