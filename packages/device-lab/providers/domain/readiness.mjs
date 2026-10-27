/**
 * Facts supplied by the transport adapter. Helper and failure evidence are already redacted.
 * Error, signal and observation codes are selected from closed adapter allowlists.
 * @typedef {{status?: number|null, signal?: string|null, errorCode?: string}} ReadinessNativeExecution
 * @typedef {ReadinessNativeExecution & {stage: 'listener'|'command'|'start-token'|'identity', reason: 'native-command-failed'|'native-output-unavailable'|'budget-exhausted'|'invalid-runtime'|'listener-pid-mismatch'|'status-identity-unverified'|'runtime-continuity-unverified'|'command-line-unverified'}} ReadinessProcessObservation
 * @typedef {{stage: 'broker-process'|'broker-transport'|'provider', error?: string, processObservation?: ReadinessProcessObservation, execution?: ReadinessNativeExecution}} ReadinessFailure
 * @typedef {{ready: boolean, failed: boolean, helper?: Record<string, unknown>, failure?: ReadinessFailure}} ReadinessObservation
 * @typedef {{attempts: number, lastProbe: string, helper?: Record<string, unknown>, helperAttempt?: number, failure?: ReadinessFailure, failureAttempt?: number}} ReadinessEvidence
 * @typedef {{kind: 'ready'} | {kind: 'timed-out', readiness: ReadinessEvidence}} ReadinessOutcome
 * @typedef {{timeoutMs: number, remainingMs: number}} ReadinessProbeBudget
 */

/**
 * Preserve the desktop readiness loop's positive budget and 10-second probe cap.
 * This is an observation of the caller's original deadline, not a new timeout.
 * @param {number} deadline
 * @param {number} observedAt
 * @returns {ReadinessProbeBudget | undefined}
 */
export function readinessProbeBudget(deadline, observedAt) {
    const remainingMs = deadline - observedAt;
    if (remainingMs <= 0) return undefined;
    return { timeoutMs: Math.min(10000, remainingMs), remainingMs };
}
