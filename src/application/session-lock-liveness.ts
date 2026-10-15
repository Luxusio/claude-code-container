import {
    sessionLockOwner,
    type ProcessStartObservation,
    type SessionLockLiveness,
} from "../domain/session-lock.js";
import type { SessionLockLivenessPorts } from "../ports/session-lock-liveness.js";

export function createSessionLockLiveness(
    ports: SessionLockLivenessPorts,
): (content: string, observed?: ReadonlyMap<number, ProcessStartObservation>) => SessionLockLiveness {
    for (const name of [
        "getPlatform",
        "observeProcessStart",
        "observeLegacyProcess",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Session lock liveness requires a callable ${name} port.`);
        }
    }

    function observationFor(
        pid: number,
        observed?: ReadonlyMap<number, ProcessStartObservation>,
    ): ProcessStartObservation {
        const batched = observed?.get(pid);
        return batched && batched.status !== "unknown" ? batched : ports.observeProcessStart(pid);
    }

    function legacyProcessLiveness(
        pid: number,
        observed?: ReadonlyMap<number, ProcessStartObservation>,
    ): SessionLockLiveness {
        if (ports.getPlatform() === "win32") {
            const observation = observationFor(pid, observed);
            return observation.status === "found" || observation.status === "present"
                ? "active"
                : observation.status === "missing" ? "stale" : "unknown";
        }
        return ports.observeLegacyProcess(pid);
    }

    return (content, observed) => {
        const record = sessionLockOwner(content.trim());
        if (!record) return "unknown";
        if (!record.startToken) return legacyProcessLiveness(record.pid, observed);

        const observation = observationFor(record.pid, observed);
        if (observation.status === "missing") return "stale";
        if (observation.status === "found") {
            return observation.token === record.startToken ? "active" : "stale";
        }
        if (observation.status === "present") return "unknown";
        return "unknown";
    };
}
