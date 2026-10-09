import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { join, dirname } from "node:path";
import { createQemuImageDiskTargetApplication } from "../../../packages/device-lab/providers/application/qemu-image-disk-target.mjs";
import { qemuCommandTimeout, qemuOverlayArguments, qemuTargetForLab } from "../../../packages/device-lab/providers/domain/qemu-image-disk-target.mjs";

// ORIGINAL Git 720addb4b97a35cac1e862bff7e074e7e2a42319; facade and
// genuine assembled emission SHA256 f27fba0d138d2d6390f7076d699a3ec93435a8d9c149a4221cfd3c26bb2a64a9.
// Minimal immutable reached orchestration bodies, frozen before extraction.
// No task directory, current source hash, or candidate-derived expected output.
const ORIGINAL = "function listImages(options = {}) {\n    const ctx = context(options);\n    const imagesRoot = join(ctx.ownerRoot, \"images\");\n    if (!existsSync(imagesRoot)) return { ok: true, ownerId: ctx.owner, images: [] };\n    const images = readdirSync(imagesRoot, { withFileTypes: true })\n        .filter((entry) => entry.isDirectory())\n        .map((entry) => {\n            try {\n                return readJson(join(imagesRoot, entry.name, \"image.json\"));\n            } catch {\n                return null;\n            }\n        })\n        .filter(Boolean);\n    return { ok: true, ownerId: ctx.owner, images };\n}\n\nfunction qemuImgCreateOverlay(lab, source, options = {}, dryRun = false) {\n    const disk = validateLabDiskPath(lab);\n    if (!disk.ok) return disk;\n    const status = labProviderStatus(options);\n    const args = [\n        \"create\",\n        \"-f\", \"qcow2\",\n        \"-F\", source.format,\n        \"-b\", source.path,\n        disk.diskPath,\n    ];\n    if (dryRun) return { ok: true, dryRun: true, command: status.qemuImg || \"qemu-img\", args, providerStatus: status };\n    if (!status.available) return { ok: false, error: \"lab-provider-unsupported\", providerStatus: status };\n    if (!status.qemuImg) return { ok: false, error: \"qemu-img-unavailable\", providerStatus: status };\n    mkdirSync(dirname(disk.diskPath), { recursive: true });\n    const runner = options.commandRunner || ((command, commandArgs, runOptions) => {\n        const result = spawnSync(command, commandArgs, {\n            cwd: runOptions.cwd,\n            env: runOptions.env,\n            encoding: \"utf8\",\n            timeout: runOptions.timeoutMs,\n            maxBuffer: PROVIDER_COMMAND_MAX_BUFFER_BYTES,\n        });\n        return { ok: result.status === 0, status: result.status, stdout: result.stdout, stderr: result.stderr, command, args: commandArgs };\n    });\n    const result = runner(status.qemuImg, args, {\n        cwd: lab.paths.labDir,\n        env: options.env || process.env,\n        timeoutMs: boundedTimeout(options.providerCommandTimeoutMs, DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS),\n    });\n    if (!result?.ok) return { ok: false, error: \"qemu-img-create-failed\", result: publicExecution(result) };\n    return { ok: true, command: status.qemuImg, args, result: publicExecution(result) };\n}\n\nfunction materializeDisk(args = {}, options = {}) {\n    const ctx = context(options);\n    const loaded = readLab(ctx, String(args.labId || \"\"));\n    if (!loaded.ok) return loaded;\n    const lab = loaded.lab;\n    if (lab.runtimeState === \"running\") return { ok: false, error: \"lab-running\", labId: lab.id };\n    const source = validateLabSourceImage(ctx, lab);\n    if (!source.ok) return source;\n    const diskPathResult = validateLabDiskPath(lab);\n    if (!diskPathResult.ok) return diskPathResult;\n    const diskPath = diskPathResult.diskPath;\n    const exists = existsSync(diskPath);\n    if (exists && args.force !== true) {\n        return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), materialized: false, reused: true, diskImage: diskPath };\n    }\n    if (args.dryRun === true) {\n        const planned = qemuImgCreateOverlay(lab, source, options, true);\n        return planned.ok\n            ? { ok: true, ownerId: ctx.owner, dryRun: true, lab: publicLab(lab), materialized: false, diskImage: diskPath, plan: publicExecution(planned) }\n            : planned;\n    }\n    const created = qemuImgCreateOverlay(lab, source, options, false);\n    if (!created.ok) return created;\n    const timestamp = nowIso(options);\n    const diskMetadata = {\n        kind: \"qcow2-overlay\",\n        path: diskPath,\n        backingPath: source.path,\n        backingFormat: source.format,\n        materializedAt: timestamp,\n        forced: args.force === true,\n    };\n    const next = {\n        ...lab,\n        updatedAt: timestamp,\n        image: { ...lab.image, diskImage: diskPath, disk: diskMetadata },\n    };\n    writeLab(ctx, next);\n    return { ok: true, ownerId: ctx.owner, lab: publicLab(next), materialized: true, diskImage: diskPath, disk: diskMetadata, result: created.result };\n}\n\nfunction targetForLab(lab) {\n    const running = lab.runtimeState === \"running\";\n    const latestReadiness = running ? lab.readiness?.latest || null : null;\n    const readiness = running ? safeReadinessState(latestReadiness?.state, \"process-running\") : \"stopped\";\n    const hasGuestSsh = Boolean(lab.guest?.ssh);\n    const hasGuestAgent = Boolean(lab.guest?.agent);\n    return {\n        id: `${lab.id}:vm`,\n        labId: lab.id,\n        name: lab.name,\n        targetKind: \"lab-vm\",\n        provider: lab.provider || PROVIDER_NAME,\n        runtimeState: lab.runtimeState,\n        readiness,\n        sessionState: running && readiness !== \"failed\" ? \"attachable\" : \"unavailable\",\n        attachable: running && readiness !== \"failed\",\n        creatable: false,\n        runtime: publicRuntime(lab.runtime),\n        readinessProbe: latestReadiness,\n        paths: {\n            workspaceDir: lab.paths.workspaceDir,\n            artifactsDir: lab.paths.artifactsDir,\n        },\n        sessionHints: {\n            monitor: running ? \"bounded-monitor-proxy-required\" : \"start-lab-before-opening-monitor-session\",\n            metadata: \"available\",\n            guestSsh: running\n                ? hasGuestSsh ? \"bounded-guest-ssh-session-available\" : \"configure-guest-ssh-before-opening-guest-session\"\n                : \"start-lab-before-opening-guest-session\",\n            guestAgent: running\n                ? hasGuestAgent ? \"bounded-guest-agent-session-available\" : \"configure-guest-agent-before-opening-agent-session\"\n                : \"start-lab-before-opening-agent-session\",\n        },\n    };\n}\n\nfunction publicRuntime(runtime) {\n    if (!runtime || typeof runtime !== \"object\") return null;\n    return {\n        pid: runtime.pid || null,\n        command: runtime.command || null,\n        startedAt: runtime.startedAt || null,\n    };\n}\n\nfunction safeReadinessState(value, fallback = \"process-running\") {\n    return [\"ready\", \"failed\", \"process-running\", \"stopped\"].includes(value) ? value : fallback;\n}\n\nfunction listTargets(args = {}, options = {}) {\n    const ctx = context(options);\n    if (args.labId !== undefined) {\n        const loaded = readLab(ctx, String(args.labId || \"\"));\n        if (!loaded.ok) return loaded;\n        return { ok: true, ownerId: ctx.owner, targets: [targetForLab(loaded.lab)] };\n    }\n    return {\n        ok: true,\n        ownerId: ctx.owner,\n        targets: listLabs(options).labs.map((lab) => targetForLab(lab)),\n    };\n}\n\nfunction boundedTimeout(value, fallback = DEFAULT_GUEST_EXEC_TIMEOUT_MS) {\n    if (value === undefined || value === null || value === \"\") return fallback;\n    const parsed = Number(value);\n    if (!Number.isInteger(parsed) || parsed < 1) return fallback;\n    return Math.min(parsed, MAX_GUEST_EXEC_TIMEOUT_MS);\n}\n";
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
    // The frozen policy sees exactly the same leaf observations as the candidate.
    const original = runInNewContext(ORIGINAL + "\n({listImages,materializeDisk,listTargets})", {
        context: () => ({owner:"owner",ownerRoot:"/owned"}), join, dirname,
        existsSync: (path: string) => path === "/owned/images" ? ports.imagesRootExists() : ports.diskExists(path),
        readdirSync: () => ports.imageEntries(), readJson: (path: string) => ports.readImageMetadata(path.split("/").at(-2)!),
        readLab: (_ctx: unknown,id: string) => ports.readLab(id),
        validateLabSourceImage: (_ctx:unknown,value:typeof lab) => ports.validateImageSource(value.image.sourceImage,value.image.format),
        validateLabDiskPath: ports.validateDiskPath, labProviderStatus: ports.providerStatus,
        mkdirSync: () => ports.ensureDiskParent(lab.image.diskImage),
        publicLab: ports.presentLab, publicExecution: ports.presentExecution,
        nowIso: ports.now, writeLab: (_ctx:unknown,value:typeof lab) => ports.writeLab(value),
        listLabs: () => ({labs:ports.ownerLabs()}),
        PROVIDER_NAME:"container-qemu", DEFAULT_PROVIDER_COMMAND_TIMEOUT_MS:120000,
        DEFAULT_GUEST_EXEC_TIMEOUT_MS:30000, MAX_GUEST_EXEC_TIMEOUT_MS:600000,
        process:{env:{}}, spawnSync:()=>{throw Error("unallocated spawn");},
    }) as {listImages():unknown;materializeDisk(args:Record<string,unknown>,options:Record<string,unknown>):unknown;listTargets(args:Record<string,unknown>):unknown};
    return {trace,fault,lab,state,ports,app:createQemuImageDiskTargetApplication(ports),original};
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("QEMU whole inward image/disk/target policy", () => {
    it("constructs without observing native ports", () => { expect(fixture().trace).toEqual([]); });
    it("omits unreadable metadata and nondirectories while retaining native image order", () => {
        const f=fixture(); expect(plain(f.app.listImages())).toEqual(plain(f.original.listImages()));
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
        expect(plain(f.app.materializeDisk({labId:"unit",force,dryRun:true}))).toEqual(plain(f.original.materializeDisk({labId:"unit",force,dryRun:true},{})));
        expect(f.trace).not.toContain("provider");expect(f.trace).not.toContain("run");expect(f.state.published).toBeUndefined();
    });
    it("dry-run plans after repeated canonical disk validation and never executes or publishes",()=>{
        const f=fixture();const value=f.app.materializeDisk({labId:"unit",dryRun:true});
        expect(plain(value)).toEqual(plain(f.original.materializeDisk({labId:"unit",dryRun:true},{})));
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
    it("looks up the command runner lazily before environment and timeout, preserving its bare receiver",()=>{
        const f=fixture(), native=f.ports.qemuImageRunner;
        Object.defineProperty(f.ports,"qemuImageRunner",{get(){f.trace.push("get-runner");return function(this:Ports){
            expect(this).toBe(f.ports);const run=native.call(f.ports);
            const bare:ReturnType<Ports["qemuImageRunner"]>=function(this:unknown,command,args,options){expect(this).toBeUndefined();return run(command,args,options);};return bare;
        };}});
        Object.defineProperty(f.ports,"providerCommandTimeoutMs",{get(){f.trace.push("timeout");return undefined;}});
        expect(f.trace).toEqual([]);f.app.materializeDisk({labId:"unit"});
        const runnerIndex=f.trace.indexOf("get-runner");expect(f.trace.slice(runnerIndex,runnerIndex+5)).toEqual(["get-runner","runner","env","timeout","run"]);
    });
    it("keeps raw thrown command identity and completed overlay effect on publication failure",()=>{
        const f=fixture();f.state.throws="run";
        let commandFault:unknown;try{f.app.materializeDisk({labId:"unit"});}catch(error){commandFault=error;}expect(commandFault).toBe(f.fault);
        expect(f.trace).not.toContain("write");f.trace.length=0;f.state.throws="write";
        let caught:unknown;try{f.app.materializeDisk({labId:"unit"});}catch(error){caught=error;}
        expect(caught).toBe(f.fault);expect(f.trace.filter(x=>x==="run")).toHaveLength(1);expect(f.trace).not.toContain("rollback");
    });
    it("explicit and all-owner targets stay passive and match immutable original projection",()=>{
        const f=fixture();expect(plain(f.app.listTargets({labId:"unit"}))).toEqual(plain(f.original.listTargets({labId:"unit"})));
        expect(plain(f.app.listTargets())).toEqual(plain(f.original.listTargets({})));
        expect(f.trace).toEqual(["read:unit","read:unit","labs","labs"]);
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

