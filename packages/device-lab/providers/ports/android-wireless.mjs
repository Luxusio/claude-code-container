/** @typedef {{status:number|null,stdout?:string,stderr?:string,signal?:string|null,error?:{message?:string}|null}} AndroidWirelessCommandResult */
/** Native invocation evidence is redacted before entering application policy.
 * @typedef {{provider:"adb",args:string[],status:number|null,stdout?:string,stderr?:string,signal:string|null,error:string|null}} AndroidWirelessEvidence */
/** @typedef {{backend?:string,action?:string,serial?:string,host?:string,port?:number,pairHost?:string,pairPort?:number,pairingCode?:string|number,connect?:boolean,timeoutMs?:number}} AndroidWirelessArguments */
/** @template Target @template Result
 * @typedef {{
 * discover:()=>({available:false}|{available:true,target:Target}),
 * listDevices:(target:Target)=>AndroidWirelessCommandResult,
 * tcpip:(target:Target,serial:string,port:number,timeoutMs:number)=>AndroidWirelessEvidence,
 * pair:(target:Target,endpoint:string,code:string|number,timeoutMs:number)=>AndroidWirelessEvidence,
 * connect:(target:Target,endpoint:string,timeoutMs:number)=>AndroidWirelessEvidence,
 * jsonResult:(value:object)=>Result,
 * textResult:(ok:boolean,text:string)=>Result
 * }} AndroidWirelessPorts
 */
export {};
