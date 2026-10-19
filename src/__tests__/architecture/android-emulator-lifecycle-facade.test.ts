import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { ANDROID_SYSTEM_IMAGE, androidRawState, androidStatePath, assertCurrentAndroidLifecycleEmission, toolJson, toolText, withAndroidLifecycleFixture } from "../helpers/android-emulator-lifecycle-fixture.js";
import { deviceLabTestHomeEnvironment } from "../helpers/device-lab-test-environment.js";

const project = fileURLToPath(new URL("../../../", import.meta.url));

describe("Android emulator lifecycle current public MCP lifecycle", () => {
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

        });
    }, 30000);

    it("invalid-port and allocated-port admission precede duplicate and a second provisioning", async () => {
        await withAndroidLifecycleFixture("direct-order", async (c, ownerId) => {
            const before = readFileSync(c.logPath, "utf8");
            const invalid = await c.client.callTool({ name: "create_android_emulator", arguments: { name: "Invalid", deviceId: "android-invalid", port: 5555, systemImage: ANDROID_SYSTEM_IMAGE } });
            expect(invalid.isError).toBe(true); expect(toolJson(invalid)).toEqual({ ok: false, error: "create Android port must be even and from 5554 to 5682" });
            expect(readFileSync(c.logPath, "utf8")).toBe(before);
            const args = { name: "Duplicate", deviceId: "android-duplicate", port: 5670, systemImage: ANDROID_SYSTEM_IMAGE };
            const first = await c.client.callTool({ name: "create_android_emulator", arguments: args });
            expect(first.isError, toolText(first)).not.toBe(true);
            const second = await c.client.callTool({ name: "create_android_emulator", arguments: args });
            expect(second.isError).toBe(true); expect(toolText(second)).toBe("android-emulator-port-conflict: port-5670-already-allocated");
            const duplicate = await c.client.callTool({ name: "create_android_emulator", arguments: { name: args.name, deviceId: args.deviceId, systemImage: args.systemImage } });
            expect(duplicate.isError).toBe(true); expect(toolText(duplicate)).toBe("Device already exists for this owner: android-duplicate");
            expect(readFileSync(c.logPath, "utf8").match(/avdmanager create avd /g)).toHaveLength(1);
            expect(androidRawState(c.homeDir, ownerId).devices).toHaveLength(1);

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

        });
    }, 30000);
});

