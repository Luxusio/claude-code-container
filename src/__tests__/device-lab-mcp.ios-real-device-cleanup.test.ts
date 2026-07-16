import { spawn, type ChildProcess } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectProcessIdentity, waitForProcessIdentity } from "../../device-lab-mcp/src/state/process-identity.mjs";
import { cleanupFakeIosMcpContext, createFakeIosMcpContext, TIMEOUT, type FakeIosMcpContext } from "./helpers/fake-ios-mcp-fixture.js";

type DeviceRecord = Record<string, unknown> & {
    id: string;
    ownerId: string;
    udid: string;
    appium?: Record<string, unknown> | null;
    recording?: Record<string, unknown> | null;
};

function parseToolJson(result: { content?: unknown }) {
    return JSON.parse((((result.content as Array<{ text?: string }> | undefined) ?? [])[0]?.text ?? "{}")) as Record<string, unknown>;
}

function statePathFor(homeDir: string, device: DeviceRecord) {
    return join(homeDir, ".ccc", "devices", "owners", device.ownerId, "ios-device", "devices.json");
}

function leasePathFor(homeDir: string, device: DeviceRecord) {
    return join(homeDir, ".ccc", "devices", "physical-leases", "ios-device", "locks", `${encodeURIComponent(device.udid)}.json`);
}

function readDevice(statePath: string, deviceId: string) {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: DeviceRecord[] };
    const device = state.devices.find((item) => item.id === deviceId);
    if (!device) throw new Error(`missing iOS device state: ${deviceId}`);
    return { state, device };
}

