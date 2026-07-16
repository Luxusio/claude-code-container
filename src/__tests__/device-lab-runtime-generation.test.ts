import { describe, expect, it } from "vitest";
import {
    appiumGenerationMatches,
    claimRecordingFinalization,
    recordingGenerationMatches,
    runtimeGenerationMatches,
    transitionAppiumGeneration,
    transitionRecordingGeneration,
} from "../../device-lab-mcp/src/state/runtime-generation.mjs";

describe("device runtime generation fencing", () => {
    it("uses runtime ids instead of reusable process identities", () => {
        const first = { runtimeId: "first", pid: 42, provider: "recorder" };
        const successor = { runtimeId: "successor", pid: 42, provider: "recorder" };

        expect(recordingGenerationMatches(first, first)).toBe(true);
        expect(recordingGenerationMatches(first, successor)).toBe(false);
        expect(recordingGenerationMatches(first, { pid: 42, provider: "recorder" })).toBe(false);
    });

    it("supports legacy records only when every identity field matches", () => {
        const legacy = {
            pid: 42,
            provider: "recorder",
            startedAt: "2026-07-14T00:00:00.000Z",
            localPath: "/tmp/recording.mp4",
        };

        expect(recordingGenerationMatches(legacy, { ...legacy })).toBe(true);
        expect(recordingGenerationMatches(legacy, { ...legacy, pid: 43 })).toBe(false);
        expect(recordingGenerationMatches({}, {})).toBe(false);
        expect(runtimeGenerationMatches(null, undefined)).toBe(true);
        expect(runtimeGenerationMatches(null, legacy)).toBe(false);
    });

    it("preserves a successor when a stale generation tries to transition", () => {
        let device = { id: "device-1", recording: { runtimeId: "successor", pid: 42 } };
        const updateDevice = (_id: string, updater: (current: typeof device) => typeof device) => {
            device = updater(device);
            return device;
        };

        const stale = transitionRecordingGeneration(
            updateDevice,
            device.id,
            { runtimeId: "stale", pid: 42 },
            null,
            "2026-07-14T00:00:00.000Z",
        );
        expect(stale.committed).toBe(false);
        expect(device.recording).toEqual({ runtimeId: "successor", pid: 42 });

        const current = transitionRecordingGeneration(
            updateDevice,
            device.id,
            device.recording,
            null,
            "2026-07-14T00:00:01.000Z",
        );
        expect(current.committed).toBe(true);
        expect(device.recording).toBeNull();
    });

    it("claims finalization with a fresh generation before artifact commit", () => {
        const recording = { runtimeId: "recorder", pid: 42, active: true, localPath: "/tmp/old.mp4" };
        let device = { id: "device-1", recording };
        const updateDevice = (_id: string, updater: (current: typeof device) => typeof device) => {
            device = updater(device);
            return device;
        };

        const claimed = claimRecordingFinalization(
            updateDevice,
            device.id,
            recording,
            { localPath: "/tmp/final.mp4" },
            "2026-07-14T00:00:00.000Z",
        );
        expect(claimed.committed).toBe(true);
        expect(device.recording).toEqual(expect.objectContaining({
            active: false,
            recorderRuntimeId: "recorder",
            runtimeId: expect.any(String),
            localPath: "/tmp/final.mp4",
            finalizingAt: "2026-07-14T00:00:00.000Z",
        }));
        expect(device.recording.runtimeId).not.toBe("recorder");
        expect(recordingGenerationMatches(recording, device.recording)).toBe(false);
    });

    it("preserves a successor Appium runtime when a pid is reused", () => {
        const stale = { runtimeId: "appium-stale", serverPid: 42, sessionId: "session-stale" };
        const successor = { runtimeId: "appium-successor", serverPid: 42, sessionId: "session-current" };
        let device = { id: "device-1", appium: successor };
        const updateDevice = (_id: string, updater: (current: typeof device) => typeof device) => {
            device = updater(device);
            return device;
        };

        expect(appiumGenerationMatches(stale, successor)).toBe(false);
        const transition = transitionAppiumGeneration(updateDevice, device.id, stale, null);
        expect(transition.committed).toBe(false);
        expect(device.appium).toEqual(successor);
    });
});
