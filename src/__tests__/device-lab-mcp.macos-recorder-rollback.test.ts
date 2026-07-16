import { chmodSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupFakeMacosMcpContext, createFakeMacosMcpContext, type FakeMacosMcpContext } from "./helpers/fake-macos-mcp-fixture.js";

const persistenceFailure = vi.hoisted(() => ({
    armed: false,
    successor: null as Record<string, unknown> | null,
}));

vi.mock("fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs")>();
    return {
        ...actual,
        renameSync(source: string, destination: string) {
            if (persistenceFailure.armed && destination.replaceAll("\\", "/").endsWith("/macos/devices.json")) {
                persistenceFailure.armed = false;
                const state = JSON.parse(actual.readFileSync(source, "utf8")) as { devices: Array<Record<string, unknown>> };
                const devices = state.devices.map((device) => device.id === "macos-rollback-recorder"
                    ? { ...device, recording: persistenceFailure.successor }
                    : device);
                actual.writeFileSync(destination, JSON.stringify({ devices }, null, 2));
                throw new Error("injected-recorder-metadata-write-failure");
            }
            return actual.renameSync(source, destination);
        },
    };
});

import { handleMacosTool } from "../../device-lab-mcp/src/backends/macos-vm.mjs";

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
    let recorderPidPath: string;

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
        const started = await handleMacosTool("device_start", { deviceId: "macos-rollback-recorder" });
        expect(started?.isError).not.toBe(true);

        recorderPidPath = join(context.homeDir, "recorder.pid");
        writeFileSync(join(context.binDir, "ssh"), `#!/bin/sh
case "$*" in
  *screencapture*"-v"*) echo $$ > "$RECORDER_PID_PATH"; exec /bin/sleep 20 ;;
  *) exit 0 ;;
esac
`);
        chmodSync(join(context.binDir, "ssh"), 0o755);
        process.env.RECORDER_PID_PATH = recorderPidPath;
    });

    afterAll(() => {
        delete process.env.RECORDER_PID_PATH;
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
            deviceId: "macos-rollback-recorder",
            remotePath: "/tmp/rollback.mov",
            localPath: join(context.homeDir, "rollback.mov"),
        });

        expect(result?.isError).toBe(true);
        expect((result?.content as Array<{ text?: string }>)[0].text).toContain("metadata persistence failed");
        const recorderPid = Number(readFileSync(recorderPidPath, "utf8").trim());
        expect(Number.isSafeInteger(recorderPid)).toBe(true);
        expect(await waitForPidExit(recorderPid)).toBe(true);

        const ownersRoot = join(context.homeDir, ".ccc", "devices", "owners");
        const statePath = join(ownersRoot, readdirSync(ownersRoot)[0], "macos", "devices.json");
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { devices: Array<{ id: string; recording?: unknown }> };
        expect(state.devices.find((device) => device.id === "macos-rollback-recorder")?.recording).toEqual(successor);
    });
});
