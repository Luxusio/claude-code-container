import type { RecordingRecord, RecordingArguments, RecordingOutcome, RecordingCommand, RecordingCopyOutcome, RecordingIdentity, RecordingSignal, RecordingGuestObservation, RecordingPath, RecordingStage, RecordingStageResult, RecordingFileResult, RecordingHelperResult, RecordingRefusal, AdbRecordingAdmission, SimulatorRecordingAdmission, MacosRecordingAdmission, AdbRecordingTarget, SimulatorRecordingTarget, MacosRecordingTarget } from '../domain/direct-recording.mjs';
export interface RecordingCommonPorts {
    findDevice(id:string):RecordingRecord|null|undefined;
    updateDevice(id:unknown, update:(device:RecordingRecord)=>RecordingRecord):RecordingRecord|null;
    runtimeId():string;
    timestamp():string;
    localPath(device:RecordingRecord):string;
    validatePath(path:string):RecordingPath;
    prepareOutput(device:RecordingRecord,path:string):undefined;
}
export interface RecorderHandle {
    pid:number|undefined;
    startup(timeoutMs:number):Promise<{kind:'ready'}|{kind:'error',message:string}|{kind:'exit',code:number|null,signal:string|null}>;
    signal(signal:'SIGINT'|'SIGKILL'):undefined;
    unref():undefined;
}
export interface RecordingProcessPorts {
    spawnRecorder(target:AdbRecordingTarget|SimulatorRecordingTarget|MacosRecordingTarget, paths:{remotePath:string,outputPath:string}, timeLimitSec:number|null, exited:()=>undefined):RecorderHandle;
    readIdentity(pid:number|undefined):RecordingIdentity|null;
    observe(identity:unknown,pid:unknown,remainingMs?:()=>number):{status:'match'|'mismatch'|'exited'|'unavailable'};
    alive(pid:unknown):boolean;
    signal(recording:RecordingRecord,remainingMs?:()=>number):RecordingSignal;
    waitExit(pid:unknown,timeoutMs:number):Promise<boolean>;
    createStage(device:RecordingRecord,path:string,persistent:boolean):RecordingStageResult;
    commitStage(stage:RecordingStage):RecordingFileResult;
    disposeStage(stage:RecordingStage):undefined;
}
export interface RecordingRemoteEffects {
    fallbackStop(target:AdbRecordingTarget|MacosRecordingTarget,remotePath:string,timeoutMs?:number):unknown;
    copyRecording(target:AdbRecordingTarget|MacosRecordingTarget,remotePath:string,stagedPath:string,timeoutMs?:number):RecordingCopyOutcome;
    removeRecording(target:AdbRecordingTarget|MacosRecordingTarget,remotePath:string,timeoutMs?:number):unknown;
}
export interface RecordingSettlementBudget {
    remaining():number;
    requestTimeout(maximum?:number):number;
    pause():Promise<void>;
}
export interface AndroidRecordingPorts extends RecordingCommonPorts, RecordingProcessPorts, Omit<RecordingRemoteEffects,'fallbackStop'> {
    kind:'android-emulator'|'android-device';
    target(device:RecordingRecord,operation:string,validation?:{capturedTarget:AdbRecordingTarget;waitBudget?:{remaining():number}}):AdbRecordingAdmission|RecordingRefusal;
    budget(timeoutMs:number,intervalMs:number):RecordingSettlementBudget;
    observeGuest(target:AdbRecordingTarget,timeoutMs:number):RecordingGuestObservation;
    fallbackStop(target:AdbRecordingTarget,remotePath:string,timeoutMs:number):{ok:boolean};
}
export interface SimulatorRecordingPorts extends RecordingCommonPorts, RecordingProcessPorts {
    kind:'ios-simulator';
    restoreStage(device:RecordingRecord,path:string,stagedPath:string):RecordingStageResult;
    populateStage(source:string,stage:RecordingStage):RecordingFileResult;
    target(device:RecordingRecord,operation:string):SimulatorRecordingAdmission|RecordingRefusal;
}
export interface MacosRecordingPorts extends RecordingCommonPorts, RecordingProcessPorts, RecordingRemoteEffects {
    kind:'macos-vm';
    target(device:RecordingRecord,operation:string):MacosRecordingAdmission|RecordingRefusal;
    prepareWorkspace(device:RecordingRecord):undefined;
}
export interface SandboxRecordingPorts extends RecordingCommonPorts {
    kind:'windows-sandbox';
    helper(device:RecordingRecord,action:'record_status'|'record_start'|'record_stop',request:{sessionId?:unknown,intervalMs?:number,timeLimitSec?:number},timeoutMs:number):Promise<RecordingHelperResult>;
    archivePath(helper:unknown,path:unknown,expectedName:string):string|null;
    copyArchive(source:string,destination:string):{ok:true}|{ok:false,error:string};
}
export type DirectRecordingPorts = AndroidRecordingPorts|SimulatorRecordingPorts|MacosRecordingPorts|SandboxRecordingPorts;
export interface RecordingApplication {
    request(name:string,args:RecordingArguments):Promise<RecordingOutcome|undefined>;
    exited(deviceId:unknown,recording:RecordingRecord):undefined;
}
/** Actual native mechanisms, distinct from application ports. Native producer binds clocks, entropy,
 * process handles, command options and fenced stage operations itself. */
export interface RecordingCommandResult { status:number|null; stdout:string; stderr:string; error?:unknown; signal?:string|null; }
export interface RecordingNativeCommon {
    findDevice:RecordingCommonPorts['findDevice'];
    updateDevice:RecordingCommonPorts['updateDevice'];
    localPath:RecordingCommonPorts['localPath'];
    validateLocalOutputPath(path:string,options:{label:string}):RecordingPath;
}
export interface RecordingNativeProcess extends RecordingNativeCommon {
    recordingDirectory(device:RecordingRecord):string;
}
export type DirectRecordingNative =
    (RecordingNativeProcess & {kind:'android-emulator'|'android-device';resolveTarget:AndroidRecordingPorts['target'];runCommand:(command:RecordingCommand)=>RecordingCommandResult}) |
    (RecordingNativeProcess & {kind:'ios-simulator';resolveTarget:SimulatorRecordingPorts['target']}) |
    (RecordingNativeProcess & {kind:'macos-vm';resolveTarget:MacosRecordingPorts['target'];runCommand:(command:RecordingCommand)=>RecordingCommandResult;ensureWorkspace:MacosRecordingPorts['prepareWorkspace']}) |
    (RecordingNativeCommon & {kind:'windows-sandbox';helperRequest:SandboxRecordingPorts['helper'];verifiedArchivePath:SandboxRecordingPorts['archivePath'];copyFile:SandboxRecordingPorts['copyArchive']});
