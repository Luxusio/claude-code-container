import type { ContainerSocketAccessPorts } from "../ports/container-socket-access.js";

export function createContainerSocketAccess(ports: ContainerSocketAccessPorts) {
    for (const name of ["probe", "grant", "warn"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Container socket access requires a callable ${name} port.`);
        }
    }

    let warned = false;

    function warn(): undefined {
        if (warned) return;
        warned = true;
        ports.warn();
    }

    function run(target: string): undefined {
        const probe = ports.probe(target);
        if (probe.kind === "usable") return;
        if (probe.kind === "unavailable") {
            warn();
            return;
        }
        const grant = ports.grant(target, probe.user, probe.gid);
        if (!grant.ok) warn();
    }

    function resetWarning(): undefined {
        warned = false;
    }

    return { run, resetWarning };
}
