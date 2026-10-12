import {
    deriveRuntimeFlavor,
    dockerCapabilityEndpointIsLocal,
    isWindowsDesktopEndpoint,
    type RuntimeInfo,
} from "../domain/runtime-capabilities.js";
import type { RuntimeName } from "../domain/container-runtime.js";
import type { RuntimeCapabilitiesPorts } from "../ports/runtime-capabilities.js";

export function createRuntimeCapabilitiesCollector(ports: RuntimeCapabilitiesPorts): () => RuntimeInfo {
    function desktop(runtime: RuntimeName): boolean {
        if (runtime !== "docker") return false;
        const operatingSystem = ports.observeDockerOperatingSystem();
        const operatingSystemIsDesktop = operatingSystem === "desktop";
        if (operatingSystem === "other") return false;
        if (!operatingSystemIsDesktop && ports.readPlatform() !== "win32") return false;
        const endpoint = ports.readSelectedDockerEndpoint();
        if (!dockerCapabilityEndpointIsLocal(endpoint)) return false;
        return isWindowsDesktopEndpoint(ports.readPlatform(), endpoint) || operatingSystemIsDesktop;
    }

    function remote(runtime: RuntimeName, dockerDesktop: boolean): boolean {
        if (ports.readPlatform() !== "linux") return true;
        if (runtime === "docker") {
            if (dockerDesktop) return true;
            if (ports.readWslDistributionName()) return !ports.observeWslMirroredLoopback();
            return false;
        }
        return ports.observePodmanRemote();
    }

    function rootless(runtime: RuntimeName): boolean {
        if (ports.readPlatform() !== "linux") return false;
        if (runtime === "docker") return ports.observeDockerSecurityOptions();
        const observedRootless = ports.observePodmanRootless();
        if (observedRootless !== null) return observedRootless;
        try {
            if (ports.readEffectiveUidOrDefault(0) !== 0) return true;
        } catch { /* original fallback ignores UID faults */ }
        return false;
    }

    function socket(runtime: RuntimeName, rootless: boolean): string | null {
        const override = ports.readRuntimeSocketOverride();
        if (override) return override;
        if (runtime === "docker") return "/var/run/docker.sock";
        if (rootless) {
            const xdg = ports.readXdgRuntimeDirectory();
            if (xdg) return ports.joinPodmanSocketPath(xdg);
            const uid = ports.readEffectiveUidOrDefault(0);
            return `/run/user/${uid}/podman/podman.sock`;
        }
        return "/run/podman/podman.sock";
    }

    return () => {
        const runtime = ports.selectRuntime();
        const detectedVersion = ports.observeVersion(runtime);
        const dockerDesktop = desktop(runtime);
        const detectedRemote = remote(runtime, dockerDesktop);
        const detectedRootless = rootless(runtime);
        const flavor = deriveRuntimeFlavor(runtime, detectedRemote, detectedRootless);
        const socketPath = socket(runtime, detectedRootless);
        return { runtime, flavor, version: detectedVersion, socketPath, rootless: detectedRootless, remote: detectedRemote, dockerDesktop };
    };
}
