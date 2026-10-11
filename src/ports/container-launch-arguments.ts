import type { ContainerLaunchOptions } from "../domain/container-launch-arguments.js";

export interface ContainerLaunchArgumentPorts<Identity> {
    observeHostFacts(options: ContainerLaunchOptions<Identity>): {
        ownerDirectory?: string;
        clipboardPortFilePresent: boolean;
    };
    identityLabels(identity: Identity): Array<[string, string]>;
    readCliVersion(): string;
    readProjectMountIdentityLabel(): string;
    readDeviceLabMountIdentityLabel(): string;
    readCodexPackagesVolumeName(): string;
    readCodexPackagesContainerDir(): string;
    readBrokerAuthContainerFile(): string;
    readClipboardFilesContainerDir(): string;
}

