import {describe,expect,it} from "vitest";
import {createHash} from "node:crypto";import {gunzipSync} from "node:zlib";import {runInNewContext} from "node:vm";
import {createIosSimulatorLifecycle} from "../../../packages/device-lab/providers/application/lifecycle/ios-simulator-lifecycle.mjs";
import {iosLifecycleClaimStatus,boundedSimulatorIdentityDetail,iosSimulatorCommandFailed,selectIosSimulatorMatches} from "../../../packages/device-lab/providers/domain/lifecycle/ios-simulator-lifecycle.mjs";
import type {IosSimulatorLifecyclePorts as Ports,IosSimulatorDevice as Device,IosSimulatorCommandResult as Command,IosSimulatorLifecycleInput as Input} from "../../../packages/device-lab/providers/ports/lifecycle/ios-simulator-lifecycle.mjs";
// Independently frozen parent188e original whole facade fb09f500..., genuine987 manifest1bf5709e....
// Selected verbatim four original branches and reached policy helpers; aliases are native ports only.
const ORIGINAL_CONTROL="H4sIAAAAAAACA+0cbW/bxvm7f8WFCAoRoAgPGwpMhiu0zTa4aJsgbrAPRTDT4sm+mCI1vthRVf73Pc+9H3mkKNtJt64GgkjHu+ee97c7at3kq5oVOSlKdsPyJPuerelqt8robFuUdRXuV0Ve1WTPiuoVvWcrepFGJU3SC/W9itYsN1+j4iGn5SXbNFlSF+Wbkq7Zx6jKmpuIVa/hWaqf/ZhsaIRwWbUq7mm5iyq2WdXZd1WRR2XD//2T1bc/sQ0tmlpAhu2T7ZY1mzeA3t+L0my8yhK2MV/rMskrhrSZsYrdAIkci7dNXgPcN2UBJFTRQ8IQmvz6t4+sjlhebemqlkMXKYUF9S5KaUZr+jXH4RIewAZRTcsNMK+mHLR4piCnQF1Spt8XK9i5qbdNfVknN5zwt3RVlCnLb16xMnpASpPyhuLzuqkA6Mf6La2arI4+AEfkx3XCMmQMIn+RLoDItNi8e3fxCkjIMmRVVSeb7SIvHtpzLsKzk7USMuyp5fttka8ztqpnqRIrKba0THBiRAz3IlIWWXadrO7IOcmbLAvJ/oTAX0nrpsyJQXO2TrKKRuS7y9c/xlVdAmFsvZuJ2fhX3C2ImKOHaFkW5YIEXLZzgcocKKjpfCURDMxsxILmKcwHSuaVUiRrhibGbKqJ0kProkEghsaYj5gJcRzPNNVLsjcsaMmC7NtQTG3D8OykNexVGmhsyPBWfLJ4rNgo7CtTS4DJhmFGzsQIehaOEseRACWsFwR0QE1uz6zN5BRnKyBZoqiHKq6HC7MJOT8/J4EwgAD4Ij6CmAPSm1XVxZbPwQ9bOQe+JCVfYHbRlJuhZpuCAgyQINVuby1UBNlqa4tXOwCPPOTSEMHbomzKEgzeFmYPhEbAFaVcCtx1HKNeGDp0yNnLWENbxlrsnJX6gTW+1LssuE06uCfXYPYDamgxTXn8iCSrukkyVId2iJTj+CEoZGsyeyEXhkZum6Re3dJUuQJljd8URUaTfDbAtNBV4RLcXFH2dVhu51FiSW0sBhxbF/RP1D+k6vX1B4gM8bYs6qLebWl8m2BsA5cPRlDvYnD12UxCJYHmSxCGGvHYtngx1QyJnSiwZ/p2RpwTNtTc8G0pDNyz0FHccfNSctBQXE+5YRA48xvIDkr6bxk9UpUGHAwwV+z1JdFphIoKCijZcqgNA+woSP7lXkOO5ZT4Q8HyWQCsCtsrF7Nr1EYrSVFx/xWtIfLO7pOs6dg74gcsveQBT0wgv/5KgiCMYWgzc+0dZ8cZzW/qW/IV+cvpX78EY756uefjVYZcPI34eNiCal6BgeMjB0fgaZHdUzebErnD7OMKMyft3lh+D/gXhqncKH2ZmBTeMq7s0TC0w5EyYRm1r97SdcNZ7grEhII1fMuLfI7hPSUaMskBNJeMb8/2Stla60TIqub2rkkiyyUxGaOi/OcAZ6JsBfAKP84/BO8tryRgxZwMm0CxU8pFDTsd0AUbCriVFD6g4LvDkLri8BWFpBJI7jxGZ8R1cJDJ7/LkGoy2LgioMCRUXWZj5lTdsi1ykyMO+iR4i99a1KAg8PNUs70CaqWX4QpcKeL4N5kZVEgGhIh4DWt+SLazGRjYpgrJ+Vfk67JMdjGr+P9qfEn4B0DgZ8V9sa8IAbipgBw3KUs1B5YWXvGaZZBdi634TvhhyRfw6GgBCDWExQQIqII2BFftja5IXJXNvoAVfxo1iqny4sahTCBmabsg9CNWHKDlRU7JbaE4JWMkTHaROSBUYK+c//Ppe0OQfi5Y8GKABShsv6NwAYQ4EaNSsTZbC/m8EIlgybM/BOc+H+XiENPAg3OiPNwreTlFUzPsupVIsPTlvsMBdNZNfgehPu/Zicar5u510SExsrjNE8ik2uUroj01Jr9WTTgTpSukSsk1zdwwArtXsmYEwalsSCywUkLNsS++IOIh5gW4CvcpVYrO6yjYZb5ZbQPPGp6I0/SbnVzAgHn1HCDdM/Bj3hW0BH1+w0YwUP7Rzv8ssmx5J1hwE08tLSn2OkRwoJTXbQ1FxmMtb+WRJU0qzPsDAWEukZozidVcBv/AZzSSv5hO8oxQymnLAH6XAW4mWlzjA1n5EH/TYCbBdxkVEf2ApRbXLJgyRAgxCQ4E4fE8kftopkhIdlLr2ZQbMDe3oB8mBWxMJgewVaZqtEl49x4ytoQ8KxYjK5o8uYcohx43GFEZyY4B/kTa60B4RstsidyIqI2A5iZLIZepyTUVjp0hnJd7AaLrNybqt04KB/tHSnWUz/A4mdskT6HIQ18WgZeqwn31wICLfCS0xJZAci99w79WgDdU8QtLrEa0e5VTRzJTE4t4w860WIjjXtWDnyAUaL2OiPCSYrdLKzJxAZAWix9A+cxBArVRJfVcBd1uj1Z/zM6gXKTp2YmHCEwQNLLo5K0W5swQFJ551qqE55y4vc5Z2MdUzo2rAmKj/MbzDB2buDmw1MmlO6rqKXLEliTJEIUdqnJVVzzs1besEiERFRBi31UHrdbHD83AV6zaZsmOB/lz0gv6YAS+Hu4sbCFyZs2Nzbv2yt0Y1F3KOn3HMzQuf4QquhTduTzgoFlgEcEDF8iTF5XzIs92QZ/bHU3ysXS4xPGxwCuVccnosgdyPIGPVeS4iYsqdHw798Rm3EePHGNbPJGS5nU06oGLncN+XjNDaWnZMQHPokw5mISsNB9VcGNEtBr8Mw8MQZ6u0LU711Y+3is4G0ABfQxgbmbGuj4UNSOWhdIJRl7b8Dq09wMUlHbIPNW4Y7d+VvqQdIxE1YlOw8D+69qJXB5MMHtBhNMn04hbLW/11/P3vRkqNPQe3DHemt8U1wyicf85MLYG97UR7XvPBHnAs1Af7E637ufZBr3wC663yAhyQVxLQrfUny+FvdBp4eBMdG8LW5r9Kea4akH8R1cziA1D6xYDG6u+puivgypEfh1DU5Lp4ahWRUMq2umCOsR7+6RaGz2hAZvt7nANTqKvmXwitp2dMz0VXDtaD4kNFoSzXjvHNlDXgs4tG8I6xhLgkE893rNZzsicoB30SfJ4JbJxej8AnXseCdtxQEjTC9mRtCaoFpU9BG4njFm+ypoU8pvgIr9PMnBKgtXBYHQcj5CiFpWuhx/nSWXhHhEStk6Y1AwSj3lefRBtb/z0h6X+SH1bFg8i7+860V504loYF3dP1i3+lQPj2RxMX5pOyR86+Lw6KPNnq4IT58mdFJrMXu6FTKCiy7CPpL7z3mcb/va6Op3G0WLhIKX9MsKDhbmLMNtLCS1I9/KCLoNaC6SVnjilqNS2oVLU1JtADs9kJPVi3dSi8rjCrpM7qRoPDyc7neTYaUTr411P9u6rW/3FZFyqmyHciDjdxxWPdokiz/NUV/QibcnDLaguSYjZB5QkWdXsnhKsCyC/w8E1nhGyX3hr54w3M0GdqLUKzYFiCEcFEPI5x1xjXJM4T4QwgTzVq7VaTiqn+QQ0y22AXNMl7h/C9HHG9MV2vP56lpeAwhC8c4SIHbX10fib1k8uDWNnjb0Y4s3PdH/RwFUnb4Oy7M8dk411q8XKGcdu4agI5zNW4RKty0HywoJG98AtKgl7zuEE8oaJBc/racwVDHONQqT+3Tza5yWWsbBdny6pZi0/GykveQeUt30GrsL1gANFlxf/uPjxp2BI+1zgseqyonF3HsmeMTfygZb0ULAfu9UiWGzdbRlUxGPuFRg3p7rBThO4StY02xHpq5zzKHQ3M2wN+4h3jpsgu5BB5iGpOGShPWk8vTk0wP7xJFJwGyMl71T37z/29ADPKCLy59PT05FM8IWAO5axPZ8gHydMzLeR0fw8HuMWyzlVm6orw6NkMzWZk3d9DD7yyKlvdsKm9VkFxbsIutbuugVv70e0EC4xbitBd08k5bbqwKvTIBSTvG7SwI6HZf4IWavraB4WD8v65d5GBwPGdOG5IpLiEeB0DH9MEMdpj01yrK79bQMFxEM+pWxTcwM3gIqj67H6TS20j+9O0VHJ8s16ruobe6hTvpkLEBp5KQqm7zuKpsCCXCqUR4s8KRSFneHd2aEl10UBuoIlkawOHm+4R/SVdf08TQz9BrJTO9tV5ROq5ee1RcseB5vc7ZiH8ucxwIQbTFaT+nY4mZFX6nn4Grhe349eFuRogEP8hBVPm9WieYZg51tY4+mvyjbsDX2ToEovSOdKvyqCx1byozXY0iA65w/mnv3aseyf82OgR3WE0+qk1Efd/+0o0UjQ9t4MnphWJ+ualuY0eK5tbT/1JnHUuYLsZazLCJO9Ay8m3nzl70oc4MHTq4xBdgwWHFMjqtGqDaSEoJMQUs1tJzwZlF59Q+skTeqEPECFqcJsRK6bmncLuD6nVgKmDxrpxy1QxUR1gr50el71SR3aZHb0GACpxhYow5tCoiKYRGJ7OJN7Tkt8gvU9q5k9q2k9jzmN2Y2//8mVfeG7FPNKPVOM6rnfKc1RflFvQm9UFnCwV835iNfBMPmRL8/9gGnTl1DlnE5ojx56dWVib/Pk8UcXw02twYbgMW0uX/voudtez93yktaiEOxnlmdP7YkJVfskLTEO+riO2KREGzUcbdabWj8trTZVDG4yXMGgxWEV90zl73DZ602zO8ECe9DXwgXs+QnHTl8NvWNYMYmvvp6i5UCGM2+Erasw9/Xcw4ISC7W48LWM6+B9x0156FcEDYRsTqSB79SwA6m34kXnZVTf/Yoe4KHpqD+d6Tg0OB1UrzsdhjxZvz/pt1ZKz4Ij4jN/dcV9PKFZJG9zeDmNb9ZxfVVvWp6M8SsWh5BLIXY8Bve/+mkL+K2Ro1jen5YlVY3q+e0tXd2JqU+8k3J8BuIwQW02NRUZsqpH9niGGwq9E/89f/fa2+aJtOg6jyOt1J1eT6TVt9sXaged18QAUWy2vTTMvID+fMfTSnDC+UxMxIrtwTzsfyK5mnpQ6UvAHn9g+/j8jLcupuWC/xdnl1wTP1GaVmynZml/nEP+zs4hzTb+fsYfJ5L/DSeSj5LSlCOOR/vcz3BOJU8zxeW2S7PTZzye8rucbkZlqswOsp/Nm/AqUaE1odf4ezk03o9WcSO35J3foBm6ba9+FGgo4A06A/7jQWr24pEn/QP9b/FupP41okNHRYN+qXt0PiVf+a3b0TwHev5mtH0rQ6I0QdhLIdfegoOCPemLswcEf+Win59PK9m7P4ZzhFkcNInx11MMDz53ha7OCI6szY/TuyMPCQ5Uod36s21P1BvM4gL+AkvK86/ki76dV3jFO78Rr6D9E0VjV88rtkPTkDYxS5xV+OepoxI+sz1r/wPu6vRwRFAAAA==";
const ORIGINAL_CONTROL_SHA="62ce4f03e6ba4b0c7e08aba82be11c34e79ec39cd9a864e0757e2ef9bffacbb2";