describe.each(["source", "emitted"] as const)("direct Android stop completion through %s MCP", route => {
    const options = route === "emitted" ? { entrypoint: join(project, "dist/device-lab-mcp/server.mjs") } : {};

    it("native stop evidence rejects failed, malformed and offline inventory, preserves recovery data, then permits a trustworthy retry", async () => {
        await withAndroidLifecycleFixture("stop-inventory-" + route, async (c, ownerId) => {
            const deviceId = "android-stop-facts", serial = "emulator-5678", avdName = `ccc-${ownerId}-stop-facts`;
            const created = await c.client.callTool({ name: "create_android_emulator", arguments: { deviceId, name: "Stop Facts", avdName, port: 5678, systemImage: ANDROID_SYSTEM_IMAGE } });
            expect(created.isError, toolText(created)).not.toBe(true);
            const state = androidRawState(c.homeDir, ownerId);
            const original = { ...state.devices[0], status: "running", appium: { sessionId: "recoverable-appium" }, recording: { active: false, remotePath: "/sdcard/recoverable.mp4" }, extra: { raw: "recoverable" } };
            writeFileSync(androidStatePath(c.homeDir, ownerId), JSON.stringify({ ...state, devices: [original] }));
            writeFileSync(join(c.homeDir, "fake-adb-active-" + serial), avdName);
            for (const [marker, content] of [
                ["fake-adb-devices-fail", "1"], ["fake-adb-devices-headerless", "1"],
                ["fake-adb-devices-truncated", "1"], ["fake-adb-target-offline", serial], ["fake-android-avd-query-fail", "1"],
            ]) {
                writeFileSync(join(c.homeDir, marker), content);
                const before = readFileSync(c.logPath, "utf8");
                try {
                    const refused = await c.client.callTool({ name: "stop", arguments: { deviceId } });
                    expect(refused.isError, toolText(refused)).toBe(true);
                    expect(toolText(refused)).toContain("android-emulator-stop-unconfirmed");
                    expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "running", appium: original.appium, recording: original.recording, extra: original.extra });
                    expect(androidRawState(c.homeDir, ownerId).devices[0]).not.toHaveProperty("lifecycle");
                    expect(existsSync(join(c.homeDir, ".android", "avd", avdName + ".avd"))).toBe(true);
                    expect(readFileSync(c.logPath, "utf8").slice(before.length)).not.toContain(`adb -s ${serial} emu kill`);
                } finally { rmSync(join(c.homeDir, marker), { force: true }); }
            }
            const stopped = await c.client.callTool({ name: "stop", arguments: { deviceId } });
            expect(stopped.isError, toolText(stopped)).not.toBe(true);
            expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "stopped", runtime: null, appium: null, recording: null });
            const deleted = await c.client.callTool({ name: "delete", arguments: { deviceId, deleteAvd: true, confirmDestructive: true } });
            expect(deleted.isError, toolText(deleted)).not.toBe(true); expect(androidRawState(c.homeDir, ownerId).devices).toEqual([]);
        }, options);
    }, 30000);

    it("native forced delete preserves registered state and AVD artifacts after failed inventory, then removes only the confirmed target", async () => {
        await withAndroidLifecycleFixture("delete-inventory-" + route, async (c, ownerId) => {
            const deviceId = "android-delete-facts", serial = "emulator-5678", avdName = `ccc-${ownerId}-delete-facts`;
            const created = await c.client.callTool({ name: "create_android_emulator", arguments: { deviceId, name: "Delete Facts", avdName, port: 5678, systemImage: ANDROID_SYSTEM_IMAGE } });
            expect(created.isError, toolText(created)).not.toBe(true);
            const state = androidRawState(c.homeDir, ownerId), original = { ...state.devices[0], status: "running", recording: { active: false, remotePath: "/sdcard/preserve.mp4" }, appium: { sessionId: "preserve" } };
            writeFileSync(androidStatePath(c.homeDir, ownerId), JSON.stringify({ ...state, devices: [original] }));
            writeFileSync(join(c.homeDir, "fake-adb-active-" + serial), avdName);
            writeFileSync(join(c.homeDir, "fake-adb-devices-fail"), "1");
            try {
                const refused = await c.client.callTool({ name: "delete", arguments: { deviceId, force: true, deleteAvd: true, confirmDestructive: true } });
                expect(refused.isError, toolText(refused)).toBe(true);
                expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "running", recording: original.recording, appium: original.appium });
                expect(existsSync(join(c.homeDir, ".android", "avd", avdName + ".avd"))).toBe(true);
                expect(readFileSync(c.logPath, "utf8")).not.toContain(`adb -s ${serial} emu kill`);
            } finally { rmSync(join(c.homeDir, "fake-adb-devices-fail"), { force: true }); }
            const deleted = await c.client.callTool({ name: "delete", arguments: { deviceId, force: true, deleteAvd: true, confirmDestructive: true } });
            expect(deleted.isError, toolText(deleted)).not.toBe(true);
            expect(androidRawState(c.homeDir, ownerId).devices).toEqual([]);
            expect(existsSync(join(c.homeDir, ".android", "avd", avdName + ".avd"))).toBe(false);
        }, options);
    }, 30000);

    it("native foreign serial identity prevents both recorder pkill and emulator kill before an exact-target retry", async () => {
        await withAndroidLifecycleFixture("foreign-serial-" + route, async (c, ownerId) => {
            const deviceId = "android-serial-reused", serial = "emulator-5678", avdName = `ccc-${ownerId}-serial-reused`;
            const created = await c.client.callTool({ name: "create_android_emulator", arguments: { deviceId, name: "Serial Reused", avdName, port: 5678, systemImage: ANDROID_SYSTEM_IMAGE } });
            expect(created.isError, toolText(created)).not.toBe(true);
            const state = androidRawState(c.homeDir, ownerId), original = { ...state.devices[0], status: "running", recording: { active: true, remotePath: "/sdcard/preserve.mp4" }, appium: { sessionId: "preserve" } };
            writeFileSync(androidStatePath(c.homeDir, ownerId), JSON.stringify({ ...state, devices: [original] }));
            const activePath = join(c.homeDir, "fake-adb-active-" + serial);
            writeFileSync(activePath, "foreign_avd");
            const before = readFileSync(c.logPath, "utf8");
            const refused = await c.client.callTool({ name: "stop", arguments: { deviceId } });
            expect(refused.isError, toolText(refused)).toBe(true);
            expect(readFileSync(c.logPath, "utf8").slice(before.length)).not.toContain(`adb -s ${serial} shell pkill`);
            expect(readFileSync(c.logPath, "utf8").slice(before.length)).not.toContain(`adb -s ${serial} emu kill`);
            expect(readFileSync(activePath, "utf8")).toBe("foreign_avd");
            expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "running", recording: original.recording, appium: original.appium });
            // The AVD may change after admission. Exercise each serial effect's
            // own identity check with and without the recorder cleanup phase.
            for (const recordingActive of [true, false]) {
                const current = androidRawState(c.homeDir, ownerId);
                writeFileSync(androidStatePath(c.homeDir, ownerId), JSON.stringify({ ...current, devices: [{ ...current.devices[0], recording: { ...original.recording, active: recordingActive } }] }));
                writeFileSync(activePath, avdName);
                writeFileSync(join(c.homeDir, "fake-stop-reuse-after-identity"), "1");
                const changed = await c.client.callTool({ name: "stop", arguments: { deviceId } });
                expect(changed.isError, toolText(changed)).toBe(true);
                expect(readFileSync(activePath, "utf8")).toBe("foreign_avd");
                expect(readFileSync(c.logPath, "utf8").slice(before.length)).not.toContain(`adb -s ${serial} shell pkill`);
                expect(readFileSync(c.logPath, "utf8").slice(before.length)).not.toContain(`adb -s ${serial} emu kill`);
            }
            const current = androidRawState(c.homeDir, ownerId);
            writeFileSync(androidStatePath(c.homeDir, ownerId), JSON.stringify({ ...current, devices: [{ ...current.devices[0], recording: original.recording }] }));
            writeFileSync(activePath, avdName);
            const stopped = await c.client.callTool({ name: "stop", arguments: { deviceId } });
            expect(stopped.isError, toolText(stopped)).not.toBe(true);
            const effects = readFileSync(c.logPath, "utf8").slice(before.length);
            expect(effects.match(new RegExp(`adb -s ${serial} shell pkill`, "g"))).toHaveLength(1);
            expect(effects.match(new RegExp(`adb -s ${serial} emu kill`, "g"))).toHaveLength(1);
            expect(existsSync(activePath)).toBe(false);
        }, options);
    }, 30000);

    it("native stale recorder no-match permits emulator stop while nonzero emulator kill still fails", async () => {
        await withAndroidLifecycleFixture("stale-recorder-" + route, async (c, ownerId) => {
            const deviceId = "android-stale-recorder", serial = "emulator-5678", avdName = `ccc-${ownerId}-stale-recorder`;
            const created = await c.client.callTool({ name: "create_android_emulator", arguments: { deviceId, name: "Stale Recorder", avdName, port: 5678 } });
            expect(created.isError, toolText(created)).not.toBe(true);
            const state = androidRawState(c.homeDir, ownerId);
            writeFileSync(androidStatePath(c.homeDir, ownerId), JSON.stringify({ ...state, devices: [{ ...state.devices[0], status: "running", recording: { active: true, remotePath: "/sdcard/stale.mp4" }, appium: { sessionId: "old-session" } }] }));
            const activePath = join(c.homeDir, "fake-adb-active-" + serial);
            writeFileSync(activePath, avdName);
            writeFileSync(join(c.homeDir, "fake-adb-pkill-no-match"), "1");
            const before = readFileSync(c.logPath, "utf8");
            const stopped = await c.client.callTool({ name: "stop", arguments: { deviceId } });
            expect(stopped.isError, toolText(stopped)).not.toBe(true);
            expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "stopped", pid: null, runtime: null, recording: null, appium: null, lifecycle: null });
            const effects = readFileSync(c.logPath, "utf8").slice(before.length);
            const serialEffects = effects.split("\n").filter(line => / shell pkill | emu kill$/.test(line));
            expect(serialEffects).toEqual([`adb -s ${serial} shell pkill -2 screenrecord`, `adb -s ${serial} emu kill`]);
            expect(existsSync(activePath)).toBe(false);

            // An identical nonzero/empty result from emu kill is a real failure,
            // not the recorder command's documented absence result.
            const current = androidRawState(c.homeDir, ownerId);
            writeFileSync(androidStatePath(c.homeDir, ownerId), JSON.stringify({ ...current, devices: [{ ...current.devices[0], status: "running" }] }));
            writeFileSync(activePath, avdName);
            writeFileSync(join(c.homeDir, "fake-adb-emu-kill-fail"), "1");
            try {
                const failed = await c.client.callTool({ name: "stop", arguments: { deviceId } });
                expect(failed.isError, toolText(failed)).toBe(true);
                expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "running", avdName });
                expect(readFileSync(activePath, "utf8")).toBe(avdName);
            } finally { rmSync(join(c.homeDir, "fake-adb-emu-kill-fail"), { force: true }); }
        }, options);
    }, 30000);

    it("native registered non-prefixed AVD stops but never grants owner artifact deletion", async () => {
        await withAndroidLifecycleFixture("registered-stop-" + route, async (c, ownerId) => {
            const deviceId = "android-registered-host";
            const activePath = join(c.homeDir, "fake-adb-active-emulator-5554");
            rmSync(activePath);
            const created = await c.client.callTool({ name: "create_android_emulator", arguments: { deviceId, name: "Registered Host", avdName: "host_pixel", port: 5554 } });
            expect(created.isError, toolText(created)).not.toBe(true);
            writeFileSync(activePath, "host_pixel");
            const stopped = await c.client.callTool({ name: "stop", arguments: { deviceId } });
            expect(stopped.isError, toolText(stopped)).not.toBe(true);
            expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "stopped", avdName: "host_pixel" });
            expect(readFileSync(c.logPath, "utf8")).toContain("adb -s emulator-5554 emu kill");
            const refused = await c.client.callTool({ name: "delete", arguments: { deviceId, deleteAvd: true, confirmDestructive: true } });
            expect(refused.isError, toolText(refused)).toBe(true); expect(toolText(refused)).toContain("non-owned Android AVD name");
            expect(androidRawState(c.homeDir, ownerId).devices).toHaveLength(1);
            expect(readFileSync(c.logPath, "utf8")).not.toContain("avdmanager delete");
            const deleted = await c.client.callTool({ name: "delete", arguments: { deviceId, confirmDestructive: true } });
            expect(deleted.isError, toolText(deleted)).not.toBe(true);
        }, options);
    }, 30000);

    it.each(["inventory", "empty-identity"] as const)("native observation expiry after %s refuses the next callback without a zero-timeout dispatch", async phase => {
        await withAndroidLifecycleFixture("stop-native-deadline-" + route, async (c, ownerId) => {
            const deviceId = "android-native-deadline", serial = "emulator-5678", avdName = `ccc-${ownerId}-native-deadline`;
            const created = await c.client.callTool({ name: "create_android_emulator", arguments: { deviceId, name: "Native Deadline", avdName, port: 5678 } });
            expect(created.isError, toolText(created)).not.toBe(true);
            writeFileSync(join(c.homeDir, "fake-adb-active-" + serial), avdName);
            writeFileSync(join(c.homeDir, phase === "inventory" ? "fake-stop-expire-after-inventory" : "fake-stop-expire-after-empty-identity"), "1");
            const before = readFileSync(c.logPath, "utf8");
            const refused = await c.client.callTool({ name: "stop", arguments: { deviceId } });
            expect(refused.isError, toolText(refused)).toBe(true); expect(toolText(refused)).toContain("deadline-exhausted");
            const calls = readFileSync(c.logPath, "utf8").slice(before.length);
            expect(calls).not.toContain("android-avd-liveness process-query");
            expect(calls).not.toContain(`adb -s ${serial} emu kill`);
            if (phase === "inventory") expect(calls).not.toContain(`adb -s ${serial} emu avd`);
            else expect(calls.match(new RegExp(`adb -s ${serial} emu avd`, "g"))).toHaveLength(1);
            expect(androidRawState(c.homeDir, ownerId).devices[0]).toMatchObject({ status: "stopped", avdName });
        }, options);
    }, 30000);
});
