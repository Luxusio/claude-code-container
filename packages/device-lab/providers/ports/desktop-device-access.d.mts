import type { CommandReceipt } from './desktop-control-transfer.mjs';
export interface DesktopAccessArguments { deviceId?:string; command?:string; helperTimeoutMs?:number; maxDepth?:number|string; maxNodes?:number|string }
export interface DesktopAccessTarget { id:string }
export interface DesktopAccessDiscovery { available:boolean }
export interface DesktopAccessBridge { target:string }
export interface DesktopScreenshotStage { localPath:string }
export interface X11AccessTarget extends DesktopAccessTarget { kind:'display'; backend:'x11'; creatable:false; lifecycle:'current'; ownerId:string; display:string; capabilities:string[]; available:boolean }
export type DesktopAccessOutcome = {kind:'json';value:object}|{kind:'text';text:string}|{kind:'native';value:object}|{kind:'command-failure';receipt:CommandReceipt}|{kind:'image';data:string};
export interface AccessibilityPayload { provider?:string; accessibility?:{provider?:string} }
export interface WindowsAccessResponse { id?:string; ok?:boolean; error?:string; stdout?:string; stderr?:string; status?:number|null; imagePath?:string; hostImagePath?:string; accessibility?:{provider?:string} }
export type WindowsAccessRequest = {type:'exec';command:string|undefined}|{type:'screenshot'}|{type:'accessibility_snapshot';maxDepth:number;maxNodes:number};
export type WindowsAccessObservation<Helper> = {error:string;helper:Helper;response?:undefined}|{error?:undefined;helper:Helper;response:WindowsAccessResponse};
export interface WindowsDeviceAccessPorts<Target extends DesktopAccessTarget,Helper> {
    variant:'windows'; target(id:string|undefined):Target|undefined; publicDevice(target:Target):object; backend():object;
    request(target:Target,request:WindowsAccessRequest,timeoutMs:number|undefined):Promise<WindowsAccessObservation<Helper>>;
    screenshotPath(helper:Helper,response:WindowsAccessResponse):string|null;
    readScreenshot(path:string):{kind:'image';data:string}|{kind:'missing'}|{kind:'invalid';reason:string};
}
export interface MacosDeviceAccessPorts<Target extends DesktopAccessTarget,Discovery extends DesktopAccessDiscovery,Bridge extends DesktopAccessBridge,Stage extends DesktopScreenshotStage> {
    variant:'macos'; target(id:string|undefined):Target|undefined; discovery():Discovery; publicDevice(target:Target,discovery:Discovery):object; backend(discovery:Discovery):object;
    bridge(target:Target,operation:'device_exec'|'device_screenshot'):{ok:true;bridge:Bridge}|{ok:false;result:object};
    exec(target:Target,bridge:Bridge,command:string|undefined,timeoutMs:number|undefined):CommandReceipt;
    helper(target:Target,argv:string[],timeoutMs:number|undefined):{error:object;result?:undefined;remoteScriptPath?:undefined}|{error?:undefined;result:CommandReceipt;remoteScriptPath:string};
    parseHelper(stdout:string):AccessibilityPayload|null;
    stageScreenshot(target:Target):Stage;
    capture(target:Target,bridge:Bridge,stage:Stage,timeoutMs:number|undefined):CommandReceipt;
    copy(target:Target,bridge:Bridge,stage:Stage,timeoutMs:number|undefined):CommandReceipt;
    readScreenshot(stage:Stage):object;
    cleanupRemote(target:Target,bridge:Bridge,stage:Stage,timeoutMs:number|undefined):CommandReceipt;
    disposeScreenshot(stage:Stage):undefined;
}
export interface X11DeviceAccessPorts<Target extends DesktopAccessTarget,Stage extends DesktopScreenshotStage> {
    variant:'x11'; owner():string; display():string; available():boolean; publicTarget(target:X11AccessTarget):Target; stageScreenshot():Stage; capture(stage:Stage):CommandReceipt;
    readScreenshot(stage:Stage):object; disposeScreenshot(stage:Stage):undefined;
}
export type DesktopDeviceAccessPorts<Target extends DesktopAccessTarget,Helper,Discovery extends DesktopAccessDiscovery,Bridge extends DesktopAccessBridge,Stage extends DesktopScreenshotStage> = WindowsDeviceAccessPorts<Target,Helper>|MacosDeviceAccessPorts<Target,Discovery,Bridge,Stage>;
