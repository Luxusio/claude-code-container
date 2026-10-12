import type { DeviceArguments } from '../domain/device-request.mjs';
export type { DeviceArguments };
export interface DeviceRecord { id: string; backend?: string; [key: string]: unknown }
export interface BrokerBackendObservation { name?: string; host?: string; provider?: string; stateKey?: string; devices?: DeviceRecord[]; error?: string; [key: string]: unknown }
export interface BackendDescription extends BrokerBackendObservation { name: string }
export interface DisplayTarget extends DeviceRecord { available: boolean; capabilities: unknown }
export interface BrokerPayload { backends?: BrokerBackendObservation[]; devices?: DeviceRecord[]; response?: { body?: AppiumBody }; [key: string]: unknown }
export interface AppiumBody { value?: unknown; screenshot?: string; bundleId?: string; bundleID?: string; [key: string]: unknown }
export interface BrokerResult { ok: boolean; result?: BrokerPayload; body?: BrokerPayload; selected?: {host: string; port: number}; [key: string]: unknown }
export type BackendInference = {ok: true; backend: string; error?: undefined; matches?: string[]}|{ok:false; backend?: undefined; error: string; matches?: string[]};
export type PhysicalInference<Result> = {ok:true; backend:string; inventory:BrokerResult|null; response?:undefined; handled?:undefined}|{ok:false; backend?:undefined; inventory?:undefined; response:Result; handled:true};
export interface MobileRequestItem {method: string; path: string; body: Record<string,unknown>; error?:undefined}
export interface MobileRequestSuccess {requests?:MobileRequestItem[]; method?:string; path?:string; body?:Record<string,unknown>; error?:undefined}
export type MobileRequest = {error:string; requests?:undefined; method?:undefined; path?:undefined; body?:undefined}|MobileRequestSuccess;
export interface DeviceRequest {publicName:string; operation:string; arguments:DeviceArguments; detail:boolean}
export interface DeviceRequestOptions { detail?: boolean; toolName?: string; toolAllowed?: (name: string) => boolean }
export interface DestructiveDecision { ok: boolean; [key: string]: unknown }
export type ActiveAppObservation =
 | {kind: 'observed'; activeAppId: unknown; foreground: boolean; receipt: unknown}
 | {kind: 'failed'; localBudgetExhausted: boolean; receipt: unknown};
export type ActiveAppObservationInput = DeviceArguments & {backend: string; expectedAppId: string; requestTimeoutMs: number};
export type ActiveAppWaitOutcome =
 | {kind: 'matched'; backend: string; expectedAppId: string; receipt: unknown}
 | {kind: 'unmatched'; backend: string; timeoutMs: number; receipt: unknown}
 | {kind: 'failed-observation'; receipt: unknown}
 | {kind: 'deadline-before'}
 | {kind: 'deadline-during'};
