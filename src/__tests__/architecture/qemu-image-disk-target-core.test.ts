import { describe, expect, it } from "vitest";
import { createQemuImageDiskTargetApplication } from "../../../packages/device-lab/providers/application/qemu-image-disk-target.mjs";
import { qemuCommandTimeout, qemuOverlayArguments, qemuTargetForLab } from "../../../packages/device-lab/providers/domain/qemu-image-disk-target.mjs";

// No task directory, current source hash, or candidate-derived expected output.
type Ports = Parameters<typeof createQemuImageDiskTargetApplication>[0];
function fixture() {
    const trace: string[] = [], fault = { native: "sentinel" }, environment={SENTINEL:"native environment"};
    const lab = { id: "unit", name: "Unit", runtimeState: "stopped", provider: "container-qemu",
        ownerId: "owner", paths: { labDir: "/owned/unit", workspaceDir: "/owned/unit/workspace", artifactsDir: "/owned/unit/artifacts" },
        image: { sourceImage: "/owned/base.raw", format: "raw", diskImage: "/owned/unit/disks/root.qcow2" }, extra: { raw: true } };
    const source = { ok: true as const, path: "/owned/base.raw", format: "raw", stat: { size: 3 } };
    const disk = { ok: true as const, diskPath: lab.image.diskImage };
    const status = { ok: true, available: true, qemuImg: "/bin/qemu-img", provider: "container-qemu", status: "ready" };
    const execution = { ok: true, status: 0, stdout: "raw stdout", stderr: "raw stderr", extra: fault };
    const state = { root: true, exists: false, loaded: { ok: true as const, lab }, source, disk, status, execution,
        entries: [{name:"second",isDirectory:()=>true},{name:"file",isDirectory:()=>false},{name:"bad",isDirectory:()=>true},{name:"first",isDirectory:()=>true}],
        published: undefined as unknown, throws: "" };
    const observe = (phase: string) => { trace.push(phase); if (state.throws === phase) throw fault; };
    const ports: Ports = {
        ownerId: "owner",
        imagesRootExists: () => { observe("images-root"); return state.root; },
        imageEntries: () => { observe("entries"); return state.entries; },
        readImageMetadata: name => { observe("image:"+name); if(name==="bad")throw fault; return {id:name,raw:fault}; },
        readLab: id => { observe("read:"+id); return state.loaded; },
        validateImageSource: (path, format) => { observe("source:"+path+":"+format); return state.source; },
        validateDiskPath: () => { observe("disk-path"); return state.disk; },
        diskExists: () => { observe("disk-exists"); return state.exists; },
        providerStatus: () => { observe("provider"); return state.status; },
        ensureDiskParent: () => { observe("mkdir"); return undefined; },
        qemuImageRunner: () => { observe("runner"); return (command, args, options) => { observe("run"); expect(command).toBe("/bin/qemu-img");
            expect(args).toEqual(["create","-f","qcow2","-F","raw","-b","/owned/base.raw",lab.image.diskImage]);
            expect(options).toEqual({cwd:lab.paths.labDir,env:environment,timeoutMs:120000}); return state.execution; }; },
        commandEnvironment: () => { observe("env"); return environment; },
        now: () => { observe("now"); return "frozen-time"; },
        writeLab: value => { observe("write"); state.published=value; return undefined; },
        presentLab: value => { observe("present-lab"); return value; },
        presentExecution: value => { observe("present-execution"); return value; },
        ownerLabs: () => { observe("labs"); return [lab]; },
    };
    return {trace,fault,lab,state,ports,app:createQemuImageDiskTargetApplication(ports)};
}

