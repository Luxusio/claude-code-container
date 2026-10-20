/** @typedef {Record<string, unknown>} RecordingRecord
 * @typedef {'android-emulator'|'android-device'|'ios-simulator'|'macos-vm'|'windows-sandbox'} RecordingVariant
 * @typedef {{deviceId:string,localPath?:string,remotePath?:string,timeLimitSec?:number,helperTimeoutMs?:number}} RecordingArguments
 * @typedef {{executable:string,args:string[],env?:Record<string,string|undefined>,timeoutMs?:number}} RecordingCommand
 * @typedef {{ok:boolean,detail:string,output:Record<string,unknown>}} RecordingCopyOutcome
 * @typedef {{kind:'adb',executable:string,prefix:string[]}} AdbRecordingTarget
 * @typedef {{kind:'simulator',executable:string,target:string}} SimulatorRecordingTarget
 * @typedef {{kind:'ssh',executable:string,prefix:string[],target:string,scp:string,scpPrefix:string[],env?:Record<string,string|undefined>}} MacosRecordingTarget
 * @typedef {{kind:'missing'}|{kind:'failure',message:string}|{kind:'native',value:unknown}} RecordingRefusal
 * @typedef {{kind:'ready',device:RecordingRecord,target:AdbRecordingTarget}} AdbRecordingAdmission
 * @typedef {{kind:'ready',device:RecordingRecord,target:SimulatorRecordingTarget}} SimulatorRecordingAdmission
 * @typedef {{kind:'ready',device:RecordingRecord,target:MacosRecordingTarget}} MacosRecordingAdmission
 * @typedef {{ok:true,path:string}|{ok:false,message:string}} RecordingPath
 * @typedef {{path:string,stagedPath:string,stageRoot:string,cleanup:()=>void}} RecordingStage
 * @typedef {{ok:true,stage:RecordingStage}|{ok:false,message:string}} RecordingStageResult
 * @typedef {{ok:true}|{ok:false,message:string}} RecordingFileResult
 * @typedef {{pid:number,startToken:string,commandHash:string}} RecordingIdentity
 * @typedef {{signaled:boolean,exited?:boolean,reason?:string}} RecordingSignal
 * @typedef {{status:'running'|'absent'|'unavailable'}} RecordingGuestObservation
 * @typedef {{active?:boolean,frameDir?:string,archivePath?:string,hostArchivePath?:string,[field:string]:unknown}} HelperRecording
 * @typedef {{error:string,response?:undefined,helper?:unknown}|{error?:undefined,response:{ok:boolean,error?:string,recording?:HelperRecording},helper:unknown}} RecordingHelperResult
 * @typedef {RecordingRecord & {deviceId:string,recording:RecordingRecord|null,provider?:string,stopped?:boolean,device?:RecordingRecord|null,helper?:unknown}} RecordingValue
 * @typedef {RecordingRefusal|{kind:'success',value:RecordingValue}} RecordingOutcome
 */
export {};
/** @param {unknown} value @returns {value is RecordingRecord} */
export function recordingObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** @param {RecordingRecord} device @returns {RecordingRecord|null} */
export function recordingOf(device) { return recordingObject(device.recording) ? device.recording : null; }
/** @param {RecordingVariant} kind */
export function recordingLabel(kind) {
    return kind === 'android-emulator' ? 'Android' : kind === 'android-device' ? 'Android real-device' : kind === 'ios-simulator' ? 'iOS Simulator' : kind === 'macos-vm' ? 'macOS VM' : 'Windows Sandbox';
}
/** @param {RecordingVariant} kind */
export function recordingProvider(kind) {
    return kind === 'ios-simulator' ? 'simctl-recordVideo' : kind === 'macos-vm' ? 'ssh-screencapture-video' : kind === 'windows-sandbox' ? 'windows-helper-frame-archive' : 'adb-screenrecord';
}
/** @param {RecordingRecord} record @param {string} field @returns {string|null} */
export function recordingString(record, field) { const value = record[field]; return typeof value === 'string' && value ? value : null; }

/** Invalid expected identity is unavailable, never evidence of a different recorder.
 * @param {unknown} identity @param {unknown} pid @returns {identity is RecordingIdentity} */
export function recordingIdentityAvailable(identity, pid) {
    return recordingObject(identity) && typeof pid === 'number' && Number.isInteger(pid) && pid > 0
        && identity.pid === pid && typeof identity.startToken === 'string' && identity.startToken.trim().length > 0
        && typeof identity.commandHash === 'string' && identity.commandHash.length === 64 && /^[a-f0-9]{64}$/i.test(identity.commandHash);
}

/** @param {AdbRecordingTarget} previous @param {AdbRecordingTarget} current */
export function recordingAdbTargetMatches(previous, current) {
    return previous.executable === current.executable && previous.prefix.length === current.prefix.length
        && previous.prefix.every((value, index) => value === current.prefix[index]);
}

/** Public provider guard can call this pure admission before its native operation lock.
 * @param {RecordingVariant} kind @param {unknown} timeLimitSec @returns {string|null} */
export function recordingInputError(kind, timeLimitSec) {
    return (kind === 'android-emulator' || kind === 'android-device') && timeLimitSec !== undefined
        && (typeof timeLimitSec !== 'number' || !Number.isInteger(timeLimitSec) || timeLimitSec < 1 || timeLimitSec > 180)
        ? 'Android recording timeLimitSec must be an integer from 1 to 180' : null;
}
