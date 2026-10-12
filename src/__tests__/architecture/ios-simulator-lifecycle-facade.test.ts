import { afterEach, describe, expect, it } from "vitest";
import {readFileSync} from "node:fs";
import {
    cleanupFakeIosMcpContext,
    createFakeIosMcpContext,
    TIMEOUT,
    type FakeIosMcpContext,
} from "../helpers/fake-ios-mcp-fixture.js";

let context: FakeIosMcpContext | undefined;
afterEach(async () => {
    if (context) await cleanupFakeIosMcpContext(context);
    context = undefined;
});

function parse(result: unknown) {
    if (result === null || typeof result !== "object") throw new Error("Expected an MCP response object");
    if (!("content" in result) || !Array.isArray(result.content)) throw new Error("Expected MCP content");
    if ("isError" in result) expect(result.isError).not.toBe(true);
    const first: unknown = result.content[0];
    if (first === null || typeof first !== "object" || !("type" in first) || first.type !== "text"
        || !("text" in first) || typeof first.text !== "string") throw new Error("Expected MCP text content");
    return JSON.parse(first.text);
}

describe("iOS simulator public lifecycle", () => {
    it("creates, boots, shuts down and deletes an owned simulator through the real SDK", async () => {
        context = await createFakeIosMcpContext();
        const call = (name: string, args: Record<string, unknown>) => context!.client.callTool({
            name, arguments: { ...args, implicitBroker: false },
        });
        const inventory = parse(await call("devices", { view: "available", backend: "ios-simulator" }));
        const id = "ios-lifecycle-public";
        const simulatorName = `ccc-${inventory.ownerId}-lifecycle-public`;
        const created = parse(await call("create_ios_simulator", {
            deviceId: id, name: "Lifecycle public", simulatorName,
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-15",
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-17-0",
        }));
        expect(created.device).toMatchObject({ deviceId: id, simulatorName, udid: "CREATED-IOS-UDID", status: "stopped" });
        const started = parse(await call("start", { deviceId: id, bootTimeoutMs: 1000 }));
        expect(started).toMatchObject({ device: { status: "booted" }, boot: { ready: true } });
        expect(parse(await call("stop", { deviceId: id })).device.status).toBe("stopped");
        expect(parse(await call("delete", { deviceId: id, deleteSimulator: true, confirmDestructive: true })))
            .toEqual({ deleted: id, simulatorDeleted: true });
        const operations=readFileSync(context.logPath,"utf8").split("\n").filter(line=>/^xcrun simctl (create|boot |bootstatus|shutdown|delete)/.test(line));
        expect(operations).toEqual([
            `xcrun simctl create ${simulatorName} com.apple.CoreSimulator.SimDeviceType.iPhone-15 com.apple.CoreSimulator.SimRuntime.iOS-17-0`,
            "xcrun simctl boot CREATED-IOS-UDID",
            "xcrun simctl bootstatus CREATED-IOS-UDID -b",
            "xcrun simctl shutdown CREATED-IOS-UDID",
            "xcrun simctl delete CREATED-IOS-UDID",
        ]);
    }, TIMEOUT);
});
