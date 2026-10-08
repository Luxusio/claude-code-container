import { normalizeDockerMountSource } from "../domain/container-launch-arguments.js";
import type { BindMountArgumentOptions, ContainerLaunchOptions } from "../domain/container-launch-arguments.js";
import type { ContainerLaunchArgumentPorts, ContainerMountArgumentPorts } from "../ports/container-launch-arguments.js";

export function createContainerMountArguments(ports: ContainerMountArgumentPorts) {
    function needsSelinuxRelabel(): boolean {
        const mode = (ports.readSelinuxRelabelMode() ?? "auto").toLowerCase();
        if (mode === "off") return false;
        if (mode === "force") return true;
        // auto: only on podman + SELinux enforcing. Docker manages labels itself.
        if (ports.readRuntimeName() !== "podman") return false;
        return ports.observeSelinuxEnforcing();
    }

    function bindMountArgs(
        hostPath: string,
        containerPath: string,
        opts: BindMountArgumentOptions = {},
    ): string[] {
        const suffixes: string[] = [];
        if (opts.readonly) suffixes.push("ro");
        const translatedHostPath = opts.sourceNamespace === "daemon"
            ? hostPath
            : translateCurrentContainerPath(hostPath);
        const isHostPath = translatedHostPath.startsWith("/") || /^[A-Za-z]:[\\/]/.test(translatedHostPath);
        if (isHostPath && needsSelinuxRelabel()) {
            suffixes.push("Z");
        }
        const suffix = suffixes.length > 0 ? `:${suffixes.join(",")}` : "";
        return ["-v", `${translatedHostPath}:${containerPath}${suffix}`];
    }

    function translateCurrentContainerPath(hostPath: string): string {
        if (!hostPath.startsWith("/")) return hostPath;
        if (ports.readContainerMarker() !== "docker" || ports.isVitestProcess()) return hostPath;
        if (ports.readRuntimeName() !== "docker") return hostPath;

        const mounts = ports.observeCurrentContainerMounts();
        let best: { source: string; destination: string } | null = null;
        for (const mount of mounts) {
            if (hostPath === mount.destination || hostPath.startsWith(`${mount.destination}/`)) {
                if (!best || mount.destination.length > best.destination.length) {
                    best = mount;
                }
            }
        }
        if (!best) return hostPath;

        const source = normalizeDockerMountSource(best.source);
        const rel = hostPath.slice(best.destination.length).replace(/^\/+/, "");
        return rel ? ports.captureHostJoin()(source, rel) : source;
    }

    function runtimeExtraRunArgs(): string[] {
        const info = ports.readRuntimeInfo();
        const extras: string[] = [];
        const podmanCgroups = (ports.readPodmanCgroups() ?? "").toLowerCase();
        if (
            info.runtime === "podman"
            && !info.remote
            && (podmanCgroups === "disabled" || (podmanCgroups !== "enabled" && ports.readContainerMarker() === "docker"))
        ) {
            extras.push("--cgroups=disabled");
        }
        if (info.flavor === "podman-rootless" || info.flavor === "podman-machine") {
            extras.push("--userns=keep-id:uid=1000,gid=1000");
        }
        return extras;
    }

    return { needsSelinuxRelabel, bindMountArgs, runtimeExtraRunArgs };
}

