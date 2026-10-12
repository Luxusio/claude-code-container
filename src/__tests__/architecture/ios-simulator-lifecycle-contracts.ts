import {createIosSimulatorLifecycle} from "../../../packages/device-lab/providers/application/lifecycle/ios-simulator-lifecycle.mjs";
import type {IosSimulatorLifecyclePorts,IosSimulatorLifecycleInput,IosSimulatorLifecycleOutcome,IosSimulatorRecording,IosSimulatorLifecycleClaim} from "../../../packages/device-lab/providers/ports/lifecycle/ios-simulator-lifecycle.mjs";
// Strict compile contracts; no native effect is invoked.
function contracts(ports:IosSimulatorLifecyclePorts,input:IosSimulatorLifecycleInput){
    const app=createIosSimulatorLifecycle(ports);
    const outcomes:Promise<IosSimulatorLifecycleOutcome|undefined>[]=[app.create(input),app.start(input),app.stop(input),app.delete(input)];
    const {simulatorOperation,...missingOperation}=ports;
    // @ts-expect-error finite simulator effect is required
    createIosSimulatorLifecycle(missingOperation);
    const {runtimeId,...missingGeneration}=ports;
    // @ts-expect-error generation authority is required
    createIosSimulatorLifecycle(missingGeneration);
    // @ts-expect-error record observation remains synchronous
    createIosSimulatorLifecycle({...ports,readIosDevices:async()=>[]});
    // @ts-expect-error inventory remains a synchronous decoded observation
    createIosSimulatorLifecycle({...ports,inventory:async()=>({kind:"listed",devices:[]})});
    // @ts-expect-error a raw status cannot substitute for native interpretation
    createIosSimulatorLifecycle({...ports,simulatorOperation:()=>({status:0,stdout:"",stderr:""})});
    // @ts-expect-error CAS needs matched and found
    createIosSimulatorLifecycle({...ports,transitionIosDevice:()=>({matched:true})});
    // @ts-expect-error CAS publication is synchronous
    createIosSimulatorLifecycle({...ports,transitionIosDevice:async()=>({matched:true,found:true})});
    // @ts-expect-error timestamps are synchronous
    createIosSimulatorLifecycle({...ports,wallTimestamp:async()=>"t"});
    // @ts-expect-error recorder settlement is asynchronous
    createIosSimulatorLifecycle({...ports,waitForProcessExit:()=>true});
    // @ts-expect-error session cleanup is asynchronous
    createIosSimulatorLifecycle({...ports,deleteAppiumSession:()=>undefined});
    // @ts-expect-error process settlement has a boolean exited
    createIosSimulatorLifecycle({...ports,terminateOwnedAppiumProcess:async()=>({exited:1})});
    // @ts-expect-error stage cleanup is synchronous
    createIosSimulatorLifecycle({...ports,discardLocalOutputStage:async()=>({ok:true})});
    // @ts-expect-error signaling retains signaled status
    createIosSimulatorLifecycle({...ports,signalOwnedRuntimeProcess:()=>({pid:41})});
    // @ts-expect-error recorder PID is numeric
    const recording:IosSimulatorRecording={pid:"41"};
    // @ts-expect-error claim generation is a string
    const claim:IosSimulatorLifecycleClaim={runtimeId:9,operation:"start",claimedAt:"t"};
    // @ts-expect-error timeout is numeric
    ports.waitForBoot("xcrun","udid","3000");
    // @ts-expect-error provisioning flag remains boolean
    app.create({createSimulator:"yes"});
    void [outcomes,simulatorOperation,runtimeId,recording,claim];
}
void contracts;
