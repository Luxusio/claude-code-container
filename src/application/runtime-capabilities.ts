import {
    decodeDockerRootlessOptions,
    deriveRuntimeFlavor,
    dockerCapabilityEndpointIsLocal,
    isWindowsDesktopEndpoint,
    parseRuntimeVersion,
    type RuntimeInfo,
} from "../domain/runtime-capabilities.js";
import type { RuntimeName } from "../domain/container-runtime.js";
import type { RuntimeCapabilitiesPorts } from "../ports/runtime-capabilities.js";

export function createRuntimeCapabilitiesCollector(ports: RuntimeCapabilitiesPorts): () => RuntimeInfo {
    for (const name of [
        "readCachedInfo", "publishCachedInfo", "readVitestFlag", "readExplicitOverride",
        "selectRuntime", "readPlatform", "observeVersion", "observeDockerOperatingSystem",
        "readSelectedDockerEndpoint", "observePodmanRemote", "observeDockerSecurityOptions",
        "observePodmanRootless", "readWslDistributionName", "observeWslMirroredLoopback",
        "readRuntimeSocketOverride", "readXdgRuntimeDirectory", "readEffectiveUidOrDefault",
        "joinPodmanSocketPath",
    ] as const) {
        if (typeof ports?.[name] !== "function") throw new TypeError(`Runtime capabilities require a callable ${name} port.`);
    }

    function version(runtime: RuntimeName): string | null {
        const result = ports.observeVersion(runtime);
        if (result.status !== 0) return null;
        return parseRuntimeVersion((result.stdout ?? "").toString());
    }

    function desktop(runtime: RuntimeName): boolean {
        if (runtime !== "docker") return false;
        const result = ports.observeDockerOperatingSystem();
        const operatingSystem = result.status === 0 ? (result.stdout ?? "").trim().toLowerCase() : "";
        const operatingSystemIsDesktop = operatingSystem.includes("docker desktop");
        if (operatingSystem && !operatingSystemIsDesktop) return false;
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
        const result = ports.observePodmanRemote();
        if (result.status === 0 && (result.stdout ?? "").trim().toLowerCase() === "true") return true;
        return false;
    }

    function rootless(runtime: RuntimeName): boolean {
        if (ports.readPlatform() !== "linux") return false;
        if (runtime === "docker") {
            const result = ports.observeDockerSecurityOptions();
            if (result.status === 0) {
                const raw = (result.stdout ?? "").trim();
                return decodeDockerRootlessOptions(raw);
            }
            return false;
        }
        const result = ports.observePodmanRootless();
        if (result.status === 0) {
            const out = (result.stdout ?? "").trim().toLowerCase();
            if (out === "true") return true;
            if (out === "false") return false;
        }
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
        const cached = ports.readCachedInfo();
        if (cached) return cached;
        if (ports.readVitestFlag() && !ports.readExplicitOverride()) {
            const stub: RuntimeInfo = {
                runtime: "docker", flavor: "docker-native", version: "0.0.0",
                socketPath: "/var/run/docker.sock", rootless: false, remote: false, dockerDesktop: false,
            };
            ports.publishCachedInfo(stub);
            return ports.readCachedInfo()!;
        }
        const runtime = ports.selectRuntime();
        const detectedVersion = version(runtime);
        const dockerDesktop = desktop(runtime);
        const detectedRemote = remote(runtime, dockerDesktop);
        const detectedRootless = rootless(runtime);
        const flavor = deriveRuntimeFlavor(runtime, detectedRemote, detectedRootless);
        const socketPath = socket(runtime, detectedRootless);
        ports.publishCachedInfo({ runtime, flavor, version: detectedVersion, socketPath, rootless: detectedRootless, remote: detectedRemote, dockerDesktop });
        return ports.readCachedInfo()!;
    };
}
