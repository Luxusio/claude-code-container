import { describe, expect, it } from "vitest";
import { createBrokerRecordingApplication } from "../../../packages/device-lab/src/device-lab/application/broker-recording.js";
import { recordingRuntimeMatches, type BrokerRecordingRequest, type BrokerRecordingResponse } from "../../../packages/device-lab/src/device-lab/domain/broker-recording.js";
import type { BrokerRecordingPorts } from "../../../packages/device-lab/src/device-lab/ports/broker-recording.js";

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
    createBrokerRecordingApplication({ ...ports, pullAndroidRecording: async () => ({ status: 0, receipt: {} }) });
    // @ts-expect-error Recording outcomes do not expose CCC HTTP response status.
    status.status;
    // @ts-expect-error The recording core has no arbitrary native process runner.
    ports.execute({ executable: "provider", args: [] });
    void [status, mutations, _publish, launchAndroidRecording];
}
void recordingCapabilityContracts;

describe("recording generation contract", () => {
    it("refuses a different recording generation even when the process ID is unchanged", () => {
        const expected = { runtimeId: "previous", pid: 12345 };
        expect(recordingRuntimeMatches(expected, { ...expected })).toBe(true);
        expect(recordingRuntimeMatches(expected, { ...expected, runtimeId: "successor" })).toBe(false);
    });
});
