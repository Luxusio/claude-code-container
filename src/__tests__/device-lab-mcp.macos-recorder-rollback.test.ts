import type { SpawnOptions } from "child_process";
import { chmodSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupFakeMacosMcpContext, createFakeMacosMcpContext, type FakeMacosMcpContext } from "./helpers/fake-macos-mcp-fixture.js";
import * as processIdentity from "@ccc/device-lab/providers/state/process-identity.mjs";
import { updateMacosDevice } from "@ccc/device-lab/providers/state/macos-state.mjs";

const persistenceFailure = vi.hoisted(() => ({
    armed: false,
    deviceId: "",
    successor: null as Record<string, unknown> | null,
}));

const recorderProcess = vi.hoisted(() => ({
    executable: "",
    pid: undefined as number | undefined,
}));

vi.mock("child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("child_process")>();
    return {
        ...actual,
        spawn(command: string, args: readonly string[], options: SpawnOptions) {
            const child = actual.spawn(command, args, options);
            if (command === recorderProcess.executable && args.some((arg) => arg.includes("screencapture"))) {
                // The parent knows the real PID even when rollback kills the child
                // before its JavaScript initialization can publish anything.
                recorderProcess.pid = child.pid;
            }
            return child;
        },
    };
});

vi.mock("fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs")>();
    return {
        ...actual,
        renameSync(source: string, destination: string) {
            if (persistenceFailure.armed && destination.replaceAll("\\", "/").endsWith("/macos/devices.json")) {
                persistenceFailure.armed = false;
                const state = JSON.parse(actual.readFileSync(source, "utf8")) as { devices: Array<Record<string, unknown>> };
                const devices = state.devices.map((device) => device.id === persistenceFailure.deviceId
                    ? { ...device, recording: persistenceFailure.successor }
                    : device);
                actual.writeFileSync(destination, JSON.stringify({ devices }, null, 2));
                throw new Error("injected-recorder-metadata-write-failure");
            }
            return actual.renameSync(source, destination);
        },
    };
});

import { handleMacosTool } from "@ccc/device-lab/providers/backends/macos-vm.mjs";

