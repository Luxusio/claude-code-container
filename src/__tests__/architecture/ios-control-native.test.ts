import {describe,expect,it,vi} from "vitest";
import {performIosControl,createIosSimulatorNative} from "../../../packages/device-lab/providers/adapters/ios-control-transfer.mjs";
import {iosControlRequest} from "../../../packages/device-lab/providers/domain/ios-control-transfer.mjs";
const session={serverUrl:"http://allocated",sessionId:"session"};
const command=(name:string,args:object)=>{
    const request=iosControlRequest(name,args);
    if(!request||!("name" in request))throw Error("Expected admitted control intent");
    return request;
};
const fetchFixture=()=>vi.fn(async(_url:string,_options:{method:string,body:string})=>({}));
describe("iOS native control framing",()=>{
    it("frames long press default and explicit zero duration as W3C actions",async()=>{
        for(const durationMs of [undefined,0,1250]){
            const fetch=fetchFixture();
            expect(await performIosControl(fetch,session,command("mobile_long_press",{x:10,y:20,...(durationMs===undefined?{}:{durationMs})}))).toEqual({kind:"succeeded"});
            expect(fetch).toHaveBeenCalledWith("http://allocated/session/session/actions",{method:"POST",body:JSON.stringify({actions:[{type:"pointer",id:"finger1",parameters:{pointerType:"touch"},actions:[{type:"pointerMove",duration:0,x:10,y:20},{type:"pointerDown",button:0},{type:"pause",duration:durationMs??700},{type:"pointerUp",button:0}]}],gesture:"longPress"})});
        }
    });
    it.each([["mobile_swipe",300,"swipe"],["mobile_drag",700,"drag"]] as const)("frames %s duration and coordinates",async(name,duration,gesture)=>{
        const fetch=fetchFixture();
        await performIosControl(fetch,session,command(name,{x1:1,y1:2,x2:3,y2:4}));
        expect(JSON.parse(fetch.mock.calls[0]![1]!.body)).toEqual({actions:[{type:"pointer",id:"finger1",parameters:{pointerType:"touch"},actions:[{type:"pointerMove",duration:0,x:1,y:2},{type:"pointerDown",button:0},{type:"pointerMove",duration,x:3,y:4},{type:"pointerUp",button:0}]}],gesture});
    });
    it("splits Unicode into code points for native text entry",async()=>{
        const fetch=fetchFixture();
        await performIosControl(fetch,session,command("mobile_type_text",{text:"A😀é"}));
        expect(fetch).toHaveBeenCalledWith("http://allocated/session/session/keys",{method:"POST",body:JSON.stringify({text:"A😀é",value:["A","😀","é"]})});
    });
    it.each([["mobile_home",{script:"mobile: pressButton",args:[{name:"home"}]}],["mobile_lock",{script:"mobile: lock",args:[]}],["mobile_unlock",{script:"mobile: unlock",args:[]}]] as const)("frames %s execute route",async(name,body)=>{
        const fetch=fetchFixture();await performIosControl(fetch,session,command(name,{}));
        expect(fetch).toHaveBeenCalledWith("http://allocated/session/session/execute/sync",{method:"POST",body:JSON.stringify(body)});
    });
    it("normalizes orientation and preserves native failure message",async()=>{
        const fetch=fetchFixture();await performIosControl(fetch,session,command("mobile_set_orientation",{orientation:"reverse-landscape"}));
        expect(fetch).toHaveBeenCalledWith("http://allocated/session/session/orientation",{method:"POST",body:JSON.stringify({orientation:"LANDSCAPE"})});
        expect(await performIosControl(async()=>{throw new Error("native denial");},session,command("mobile_home",{}))).toEqual({kind:"failed",message:"native denial"});
    });
});
describe("iOS native simctl observations",()=>{
    it.each([["boot","Unable to boot device in current state: Booted"],["shutdown","Unable to shutdown device in current state: Shutdown"],["delete","Invalid device"]] as const)("interprets only the %s idempotent diagnostic", (operation,diagnostic)=>{
        for(const channel of ["stdout","stderr"] as const){
            const receipt={status:7,stdout:"",stderr:"",[channel]:diagnostic};
            const run=vi.fn(()=>receipt);const native=createIosSimulatorNative({run,runWithTimeout:run,simctlJson:()=>({value:{devices:{}}})});
            expect(native.simulatorOperation("/allocated/xcrun",operation,"exact-udid")).toEqual({kind:"succeeded",receipt});
            expect(run).toHaveBeenCalledWith("/allocated/xcrun",["simctl",operation,"exact-udid"]);
            const refused={status:7,stdout:"",stderr:"raw refusal"};run.mockReturnValue(refused);
            expect(native.simulatorOperation("/allocated/xcrun",operation,"exact-udid")).toEqual({kind:"failed",receipt:refused,message:"raw refusal"});
            const unrelated={status:7,stdout:"",stderr:operation==="boot"?"Invalid device":"Unable to boot device in current state: Booted"};run.mockReturnValue(unrelated);
            expect(native.simulatorOperation("/allocated/xcrun",operation,"exact-udid")).toEqual({kind:"failed",receipt:unrelated,message:unrelated.stderr});
        }
    });
    it("decodes inventory without collapsing ambiguous host identities",()=>{
        const host={name:"ccc-owned",udid:"same"};const list=vi.fn(()=>({value:{devices:{r:[host,host],other:[{name:"foreign",udid:"other"}]}}}));
        const native=createIosSimulatorNative({run:()=>({status:0,stdout:"",stderr:""}),runWithTimeout:()=>({status:0,stdout:"",stderr:""}),simctlJson:list});
        expect(native.inventory("/sdk/xcrun")).toEqual({kind:"listed",devices:[host,host,{name:"foreign",udid:"other"}]});
        expect(list).toHaveBeenCalledWith("/sdk/xcrun",["list","devices","-j"]);
    });
    it("preserves create UDID and boot timeout diagnostic receipts",()=>{
        const receipt={status:4,stdout:"boot progress",stderr:"deadline",error:new Error("timeout")};
        const run=vi.fn(()=>({status:0,stdout:" exact-udid \n",stderr:""})),wait=vi.fn(()=>receipt);
        const native=createIosSimulatorNative({run,runWithTimeout:wait,simctlJson:()=>({value:{devices:{}}})});
        expect(native.createSimulator("/sdk/xcrun","ccc-owned","type","runtime")).toEqual({kind:"created",udid:"exact-udid"});
        expect(run).toHaveBeenCalledWith("/sdk/xcrun",["simctl","create","ccc-owned","type","runtime"]);
        expect(native.waitForBoot("/sdk/xcrun","exact-udid",1234)).toEqual({ready:false,skipped:false,...receipt});
        expect(wait).toHaveBeenCalledWith("/sdk/xcrun",["simctl","bootstatus","exact-udid","-b"],1234);
    });
});
