import { describe, expect, it, vi } from "vitest";
import { createIosControlTransfer } from "../../../packages/device-lab/providers/application/ios-control-transfer.mjs";
import type { IosSimulatorControlPorts } from "../../../packages/device-lab/providers/ports/ios-control-transfer.mjs";

function simulatorPorts(): IosSimulatorControlPorts {
    return {
        kind: "simulator", findDevice: () => ({ id: "owned", simulatorName: "ccc-owned" }),
        resolveSession: async () => ({ serverUrl: "http://appium", sessionId: "session" }),
        performControl: async () => ({kind:"succeeded"}),
        ownedSimulatorName: () => true,
        discovery: () => ({ available: true, xcrun: "/sdk/xcrun", missing: [] }),
        verifyTarget: () => ({ target: "udid" }),
        resolveContainer: () => ({ kind:"resolved", containerRoot:"/container" }),
        pathFacts: () => ({ path: "/container/Documents/file", relativePath: "Documents/file", absolute: false }),
        guardWrite: () => ({}), guardRead: () => ({}), exists: () => true,
        stageInput: () => ({ ok: true, path: "/input", stagedPath: "/stage/input", cleanup: () => {} }),
        stageOutput: () => ({ ok: true, path: "/output", stagedPath: "/stage/output", cleanup: () => {} }),
        copyInput: () => ({ ok: true, path: "/container/Documents/file" }),
        populateOutput: () => ({ ok: true, path: "/stage/output" }),
        commitOutput: () => ({ ok: true, path: "/output" }), disposeStage: () => undefined,
    };
}

