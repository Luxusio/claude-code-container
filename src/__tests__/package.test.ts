import { execFileSync, spawn } from "child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

const repoRoot = join(__dirname, "../..");
const HIDDEN_LEGACY_TRANSPORT_KEYS = new Set([
    "broker",
    "viaBroker",
    "implicitBroker",
    "autolaunch",
    "hostCandidates",
    "launchHost",
    "port",
    "brokerPort",
    "timeoutMs",
    "rpcTimeoutMs",
    "launchTimeoutMs",
]);

function schemaProperties(inputSchema: unknown): Record<string, unknown> {
    return ((inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties || {}) as Record<string, unknown>;
}

describe("npm package contents", () => {
    it("locks a reproducible, patched Appium broker runtime", () => {
        const manifest = JSON.parse(readFileSync(join(repoRoot, "device-lab-mcp", "package.json"), "utf-8")) as {
            dependencies?: Record<string, string>;
        };
        const lock = JSON.parse(readFileSync(join(repoRoot, "device-lab-mcp", "package-lock.json"), "utf-8")) as {
            packages?: Record<string, { version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
        };
        const packages = lock.packages || {};

        expect(manifest.dependencies).toEqual(expect.objectContaining({
            "@modelcontextprotocol/sdk": "^1.29.0",
            appium: "^3.5.2",
            "appium-uiautomator2-driver": "^8.1.0",
            "appium-xcuitest-driver": "^11.17.6",
        }));
        expect(packages[""]?.dependencies).toEqual(manifest.dependencies);
        expect(packages["node_modules/appium"]?.version).toBe("3.5.2");
        expect(packages["node_modules/appium-uiautomator2-driver"]?.version).toBe("8.1.0");
        expect(packages["node_modules/appium-xcuitest-driver"]?.version).toBe("11.17.6");
        expect(packages["node_modules/@appium/base-driver"]?.version).toBe("10.7.1");
        expect(packages["node_modules/@appium/support"]?.version).toBe("7.2.5");
        expect(packages["node_modules/form-data"]?.version).toBe("4.0.6");
        expect(packages["node_modules/morgan"]?.version).toBe("1.11.0");

        const sharpVersion = packages["node_modules/sharp"]?.version;
        expect(sharpVersion).toBe("0.35.1");
        for (const [dependency, version] of Object.entries(packages["node_modules/sharp"]?.optionalDependencies || {})) {
            expect(packages[`node_modules/${dependency}`]?.version, `${dependency} must match sharp's locked optional dependency`).toBe(version);
        }
    });

    it("ships the postinstall script referenced by package.json", () => {
        const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")) as {
            scripts?: Record<string, string>;
            engines?: Record<string, string>;
        };
        expect(pkg.scripts?.postinstall).toBe("node scripts/install.js --postinstall");
        expect(pkg.scripts?.test).toBe("node scripts/run-vitest.mjs run");
        expect(pkg.scripts?.["test:watch"]).toBe("node scripts/run-vitest.mjs");
        expect(pkg.engines?.node).toBe(">=20.19.0");

        const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
            cwd: repoRoot,
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        const [pack] = JSON.parse(out) as Array<{
            files: Array<{ path: string }>;
        }>;
        const files = new Set(pack.files.map((file) => file.path));

        expect(files).toContain("scripts/install.js");
        expect(files).toContain("dist/index.js");
        expect(files).toContain("dist/x11-mcp/server.mjs");
        expect(files).toContain("dist/device-lab-mcp/server.mjs");
        expect(files).not.toContain("dist/lab-mcp/server.mjs");
        expect(files).toContain("Dockerfile");
        expect(files).toContain("Containerfile");
        expect(files).toContain("x11-mcp/package.json");
        expect(files).toContain("x11-mcp/package-lock.json");
        expect(files).toContain("x11-mcp/server.mjs");
        expect(files).toContain("device-lab-mcp/package.json");
        expect(files).toContain("device-lab-mcp/package-lock.json");
        expect(files).toContain("device-lab-mcp/server.mjs");
        expect(files).toContain("device-lab-mcp/src/server.mjs");
        expect(files).toContain("device-lab-mcp/src/tools.mjs");
        expect(files).toContain("device-lab-mcp/src/backends/android.mjs");
        expect(files).toContain("device-lab-mcp/src/backends/android-device.mjs");
        expect(files).toContain("device-lab-mcp/src/backends/ios-simulator.mjs");
        expect(files).toContain("device-lab-mcp/src/backends/ios-device.mjs");
        expect(files).toContain("device-lab-mcp/src/backends/windows-sandbox.mjs");
        expect(files).toContain("device-lab-mcp/src/backends/macos-vm.mjs");
        expect(files).toContain("device-lab-mcp/src/backends/linux-vm.mjs");
        expect(files).toContain("device-lab-mcp/src/state/ios-state.mjs");
        expect(files).toContain("device-lab-mcp/src/state/macos-state.mjs");
        expect(files).toContain("device-lab-mcp/src/state/ios-device-state.mjs");
        expect(files).toContain("device-lab-mcp/src/state/physical-lease-store.mjs");
        expect(files).toContain("device-lab-mcp/src/display/x11.mjs");
        expect(files).toContain("scripts/test-level.js");
        expect(files).toContain("scripts/run-vitest.mjs");
        expect(files).toContain("scripts/real-tests/run.ts");
        expect(files).toContain("scripts/real-tests/assert-json.ts");
        expect(files).toContain("scripts/real-tests/summarize-json.ts");
        expect(files).toContain("scripts/real-tests/installed-mcp-smoke.ts");
        expect(files).toContain("scripts/real-tests/helpers.ts");
        expect(files).toContain("scripts/real-tests/hidden-child-processes.cjs");
        expect(files).toContain("scripts/real-tests/device-lab-mcp-client.ts");
        expect(files).toContain("scripts/real-tests/android-emulator-e2e.ts");
        expect(files).toContain("scripts/real-tests/ios-e2e.ts");
        expect(files).toContain("scripts/real-tests/macos-vm-e2e.ts");
        expect(files).toContain("scripts/real-tests/windows-sandbox-e2e.ts");
        expect(files).toContain("scripts/real-tests/level0-package-smoke.ts");
        expect(files).toContain("scripts/real-tests/level1-real-provider-readiness.ts");
        expect(files).toContain("scripts/real-tests/level2-host-integration-slots.ts");
        expect(files).toContain("scripts/real-tests/level2-ios-e2e.ts");
        expect(files).toContain("scripts/real-tests/level2-android-emulator-e2e.ts");
        expect(files).toContain("scripts/real-tests/android-device-e2e.ts");
        expect(files).toContain("scripts/real-tests/level2-android-device-e2e.ts");
        expect(files).toContain("scripts/real-tests/level2-macos-vm-e2e.ts");
        expect(files).toContain("scripts/real-tests/level2-windows-sandbox.ts");
        expect(files).toContain("scripts/real-tests/level2-real-linux-vm.ts");
        expect(files).toContain("scripts/real-tests/level3-real-destructive.ts");
        expect([...files].some((file) => file.startsWith("lab-mcp/"))).toBe(false);
    });

    it("runs packaged informational CLI commands without creating runtime state", () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-packaged-cli-info-"));
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "VITEST" && !key.startsWith("VITEST_")),
        ) as NodeJS.ProcessEnv;
        env.HOME = homeDir;
        env.USERPROFILE = homeDir;
        try {
            const version = execFileSync(process.execPath, [join(repoRoot, "dist", "index.js"), "--version"], {
                cwd: homeDir,
                encoding: "utf-8",
                env,
                timeout: 10000,
            });
            const help = execFileSync(process.execPath, [join(repoRoot, "dist", "index.js"), "@feature", "--help"], {
                cwd: homeDir,
                encoding: "utf-8",
                env,
                timeout: 10000,
            });

            expect(version.trim()).toBe(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8")).version);
            expect(help).toContain("ccc - Claude Code Container");
            expect(help).toContain("-v, --version");
            expect(() => readFileSync(join(homeDir, ".ccc", "devices", "broker", "runtime.json"), "utf-8")).toThrow();
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("provisions one owner secret across concurrent packaged processes", async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-packaged-auth-race-"));
        const barrier = join(homeDir, "start");
        const ownerId = "1234567890abcdef";
        const moduleUrl = pathToFileURL(join(repoRoot, "dist", "device-lab-broker.js")).href;
        const script = [
            `import { existsSync } from ${JSON.stringify("fs")};`,
            `import { deviceBrokerOwnerSecret } from ${JSON.stringify(moduleUrl)};`,
            `while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 2));`,
            `process.stdout.write(deviceBrokerOwnerSecret(${JSON.stringify(ownerId)}));`,
        ].join("\n");
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "VITEST" && !key.startsWith("VITEST_")),
        ) as NodeJS.ProcessEnv;
        env.HOME = homeDir;
        env.USERPROFILE = homeDir;

        const children = Array.from({ length: 16 }, () => new Promise<string>((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
                cwd: homeDir,
                env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            });
            let stdout = "";
            let stderr = "";
            const timer = setTimeout(() => {
                child.kill("SIGKILL");
                reject(new Error("concurrent owner secret child timed out"));
            }, 15000);
            child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
            child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
            child.once("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });
            child.once("close", (status) => {
                clearTimeout(timer);
                if (status === 0) resolve(stdout.trim());
                else reject(new Error(`owner secret child exited ${status}: ${stderr}`));
            });
        }));

        try {
            writeFileSync(barrier, "start");
            const secrets = await Promise.all(children);
            expect(new Set(secrets).size).toBe(1);
            expect(secrets[0]).toMatch(/^[a-f0-9]{64}$/);
            const authRoot = join(homeDir, ".ccc", "devices", "broker", "auth");
            expect(readdirSync(authRoot)).toEqual([`${ownerId}.json`]);
            expect(JSON.parse(readFileSync(join(authRoot, `${ownerId}.json`), "utf8"))).toEqual(expect.objectContaining({
                ownerId,
                secret: secrets[0],
                version: 1,
            }));
        } finally {
            await Promise.allSettled(children);
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("keeps owner device state valid across concurrent provider processes", async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-packaged-device-state-race-"));
        const barrier = join(homeDir, "start");
        const moduleUrl = pathToFileURL(join(repoRoot, "device-lab-mcp", "src", "state", "device-store.mjs")).href;
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "VITEST" && !key.startsWith("VITEST_")),
        ) as NodeJS.ProcessEnv;
        env.HOME = homeDir;
        env.USERPROFILE = homeDir;
        const children = Array.from({ length: 16 }, (_, index) => {
            const id = `writer-${index}`;
            const payloadLength = (index + 1) * 4096;
            const script = [
                `import { existsSync } from ${JSON.stringify("fs")};`,
                `import { ownerStateFile, writeOwnerDevices } from ${JSON.stringify(moduleUrl)};`,
                `while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 2));`,
                `writeOwnerDevices("android", [{ id: ${JSON.stringify(id)}, payload: "x".repeat(${payloadLength}) }]);`,
                `process.stdout.write(ownerStateFile("android"));`,
            ].join("\n");
            return new Promise<string>((resolve, reject) => {
                const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
                    cwd: homeDir,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                });
                let stdout = "";
                let stderr = "";
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    reject(new Error("concurrent owner device state child timed out"));
                }, 15000);
                child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
                child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
                child.once("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once("close", (status) => {
                    clearTimeout(timer);
                    if (status === 0) resolve(stdout.trim());
                    else reject(new Error(`owner device state child exited ${status}: ${stderr}`));
                });
            });
        });

        try {
            writeFileSync(barrier, "start");
            const stateFiles = await Promise.all(children);
            expect(new Set(stateFiles).size).toBe(1);
            const stateFile = stateFiles[0];
            const state = JSON.parse(readFileSync(stateFile, "utf8")) as { devices: Array<{ id: string; payload: string }> };
            expect(state.devices).toHaveLength(1);
            const writerIndex = Number(state.devices[0].id.replace("writer-", ""));
            expect(state.devices[0].payload).toHaveLength((writerIndex + 1) * 4096);
            expect(readdirSync(join(stateFile, "..")).filter((entry) => entry !== "devices.json")).toEqual([]);
        } finally {
            await Promise.allSettled(children);
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("preserves every concurrent owner device mutation across provider processes", async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-packaged-device-mutation-race-"));
        const barrier = join(homeDir, "start");
        const moduleUrl = pathToFileURL(join(repoRoot, "device-lab-mcp", "src", "state", "device-store.mjs")).href;
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "VITEST" && !key.startsWith("VITEST_")),
        ) as NodeJS.ProcessEnv;
        env.HOME = homeDir;
        env.USERPROFILE = homeDir;
        const children = Array.from({ length: 16 }, (_, index) => {
            const id = `device-${index}`;
            const script = [
                `import { existsSync } from ${JSON.stringify("fs")};`,
                `import { mutateOwnerDevices, ownerStateFile } from ${JSON.stringify(moduleUrl)};`,
                `while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 2));`,
                `mutateOwnerDevices("android", (devices) => [...devices, { id: ${JSON.stringify(id)} }]);`,
                `process.stdout.write(ownerStateFile("android"));`,
            ].join("\n");
            return new Promise<string>((resolve, reject) => {
                const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
                    cwd: homeDir,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                });
                let stdout = "";
                let stderr = "";
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    reject(new Error("concurrent owner device mutation child timed out"));
                }, 15000);
                child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
                child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
                child.once("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once("close", (status) => {
                    clearTimeout(timer);
                    if (status === 0) resolve(stdout.trim());
                    else reject(new Error(`owner device mutation child exited ${status}: ${stderr}`));
                });
            });
        });

        try {
            writeFileSync(barrier, "start");
            const stateFiles = await Promise.all(children);
            expect(new Set(stateFiles).size).toBe(1);
            const stateFile = stateFiles[0];
            const state = JSON.parse(readFileSync(stateFile, "utf8")) as { devices: Array<{ id: string }> };
            expect(state.devices.map((device) => device.id).sort()).toEqual(
                Array.from({ length: 16 }, (_, index) => `device-${index}`).sort(),
            );
            expect(readdirSync(join(stateFile, "..")).filter((entry) => entry !== "devices.json")).toEqual([]);
        } finally {
            await Promise.allSettled(children);
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("allows exactly one concurrent claim for the same owner device identity", async () => {
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-packaged-device-claim-race-"));
        const barrier = join(homeDir, "start");
        const moduleUrl = pathToFileURL(join(repoRoot, "device-lab-mcp", "src", "state", "device-store.mjs")).href;
        const env = Object.fromEntries(
            Object.entries(process.env).filter(([key, value]) => value !== undefined && key !== "VITEST" && !key.startsWith("VITEST_")),
        ) as NodeJS.ProcessEnv;
        env.HOME = homeDir;
        env.USERPROFILE = homeDir;
        const children = Array.from({ length: 16 }, (_, index) => {
            const script = [
                `import { existsSync } from ${JSON.stringify("fs")};`,
                `import { claimOwnerDevice } from ${JSON.stringify(moduleUrl)};`,
                `while (!existsSync(${JSON.stringify(barrier)})) await new Promise((resolve) => setTimeout(resolve, 2));`,
                `const result = claimOwnerDevice("android", { id: "shared-device", avdName: "shared-avd", writer: ${index} }, ["id", "avdName"]);`,
                `process.stdout.write(JSON.stringify(result));`,
            ].join("\n");
            return new Promise<Record<string, unknown>>((resolve, reject) => {
                const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
                    cwd: homeDir,
                    env,
                    stdio: ["ignore", "pipe", "pipe"],
                    windowsHide: true,
                });
                let stdout = "";
                let stderr = "";
                const timer = setTimeout(() => {
                    child.kill("SIGKILL");
                    reject(new Error("concurrent owner device claim child timed out"));
                }, 15000);
                child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
                child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
                child.once("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.once("close", (status) => {
                    clearTimeout(timer);
                    if (status === 0) resolve(JSON.parse(stdout) as Record<string, unknown>);
                    else reject(new Error(`owner device claim child exited ${status}: ${stderr}`));
                });
            });
        });

        try {
            writeFileSync(barrier, "start");
            const results = await Promise.all(children);
            expect(results.filter((result) => result.ok === true)).toHaveLength(1);
            const conflicts = results.filter((result) => result.ok === false);
            expect(conflicts).toHaveLength(15);
            expect(new Set(conflicts.map((result) => result.error))).toEqual(new Set(["owner-device-id-conflict"]));
            expect(new Set(conflicts.map((result) => result.field))).toEqual(new Set(["id"]));
            const stateRoot = join(homeDir, ".ccc", "devices", "owners");
            const ownerRoots = readdirSync(stateRoot);
            expect(ownerRoots).toHaveLength(1);
            const backendRoot = join(stateRoot, ownerRoots[0], "android");
            const state = JSON.parse(readFileSync(join(backendRoot, "devices.json"), "utf8")) as { devices: Array<{ id: string }> };
            expect(state.devices).toHaveLength(1);
            expect(state.devices[0].id).toBe("shared-device");
            expect(readdirSync(backendRoot)).toEqual(["devices.json"]);
        } finally {
            await Promise.allSettled(children);
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("summarizes native JSON MCP content for real-test proof metadata", async () => {
        const { parseToolPayload, parseToolResult, realMcpToolRequestTimeoutMs, summarizeToolResultForProof } = await import("../../scripts/real-tests/device-lab-mcp-client.ts") as {
            parseToolPayload: (result: unknown) => Record<string, unknown>;
            parseToolResult: (result: unknown, options?: Record<string, unknown>) => Record<string, unknown>;
            realMcpToolRequestTimeoutMs: (name: string, args?: Record<string, unknown>) => number;
            summarizeToolResultForProof: (result: unknown) => Record<string, unknown>;
        };

        const okJsonResult = { content: [{ type: "json", value: { ok: true, devices: [{ id: "display" }] } }] };
        expect(parseToolPayload(okJsonResult)).toEqual({ ok: true, devices: [{ id: "display" }] });
        expect(summarizeToolResultForProof(okJsonResult)).toEqual({
            contentTypes: ["json"],
            okPayloadText: false,
            okPayloadImage: false,
            okPayloadJson: true,
            okPayloadShape: { kind: "object", keys: ["devices", "ok"] },
        });

        const expectedErrorResult = { isError: true, content: [{ type: "json", value: { error: "provider-missing", ok: false } }] };
        expect(parseToolResult(expectedErrorResult, { expectedError: true })).toEqual({ error: "provider-missing", ok: false });
        expect(summarizeToolResultForProof(expectedErrorResult)).toEqual({
            contentTypes: ["json"],
            errorPayloadText: false,
            errorDispatchMismatch: false,
            errorPayloadJson: true,
            errorCode: "provider-missing",
        });
        expect(realMcpToolRequestTimeoutMs("device_status")).toBe(120000);
        expect(realMcpToolRequestTimeoutMs("device_create", { createAvd: true })).toBe(360000);
        expect(realMcpToolRequestTimeoutMs("device_start", { waitForBoot: true, bootTimeoutMs: 180000 })).toBe(210000);
        expect(realMcpToolRequestTimeoutMs("mobile_get_clipboard", { backend: "android-emulator" })).toBe(360000);
        expect(realMcpToolRequestTimeoutMs("device_exec", { helperTimeoutMs: 180000 })).toBe(210000);
        expect(realMcpToolRequestTimeoutMs("device_create", { rpcTimeoutMs: 615000 })).toBe(630000);
        expect(realMcpToolRequestTimeoutMs("device_create", { backend: "windows-vm" })).toBe(21615000);
    });

    it("keeps real-provider transfer fixtures inside the broker-visible project root", async () => {
        const { realProviderTempRoot } = await import("../../scripts/real-tests/helpers.ts") as {
            realProviderTempRoot: (options?: Record<string, unknown>) => string;
        };
        expect(realProviderTempRoot()).toBe(join(repoRoot, "results", ".tmp"));
        expect(realProviderTempRoot({ brokerOnly: false })).toBe(join(repoRoot, "results", ".tmp"));
    });

    it("runs the bundled device-lab MCP server with the advertised tool surface", { timeout: 30000 }, async () => {
        const { TOOLS } = await import("../../device-lab-mcp/src/tools.mjs") as {
            TOOLS: Array<{ name: string; inputSchema?: unknown }>;
        };
        const { parseToolPayload, withDeviceLabMcp } = await import("../../scripts/real-tests/device-lab-mcp-client.ts") as {
            parseToolPayload: (result: unknown) => Record<string, unknown>;
            withDeviceLabMcp: (
                callback: (ctx: {
                    client: { listTools: () => Promise<{ tools: Array<{ name: string; inputSchema?: unknown }> }> };
                    callTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
                }) => Promise<void>,
                options?: { env?: Record<string, string>; name?: string; serverPath?: string },
            ) => Promise<void>;
        };
        const { installedMcpSmokeSample: distSmokeSample } = await import("../../scripts/real-tests/installed-mcp-smoke.ts") as {
            installedMcpSmokeSample: (toolName: string) => Record<string, unknown>;
        };
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-dist-smoke-"));
        try {
            await withDeviceLabMcp(async ({ client, callTool }) => {
                const listed = await client.listTools();
                expect(listed.tools.map((tool) => tool.name)).toEqual(TOOLS.map((tool) => tool.name));
                expect(listed.tools.map((tool) => tool.inputSchema)).toEqual(TOOLS.map((tool) => tool.inputSchema));
                const advertisedTransportKeys = listed.tools.flatMap((tool) => {
                    const properties = schemaProperties(tool.inputSchema);
                    return [...HIDDEN_LEGACY_TRANSPORT_KEYS]
                        .filter((key) => key !== "port" && key !== "timeoutMs")
                        .filter((key) => key in properties)
                        .map((key) => ({ name: tool.name, key }));
                });
                expect(advertisedTransportKeys).toEqual([]);
                expect(listed.tools.map((tool) => tool.name)).not.toContain("device_broker_service");

                const payload = parseToolPayload(await callTool("device_backends", { implicitBroker: false })) as {
                    source?: string;
                    backends?: Array<{ name?: string }>;
                };
                expect(payload.source).toBe("direct-provider");
                expect(payload.backends?.map((backend) => backend.name)).toEqual(expect.arrayContaining([
                    "x11-current-display",
                    "android-emulator",
                    "ios-simulator",
                    "windows-sandbox",
                    "macos-vm",
                ]));

                const displayStatus = parseToolPayload(await callTool("device_status", { deviceId: "x11-current-display" })) as {
                    id?: string;
                    kind?: string;
                    backend?: string;
                };
                expect(displayStatus).toEqual(expect.objectContaining({
                    id: "x11-current-display",
                    kind: "display",
                    backend: "x11",
                }));

                const displayFlow = parseToolPayload(await callTool("device_run_flow", {
                    steps: [{ tool: "device_status", arguments: { deviceId: "x11-current-display" } }],
                })) as {
                    ok?: boolean;
                    results?: Array<{ tool?: string; isError?: boolean; content?: Array<{ value?: { id?: string } }> }>;
                };
                expect(displayFlow.ok).toBe(true);
                expect(displayFlow.results?.[0]).toEqual(expect.objectContaining({
                    tool: "device_status",
                    isError: false,
                }));
                expect(displayFlow.results?.[0]?.content?.[0]?.value).toEqual(expect.objectContaining({ id: "x11-current-display" }));

                for (const args of [
                    { implicitBroker: false, backend: "android-emulator", name: "Dist Android smoke", deviceId: "dist-android-smoke" },
                    { implicitBroker: false, backend: "ios-simulator", name: "Dist iOS smoke", deviceId: "dist-ios-smoke" },
                    { implicitBroker: false, backend: "windows-sandbox", name: "Dist Windows smoke", deviceId: "dist-windows-smoke" },
                    { implicitBroker: false, backend: "macos-vm", name: "Dist macOS smoke", deviceId: "dist-macos-smoke", image: "missing-image" },
                ]) {
                    await callTool("device_create", args);
                }

                const missingRequiredSamples = listed.tools.flatMap((tool) => {
                    const required = Array.isArray((tool.inputSchema as { required?: unknown } | undefined)?.required)
                        ? (tool.inputSchema as { required: unknown[] }).required.map(String)
                        : [];
                    const sample = distSmokeSample(tool.name);
                    return required
                        .filter((key) => !(key in sample))
                        .map((key) => ({ name: tool.name, missing: key }));
                });
                expect(missingRequiredSamples).toEqual([]);

                const missingAnyOfSamples = listed.tools.flatMap((tool) => {
                    const anyOf = Array.isArray((tool.inputSchema as { anyOf?: unknown } | undefined)?.anyOf)
                        ? (tool.inputSchema as { anyOf: Array<{ required?: unknown[] }> }).anyOf
                            .map((item) => Array.isArray(item.required) ? item.required.map(String) : [])
                            .filter((required) => required.length > 0)
                        : [];
                    const sample = distSmokeSample(tool.name);
                    if (anyOf.length === 0 || anyOf.some((required) => required.every((key) => key in sample))) return [];
                    return [{ name: tool.name, anyOf }];
                });
                expect(missingAnyOfSamples).toEqual([]);

                const unknownSampleKeys = listed.tools.flatMap((tool) => {
                    const properties = schemaProperties(tool.inputSchema);
                    const sample = distSmokeSample(tool.name);
                    return Object.keys(sample)
                        .filter((key) => !(key in properties) && !HIDDEN_LEGACY_TRANSPORT_KEYS.has(key))
                        .map((key) => ({ name: tool.name, unknown: key }));
                });
                expect(unknownSampleKeys).toEqual([]);

                const failures: Array<{ name: string; text: string }> = [];
                for (const tool of TOOLS) {
                    const result = await callTool(tool.name, distSmokeSample(tool.name));
                    const text = (result as { content?: Array<{ text?: string }> }).content?.map((item) => item.text || "").join("\n") || "";
                    if (/Unknown tool:|Unexpected error:/.test(text)) failures.push({ name: tool.name, text });
                }
                expect(failures).toEqual([]);
            }, {
                name: "ccc-device-lab-dist-smoke",
                serverPath: join(repoRoot, "dist", "device-lab-mcp", "server.mjs"),
                env: {
                    HOME: homeDir,
                    PATH: process.env.PATH || "",
                },
            });
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("runs the installed MCP smoke contract against the bundled server", { timeout: 30000 }, async () => {
        const { runInstalledMcpSmoke } = await import("../../scripts/real-tests/installed-mcp-smoke.ts") as {
            runInstalledMcpSmoke: (options: { env?: Record<string, string>; name?: string; serverPath?: string }) => Promise<{
                status: string;
                tools: number;
                publicDispatchTools: number;
                currentDisplayAliases: string[];
            }>;
        };
        const homeDir = mkdtempSync(join(tmpdir(), "ccc-device-lab-installed-smoke-"));
        try {
            const result = await runInstalledMcpSmoke({
                name: "ccc-device-lab-installed-smoke-package-test",
                serverPath: join(repoRoot, "dist", "device-lab-mcp", "server.mjs"),
                env: {
                    HOME: homeDir,
                    PATH: process.env.PATH || "",
                },
            });
            expect(result.status).toBe("PASS");
            expect(result.publicDispatchTools).toBe(result.tools);
            expect(result.currentDisplayAliases).toEqual(expect.arrayContaining(["device_status"]));
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