type Reply={ok:boolean;text?:string;payload?:any;command?:Command};
type Operation="create"|"start"|"stop"|"delete";
const fixedTime="2031-01-02T03:04:05.000Z";
function fixture(mode:string,operation:Operation,raw=new Error("raw-ios-native")) {
    const trace:unknown[][]=[],publications:Array<{expected:Device;replacement:Device|null}>=[],commands:string[][]=[];
    let transitions=0;
    const base:Device={id:"unit",name:"Unit",backend:"ios-simulator",ownerId:"owner",simulatorName:"ccc-owner-unit",udid:"host-udid",status:operation==="stop"?"booted":"stopped",raw:{kept:true}};
    if(/signal|wait|partial|recording|stage/.test(mode))base.recording={active:!mode.includes("pending"),pid:41,stagingPath:mode.includes("stage")?"/allocated/stage":undefined,processIdentity:{startToken:"recording"},raw:"recording-metadata"};
    if(/appium|partial/.test(mode))base.appium={runtimeId:"appium-A",processOwner:"device-lab-mcp",startedBy:mode.includes("foreign")?"external":"direct-provider",serverPid:42,processIdentity:{startToken:"appium"},serverUrl:"http://allocated/status",sessionId:"raw-session"};
    if(mode==="foreign-name")base.simulatorName="foreign-unit";
    if(mode==="name-selection"||mode==="host-empty-udid")base.udid=null;
    let current:Device|null=mode==="missing"?null:base;
    const rc=(status=0,stdout=" raw stdout ",stderr=""):Command=>({status,stdout,stderr,carrier:raw});
    const p:Ports<Reply>={
        iosDeviceId(name){trace.push(["id",name]);return "ios-"+String(name).toLowerCase().replaceAll(" ","-");},
        readIosDevices(){trace.push(["read"]);return current?[current]:[];},
        findIosDevice(id){trace.push(["find",id]);if(transitions>0&&mode==="readback-absent")current=null;
            if(transitions>0&&mode==="readback-successor")current={...base,lifecycle:{runtimeId:"successor",operation:"start",claimedAt:fixedTime},raw:{winner:true}};
            return current?.id===id?current:undefined;},
        ownerSimulatorPrefix(){trace.push(["prefix"]);return "ccc-owner-";},
        slug(name){trace.push(["slug",name]);return String(name).toLowerCase().replaceAll(" ","-");},
        isOwnedSimulatorName(name){trace.push(["owned",name]);return typeof name==="string"&&name.startsWith("ccc-owner-");},
        iosDiscovery(){trace.push(["discovery"]);return mode.startsWith("no-prereq")?{available:false,xcrun:null,missing:["xcrun"]}:{available:true,xcrun:"/allocated/xcrun",missing:[]};},
        simctlJson(executable,args){trace.push(["inventory",executable,args]);if(mode==="inventory-error")return {error:rc(9,""," raw inventory refusal ")};
            let host={name:"ccc-owner-unit",udid:"host-udid"};if(mode==="host-mismatch")host={...host,name:"ccc-owner-other"};if(mode==="host-empty-udid")host={...host,udid:""};
            return {value:{devices:{"runtime":[...(mode==="host-missing"?[]:[host]),...(mode==="host-ambiguous"?[host]:[])]}}};},
        run(executable,args){trace.push(["run",executable,args]);commands.push(args.map(String));const action=args[1];
            if(mode==="run-throw"||mode==="rollback-throw"&&action==="delete")throw raw;
            if(action==="create")return mode==="create-command-fail"?rc(7,""," raw create refusal "):rc(0," host-udid \n");
            if(action==="boot")return mode==="boot-fail"?rc(7,"","raw boot refusal"):mode==="boot-already"?rc(7,"","Unable to boot device in current state: Booted"):rc();
            if(action==="shutdown")return mode==="shutdown-fail"||mode==="delete-shutdown-fail"?rc(7,"","raw shutdown refusal"):mode==="shutdown-already"||mode==="delete-shutdown-already"?rc(7,"","Unable to shutdown device in current state: Shutdown"):rc();
            if(action==="delete")return mode==="delete-fail"||mode==="rollback-fail"?rc(7,"","raw delete refusal"):mode==="delete-invalid"||mode==="rollback-invalid"?rc(7,"","Invalid device"):rc();
            throw Error("unallocated command "+action);},
        runWithTimeout(executable,args,timeout){trace.push(["bootstatus",executable,args,timeout]);if(mode==="bootstatus-throw")throw raw;
            return mode==="boot-not-ready"?{...rc(4,"raw boot stdout","raw boot stderr"),error:raw}:rc(0,"raw boot stdout","raw boot stderr");},
        ownerId(){trace.push(["owner"]);return "owner";},
        appiumPortForIosDevice(id){trace.push(["port",id]);return 31001;},
        claimIosDevice(device){trace.push(["claim",device]);if(mode==="claim-throw"||mode==="rollback-throw")throw raw;
            if(mode.startsWith("claim-conflict")||mode.startsWith("rollback-"))return {ok:false,field:"id",value:device.id,existing:{...base,udid:mode==="claim-conflict-same"?"host-udid":"existing-udid"}};
            current=device;return {ok:true};},
        transitionIosDevice(id,expected,replacement){trace.push(["transition",id,expected,replacement]);publications.push({expected,replacement});transitions++;
            if(mode==="transition-throw")throw raw;
            if(mode==="claim-mismatch"&&transitions===1||mode==="complete-mismatch"&&transitions===2)return {matched:false,found:true};
            if(current!==expected)return {matched:false,found:Boolean(current)};current=replacement;return {matched:true,found:true};},
        signalOwnedRuntimeProcess(recording,signal){trace.push(["signal",recording,signal]);if(mode==="signal-throw")throw raw;
            return mode==="signal-unavailable"?{signaled:false,reason:"runtime-process-identity-unavailable"}:mode==="signal-exited"?{signaled:false,reason:"runtime-process-exited"}:{signaled:true};},
        async waitForProcessExit(pid,timeout){trace.push(["wait",pid,timeout]);if(mode==="wait-throw")throw raw;return mode!=="wait-timeout";},
        inspectProcessIdentity(identity,pid){trace.push(["inspect",identity,pid]);if(mode==="inspect-throw")throw raw;return {status:mode==="appium-mismatch"?"mismatch":mode==="appium-unavailable"?"unavailable":mode==="appium-exited"?"exited":"match"};},
        async deleteAppiumSession(appium){trace.push(["delete-session",appium]);if(mode==="session-throw")throw raw;},
        async terminateOwnedAppiumProcess(appium,label,timeout){trace.push(["terminate",appium,label,timeout]);if(mode==="terminate-throw")throw raw;return mode==="appium-fail"||mode==="partial"?{exited:false,error:"raw Appium failure"}:{exited:true,signaled:true};},
        discardLocalOutputStage(file,options){trace.push(["discard",file,options]);if(mode==="stage-throw")throw raw;return mode==="stage-refusal"?{ok:false,message:"raw staged recording refusal"}:{ok:true};},
        iosRecordingDir(device){trace.push(["recording-dir",device]);return "/allocated/recording/"+device.id;},
        withTargetStatus(device){trace.push(["target-status",device]);return device;},
        textResult(ok,text){trace.push(["text",ok,text]);return {ok,text};},
        jsonResult(payload){trace.push(["json",payload]);return {ok:true,payload};},
        fail(command){trace.push(["failure",command]);return {ok:false,command};},
        runtimeId(){trace.push(["uuid"]);return "lifecycle-A";},
        wallTimestamp(){trace.push(["clock"]);return fixedTime;},
    };
    if(mode==="no-prereq-stopped")base.status="stopped";
    if(mode==="recording-refusal")base.recording={active:false,pid:41};
    if(mode==="status-refusal"||mode.startsWith("delete-shutdown")||mode==="delete-booted")base.status="booted";
    return {ports:p,trace,publications,commands,raw,base,state:()=>current};
}
const control=gunzipSync(Buffer.from(ORIGINAL_CONTROL,"base64")).toString("utf8");
function original(ports:Ports<Reply>):ReturnType<typeof createIosSimulatorLifecycle<Reply>> {
    return runInNewContext(control+";originalLifecycle(ports)",{ports}) as ReturnType<typeof createIosSimulatorLifecycle<Reply>>;
}

