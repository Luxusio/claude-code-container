import type { DeviceStatusRequest, DeviceStatusOutcome, DeviceStatusPreparation, DeviceStatusPhysicalAdmission, DeviceStatusExecution } from "../domain/broker-observation.js";
import type { DiscoveryExecutable, DiscoveryImageCache, DiscoveryReadiness, LeaseDirectoryEntry, LeaseDirectoryInspection, LeaseDirectoryReader, OwnerInventory } from "../domain/broker-observation.js";
import type { LifecyclePreviewRequest } from "../domain/broker-observation-command-plan.js";

export interface OwnerInventoryPorts<File, Device> {
    readonly root: () => string;
    readonly file: (root: string, ownerId: string, stateKey: string) => File;
    readonly exists: (file: File) => boolean;
    readonly stat: (file: File) => { size: number };
    readonly read: (file: File, maxBytes: number) => Device[];
    readonly redact: (device: Device, index: number, devices: Device[]) => Device;
    readonly errorCode: (error: unknown) => string | null;
    readonly ownerRoot: (root: string, ownerId: string) => string;
}

export interface FocusedInventoryPorts<Device, Context, Host extends { devices: unknown }, Choices extends object> {
    readonly inventory: (ownerId: string) => OwnerInventory<Device>;
    readonly androidHost: (context: Context) => Host;
    readonly androidChoices: (context: Context) => Choices | null;
    readonly backend: (entry: { stateKey: string }) => string | null;
}

export interface LeaseDatePorts {
    readonly parse: (value: () => string) => number;
    readonly epoch: () => string;
    readonly expiryFrom: (updatedAt: string, ttlMs: number) => string;
}

export interface LeaseDirectoryPorts<Root, File, Entry extends LeaseDirectoryEntry, Inspection extends LeaseDirectoryInspection> {
    readonly root: (backend: string) => Root;
    readonly inspect: (backend: string) => Inspection;
    readonly assertRoot: (root: Root) => void;
    readonly open: (root: Root) => LeaseDirectoryReader<Entry>;
    readonly entryFile: (root: Root, entry: Entry) => File;
    readonly errorCode: (error: unknown) => string | null;
}

export interface LeaseListPorts<File> {
    readonly read: (file: File, backend: string, hardwareId: string) => Record<string, unknown> | null;
    readonly expired: (lease: Record<string, unknown>) => boolean;
    readonly expiresAt: (lease: Record<string, unknown>) => string;
    readonly ttlMs: (lease: Record<string, unknown>) => number;
}

export interface MetadataObservationPorts {
    readonly read: (ownerId: string, stateKey: string) => unknown[];
}

export interface BrokerStatusPorts<Context, Service, Owner extends { ownerId: string } | null, Address, Paths, Persistence, ServiceFacts, Elevation> {
    readonly root: () => string;
    readonly service: (context: Context) => Service;
    readonly serviceOwner: () => Owner;
    readonly runtimeFile: () => string;
    readonly runtime: () => Record<string, unknown> | null;
    readonly address: (context: Context) => Address;
    readonly hostId: () => string;
    readonly pid: () => number;
    readonly startToken: () => string | null;
    readonly startedAt: (context: Context) => string;
    readonly paths: (root: string, ownerId: string) => Paths;
    readonly exists: (root: string) => boolean;
    readonly persistence: (ownerId: string) => Persistence;
    readonly serviceFacts: (service: Service) => ServiceFacts;
    readonly elevation: () => Elevation;
}

export interface ServiceQueryObservation { mode: string; provider: string }
export interface BrokerServicePorts<Context, Action extends string, Plan extends { supported: boolean; definitionPath: string | null }, Owner extends { ownerId: string } | null, Command, Result extends ServiceQueryObservation, Projection> {
    readonly plan: (context: Context) => Plan;
    readonly commands: (action: Action, plan: Plan, context: Context) => Command[];
    readonly dryRun: (context: Context) => boolean;
    readonly owner: () => Owner;
    readonly installed: (plan: Plan) => boolean;
    readonly query: (context: Context, command: Command) => Result;
    readonly succeeded: (result: Result) => boolean;
    readonly projection: (plan: Plan, commands: Command[]) => Projection;
    readonly diagnostics: (plan: Plan) => string[];
}