describe("QEMU whole inward image/disk/target policy", () => {
    it("constructs without observing native ports", () => { expect(fixture().trace).toEqual([]); });
    it("omits unreadable metadata and nondirectories while retaining native image order", () => {
        const f=fixture(); expect(f.app.listImages()).toMatchObject({ok:true,images:[{id:"second"},{id:"first"}]});
        expect(f.trace.slice(0,5)).toEqual(["images-root","entries","image:second","image:bad","image:first"]);
        expect(f.app.listImages()).toMatchObject({ownerId:"owner",images:[{id:"second"},{id:"first"}]});
        f.trace.length=0;f.state.root=false;expect(f.app.listImages()).toEqual({ok:true,ownerId:"owner",images:[]});expect(f.trace).toEqual(["images-root"]);
    });
    it("preserves running refusal before source or disk observations", () => {
        const f=fixture(); f.lab.runtimeState="running";
        expect(f.app.materializeDisk({labId:"unit"})).toEqual({ok:false,error:"lab-running",labId:"unit"});expect(f.trace).toEqual(["read:unit"]);
    });
    it("forwards missing lab/source/path refusals before later native observations",()=>{
        for(const phase of ["readLab","validateImageSource","validateDiskPath"] as const){
            const f=fixture(), refusal={ok:false as const,error:"original-"+phase,raw:f.fault};
            f.ports[phase]=()=>refusal;
            expect(f.app.materializeDisk({labId:"unit"})).toBe(refusal);
            expect(f.trace).not.toContain("disk-exists");expect(f.trace).not.toContain("provider");expect(f.trace).not.toContain("run");
        }
    });
    it("refuses unsupported provider/missing qemu-img and preserves raw command failure",()=>{
        const f=fixture();f.state.status.available=false;
        expect(f.app.materializeDisk({labId:"unit"})).toMatchObject({error:"lab-provider-unsupported",providerStatus:f.state.status});
        f.state.status.available=true;f.state.status.qemuImg="";
        expect(f.app.materializeDisk({labId:"unit"})).toMatchObject({error:"qemu-img-unavailable"});expect(f.trace).not.toContain("run");
        f.state.status.qemuImg="/bin/qemu-img";f.state.execution.ok=false;
        const result=f.app.materializeDisk({labId:"unit"});expect(result).toMatchObject({error:"qemu-img-create-failed",result:f.state.execution});
        expect(f.trace).not.toContain("now");expect(f.state.published).toBeUndefined();
    });
    it.each([undefined,false,1,"true"])("reuses an existing disk unless force is strictly true (%s)",force=>{
        const f=fixture();f.state.exists=true;
        expect(f.app.materializeDisk({labId:"unit",force,dryRun:true})).toMatchObject({ok:true,reused:true});
        expect(f.trace).not.toContain("provider");expect(f.trace).not.toContain("run");expect(f.state.published).toBeUndefined();
    });
    it("dry-run plans after repeated canonical disk validation and never executes or publishes",()=>{
        const f=fixture();const value=f.app.materializeDisk({labId:"unit",dryRun:true});
        expect(value).toMatchObject({ok:true,dryRun:true,materialized:false,plan:{command:"/bin/qemu-img"}});
        expect(f.trace).not.toContain("mkdir");expect(f.trace).not.toContain("now");expect(f.trace).not.toContain("write");
    });
    it("strict force executes exact argv and publishes only after success and clock observation",()=>{
        const f=fixture();f.state.exists=true;
        const value=f.app.materializeDisk({labId:"unit",force:true});
        expect(value).toMatchObject({ok:true,materialized:true,disk:{forced:true,backingFormat:"raw",materializedAt:"frozen-time"}});
        expect(f.trace.indexOf("run")).toBeLessThan(f.trace.indexOf("now"));
        expect(f.trace.indexOf("now")).toBeLessThan(f.trace.indexOf("write"));
        expect(f.state.published).toMatchObject({extra:f.lab.extra,image:{disk:{path:f.lab.image.diskImage}}});
    });
    it("keeps raw thrown command identity and completed overlay effect on publication failure",()=>{
        const f=fixture();f.state.throws="run";
        let commandFault:unknown;try{f.app.materializeDisk({labId:"unit"});}catch(error){commandFault=error;}expect(commandFault).toBe(f.fault);
        expect(f.trace).not.toContain("write");f.trace.length=0;f.state.throws="write";
        let caught:unknown;try{f.app.materializeDisk({labId:"unit"});}catch(error){caught=error;}
        expect(caught).toBe(f.fault);expect(f.trace.filter(x=>x==="run")).toHaveLength(1);expect(f.trace).not.toContain("rollback");
    });
    it("explicit and all-owner targets stay passive",()=>{
        const f=fixture();expect(f.app.listTargets({labId:"unit"})).toMatchObject({ok:true,targets:[{labId:"unit",attachable:false}]});
        expect(f.app.listTargets()).toMatchObject({ok:true,targets:[{labId:"unit"}]});
        expect(f.trace).toEqual(["read:unit","labs"]);
    });
    it.each(["stopped","running"])("projects %s targets without probes or channels",runtimeState=>{
        const f=fixture();const lab={...f.lab,runtimeState,runtime:{pid:7,command:"qemu",startedAt:"time",secret:"private"},readiness:{latest:{state:"unexpected"}}};
        const target=qemuTargetForLab(lab);
        expect(target).toMatchObject({readiness:runtimeState==="running"?"process-running":"stopped",attachable:runtimeState==="running",creatable:false,runtime:{pid:7,command:"qemu",startedAt:"time"}});
        expect(target.runtime).not.toHaveProperty("secret");expect(f.trace).toEqual([]);
        expect(qemuTargetForLab({...lab,runtimeState:"running",readiness:{latest:{state:"failed"}},guest:{ssh:{},agent:{}}})).toMatchObject({attachable:false,sessionState:"unavailable",sessionHints:{guestSsh:"bounded-guest-ssh-session-available",guestAgent:"bounded-guest-agent-session-available"}});
    });
    it("preserves command timeout bounds and exact overlay planning",()=>{
        for(const [value,expected] of [[undefined,120000],[null,120000],["",120000],[-1,120000],[1.5,120000],["1500",1500],[900000,600000]] as const)
            expect(qemuCommandTimeout(value,120000)).toBe(expected);
        const f=fixture();expect(qemuOverlayArguments(f.state.source,f.lab.image.diskImage)).toEqual(["create","-f","qcow2","-F","raw","-b","/owned/base.raw",f.lab.image.diskImage]);
    });
});

