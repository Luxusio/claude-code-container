import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
    cleanupCurrentWindowsSandboxE2E,
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

function toolResult(payload: unknown, isError = false) {
    return { isError, content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload) }] };
}

function createCleanupEvidence(homeDir: string, owner: string, device: Record<string, unknown>) {
    const windowsRoot = join(homeDir, ".ccc/devices/owners", owner, "windows");
    const deviceId = String(device.id);
    mkdirSync(join(windowsRoot, deviceId), { recursive: true });
    writeFileSync(join(windowsRoot, "devices.json"), JSON.stringify({ devices: [device] }));
    const lockPath = join(homeDir, ".ccc/devices/host-locks/windows-sandbox.json");
    mkdirSync(join(homeDir, ".ccc/devices/host-locks"), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ ownerId: owner, deviceId }));
    return { windowsRoot, deviceId, lockPath, deviceDir: join(windowsRoot, deviceId) };
}

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

    it("extracts sessions but stops only the verified test-owned session", () => {
        const calls: Array<{ command: string; args: string[]; options?: { windowsHide?: boolean } }> = [];
        const result = stopRunningWindowsSandboxSessions({
            wsb: "wsb",
            verifiedSessionIds: ["12345678-1234-4234-9234-1234567890ab"],
            preExistingSessionIds: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
            runner(command: string, args: string[], options?: { windowsHide?: boolean }) {
                calls.push({ command, args, options });
                if (args[0] === "list") {
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            sessions: [
                                { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "running" },
                                { id: "12345678-1234-4234-9234-1234567890ab", status: "running" },
                                { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "running" },
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

    it("removes previous cleanup evidence only after verified provider deletion", async () => {
        const homeDir = join(tmpdir(), `ccc-windows-e2e-cleanup-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const owner = "windows-e2e-cleanup-owner";
        try {
            const { windowsRoot, deviceId, deviceDir, lockPath } = createCleanupEvidence(homeDir, owner, {
                id: "windows-real-sandbox-old",
                backend: "windows-sandbox",
                status: "stopped",
            });
            mkdirSync(join(windowsRoot, "windows-keep"), { recursive: true });
            writeFileSync(join(windowsRoot, "devices.json"), JSON.stringify({
                devices: [
                    { id: deviceId, backend: "windows-sandbox", status: "stopped" },
                    { id: "windows-keep", backend: "windows-sandbox", status: "stopped" },
                ],
            }));

            await cleanupPreviousWindowsSandboxE2E({
                homeDir,
                ownerId: owner,
                callTool: async (tool: string) => {
                    expect(tool).toBe("device_delete");
                    return toolResult({ deleted: deviceId });
                },
            });

            const state = JSON.parse(readFileSync(join(windowsRoot, "devices.json"), "utf-8")) as { devices: Array<{ id: string }> };
            expect(state.devices).toEqual([{ id: "windows-keep", backend: "windows-sandbox", status: "stopped" }]);
            expect(existsSync(deviceDir)).toBe(false);
            expect(existsSync(join(windowsRoot, "windows-keep"))).toBe(true);
            expect(existsSync(lockPath)).toBe(false);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("preserves previous cleanup state, directory, and singleton when stop fails", async () => {
        const homeDir = join(tmpdir(), `ccc-windows-e2e-stop-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const owner = "windows-e2e-cleanup-owner";
        const evidence = createCleanupEvidence(homeDir, owner, {
            id: "windows-real-sandbox-running",
            backend: "windows-sandbox",
            status: "running",
            sandboxId: "11111111-1111-4111-8111-111111111111",
        });
        const calls: string[] = [];
        try {
            await expect(cleanupPreviousWindowsSandboxE2E({
                homeDir,
                ownerId: owner,
                callTool: async (tool: string) => {
                    calls.push(tool);
                    throw new Error("stop denied");
                },
            })).rejects.toThrow(/cleanup was not verified/);
            expect(calls).toEqual(["device_stop"]);
            expect(existsSync(evidence.deviceDir)).toBe(true);
            expect(existsSync(evidence.lockPath)).toBe(true);
            expect(readFileSync(join(evidence.windowsRoot, "devices.json"), "utf-8")).toContain(evidence.deviceId);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("preserves finally-path evidence when verified deletion fails", async () => {
        const homeDir = join(tmpdir(), `ccc-windows-e2e-delete-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const owner = "windows-e2e-cleanup-owner";
        const evidence = createCleanupEvidence(homeDir, owner, {
            id: "windows-real-sandbox-current",
            backend: "windows-sandbox",
            status: "stopped",
            sandboxId: "22222222-2222-4222-8222-222222222222",
        });
        try {
            await expect(cleanupCurrentWindowsSandboxE2E({
                homeDir,
                ownerId: owner,
                deviceId: evidence.deviceId,
                callTool: async () => toolResult("delete failed", true),
            })).rejects.toThrow(/device_delete failed.*ownership evidence was preserved/);
            expect(existsSync(evidence.deviceDir)).toBe(true);
            expect(existsSync(evidence.lockPath)).toBe(true);
            expect(readFileSync(join(evidence.windowsRoot, "devices.json"), "utf-8")).toContain(evidence.deviceId);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it.each([
        { operation: "recording cleanup", recordingActive: true, needsStop: true, firstTool: "device_record_video_stop" },
        { operation: "device_stop", recordingActive: false, needsStop: true, firstTool: "device_stop" },
    ])("preserves finally-path evidence when $operation fails", async ({ recordingActive, needsStop, firstTool }) => {
        const homeDir = join(tmpdir(), `ccc-windows-e2e-provider-failure-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const owner = "windows-e2e-cleanup-owner";
        const evidence = createCleanupEvidence(homeDir, owner, {
            id: "windows-real-sandbox-current-running",
            backend: "windows-sandbox",
            status: "running",
            recording: recordingActive ? { active: true } : undefined,
        });
        const calls: string[] = [];
        try {
            await expect(cleanupCurrentWindowsSandboxE2E({
                homeDir,
                ownerId: owner,
                deviceId: evidence.deviceId,
                recordingActive,
                needsStop,
                callTool: async (tool: string) => {
                    calls.push(tool);
                    throw new Error("provider cleanup failed");
                },
            })).rejects.toThrow(/ownership evidence was preserved/);
            expect(calls).toEqual([firstTool]);
            expect(existsSync(evidence.deviceDir)).toBe(true);
            expect(existsSync(evidence.lockPath)).toBe(true);
            expect(readFileSync(join(evidence.windowsRoot, "devices.json"), "utf-8")).toContain(evidence.deviceId);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });

    it("preserves orphan directories because runtime absence cannot be verified", async () => {
        const homeDir = join(tmpdir(), `ccc-windows-e2e-orphan-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const owner = "windows-e2e-cleanup-owner";
        const orphan = join(homeDir, ".ccc/devices/owners", owner, "windows", "windows-real-sandbox-orphan");
        try {
            mkdirSync(orphan, { recursive: true });
            await expect(cleanupPreviousWindowsSandboxE2E({ homeDir, ownerId: owner })).rejects.toThrow(/cleanup was not verified/);
            expect(existsSync(orphan)).toBe(true);
        } finally {
            rmSync(homeDir, { recursive: true, force: true });
        }
    });
});
