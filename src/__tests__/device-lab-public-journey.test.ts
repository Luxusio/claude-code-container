import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { AddressInfo } from "node:net";
import { DEVICE_BROKER_PROTOCOL_VERSION } from "@ccc/device-lab/providers/contracts/broker-protocol.mjs";
import { createToolName } from "../../device-lab-mcp/src/tools.mjs";
import { currentHyperVConsoleFrame, forgetHyperVConsoleFrame, hyperVConsolePixel, hyperVConsoleText, rememberHyperVConsoleFrame } from "@ccc/device-lab/device-lab/broker/hyper-v/console.js";
import { cleanupDeviceLabMcpTestContext, createDeviceLabMcpTestContext, type DeviceLabMcpTestContext } from "./helpers/device-lab-mcp-fixture.js";

// Actual stdio MCP + HTTP broker routing, validation and compact responses.
// Only the external host/provider is simulated: this is not a native VM test.
type Device = { id: string; name: string; backend: string; status: string; incarnationId: string };
type Rpc = { method: string; params: Record<string, any> };
const stateKeys: Record<string, string> = { "windows-vm": "windows-vm", "linux-vm": "linux-vm", "android-emulator": "android", "ios-simulator": "ios", "macos-vm": "macos", "windows-sandbox": "windows" };
const textResult = (value: unknown, isError = false) => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCr8AAAAASUVORK5CYII=";

