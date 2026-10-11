import type { ContainerLaunchOptions, ContainerLaunchOperation, ContainerLaunchPlan } from "../domain/container-launch-arguments.js";
import type { ContainerLaunchArgumentPorts } from "../ports/container-launch-arguments.js";

export function createContainerLaunchArguments<Identity>(ports: ContainerLaunchArgumentPorts<Identity>) {
    function buildPlan(opts: ContainerLaunchOptions<Identity>): ContainerLaunchPlan {
        const facts = ports.observeHostFacts(opts);
        // Preserve operation order: overlays and duplicate entries are intentional.
        const operations: ContainerLaunchOperation[] = [];
        const bind = (source: string, destination: string, readonly?: boolean) => {
            operations.push({ kind: "bind", source, destination, ...(readonly ? { readonly } : {}) });
        };
        const env = (key: string, value: string) => { operations.push({ kind: "env", key, value }); };
        const tmpfs = (destination: string) => {
            operations.push({ kind: "tmpfs", destination, mode: 0o711, noexec: true, nosuid: true, nodev: true });
        };
        bind(opts.fullPath, opts.projectMountPath);
        for (const mount of opts.credentialMounts) bind(mount.hostPath, mount.containerPath);
        for (const mount of opts.gitIdentityMounts ?? []) bind(mount.hostPath, mount.containerPath, true);
        bind(opts.claudeJsonFile, "/home/ccc/.claude.json");
        if (opts.deviceLabStateHostDir) {
            bind(opts.deviceLabStateHostDir, "/home/ccc/.ccc/devices", true);
            tmpfs("/home/ccc/.ccc/devices/owners");
            if (opts.deviceLabOwnerId && facts.ownerDirectory) {
                bind(facts.ownerDirectory, `/home/ccc/.ccc/devices/owners/${opts.deviceLabOwnerId}`);
            }
            tmpfs("/home/ccc/.ccc/devices/broker/auth");
            if (opts.deviceLabOwnerAuthFile) {
                bind(opts.deviceLabOwnerAuthFile, ports.readBrokerAuthContainerFile(), true);
                env("CCC_DEVICE_BROKER_AUTH_FILE", ports.readBrokerAuthContainerFile());
            }
        }
        bind(opts.miseVolumeName, "/home/ccc/.local/share/mise");
        bind(opts.codexPackagesVolumeName ?? ports.readCodexPackagesVolumeName(), ports.readCodexPackagesContainerDir());
        if (opts.labRunner?.status === "ready") bind(opts.labRunner.stateVolumeName, opts.labRunner.stateContainerDir);
        operations.push({ kind: "socket" });
        operations.push({ kind: "execution", workdir: opts.projectMountPath, pidsLimit: opts.pidsLimit });
        operations.push({ kind: "runtime-extras" });
        if (opts.hostSshDir) {
            bind(opts.hostSshDir, "/home/ccc/.ssh", true);
            operations.push({ kind: "ssh-command" });
        }
        if (opts.sshAgentSocket) {
            bind(opts.sshAgentSocket, "/tmp/ssh-agent.sock");
            env("SSH_AUTH_SOCK", "/tmp/ssh-agent.sock");
        }
        env("MISE_TRUSTED_CONFIG_PATHS", opts.projectMountPath);
        if (opts.proxyEnabled) env("CCC_PROXY_ENABLED", "1");
        if (opts.containerHostRemote) env("CCC_CONTAINER_HOST_REMOTE", "1");
        if (opts.labRunner) {
            env("CCC_LAB_RUNNER", "1");
            env("CCC_LAB_RUNNER_STATUS", opts.labRunner.status);
            env("CCC_LAB_STATE_DIR", opts.labRunner.stateContainerDir);
            env("CCC_LAB_NET_MODE", opts.labRunner.networkMode);
            if (opts.labRunner.unsupportedReason) env("CCC_LAB_RUNNER_UNSUPPORTED_REASON", opts.labRunner.unsupportedReason);
            if (opts.labRunner.status === "ready" && opts.labRunner.kvmDevicePath) {
                operations.push({ kind: "device", source: opts.labRunner.kvmDevicePath, destination: opts.labRunner.kvmDevicePath });
                if (opts.labRunner.kvmGroupId !== undefined) operations.push({ kind: "group", id: opts.labRunner.kvmGroupId });
            }
        }
        for (const mount of opts.extraMounts ?? []) bind(mount.hostPath, mount.containerPath);
        if (opts.clipboardPortFile && facts.clipboardPortFilePresent) bind(opts.clipboardPortFile, "/run/ccc/clipboard.port", true);
        if (opts.clipboardFilesHostDir) bind(opts.clipboardFilesHostDir, ports.readClipboardFilesContainerDir());
        operations.push({ kind: "management-labels", projectPath: opts.fullPath, profile: opts.profile ?? "", cliVersion: ports.readCliVersion() });
        if (opts.projectMountIdentity) operations.push({ kind: "label", key: ports.readProjectMountIdentityLabel(), value: opts.projectMountIdentity });
        if (opts.identity) {
            for (const [key, value] of ports.identityLabels(opts.identity)) operations.push({ kind: "label", key, value });
        }
        if (opts.deviceLabMountIdentity) operations.push({ kind: "label", key: ports.readDeviceLabMountIdentityLabel(), value: opts.deviceLabMountIdentity });
        return {
            containerName: opts.containerName, hostname: opts.containerName.slice(0, 63),
            imageName: opts.imageName, network: "host", init: true, seccomp: "unconfined",
            capabilities: ["NET_ADMIN"], operations,
        };
    }

    return { buildPlan };
}
