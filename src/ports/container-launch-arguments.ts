import type { RuntimeName } from "../domain/container-runtime.js";
import type { BindMountArgumentOptions, CurrentContainerMount, LaunchRuntimeFacts } from "../domain/container-launch-arguments.js";

export interface ContainerMountArgumentPorts {
    readSelinuxRelabelMode(): string | undefined;
    readRuntimeName(): RuntimeName;
    observeSelinuxEnforcing(): boolean;
    readContainerMarker(): string | undefined;
    isVitestProcess(): boolean;
    observeCurrentContainerMounts(): CurrentContainerMount[];
    captureHostJoin(): (...parts: string[]) => string;
    readRuntimeInfo(): LaunchRuntimeFacts;
    readPodmanCgroups(): string | undefined;
}

export interface ContainerLaunchArgumentPorts<Identity> {
    captureBindMountArgs(): (hostPath: string, containerPath: string, options?: BindMountArgumentOptions) => string[];
    captureRuntimeExtraRunArgs(): () => string[];
    readRuntimeInfo(): LaunchRuntimeFacts;
    captureExistsSync(): (path: string) => boolean;
    captureHostJoin(): (...parts: string[]) => string;
    captureIdentityLabels(): (identity: Identity) => Record<string, string>;
    captureEntries(): (value: Record<string, string>) => Array<[string, string]>;
    readCliVersion(): string;
    readProjectMountIdentityLabel(): string;
    readDeviceLabMountIdentityLabel(): string;
    readCodexPackagesVolumeName(): string;
    readCodexPackagesContainerDir(): string;
    readBrokerAuthContainerFile(): string;
    readClipboardFilesContainerDir(): string;
}

