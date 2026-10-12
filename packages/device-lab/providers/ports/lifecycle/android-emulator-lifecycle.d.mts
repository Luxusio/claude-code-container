export interface AndroidEmulatorLifecycleInput {
    backend?: string;
    name?: string;
    deviceId?: string;
    avdName?: string;
    port?: number;
    systemImage?: string;
    deviceProfile?: string;
    createAvd?: boolean;
    headless?: boolean;
    force?: boolean;
    deleteAvd?: boolean;
    waitForBoot?: boolean;
    bootTimeoutMs?: number;
}

export interface AndroidEmulatorLifecycleClaim {
    runtimeId: string;
    operation: string;
    claimedAt: string;
    startedAt?: string;
}

export interface AndroidEmulatorRuntime {
    runtimeId?: string;
    pid?: number;
    processIdentity?: unknown;
    identityUnavailable?: boolean;
    active?: boolean;
    [key: string]: unknown;
}

/** Mutable legacy carriers remain owned by their native repository. */
export interface AndroidEmulatorDevice {
    id: string;
    name?: string;
    backend?: string;
    avdName?: string;
    avdRoot?: string | null;
    port?: number;
    serial?: string;
    status?: string;
    pid?: number | null;
    runtime?: AndroidEmulatorRuntime | null;
    recording?: AndroidEmulatorRuntime | null;
    lifecycle?: AndroidEmulatorLifecycleClaim | null;
    [key: string]: unknown;
}

/** The real spawned handle crosses this boundary; a PID is not its identity. */
export interface AndroidEmulatorProcessHandle {
    readonly pid?: number;
}

export interface AndroidEmulatorDiscovery {
    adbAvailable: boolean;
    native: unknown;
    available: boolean;
    missing: string[];
    provisioningAvailable: boolean;
    provisioningMissing: string[];
}

export type AndroidEmulatorNativeObservation = { ok: boolean; diagnostic: unknown };
export type AndroidEmulatorLifecycleOutcome =
    | { kind: "refused"; message: string }
    | { kind: "native-failure"; diagnostic: unknown }
    | { kind: "identity-unavailable"; deviceId: string | undefined; termination: AndroidEmulatorTermination; stateReverted: boolean; runtimeStatePreserved: boolean }
    | { kind: "boot-process-exited"; deviceId: string | undefined; boot: AndroidEmulatorBoot; rollback: unknown; stateReverted: boolean }
    | { kind: "runtime-stop-failed"; deviceId: string | undefined; runtimeStop: AndroidEmulatorTermination }
    | { kind: "force-delete-stop-failed"; deviceId: string | undefined; adbStop: unknown; runtimeStop: AndroidEmulatorTermination | null; stateReverted: boolean }
    | { kind: "conflict"; deviceId: string | undefined; operation: string; found: boolean; rollback?: unknown }
    | { kind: "created" | "stopped"; device: AndroidEmulatorDevice }
    | { kind: "started"; device: AndroidEmulatorDevice; boot: AndroidEmulatorBoot }
    | { kind: "deleted"; deviceId: string | undefined; avdDeleted: boolean };

export interface AndroidEmulatorTransition {
    matched: boolean;
    found: boolean;
    [key: string]: unknown;
}

export type AndroidEmulatorPortAllocation =
    | { ok: true; port: number }
    | { ok: false; error: string; detail?: string; allowed?: string };
export type AndroidEmulatorLivePorts =
    | { ok: true; ports: Set<number> }
    | { ok: false; error: string; detail: string };
export type AndroidEmulatorAvdDeletion =
    | { ok: true; artifactsRemoved: number }
    | { ok: false; error: string };
export interface AndroidEmulatorTermination {
    ok?: boolean;
    exited: boolean;
    [key: string]: unknown;
}
export interface AndroidEmulatorBoot {
    ready: boolean;
    reason?: string;
    [key: string]: unknown;
}

/** Every required step is looked up at its operation phase; no workflow port. */
export interface AndroidEmulatorLifecyclePorts<Child extends AndroidEmulatorProcessHandle = AndroidEmulatorProcessHandle> {
    provisionAndroidAvd(discovery: AndroidEmulatorDiscovery, input: { avdName: string; systemImage: string; deviceProfile?: string }): AndroidEmulatorNativeObservation;
    launchAndroidEmulator(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice, input: AndroidEmulatorLifecycleInput): Promise<Child>;
    observeAndroidEmulator(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice): { live: boolean };
    stopAndroidEmulator(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice): AndroidEmulatorNativeObservation | null;
    stopAndroidRecorder(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice): void;
    androidAvdHome(): string;
    androidAvdIsInactive(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice | { avdName: string }): boolean;
    androidDeviceId(name: string | undefined): string;
    androidDiscovery(): AndroidEmulatorDiscovery;
    appiumPortForDevice(id: string): number;
    androidEmulatorSerial(port: number): string;
    approvedAndroidAvdRoot(recordedRoot: unknown): string | null;
    claimAndroidDevice(device: AndroidEmulatorDevice): { ok: true } | { ok: false; existing?: AndroidEmulatorDevice; field: string; value: unknown };
    deleteOwnedAndroidAvd(avdName: string | undefined, options: { avdRoot: string | null; verifyInactive: () => boolean }): AndroidEmulatorAvdDeletion;
    findAndroidDevice(deviceId: string | undefined): AndroidEmulatorDevice | null | undefined;
    isOwnedAvdName(avdName: unknown): avdName is string;
    isSafeDeviceProfile(deviceProfile: unknown): boolean;
    isSafeProvisionedAvdName(avdName: unknown): boolean;
    isSafeSystemImage(systemImage: unknown): boolean;
    listOwnedAndroidAvdArtifacts(owner: string, options: { root: string | null }): { name: string }[];
    liveAndroidEmulatorPortsForAllocation(discovery?: AndroidEmulatorDiscovery): AndroidEmulatorLivePorts;
    ownerAvdPrefix(): string;
    ownerId(): string;
    readAndroidDevices(): AndroidEmulatorDevice[];
    refreshOwnedRuntimeProcessIdentity(runtime: AndroidEmulatorRuntime): AndroidEmulatorRuntime;
    resolveAndroidEmulatorPort(owner: string, deviceId: string, requestedPort?: number, additionalUsedPorts?: Iterable<number>): AndroidEmulatorPortAllocation;
    signalAndroidRecorder(runtime: AndroidEmulatorRuntime | null | undefined): { signaled: boolean; [key: string]: unknown };
    slug(name: string | undefined): string;
    terminateFreshAndroidEmulatorProcessTree(child: Child): Promise<AndroidEmulatorTermination & { ok: boolean }>;
    terminateOwnedRuntimeProcessTree(runtime: AndroidEmulatorRuntime, label: string, options: { timeoutMs: number }): Promise<AndroidEmulatorTermination>;
    transitionAndroidDevice(deviceId: string | undefined, expected: AndroidEmulatorDevice, replacement: AndroidEmulatorDevice | null): AndroidEmulatorTransition;
    waitForAndroidBoot(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice, timeoutMs: number, child: Child): Promise<AndroidEmulatorBoot>;
    waitForProcessExit(pid: number | undefined, timeoutMs: number): Promise<boolean>;
    waitForProcessIdentity(pid: number | undefined, timeoutMs: number): Promise<unknown | null>;
    runtimeId(): string;
    wallTimestamp(): string;
}
