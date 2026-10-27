import { readinessProbeBudget } from "../domain/readiness.mjs";

/** @typedef {import('../domain/readiness.mjs').ReadinessEvidence} ReadinessEvidence */
/** @typedef {import('../ports/readiness.mjs').ReadinessPorts} ReadinessPorts */

/**
 * Wait for usable desktop control within the original start deadline.
 * The caller supplies transport-neutral observations with already-safe evidence.
 * No environment, transport envelope, device routing, or real clock is read here.
 * Probe implementations must honor the supplied budget; this loop cannot cancel
 * an external operation that ignores its deadline.
 * @param {number} deadline
 * @param {ReadinessPorts} ports
 * @returns {Promise<import('../domain/readiness.mjs').ReadinessOutcome>}
 */
export async function waitForStartReadiness(deadline, { probe, now, sleep }) {
    /** @type {ReadinessEvidence} */
    let readiness = { attempts: 0, lastProbe: "not-attempted" };
    while (now() < deadline) {
        const budget = readinessProbeBudget(deadline, now());
        if (!budget) break;
        const attempts = readiness.attempts + 1;
        let observation;
        let transportException = false;
        try {
            observation = await probe(budget);
        } catch {
            // Exceptions never prove readiness and their raw contents stay private.
            transportException = true;
        }
        if (now() <= deadline && observation?.ready === true && !observation.failed) return { kind: "ready" };
        const currentHelper = observation?.helper;
        const helper = currentHelper || readiness.helper;
        const helperAttempt = currentHelper ? attempts : readiness.helperAttempt;
        const currentFailure = observation?.failure;
        const failure = currentFailure || readiness.failure;
        const failureAttempt = currentFailure ? attempts : readiness.failureAttempt;
        readiness = {
            attempts,
            lastProbe: transportException ? "transport-exception" : observation?.failed ? "provider-error"
                : now() > deadline ? "late-response" : "missing-cursor",
            ...(helper ? { helper, helperAttempt } : {}),
            ...(failure ? { failure, failureAttempt } : {}),
        };
        if (now() >= deadline) break;
        await sleep(Math.min(500, deadline - now()));
    }
    return { kind: "timed-out", readiness };
}