function replaceDevice(statePath: string, replacement: DeviceRecord) {
    const state = JSON.parse(readFileSync(statePath, "utf-8")) as { devices: DeviceRecord[] };
    state.devices = state.devices.map((item) => item.id === replacement.id ? replacement : item);
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

async function attach(context: FakeIosMcpContext, deviceId: string, udid = "00008110-001C195E0E91801E") {
    const result = await context.client.callTool({
        name: "device_attach",
        arguments: { backend: "ios-device", deviceId, name: deviceId, udid },
    });
    expect(result.isError, (result.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);
    return parseToolJson(result).device as DeviceRecord;
}

describe("iOS physical runtime cleanup fencing", () => {
    let context: FakeIosMcpContext | undefined;
    let child: ChildProcess | undefined;

    afterEach(async () => {
        if (child?.pid && child.exitCode === null) {
            try { child.kill("SIGKILL"); } catch { /* process already exited */ }
        }
        await cleanupFakeIosMcpContext(context);
        context = undefined;
        child = undefined;
    }, TIMEOUT);

    it.runIf(process.platform !== "win32")("preserves recording metadata and the physical lease when SIGINT delivery does not stop the recorder", { timeout: TIMEOUT }, async () => {
        context = await createFakeIosMcpContext();
        const attached = await attach(context, "ios-recording-cleanup");
        const statePath = statePathFor(context.homeDir, attached);
        const leasePath = leasePathFor(context.homeDir, attached);

        child = spawn(process.execPath, ["-e", "process.on('SIGINT',()=>{});if(process.send)process.send('ready');setInterval(()=>{},1000)"], {
            stdio: ["ignore", "ignore", "ignore", "ipc"],
            windowsHide: true,
        });
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("stubborn recorder did not become ready")), 1000);
            child?.once("message", (message) => {
                clearTimeout(timer);
                if (message === "ready") resolve();
                else reject(new Error(`unexpected recorder readiness message: ${String(message)}`));
            });
        });
        const processIdentity = await waitForProcessIdentity(child.pid, 1000);
        expect(processIdentity).toBeTruthy();
        const original = readDevice(statePath, attached.id).device;
        const recording = {
            active: true,
            runtimeId: "ios-physical-recording-runtime",
            pid: child.pid,
            processIdentity,
            provider: "xctrace-recording",
            startedAt: new Date().toISOString(),
        };
        replaceDevice(statePath, { ...original, recording });

        const detached = await context.client.callTool({
            name: "device_detach",
            arguments: { backend: "ios-device", deviceId: attached.id },
        });
        expect(detached.isError).toBe(true);
        expect((detached.content as Array<{ text?: string }>)[0]?.text).toContain("did not exit within 3000ms");

        const preserved = readDevice(statePath, attached.id).device;
        expect(preserved.recording).toEqual(recording);
        expect(preserved.lifecycle).toBeUndefined();
        expect(existsSync(leasePath)).toBe(true);
        expect(child.exitCode).toBeNull();
    });

    it("preserves Appium metadata and the physical lease when process identity cannot be verified", { timeout: TIMEOUT }, async () => {
        context = await createFakeIosMcpContext();
        const attached = await attach(context, "ios-appium-cleanup");
        const statePath = statePathFor(context.homeDir, attached);
        const leasePath = leasePathFor(context.homeDir, attached);

        child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
        const processIdentity = await waitForProcessIdentity(child.pid, 1000);
        expect(processIdentity).toBeTruthy();
        const original = readDevice(statePath, attached.id).device;
        const appium = {
            runtimeId: "ios-physical-appium-runtime",
            processOwner: "device-lab-mcp",
            startedBy: "direct-provider",
            serverPid: child.pid,
            processIdentity: { ...processIdentity, startToken: `${processIdentity?.startToken}-stale` },
            serverUrl: "http://127.0.0.1:9",
            sessionId: "stale-session",
        };
        replaceDevice(statePath, { ...original, appium });

        const stopped = await context.client.callTool({
            name: "device_stop",
            arguments: { backend: "ios-device", deviceId: attached.id },
        });
        expect(stopped.isError).toBe(true);
        expect((stopped.content as Array<{ text?: string }>)[0]?.text).toContain("Appium metadata and physical lease were preserved for retry");

        const preserved = readDevice(statePath, attached.id).device;
        expect(preserved.appium).toEqual(appium);
        expect(preserved.lifecycle).toBeUndefined();
        expect(existsSync(leasePath)).toBe(true);
        expect(child.exitCode).toBeNull();
    });

    it("records a successful recorder stop when later Appium cleanup fails", { timeout: TIMEOUT }, async () => {
        context = await createFakeIosMcpContext();
        const attached = await attach(context, "ios-partial-cleanup");
        const statePath = statePathFor(context.homeDir, attached);
        const leasePath = leasePathFor(context.homeDir, attached);
        const session = await context.client.callTool({ name: "mobile_dump_ui", arguments: { deviceId: attached.id } });
        expect(session.isError, (session.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);

        child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
        const recordingIdentity = await waitForProcessIdentity(child.pid, 1000);
        expect(recordingIdentity).toBeTruthy();
        const original = readDevice(statePath, attached.id).device;
        const appium = original.appium as Record<string, any>;
        const forgedAppium = {
            ...appium,
            processIdentity: { ...appium.processIdentity, startToken: `${appium.processIdentity.startToken}-stale` },
        };
        const recording = {
            active: true,
            runtimeId: "ios-physical-partial-recording-runtime",
            pid: child.pid,
            processIdentity: recordingIdentity,
            provider: "xctrace-recording",
            startedAt: new Date().toISOString(),
        };
        replaceDevice(statePath, { ...original, appium: forgedAppium, recording });

        const stopped = await context.client.callTool({
            name: "device_stop",
            arguments: { backend: "ios-device", deviceId: attached.id },
        });
        expect(stopped.isError).toBe(true);
        expect((stopped.content as Array<{ text?: string }>)[0]?.text).toContain("Appium metadata and physical lease were preserved for retry");

        const preserved = readDevice(statePath, attached.id).device;
        expect(preserved.status).toBe(original.status);
        expect(preserved.recording).toEqual(expect.objectContaining({
            ...recording,
            active: false,
            endedAt: expect.any(String),
        }));
        expect(preserved.appium).toEqual(forgedAppium);
        expect(preserved.lifecycle).toBeUndefined();
        expect(existsSync(leasePath)).toBe(true);
        expect(inspectProcessIdentity(recordingIdentity, child.pid).status).toBe("exited");
    });

    it("does not clear a concurrent successor after the owned Appium runtime exits", { timeout: TIMEOUT }, async () => {
        context = await createFakeIosMcpContext();
        const attached = await attach(context, "ios-cleanup-successor", "00008111-001C195E0E91801F");
        const statePath = statePathFor(context.homeDir, attached);
        const leasePath = leasePathFor(context.homeDir, attached);
        const session = await context.client.callTool({ name: "mobile_dump_ui", arguments: { deviceId: attached.id } });
        expect(session.isError, (session.content as Array<{ text?: string }>)[0]?.text).not.toBe(true);

        const currentState = readDevice(statePath, attached.id);
        const successor = {
            ...currentState.device,
            name: "Concurrent successor",
            appium: null,
            successorMarker: "preserved",
            updatedAt: new Date().toISOString(),
        };
        writeFileSync(join(context.homeDir, "fake-ios-real-state-conflict.json"), `${JSON.stringify({
            devices: currentState.state.devices.map((item) => item.id === attached.id ? successor : item),
        }, null, 2)}\n`);
        writeFileSync(join(context.homeDir, "fake-ios-real-state-conflict-path"), statePath);

        const stopped = await context.client.callTool({
            name: "device_stop",
            arguments: { backend: "ios-device", deviceId: attached.id },
        });
        expect(stopped.isError).toBe(true);
        expect((stopped.content as Array<{ text?: string }>)[0]?.text).toContain("owner-device-state-conflict");
        expect(readDevice(statePath, attached.id).device).toEqual(successor);
        expect(existsSync(leasePath)).toBe(true);
    });
});
