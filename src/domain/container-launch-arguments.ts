import type { RuntimeName } from "./container-runtime.js";

export interface BindMountArgumentOptions {
    readonly?: boolean;
    sourceNamespace?: "client" | "daemon";
}

export interface LaunchRuntimeFacts {
    runtime: RuntimeName;
    flavor: string;
    socketPath: string | null;
    remote: boolean;
}

export interface CurrentContainerMount {
    source: string;
    destination: string;
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

export function normalizeDockerMountSource(source: string): string {
    const match = source.match(/^([A-Za-z]):[\\/](.*)$/);
    if (!match) return source;
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    return `/run/desktop/mnt/host/${drive}/${rest}`;
}
