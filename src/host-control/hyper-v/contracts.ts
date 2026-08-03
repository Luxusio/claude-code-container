export type HyperVProviderCommand = {
    mode: "exec";
    provider: "hyper-v" | "hyper-v-ssh" | "hyper-v-scp";
    executable: string;
    args: string[];
    input?: string;
};

export type HyperVReadiness = {
    ok: boolean;
    available: boolean;
    platform: string;
    moduleAvailable: boolean;
    hypervisorPresent: boolean;
    vmmsRunning: boolean;
    rebootPending: boolean;
    totalMemoryMb: number;
    freeMemoryMb: number;
    logicalProcessors: number;
    missing: string[];
    hyperVAdministratorsMember?: boolean;
    managementAccess?: boolean;
    sessionRefreshRequired?: boolean;
    detail?: string;
};

export type HyperVSetupObservation = {
    ok: boolean;
    featureName: "Microsoft-Hyper-V-All";
    beforeState: string;
    afterState: string;
    changed: boolean;
    elevated: boolean;
    rebootRequired: boolean;
    hyperVAdministratorsMember?: boolean;
    membershipChanged?: boolean;
    managementAccess?: boolean;
    sessionRefreshRequired?: boolean;
    network?: HyperVNetworkObservation;
};

export const HYPER_V_NETWORK_SWITCH = "CCC Device Lab";
export const HYPER_V_NETWORK_NAT = "CCCDeviceLab";
export const HYPER_V_NETWORK_MARKER = "ccc-device-lab:hyper-v-network:v1";
export const HYPER_V_NETWORK_PREFIX = "172.29.0.0/24";
export const HYPER_V_NETWORK_GATEWAY = "172.29.0.1";
export const HYPER_V_NETWORK_PREFIX_LENGTH = 24;
export const HYPER_V_PROVIDER_IMAGE_FINALIZATION_CONTRACT = "hyper-v-provider-image-finalization-v2";

export function isHyperVCccNetworkIdentity(marker: unknown, natName: unknown): marker is string {
    if (marker === HYPER_V_NETWORK_MARKER) return natName === HYPER_V_NETWORK_NAT;
    if (typeof marker !== "string" || typeof natName !== "string") return false;
    const token = /^ccc-device-lab:hyper-v-network:([a-f0-9]{24})$/.exec(marker)?.[1];
    return Boolean(token) && natName === `${HYPER_V_NETWORK_NAT}-${token}`;
}

export type HyperVVmObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    state: string;
    status: string;
    uptimeMs?: number;
    diskPath?: string;
    switchName?: string;
    generation?: 1 | 2;
    snapshots?: HyperVSnapshotObservation[];
};

export type HyperVDeleteObservation = HyperVVmObservation & {
    deleted: true;
};

export type HyperVSnapshotObservation = {
    ok: boolean;
    snapshotId: string;
    snapshotName: string;
    state?: string;
    snapshotType?: string;
};

export type HyperVSnapshotDeleteObservation = HyperVSnapshotObservation & {
    deleted: true;
};

export type HyperVGuestExecObservation = {
    ok: boolean;
    status: number;
    stdout: string;
    stderr: string;
};

export type HyperVGuestTransferObservation = {
    ok: boolean;
    localPath: string;
    remotePath: string;
    bytes: number;
};

export type HyperVGuestProvisionObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    guestUsername: string;
    credentialPath: string;
    unattendPath: string;
};

export type HyperVGuestReadyObservation = {
    ok: boolean;
    vmId: string;
    vmName: string;
    computerName: string;
    attempts: number;
    networkAddress?: string;
};

export type HyperVGuestReadyFailureObservation = {
    ok: false;
    error: "hyper-v-guest-ready-timeout";
    reason: string;
    attempts: number;
};

export type HyperVGuestBootDiagnosticObservation = {
    ok: true;
    vmId: string;
    vmName: string;
    state: string;
    uptimeMs: number;
    generation: 1 | 2;
    secureBootEnabled: boolean | null;
    heartbeatEnabled: boolean | null;
    heartbeatPrimaryStatus: number | null;
    heartbeatSecondaryStatus: number | null;
    integrationServices: Array<{
        name: string;
        enabled: boolean;
        primaryStatus: number | null;
        secondaryStatus: number | null;
    }>;
    hardDiskCount: number;
    dvdCount: number;
    hardDiskControllers: string[];
    bootDeviceTypes: string[];
};

export type HyperVBaseImageObservation = {
    ok: boolean;
    profile: "windows-11" | "windows-server" | "ubuntu-lts";
    imagePath: string;
    sha256: string;
    sizeBytes: number;
    virtualSizeBytes: number;
    vhdType: string;
    generation: 1 | 2;
    reused: boolean;
};

export type HyperVNetworkObservation = {
    ok: boolean;
    switchName: string;
    switchId: string;
    marker?: string;
    natName: string;
    natInstanceId: string;
    prefix: string;
    gateway: string;
    interfaceIndex: number;
    createdSwitch: boolean;
    createdGateway?: boolean;
    createdNat: boolean;
};

export type HyperVNetworkCleanupObservation = {
    ok: boolean;
    removedSwitch: boolean;
    removedNat: boolean;
    removedGateway: boolean;
    alreadyMissing: boolean;
};

export type HyperVNetworkAllocationIdentity = {
    ownerId: string;
    deviceId: string;
    incarnationId: string;
};

