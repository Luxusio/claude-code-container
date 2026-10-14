export interface QemuScope { env: Record<string,string|undefined>; stateRoot: string; owner: string; ownerRoot: string; }
export interface QemuLifecycleArguments { [key:string]: unknown; name?: unknown; labId?: unknown; force?: unknown; dryRun?: unknown; baseImageId?: unknown; sourceImage?: unknown; memoryMb?: unknown; cpus?: unknown; timeoutMs?: unknown; }
export interface QemuFailure { [key:string]:unknown; ok:false; error:string; }
export interface QemuAgentStatus { [key:string]:unknown; id?:string; state?:string; ok?:boolean; error?:unknown; status?:unknown; }
export interface QemuSsh { host:string; port:number; user:string; keyPath?:string|null; readinessCommand?:string; keyConfigured?:boolean; readinessCommandConfigured?:boolean; }
export interface QemuAgent { [key:string]:unknown; name?:string; protocol?:string; healthCommand?:string; provisionCommand?:string|null; autoProvision?:boolean; lastProvision?:QemuAgentStatus|null; lastStatus?:QemuAgentStatus|null; provisionHistory?:QemuAgentStatus[]; }
export interface QemuGuest { [key:string]:unknown; ssh?:QemuSsh|null; agent?:QemuAgent|null; }
export interface QemuRuntime { [key:string]:unknown; runtimeId?:string; pid?:unknown; processIdentity?:unknown; command?:unknown; args?:unknown; startedAt?:unknown; }
export interface QemuLab { [key:string]:unknown; id:string; name:string; ownerId:string; provider?:string; runtimeState:string; createdAt?:unknown; updatedAt?:unknown; resources:{memoryMb:unknown;cpus:unknown}; image:{[key:string]:unknown;baseImageId?:string|null;sourceImage?:string|null;diskImage:string;format?:string;disk?:{[key:string]:unknown;path?:string}}; paths:{labDir:string;workspaceDir:string;snapshotsDir:string;artifactsDir:string;exportsDir:string}; runtime?:QemuRuntime|null; guest?:QemuGuest; readiness?:{[key:string]:unknown;latest?:unknown}; }
export interface QemuExecution { [key:string]:unknown; ok?:unknown; status?:unknown; stdout?:unknown; stderr?:unknown; args?:unknown; pid?:unknown; processIdentity?:unknown; }
export interface QemuMaterializedResult { [key:string]:unknown; ok:boolean; lab?:QemuLab; materialized?:boolean; }
export interface QemuLifecycleResult { [key:string]:unknown; ok?:boolean; lab?:QemuLab; }
export interface QemuProvisionProbe { [key:string]:unknown; ok?:unknown; provisioned?:unknown; checks?:unknown[]; diagnostics?:unknown; }
export interface QemuLaunchInput { ownerId:string; labId:string; memoryMb:unknown; cpus:unknown; labDirectory:string; diskImage:string|null; dryRun:boolean; }
export interface QemuNativeRuntimeReceipt { pid:unknown; processIdentity:unknown; command:unknown; args:unknown; }
export type QemuLaunchResult = {ok:true;runtime?:QemuNativeRuntimeReceipt;presentation:QemuExecution;preview?:{command:string;args:string[]}} | {ok:false;presentation:QemuExecution|null|undefined};
export interface QemuLifecyclePorts {
    providerName: string;
    scope(): QemuScope;
    runnerUnavailable(scope:QemuScope): QemuFailure|null;
    readLab(scope:QemuScope,labId:string): {ok:true;lab:QemuLab}|QemuFailure;
    writeLab(scope:QemuScope,lab:QemuLab): undefined;
    metadataExists(scope:QemuScope,labId:string): boolean;
    labId(): string;
    labDirectory(scope:QemuScope,labId:string): string;
    allocatedPath(directory:string,...segments:string[]): string;
    ensureDirectory(directory:string): undefined;
    removeLabDirectory(scope:QemuScope,labId:string): undefined;
    resolveBaseImage(scope:QemuScope,imageId:string): {ok:true;image:{id:string;path:string;format:string}}|QemuFailure;
    boundedSource(scope:QemuScope,value:unknown,label:string): {ok:true;path:string|null}|QemuFailure;
    resolveSshKey(scope:QemuScope,value:unknown): {ok:true;path:string|null}|QemuFailure;
    validateDisk(lab:QemuLab): {ok:true;diskPath:string}|QemuFailure;
    diskExists(path:string): boolean;
    imageDiskTargetApplication(): {materializeDisk(args:{labId:string;dryRun?:boolean}):QemuMaterializedResult};
    providerStatus(): { [key:string]:unknown;available:boolean;qemu:string|null };
    launch(input:QemuLaunchInput,scope:QemuScope,status:{available:boolean;qemu:string|null}):QemuLaunchResult;
    clock(): unknown;
    runtimeId(): string;
    inspectRuntime(runtime:QemuRuntime|null|undefined): {status:"match"|"mismatch"|"exited"|"unavailable"};
    waitRuntimeExit(runtime:QemuRuntime,timeoutMs:number): {exited:boolean;reason?:string};
    legacyKillAvailable(): boolean;
    legacyKill(pid:unknown): undefined;
    signalRuntime(runtime:QemuRuntime,signal:string): {signaled:boolean;reason?:string};
    provisionGuestAgent(input:{lab:QemuLab;timeoutMs:number},scope:QemuScope): QemuProvisionProbe;
}
