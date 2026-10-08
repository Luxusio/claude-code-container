import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createDeviceBrokerServer } from "@ccc/device-lab/device-lab-broker.js";
import { deviceLabOwnerId } from "@ccc/device-lab/device-lab-owner.js";
import { backendRoot, close, listen, ownerRpcEndpoint, ownerRpcHeaders } from "../helpers/host-broker-test-fixture.js";
import { isolateDeviceLabTestEnvironment } from "../helpers/device-lab-test-environment.js";
import { createDeviceLabMcpTestContext, cleanupDeviceLabMcpTestContext } from "../helpers/device-lab-mcp-fixture.js";

describe("actual public Sandbox create bindings", () => {
    it("creates through actual MCP and refuses duplicate owner identity", async () => {
        const context = await createDeviceLabMcpTestContext({ defaultImplicitBroker: false });
        try {
            const args = { backend: "windows-sandbox", name: "Architecture Sandbox", deviceId: "architecture-sandbox" };
            const catalog = await context.client.listTools(); const tool = catalog.tools.find(tool => tool.name === "create_windows_sandbox");
            expect(tool).toBeDefined(); expect(catalog.tools.some(tool => tool.name === "device_create")).toBe(false);
            expect(tool?.inputSchema.properties?.memoryMb).toMatchObject({ type: "integer" });
            const invalid = await context.client.callTool({ name: "create_windows_sandbox", arguments: { ...args, memoryMb: 1 } }); expect(invalid.isError).toBe(true);
            const result = await context.client.callTool({ name: "create_windows_sandbox", arguments: args }); expect(result.isError).not.toBe(true);
            const duplicate = await context.client.callTool({ name: "create_windows_sandbox", arguments: args }); expect(duplicate.isError).toBe(true);
            expect(JSON.stringify(duplicate)).toContain("Device already exists for this owner");
        } finally { await cleanupDeviceLabMcpTestContext(context); }
    }, 30000);
    it("requires authenticated RPC, creates config atomically and keeps duplicate 409 separate from dry-run", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-sandbox-create-rpc-")); const restore = isolateDeviceLabTestEnvironment(home);
        const cwd = join(home, "project"); mkdirSync(cwd); const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, providerPaths: { wsb: "/fake/wsb" } }); const url = await listen(server); const endpoint = ownerRpcEndpoint(url, ownerId); const headers = ownerRpcHeaders(ownerId);
        const params = { backend: "windows-sandbox", command: "device_create", deviceId: "sandbox", name: "Sandbox", memoryMb: 2048, networking: true };
        const invoke = (value: object, auth = headers) => fetch(endpoint, { method: "POST", headers: auth, body: JSON.stringify({ method: "broker.command.invoke", params: value }) });
        try {
            const denied = await invoke(params, { "content-type": "application/json", "x-ccc-device-token": "wrong" }); expect(denied.status).toBeGreaterThanOrEqual(400); expect(existsSync(join(backendRoot(ownerId, "windows"), "devices.json"))).toBe(false);
            const dry = await invoke({ ...params, dryRun: true }); expect(dry.status).toBe(200); expect(existsSync(join(backendRoot(ownerId, "windows"), "devices.json"))).toBe(false);
            const configPath = join(backendRoot(ownerId, "windows"), "sandbox", "sandbox.wsb"); const external = join(home, "external.wsb");
            if (process.platform !== "win32") { mkdirSync(dirname(configPath), { recursive: true }); writeFileSync(external, "outside"); symlinkSync(external, configPath); }
            const created = await invoke(params); expect(created.status, JSON.stringify(await created.clone().json())).toBe(200);
            expect(lstatSync(configPath).isSymbolicLink()).toBe(false); if (process.platform !== "win32") expect(readFileSync(external, "utf8")).toBe("outside");
            const config = readFileSync(configPath, "utf8"); expect(config).toContain("<MemoryInMB>2048</MemoryInMB>"); expect(config).toContain("<Networking>Enable</Networking>"); expect(config.match(/<MappedFolder>/g)).toHaveLength(5); expect(config).toContain("wscript.exe //B");
            const duplicate = await invoke(params); expect(duplicate.status).toBe(409); expect(await duplicate.json()).toMatchObject({ ok: false, error: "owner-device-already-exists", deviceId: "sandbox" });
            // The native broker's existing optionalNumber parser omits raw strings.
            const fallback = await invoke({ ...params, deviceId: "fallback", memoryMb: "raw" }); expect(fallback.status).toBe(200);
            expect(await fallback.json()).toMatchObject({ ok: true, result: { device: { id: "fallback", memoryMb: 4096 } } });
            const records = JSON.parse(readFileSync(join(backendRoot(ownerId, "windows"), "devices.json"), "utf8")).devices as Array<{ id: string; memoryMb: number }>;
            expect(records.find(device => device.id === "fallback")).toMatchObject({ memoryMb: 4096 });
            expect(readFileSync(join(backendRoot(ownerId, "windows"), "fallback", "fallback.wsb"), "utf8")).toContain("<MemoryInMB>4096</MemoryInMB>");
            const invalid = await invoke({ ...params, deviceId: "../invalid" }); expect(invalid.status).toBeGreaterThanOrEqual(400);
            expect(existsSync(join(backendRoot(ownerId, "windows"), "..", "invalid"))).toBe(false);
        } finally { await close(server); restore(); rmSync(home, { recursive: true, force: true }); }
    }, 30000);
    it("compensates an actual RPC config publication fault while preserving generated helper files", async () => {
        const home = mkdtempSync(join(tmpdir(), "ccc-sandbox-create-config-fault-")); const restore = isolateDeviceLabTestEnvironment(home);
        const cwd = join(home, "project"); mkdirSync(cwd); const ownerId = deviceLabOwnerId(cwd);
        const server = createDeviceBrokerServer({ cwd, host: "127.0.0.1", port: 0, providerPaths: { wsb: "/fake/wsb" } }); const url = await listen(server);
        const root = backendRoot(ownerId, "windows"); const deviceRoot = join(root, "fault"); const configPath = join(deviceRoot, "fault.wsb");
        mkdirSync(configPath, { recursive: true }); writeFileSync(join(configPath, "owned-marker"), "keep");
        try {
            const response = await fetch(ownerRpcEndpoint(url, ownerId), { method: "POST", headers: ownerRpcHeaders(ownerId), body: JSON.stringify({ method: "broker.command.invoke", params: { backend: "windows-sandbox", command: "device_create", deviceId: "fault", name: "Fault" } }) });
            expect(response.status).toBe(500); expect(await response.json()).toMatchObject({ ok: false, error: "windows-sandbox-config-write-failed", deviceId: "fault" });
            expect(JSON.parse(readFileSync(join(root, "devices.json"), "utf8")).devices).toEqual([]);
            expect(readFileSync(join(configPath, "owned-marker"), "utf8")).toBe("keep");
            for (const name of ["ccc-guest-helper.ps1", "ccc-guest-helper-bootstrap.ps1", "ccc-guest-helper-bootstrap.vbs"]) expect(readFileSync(join(deviceRoot, "tools", name), "utf8")).not.toBe("");
            for (const name of ["inbox", "outbox", "uploads", "downloads"]) expect(existsSync(join(deviceRoot, name))).toBe(true);
        } finally { await close(server); restore(); rmSync(home, { recursive: true, force: true }); }
    }, 30000);
});
