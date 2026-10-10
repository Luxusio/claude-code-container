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
    createBrokerRecordingApplication({ ...ports, signal: async () => ({ attempted: true, ok: true }) });
    void [status, mutations, _publish];
}
void recordingCapabilityContracts;

describe("recording generation contract", () => {
    it("refuses a different recording generation even when the process ID is unchanged", () => {
        const expected = { runtimeId: "previous", pid: 12345 };
        expect(recordingRuntimeMatches(expected, { ...expected })).toBe(true);
        expect(recordingRuntimeMatches(expected, { ...expected, runtimeId: "successor" })).toBe(false);
    });
});
