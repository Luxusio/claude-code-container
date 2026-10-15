/** @typedef {import('../domain/physical-attachment.mjs').AttachmentDevice} AttachmentDevice
 * @typedef {import('./physical-stop.mjs').PhysicalLifecycle} Lifecycle
 * @typedef {import('./physical-stop.mjs').PhysicalTransition} Transition
 * @typedef {import('./physical-stop.mjs').PhysicalExitResult} ExitResult
 * @typedef {import('./physical-leases.mjs').PhysicalLeaseOptions} LeaseOptions
 * @typedef {import('./physical-leases.mjs').PhysicalLeaseResult} LeaseResult
 * @typedef {{ok:boolean,field?:string,value?:unknown,error?:string}} DeviceClaim
 * @typedef {{ok:boolean,receipt:unknown}} ConnectResult
 * @typedef {{backend?:string,name?:string,deviceId?:string,serial?:string,udid?:string,connection?:string,host?:string,port?:number}} AttachRequest
 * @typedef {{serial:string,attachable:boolean,state:string,connection?:string,details:object}} AndroidHostDevice
 * @typedef {{udid:string,name?:string,connection?:string}} IosHostDevice
 * @typedef {{kind:'missing'}|{kind:'error',message:string|undefined}|{kind:'command-failure',command:unknown}|{kind:'conflict',backend:'android-device'|'ios-device',deviceId:string,operation:string,found:boolean}|{kind:'attached',device:AttachmentDevice}|{kind:'detached',deviceId:string}} AttachmentOutcome
 * @typedef {{ok:boolean,transition:Transition,rollback?:()=>undefined}} DetachMutation
 * @typedef {{ok:true}|{ok:false,error:string,mutation?:DetachMutation|null}} DetachRelease
 * @typedef {{claimLifecycle:(id:string,device:AttachmentDevice,operation:string)=>{lifecycle:Lifecycle,transition:Transition},currentLifecycleDevice:(id:string,lifecycle:Lifecycle)=>AttachmentDevice|null,abortLifecycle:(id:string,lifecycle:Lifecycle,original:AttachmentDevice,actual?:Partial<AttachmentDevice>)=>{matched:boolean,found:boolean},cleanup:(device:AttachmentDevice,adb?:string|null)=>Promise<ExitResult>}} PhysicalStopPeer
 * @typedef {{
 * read:()=>AttachmentDevice[],find:(id:string)=>AttachmentDevice|null,
 * claim:(device:AttachmentDevice)=>DeviceClaim,transition:(id:string,expected:AttachmentDevice,replacement:AttachmentDevice|null)=>Transition,
 * owner:()=>string,deriveId:(name:string)=>string,appiumPort:(id:string)=>number,now:()=>string,nonce:()=>string,
 * claimLease:(hardware:string,id:string,options:LeaseOptions)=>LeaseResult,
 * releaseLease:(hardware:string,id:string,options:LeaseOptions)=>boolean,
 * startHeartbeat:(hardware:string,id:string,options:LeaseOptions)=>{ok:boolean},
 * releaseWithMutation:(hardware:string|null|undefined,id:string,options:LeaseOptions,mutation:()=>DetachMutation)=>DetachRelease,
 * stop:PhysicalStopPeer
 * }} CommonAttachmentPorts
 * @typedef {CommonAttachmentPorts & {backend:'android-device',discover:()=>{adb?:string|null},inventory:(discovery:{adb?:string|null})=>{devices:AndroidHostDevice[]},wifiSerial:(value:string|undefined,port:number)=>string|null,wifiTransport:(serial:string,host:string|undefined,port:number)=>object,connect:(adb:string,target:string)=>ConnectResult}} AndroidAttachmentPorts
 * @typedef {CommonAttachmentPorts & {backend:'ios-device',discover:()=>{xcrun?:string|null},inventory:(discovery:{xcrun?:string|null})=>{devices:IosHostDevice[]}}} IosAttachmentPorts
 * @typedef {AndroidAttachmentPorts|IosAttachmentPorts} PhysicalAttachmentPorts
 */
export {};
