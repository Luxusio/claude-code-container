import type { AndroidAccessObservation, AndroidCaptureObservation, AndroidAppObservation } from '../domain/android-device-access.mjs';
export type { AndroidAccessObservation, AndroidCaptureObservation, AndroidAppObservation, AndroidAccessOutcome } from '../domain/android-device-access.mjs';

export interface AndroidAccessArguments { deviceId?: string; command?: string; text?: string; packageName?: string; timeoutMs?: number; intervalMs?: number }
export interface AndroidAccessDevice { id: string; serial?: string; port?: number; appium?: object | null }
export interface AndroidAccessDiscovery { adbAvailable: boolean; native: unknown }
export interface AndroidAccessTarget<Device extends AndroidAccessDevice = AndroidAccessDevice> { device: Device; native: unknown }
export type AndroidAccessSelection<Target> = { kind: 'unknown' } | { kind: 'refused'; message: string } | { kind: 'ready'; target: Target };
export interface AndroidAccessBudget { timeoutMs:number; remaining():number; requestTimeout():number; pause():Promise<void> }
export interface AndroidAccessWaitPorts<Target> {
    budget(timeoutMs:number|undefined,intervalMs:number|undefined):AndroidAccessBudget;
    dumpUi(target:Target,remotePath:string,timeoutMs?:number):AndroidAccessObservation<undefined>;
    readUi(target:Target,remotePath:string,mode:'primary'|'fallback',timeoutMs?:number):AndroidAccessObservation<string>;
    observeApp(target:Target,packageName:string,timeoutMs:number):AndroidAccessObservation<AndroidAppObservation>;
}
export type AndroidTextWaitResult = {kind:'native-failure';diagnostic:unknown}|{kind:'deadline';subject:'ui'}|{found:false;source:string;timeoutMs:number}|{found:true;source:string;remotePath:string};
export type AndroidAppWaitResult = {kind:'native-failure';diagnostic:unknown}|{kind:'deadline';subject:'app'}|{running:true;pid:string;diagnostic:unknown}|{running:false;timeoutMs:number;diagnostic:unknown};
interface AndroidAccessCommon<Device extends AndroidAccessDevice, Discovery extends AndroidAccessDiscovery> extends AndroidAccessWaitPorts<AndroidAccessTarget<Device>> {
    device(id:string|undefined):Device|undefined;
    discovery():Discovery;
    targetForDevice(device:Device,discovery:Discovery):AndroidAccessTarget<Device>;
    target(id:string|undefined):AndroidAccessSelection<AndroidAccessTarget<Device>>;
    uiPath(device:Device):string;
    executeShell(target:AndroidAccessTarget<Device>,command:string|undefined):AndroidAccessObservation<undefined>;
    capture(target:AndroidAccessTarget<Device>):AndroidCaptureObservation;
}
export interface AndroidEmulatorAccessPorts<Device extends AndroidAccessDevice=AndroidAccessDevice, Discovery extends AndroidAccessDiscovery=AndroidAccessDiscovery> extends AndroidAccessCommon<Device,Discovery> { variant:'emulator' }
export interface AndroidPhysicalAccessPorts<Device extends AndroidAccessDevice=AndroidAccessDevice, Discovery extends AndroidAccessDiscovery=AndroidAccessDiscovery> extends AndroidAccessCommon<Device,Discovery> {
    variant:'physical';
    refreshLease(device:Device):{ok:true}|{ok:false;message:string};
    hostState(device:Device,discovery:Discovery):unknown;
}
export type AndroidDeviceAccessPorts<Device extends AndroidAccessDevice=AndroidAccessDevice, Discovery extends AndroidAccessDiscovery=AndroidAccessDiscovery> = AndroidEmulatorAccessPorts<Device,Discovery>|AndroidPhysicalAccessPorts<Device,Discovery>;