export function createContainerLaunchArguments<Identity>(ports: ContainerLaunchArgumentPorts<Identity>) {
    function getComposeLabels(
        containerName: string,
        fullPath: string,
        projectMountIdentity?: string,
        profile?: string,
    ): string[] {
        const labels = [
            "--label", "com.docker.compose.project=ccc",
            "--label", `com.docker.compose.service=${containerName}`,
            "--label", "com.docker.compose.oneoff=False",
            "--label", "com.docker.compose.version=2",
            "--label", "com.docker.compose.container-number=1",
            "--label", "ccc.managed=true",
            "--label", `ccc.project.path=${fullPath}`,
            "--label", `ccc.profile=${profile ?? ""}`,
            "--label", `ccc.cli.version=${ports.readCliVersion()}`,
        ];
        if (projectMountIdentity) {
            labels.push("--label", `${ports.readProjectMountIdentityLabel()}=${projectMountIdentity}`);
        }
        return labels;
    }

    function resolveHostSocketPath(): string {
        const info = ports.readRuntimeInfo();
        if (info.runtime === "docker") return info.socketPath ?? "/var/run/docker.sock";
        const socket = info.socketPath ?? "/run/podman/podman.sock";
        if (ports.captureExistsSync()(socket)) return socket;
        // Fall back to /var/run/docker.sock if Podman socket isn't running.
        // This keeps the bind-mount spec valid; the socket will 404 but nothing
        // inside the container will crash at create time.
        return "/var/run/docker.sock";
    }

    function buildRunArgs(opts: ContainerLaunchOptions<Identity>): string[] {
        // Stable hostname: derived from container name, truncated to 63 chars (RFC 1123).
        // Ensures Claude Code's --resume can find conversations after container recreation,
        // since conversations are keyed by hostname internally.
        const hostname = opts.containerName.slice(0, 63);

        const args: string[] = [
            "run",
            "-d",
            "--name",
            opts.containerName,
            "--hostname",
            hostname,
            "--network",
            "host",
            "--security-opt",
            "seccomp=unconfined",
            "--cap-add",
            "NET_ADMIN",
            // Run the runtime's init (docker-init/tini, catatonit) as PID 1 so orphaned
            // children are reaped instead of piling up as zombies under `tail`.
            "--init",
        ];

        // Bind mounts (runtime-aware: adds :Z on SELinux podman)
        args.push(...ports.captureBindMountArgs()(opts.fullPath, opts.projectMountPath));
        for (const mount of opts.credentialMounts) {
            args.push(...ports.captureBindMountArgs()(mount.hostPath, mount.containerPath));
        }
        for (const mount of opts.gitIdentityMounts ?? []) {
            args.push(...ports.captureBindMountArgs()(mount.hostPath, mount.containerPath, { readonly: true }));
        }
        args.push(...ports.captureBindMountArgs()(opts.claudeJsonFile, "/home/ccc/.claude.json"));
        if (opts.deviceLabStateHostDir) {
            args.push(...ports.captureBindMountArgs()(opts.deviceLabStateHostDir, "/home/ccc/.ccc/devices", { readonly: true }));
            args.push("--tmpfs", "/home/ccc/.ccc/devices/owners:rw,noexec,nosuid,nodev,mode=0711");
            if (opts.deviceLabOwnerId) {
                args.push(...ports.captureBindMountArgs()(
                    ports.captureHostJoin()(opts.deviceLabStateHostDir, "owners", opts.deviceLabOwnerId),
                    `/home/ccc/.ccc/devices/owners/${opts.deviceLabOwnerId}`,
                ));
            }
            args.push("--tmpfs", "/home/ccc/.ccc/devices/broker/auth:rw,noexec,nosuid,nodev,mode=0711");
            if (opts.deviceLabOwnerAuthFile) {
                args.push(...ports.captureBindMountArgs()(opts.deviceLabOwnerAuthFile, ports.readBrokerAuthContainerFile(), { readonly: true }));
                args.push("-e", `CCC_DEVICE_BROKER_AUTH_FILE=${ports.readBrokerAuthContainerFile()}`);
            }
        }
        // Named volume — never gets :Z (mount helper auto-detects host-path vs name)
        args.push(...ports.captureBindMountArgs()(opts.miseVolumeName, "/home/ccc/.local/share/mise"));
        args.push(...ports.captureBindMountArgs()(opts.codexPackagesVolumeName ?? ports.readCodexPackagesVolumeName(), ports.readCodexPackagesContainerDir()));
        if (opts.labRunner) {
            // Lab state only matters where container-QEMU labs can run (REQ__lab-state-volume.md).
            if (opts.labRunner.status === "ready") {
                args.push(...ports.captureBindMountArgs()(opts.labRunner.stateVolumeName, opts.labRunner.stateContainerDir));
            }
        }
        // Container-manager socket: Docker uses /var/run/docker.sock,
        // Podman substitutes its own socket on the host side but keeps the same
        // in-container path so docker CLI shims inside the container keep working.
        const socketSource = resolveHostSocketPath();
        args.push(...ports.captureBindMountArgs()(socketSource, "/var/run/docker.sock", {
            sourceNamespace: ports.readRuntimeInfo().runtime === "docker" && socketSource !== "/var/run/docker.sock"
                ? "daemon"
                : "client",
        }));

        args.push("-w", opts.projectMountPath, "--pids-limit", opts.pidsLimit);

        // Runtime-specific: --userns=keep-id:uid=1000,gid=1000 on rootless podman
        args.push(...ports.captureRuntimeExtraRunArgs()());

        // Mount host SSH keys (read-only) for git SSH access
        if (opts.hostSshDir) {
            args.push(...ports.captureBindMountArgs()(opts.hostSshDir, "/home/ccc/.ssh", { readonly: true }));
            args.push(
                "-e",
                "GIT_SSH_COMMAND=ssh -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/.ssh-copy/known_hosts -o IdentityFile=/tmp/.ssh-copy/id_rsa -o IdentityFile=/tmp/.ssh-copy/id_ed25519",
            );
        }

        // Forward SSH agent socket
        if (opts.sshAgentSocket) {
            args.push(...ports.captureBindMountArgs()(opts.sshAgentSocket, "/tmp/ssh-agent.sock"));
            args.push("-e", "SSH_AUTH_SOCK=/tmp/ssh-agent.sock");
        }

        // Trust the project's mise config without requiring a separate `mise trust`
        // call. Baked in at container creation so every `docker exec` inherits it;
        // mise checks this env var in-memory on each invocation and skips the
        // trust-file write path entirely.
        args.push("-e", `MISE_TRUSTED_CONFIG_PATHS=${opts.projectMountPath}`);
        if (opts.proxyEnabled) {
            args.push("-e", "CCC_PROXY_ENABLED=1");
        }
        // Fixed at creation, unlike per-session env: the device-lab MCP uses it to know the container's
        // loopback is shared through a VM even when CCC_DISABLE_PROXY turned the proxy off
        // (doc/device-lab/REQ__container-broker-discovery.md).
        if (opts.containerHostRemote) {
            args.push("-e", "CCC_CONTAINER_HOST_REMOTE=1");
        }

        if (opts.labRunner) {
            args.push("-e", "CCC_LAB_RUNNER=1");
            args.push("-e", `CCC_LAB_RUNNER_STATUS=${opts.labRunner.status}`);
            args.push("-e", `CCC_LAB_STATE_DIR=${opts.labRunner.stateContainerDir}`);
            args.push("-e", `CCC_LAB_NET_MODE=${opts.labRunner.networkMode}`);
            if (opts.labRunner.unsupportedReason) {
                args.push("-e", `CCC_LAB_RUNNER_UNSUPPORTED_REASON=${opts.labRunner.unsupportedReason}`);
            }
            if (opts.labRunner.status === "ready" && opts.labRunner.kvmDevicePath) {
                args.push("--device", `${opts.labRunner.kvmDevicePath}:${opts.labRunner.kvmDevicePath}`);
                if (opts.labRunner.kvmGroupId !== undefined) {
                    args.push("--group-add", String(opts.labRunner.kvmGroupId));
                }
            }
        }

        // Extra volume mounts (e.g., source .git for worktree workspaces)
        if (opts.extraMounts) {
            for (const mount of opts.extraMounts) {
                args.push(...ports.captureBindMountArgs()(mount.hostPath, mount.containerPath));
            }
        }

        // Mount clipboard port file so shims can read the latest token even after server restarts
        if (opts.clipboardPortFile && ports.captureExistsSync()(opts.clipboardPortFile)) {
            args.push(...ports.captureBindMountArgs()(opts.clipboardPortFile, "/run/ccc/clipboard.port", { readonly: true }));
        }
        if (opts.clipboardFilesHostDir) {
            args.push(...ports.captureBindMountArgs()(opts.clipboardFilesHostDir, ports.readClipboardFilesContainerDir()));
        }

        args.push(...getComposeLabels(
            opts.containerName,
            opts.fullPath,
            opts.projectMountIdentity,
            opts.profile,
        ));
        if (opts.identity) {
            for (const [key, value] of ports.captureEntries()(ports.captureIdentityLabels()(opts.identity))) {
                args.push("--label", `${key}=${value}`);
            }
        }
        if (opts.deviceLabMountIdentity) {
            args.push("--label", `${ports.readDeviceLabMountIdentityLabel()}=${opts.deviceLabMountIdentity}`);
        }
        args.push(opts.imageName);
        return args;
    }

    return { buildRunArgs, resolveHostSocketPath };
}
