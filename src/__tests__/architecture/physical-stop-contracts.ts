import { createPhysicalStopApplication } from "../../../packages/device-lab/providers/application/physical-stop.mjs";
import type { AndroidPhysicalStopPorts, IosPhysicalStopPorts, PhysicalDevice, PhysicalStopOutcome } from "../../../packages/device-lab/providers/ports/physical-stop.mjs";

declare const android: AndroidPhysicalStopPorts;
declare const ios: IosPhysicalStopPorts;
declare const device: PhysicalDevice;
const stop: Promise<PhysicalStopOutcome> = createPhysicalStopApplication(android).stop("target");
createPhysicalStopApplication(ios).cleanup(device);
const { transition, ...withoutCas } = android;
// @ts-expect-error Exact record CAS is required.
createPhysicalStopApplication(withoutCas);
// @ts-expect-error Record lookup is synchronous.
const asyncFind: AndroidPhysicalStopPorts = { ...android, find: async () => device };
// @ts-expect-error Record CAS is synchronous.
const asyncCas: AndroidPhysicalStopPorts = { ...android, transition: async () => ({ matched: true, found: true, device, currentDevice: device }) };
// @ts-expect-error Owned recorder signal is synchronous.
const asyncSignal: AndroidPhysicalStopPorts = { ...android, signalRecording: async () => ({ attempted: true, signaled: true }) };
// @ts-expect-error Exit confirmation is asynchronous.
const syncWait: AndroidPhysicalStopPorts = { ...android, waitRecordingExit: () => true };
createPhysicalStopApplication({ ...android, stopAdbRecording: () => ({ ok: false, detail: "native diagnostic" }) });
// @ts-expect-error Stop fallback must supply semantic completion and diagnostic detail.
createPhysicalStopApplication({ ...android, stopAdbRecording: () => ({ status: 0, stdout: "", stderr: "" }) });
// @ts-expect-error Failure detail is part of the semantic stop contract.
createPhysicalStopApplication({ ...android, stopAdbRecording: () => ({ ok: false }) });
// @ts-expect-error Fallback observation remains synchronous before the recorder wait.
createPhysicalStopApplication({ ...android, stopAdbRecording: async () => ({ ok: true, detail: "" }) });
const fallback = android.stopAdbRecording("adb", "owned");
const fallbackDetail: string = fallback.detail;
// @ts-expect-error Native process status is outside the stop application result.
fallback.status;
// @ts-expect-error Native stdout is outside the stop application result.
fallback.stdout;
// @ts-expect-error Native stderr is outside the stop application result.
fallback.stderr;
// @ts-expect-error Owned Appium cleanup is required.
createPhysicalStopApplication({ ...ios, stopOwnedAppium: undefined });
// @ts-expect-error Presentation is not an application capability.
android.textResult;
function consume(outcome: PhysicalStopOutcome) {
    if (outcome.kind === "stopped") return outcome.device.id;
    if (outcome.kind === "conflict") return outcome.found;
    if (outcome.kind === "failure") return outcome.error;
    return undefined;
}
void [stop, transition, asyncFind, asyncCas, asyncSignal, syncWait, fallbackDetail, consume];
