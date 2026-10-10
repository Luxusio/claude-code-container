import { afterEach, describe, expect, it } from "vitest";
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

function parse(result: { content: unknown; isError?: unknown }) {
    expect(result.isError).not.toBe(true);
    expect(Array.isArray(result.content)).toBe(true);
    const first = (result.content as Array<{ type: string; text?: string }>)[0];
    expect(first.type).toBe("text");
    return JSON.parse(first.text!);
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
    }, TIMEOUT);
});
