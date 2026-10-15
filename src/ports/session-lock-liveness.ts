import type { ProcessStartObservation, SessionLockLiveness } from "../domain/session-lock.js";

export interface SessionLockLivenessPorts {
    getPlatform(): string;
    observeProcessStart(pid: number): ProcessStartObservation;
    observeLegacyProcess(pid: number): SessionLockLiveness;
}
