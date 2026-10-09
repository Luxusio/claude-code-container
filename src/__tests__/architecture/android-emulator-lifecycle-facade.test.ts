import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { ANDROID_SYSTEM_IMAGE, ORIGINAL_ANDROID_LIFECYCLE, androidRawState, androidStatePath, assertCurrentAndroidLifecycleEmission, originalObservation, toolJson, toolText, withAndroidLifecycleFixture } from "../helpers/android-emulator-lifecycle-fixture.js";
import { deviceLabTestHomeEnvironment } from "../helpers/device-lab-test-environment.js";

const project = fileURLToPath(new URL("../../../", import.meta.url));

describe("Android emulator lifecycle original direct public MCP witnesses", () => {
    it("genuine current emitted MCP executes all four policies through existing native SDK authority", async () => {
        assertCurrentAndroidLifecycleEmission();
        await withAndroidLifecycleFixture("emitted-direct-four", async (c, ownerId) => {
            const emitted = new Client({ name: "android-lifecycle-emitted", version: "1" }, { capabilities: {} });
            const failures: unknown[] = [], deviceId = "android-emitted-four";
            try {
                await emitted.connect(new StdioClientTransport({ command: process.execPath,
                    args: [join(project, "dist/device-lab-mcp/server.mjs")], cwd: project,
                    env: { ...deviceLabTestHomeEnvironment(c.homeDir), PATH: c.binDir, NODE_ENV: "test", FAKE_ANDROID_LOG: c.logPath,
                        NODE_OPTIONS: "--require=" + JSON.stringify(join(c.homeDir, "node-provider-routing.cjs")) },
                }));
                const call = (name: string, args: Record<string, unknown>) => emitted.callTool({ name, arguments: { ...args, implicitBroker: false, detail: true } });
                const created = await call("create_android_emulator", { name: "Emitted Four", deviceId, port: 5676, systemImage: ANDROID_SYSTEM_IMAGE });
                expect(created.isError, toolText(created)).not.toBe(true);
                expect(toolJson(created).device).toMatchObject({ deviceId, status: "stopped", provisioned: true });
                const started = await call("start", { deviceId, bootTimeoutMs: 5000 });
                expect(started.isError, toolText(started)).not.toBe(true);
                expect(toolJson(started)).toMatchObject({ device: { status: "running" }, boot: { ready: true } });
                const runtime = androidRawState(c.homeDir, ownerId).devices[0].runtime as { pid: number };
                const stopped = await call("stop", { deviceId });
                expect(stopped.isError, toolText(stopped)).not.toBe(true);
                expect(toolJson(stopped).device).toMatchObject({ status: "stopped" });
                await expect.poll(() => { try { process.kill(runtime.pid, 0); return true; } catch { return false; } }, { timeout: 5000 }).toBe(false);
                const deleted = await call("delete", { deviceId, deleteAvd: true, confirmDestructive: true });
                expect(deleted.isError, toolText(deleted)).not.toBe(true);
                expect(toolJson(deleted)).toMatchObject({ deleted: deviceId, avdDeleted: true });
                expect(androidRawState(c.homeDir, ownerId).devices).toEqual([]);
            } catch (error) { failures.push(error); }
            finally { try { await emitted.close(); } catch (error) { failures.push(error); } }
            if (failures.length) throw new AggregateError(failures, "emitted lifecycle assertion precedes cleanup failures");
        });
    }, 30000);

    it("create/start/stop/delete retain raw carriers, command order and owned runtime joins", async () => {
        await withAndroidLifecycleFixture("direct-four", async (c, ownerId) => {
            const deviceId = "android-original-four", avdName = `ccc-${ownerId}-original-four`;
            const outcomes: unknown[] = [];
            const created = await c.client.callTool({ name: "create_android_emulator", arguments: {
                name: "Original Four", deviceId, avdName, port: 5668, systemImage: ANDROID_SYSTEM_IMAGE, deviceProfile: "pixel_6",
            } });
            outcomes.push(created); expect(created.isError, toolText(created)).not.toBe(true);
            expect(toolJson(created).device).toMatchObject({ deviceId, avdName, port: 5668, status: "stopped", provisioned: true, headless: true });
            expect(toolJson(created).device).not.toHaveProperty("avdRoot");
            const rawCreated = androidRawState(c.homeDir, ownerId).devices[0];
            expect(rawCreated).toMatchObject({ id: deviceId, ownerId, serial: "emulator-5668", status: "stopped", appium: null, systemImage: ANDROID_SYSTEM_IMAGE });
            const started = await c.client.callTool({ name: "start", arguments: { deviceId, bootTimeoutMs: 5000 } });
            outcomes.push(started); expect(started.isError, toolText(started)).not.toBe(true);
            expect(toolJson(started)).toMatchObject({ device: { status: "running", bootReady: true }, boot: { ready: true } });
            const rawStarted = androidRawState(c.homeDir, ownerId).devices[0];
            expect(rawStarted.runtime).toMatchObject({ pid: expect.any(Number), processIdentity: { startToken: expect.any(String) } });
            const stopped = await c.client.callTool({ name: "stop", arguments: { deviceId } });
            outcomes.push(stopped); expect(stopped.isError, toolText(stopped)).not.toBe(true);
            expect(toolJson(stopped).device).toMatchObject({ status: "stopped" });
            expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ pid: null, runtime: null, lifecycle: null, appium: null, recording: null, status: "stopped" });
            const ownedPid = (rawStarted.runtime as { pid: number }).pid;
            await expect.poll(() => {
                try { process.kill(ownedPid, 0); return true; } catch { return false; }
            }, { timeout: 5000 }).toBe(false);
            const deleted = await c.client.callTool({ name: "delete", arguments: { deviceId, deleteAvd: true, confirmDestructive: true } });
            outcomes.push(deleted); expect(deleted.isError, toolText(deleted)).not.toBe(true);
            expect(androidRawState(c.homeDir, ownerId).devices).toEqual([]);
            expect(existsSync(join(c.homeDir, ".android", "avd", avdName + ".avd"))).toBe(false);
            const log = readFileSync(c.logPath, "utf8");
            const createIndex = log.indexOf(`avdmanager create avd --name ${avdName}`), launchIndex = log.indexOf(`emulator -avd ${avdName} -port 5668`);
            expect(createIndex).toBeGreaterThanOrEqual(0); expect(launchIndex).toBeGreaterThan(createIndex);
            expect(log.indexOf("adb -s emulator-5668 emu kill")).toBeGreaterThan(launchIndex);
            originalObservation("direct-four", { outcomes, rawCreated, rawStarted, log, unknownSignalsAttempted: "not counted; native identity authority retained" });
        });
    }, 30000);

    it("invalid-port and allocated-port admission precede duplicate and a second provisioning", async () => {
        await withAndroidLifecycleFixture("direct-order", async (c, ownerId) => {
            const before = readFileSync(c.logPath, "utf8");
            const invalid = await c.client.callTool({ name: "create_android_emulator", arguments: { name: "Invalid", deviceId: "android-invalid", port: 5555, systemImage: ANDROID_SYSTEM_IMAGE } });
            expect(invalid.isError).toBe(true); expect(toolJson(invalid)).toEqual({ ok: false, error: ORIGINAL_ANDROID_LIFECYCLE.directOddPortError });
            expect(readFileSync(c.logPath, "utf8")).toBe(before);
            const args = { name: "Duplicate", deviceId: "android-duplicate", port: 5670, systemImage: ANDROID_SYSTEM_IMAGE };
            const first = await c.client.callTool({ name: "create_android_emulator", arguments: args });
            expect(first.isError, toolText(first)).not.toBe(true);
            const second = await c.client.callTool({ name: "create_android_emulator", arguments: args });
            expect(second.isError).toBe(true); expect(toolText(second)).toBe(ORIGINAL_ANDROID_LIFECYCLE.directAllocatedDuplicateError);
            const duplicate = await c.client.callTool({ name: "create_android_emulator", arguments: { name: args.name, deviceId: args.deviceId, systemImage: args.systemImage } });
            expect(duplicate.isError).toBe(true); expect(toolText(duplicate)).toBe(ORIGINAL_ANDROID_LIFECYCLE.directDuplicateError);
            expect(readFileSync(c.logPath, "utf8").match(/avdmanager create avd /g)).toHaveLength(1);
            expect(androidRawState(c.homeDir, ownerId).devices).toHaveLength(1);
            originalObservation("direct-order", { invalid, first, second, duplicate });
        });
    }, 30000);

    it("failed provider create compensates partial owned artifacts and preserves raw stderr", async () => {
        await withAndroidLifecycleFixture("direct-compensation", async (c, ownerId) => {
            writeFileSync(join(c.homeDir, "fake-android-avdmanager-create-fail"), "1");
            const avdName = `ccc-${ownerId}-partial-original`;
            const failed = await c.client.callTool({ name: "create_android_emulator", arguments: { name: "Partial Original", deviceId: "android-partial-original", avdName, port: 5672, systemImage: ANDROID_SYSTEM_IMAGE } });
            expect(failed.isError).toBe(true); expect(toolText(failed)).toContain("injected partial AVD creation failure");
            expect(androidRawState(c.homeDir, ownerId).devices).toEqual([]);
            for (const suffix of [".ini", ".avd"]) expect(existsSync(join(c.homeDir, ".android", "avd", avdName + suffix))).toBe(false);
            originalObservation("direct-compensation", { failed, state: androidRawState(c.homeDir, ownerId) });
        });
    }, 30000);

    it("an external create winner survives losing claim and owned artifact compensation", async () => {
        await withAndroidLifecycleFixture("direct-successor", async (c, ownerId) => {
            const deviceId = "android-original-successor", avdName = `ccc-${ownerId}-loser-original`;
            const winner = { id: deviceId, name: "External original winner", backend: "android-emulator", avdName: `ccc-${ownerId}-winner-original`, status: "stopped", extra: { raw: "retained" } };
            writeFileSync(join(c.homeDir, "fake-android-create-conflict-state.json"), JSON.stringify({ devices: [winner] }));
            writeFileSync(join(c.homeDir, "fake-android-create-conflict-state-path"), androidStatePath(c.homeDir, ownerId));
            const failed = await c.client.callTool({ name: "create_android_emulator", arguments: { name: "Loser Original", deviceId, avdName, port: 5674, systemImage: ANDROID_SYSTEM_IMAGE } });
            expect(failed.isError).toBe(true); expect(toolText(failed)).toContain(`Device identity already exists for this owner (id: ${deviceId})`);
            expect(androidRawState(c.homeDir, ownerId).devices).toEqual([winner]);
            expect(existsSync(join(c.homeDir, ".android", "avd", avdName + ".avd"))).toBe(false);
            originalObservation("direct-successor", { failed, winner, state: androidRawState(c.homeDir, ownerId) });
        });
    }, 30000);
});