const cases:Array<[Operation,string,Input]>=[
    ["create","wrong-backend",{backend:"android-emulator",name:"Unit"}],
    ["create","definition",{backend:"ios-simulator",name:"Other"}],
    ["create","duplicate",{backend:"ios-simulator",name:"Unit",deviceId:"unit"}],
    ["create","foreign-name",{backend:"ios-simulator",name:"Other",simulatorName:"foreign",createSimulator:true,deviceType:"type",runtime:"runtime"}],
    ["create","missing-type",{backend:"ios-simulator",name:"Other",createSimulator:true,runtime:"runtime"}],
    ["create","no-prereq-create",{backend:"ios-simulator",name:"Other",createSimulator:true,deviceType:"type",runtime:"runtime"}],
    ...["created","create-command-fail","claim-throw","claim-conflict","claim-conflict-same","rollback-fail","rollback-invalid","rollback-throw"].map(mode=>["create",mode,{backend:"ios-simulator",name:"Other",createSimulator:true,deviceType:"type",runtime:"runtime"}] as [Operation,string,Input]),
    ...["missing","no-prereq-start","foreign-name","inventory-error","host-missing","host-ambiguous","host-mismatch","host-empty-udid","name-selection","claim-mismatch","boot-fail","boot-already","boot-not-ready","bootstatus-throw","complete-mismatch","run-throw","transition-throw"].map(mode=>["start",mode,{deviceId:"unit"}] as [Operation,string,Input]),
    ["start","wait-skipped",{deviceId:"unit",waitForBoot:false}],["start","timeout-forwarded",{deviceId:"unit",bootTimeoutMs:17}],
    ...["missing","no-prereq-stop","no-prereq-stopped","foreign-name","claim-mismatch","signal-unavailable","signal-exited","signal-ok","wait-timeout","signal-throw","wait-throw","shutdown-fail","shutdown-already","appium-mismatch","appium-unavailable","appium-exited","appium-foreign","appium-fail","partial","inspect-throw","session-throw","terminate-throw","readback-absent","readback-successor","complete-mismatch"].map(mode=>["stop",mode,{deviceId:"unit"}] as [Operation,string,Input]),
    ...["missing","recording-refusal","status-refusal","deleted","claim-mismatch","appium-fail","stage-refusal","stage-throw","readback-absent","readback-successor","complete-mismatch"].map(mode=>["delete",mode,{deviceId:"unit"}] as [Operation,string,Input]),
    ...["delete-native","delete-fail","delete-invalid","stage-refusal","signal-ok","wait-timeout","appium-mismatch","partial"].map(mode=>["delete",mode,{deviceId:"unit",force:true,deleteSimulator:true}] as [Operation,string,Input]),
    ...["stage-refusal","stage-throw"].map(mode=>["delete",mode,{deviceId:"unit",force:true,deleteSimulator:false}] as [Operation,string,Input]),
    ...["delete-booted","delete-shutdown-fail","delete-shutdown-already"].map(mode=>["delete",mode,{deviceId:"unit",force:true,deleteSimulator:true}] as [Operation,string,Input]),
];
describe("iOS direct lifecycle independent frozen original policy",()=>{
    it("authenticates verbatim original control and constructs without native observation",()=>{
        expect(createHash("sha256").update(control).digest("hex")).toBe(ORIGINAL_CONTROL_SHA);
        const f=fixture("construct","start");let lookups=0;
        const closed=new Proxy(f.ports,{get(){lookups++;throw new Error("constructor native-port observation");}});
        createIosSimulatorLifecycle(closed);expect(lookups).toBe(0);expect(f.trace).toEqual([]);
    });
    it.each(cases)("%s retains original %s result, native order, full-record CAS and raw error identity",async(operation,mode,args)=>{
        const raw=new Error("raw-ios-native"),a=fixture(mode,operation,raw),b=fixture(mode,operation,raw);
        let before:Reply|undefined,after:Reply|undefined,oldError:unknown,newError:unknown;
        try{before=await original(a.ports)[operation](args);}catch(error){oldError=error;}
        try{after=await createIosSimulatorLifecycle(b.ports)[operation](args);}catch(error){newError=error;}
        expect(newError).toBe(oldError);if(newError!==undefined)expect(newError).toBe(raw);
        expect(after).toEqual(before);expect(b.trace).toEqual(a.trace);expect(b.state()).toEqual(a.state());
        expect(b.publications.map(p=>({expected:p.expected,replacement:p.replacement}))).toEqual(a.publications);
    });
    it("keeps 3000ms recorder wait and its original identity-bearing recording carrier",async()=>{
        const f=fixture("signal-ok","stop");await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(f.trace).toContainEqual(["wait",41,3000]);expect(f.trace.find(row=>row[0]==="signal")?.[1]).toBe(f.base.recording);
        expect(f.state()?.recording).toMatchObject({active:false,pid:41,raw:"recording-metadata",endedAt:fixedTime});
        expect(f.trace.findIndex(row=>row[0]==="signal")).toBeLessThan(f.trace.findIndex(row=>row[0]==="run"));
    });
    it("retains truthful stop partial state after native shutdown and Appium refusal",async()=>{
        const f=fixture("partial","stop");const result=await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(result).toEqual({ok:false,text:"raw Appium failure"});expect(f.state()).toMatchObject({status:"stopped",lifecycle:null,recording:{active:false,raw:"recording-metadata"}});
        expect(f.state()?.appium).toBe(f.base.appium);
    });
    it("matches Appium process identity before session deletion and uses the unchanged native termination default",async()=>{
        const f=fixture("appium-ok","stop");await createIosSimulatorLifecycle(f.ports).stop({deviceId:"unit"});
        expect(f.trace.findIndex(row=>row[0]==="inspect")).toBeLessThan(f.trace.findIndex(row=>row[0]==="delete-session"));
        expect(f.trace.findIndex(row=>row[0]==="delete-session")).toBeLessThan(f.trace.findIndex(row=>row[0]==="terminate"));
        expect(f.trace.find(row=>row[0]==="terminate")?.slice(2)).toEqual(["iOS Simulator Appium",undefined]);
    });
    it("default provisioning stays definition-only and duplicate admission precedes discovery",async()=>{
        const f=fixture("definition","create");await createIosSimulatorLifecycle(f.ports).create({backend:"ios-simulator",name:"Other"});
        expect(f.commands).toEqual([]);expect(f.state()).toMatchObject({id:"ios-other",simulatorName:"ccc-owner-other",provisioning:"definition-only",status:"stopped",udid:null});
        const d=fixture("duplicate","create");await createIosSimulatorLifecycle(d.ports).create({backend:"ios-simulator",name:"Unit",deviceId:"unit"});
        expect(d.trace).toEqual([["read"],["text",false,"Device already exists for this owner: unit"]]);
    });
    it("pure domain retains original claim statuses, simulator selection and bounded refusal text",()=>{
        expect(["start","stop","delete"].map(iosLifecycleClaimStatus)).toEqual(["starting","stopping","deleting"]);
        const host={udid:"u",name:"ccc-owner-a"};expect(selectIosSimulatorMatches({r:[host]},{udid:"u",simulatorName:"different"})).toEqual([host]);
        expect(selectIosSimulatorMatches({r:[host,host]},{simulatorName:host.name})).toHaveLength(2);
        expect(boundedSimulatorIdentityDetail(" "+ "x".repeat(4097)+" ")).toBe("x".repeat(4096)+"...");
        for(const [operation,message]of [["boot","Unable to boot device in current state: Booted"],["shutdown","Unable to shutdown device in current state: Shutdown"],["delete","Invalid device"]] as const){
            expect(iosSimulatorCommandFailed({status:1,stderr:message,stdout:""},operation)).toBe(false);
            expect(iosSimulatorCommandFailed({status:1,stderr:"raw failure",stdout:""},operation)).toBe(true);
        }
    });
});
