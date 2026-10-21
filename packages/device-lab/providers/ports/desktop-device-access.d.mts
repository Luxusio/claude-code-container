import type { CommandReceipt } from './desktop-control-transfer.mjs';
import type { X11AccessTarget } from '../domain/desktop-device-access.mjs';
export type { DesktopAccessArguments, X11AccessTarget } from '../domain/desktop-device-access.mjs';
export interface DesktopAccessTarget { id:string }
export interface DesktopAccessDiscovery { available:boolean }
export interface DesktopAccessBridge { target:string }
export interface DesktopScreenshotStage { localPath:string }
export type DesktopScreenshotResult = {kind:"image";data:string}|{kind:"missing";message:string}|{kind:"invalid";message:string};
export type DesktopAccessResult = {kind:'json';value:object}|{kind:'text';text:string}|{kind:'native';value:object}|{kind:'command-failure';receipt:CommandReceipt}|{kind:'image';data:string};
export interface DesktopCleanupEvidence {operation:'remote'|'local';evidence:unknown}
export type DesktopAccessOutcome = DesktopAccessResult|{kind:'cleanup-failure';primary:DesktopAccessResult|{kind:'thrown';error:unknown};cleanup:DesktopCleanupEvidence[]};
export type DesktopAccessObservation = {ok:true;value:object}|{ok:false;outcome:DesktopAccessResult};
export type DesktopScreenshotObservation = {ok:true;path:string}|{ok:false;outcome:DesktopAccessResult};
export type DesktopNativeEffect = {ok:boolean;receipt:CommandReceipt};
export interface DesktopAccessibilityLimits {maxDepth:number;maxNodes:number}
export interface WindowsDeviceAccessPorts<Target extends DesktopAccessTarget,Helper> {
    variant:'windows'; target(id:string|undefined):Target|undefined; publicDevice(target:Target):object; backend():object;
    exec(target:Target,command:string|undefined,timeoutMs:number|undefined):Promise<DesktopAccessObservation>;
    accessibility(target:Target,limits:DesktopAccessibilityLimits,timeoutMs:number|undefined):Promise<DesktopAccessObservation>;
    screenshot(target:Target,timeoutMs:number|undefined):Promise<DesktopScreenshotObservation>;
    readScreenshot(path:string):{kind:'image';data:string}|{kind:'missing'}|{kind:'invalid';reason:string};
}
export interface MacosDeviceAccessPorts<Target extends DesktopAccessTarget,Discovery extends DesktopAccessDiscovery,Bridge extends DesktopAccessBridge,Stage extends DesktopScreenshotStage> {
    variant:'macos'; target(id:string|undefined):Target|undefined; discovery():Discovery; publicDevice(target:Target,discovery:Discovery):object; backend(discovery:Discovery):object;
    bridge(target:Target,operation:'device_exec'|'device_screenshot'):{ok:true;bridge:Bridge}|{ok:false;result:object};
    exec(target:Target,bridge:Bridge,command:string|undefined,timeoutMs:number|undefined):object;
    accessibility(target:Target,limits:DesktopAccessibilityLimits,timeoutMs:number|undefined):DesktopAccessObservation;
    stageScreenshot(target:Target):Stage;
    capture(target:Target,bridge:Bridge,stage:Stage,timeoutMs:number|undefined):DesktopNativeEffect;
    copy(target:Target,bridge:Bridge,stage:Stage,timeoutMs:number|undefined):DesktopNativeEffect;
    readScreenshot(stage:Stage):DesktopScreenshotResult;
    cleanupRemote(target:Target,bridge:Bridge,stage:Stage,timeoutMs:number|undefined):DesktopNativeEffect;
    disposeScreenshot(stage:Stage):undefined;
}
export interface X11DeviceAccessPorts<Target extends DesktopAccessTarget,Stage extends DesktopScreenshotStage> {
    variant:'x11'; owner():string; display():string; available():boolean; publicTarget(target:X11AccessTarget):Target; stageScreenshot():Stage; capture(stage:Stage):DesktopNativeEffect;
    focusAvailable?():boolean;
    readScreenshot(stage:Stage):DesktopScreenshotResult; disposeScreenshot(stage:Stage):undefined;
}
export type DesktopDeviceAccessPorts<Target extends DesktopAccessTarget,Helper,Discovery extends DesktopAccessDiscovery,Bridge extends DesktopAccessBridge,Stage extends DesktopScreenshotStage> = WindowsDeviceAccessPorts<Target,Helper>|MacosDeviceAccessPorts<Target,Discovery,Bridge,Stage>;
