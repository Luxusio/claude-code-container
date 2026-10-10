import type { DeviceArguments } from '../domain/device-request.mjs';
export type { DeviceArguments };
export interface DeviceContent { type: string; text?: string; data?: string; mimeType?: string; [key: string]: unknown }
export interface DeviceResult { content: DeviceContent[]; isError?: boolean; [key: string]: unknown }
export interface DeviceRecord { id: string; backend?: string; [key: string]: unknown }
export interface BrokerBackendObservation { name?: string; host?: string; provider?: string; stateKey?: string; devices?: DeviceRecord[]; error?: string; [key: string]: unknown }
export interface BackendDescription extends BrokerBackendObservation { name: string }
export interface DisplayTarget extends DeviceRecord { available: boolean; capabilities: unknown }
export interface BrokerPayload { backends?: BrokerBackendObservation[]; devices?: DeviceRecord[]; mcpResult?: DeviceResult; response?: { body?: AppiumBody }; [key: string]: unknown }
export interface AppiumBody { value?: unknown; screenshot?: string; bundleId?: string; bundleID?: string; [key: string]: unknown }
export interface BrokerResult { ok: boolean; result?: BrokerPayload; body?: BrokerPayload; selected?: {host: string; port: number}; [key: string]: unknown }
export type BackendInference = {ok: true; backend: string; error?: undefined; matches?: string[]}|{ok:false; backend?: undefined; error: string; matches?: string[]};
export type PhysicalInference = {ok:true; backend:string; inventory:BrokerResult|null; response?:undefined; handled?:undefined}|{ok:false; backend?:undefined; inventory?:undefined; response:DeviceResult; handled:true};
export interface MobileRequestItem {method: string; path: string; body: Record<string,unknown>; error?:undefined}
export interface MobileRequestSuccess {requests?:MobileRequestItem[]; method?:string; path?:string; body?:Record<string,unknown>; error?:undefined}
export type MobileRequest = {error:string; requests?:undefined; method?:undefined; path?:undefined; body?:undefined}|MobileRequestSuccess;
export interface DeviceRequest {publicName:string; operation:string; arguments:DeviceArguments; detail:boolean}
export interface DeviceRequestOptions { detail?: boolean; toolName?: string; toolAllowed?: (name: string) => boolean }
export interface DestructiveDecision { ok: boolean; [key: string]: unknown }
export interface WaitBudget { timeoutMs: number; remaining(): number; requestTimeout(maximum: number): number; pause(): Promise<void> }
export interface FlowSummary { isError: boolean; error?: string; contentIndex?: number; contentCount?: number; content?: unknown[] }
export interface DeviceFlowPorts {
 toolInputError(name: string, args: unknown): string|null;
 flowOperationAllowed(name: string, args?: unknown): boolean;
 toolOperation(name: string, args: unknown): string;
 flowStepArguments(tool: string, flowArgs: DeviceArguments, stepArgs: DeviceArguments): DeviceArguments;
 normalizePublicToolArgs(name: string, args: unknown): DeviceArguments;
 withBrokerOperation<T>(operation: () => Promise<T>): Promise<T>;
 dispatchTool(name: string, args: DeviceArguments, options?: DeviceRequestOptions): Promise<DeviceResult>;
 evaluateDestructivePolicy(name: string, args: unknown): DestructiveDecision;
 policyDeniedResult(policy: DestructiveDecision): DeviceResult;
 summarizeToolResult(name: string, result: DeviceResult, nativeContent: DeviceContent[]): FlowSummary;
 actionResult(publicName: string, operation: string, result: DeviceResult, options: DeviceRequestOptions): DeviceResult;
 unexpectedError(message: string): DeviceResult;
 textFailure(message: string): DeviceResult;
 renderFlow(value: unknown, options: {toolName: string; detail: boolean}): DeviceResult;
}
export type ProviderRequest = (name: string, args: DeviceArguments) => DeviceResult|null|undefined|Promise<DeviceResult|null|undefined>;
export interface DeviceRequestPorts {
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
 handleAndroidTool: ProviderRequest;
 handleAndroidRealTool: ProviderRequest;
 handleIosTool: ProviderRequest;
 handleIosRealTool: ProviderRequest;
 handleMacosTool: ProviderRequest;
 handleLinuxVmManagementTool: ProviderRequest;
 handleLinuxVmTool: ProviderRequest;
 handleWindowsTool: ProviderRequest;
 handleDisplayTool: ProviderRequest;
 brokerStatus(args: DeviceArguments): Promise<BrokerResult>;
 brokerCommand(args: DeviceArguments): Promise<BrokerResult>;
 brokerDeviceTool(args: DeviceArguments): Promise<BrokerResult>;
 brokerPhysical(args: DeviceArguments): Promise<BrokerResult>;
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
 jsonResult(value: unknown): DeviceResult;
 textResult(ok: boolean, text: string): DeviceResult;
 flowJsonResult(value: unknown, options: {detail: boolean}): DeviceResult;
 compactToolValue(toolName: string, value: unknown): unknown;
 actionResult(publicName: string, operation: string, result: DeviceResult, options: DeviceRequestOptions): DeviceResult;
 buildListFilesCommand(backend: string, args: DeviceArguments): string;
 listFilesFromExecResult(result: DeviceResult, args: DeviceArguments): DeviceResult;
 availableDevices(dispatch: (backend: string) => Promise<DeviceResult>, options: DeviceRequestOptions): Promise<DeviceResult>;
 startBootTimeoutMs(args: DeviceArguments): number;
 finishStartReadiness(result: DeviceResult, args: DeviceArguments, startedAt: number, dispatch: (name: string, args: DeviceArguments) => Promise<DeviceResult>): Promise<DeviceResult>;
 cropScreenshotResult(result: DeviceResult, region: unknown): DeviceResult|Promise<DeviceResult>;
 createWaitBudget(timeoutMs?: number, intervalMs?: number): WaitBudget;
 runDeviceFlow(args: DeviceArguments, options: DeviceRequestOptions, ports: DeviceFlowPorts): Promise<DeviceResult>;
}
