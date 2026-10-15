import { describe, expect, it } from "vitest";
import { createBrokerRecordingApplication } from "../../../packages/device-lab/src/device-lab/application/broker-recording.js";
import { recordingRuntimeMatches, type BrokerRecordingRequest, type BrokerRecordingResponse } from "../../../packages/device-lab/src/device-lab/domain/broker-recording.js";
import type { BrokerRecordingArtifactContext, BrokerRecordingPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-recording.js";

function recordingCapabilityContracts(ports: BrokerRecordingPorts, request: BrokerRecordingRequest): void {
    const app = createBrokerRecordingApplication(ports);
    const status: BrokerRecordingResponse = app.status("owner", request);
    const mutations: Promise<BrokerRecordingResponse>[] = [app.start("owner", request), app.stop("owner", request)];
    const { publish: _publish, ...withoutPublication } = ports;
    // @ts-expect-error Recording state changes require the native expected-record publication authority.
    createBrokerRecordingApplication(withoutPublication);
    // @ts-expect-error Signaling must return its actual synchronous ownership/termination admission result.
    createBrokerRecordingApplication({ ...ports, signal: async () => ({ attempted: true, ok: true, receipt: {} }) });
    const { launchAndroidRecording, ...withoutAndroidLaunch } = ports;
    // @ts-expect-error Android launch is a required finite native effect.
    createBrokerRecordingApplication(withoutAndroidLaunch);
    // @ts-expect-error Artifact pull must settle before publication.
    createBrokerRecordingApplication({ ...ports, pullAndroidRecording: async () => ({ ok: true, refusal: null, receipt: {} }) });
    const context: BrokerRecordingArtifactContext = {
        ownerId: "owner", target: { stateKey: "android", backend: "android-emulator", device: { id: "pixel" } },
        recording: { active: false, runtimeId: "runtime", stoppedAt: "2026-10-13T00:00:00.000Z", artifactCopyPending: true, artifactCopied: true },
    };
    ports.stopAndroidRecording(context, "emulator-5580");
    ports.pullAndroidRecording(context, "emulator-5580", "/sdcard/video.mp4", "/private/video.mp4");
    ports.removeAndroidRecording(context, "emulator-5580", "/sdcard/video.mp4");
    ports.publish("owner", "android", "pixel", context.recording, null, context.target);
    // @ts-expect-error Publication requires the captured device identity as well as the recording.
    ports.publish("owner", "android", "pixel", context.recording, null);
    // @ts-expect-error A serial alone carries no recording generation or owner authority.
    ports.stopAndroidRecording("emulator-5580");
    // @ts-expect-error Artifact copying requires the captured recording and target.
    ports.pullAndroidRecording("emulator-5580", "/sdcard/video.mp4", "/private/video.mp4");
    // @ts-expect-error Remote removal requires the captured recording and target.
    ports.removeAndroidRecording("emulator-5580", "/sdcard/video.mp4");
    // @ts-expect-error A captured artifact context cannot omit the expected recording.
    const incompleteContext: BrokerRecordingArtifactContext = { ownerId: "owner", target: context.target };
    // @ts-expect-error Recording outcomes do not expose CCC HTTP response status.
    status.status;
    // @ts-expect-error The recording core has no arbitrary native process runner.
    ports.execute({ executable: "provider", args: [] });
    void [status, mutations, _publish, launchAndroidRecording, incompleteContext];
}
void recordingCapabilityContracts;

describe("recording generation contract", () => {
    it("refuses a different recording generation even when the process ID is unchanged", () => {
        const expected = { runtimeId: "previous", pid: 12345 };
        expect(recordingRuntimeMatches(expected, { ...expected })).toBe(true);
        expect(recordingRuntimeMatches(expected, { ...expected, runtimeId: "successor" })).toBe(false);
    });

    it.each([
        { active: false }, { artifactCopyPending: true }, { artifactCopied: true },
        { stoppedAt: "2026-10-13T00:00:00.000Z" }, { remotePath: "/sdcard/replacement.mp4" },
        { localPath: "/private/replacement.mp4" },
    ])("refuses stale captured recovery state with the same runtime: %j", changed => {
        const expected = { runtimeId: "runtime", pid: 12345, active: true, remotePath: "/sdcard/video.mp4", localPath: "/private/video.mp4" };
        expect(recordingRuntimeMatches(expected, { ...expected, ...changed })).toBe(false);
    });

    it("matches an unchanged recovery receipt and rejects a newer copy-complete receipt", () => {
        const pending = { runtimeId: "runtime", pid: 12345, active: false, artifactCopyPending: true, stoppedAt: "2026-10-13T00:00:00.000Z" };
        expect(recordingRuntimeMatches(pending, { ...pending })).toBe(true);
        expect(recordingRuntimeMatches(pending, { ...pending, artifactCopied: true })).toBe(false);
    });
});
