/** Native evidence is opaque to application policy. */
/** @template Value @typedef {{ok:true,value:Value,diagnostic?:unknown}|{ok:false,diagnostic:unknown}} AndroidAccessObservation */
/** @typedef {{kind:'refused',message:string}|{kind:'native-failure',diagnostic:unknown}|{kind:'image',data:string}} AndroidCaptureObservation */
/** @typedef {{running:boolean,pid?:string,diagnostic:unknown}} AndroidAppObservation */
/** @typedef {{kind:'refused',message:string}|{kind:'native-failure',diagnostic:unknown}|{kind:'image',data:string}|{kind:'session',device:object}|{kind:'status',device:object,discovery:object,hostState:unknown}|{kind:'executed',diagnostic:unknown}|{kind:'ui',source:string,remotePath:string,dump:unknown}|{kind:'text-wait',result:object,text:string|undefined}|{kind:'app-wait',result:object,packageName:string}} AndroidAccessOutcome */
