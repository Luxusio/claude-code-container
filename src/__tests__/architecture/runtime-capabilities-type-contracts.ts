import { createRuntimeCapabilitiesCollector } from "../../application/runtime-capabilities.js";
import type { DockerOperatingSystemObservation, RuntimeCapabilitiesObservationPorts, RuntimeCapabilitiesPorts } from "../../ports/runtime-capabilities.js";
import type { RuntimeInfo, RuntimeFlavor } from "../../domain/runtime-capabilities.js";
import { getRuntimeInfo, runtimeCli, type RuntimeInfo as PublicRuntimeInfo, type RuntimeFlavor as PublicRuntimeFlavor } from "../../container-runtime.js";
import type { RuntimeName } from "../../domain/container-runtime.js";

export function runtimeCapabilitiesContracts(ports: RuntimeCapabilitiesPorts): void {
    const collect: () => RuntimeInfo = createRuntimeCapabilitiesCollector(ports);
    const domainInfo: RuntimeInfo = getRuntimeInfo(); const publicInfo: PublicRuntimeInfo = collect();
    const flavor: RuntimeFlavor = publicInfo.flavor; const publicFlavor: PublicRuntimeFlavor = flavor;
    const name: RuntimeName = runtimeCli(); const version: string | null = ports.observeVersion(name);
    const observations: RuntimeCapabilitiesObservationPorts = ports;
    const operatingSystem: DockerOperatingSystemObservation = observations.observeDockerOperatingSystem();
    const remote: boolean = ports.observePodmanRemote(); const dockerRootless: boolean = ports.observeDockerSecurityOptions();
    const podmanRootless: boolean | null = ports.observePodmanRootless();
    const wsl: string | undefined = ports.readWslDistributionName();
    const { readWslDistributionName, ...withoutWsl } = ports;
    // @ts-expect-error capabilities must include the explicit lazy WSL observation port
    const missingWsl: RuntimeCapabilitiesPorts = withoutWsl;
    // @ts-expect-error the collector consumes a decoded version, not native transport
    const rawVersion: RuntimeCapabilitiesPorts["observeVersion"] = () => ({ status: 0, stdout: "27.1.1" });
    // @ts-expect-error OS absence and successful non-Desktop observations remain distinct
    const booleanOs: RuntimeCapabilitiesPorts["observeDockerOperatingSystem"] = () => false;
    // @ts-expect-error unknown Podman rootless is a finite null observation
    const unknownRootless: RuntimeCapabilitiesPorts["observePodmanRootless"] = () => undefined;
    // @ts-expect-error public info remains synchronous
    const asyncInfo: Promise<RuntimeInfo> = getRuntimeInfo();
    void [domainInfo, publicInfo, publicFlavor, version, observations, operatingSystem, remote, dockerRootless, podmanRootless, wsl, readWslDistributionName, missingWsl, rawVersion, booleanOs, unknownRootless, asyncInfo];
}
