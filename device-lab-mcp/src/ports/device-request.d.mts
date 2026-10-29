import type { DeviceArguments, ActiveAppObservation, MobileEffect } from '../domain/device-request.mjs';
export type { DeviceArguments, ActiveAppObservation, MobileEffect };
export interface DeviceRecord { id: string; backend?: string; [key: string]: unknown }
export interface BrokerBackendObservation { name?: string; host?: string; provider?: string; stateKey?: string; devices?: DeviceRecord[]; error?: string; [key: string]: unknown }
export interface BackendDescription extends BrokerBackendObservation { name: string }
export interface DisplayTarget extends DeviceRecord { available: boolean; capabilities: unknown }
export interface BrokerPayload { backends?: BrokerBackendObservation[]; devices?: DeviceRecord[]; response?: { body?: AppiumBody }; [key: string]: unknown }
export interface AppiumBody { value?: unknown; screenshot?: string; bundleId?: string; bundleID?: string; [key: string]: unknown }
export interface BrokerResult { ok: boolean; result?: BrokerPayload; body?: BrokerPayload; selected?: {host: string; port: number}; [key: string]: unknown }
export interface BrokerObservation { ok:boolean; selection?:{host:string;port:number}; receipt:unknown }
export interface BrokerStatusObservation extends BrokerObservation { available:boolean }
export interface BrokerBackendsObservation extends BrokerObservation { backends:BrokerBackendObservation[]|null; payloadReceipt:unknown }
export interface BrokerInventoryObservation extends BrokerBackendsObservation { devices:DeviceRecord[]|null }
export type MobileObservation =
 | {kind:'completed';receipt:unknown;source?:unknown;sourceText?:string;clipboardText?:unknown;screenshotData?:string}
 | {kind:'failed';localBudgetExhausted:boolean;receipt:unknown};
export type SourceWaitOutcome =
 | {kind:'matched';text:string;source:string;backend:string;receipt:unknown}
 | {kind:'unmatched';text:string;source:string;backend:string;timeoutMs:number}
 | {kind:'deadline-before'}
 | {kind:'deadline-during'};
export interface BrokerToolPresentation { routedBy?:string; payload?:boolean }
export interface BrokerLifecyclePresentation { routedBy:string;implicit:boolean;deleted?:string;avdDeleted?:boolean;simulatorDeleted?:boolean }
export type BackendInference = {ok: true; backend: string; error?: undefined; matches?: string[]}|{ok:false; backend?: undefined; error: string; matches?: string[]};
export type PhysicalInference<Result> = {ok:true; backend:string; inventory:BrokerInventoryObservation|null; response?:undefined; handled?:undefined}|{ok:false; backend?:undefined; inventory?:undefined; response:Result; handled:true};
export interface DeviceRequest {publicName:string; operation:string; arguments:DeviceArguments; detail:boolean}
export interface DeviceRequestOptions { detail?: boolean; toolName?: string; toolAllowed?: (name: string) => boolean }
export interface DestructiveDecision { ok: boolean; [key: string]: unknown }
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
 observeBrokerStatus(args:DeviceArguments):Promise<BrokerStatusObservation>;
 observeBrokerBackends(args:DeviceArguments):Promise<BrokerBackendsObservation>;
 observeBrokerInventory(args:DeviceArguments):Promise<BrokerInventoryObservation>;
 invokeBrokerLifecycle(args:DeviceArguments):Promise<BrokerObservation>;
 brokerDeviceTool(args:DeviceArguments):Promise<BrokerObservation>;
 brokerPhysical(args:DeviceArguments):Promise<BrokerObservation>;
 ensureMobileSession(args:DeviceArguments):Promise<BrokerObservation>;
 observeMobileSessionStatus(args:DeviceArguments):Promise<BrokerObservation>;
 executeMobileEffect(args:DeviceArguments & {backend:string;deviceId:string},effect:MobileEffect):Promise<MobileObservation>;
 observeActiveApp(args: ActiveAppObservationInput): Promise<ActiveAppObservation>;
 presentActiveAppWait(outcome: ActiveAppWaitOutcome): Result;
 macosTartCreateRpcTimeoutMs(args: DeviceArguments): number|null;
 implicitBrokerProbeOptions(args: DeviceArguments, behavior?: {allowDefault?: boolean}): DeviceArguments|null;
 withBrokerOperation<T>(operation: () => Promise<T>): Promise<T>;
 normalizeToolArgs(args: unknown, name: string): DeviceArguments;
 normalizePublicToolArgs(name: string, args: unknown): DeviceArguments;
 toolInputError(name: string, args: unknown): string|null;
 execInputError(args: unknown): string|null;
 toolOperation(name: string, args: unknown): string;
 flowOperationAllowed(name: string, args?: unknown): boolean;
 flowStepArguments(tool: string, flowArgs: DeviceArguments, stepArgs: DeviceArguments): DeviceArguments;
 evaluateDestructivePolicy(name: string, args: unknown): DestructiveDecision;
 presentBrokerReceipt(receipt:unknown,extra:Record<string,unknown>):Result;
 presentBrokerTool(receipt:unknown,options:BrokerToolPresentation):Result;
 presentBrokerLifecycle(receipt:unknown,options:BrokerLifecyclePresentation):Result;
 presentBackendCatalog(value:import('../domain/device-request.mjs').BackendCatalogValue):Result;
 presentMobileObservation(name:string,backend:string,observation:Extract<MobileObservation,{kind:'completed'}>,extra:Record<string,unknown>):Result;
 presentSourceWait(outcome:SourceWaitOutcome):Result;
 jsonResult(value: unknown): Result;
 textResult(ok: boolean, text: string): Result;
 flowJsonResult(value: unknown, options: {detail: boolean}): Result;
 compactToolValue(toolName: string, value: unknown): unknown;
 actionResult(publicName: string, operation: string, result: Result, options: DeviceRequestOptions): Result;
 invokeBrokerListFiles(args:DeviceArguments,backend:string):Promise<BrokerObservation>;
 listDirectDeviceFiles(args:DeviceArguments,backend:string):Promise<Result>;
 listFilesFromExecResult(result: Result, args: DeviceArguments): Result;
 availableDevices(dispatch: (backend: string) => Promise<Result>, options: DeviceRequestOptions): Promise<Result>;
 startBootTimeoutMs(args: DeviceArguments): number;
 finishStartReadiness(result: Result, args: DeviceArguments, startedAt: number, dispatch: (name: string, args: DeviceArguments) => Promise<Result>): Promise<Result>;
 cropScreenshotResult(result: Result, region: unknown): Result|Promise<Result>;
 createWaitBudget(timeoutMs?: number, intervalMs?: number): WaitBudget;
 runDeviceFlow(args: DeviceArguments, options: DeviceRequestOptions, ports: DeviceFlowPorts<Result>): Promise<Result>;
}
