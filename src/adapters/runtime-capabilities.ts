import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { RuntimeCapabilitiesObservationPorts } from "../ports/runtime-capabilities.js";

function decodeDockerRootlessOptions(raw: string): boolean {
    try {
        const options = JSON.parse(raw) as unknown;
        return Array.isArray(options)
            && options.some(option => String(option).toLowerCase().includes("rootless"));
    } catch {
        return raw.toLowerCase().includes("rootless");
    }
}

/** Native probes normalize transport output before capability policy reads it. */
export function createNativeRuntimeCapabilitiesObservations(
    readSelectedDockerEndpoint: () => string | null,
): RuntimeCapabilitiesObservationPorts {
    return {
        readPlatform: () => process.platform,
        observeVersion: runtime => {
            const result = spawnSync(runtime, ["--version"], {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
            if (result.status !== 0) return null;
            const match = (result.stdout ?? "").toString().match(/\b(\d+\.\d+(?:\.\d+)?)/);
            return match ? match[1] : null;
        },
        observeDockerOperatingSystem: () => {
            const result = spawnSync("docker", ["info", "--format", "{{.OperatingSystem}}"], {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
            const operatingSystem = result.status === 0 ? (result.stdout ?? "").trim().toLowerCase() : "";
            if (!operatingSystem) return "unavailable";
            return operatingSystem.includes("docker desktop") ? "desktop" : "other";
        },
        readSelectedDockerEndpoint,
        observePodmanRemote: () => {
            const result = spawnSync("podman", ["info", "--format", "{{.Host.Remote}}"], {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
            return result.status === 0 && (result.stdout ?? "").trim().toLowerCase() === "true";
        },
        observeDockerSecurityOptions: () => {
            const result = spawnSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
            return result.status === 0 && decodeDockerRootlessOptions((result.stdout ?? "").trim());
        },
        observePodmanRootless: () => {
            const result = spawnSync("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
                encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
            });
            if (result.status !== 0) return null;
            const rootless = (result.stdout ?? "").trim().toLowerCase();
            return rootless === "true" ? true : rootless === "false" ? false : null;
        },
        readWslDistributionName: () => process.env.WSL_DISTRO_NAME,
        observeWslMirroredLoopback: () => existsSync("/sys/class/net/loopback0"),
        readRuntimeSocketOverride: () => process.env.CCC_RUNTIME_SOCKET,
        readXdgRuntimeDirectory: () => process.env.XDG_RUNTIME_DIR,
        readEffectiveUidOrDefault: defaultUid => typeof process.getuid === "function" ? process.getuid() : defaultUid,
        joinPodmanSocketPath: xdg => join(xdg, "podman", "podman.sock"),
    };
}
