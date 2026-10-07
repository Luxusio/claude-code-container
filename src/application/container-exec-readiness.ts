import type { ContainerExecReadinessPorts } from "../ports/container-exec-readiness.js";

export function createContainerExecReadiness(ports: ContainerExecReadinessPorts) {
    for (const name of ["now", "canExec", "sleep"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container exec readiness requires a callable ${name} port.`);
        }
    }

    function run(target: string): boolean {
        const probeTimeoutMs = 5000;
        const deadline = ports.now() + 3 * probeTimeoutMs + 2 * 75;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const remainingMs = deadline - ports.now();
            if (remainingMs <= 0) break;
            if (ports.canExec(target, Math.min(probeTimeoutMs, remainingMs))) return true;
            const sleepMs = Math.min(75, deadline - ports.now());
            if (attempt < 2 && sleepMs > 0) ports.sleep(sleepMs);
        }
        return false;
    }

    return { run };
}
