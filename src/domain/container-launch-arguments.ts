export interface BindMountArgumentOptions {
    readonly?: boolean;
    sourceNamespace?: "client" | "daemon";
}

export interface ContainerLaunchLabConfig {
    status: "ready" | "unsupported";
    stateVolumeName: string;
    stateContainerDir: string;
    kvmDevicePath?: string;
    kvmGroupId?: number;
    networkMode: "user";
    unsupportedReason?: string;
}

export interface ContainerLaunchOptions<Identity> {
    containerName: string;
    fullPath: string;
    projectMountPath: string;
    profile?: string;
    credentialMounts: Array<{ hostPath: string; containerPath: string }>;
    gitIdentityMounts?: Array<{ hostPath: string; containerPath: string }>;
    claudeJsonFile: string;
    miseVolumeName: string;
    codexPackagesVolumeName?: string;
    identity?: Identity;
    pidsLimit: string;
    imageName: string;
    hostSshDir: string | null;
    sshAgentSocket: string | null;
    extraMounts?: Array<{
        hostPath: string;
        containerPath: string;
    }>;
    projectMountIdentity?: string;
    clipboardPortFile?: string;
    clipboardFilesHostDir?: string;
    /**
     * Optional in-container QEMU/KVM contract. Despite the historical
     * `labRunner` name, this is now used for ordinary containers too so
     * the device-lab Linux VM backend can run from the default CCC container.
     */
    labRunner?: ContainerLaunchLabConfig | null;
    deviceLabStateHostDir?: string;
    deviceLabOwnerId?: string;
    deviceLabOwnerAuthFile?: string;
    deviceLabMountIdentity?: string;
    /**
     * Tells the in-container entrypoint to install the iptables NAT REDIRECT
     * and start ccc-proxy. Set on Docker Desktop / WSL2 / podman-machine
     * flavors where --network host doesn't actually share the host loopback;
     * left unset on docker-native and rootful podman where it does.
     */
    proxyEnabled?: boolean;
    /** The runtime keeps containers in a VM (Docker Desktop, podman machine), independent of the proxy opt-out. */
    containerHostRemote?: boolean;
}

export type ContainerLaunchOperation =
    | { kind: "bind"; source: string; destination: string; readonly?: boolean }
    | { kind: "socket" }
    | { kind: "tmpfs"; destination: string; mode: number; noexec: boolean; nosuid: boolean; nodev: boolean }
    | { kind: "execution"; workdir: string; pidsLimit: string }
    | { kind: "runtime-extras" }
    | { kind: "ssh-command" }
    | { kind: "env"; key: string; value: string }
    | { kind: "device"; source: string; destination: string }
    | { kind: "group"; id: number }
    | { kind: "management-labels"; projectPath: string; profile: string; cliVersion: string }
    | { kind: "label"; key: string; value: string };

export interface ContainerLaunchPlan {
    containerName: string;
    hostname: string;
    imageName: string;
    network: "host";
    init: true;
    seccomp: "unconfined";
    capabilities: string[];
    operations: ContainerLaunchOperation[];
}
