import { describe, expect, it } from "vitest";
import { createWindowsSandboxStop, createWindowsSandboxLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-stop.mjs";
import type { WindowsSandboxLifecycleOutcome } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-stop.mjs";
import type { WindowsSandboxStopPorts, WindowsSandboxLifecyclePorts, WindowsSandboxNativeResult } from "../../../packages/device-lab/providers/ports/lifecycle/windows-sandbox-stop.mjs";
import type { IsoTimestamp, WindowsSandboxLifecycleDevice } from "../../../packages/device-lab/providers/domain/lifecycle/windows-sandbox-stop.mjs";

type Ports = WindowsSandboxStopPorts<{ handle: 'native' }, { receipt: 'opaque' }>;
const ports: Ports = {
    readSingleton: () => null, sameSingletonOwner: () => false, newRuntimeId: () => "operation", wallTimestamp: () => "2026-10-08T00:00:00.000Z",
    transitionDevice: () => ({ found: true, matched: true }), findDevice: () => undefined,
    claimSingleton: () => ({ ok: false, error: "foreign" }), releaseSingleton: () => false, singletonGenerationMatches: () => false,
    watchdogCancelPath: () => "cancel", cancelWatchdog: cancelPath => ({ attempted: true, ok: true, cancelPath }),
    discoverRuntime: () => ({ available: true, missing: [], binding: { handle: "native" } }), stopOwnedRuntime: () => ({ ok: false, evidence: { receipt: "opaque" } }),
};
function contracts() {
    const app = createWindowsSandboxStop(ports);
    const result = app.stop("target");
    if (result.kind === "completed") { const status: string = result.device.status; const claim: string | null | undefined = result.device.singletonClaimId; void [status, claim]; }
    if (result.kind === "native-failure") { const receipt: "opaque" = result.evidence.receipt; void receipt; }
    const device: WindowsSandboxLifecycleDevice = { id: "target", status: "running", sandboxId: undefined, singletonClaimId: null, lifecycle: undefined, helperSessionLaunch: null };
    app.stopDevice(device);
    // @ts-expect-error No ambient ports.
    createWindowsSandboxStop();
    // @ts-expect-error All semantic ports are required.
    createWindowsSandboxStop({ findDevice: () => device });
    // @ts-expect-error stop is synchronous.
    const asynchronous: Promise<unknown> = app.stop("target");
    // @ts-expect-error Native wall timestamp carrier is narrow.
    const badTimestamp: IsoTimestamp = "yesterday";
    // @ts-expect-error A thenable is not a helper metadata carrier.
    const badHelper: WindowsSandboxLifecycleDevice = { id: "target", status: "running", helperSessionLaunch: Promise.resolve({ ok: true }) };
    // @ts-expect-error Narrow claim carrier rejects unknown.
    const badClaim: WindowsSandboxLifecycleDevice = { id: "target", status: "running", singletonClaimId: {} as unknown };
    // @ts-expect-error Unknown read results are rejected.
    createWindowsSandboxStop({ ...ports, findDevice: (): unknown => device });
    // @ts-expect-error Unknown native observations are rejected.
    createWindowsSandboxStop({ ...ports, stopOwnedRuntime: (): unknown => ({ ok: true }) });
    // @ts-expect-error Read is synchronous.
    createWindowsSandboxStop({ ...ports, findDevice: async () => device });
    // @ts-expect-error CAS is synchronous.
    createWindowsSandboxStop({ ...ports, transitionDevice: async () => ({ matched: true, found: true }) });
    // @ts-expect-error Cancellation is synchronous.
    createWindowsSandboxStop({ ...ports, cancelWatchdog: async cancelPath => ({ attempted: true, ok: true, cancelPath }) });
    // @ts-expect-error Runtime stop is synchronous.
    createWindowsSandboxStop({ ...ports, stopOwnedRuntime: async () => ({ ok: true, evidence: { receipt: "opaque" } }) });
    void [asynchronous, badTimestamp, badHelper, badClaim];
}
void contracts;
describe("checked Sandbox stop carriers", () => { it("uses the actual synchronous application", () => { expect(createWindowsSandboxStop(ports).stop("missing")).toEqual({ kind: "unhandled" }); }); });


function lifecycleContracts(required: WindowsSandboxLifecyclePorts<{ handle: "native" }, { receipt: "opaque" }>) {
    const app = createWindowsSandboxLifecycle(required);
    type Outcome = WindowsSandboxLifecycleOutcome<{ receipt: "opaque" }>;
    const started: Promise<Outcome> = app.start({ deviceId: "sandbox", minimized: false });
    const stopped: Outcome = app.stop({ deviceId: "sandbox" });
    const deleted: Outcome = app.delete({ deviceId: "sandbox", force: true });
    const { writeConfig, ...withoutConfig } = required;
    // @ts-expect-error guarded config publication is required
    createWindowsSandboxLifecycle(withoutConfig);
    const { listRuntime, ...withoutObservation } = required;
    // @ts-expect-error native runtime observation is required
    createWindowsSandboxLifecycle(withoutObservation);
    const { removeScratch, ...withoutRemoval } = required;
    // @ts-expect-error scratch removal authority is required
    createWindowsSandboxLifecycle(withoutRemoval);
    // @ts-expect-error native start command must settle synchronously
    createWindowsSandboxLifecycle({ ...required, launchConfig: async () => ({ ok: true, result: {} }) });
    // @ts-expect-error scratch deletion cannot defer settlement
    createWindowsSandboxLifecycle({ ...required, removeScratch: async () => undefined });
    // @ts-expect-error registration observation is asynchronous at the application boundary
    const synchronousStart: Outcome = app.start({ deviceId: "sandbox" });
    // @ts-expect-error stop completes synchronously
    const asynchronousStop: Promise<unknown> = app.stop({ deviceId: "sandbox" });
    // @ts-expect-error the public request requires a concrete device ID
    app.start({ deviceId: 7 });
    const { monotonicNow, ...withoutElapsedClock } = required;
    // @ts-expect-error registration requires an elapsed clock, independently of wallTimestamp
    createWindowsSandboxLifecycle(withoutElapsedClock);
    // @ts-expect-error the elapsed clock is synchronous and numeric
    createWindowsSandboxLifecycle({ ...required, monotonicNow: async () => 0 });
    // @ts-expect-error ambiguous wall now is no longer a lifecycle port
    createWindowsSandboxLifecycle({ ...required, now: () => 0 });
    // @ts-expect-error native registration diagnostic presentation belongs to the backend
    createWindowsSandboxLifecycle({ ...required, registrationDiagnostic: () => "native diagnostic" });
    // @ts-expect-error target rendering belongs to the backend
    createWindowsSandboxLifecycle({ ...required, targetStatus: () => ({}) });
    // @ts-expect-error conflict envelope construction belongs to the backend
    createWindowsSandboxLifecycle({ ...required, lifecycleConflict: () => ({}) });
    // @ts-expect-error text response construction belongs to the backend
    createWindowsSandboxLifecycle({ ...required, textResult: () => ({}) });
    // @ts-expect-error JSON response construction belongs to the backend
    createWindowsSandboxLifecycle({ ...required, jsonResult: () => ({}) });
    // @ts-expect-error native error response construction belongs to the backend
    createWindowsSandboxLifecycle({ ...required, fail: () => ({}) });
    // @ts-expect-error response generic is removed from the lifecycle ports
    type ResponsePorts = WindowsSandboxLifecyclePorts<{ handle: "native" }, WindowsSandboxNativeResult, { ok: boolean }>;
    // @ts-expect-error raw process evidence is not a settled runtime inventory
    createWindowsSandboxLifecycle({ ...required, listRuntime: () => ({ status: 0, stdout: "[]" }) });
    // @ts-expect-error a watchdog observation must preserve its launch metadata separately
    createWindowsSandboxLifecycle({ ...required, launchWatchdog: () => ({ ok: true, pid: 17 }) });
    void [started, stopped, deleted, writeConfig, listRuntime, removeScratch, monotonicNow, synchronousStart, asynchronousStop];
}
void lifecycleContracts;

function outcomeNarrowing(result: WindowsSandboxLifecycleOutcome<{ receipt: "opaque" }>) {
    switch (result.kind) {
        case "unhandled": break;
        case "completed": {
            const device: WindowsSandboxLifecycleDevice = result.device;
            // @ts-expect-error semantic completion has no MCP response envelope
            const content = result.content;
            void [device, content]; break;
        }
        case "deleted": {
            const deleted: string = result.deleted, scratch: string = result.scratchRemoved;
            void [deleted, scratch]; break;
        }
        case "conflict": {
            const operation: string = result.operation, found: boolean = result.transition.found;
            const detail: Record<string, unknown> | undefined = result.detail;
            void [operation, found, detail]; break;
        }
        case "refused": { const error: string | undefined = result.error; void error; break; }
        case "native-failure": { const receipt: "opaque" = result.evidence.receipt; void receipt; break; }
        case "registration-failed": {
            const failed: false = result.registration.ok;
            const receipt: "opaque" | undefined = result.registration.result?.receipt;
            const ids: string[] = result.cleanupIds, observed: string[] = result.registration.observedIds;
            const ambiguous: boolean = result.ambiguous, gone: boolean = result.runtimeGone, released: boolean = result.releaseLockAfterFailure;
            const stopped: string[] = result.cleanup.stopped, refused: boolean = result.cleanup.refused;
            const failedReceipt: "opaque" | undefined = result.cleanup.failed[0]?.result.receipt;
            const verifyReceipt: "opaque" | undefined = result.cleanupVerify?.result.receipt;
            const watchdog: boolean = result.watchdogCleanup.ok;
            // @ts-expect-error registration failures preserve observations rather than serialized error responses
            const content = result.content;
            void [failed, receipt, ids, observed, ambiguous, gone, released, stopped, refused, failedReceipt, verifyReceipt, watchdog, content]; break;
        }
        case "singleton-conflict": {
            const id: string = result.deviceId, stopped: boolean = result.runtimeStopped;
            const refused: boolean = result.compensationRefused, cleaned: boolean = result.watchdogCleaned;
            void [id, stopped, refused, cleaned]; break;
        }
        default: { const exhaustive: never = result; void exhaustive; }
    }
}
void outcomeNarrowing;