export interface AndroidPreviewPortAllocationPorts<Parsed extends LifecyclePreviewRequest> {
    readonly valid: (port: unknown) => port is number;
    readonly allocated: () => Set<number>;
    readonly inventoryError: (error: unknown) => string;
    readonly seed: (ownerId: string, parsed: Parsed) => number;
}

export interface LifecyclePreviewPorts<Parsed extends LifecyclePreviewRequest, Context, ProviderPlan, Allocation extends { ok: true; port: number } | { ok: false }> {
    readonly read: (ownerId: string, parsed: Parsed) => unknown[];
    readonly hyperV: (parsed: Parsed) => boolean;
    readonly validIncarnation: (parsed: Parsed) => boolean;
    readonly incarnation: (device: Record<string, unknown>) => string | null;
    readonly conflicts: (device: Record<string, unknown>, parsed: Parsed) => string[];
    readonly androidPort: (ownerId: string, parsed: Parsed) => Allocation;
    readonly createDefinition: (ownerId: string, parsed: Parsed) => unknown;
    readonly assertWritable: (devices: () => unknown[]) => void;
    readonly createPlan: (ownerId: string, parsed: Parsed, context: Context) => ProviderPlan;
    readonly existingPlan: (ownerId: string, parsed: Parsed, device: unknown, context: Context) => ProviderPlan;
    readonly attachmentMatches: (ownerId: string, parsed: Parsed, device: Record<string, unknown>) => boolean;
}

export interface HostBackendDiscoveryPorts {
    readonly executable: (name: DiscoveryExecutable) => string | null;
    readonly hostId: () => string;
    readonly hyperVReadiness: (powershell: string, timeoutMs: number) => Promise<DiscoveryReadiness | null>;
    readonly ubuntuImageCache: (ownerId: string) => DiscoveryImageCache;
}

export interface BrokerDeviceStatusPorts<Connection, Receipt> {
    preview(owner: string, request: DeviceStatusRequest, params: unknown): DeviceStatusPreparation<Connection>;
    refreshPhysicalLease(owner: string, request: DeviceStatusRequest, device: Record<string, unknown>): DeviceStatusPhysicalAdmission;
    observe(connection: Connection): DeviceStatusExecution<Receipt> | PromiseLike<DeviceStatusExecution<Receipt>>;
    observeHyperVFallback(connection: Connection, deadline: number): Promise<DeviceStatusExecution<Receipt>>;
    typedStatus(connection: Connection, identity: {ownerId: string; deviceId: string; incarnationId: string; vmId: string; vmName: string}, deadline: number): Promise<DeviceStatusExecution<Receipt>>;
    incarnation(device: Record<string, unknown>): string | null;
    validIncarnation(value: unknown): value is string;
    deadlineExpired(deadline: number): boolean;
    assertDeadline(deadline: number): undefined;
    timestamp(): string;
    diagnosticCode(execution: DeviceStatusExecution<Receipt>, fallback: string): string | undefined;
    operationPending(owner: string, backend: string, id: string): boolean;
    snapshotPending(owner: string, backend: string, id: string): boolean;
    readDevices(owner: string, state: string): unknown[];
    readOperationJournal(owner: string, backend: string, id: string): {incarnationId: string} | null;
    readSnapshotJournal(owner: string, backend: string, id: string): {operationId: string} | null;
    reconcileOperation(owner: string, backend: string, id: string, deadline: number, preserveNetwork: true): Promise<import("../domain/lifecycle/hyper-v-stop-delete.js").HyperVReplayResult>;
    repairSnapshots(owner: string, backend: string, id: string, device: Record<string, unknown>, connection: Connection, parentDeadlineAt?: number): Promise<import("../domain/lifecycle/hyper-v-snapshots.js").SnapshotRepairResult>;
    recoveryConnection(): Connection | null;
    stateErrorCode(error: unknown): string | null;
    stateFailure(error: unknown, request: DeviceStatusRequest): import("../domain/lifecycle/hyper-v-stop-delete.js").HyperVStateFailure;
    errorCode(error: unknown, fallback: string): string;
    withHostLock(deadline: number, operation: () => Promise<DeviceStatusOutcome<Connection, Receipt>>): Promise<DeviceStatusOutcome<Connection, Receipt>>;
    lockTimedOut(error: unknown): boolean;
}
