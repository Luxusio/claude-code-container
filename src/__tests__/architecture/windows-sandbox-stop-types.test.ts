import { describe, expect, it } from "vitest";
import { createWindowsSandboxStop, createWindowsSandboxLifecycle } from "../../../packages/device-lab/providers/application/lifecycle/windows-sandbox-stop.mjs";
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


function lifecycleContracts(required: WindowsSandboxLifecyclePorts<{ handle: "native" }, WindowsSandboxNativeResult, { ok: boolean }>) {
    const app = createWindowsSandboxLifecycle(required);
    const started: Promise<{ ok: boolean } | undefined> = app.start({ deviceId: "sandbox", minimized: false });
    const stopped: { ok: boolean } | undefined = app.stop({ deviceId: "sandbox" });
    const deleted: { ok: boolean } | undefined = app.delete({ deviceId: "sandbox", force: true });
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
    const synchronousStart: { ok: boolean } | undefined = app.start({ deviceId: "sandbox" });
    // @ts-expect-error stop completes synchronously
    const asynchronousStop: Promise<unknown> = app.stop({ deviceId: "sandbox" });
    // @ts-expect-error the public request requires a concrete device ID
    app.start({ deviceId: 7 });
    const { registrationDiagnostic, ...withoutDiagnostic } = required;
    // @ts-expect-error opaque registration evidence needs its native presentation authority
    createWindowsSandboxLifecycle(withoutDiagnostic);
    // @ts-expect-error raw process evidence is not a settled runtime inventory
    createWindowsSandboxLifecycle({ ...required, listRuntime: () => ({ status: 0, stdout: "[]" }) });
    // @ts-expect-error a watchdog observation must preserve its launch metadata separately
    createWindowsSandboxLifecycle({ ...required, launchWatchdog: () => ({ ok: true, pid: 17 }) });
    void [started, stopped, deleted, writeConfig, listRuntime, removeScratch, registrationDiagnostic, synchronousStart, asynchronousStop];
}
void lifecycleContracts;
