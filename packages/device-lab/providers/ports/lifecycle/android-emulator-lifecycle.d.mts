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
    adb: string | null;
    emulator: string | null;
    avdmanager: string | null;
    available: boolean;
    missing: string[];
    provisioningAvailable: boolean;
    provisioningMissing: string[];
}

export interface AndroidEmulatorCommandResult {
    status: number | null;
    stdout: string;
    stderr: string;
    [key: string]: unknown;
}

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
export interface AndroidEmulatorLifecyclePorts<Result, Child extends AndroidEmulatorProcessHandle = AndroidEmulatorProcessHandle> {
    androidAvdHome(): string;
    androidAvdIsInactive(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice | { avdName: string }): boolean;
    androidDeviceId(name: string | undefined): string;
    androidDiscovery(): AndroidEmulatorDiscovery;
    androidEmulatorStartArgs(device: AndroidEmulatorDevice, args: AndroidEmulatorLifecycleInput): string[];
    androidLifecycleConflict(deviceId: string | undefined, operation: string, transition: AndroidEmulatorTransition, rollback?: unknown): Result;
    androidSerial(device: AndroidEmulatorDevice): string | undefined;
    appiumPortForDevice(id: string): number;
    approvedAndroidAvdRoot(recordedRoot: unknown): string | null;
    claimAndroidDevice(device: AndroidEmulatorDevice): { ok: true } | { ok: false; existing?: AndroidEmulatorDevice; field: string; value: unknown };
    deleteOwnedAndroidAvd(avdName: string | undefined, options: { avdRoot: string | null; verifyInactive: () => boolean }): AndroidEmulatorAvdDeletion;
    fail(result: AndroidEmulatorCommandResult): Result;
    findAndroidDevice(deviceId: string | undefined): AndroidEmulatorDevice | null | undefined;
    isOwnedAvdName(avdName: unknown): avdName is string;
    isSafeDeviceProfile(deviceProfile: unknown): boolean;
    isSafeProvisionedAvdName(avdName: unknown): boolean;
    isSafeSystemImage(systemImage: unknown): boolean;
    jsonResult(payload: unknown): Result;
    listOwnedAndroidAvdArtifacts(owner: string, options: { root: string | null }): { name: string }[];
    liveAndroidEmulatorPortsForAllocation(discovery?: AndroidEmulatorDiscovery): AndroidEmulatorLivePorts;
    ownerAvdPrefix(): string;
    ownerId(): string;
    publicAndroidDevice(device: AndroidEmulatorDevice): unknown;
    readAndroidDevices(): AndroidEmulatorDevice[];
    refreshOwnedRuntimeProcessIdentity(runtime: AndroidEmulatorRuntime): AndroidEmulatorRuntime;
    resolveAndroidEmulatorPort(owner: string, deviceId: string, requestedPort?: number, additionalUsedPorts?: Iterable<number>): AndroidEmulatorPortAllocation;
    run(executable: string, args: string[]): AndroidEmulatorCommandResult;
    runWithInput(executable: string | null, args: string[], input: string, options: { timeout: number }): AndroidEmulatorCommandResult;
    signalOwnedRuntimeProcess(runtime: AndroidEmulatorRuntime | null | undefined, signal: string): { signaled: boolean; [key: string]: unknown };
    slug(name: string | undefined): string;
    spawnAndroidEmulator(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice, args: string[]): Promise<Child>;
    terminateFreshAndroidEmulatorProcessTree(child: Child): Promise<AndroidEmulatorTermination>;
    terminateOwnedRuntimeProcessTree(runtime: AndroidEmulatorRuntime, label: string, options: { timeoutMs: number }): Promise<AndroidEmulatorTermination>;
    textResult(ok: boolean, text: string): Result;
    transitionAndroidDevice(deviceId: string | undefined, expected: AndroidEmulatorDevice, replacement: AndroidEmulatorDevice | null): AndroidEmulatorTransition;
    waitForAndroidBoot(discovery: AndroidEmulatorDiscovery, device: AndroidEmulatorDevice, timeoutMs: number, child: Child): Promise<AndroidEmulatorBoot>;
    waitForProcessExit(pid: number | undefined, timeoutMs: number): Promise<boolean>;
    waitForProcessIdentity(pid: number | undefined, timeoutMs: number): Promise<unknown | null>;
    runtimeId(): string;
    wallTimestamp(): string;
}