describe("public MCP user journeys", () => {
    let context: DeviceLabMcpTestContext;
    let server: Server;
    const devices = new Map<string, Device>();
    const files = new Map<string, Map<string, Buffer>>();
    const requests: Rpc[] = [];
    let failNext = "";
    let birth = 0;
    let catalog: Awaited<ReturnType<DeviceLabMcpTestContext["client"]["listTools"]>>["tools"];

    function invoke({ method, params: p }: Rpc): unknown {
        requests.push({ method, params: p });
        if (method === "broker.inventory") return { backends: Object.entries(stateKeys).map(([backend, stateKey]) => ({ stateKey, devices: [...devices.values()].filter(d => d.backend === backend) })) };
        if (method === "broker.backends") return { backends: [{ name: "linux-vm", provider: "hyper-v", available: true }] };
        if (method === "broker.command.invoke") {
            if (p.command === "device_create") {
                const id = `${p.backend === "windows-vm" ? "win" : p.backend === "linux-vm" ? "linux" : "macos"}-${String(++birth).padStart(8, "0")}-1111-4111-8111-111111111111`;
                if (["windows-vm", "linux-vm", "macos-vm"].includes(p.backend) && Object.hasOwn(p, "deviceId")) throw new Error("fixture-caller-chosen-id");
                const device = { id, name: p.name, backend: p.backend, status: "stopped", incarnationId: id.endsWith("1") ? "a".repeat(32) : "b".repeat(32) };
                devices.set(id, device);
                files.set(id, new Map());
                return { device };
            }
            const device = devices.get(p.deviceId);
            if (!device || p.backend !== device.backend) throw new Error("fixture-wrong-device-route");
            if (Object.hasOwn(p, "incarnationId")) throw new Error("fixture-public-generation-forwarded");
            if (p.command === "device_delete") { devices.delete(device.id); files.delete(device.id); forgetHyperVConsoleFrame(device.id); return { deleted: device.id }; }
            if (p.command === "device_start") device.status = "running";
            else if (p.command === "device_stop") device.status = "stopped";
            else if (p.command !== "device_status") throw new Error(`fixture-unhandled-command:${p.command}`);
            return { device };
        }
        if (method !== "broker.device.tool.invoke") throw new Error(`fixture-unhandled-method:${method}`);
        const device = devices.get(p.deviceId);
        if (!device || p.backend !== device.backend) throw new Error("fixture-wrong-device-route");
        const result = (value: unknown, failed = false) => ({ mcpResult: textResult(value, failed) });
        if (Object.hasOwn(p, "incarnationId")) throw new Error("fixture-public-generation-forwarded");
        if (p.tool === failNext) { failNext = ""; return result({ ok: false, error: "fixture-provider-busy", remedy: "Retry this operation." }, true); }
        if (device.status !== "running") return result({ ok: false, error: "device-not-running", remedy: "Start the device." }, true);
        switch (p.tool) {
            case "device_screenshot": {
                const frame = { incarnationId: device.incarnationId, width: 1, height: 1, nativeWidth: 1, nativeHeight: 1, capturedAt: new Date().toISOString() };
                rememberHyperVConsoleFrame(device.id, frame);
                return { mcpResult: { content: [
                    { type: "image", mimeType: "image/png", data: png },
                    { type: "text", text: JSON.stringify({ deviceId: device.id, backend: device.backend, width: frame.width, height: frame.height, incarnationId: frame.incarnationId, capturedAt: frame.capturedAt }) },
                ] } };
            }
            case "device_click": case "device_cursor_position": {
                const frame = currentHyperVConsoleFrame(device.id, device.incarnationId);
                if (!frame) return result({ ok: false, error: "hyper-v-console-screenshot-required" }, true);
                if (hyperVConsolePixel(p.x, frame.width) === null || hyperVConsolePixel(p.y, frame.height) === null) return result({ ok: false, error: "hyper-v-console-pixel-invalid" }, true);
                return result({ ok: true });
            }
            case "device_type": return hyperVConsoleText(p.text) === null ? result({ ok: false, error: "hyper-v-console-text-invalid" }, true) : result({ ok: true });
            case "device_upload": files.get(device.id)!.set(p.remotePath, readFileSync(p.localPath)); return result({ ok: true });
            case "device_download": {
                const bytes = files.get(device.id)!.get(p.remotePath);
                if (!bytes) return result({ ok: false, error: "file-not-found" }, true);
                writeFileSync(p.localPath, bytes);
                return result({ ok: true });
            }
            case "device_exec": {
                if (p.command === "printf guest-identity") return result({ status: 0, stdout: JSON.stringify({ incarnationId: "guest-data", nested: { incarnationId: "guest-child" } }), stderr: "" });
                if (!p.command?.includes("[IO.Directory]::EnumerateFileSystemEntries")) throw new Error("fixture-unexpected-exec");
                const entries = [...files.get(device.id)!].map(([path, bytes]) => ({ name: basename(path), type: "file", size: bytes.length }));
                return result({ status: 0, stdout: JSON.stringify({ entries }), stderr: "" });
            }
            default: throw new Error(`fixture-unhandled-tool:${p.tool}`);
        }
    }

    beforeEach(async () => {
        for (const id of devices.keys()) forgetHyperVConsoleFrame(id);
        devices.clear(); files.clear(); requests.length = 0; failNext = ""; birth = 0;
        const owner = "1111111111111111";
        server = createServer((req, res) => {
            const send = (value: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
            if (req.url === "/health") return send({ ok: true, name: "ccc-device-broker" });
            if (req.url === "/status") return send({ ok: true, broker: { protocolVersion: DEVICE_BROKER_PROTOCOL_VERSION } });
            if (req.url === "/v1/owner/resolve") return send({ ok: true, result: { ownerId: owner } });
            let raw = "";
            req.on("data", chunk => { raw += chunk; });
            req.on("end", () => {
                try {
                    if (req.url !== `/v1/owners/${owner}/rpc`) throw new Error("fixture-wrong-owner");
                    send({ ok: true, result: invoke(JSON.parse(raw)) });
                } catch (error) { send({ ok: false, error: String(error) }); }
            });
        });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as AddressInfo).port;
        context = await createDeviceLabMcpTestContext({ rawPublicCalls: true, setupHome(home) {
            const root = join(home, ".ccc", "devices", "broker");
            mkdirSync(join(root, "auth"), { recursive: true });
            writeFileSync(join(root, "runtime.json"), JSON.stringify({ host: "127.0.0.1", port, managedBy: "ccc-host" }));
            writeFileSync(join(root, "auth", `${owner}.json`), JSON.stringify({ ownerId: owner, secret: "a".repeat(64), version: 1 }), { mode: 0o600 });
        } });
        catalog = (await context.client.listTools()).tools;
    });
    afterEach(async () => {
        for (const id of files.keys()) forgetHyperVConsoleFrame(id);
        await cleanupDeviceLabMcpTestContext(context);
        server?.closeAllConnections();
        if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    // No hidden flags, detail:true, preselected device or backend on existing-device calls.
    async function call(name: string, args: Record<string, unknown> = {}, fails = false) {
        const tool = catalog.find(t => t.name === name);
        expect(tool, `Unadvertised tool ${name}`).toBeDefined();
        const allowed = new Set(Object.keys(tool!.inputSchema.properties || {}));
        expect(Object.keys(args).filter(key => !allowed.has(key)), `${name} uses private arguments`).toEqual([]);
        const result = await context.client.callTool({ name, arguments: args });
        expect(result.isError === true, JSON.stringify(result)).toBe(fails);
        return result as { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };
    }
    async function value(name: string, args: Record<string, unknown> = {}, fails = false) {
        const result = await call(name, args, fails);
        const text = result.content.find(c => c.type === "text")!.text!;
        return text === "ok" ? text : JSON.parse(text);
    }
    async function create(backend = "windows-vm", extra: Record<string, unknown> = {}) {
        const created = await value(createToolName(backend), { name: "Journey", ...extra });
        // Explicit Hyper-V creation retains the existing broker result envelope.
        const device = backend === "linux-vm" && extra.provider === "hyper-v" ? created.result.device : created.device;
        expect(device.deviceId).toEqual(expect.any(String));
        expect(device).not.toHaveProperty("incarnationId");
        return { deviceId: device.deviceId as string };
    }
    async function screenshotTarget(target: { deviceId: string }) {
        const result = await call("screenshot", target);
        expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: png });
        const metadata = JSON.parse(result.content.find(c => c.type === "text")!.text!);
        expect(metadata).toMatchObject({ deviceId: target.deviceId, width: 1, height: 1 });
        expect(metadata).not.toHaveProperty("incarnationId");
        return { deviceId: metadata.deviceId as string };
    }

    it.each(["windows-vm", "linux-vm", "macos-vm"])("refuses caller-selected %s identity before any broker or provider request", async backend => {
        const tool = createToolName(backend);
        expect(catalog.find(entry => entry.name === tool)!.inputSchema.properties).not.toHaveProperty("deviceId");
        const result = await context.client.callTool({ name: tool, arguments: {
            name: "Chosen identity", deviceId: "chosen-vm-id", ...(backend === "macos-vm" ? { image: "fixture-image" } : {}),
        } });
        expect(result.isError).toBe(true);
        expect(JSON.parse((result.content[0] as { text: string }).text).error).toContain("deviceId");
        expect(requests).toEqual([]);
        expect(devices.size).toBe(0);
    });

    it.each(["windows-vm", "linux-vm"])("uses fresh returned %s IDs through the MCP create/list/status/exec chain", async backend => {
        const name = "重复 Virtual Machine name";
        const extra = backend === "linux-vm" ? { name, provider: "hyper-v" } : { name };
        const first = await create(backend, extra), second = await create(backend, extra);
        expect(first.deviceId).not.toBe(second.deviceId);
        expect(devices.get(first.deviceId)!.name).toBe(name);
        expect(devices.get(second.deviceId)!.name).toBe(name);
        expect(await value("devices")).toEqual(expect.arrayContaining([expect.objectContaining(first), expect.objectContaining(second)]));
        await call("start", first);
        expect((await value("status", first)).device.deviceId).toBe(first.deviceId);
        const executed = await value("exec", { ...first, command: "printf guest-identity" });
        expect(JSON.parse(executed.stdout)).toEqual({ incarnationId: "guest-data", nested: { incarnationId: "guest-child" } });
        const creates = requests.filter(r => r.params.command === "device_create");
        expect(creates).toHaveLength(2);
        for (const request of creates) expect(request.params).not.toHaveProperty("deviceId");
        for (const request of requests) expect(request.params).not.toHaveProperty("incarnationId");
        expect(requests.find(r => r.params.tool === "device_exec")!.params.deviceId).toBe(first.deviceId);
        await call("delete", { ...first, confirmDestructive: true });
        const replacement = await create(backend, extra);
        expect(replacement.deviceId).not.toBe(first.deviceId);
        const before = requests.length;
        expect(await value("exec", { ...first, command: "printf guest-identity" }, true)).toMatchObject({ error: "device-not-found" });
        expect(requests.filter(r => r.params.tool === "device_exec")).toHaveLength(1);
        expect(requests.slice(before).every(request => request.method === "broker.inventory")).toBe(true);
        expect(devices.has(replacement.deviceId)).toBe(true);
    });

    it("uses returned IDs through create, start, screenshot, input, transfer and deletion", async () => {
        let target = await create("windows-vm", { nestedVirtualization: true });
        expect(requests.find(r => r.params.command === "device_create")?.params).toMatchObject({ backend: "windows-vm", nestedVirtualization: true });
        expect(await value("devices")).toEqual(expect.arrayContaining([expect.objectContaining({ deviceId: target.deviceId, state: "stopped" })]));
        await value("start", target);
        expect((await value("status", target)).device.status).toBe("running");
        target = await screenshotTarget(target);
        expect(await value("move", { ...target, x: 0, y: 0 })).toBe("ok");
        expect(await value("click", { ...target, x: 0, y: 0 })).toBe("ok");
        expect(await value("type", { ...target, text: "Hello" })).toBe("ok");
        const localPath = join(context.homeDir, "input.bin"), outputPath = join(context.homeDir, "output.bin");
        const bytes = Buffer.from([0, 255, 10, 13, 42]);
        writeFileSync(localPath, bytes);
        const remotePath = "C:/Temp/payload.bin";
        await call("upload", { ...target, localPath, remotePath });
        expect(await value("list_files", { ...target, path: "C:/Temp" })).toEqual({ entries: [{ name: "payload.bin", type: "file", size: bytes.length }] });
        await call("download", { ...target, remotePath, localPath: outputPath });
        expect(readFileSync(outputPath)).toEqual(bytes);
        await call("stop", target);
        await call("delete", { ...target, confirmDestructive: true });
        expect(await value("devices")).not.toEqual(expect.arrayContaining([expect.objectContaining({ deviceId: target.deviceId })]));
        expect(requests.filter(r => r.method === "broker.command.invoke").map(r => r.params.command)).toEqual(["device_create", "device_start", "device_status", "device_stop", "device_delete"]);
    });

    it.each([
        ["android-emulator", { systemImage: "system-images;android-35;google_apis;x86_64" }, "createAvd"],
        ["ios-simulator", { deviceType: "iPhone-16", runtime: "iOS-18" }, "createSimulator"],
    ])("provisions %s without a preparation switch and reuses its returned ID", async (backend, extra, flag) => {
        const target = await create(backend as string, extra as Record<string, unknown>);
        expect(requests.find(r => r.params.command === "device_create")!.params[flag as string]).toBe(true);
        await call("start", target);
        await call("stop", target);
        await call("delete", { ...target, confirmDestructive: true });
    });

    it("reports a stopped device, permits start/retry, and never replays a failed mutation", async () => {
        const target = await create();
        expect(await value("click", { ...target, x: 0, y: 0 }, true)).toMatchObject({ error: "device-not-running" });
        await call("start", target);
        const captured = await screenshotTarget(target);
        failNext = "device_click";
        expect(await value("click", { ...captured, x: 0, y: 0 }, true)).toMatchObject({ error: "fixture-provider-busy", remedy: "Retry this operation." });
        expect(requests.filter(r => r.params.tool === "device_click")).toHaveLength(2);
        expect(await value("click", { ...captured, x: 0, y: 0 })).toBe("ok");
        expect(requests.filter(r => r.params.tool === "device_click")).toHaveLength(3);
    });

    it("blocks unconfirmed deletion and rejects the deleted ID without another provider mutation", async () => {
        const target = await create();
        const before = requests.length;
        await call("delete", target, true);
        expect(requests).toHaveLength(before);
        expect(devices.has(target.deviceId)).toBe(true);
        await call("delete", { ...target, confirmDestructive: true });
        const mutations = requests.filter(r => r.method !== "broker.inventory").length;
        expect(await value("start", target, true)).toMatchObject({ error: "device-not-found" });
        expect(requests.filter(r => r.method !== "broker.inventory")).toHaveLength(mutations);
    });

    it("rejects incomplete creation before dispatch and accepts corrected public inputs", async () => {
        const failed = await value("create_android_emulator", {  name: "Journey" }, true);
        expect(failed.error).toContain("systemImage");
        expect(requests).toEqual([]);
        await create("android-emulator", { systemImage: "system-images;android-35;google_apis;x86_64" });
        expect(requests.filter(r => r.params.command === "device_create")).toHaveLength(1);
    });

    it("isolates overlapping device flows and stops failed flows before the next mutation", async () => {
        let first = await create(), second = await create();
        await Promise.all([call("start", first), call("start", second)]);
        [first, second] = await Promise.all([screenshotTarget(first), screenshotTarget(second)]);
        const flow = (target: typeof first, text: string) => value("run_flow", { ...target, steps: [
            { tool: "click", arguments: { x: 0, y: 0 } }, { tool: "type", arguments: { text } },
        ] });
        await Promise.all([flow(first, "first"), flow(second, "second")]);
        expect(requests.filter(r => r.params.tool === "device_type").map(r => [r.params.deviceId, r.params.text]).sort()).toEqual([[first.deviceId, "first"], [second.deviceId, "second"]].sort());
        failNext = "device_click";
        const failed = await value("run_flow", { ...first, steps: [{ tool: "click", arguments: { x: 0, y: 0 } }, { tool: "type", arguments: { text: "must not run" } }] }, true);
        expect(failed).toMatchObject({ ok: false, stoppedAt: 0 });
        expect(requests.some(r => r.params.text === "must not run")).toBe(false);
        expect(await value("type", { ...second, text: "still usable" })).toBe("ok");
    });

    it("rejects missing and privately stale console frames while public actions use only deviceId", async () => {
        const target = await create();
        await call("start", target);
        const coordinates = { x: 0, y: 0 };
        expect(await value("click", { ...target, ...coordinates }, true)).toMatchObject({ error: "hyper-v-console-screenshot-required" });
        const captured = await screenshotTarget(target);
        expect(await value("click", { deviceId: captured.deviceId, ...coordinates })).toBe("ok");
        // Private native generation still invalidates a frame captured earlier.
        const previousGeneration = devices.get(target.deviceId)!.incarnationId;
        devices.get(target.deviceId)!.incarnationId = "c".repeat(32);
        expect(currentHyperVConsoleFrame(target.deviceId, previousGeneration)).not.toBeNull();
        expect(await value("click", { ...captured, ...coordinates }, true)).toMatchObject({ error: "hyper-v-console-screenshot-required" });
        const fresh = await screenshotTarget(target);
        expect(fresh).toEqual(captured);
        expect(await value("click", { ...fresh, x: 1, y: 0 }, true)).toMatchObject({ error: "hyper-v-console-pixel-invalid" });
        expect(await value("click", { ...fresh, ...coordinates })).toBe("ok");
    });
});
