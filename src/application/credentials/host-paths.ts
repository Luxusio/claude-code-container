import type { CredentialMount } from "../../domain/tool-registry.js";
import type { HostCredentialPathPorts } from "../../ports/credentials/host-paths.js";

export function createHostCredentialPaths(ports: HostCredentialPathPorts, codexPackagesContainerDir: string) {
    for (const name of [
        "readContainerEnvironment", "readVitestEnvironment", "claudeProfilePath",
        "codexProfilePath", "homeDirectory", "joinHostPath", "createDirectory",
        "packageParentPath", "packageBasename",
    ] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Host credential paths requires a callable ${name} port.`);
        }
    }

    function resolveCredentialHostPath(mount: CredentialMount, profile?: string): string {
        if (!profile && ports.readContainerEnvironment() === "docker" && !ports.readVitestEnvironment()) {
            return mount.containerDir;
        }
        if (mount.containerDir === "/home/ccc/.claude") return ports.claudeProfilePath(profile);
        if (mount.containerDir === "/home/ccc/.codex") return ports.codexProfilePath(profile);
        return ports.joinHostPath(ports.homeDirectory(), mount.hostDir);
    }

    function ensureCredentialHostDir(mount: CredentialMount, profile?: string): string {
        const hostPath = resolveCredentialHostPath(mount, profile);
        // ccc's own profile credential folders are private; other tools' folders keep their defaults.
        const cccOwned = mount.containerDir === "/home/ccc/.claude" || mount.containerDir === "/home/ccc/.codex";
        ports.createDirectory(hostPath, cccOwned ? { recursive: true, mode: 0o700 } : { recursive: true });
        if (ports.packageParentPath(codexPackagesContainerDir) === mount.containerDir) {
            ports.createDirectory(ports.joinHostPath(hostPath, ports.packageBasename(codexPackagesContainerDir)), { recursive: true, mode: 0o700 });
        }
        return hostPath;
    }

    return { resolveCredentialHostPath, ensureCredentialHostDir };
}
