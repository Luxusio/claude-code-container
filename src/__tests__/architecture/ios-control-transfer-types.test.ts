import {describe,expect,it} from "vitest";
import {createIosControlTransfer} from "../../../packages/device-lab/providers/application/ios-control-transfer.mjs";
import {iosControlRequest} from "../../../packages/device-lab/providers/domain/ios-control-transfer.mjs";
import type {IosSimulatorControlPorts,IosControlOutcome} from "../../../packages/device-lab/providers/ports/ios-control-transfer.mjs";
export function requiredIosCapabilities(ports:IosSimulatorControlPorts){
    const app=createIosControlTransfer(ports);
    const response:Promise<IosControlOutcome|undefined>=app.handle("mobile_home",{deviceId:"owned"});
    const {performControl,...missingControl}=ports;
    // @ts-expect-error semantic control effect is required
    createIosControlTransfer(missingControl);
    const {commitOutput,...missingCommit}=ports;
    // @ts-expect-error download publication is required
    createIosControlTransfer(missingCommit);
    // @ts-expect-error disposal remains synchronous
    createIosControlTransfer({...ports,disposeStage:async()=>undefined});
    // @ts-expect-error native operation must return finite success or failure
    createIosControlTransfer({...ports,performControl:async()=>({status:0})});
    // @ts-expect-error container resolution returns a decoded finite result
    createIosControlTransfer({...ports,resolveContainer:()=>({status:0,stdout:"/container",stderr:""})});
    return {response,performControl,commitOutput};
}
describe("iOS key admission",()=>{
    it("uses explicit key before keyCode and rejects an empty key",()=>{
        expect(iosControlRequest("mobile_key",{key:"Return",keyCode:13})).toEqual({name:"mobile_key",args:{key:"Return",keyCode:13},payload:{key:"Return"}});
        expect(iosControlRequest("mobile_key",{key:"",keyCode:13})).toEqual({error:"mobile_key requires key or keyCode"});
    });
});
