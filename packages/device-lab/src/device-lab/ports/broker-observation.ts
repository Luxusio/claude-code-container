import type { LeaseDirectoryEntry, LeaseDirectoryInspection, LeaseDirectoryReader, OwnerInventory } from "../domain/broker-observation.js";
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

export type ProviderPlanObservation = ServiceQueryObservation | { error: string; missing: string[] };
export interface LifecyclePreviewPorts<Parsed extends LifecyclePreviewRequest, Context, DeviceProjection, CreateProjection, ProviderPlan extends ProviderPlanObservation, Allocation extends { ok: true; port: number } | { ok: false }> {
    readonly read: (ownerId: string, parsed: Parsed) => unknown[];
    readonly hyperV: (parsed: Parsed) => boolean;
    readonly validIncarnation: (parsed: Parsed) => boolean;
    readonly incarnation: (device: Record<string, unknown>) => string | null;
    readonly conflicts: (device: Record<string, unknown>, parsed: Parsed) => string[];
    readonly androidPort: (ownerId: string, parsed: Parsed) => Allocation;
    readonly createDefinition: (ownerId: string, parsed: Parsed) => unknown;
    readonly assertWritable: (devices: () => unknown[]) => void;
    readonly redactDevice: (device: unknown) => DeviceProjection;
    readonly redactHyperVDevice: (device: unknown) => DeviceProjection;
    readonly redactCreate: (parsed: Parsed) => CreateProjection;
    readonly publicHyperVCreate: (effective: Parsed, original: Parsed) => CreateProjection;
    readonly maskedHyperVPlan: () => ProviderPlan;
    readonly createPlan: (ownerId: string, parsed: Parsed, context: Context) => ProviderPlan;
    readonly existingPlan: (ownerId: string, parsed: Parsed, device: unknown, context: Context) => ProviderPlan;
    readonly attachmentMatches: (ownerId: string, parsed: Parsed, device: Record<string, unknown>) => boolean;
}
