/** @typedef {{status:number|null,stdout?:string,stderr?:string,signal?:string|null,error?:{message?:string}|null}} AndroidWirelessCommandResult */
/** Native invocation evidence is redacted before entering application policy.
 * @typedef {{provider:"adb",args:string[],status:number|null,stdout?:string,stderr?:string,signal:string|null,error:string|null}} AndroidWirelessEvidence */
/** @typedef {{ok:boolean,evidence:AndroidWirelessEvidence}} AndroidWirelessObservation */
/** @typedef {{backend?:string,action?:string,serial?:string,host?:string,port?:number,pairHost?:string,pairPort?:number,pairingCode?:string|number,connect?:boolean,timeoutMs?:number}} AndroidWirelessArguments */
/** @typedef {{kind:"tcpip"|"pair",evidence:AndroidWirelessEvidence}} AndroidWirelessPreparation */
/** @typedef {(
 * {kind:"status",hostDevices:import('./device-observation.mjs').HostDevices<import('./device-observation.mjs').AndroidHostDevice>} |
 * {kind:"refused",error:string,detail?:object,preparation?:AndroidWirelessPreparation} |
 * {kind:"command-failed",error:string,evidence:AndroidWirelessEvidence,preparation?:AndroidWirelessPreparation} |
 * {kind:"completed",action:"usb-tcpip"|"pair"|"connect",serial?:string,pairTarget?:string,target?:string,preparation?:AndroidWirelessPreparation,connection?:AndroidWirelessEvidence,attachNext?:ReturnType<typeof import('../domain/android-wireless.mjs').androidWifiAttachNext>}
 * )} AndroidWirelessOutcome */
/** @template Target
 * @typedef {{
 * discover:()=>({available:false}|{available:true,target:Target}),
 * listDevices:(target:Target)=>import('./device-observation.mjs').HostDevices<import('./device-observation.mjs').AndroidHostDevice>,
 * tcpip:(target:Target,serial:string,port:number,timeoutMs:number)=>AndroidWirelessObservation,
 * pair:(target:Target,endpoint:string,code:string|number,timeoutMs:number)=>AndroidWirelessObservation,
 * connect:(target:Target,endpoint:string,timeoutMs:number)=>AndroidWirelessObservation
 * }} AndroidWirelessPorts
 */
export {};