export type HyperVNetworkAllocationObservation = HyperVNetworkAllocationIdentity & {
    vmName: string;
    present: boolean;
    vmId?: string;
};

export type HyperVNetworkAllocationsObservation = {
    ok: true;
    allocations: HyperVNetworkAllocationObservation[];
};

export type HyperVNetworkAllocationsOptions = {
    executable: string;
    allocations: HyperVNetworkAllocationIdentity[];
};

export type HyperVRecoveryObservation = {
    ok: boolean;
    recoveredVm: boolean;
    removedDisk: boolean;
};

export type HyperVBootstrapNetworkCleanupObservation = {
    ok: boolean;
    removed: boolean;
    alreadyMissing: boolean;
};

export type HyperVBootstrapNetworkObservation = {
    ok: boolean;
    addresses: string[];
};

export type HyperVCommandOptions = {
    executable: string;
    ownerId: string;
    deviceId: string;
    incarnationId: string;
    vmName: string;
    vmId?: string | null;
    diskPath?: string | null;
    auxiliaryDiskPaths?: string[];
    auxiliaryMediaPaths?: string[];
};

export type HyperVCreateOptions = HyperVCommandOptions & {
    baseImagePath: string;
    baseImageSha256: string;
    baseImageGeneration: 1 | 2;
    baseImageRoot: string;
    deviceRoot: string;
    memoryMb: number;
    cpus: number;
    diskMaxBytes: number;
    switchName?: string | null;
    macAddress?: string | null;
    networking?: boolean;
    bootstrapDhcp?: boolean;
    secureBootTemplate?: "MicrosoftWindows" | "MicrosoftUEFICertificateAuthority";
};

export type HyperVStartOptions = HyperVCommandOptions & {
    memoryMb: number;
    cpus: number;
};

export type HyperVRebootOptions = HyperVCommandOptions & {
    force?: boolean;
    startIfStopped?: boolean;
};

export type HyperVSnapshotOptions = HyperVCommandOptions & {
    snapshotName: string;
    snapshotId?: string | null;
    force?: boolean;
};

export type HyperVGuestOptions = HyperVCommandOptions & {
    deviceRoot: string;
    privateRoot?: string;
    credentialPath: string;
};

export type HyperVGuestExecOptions = HyperVGuestOptions & {
    guestCommand: string;
};

export type HyperVGuestTransferOptions = HyperVGuestOptions & {
    localPath: string;
    remotePath: string;
    maxBytes?: number;
};

export type HyperVGuestProvisionOptions = HyperVGuestOptions & {
    provisioningMediaPath: string;
    guestUsername: string;
    guestPassword: string;
    networkAddress?: string | null;
    networkGateway?: string | null;
    networkPrefixLength?: number | null;
};

export type HyperVGuestReadyOptions = HyperVGuestOptions & {
    timeoutMs: number;
    expectedNetworkAddress?: string | null;
    provisioningMediaPath?: string | null;
};

export type HyperVBaseImageOptions = {
    executable: string;
    profile: "windows-11" | "windows-server" | "ubuntu-lts";
    sourceImagePath: string;
    sourceRoot: string;
    imagePath: string;
    imageRoot: string;
};

export type HyperVAutomaticBaseImageProfile = "windows-server" | "ubuntu-lts";

export type HyperVAcquireBaseImageOptions = {
    executable: string;
    profile: HyperVAutomaticBaseImageProfile;
    imageRoot: string;
    expectedGeneration: 1 | 2;
};

export type HyperVLinuxSeedOptions = HyperVCommandOptions & {
    deviceRoot: string;
    privateRoot: string;
    seedDiskPath: string;
    sshPrivateKeyPath: string;
    sshPublicKeyPath: string;
    sshHostPrivateKeyPath: string;
    sshHostPublicKeyPath: string;
    knownHostsPath: string;
    guestUsername: string;
    networkAddress: string;
    networkGateway: string;
    networkPrefixLength: number;
    macAddress: string;
    dnsServers?: string[];
};

export type HyperVLinuxSshOptions = {
    executable: string;
    deviceRoot: string;
    privateRoot?: string;
    sshPrivateKeyPath: string;
    knownHostsPath: string;
    guestUsername: string;
    networkAddress: string;
    hostKeyAlias?: string;
    timeoutMs?: number;
};

export type HyperVBootstrapNetworkCleanupOptions = HyperVCommandOptions;
export type HyperVBootstrapNetworkOptions = HyperVCommandOptions;

export type HyperVLinuxNetworkFinalizeOptions = HyperVLinuxSshOptions & {
    managedMacAddress: string;
    managedNetworkAddress: string;
    networkGateway: string;
    networkPrefixLength: number;
    dnsServers?: string[];
};

export type HyperVNetworkOptions = {
    executable: string;
    switchName: string;
    natName: string;
    prefix: string;
    gateway: string;
    prefixLength: number;
    marker: string;
    allowExistingNat?: boolean;
    allowCccOwnedNetworkAdoption?: boolean;
    expectedSwitchId?: string;
    expectedNatInstanceId?: string;
    elevated?: boolean;
    elevatedDeadlineUnixMs?: number;
};

export type HyperVNetworkCleanupOptions = HyperVNetworkOptions & {
    removeNat?: boolean;
    removeSwitch?: boolean;
    removeGateway?: boolean;
};
