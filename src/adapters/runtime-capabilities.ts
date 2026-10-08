import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { RuntimeCapabilitiesObservationPorts } from "../ports/runtime-capabilities.js";

/** Native authority remains here; each probe returns the original result. */
export function createNativeRuntimeCapabilitiesObservations(
    readSelectedDockerEndpoint: () => string | null,
): RuntimeCapabilitiesObservationPorts {
    return {
        readPlatform: () => process.platform,
        observeVersion: runtime => spawnSync(runtime, ["--version"], {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }),
        observeDockerOperatingSystem: () => spawnSync("docker", ["info", "--format", "{{.OperatingSystem}}"], {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }),
        readSelectedDockerEndpoint,
        observePodmanRemote: () => spawnSync("podman", ["info", "--format", "{{.Host.Remote}}"], {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }),
        observeDockerSecurityOptions: () => spawnSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }),
        observePodmanRootless: () => spawnSync("podman", ["info", "--format", "{{.Host.Security.Rootless}}"], {
            encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
        }),
        readWslDistributionName: () => process.env.WSL_DISTRO_NAME,
        observeWslMirroredLoopback: () => existsSync("/sys/class/net/loopback0"),
        readRuntimeSocketOverride: () => process.env.CCC_RUNTIME_SOCKET,
        readXdgRuntimeDirectory: () => process.env.XDG_RUNTIME_DIR,
        readEffectiveUidOrDefault: defaultUid => typeof process.getuid === "function" ? process.getuid() : defaultUid,
        joinPodmanSocketPath: xdg => join(xdg, "podman", "podman.sock"),
    };
}
