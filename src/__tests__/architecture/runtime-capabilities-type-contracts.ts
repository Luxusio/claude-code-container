import { createRuntimeCapabilitiesCollector } from "../../application/runtime-capabilities.js";
import type { RuntimeCapabilitiesPorts, RuntimeCapabilityProbeResult } from "../../ports/runtime-capabilities.js";
import type { RuntimeInfo, RuntimeFlavor } from "../../domain/runtime-capabilities.js";
import { getRuntimeInfo, runtimeCli, type RuntimeInfo as PublicRuntimeInfo, type RuntimeFlavor as PublicRuntimeFlavor } from "../../container-runtime.js";
import type { RuntimeName } from "../../domain/container-runtime.js";

export function runtimeCapabilitiesContracts(ports: RuntimeCapabilitiesPorts): void {
    const collect: () => RuntimeInfo = createRuntimeCapabilitiesCollector(ports);
    const domainInfo: RuntimeInfo = getRuntimeInfo(); const publicInfo: PublicRuntimeInfo = collect();
    const flavor: RuntimeFlavor = publicInfo.flavor; const publicFlavor: PublicRuntimeFlavor = flavor;
    const name: RuntimeName = runtimeCli(); const raw: RuntimeCapabilityProbeResult = ports.observeVersion(name);
    const wsl: string | undefined = ports.readWslDistributionName();
    const { readWslDistributionName, ...withoutWsl } = ports;
    // @ts-expect-error capabilities must include the explicit lazy WSL observation port
    const missingWsl: RuntimeCapabilitiesPorts = withoutWsl;
    // @ts-expect-error raw probe status is not a sanitized success boolean
    const wrongProbe: RuntimeCapabilityProbeResult = { status: true, stdout: "" };
    // @ts-expect-error cache publication must finish synchronously before the collector returns
    const asyncPublisher: RuntimeCapabilitiesPorts["publishCachedInfo"] = async () => undefined;
    // @ts-expect-error public info remains synchronous
    const asyncInfo: Promise<RuntimeInfo> = getRuntimeInfo();
    void [domainInfo, publicInfo, publicFlavor, raw, wsl, readWslDistributionName, missingWsl, wrongProbe, asyncPublisher, asyncInfo];
}
