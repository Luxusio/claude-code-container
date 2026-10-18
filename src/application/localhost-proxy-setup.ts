import type { LocalhostProxyVerifierPorts } from "../ports/localhost-proxy-setup.js";

export function createLocalhostProxyVerifier(ports: LocalhostProxyVerifierPorts) {
    for (const name of ["platform", "containerHostRemote", "directReach", "proxyListenerPresent", "debugFlag", "reportDirectReachable", "reportUnavailable"] as const) {
        const capabilityGetter = ports && Object.getOwnPropertyDescriptor(ports, name)?.get;
        if (!ports || (!capabilityGetter && typeof ports[name] !== "function")) throw new TypeError(`Localhost proxy verifier requires ${name}`);
    }
    function setup(containerName: string): void {
        if (ports.platform() === "linux" && !ports.containerHostRemote()) return;
        const reach = ports.directReach(containerName, 1500);
        if (reach.reachable) {
            if (ports.debugFlag()) ports.reportDirectReachable(reach.latencyMs);
            return;
        }
        if (!ports.proxyListenerPresent(containerName)) ports.reportUnavailable(containerName);
    }
    return {setup};
}