async function waitForPidExit(pid: number, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
        try {
            process.kill(pid, 0);
        } catch {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
}

describe("macOS VM recorder start rollback", () => {
    let context: FakeMacosMcpContext;

    beforeAll(async () => {
        context = createFakeMacosMcpContext();
        const created = await handleMacosTool("device_create", {
            backend: "macos-vm",
            name: "Rollback Recorder",
            provider: "tart",
            image: "ghcr.io/example/macos:latest",
            sshHost: "127.0.0.1",
            sshPort: 2222,
            sshUser: "ccc",
        });
        expect(created?.isError).not.toBe(true);
        persistenceFailure.deviceId = JSON.parse((created?.content as Array<{ text: string }>)[0].text).device.id;
        const started = await handleMacosTool("device_start", { deviceId: persistenceFailure.deviceId });
        expect(started?.isError).not.toBe(true);

        recorderProcess.executable = join(context.binDir, "ssh");
        writeFileSync(join(context.binDir, "ssh"), `#!${process.execPath}
const command = process.argv.slice(2).join(" ");
if (command.includes("screencapture") && command.includes("-v")) {
    // Deliberately initialize later than the 150ms recorder readiness grace.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    setTimeout(() => {}, 20000);
}
`);
        chmodSync(join(context.binDir, "ssh"), 0o755);
    });

    afterAll(() => {
        recorderProcess.executable = "";
        recorderProcess.pid = undefined;
        persistenceFailure.armed = false;
        persistenceFailure.successor = null;
        cleanupFakeMacosMcpContext(context);
    });

    it.runIf(process.platform !== "win32")("terminates the spawned recorder and preserves successor state when metadata persistence throws", async () => {
        const successor = {
            active: true,
            provider: "successor-recorder",
            runtimeId: "successor-runtime",
            pid: 999999,
            startedAt: "2026-07-17T00:00:00.000Z",
        };
        persistenceFailure.successor = successor;
        persistenceFailure.armed = true;

        const result = await handleMacosTool("device_record_video_start", {
            deviceId: persistenceFailure.deviceId,
            remotePath: "/tmp/rollback.mov",
            localPath: join(context.homeDir, "rollback.mov"),
        });

        expect(result?.isError).toBe(true);
        expect((result?.content as Array<{ text?: string }>)[0].text).toContain("metadata persistence failed");
        const recorderPid = recorderProcess.pid;
        expect(Number.isSafeInteger(recorderPid)).toBe(true);
        expect(recorderPid).toBeGreaterThan(0);
        expect(await waitForPidExit(recorderPid!)).toBe(true);

        const ownersRoot = join(context.homeDir, ".ccc", "devices", "owners");
        const statePath = join(ownersRoot, readdirSync(ownersRoot)[0], "macos", "devices.json");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<{ id: string; recording?: unknown }> };
        expect(state.devices.find((device) => device.id === persistenceFailure.deviceId)?.recording).toEqual(successor);
    });

    it("uses the recorded process identity when PID absence cannot confirm recorder exit before image mutation", async () => {
        const created = await handleMacosTool("device_create", {
            backend: "macos-vm", name: "Unconfirmed Native Recorder Exit", provider: "tart",
        });
        expect(created?.isError).not.toBe(true);
        const deviceId = JSON.parse((created?.content as Array<{ text: string }>)[0].text).device.id as string;
        const identity = { pid: 999999, startToken: "captured-birth", commandHash: "a".repeat(64) };
        const recording = { runtimeId: "captured-recorder", pid: identity.pid, processIdentity: identity, active: false };
        const restoreRecovery = { candidateProviderInstance: "retained-native-candidate", phase: "prepared" };
        updateMacosDevice(deviceId, device => ({ ...device, status: "running", recording, restoreRecovery }));
        // The fixture already owns these two native observations. Signal succeeds,
        // but exit identity is unavailable; a nonexistent PID alone proves nothing.
        const signal = vi.mocked(processIdentity.signalOwnedRuntimeProcess);
        const inspect = vi.mocked(processIdentity.inspectProcessIdentity);
        const originalSignal = signal.getMockImplementation()!;
        const originalInspect = inspect.getMockImplementation()!;
        signal.mockReturnValue({ attempted: true, signaled: true, pid: identity.pid, signal: "SIGINT" });
        const remainingAtObservation: number[] = [];
        inspect.mockImplementation((_identity, _pid, options) => {
            if (options?.remainingMs) remainingAtObservation.push(options.remainingMs());
            return { status: "unavailable", current: null, liveness: "unknown" };
        });
        const logBefore = readFileSync(context.logPath, { encoding: "utf8", flag: "a+" });
        try {
            const result = await handleMacosTool("device_snapshot_create", { deviceId, snapshotName: "Identity Unavailable", force: true });
            expect(result?.isError).toBe(true);
            expect(JSON.parse((result?.content as Array<{ text: string }>)[0].text)).toMatchObject({
                error: "macos-recording-cleanup-incomplete", reason: "runtime-process-exit-unconfirmed",
            });
            expect(inspect).toHaveBeenCalledWith(identity, identity.pid, { remainingMs: expect.any(Function) });
            expect(remainingAtObservation).toHaveLength(1);
            expect(Number.isFinite(remainingAtObservation[0])).toBe(true);
            expect(Math.floor(remainingAtObservation[0])).toBeGreaterThanOrEqual(1);
            expect(remainingAtObservation[0]).toBeLessThanOrEqual(1000);
            const ownersRoot = join(context.homeDir, ".ccc", "devices", "owners");
            const statePath = join(ownersRoot, readdirSync(ownersRoot)[0], "macos", "devices.json");
            const state = JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<Record<string, unknown>> };
            const saved = state.devices.find(device => device.id === deviceId);
            expect(saved).toMatchObject({ status: "stopped", runtime: null, recording, restoreRecovery });
            expect(saved).not.toHaveProperty("lifecycle");
            const effects = readFileSync(context.logPath, "utf8").slice(logBefore.length);
            expect(effects).toContain("tart stop ");
            expect(effects).not.toMatch(/tart (?:clone|delete) /);
        } finally {
            signal.mockImplementation(originalSignal);
            inspect.mockImplementation(originalInspect);
            updateMacosDevice(deviceId, device => ({ ...device, recording: null, restoreRecovery: null }));
            await handleMacosTool("device_delete", { deviceId, force: true });
        }
    });
});
