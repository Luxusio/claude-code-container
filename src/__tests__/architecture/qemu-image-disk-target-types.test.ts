import { describe, expect, it } from "vitest";
import { createQemuImageDiskTargetApplication } from "../../../packages/device-lab/providers/application/qemu-image-disk-target.mjs";
import type { QemuLab, QemuImageDiskTargetPorts, QemuDiskResult, QemuTargetResult } from "../../../packages/device-lab/providers/ports/qemu-image-disk-target.mjs";

// Current public .mjs specifiers must resolve the shipped .d.mts contracts.
// These consumers also belong in genuine source/emission strict QA; a runtime
// Vitest result alone does not prove that @ts-expect-error controls were checked.
const lab:QemuLab={id:"unit",name:"Unit",runtimeState:"stopped",paths:{labDir:"/owned/unit",workspaceDir:"/owned/workspace",artifactsDir:"/owned/artifacts"},extra:{raw:true}};
const ports:QemuImageDiskTargetPorts={
    ownerId:"owner",imagesRootExists:()=>false,imageEntries:()=>[],readImageMetadata:()=>({id:"base",raw:[1,null]}),
    readLab:()=>({ok:true,lab}),validateImageSource:()=>({ok:true,path:"/owned/base.raw",format:"raw"}),
    validateDiskPath:()=>({ok:true,diskPath:"/owned/unit/root.qcow2"}),diskExists:()=>false,providerStatus:()=>({available:false}),
    createOverlay:()=>({ok:true,command:"opaque-native-command",args:[]}),
    now:()=>"frozen-time",writeLab:()=>undefined,presentLab:value=>value,presentExecution:value=>value,ownerLabs:()=>[lab],
};
type RequiredSteps=Omit<QemuImageDiskTargetPorts,"providerCommandTimeoutMs">;
type OptionalKeys<T> = {[K in keyof T]-?: object extends Pick<T,K> ? K : never}[keyof T];
const allStepsRequired:[OptionalKeys<RequiredSteps>] extends [never]?true:false=true;void allStepsRequired;
function contractNegatives(){
    const {readLab,...missingRead}=ports;void readLab;
    // @ts-expect-error actual lab observation is required
    createQemuImageDiskTargetApplication(missingRead);
    // @ts-expect-error metadata observation is synchronous JSON, never a Promise
    const asyncMetadata:QemuImageDiskTargetPorts={...ports,readImageMetadata:async()=>({id:"base"})};
    // @ts-expect-error image inventory is observed synchronously
    const asyncEntries:QemuImageDiskTargetPorts={...ports,imageEntries:async()=>[]};
    // @ts-expect-error canonical source validation is synchronous
    const asyncSource:QemuImageDiskTargetPorts={...ports,validateImageSource:async()=>({ok:true,path:"/base",format:"raw"})};
    // @ts-expect-error canonical disk validation carries a discriminated disk path
    const weakDisk:QemuImageDiskTargetPorts={...ports,validateDiskPath:()=>({ok:true})};
    // @ts-expect-error provider status must carry the availability decision
    const weakProvider:QemuImageDiskTargetPorts={...ports,providerStatus:()=>({qemuImg:"qemu-img"})};
    // @ts-expect-error overlay completion must be a synchronous normalized observation
    const asyncOverlay:QemuImageDiskTargetPorts={...ports,createOverlay:async()=>({ok:true,command:"native",args:[]})};
    // @ts-expect-error normalized overlay success requires the opaque native receipt
    const weakOverlay:QemuImageDiskTargetPorts={...ports,createOverlay:()=>({ok:true})};
    // @ts-expect-error generic command execution is not an inward capability
    const recipeRunner:QemuImageDiskTargetPorts={...ports,qemuImageRunner:()=>()=>({ok:true})};
    // @ts-expect-error publication must finish synchronously before returning materialized success
    const asyncWrite:QemuImageDiskTargetPorts={...ports,writeLab:async()=>undefined};
    // @ts-expect-error passive owner-lab inventory is synchronous
    const asyncLabs:QemuImageDiskTargetPorts={...ports,ownerLabs:async()=>[lab]};
    // @ts-expect-error raw mutable lab id remains a string
    const malformed:QemuLab={...lab,id:8};
    // @ts-expect-error materialization has a synchronous discriminated public result
    const promised:Promise<QemuDiskResult>=createQemuImageDiskTargetApplication(ports).materializeDisk({labId:"unit"});
    void asyncMetadata;void asyncEntries;void asyncSource;void weakDisk;void weakProvider;void asyncOverlay;
    void weakOverlay;void recipeRunner;void asyncWrite;void asyncLabs;void malformed;void promised;
}
void contractNegatives;

describe("QEMU current required leaf and result contracts",()=>{
    it("keeps mutable raw carriers and synchronous public factory outputs",()=>{
        lab.extra={changed:true};lab.runtimeState="stopped";
        const app=createQemuImageDiskTargetApplication(ports);
        const disk:QemuDiskResult=app.materializeDisk({labId:"unit"});
        const targets:QemuTargetResult=app.listTargets({labId:"unit"});
        expect(disk).toMatchObject({ok:false,error:"lab-provider-unsupported"});
        expect(targets).toMatchObject({ok:true,targets:[{labId:"unit",readiness:"stopped",creatable:false}]});
        expect(app.listImages()).toEqual({ok:true,ownerId:"owner",images:[]});
    });
});

