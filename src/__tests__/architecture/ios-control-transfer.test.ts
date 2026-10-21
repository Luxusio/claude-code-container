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

const transferArgs = {
    deviceId: "owned", bundleId: "com.example.App", localPath: "/local/file", remotePath: "Documents/file",
};

function transferFixture() {
    const ports = simulatorPorts();
    const stage = { ok: true as const, path: transferArgs.localPath, stagedPath: "/stage/allocated", cleanup: vi.fn() };
    ports.stageInput = vi.fn(() => stage);
    ports.stageOutput = vi.fn(() => stage);
    const dispose = vi.fn(ports.disposeStage);
    const copy = vi.fn(ports.copyInput);
    const populate = vi.fn(ports.populateOutput);
    const commit = vi.fn(ports.commitOutput);
    commit.mockImplementation(() => ({ ok: true, path: stage.path }));
    ports.disposeStage = dispose;
    ports.copyInput = copy;
    ports.populateOutput = populate;
    ports.commitOutput = commit;
    return { ports, stage, dispose, copy, populate, commit };
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

    it.each(["device_upload", "device_download"])("retains completed %s publication when cleanup throws", async name => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        const cleanupError = new Error("stage removal denied");
        dispose.mockImplementation(() => { throw cleanupError; });

        const result = await createIosControlTransfer(ports).handle(name, transferArgs);

        expect(result).toEqual({
            kind: "cleanup-failure",
            primary: {
                kind: "json",
                payload: {
                    [name === "device_upload" ? "uploaded" : "downloaded"]: {
                        localPath: stage.path, remotePath: "Documents/file", bundleId: "com.example.App", containerType: "data",
                    },
                    containerRoot: "/container", provider: "simctl-app-container",
                },
            },
            error: cleanupError,
        });
        if (result?.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError);
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
        if (name === "device_upload") {
            expect(copy).toHaveBeenCalledExactlyOnceWith(stage, "/container/Documents/file");
            expect(populate).not.toHaveBeenCalled();
            expect(commit).not.toHaveBeenCalled();
            expect(copy.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
        } else {
            expect(copy).not.toHaveBeenCalled();
            expect(populate).toHaveBeenCalledExactlyOnceWith("/container/Documents/file", stage);
            expect(commit).toHaveBeenCalledExactlyOnceWith(stage);
            expect(populate.mock.invocationCallOrder[0]).toBeLessThan(commit.mock.invocationCallOrder[0]);
            expect(commit.mock.invocationCallOrder[0]).toBeLessThan(dispose.mock.invocationCallOrder[0]);
        }
    });

    it.each(["device_upload", "device_download"])("does not dispose an unallocated %s stage after staging refusal", async name => {
        const { ports, dispose, copy, populate, commit } = transferFixture();
        const allocate = vi.fn(() => ({ ok: false as const, message: "staging refused" }));
        if (name === "device_upload") ports.stageInput = allocate;
        else ports.stageOutput = allocate;
        const discover = vi.fn(ports.discovery);
        ports.discovery = discover;

        expect(await createIosControlTransfer(ports).handle(name, transferArgs)).toEqual({ kind: "text", message: "staging refused" });
        expect(allocate).toHaveBeenCalledExactlyOnceWith(transferArgs.localPath);
        expect(dispose).not.toHaveBeenCalled();
        expect(discover).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
    });

    it.each([undefined, 0])("retains a falsy cleanup exception (%s) after completed upload", async cleanupError => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        dispose.mockImplementation(() => { throw cleanupError; });

        const result = await createIosControlTransfer(ports).handle("device_upload", transferArgs);

        expect(result?.kind).toBe("cleanup-failure");
        if (result?.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError);
        expect(result.primary).toEqual({ kind: "json", payload: {
            uploaded: { localPath: stage.path, remotePath: "Documents/file", bundleId: "com.example.App", containerType: "data" },
            containerRoot: "/container", provider: "simctl-app-container",
        } });
        expect(copy).toHaveBeenCalledExactlyOnceWith(stage, "/container/Documents/file");
        expect(populate).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
    });

    it.each(["device_upload", "device_download"])("does not dispose an unallocated %s stage when allocation throws", async name => {
        const { ports, dispose, copy, populate, commit } = transferFixture();
        const fault = new Error("allocation failed");
        const allocate = vi.fn(() => { throw fault; });
        if (name === "device_upload") ports.stageInput = allocate;
        else ports.stageOutput = allocate;

        await expect(createIosControlTransfer(ports).handle(name, transferArgs)).rejects.toBe(fault);
        expect(allocate).toHaveBeenCalledExactlyOnceWith(transferArgs.localPath);
        expect(dispose).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
    });

    it.each(["device_upload", "device_download"])("retains the exact %s container-command receipt together with cleanup failure", async name => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        const receipt = { status: 9, stdout: "container observation", stderr: "container refusal" };
        const cleanupError = new Error("stage removal denied");
        ports.resolveContainer = () => ({ kind: "failed", receipt });
        dispose.mockImplementation(() => { throw cleanupError; });

        const result = await createIosControlTransfer(ports).handle(name, transferArgs);

        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "command-failure", receipt }, error: cleanupError });
        if (result?.kind !== "cleanup-failure" || result.primary.kind !== "command-failure") throw new Error("Expected command and cleanup failures");
        expect(result.primary.receipt).toBe(receipt);
        expect(result.error).toBe(cleanupError);
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
        expect(copy).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
    });

    it.each(["device_upload", "device_download"])("retains %s target refusal when cleanup also fails", async name => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        const cleanupError = new Error("stage removal denied");
        const resolve = vi.fn(ports.resolveContainer);
        ports.verifyTarget = () => ({ error: "owned target changed" });
        ports.resolveContainer = resolve;
        dispose.mockImplementation(() => { throw cleanupError; });

        const result = await createIosControlTransfer(ports).handle(name, transferArgs);

        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "text", message: "owned target changed" }, error: cleanupError });
        if (result?.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError);
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
        expect(resolve).not.toHaveBeenCalled();
        expect(copy).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
    });

    it.each(["device_upload", "device_download"])("retains %s containment guard refusal and never transfers after it", async name => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        const cleanupError = new Error("stage removal denied");
        const guard = vi.fn(() => ({ error: "container entry changed" }));
        if (name === "device_upload") ports.guardWrite = guard;
        else ports.guardRead = guard;
        dispose.mockImplementation(() => { throw cleanupError; });

        const result = await createIosControlTransfer(ports).handle(name, transferArgs);

        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "text", message: "container entry changed" }, error: cleanupError });
        if (result?.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError);
        expect(guard).toHaveBeenCalledExactlyOnceWith("/container", "/container/Documents/file");
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
        expect(copy).not.toHaveBeenCalled();
        expect(populate).not.toHaveBeenCalled();
        expect(commit).not.toHaveBeenCalled();
    });

    it.each(["copy", "populate", "commit"] as const)("retains a %s refusal when stage cleanup also fails", async phase => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        const cleanupError = new Error("stage removal denied");
        const failed = { ok: false as const, message: `${phase} refused` };
        if (phase === "copy") copy.mockImplementation(() => failed);
        else if (phase === "populate") populate.mockImplementation(() => failed);
        else commit.mockImplementation(() => failed);
        dispose.mockImplementation(() => { throw cleanupError; });

        const result = await createIosControlTransfer(ports).handle(phase === "copy" ? "device_upload" : "device_download", transferArgs);

        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "text", message: `${phase} refused` }, error: cleanupError });
        if (result?.kind !== "cleanup-failure") throw new Error("Expected cleanup failure");
        expect(result.error).toBe(cleanupError);
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
        if (phase === "copy") {
            expect(copy).toHaveBeenCalledExactlyOnceWith(stage, "/container/Documents/file");
            expect(populate).not.toHaveBeenCalled();
        } else {
            expect(populate).toHaveBeenCalledExactlyOnceWith("/container/Documents/file", stage);
            expect(copy).not.toHaveBeenCalled();
        }
        if (phase === "commit") expect(commit).toHaveBeenCalledExactlyOnceWith(stage);
        else expect(commit).not.toHaveBeenCalled();
    });

    it.each([
        ["upload container resolution", "device_upload", "resolve", new Error("resolver failed")],
        ["download container resolution", "device_download", "resolve", new Error("resolver failed")],
        ["upload guard", "device_upload", "guard", 0],
        ["download guard", "device_download", "guard", false],
        ["upload copy", "device_upload", "copy", undefined],
        ["download population", "device_download", "populate", null],
        ["download publication", "device_download", "commit", ""],
    ] as const)("retains the exact thrown value from %s together with cleanup failure", async (_label, name, phase, fault) => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        const cleanupError = new Error("stage removal denied");
        const fail = () => { throw fault; };
        if (phase === "resolve") ports.resolveContainer = fail;
        else if (phase === "guard") {
            if (name === "device_upload") ports.guardWrite = fail;
            else ports.guardRead = fail;
        } else if (phase === "copy") copy.mockImplementation(fail);
        else if (phase === "populate") populate.mockImplementation(fail);
        else commit.mockImplementation(fail);
        dispose.mockImplementation(() => { throw cleanupError; });

        const result = await createIosControlTransfer(ports).handle(name, transferArgs);

        expect(result).toEqual({ kind: "cleanup-failure", primary: { kind: "thrown", error: fault }, error: cleanupError });
        if (result?.kind !== "cleanup-failure" || result.primary.kind !== "thrown") throw new Error("Expected thrown primary and cleanup failure");
        expect(result.primary.error).toBe(fault);
        expect(result.error).toBe(cleanupError);
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
        if (phase !== "commit") expect(commit).not.toHaveBeenCalled();
        if (phase === "resolve" || phase === "guard") {
            expect(copy).not.toHaveBeenCalled();
            expect(populate).not.toHaveBeenCalled();
        }
    });

    it.each([
        ["device_upload", undefined],
        ["device_download", 0],
    ] as const)("rethrows the exact %s failure after successful stage cleanup", async (name, fault) => {
        const { ports, stage, dispose, copy, populate, commit } = transferFixture();
        if (name === "device_upload") copy.mockImplementation(() => { throw fault; });
        else commit.mockImplementation(() => { throw fault; });

        await expect(createIosControlTransfer(ports).handle(name, transferArgs)).rejects.toBe(fault);
        expect(dispose).toHaveBeenCalledExactlyOnceWith(stage);
        if (name === "device_upload") {
            expect(populate).not.toHaveBeenCalled();
            expect(commit).not.toHaveBeenCalled();
        } else {
            expect(populate).toHaveBeenCalledExactlyOnceWith("/container/Documents/file", stage);
            expect(commit).toHaveBeenCalledExactlyOnceWith(stage);
        }
    });
});
