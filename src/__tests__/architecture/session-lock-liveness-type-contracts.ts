import {
    sessionLockOwner,
    type ProcessStartObservation, type SessionLockLiveness, type SessionLockOwner,
} from "../../domain/session-lock.js";
import { parseProcessStartObservations } from "../../session-lock-liveness.js";
import { createSessionLockLiveness } from "../../application/session-lock-liveness.js";
import type { SessionLockLivenessPorts } from "../../ports/session-lock-liveness.js";

const ports: SessionLockLivenessPorts = {
    getPlatform: () => "linux",
    observeProcessStart: () => ({ status: "found", token: "opaque" }),
    observeLegacyProcess: () => "active",
};
const classify: (content: string, observed?: ReadonlyMap<number, ProcessStartObservation>) => SessionLockLiveness = createSessionLockLiveness(ports);
const observed: ReadonlyMap<number, ProcessStartObservation> = parseProcessStartObservations("42 FOUND:123", [42] as const);
const result: SessionLockLiveness = classify("42", observed);
const owner: SessionLockOwner | null = sessionLockOwner("42");
const legacyResult: SessionLockLiveness = ports.observeLegacyProcess(42);
void [result, owner, legacyResult];

// @ts-expect-error The factory requires explicit ports without defaults.
createSessionLockLiveness();
// @ts-expect-error Platform is a required port.
createSessionLockLiveness({ observeProcessStart: ports.observeProcessStart, observeLegacyProcess: ports.observeLegacyProcess });
// @ts-expect-error Observation is a required port.
createSessionLockLiveness({ getPlatform: ports.getPlatform, observeLegacyProcess: ports.observeLegacyProcess });
// @ts-expect-error Semantic legacy observation is a required port.
createSessionLockLiveness({ getPlatform: ports.getPlatform, observeProcessStart: ports.observeProcessStart });
// @ts-expect-error Platform callbacks must be synchronous.
createSessionLockLiveness({ ...ports, getPlatform: async () => "linux" });
// @ts-expect-error Observation callbacks must be synchronous.
createSessionLockLiveness({ ...ports, observeProcessStart: async () => ({ status: "missing" as const }) });
// @ts-expect-error Legacy observations must be synchronous.
createSessionLockLiveness({ ...ports, observeLegacyProcess: async () => "active" });
const voidProbe = (_pid: number): void => {};
// @ts-expect-error Legacy observations return a semantic state rather than void.
createSessionLockLiveness({ ...ports, observeLegacyProcess: voidProbe });
// @ts-expect-error The legacy observation cannot return a status boolean.
createSessionLockLiveness({ ...ports, observeLegacyProcess: () => true });
// @ts-expect-error Native undefined-returning probes no longer satisfy the semantic contract.
createSessionLockLiveness({ ...ports, observeLegacyProcess: () => undefined });
// @ts-expect-error Native status records are classified outside the application.
createSessionLockLiveness({ ...ports, observeLegacyProcess: () => ({ status: 0, error: { code: "EPERM" } }) });
// @ts-expect-error The new semantic observation has a closed set of liveness states.
createSessionLockLiveness({ ...ports, observeLegacyProcess: () => "missing" });
// @ts-expect-error The old throwing native probe cannot replace the required semantic observation.
createSessionLockLiveness({ getPlatform: ports.getPlatform, observeProcessStart: ports.observeProcessStart, probeLegacyProcess: () => undefined });
// @ts-expect-error Observations have a closed discriminant union.
createSessionLockLiveness({ ...ports, observeProcessStart: () => ({ status: "active" }) });
// @ts-expect-error Found observations always carry a string token.
createSessionLockLiveness({ ...ports, observeProcessStart: () => ({ status: "found" }) });
// @ts-expect-error Found tokens are strings.
createSessionLockLiveness({ ...ports, observeProcessStart: () => ({ status: "found", token: 1 }) });
// @ts-expect-error The synchronous classifier returns liveness rather than a promise.
const asynchronousResult: Promise<SessionLockLiveness> = classify("42");
void asynchronousResult;
