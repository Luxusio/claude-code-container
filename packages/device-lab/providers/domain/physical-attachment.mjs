/** Raw attachment data retains fields outside this operation's policy.
 * @typedef {{[key:string]:unknown,runtimeId?:string,operation?:string,claimedAt?:string}} AttachmentLifecycle
 * @typedef {{[key:string]:unknown,active?:boolean,pid?:number|null,runtimeId?:string,processIdentity?:object|null,endedAt?:string}} AttachmentRecording
 * @typedef {{[key:string]:unknown,id:string,status?:string,serial?:string|null,udid?:string,pid?:number|null,appium?:object|null,recording?:AttachmentRecording|null,lifecycle?:AttachmentLifecycle|null,updatedAt?:string,leaseClaimId?:string,leaseClaimNonce?:string}} AttachmentDevice
 */
/** @param {AttachmentDevice[]} devices
 * @param {string} id @param {'serial'|'udid'} field @param {string} hardware */
export function attachmentDuplicate(devices,id,field,hardware) {
    if (devices.some(device=>device.id===id)) return `Device already exists for this owner: ${id}`;
    if (devices.some(device=>device[field]===hardware)) return field==='serial'
        ? `Android serial already attached for this owner: ${hardware}` : `iOS UDID already attached for this owner: ${hardware}`;
    return null;
}
/** @param {'android-device'|'ios-device'} backend @param {string} id @param {string} name
 * @param {{owner:string,port:number,claimId:string|undefined,nonce:string,attachedAt:string,updatedAt:string}} facts */
export function attachmentRecord(backend,id,name,facts) {
    return {id,name,backend,kind:'mobile',platform:backend==='android-device'?'android':'ios',physical:true,
        ownerId:facts.owner,appiumPort:facts.port,appium:null,recording:null,leaseClaimId:facts.claimId,
        leaseClaimNonce:facts.nonce,status:'attached',creatable:false,attachable:true,attachedAt:facts.attachedAt,updatedAt:facts.updatedAt};
}
