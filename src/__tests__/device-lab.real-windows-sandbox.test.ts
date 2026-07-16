import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    cleanupPreviousWindowsSandboxE2E,
    findImageContent,
    runWindowsSandboxE2E,
    stopRunningWindowsSandboxSessions,
    windowsRecordingPayload,
    windowsRecordingState,
    windowsSandboxSessionIdsFromListOutput,
    windowsSandboxE2ECapability,
} from "../../scripts/real-tests/windows-sandbox-e2e.mjs";
import { windowsBackend } from "../../device-lab-mcp/src/backends/windows-sandbox.mjs";

const level = Number(process.env.CCC_TEST_LEVEL || "0");
const enabled = level >= 2;
const cap = windowsSandboxE2ECapability(level);
const title = cap.available
    ? "creates, starts, drives helper actions, stops, and deletes an owner-scoped Windows Sandbox"
    : `skips Windows Sandbox helper E2E (${cap.reason})`;

describe.runIf(enabled)("level 2 real Windows Sandbox helper E2E", () => {
    it.skipIf(!cap.available)(title, async () => {
        const result = await runWindowsSandboxE2E({ level, helperTimeoutMs: 30000 });
        expect(result).toEqual(expect.objectContaining({
            status: "PASS",
            deviceId: expect.stringMatching(/^windows-real-sandbox-/),
            sandboxId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            verifiedCapabilities: expect.arrayContaining(windowsBackend().capabilities),
        }));
    }, 240000);
});

describe("Windows Sandbox real E2E cleanup preflight", () => {
    it("normalizes recording responses from broker and backend result shapes", () => {
        const recording = { active: true, provider: "windows-helper-frame-archive" };
        const direct = { deviceId: "win-direct", recording, provider: "windows-helper-frame-archive" };
        const nested = { result: { deviceId: "win-nested", recording } };
        const bare = { active: true, sessionId: "recording-bare" };

        expect(windowsRecordingPayload(direct)).toBe(direct);
        expect(windowsRecordingPayload(nested)).toBe(nested.result);
        expect(windowsRecordingState(direct)).toBe(recording);
        expect(windowsRecordingState(nested)).toBe(recording);
        expect(windowsRecordingState(bare)).toBe(bare);
    });

    it("finds image content without depending on MCP content ordering", () => {
        const image = { type: "image", mimeType: "image/png", data: "AAAA" };
        expect(findImageContent({ content: [{ type: "text", text: "metadata" }, image] })).toBe(image);
        expect(findImageContent({ content: [{ type: "text", text: "error" }] })).toBeNull();
    });

    it("extracts and stops running sandbox sessions from raw list output", () => {
        const calls: Array<{ command: string; args: string[]; options?: { windowsHide?: boolean } }> = [];
        const result = stopRunningWindowsSandboxSessions({
            wsb: "wsb",
            runner(command: string, args: string[], options?: { windowsHide?: boolean }) {
                calls.push({ command, args, options });
                if (args[0] === "list") {
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            sessions: [
                                { id: "12345678-1234-4234-9234-1234567890ab", status: "running" },
                            ],
                        }),
                        stderr: "",
                    };
                }
                return { status: 0, stdout: "", stderr: "" };
            },
        });
        expect(windowsSandboxSessionIdsFromListOutput("session 12345678-1234-4234-9234-1234567890ab")).toEqual([
            "12345678-1234-4234-9234-1234567890ab",
        ]);
        expect(result).toEqual({ ok: true, stopped: ["12345678-1234-4234-9234-1234567890ab"], failed: [] });
        expect(calls).toEqual([
            { command: "wsb", args: ["list", "--raw"], options: expect.objectContaining({ windowsHide: true }) },
            { command: "wsb", args: ["stop", "--id", "12345678-1234-4234-9234-1234567890ab"], options: expect.objectContaining({ windowsHide: true }) },
        ]);
    });

    it("cleans only prior owner-scoped real E2E devices and stale locks", async () => {
        const homeDir = join(tmpdir(), `ccc-windows-e2e-cleanup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const owner = "windows-e2e-cleanup-owner";
        try {
            const windowsRoot = join(homeDir, ".ccc/devices/owners", owner, "windows");
            mkdirSync(join(windowsRoot, "windows-real-sandbox-old"), { recursive: true });
            mkdirSync(join(windowsRoot, "windows-real-sandbox-orphan"), { recursive: true });
            mkdirSync(join(windowsRoot, "windows-keep"), { recursive: true });
            writeFileSync(join(windowsRoot, "devices.json"), JSON.stringify({
                devices: [
                    { id: "windows-real-sandbox-old", backend: "windows-sandbox", status: "stopped" },
                    { id: "windows-keep", backend: "windows-sandbox", status: "stopped" },
                ],
            }));
            const lockPath = join(homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
            mkdirSync(join(homeDir, ".ccc/devices/host-locks"), { recursive: true });
            writeFileSync(lockPath, JSON.stringify({ ownerId: owner, deviceId: "windows-real-sandbox-old" }));

            await cleanupPreviousWindowsSandboxE2E({ homeDir, ownerId: owner, skipProviderCleanup: true });

            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf-8")) as { devices: Array<{ id: string }> };
            expect(state.devices).toEqual([{ id: "windows-keep", backend: "windows-sandbox", status: "stopped" }]);
            expect(existsSync(join(windowsRoot, "windows-real-sandbox-old"))).toBe(false);
            expect(existsSync(join(windowsRoot, "windows-real-sandbox-orphan"))).toBe(false);
            expect(existsSync(join(windowsRoot, "windows-keep"))).toBe(true);
            expect(existsSync(lockPath)).toBe(false);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
