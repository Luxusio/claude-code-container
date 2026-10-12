import type { RuntimeName } from "./container-runtime.js";

export type RuntimeFlavor =
    | "docker-native"
    | "docker-rootless"
    | "docker-desktop"
    | "podman-rootful"
    | "podman-rootless"
    | "podman-machine"
    | "unknown";

export interface RuntimeInfo {
    runtime: RuntimeName;
    flavor: RuntimeFlavor;
    version: string | null;
    socketPath: string | null;
    rootless: boolean;
    remote: boolean;
    dockerDesktop: boolean;
}

/** Compatibility flavor does not grant Docker Desktop capabilities. */
export function deriveRuntimeFlavor(runtime: RuntimeName, remote: boolean, rootless: boolean): RuntimeFlavor {
    if (runtime === "docker") {
        if (remote) return "docker-desktop";
        if (rootless) return "docker-rootless";
        return "docker-native";
    }
    if (remote) return "podman-machine";
    if (rootless) return "podman-rootless";
    return "podman-rootful";
}

export function dockerCapabilityEndpointIsLocal(endpoint: string | null): boolean {
    return endpoint !== null && /^(?:unix|npipe):\/\//i.test(endpoint);
}

export function isWindowsDesktopEndpoint(platform: string, endpoint: string | null): boolean {
    return platform === "win32"
        && endpoint?.replace(/\\/g, "/").toLowerCase()
            === "npipe:////./pipe/dockerdesktoplinuxengine";
}
