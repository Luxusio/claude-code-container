import { createPhysicalAttachmentApplication } from '../application/physical-attachment.mjs';
/** @typedef {import('../ports/physical-attachment.mjs').CommonAttachmentPorts} Common
 * @typedef {import('../ports/physical-attachment.mjs').ConnectResult} ConnectResult
 * @typedef {{readDevices:Common['read'],findDevice:Common['find'],claimDevice:Common['claim'],transitionDevice:Common['transition'],owner:Common['owner'],deviceId:Common['deriveId'],appiumPort:Common['appiumPort'],now:Common['now'],nonce:Common['nonce'],stop:Common['stop'],claimLease:(backend:string,hardware:string,id:string,options:import('../ports/physical-attachment.mjs').LeaseOptions)=>import('../ports/physical-attachment.mjs').LeaseResult,releaseLease:(backend:string,hardware:string,id:string,options:import('../ports/physical-attachment.mjs').LeaseOptions)=>boolean,startHeartbeat:(backend:string,hardware:string,id:string,options:import('../ports/physical-attachment.mjs').LeaseOptions)=>{ok:boolean},releaseWithMutation:(backend:string,hardware:string|null|undefined,id:string,options:import('../ports/physical-attachment.mjs').LeaseOptions,mutation:()=>import('../ports/physical-attachment.mjs').DetachMutation)=>import('../ports/physical-attachment.mjs').DetachRelease}} NativeCommon
 * @typedef {NativeCommon & {discover:()=>{adb?:string|null},inventory:(discovery:{adb?:string|null})=>{devices:import('../ports/physical-attachment.mjs').AndroidHostDevice[]},wifiSerial:(value:string|undefined,port:number)=>string|null,wifiTransport:(serial:string,host:string|undefined,port:number)=>object,run:(executable:string,args:string[])=>ConnectResult}} AndroidAttachmentNative
 * @typedef {NativeCommon & {discover:()=>{xcrun?:string|null},inventory:(discovery:{xcrun?:string|null})=>{devices:import('../ports/physical-attachment.mjs').IosHostDevice[]}}} IosAttachmentNative
 */
/** @param {NativeCommon} native @param {'android-device'|'ios-device'} backend @returns {Common} */
function nativeCommon(native,backend) {
    return {
        read:()=>native.readDevices(),find:id=>native.findDevice(id),claim:device=>native.claimDevice(device),
        transition:(id,expected,replacement)=>native.transitionDevice(id,expected,replacement),
        owner:()=>native.owner(),deriveId:name=>native.deviceId(name),appiumPort:id=>native.appiumPort(id),
        now:()=>native.now(),nonce:()=>native.nonce(),stop:native.stop,
        claimLease:(hardware,id,options)=>native.claimLease(backend,hardware,id,options),
        releaseLease:(hardware,id,options)=>native.releaseLease(backend,hardware,id,options),
        startHeartbeat:(hardware,id,options)=>native.startHeartbeat(backend,hardware,id,options),
        releaseWithMutation:(hardware,id,options,mutation)=>native.releaseWithMutation(backend,hardware,id,options,mutation),
    };
}
/** Actual Android producer fixes the native connect command, not an application workflow.
 * @param {AndroidAttachmentNative} native */
export function createAndroidPhysicalAttachment(native) {
    /** @type {import('../ports/physical-attachment.mjs').AndroidAttachmentPorts} */
    const ports={...nativeCommon(native,'android-device'),backend:'android-device',
        discover:()=>native.discover(),inventory:discovery=>native.inventory(discovery),
        wifiSerial:(value,port)=>native.wifiSerial(value,port),wifiTransport:(serial,host,port)=>native.wifiTransport(serial,host,port),
        connect:(adb,target)=>native.run(adb,['connect',target]),
    };
    return createPhysicalAttachmentApplication(ports);
}
/** @param {IosAttachmentNative} native */
export function createIosPhysicalAttachment(native) {
    /** @type {import('../ports/physical-attachment.mjs').IosAttachmentPorts} */
    const ports={...nativeCommon(native,'ios-device'),backend:'ios-device',discover:()=>native.discover(),inventory:discovery=>native.inventory(discovery)};
    return createPhysicalAttachmentApplication(ports);
}
