import { androidAppPlan } from "../domain/mobile-app-management.mjs";

/** @template Target
 * @param {import('../ports/mobile-app-management.mjs').AndroidAppManagementPorts<Target>} ports */
export function createAndroidAppManagement(ports) {
    /** @param {string} name
     * @param {import('../ports/mobile-app-management.mjs').MobileAppArguments} args
     * @returns {import('../ports/mobile-app-management.mjs').AndroidAppOutcome | undefined} */
    function request(name, args) {
        const observation = ports.target(args.deviceId);
        if (observation.kind === "unknown") return undefined;
        if (observation.kind === "refused") return { kind: "refused", message: observation.message };
        const plan = androidAppPlan(name, args, ports.variant);
        if (!plan) return undefined;
        if (!plan.ok) return { kind: "refused", message: plan.message };
        const result = ports.perform(observation.target, plan.effect);
        return result.kind === "succeeded"
            ? { kind: "completed", effect: plan.effect, command: result.command }
            : { kind: "command-failure", command: result.command };
    }
    return { request };
}
