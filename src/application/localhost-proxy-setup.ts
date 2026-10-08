import type { LocalhostProxyVerifierPorts } from "../ports/localhost-proxy-setup.js";

export function createLocalhostProxyVerifier(ports: LocalhostProxyVerifierPorts) {
    for (const name of ["platform", "containerHostRemote", "directReach", "proxyListenerObservation", "debugFlag", "runtimeName", "reportDebug", "reportWarning"] as const) {
        const capabilityGetter = ports && Object.getOwnPropertyDescriptor(ports, name)?.get;
        if (!ports || (!capabilityGetter && typeof ports[name] !== "function")) throw new TypeError(`Localhost proxy verifier requires ${name}`);
    }
    function setup(containerName: string): void {
        if (ports.platform() === "linux" && !ports.containerHostRemote()) return;
        const reach = ports.directReach(containerName, 1500);
        if (reach.reachable) {
            if (ports.debugFlag()) ports.reportDebug(`[ccc] host loopback reachable from container (${reach.latencyMs}ms) — proxy not needed`);
            return;
        }
        const result = ports.proxyListenerObservation(containerName);
        if (!(!result.error && result.status === 0)) {
            ports.reportWarning(`[ccc] WARNING: localhost proxy daemon not detected — host port access may fail.`);
            ports.reportWarning(`[ccc]   check \`${ports.runtimeName()} logs ${containerName}\` for entrypoint errors.`);
        }
    }
    return {setup};
}
