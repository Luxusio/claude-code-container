/** Maximum number of sequential public device actions in one flow. */
export const FLOW_MAX_STEPS = 50;

/**
 * Both arguments have already undergone the facade's existing normalization.
 * Eligibility is represented by the facade's required-deviceId schema map.
 * @param {import('./device-flow.mjs').FlowArguments} args
 * @param {import('./device-flow.mjs').FlowArguments} stepArgs
 * @param {Record<string, unknown> | undefined} targetProperties
 * @returns {import('./device-flow.mjs').FlowArguments}
 */
export function sharedFlowTarget(args, stepArgs, targetProperties) {
    /** @type {import('./device-flow.mjs').FlowArguments} */
    const sharedTarget = {};
    const changedTarget = ["deviceId"].some((key) =>
        Object.hasOwn(args, key) && Object.hasOwn(stepArgs, key) && args[key] !== stepArgs[key]);
    if (targetProperties && !changedTarget) {
        for (const key of ["deviceId"]) {
            if (Object.hasOwn(args, key) && Object.hasOwn(targetProperties, key)) sharedTarget[key] = args[key];
        }
    }
    return sharedTarget;
}

/** @param {string} operation @param {import('./device-flow.mjs').FlowObservation<unknown>} observation */
export function flowFailure(operation, observation) {
    const failed = observation.transportFailed || observation.values.some(value => value.ok === false);
    const wait = operation === 'mobile_wait_for_text' || operation === 'mobile_wait_for_app';
    const unmet = !failed && wait && observation.values.some(value => value.matched === false || value.found === false || operation === 'mobile_wait_for_app' && value.running === false);
    return { failed: failed || unmet, ...(unmet ? { error: 'wait-condition-not-met' } : {}) };
}

/** @param {unknown} value @returns {value is import('./device-flow.mjs').FlowArguments} */
export function isFlowArguments(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
