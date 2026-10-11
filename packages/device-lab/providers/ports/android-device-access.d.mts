export interface AndroidAccessArguments { deviceId?: string; command?: string; text?: string; packageName?: string; timeoutMs?: number; intervalMs?: number }
export interface AndroidAccessDevice { id: string; serial?: string; port?: number; appium?: object | null }
export interface AndroidAccessDiscovery { adb: string | null }
export interface AndroidAccessTarget<Device extends AndroidAccessDevice = AndroidAccessDevice> { device: Device; adb: string }
export type AndroidAccessSelection<Target> = { kind: 'unknown' } | { kind: 'refused'; message: string } | { kind: 'ready'; target: Target };
export interface AndroidAccessReceipt { status: number | null; stdout?: string; stderr?: string; error?: {message?:string}; signal?: string | null }
export interface AndroidScreenshotFacts { status:number|null; byteLength:number; prefix:readonly number[]; base64:string; stdoutText:string; stderrText:string }
export interface AndroidAppiumFacts { available:boolean; missing:string[]; tools:{appium:string|null;adb:string|null} }
export interface AndroidAccessBudget { timeoutMs:number; remaining():number; requestTimeout():number; pause():Promise<void> }
export interface AndroidAccessWaitPorts<Target> { budget(timeoutMs:number|undefined,intervalMs:number|undefined):AndroidAccessBudget; executeTimed(target:Target,args:string[],timeoutMs:number):AndroidAccessReceipt }
export type AndroidTextWaitResult = {error:AndroidAccessReceipt}|{found:false;source:string;timeoutMs:number}|{found:true;source:string;remotePath:string};
export type AndroidAppWaitResult = {error:AndroidAccessReceipt}|{running:true;pid:string;stdout:string;stderr?:string;status:number|null}|{running:false;timeoutMs:number;stdout:string;stderr?:string;status:0;nativeStatus:number|null};
export type AndroidAccessOutcome = {kind:'json';payload:object}|{kind:'text';message:string}|{kind:'command-failure';command:AndroidAccessReceipt}|{kind:'image';data:string};
interface AndroidAccessCommon<Device extends AndroidAccessDevice, Discovery extends AndroidAccessDiscovery> extends AndroidAccessWaitPorts<AndroidAccessTarget<Device>> {
    device(id:string|undefined):Device|undefined;
    discovery():Discovery;
    backend(discovery:Discovery):object;
    publicDevice(device:Device):object;
    appium(discovery:Discovery|undefined):AndroidAppiumFacts;
    target(id:string|undefined):AndroidAccessSelection<AndroidAccessTarget<Device>>;
    execute(target:AndroidAccessTarget<Device>,args:(string|undefined)[]):AndroidAccessReceipt;
    capture(target:AndroidAccessTarget<Device>):AndroidScreenshotFacts;
}
export interface AndroidEmulatorAccessPorts<Device extends AndroidAccessDevice=AndroidAccessDevice, Discovery extends AndroidAccessDiscovery=AndroidAccessDiscovery> extends AndroidAccessCommon<Device,Discovery> { variant:'emulator' }
export interface AndroidPhysicalAccessPorts<Device extends AndroidAccessDevice=AndroidAccessDevice, Discovery extends AndroidAccessDiscovery=AndroidAccessDiscovery> extends AndroidAccessCommon<Device,Discovery> {
    variant:'physical';
    refreshLease(device:Device):{ok:true}|{ok:false;message:string};
    hostState(device:Device,adb:string):AndroidAccessReceipt;
}
export type AndroidDeviceAccessPorts<Device extends AndroidAccessDevice=AndroidAccessDevice, Discovery extends AndroidAccessDiscovery=AndroidAccessDiscovery> = AndroidEmulatorAccessPorts<Device,Discovery>|AndroidPhysicalAccessPorts<Device,Discovery>;