export interface WaitBudget { timeoutMs: number; remaining(): number; requestTimeout(maximum: number): number; pause(): Promise<void> }
export interface DeviceFlowPorts<Result> {
 toolInputError(name: string, args: unknown): string|null;
 flowOperationAllowed(name: string, args?: unknown): boolean;
 toolOperation(name: string, args: unknown): string;
 flowStepArguments(tool: string, flowArgs: DeviceArguments, stepArgs: DeviceArguments): DeviceArguments;
 normalizePublicToolArgs(name: string, args: unknown): DeviceArguments;
 withBrokerOperation<T>(operation: () => Promise<T>): Promise<T>;
 dispatchTool(name: string, args: DeviceArguments, options?: DeviceRequestOptions): Promise<Result>;
 evaluateDestructivePolicy(name: string, args: unknown): DestructiveDecision;
 policyDeniedResult(policy: DestructiveDecision): Result;
 actionResult(publicName: string, operation: string, result: Result, options: DeviceRequestOptions): Result;
 unexpectedError(message: string): Result;
 textFailure(message: string): Result;
 renderFlow(value: unknown, options: {toolName: string; detail: boolean}): Result;
}
export type ProviderRequest<Result> = (name: string, args: DeviceArguments) => Result|null|undefined|Promise<Result|null|undefined>;
export interface DeviceRequestPorts<Result> {
 OWNER_DEVICE_ID_PATTERN: RegExp;
 OPERATION_TOOLS: readonly {name: string; inputSchema?: {required?: readonly string[]}}[];
 DEVICE_FLOW_TOOL_NAMES: readonly string[];
 now(): number;
 encodeBase64(text: string): string;
 decodeBase64(text: string): string;
 ownerId(): string;
 readOwnerDevices(stateKey: string): DeviceRecord[];
 currentDisplayTarget(): DisplayTarget;
 listAndroidDevices(): DeviceRecord[];
 listAndroidRealDevices(): DeviceRecord[];
 listIosDevices(options?: {identityOnly?: boolean}): DeviceRecord[];
 listIosRealDevices(): DeviceRecord[];
 listMacosDevices(options?: {identityOnly?: boolean}): DeviceRecord[];
 listLinuxVmDevices(options?: {strictState?: boolean}): DeviceRecord[];
 listWindowsDevices(): DeviceRecord[];
 listWindowsVmDevices(): DeviceRecord[];
 androidDiscovery(): unknown;
 iosDiscovery(): unknown;
 iosRealDiscovery(ios: unknown): unknown;
 androidBackend(discovery?: unknown): BackendDescription;
 androidRealBackend(discovery?: unknown): BackendDescription;
 iosBackend(discovery?: unknown): BackendDescription;
 iosRealBackend(discovery?: unknown): BackendDescription;
 macosBackend(): BackendDescription;
 linuxVmBackend(): BackendDescription;
 windowsBackend(): BackendDescription;
 windowsVmBackend(): BackendDescription;
 handleAndroidTool: ProviderRequest<Result>;
 handleAndroidRealTool: ProviderRequest<Result>;
 handleIosTool: ProviderRequest<Result>;
 handleIosRealTool: ProviderRequest<Result>;
 handleMacosTool: ProviderRequest<Result>;
 handleLinuxVmManagementTool: ProviderRequest<Result>;
 handleLinuxVmTool: ProviderRequest<Result>;
 handleWindowsTool: ProviderRequest<Result>;
 handleDisplayTool: ProviderRequest<Result>;
 brokerStatus(args: DeviceArguments): Promise<BrokerResult>;
 brokerCommand(args: DeviceArguments): Promise<BrokerResult>;
 brokerDeviceTool(args: DeviceArguments): Promise<BrokerResult>;
 brokerPhysical(args: DeviceArguments): Promise<BrokerResult>;
 observeActiveApp(args: ActiveAppObservationInput): Promise<ActiveAppObservation>;
 presentActiveAppWait(outcome: ActiveAppWaitOutcome): Result;
 brokerAppium(args: DeviceArguments): Promise<BrokerResult>;
 brokerRpc(args: DeviceArguments): Promise<BrokerResult>;
 implicitBrokerProbeOptions(args: DeviceArguments, behavior?: {allowDefault?: boolean}): DeviceArguments|null;
 isLocalObservationBudgetExhaustion(result: BrokerResult): boolean;
 withBrokerOperation<T>(operation: () => Promise<T>): Promise<T>;
 normalizeToolArgs(args: unknown, name: string): DeviceArguments;
 normalizePublicToolArgs(name: string, args: unknown): DeviceArguments;
 toolInputError(name: string, args: unknown): string|null;
 toolOperation(name: string, args: unknown): string;
 flowOperationAllowed(name: string, args?: unknown): boolean;
 flowStepArguments(tool: string, flowArgs: DeviceArguments, stepArgs: DeviceArguments): DeviceArguments;
 evaluateDestructivePolicy(name: string, args: unknown): DestructiveDecision;
 presentBrokerTool(receipt: BrokerResult, selectedFallbackValue: unknown): Result;
 imageResult(image: {data: string; mimeType: "image/png"}): Result;
 jsonResult(value: unknown): Result;
 textResult(ok: boolean, text: string): Result;
 flowJsonResult(value: unknown, options: {detail: boolean}): Result;
 compactToolValue(toolName: string, value: unknown): unknown;
 actionResult(publicName: string, operation: string, result: Result, options: DeviceRequestOptions): Result;
 buildListFilesCommand(backend: string, args: DeviceArguments): string;
 listFilesFromExecResult(result: Result, args: DeviceArguments): Result;
 availableDevices(dispatch: (backend: string) => Promise<Result>, options: DeviceRequestOptions): Promise<Result>;
 startBootTimeoutMs(args: DeviceArguments): number;
 finishStartReadiness(result: Result, args: DeviceArguments, startedAt: number, dispatch: (name: string, args: DeviceArguments) => Promise<Result>): Promise<Result>;
 cropScreenshotResult(result: Result, region: unknown): Result|Promise<Result>;
 createWaitBudget(timeoutMs?: number, intervalMs?: number): WaitBudget;
 runDeviceFlow(args: DeviceArguments, options: DeviceRequestOptions, ports: DeviceFlowPorts<Result>): Promise<Result>;
}
