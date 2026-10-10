import { describe, expect, it } from "vitest";
import { createIosControlTransfer } from "../../../packages/device-lab/providers/application/ios-control-transfer.mjs";
import { iosControlRequest } from "../../../packages/device-lab/providers/domain/ios-control-transfer.mjs";
import type { IosSimulatorControlPorts } from "../../../packages/device-lab/providers/ports/ios-control-transfer.mjs";

// Consumed by the ordinary strict test scope; never invokes native capabilities.
export function requiredIosCapabilities(ports: IosSimulatorControlPorts<object>) {
    const application = createIosControlTransfer(ports);
    const response: Promise<object | undefined> = application.handle("mobile_home", { deviceId: "owned" });
    const { requestSession, ...missingSessionRequest } = ports;
    // @ts-expect-error session HTTP is a required capability
    createIosControlTransfer(missingSessionRequest);
    const { commitOutput, ...missingCommit } = ports;
    // @ts-expect-error publication is required for simulator downloads
    createIosControlTransfer(missingCommit);
    // @ts-expect-error synchronous stage disposal cannot be replaced by an asynchronous effect
    createIosControlTransfer({ ...ports, disposeStage: async () => undefined });
    return { response, requestSession, commitOutput };
}

describe("iOS key admission", () => {
    it("uses the explicit key before keyCode and rejects an empty key", () => {
        expect(iosControlRequest("mobile_key", { key: "Return", keyCode: 13 })).toMatchObject({
            path: "/keys", body: { text: "Return", value: ["Return"] }, payload: { key: "Return" },
        });
        expect(iosControlRequest("mobile_key", { key: "", keyCode: 13 })).toEqual({ error: "mobile_key requires key or keyCode" });
    });
});
