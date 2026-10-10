import { androidAppPlan, androidAppCommandSucceeded } from "../domain/mobile-app-management.mjs";

/** @template {import('../ports/mobile-app-management.mjs').AndroidAppTarget} Target
 * @param {import('../ports/mobile-app-management.mjs').AndroidAppManagementPorts<Target>} ports */
export function createAndroidAppManagement(ports) {
    /** @param {string} name
     * @param {import('../ports/mobile-app-management.mjs').MobileAppArguments} args
     * @returns {import('../ports/mobile-app-management.mjs').AndroidAppOutcome | undefined} */
    function request(name, args) {
        const observation = ports.target(args.deviceId);
        if (observation.kind === "unknown") return undefined;
        if (observation.kind === "refused") return { kind: "text", message: observation.message };
        const plan = androidAppPlan(name, args, ports.variant);
        if (!plan) return undefined;
        if (!plan.ok) return { kind: "text", message: plan.message };
        const command = ports.execute(observation.target, plan.args, plan.helperTimeoutMs);
        return androidAppCommandSucceeded(command, plan.validateLaunch)
            ? { kind: "json", payload: { ...plan.payload, stdout: command.stdout, stderr: command.stderr, status: command.status } }
            : { kind: "command-failure", command };
    }
    return { request };
}