describe("iOS control and transfer application", () => {
    it("refuses physical transfers before touching a session",async()=>{
        const ports={kind:"physical" as const,findDevice:vi.fn(()=>({id:"real"})),resolveSession:vi.fn(async()=>({serverUrl:"http://allocated",sessionId:"session"})),performControl:vi.fn(async()=>({kind:"succeeded" as const}))};
        for(const name of ["device_upload","device_download"])expect(await createIosControlTransfer(ports).handle(name,{deviceId:"real",localPath:"/file",remotePath:"Documents/file",bundleId:"app"})).toBeUndefined();
        expect(ports.findDevice).not.toHaveBeenCalled();expect(ports.resolveSession).not.toHaveBeenCalled();expect(ports.performControl).not.toHaveBeenCalled();
    });
    it("reports a semantic control refusal and physical provider evidence",async()=>{
        const ports=simulatorPorts();ports.performControl=async()=>({kind:"failed",message:"native refusal"});
        expect(await createIosControlTransfer(ports).handle("mobile_home",{deviceId:"owned"})).toEqual({kind:"text",message:"iOS Simulator Appium request failed: native refusal"});
        expect(await createIosControlTransfer({kind:"physical",findDevice:ports.findDevice,resolveSession:ports.resolveSession,performControl:async()=>({kind:"succeeded"})}).handle("mobile_home",{deviceId:"owned"})).toEqual({kind:"json",payload:{home:true,provider:"appium-xcuitest",physical:true}});
    });
    it.each(["device_upload","device_download"])("disposes the allocated %s stage after ownership refusal without copying",async name=>{
        const ports=simulatorPorts(),dispose=vi.fn(ports.disposeStage),copy=vi.fn(ports.copyInput),populate=vi.fn(ports.populateOutput);
        ports.disposeStage=dispose;ports.copyInput=copy;ports.populateOutput=populate;ports.verifyTarget=()=>({error:"ambiguous owned target"});
        expect(await createIosControlTransfer(ports).handle(name,{deviceId:"owned",localPath:"/file",remotePath:"Documents/file",bundleId:"app"})).toEqual({kind:"text",message:"ambiguous owned target"});
        expect(dispose).toHaveBeenCalledTimes(1);expect(copy).not.toHaveBeenCalled();expect(populate).not.toHaveBeenCalled();
    });
    it.each(["device_upload","device_download"])("rejects %s container escape before transfer and disposes the stage",async name=>{
        const ports=simulatorPorts(),dispose=vi.fn(ports.disposeStage),copy=vi.fn(ports.copyInput),populate=vi.fn(ports.populateOutput);
        ports.disposeStage=dispose;ports.copyInput=copy;ports.populateOutput=populate;ports.pathFacts=()=>({path:"/escape",relativePath:"../escape",absolute:false});
        expect(await createIosControlTransfer(ports).handle(name,{deviceId:"owned",localPath:"/file",remotePath:"../escape",bundleId:"app"})).toEqual({kind:"text",message:"Refusing path outside iOS app container: ../escape"});
        expect(dispose).toHaveBeenCalledTimes(1);expect(copy).not.toHaveBeenCalled();expect(populate).not.toHaveBeenCalled();
    });
    it("preserves the container failure receipt and disposes upload staging",async()=>{
        const ports=simulatorPorts(),receipt={status:9,stdout:"",stderr:"container refusal"},dispose=vi.fn(ports.disposeStage);
        ports.disposeStage=dispose;ports.resolveContainer=()=>({kind:"failed",receipt});
        const result=await createIosControlTransfer(ports).handle("device_upload",{deviceId:"owned",localPath:"/file",remotePath:"Documents/file",bundleId:"app"});
        expect(result).toEqual({kind:"command-failure",receipt});if(result?.kind==="command-failure")expect(result.receipt).toBe(receipt);
        expect(dispose).toHaveBeenCalledTimes(1);
    });
    it("sends the default long press and preserves the public provider result", async () => {
        const ports = simulatorPorts();
        const request = vi.fn(ports.performControl);
        ports.performControl = request;
        expect(await createIosControlTransfer(ports).handle("mobile_long_press", { deviceId: "owned", x: 10, y: 20 })).toEqual({
            kind:"json",payload:{longPressed: { x: 10, y: 20, durationMs: 700 }, provider: "appium-xcuitest"},
        });
        expect(request).toHaveBeenCalledWith({ serverUrl: "http://appium", sessionId: "session" }, {
            name:"mobile_long_press",args:{deviceId:"owned",x:10,y:20,durationMs:700},payload:{longPressed:{x:10,y:20,durationMs:700}},
        });
    });

    it("does not report success for an unknown or failed session", async () => {
        const ports = simulatorPorts();
        ports.performControl = async () => { throw new Error("unexpected request"); };
        ports.resolveSession = async () => ({ unknown: true });
        expect(await createIosControlTransfer(ports).handle("mobile_home", { deviceId: "owned" })).toBeUndefined();
        ports.resolveSession = async () => ({ error: "session unavailable" });
        expect(await createIosControlTransfer(ports).handle("mobile_home", { deviceId: "owned" })).toEqual({ kind:"text", message: "session unavailable" });
    });

    it("disposes an upload stage when native copying throws", async () => {
        const ports = simulatorPorts();
        const fault = new Error("copy denied");
        ports.copyInput = () => { throw fault; };
        const dispose = vi.fn(ports.disposeStage);
        ports.disposeStage = dispose;
        await expect(createIosControlTransfer(ports).handle("device_upload", {
            deviceId: "owned", bundleId: "com.example.App", localPath: "/input", remotePath: "Documents/file",
        })).rejects.toBe(fault);
        expect(dispose).toHaveBeenCalledWith(expect.objectContaining({ path: "/input", stagedPath: "/stage/input" }));
    });

    it("reports failed download publication and disposes its stage", async () => {
        const ports = simulatorPorts();
        ports.commitOutput = () => ({ ok:false, message: "destination changed" });
        const dispose = vi.fn(ports.disposeStage);
        ports.disposeStage = dispose;
        expect(await createIosControlTransfer(ports).handle("device_download", {
            deviceId: "owned", bundleId: "com.example.App", localPath: "/output", remotePath: "Documents/file",
        })).toEqual({ kind:"text", message: "destination changed" });
        expect(dispose).toHaveBeenCalledWith(expect.objectContaining({ path: "/output" }));
    });
});
