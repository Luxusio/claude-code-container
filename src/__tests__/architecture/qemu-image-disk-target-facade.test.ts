import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const root=path.resolve(import.meta.dirname,"../../.."), facade="packages/device-lab/providers/backends/linux-vm.mjs";
// ORIGINAL Git 720addb4b97a35cac1e862bff7e074e7e2a42319,
// source blob 133299e289a2e76266eb17dc9b6ff7b06741d169.
// Genuine assembled build 64588b1311309bea038e832340058d747498c942:
// source/emission f27fba0d138d2d6390f7076d699a3ec93435a8d9c149a4221cfd3c26bb2a64a9 (105776 bytes).
// Immutable native-body pins were read from Git before extraction. Only unchanged
// authority is pinned; moved policy is exercised below, never hash-whitelisted.
const NATIVE_PINS={
    "context": "12584a34cb2658e5dfb0364b68d8e2be2202e7c96969445406a6d172e33a2c80",
    "readLab": "c415cc578622dde68cee49aa93578951ec5c6a30fb2cf7fb6de7657d2028f75a",
    "validateImageSource": "e8e5cff56848e9ee808622bd495d9a3fa25b655fc249a008e7db94be033c431e",
    "validateLabDiskPath": "eabd9a368cb4924e06b3e1731048269a4e661091cd83bc04aa35159d742b041c",
    "rejectSymlinkAncestors": "dbc01a26b154f6c8400994d9aac445969661d387be4f2e37ae3d5411d53dd060",
    "publicLab": "515eb68641f6015618b05cf3aaf9dfcfcbd209fd3dc85f7d728bba9c9f8486a4",
    "publicExecution": "8af20309080ab393ae9caef2edee960f11eb38bd7f12b97e61613bbd72bdf02e",
    "publicQemuArgs": "a14dc12866031dc100465082bf7d4f76394bcdd156b933fb940b46a491e1a858",
    "writeLab": "9fa06e35214a491f944439b12df9e9861b6125de6d84ce5a681538b5aca1063a",
    "writeJsonAtomically": "ab6c6dba9d9be4de6512c03bdaccf74776ee41717deefdbf40e8c7e24700c53f",
    "listLabs": "3e8c251bb2d06575e3254cec860e12c46c18ec31ce190377270935c39f47f285",
    "linuxVmArgs": "aa57a335c0c86a692cace4956ef187201ded835b8209b938fda955e91ccfdfa3",
    "linuxVmMcpResult": "cdffcc26febf41ffd21c7cae2ddc34d8ec1d907d33c6c5cf6434a6b0143bca5b"
};
const ORIGINAL_NAMESPACE=["DEFAULT_LAB_STATE_DIR","LINUX_VM_BACKEND","LINUX_VM_CAPABILITIES","PROVIDER_NAME","buildQemuArgs","createLab","deleteLab","exportArtifacts","guestAgentProvision","guestAgentStatus","guestExec","guestPull","guestPush","handleLinuxVmManagementTool","handleLinuxVmTool","importImage","inspectLab","labProviderStatus","linuxVmBackend","listImages","listLabs","listLinuxVmDevices","listTargets","materializeDisk","openSession","ownerId","probeReadiness","rebootLab","slug","snapshotLab","startLab","stopLab","syncWorkspace"];
type Api = {
    listImages(options?: object): {ok:boolean;images:unknown[]};
    materializeDisk(args?:object,options?:object): Record<string,unknown>;
    listTargets(args?:object,options?:object): {ok:boolean;targets:Array<Record<string,unknown>>};
    handleLinuxVmManagementTool(name:string,args?:object,options?:object): Promise<{content:Array<{text:string}>;isError?:boolean}|undefined>;
    handleLinuxVmTool(name:string,args?:object,options?:object): Promise<{content:Array<{text:string}>;isError?:boolean}|undefined>;
    [key:string]:unknown;
};
function controlledFacade() {
    const trace:string[]=[], denied:string[]=[], fault={native:"raw sentinel"};
    const home="/fixture/home", stateRoot="/fixture/labs", ownerRoot=stateRoot+"/owners/owner", labDir=ownerRoot+"/labs/unit";
    const sourcePath=ownerRoot+"/images/base/base.raw", diskPath=labDir+"/disks/root.qcow2";
    const environment={CCC_LAB_RUNNER:"1",CCC_LAB_RUNNER_STATUS:"ready",RAW_ENV:"kept"};
    const lab:Record<string,unknown>={id:"unit",name:"Unit",ownerId:"owner",runtimeState:"stopped",image:{sourceImage:sourcePath,format:"raw"},
        runtime:{pid:11,command:"qemu",startedAt:"time",secret:"private"},extra:{raw:true}};
    const files=new Map<string,string>([[labDir+"/lab.json",JSON.stringify(lab)],[sourcePath,"raw"]]);
    const directories=new Set<string>();
    for(const file of files.keys()){let current=path.dirname(file);for(;;){directories.add(current);if(current==="/")break;current=path.dirname(current);}}
    const links=new Set<string>(), writes:string[]=[], commands:Array<{command:string;args:string[];options:Record<string,unknown>}>= [];
    const mode={command:"ok",publication:false};
    const deny=(name:string):never=>{denied.push(name);throw fault;};
    const ordinary=(file:string)=>{if(!file.startsWith("/fixture/") && file!=="/fixture" && file!=="/")return deny("foreign-path:"+file);};
    const fsLeaf={
        existsSync(file:string){ordinary(file);trace.push("exists:"+file);return files.has(file)||directories.has(file)||links.has(file);},
        lstatSync(file:string){ordinary(file);trace.push("stat:"+file);if(!files.has(file)&&!directories.has(file)&&!links.has(file))throw Object.assign(Error("missing"),{code:"ENOENT"});
            return {isFile:()=>files.has(file),isDirectory:()=>directories.has(file),isSymbolicLink:()=>links.has(file),size:files.get(file)?.length||0};},
        readFileSync(file:string){ordinary(file);trace.push("read:"+file);if(!files.has(file))throw Object.assign(Error("missing"),{code:"ENOENT"});return files.get(file)!;},
        readdirSync(file:string){ordinary(file);trace.push("entries:"+file);
            const children=[...directories,...files.keys()].filter(value=>path.dirname(value)===file);
            return children.map(value=>({name:path.basename(value),isDirectory:()=>directories.has(value)}));},
        mkdirSync(file:string){ordinary(file);trace.push("mkdir:"+file);directories.add(file);},
        writeFileSync(file:string,value:string){ordinary(file);trace.push("write:"+file);if(mode.publication)throw fault;files.set(file,value);writes.push(file);},
        renameSync(from:string,to:string){ordinary(from);ordinary(to);trace.push("rename");files.set(to,files.get(from)!);files.delete(from);},
        rmSync(file:string){ordinary(file);trace.push("rm:"+file);files.delete(file);},
    };
    const run=(command:string,args:string[],options:Record<string,unknown>)=>{
        if(command!=="/controlled/qemu-img")return deny("command:"+command);
        commands.push({command,args,options});trace.push("command");
        if(mode.command==="throw")throw fault;
        if(mode.command==="failure")return {ok:false,status:17,stdout:"raw stdout",stderr:"raw stderr",sentinel:fault,args};
        files.set(diskPath,"overlay");return {ok:true,status:0,stdout:"raw stdout",stderr:"raw stderr",args,sentinel:fault};
    };
    const guarded=(name:string,allowed:object)=>new Proxy(allowed,{get(target,key,receiver){
        if(Reflect.has(target,key))return Reflect.get(target,key,receiver);
        return (..._args:unknown[])=>deny(name+"."+String(key));
    }});
    const modules:Record<string,unknown>={
        fs:guarded("fs",fsLeaf),path,os:{homedir:()=>{trace.push("initial-home");return home;}},
        crypto:{randomUUID:()=>{trace.push("uuid");return "frozen-uuid";}},
        child_process:guarded("process",{spawnSync:(command:string,args:string[],options:Record<string,unknown>)=>{
            const result=run(command,args,options);return {...result,status:result.ok?0:17};}}),
        "../context.mjs":{ownerId:()=>deny("implicit-owner")},
        "../responses.mjs":{textResult:(ok:boolean,text:string)=>({content:[{type:"text",text}],isError:!ok})},
        "../state/device-store.mjs":{withOwnerDeviceOperation:(backend:string,id:string,callback:()=>unknown)=>{
            expect(backend).toBe("linux");expect(id).toBe("unit");trace.push("owner-lock");return callback();}},
        "../state/process-identity.mjs":guarded("identity",{}),
        "../file-listing.mjs":guarded("listing",{}),
    };
    const allowed=new Set([facade,"packages/device-lab/providers/application/qemu-image-disk-target.mjs","packages/device-lab/providers/domain/qemu-image-disk-target.mjs",
        "packages/device-lab/providers/ports/qemu-image-disk-target.mjs","device-lab-mcp/src/tools.mjs","device-lab-mcp/src/operation-tools.mjs","device-lab-mcp/src/creation-input.mjs"]);
    const cache=new Map<string,Record<string,unknown>>();
    const load=(file:string):Record<string,unknown>=>{
        if(!allowed.has(file))return deny("source:"+file);
        if(cache.has(file))return cache.get(file)!;
        const exports:Record<string,unknown>={};cache.set(file,exports);
        const compiled=ts.transpileModule(readFileSync(path.join(root,file),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
        runInNewContext(compiled,{exports,require:(name:string)=>{
            if(Object.hasOwn(modules,name))return modules[name];
            if(name.startsWith("."))return load(path.posix.normalize(path.posix.join(path.posix.dirname(file),name)));
            return deny("import:"+name);
        },process:{env:environment,cwd:()=>deny("cwd"),pid:123,kill:()=>deny("kill")},console:guarded("console",{}),Buffer});
        return exports;
    };
    const api=load(facade) as Api;
    // Initialization is separately asserted, before invocation counters reset.
    expect(denied).toEqual([]);expect(trace).toEqual(["initial-home"]);trace.length=0;
    const options={stateRoot,ownerId:"owner",env:environment,qemuPath:"/controlled/qemu",qemuImgPath:"/controlled/qemu-img",kvmAvailable:true,now:"frozen-time",commandRunner:run};
    const update=(changes:Record<string,unknown>)=>{Object.assign(lab,changes);files.set(labDir+"/lab.json",JSON.stringify(lab));};
    const unallocatedRead=()=> (modules.fs as {openSync(file:string):unknown}).openSync("/foreign");
    return {api,options,environment,trace,denied,fault,files,directories,links,writes,commands,mode,lab,labDir,sourcePath,diskPath,ownerRoot,update,load,unallocatedRead};
}
function content(value:{content:Array<{text:string}>}|undefined){expect(value).toBeDefined();return JSON.parse(value!.content[0].text);}

describe("QEMU actual facade, native leaves and legacy routes",()=>{
    it("preserves original namespace/default arities and unchanged native authority",()=>{
        const f=controlledFacade();expect(Object.keys(f.api).sort()).toEqual(ORIGINAL_NAMESPACE);
        for(const name of ["listImages","materializeDisk","listTargets","handleLinuxVmTool","handleLinuxVmManagementTool"])
            expect((f.api[name] as Function).length).toBe(name.startsWith("handle")?1:0);
        const source=readFileSync(path.join(root,facade),"utf8");
        for(const [name,hash]of Object.entries(NATIVE_PINS)){
            const start=source.search(new RegExp("(?:export )?function "+name+"\\("));expect(start).toBeGreaterThanOrEqual(0);
            const end=source.indexOf("\n}\n",start)+3;
            expect(createHash("sha256").update(source.slice(start,end)).digest("hex")).toBe(hash);
        }
        const packageExports=JSON.parse(readFileSync(path.join(root,"packages/device-lab/package.json"),"utf8")).exports;
        expect(packageExports["./providers/*"]).toBe("./providers/*");expect(f.denied).toEqual([]);
    });
    it("lists missing image root without creating it; omits bad records in actual directory order",async()=>{
        const f=controlledFacade(),images=f.ownerRoot+"/images";
        f.directories.delete(images);expect(f.api.listImages(f.options)).toMatchObject({images:[]});expect(f.writes).toEqual([]);
        f.directories.add(images);f.directories.add(images+"/second");f.directories.add(images+"/bad");f.directories.add(images+"/first");
        f.files.set(images+"/second/image.json",'{"id":"second","raw":1}');f.files.set(images+"/bad/image.json","invalid");f.files.set(images+"/first/image.json",'{"id":"first","raw":2}');
        expect(f.api.listImages(f.options).images).toEqual([{id:"second",raw:1},{id:"first",raw:2}]);
        const routed=content(await f.api.handleLinuxVmManagementTool("device_image_list",{backend:"linux-vm"},f.options));
        expect(routed.images).toEqual([{id:"second",raw:1},{id:"first",raw:2}]);expect(f.commands).toEqual([]);expect(f.denied).toEqual([]);
    });
    it("rejects missing/running labs and actual source symlinks before command dispatch",()=>{
        const f=controlledFacade();
        expect(f.api.materializeDisk({labId:"../foreign"},f.options)).toMatchObject({ok:false,error:"invalid-lab-id"});
        expect(f.api.materializeDisk({labId:"missing"},f.options)).toMatchObject({ok:false,error:"lab-not-found"});
        f.update({runtimeState:"running"});expect(f.api.materializeDisk({labId:"unit"},f.options)).toMatchObject({error:"lab-running"});
        f.update({runtimeState:"stopped"});f.links.add(f.sourcePath);
        expect(f.api.materializeDisk({labId:"unit"},f.options)).toMatchObject({error:"source-image-symlink-rejected"});
        f.links.delete(f.sourcePath);f.links.add(f.labDir+"/disks");
        expect(f.api.materializeDisk({labId:"unit"},f.options)).toMatchObject({error:"disk-image-symlink-ancestor-rejected"});
        expect(f.commands).toEqual([]);expect(f.writes).toEqual([]);expect(f.denied).toEqual([]);
    });
    it.each(["missing","outside","foreign-owner","format"])("preserves canonical %s source refusal",mode=>{
        const f=controlledFacade();
        const errors={missing:"source-image-not-found",outside:"source-image-outside-lab-state-root","foreign-owner":"source-image-outside-owner-scope",format:"unsupported-image-format"};
        if(mode==="missing")f.files.delete(f.sourcePath);
        else f.update({image:{sourceImage:mode==="outside"?"/foreign/base.raw":mode==="foreign-owner"?"/fixture/labs/owners/other/base.raw":f.sourcePath,format:mode==="format"?"vmdk":"raw"}});
        expect(f.api.materializeDisk({labId:"unit"},f.options)).toMatchObject({ok:false,error:errors[mode as keyof typeof errors]});
        expect(f.commands).toEqual([]);expect(f.writes).toEqual([]);expect(f.denied).toEqual([]);
    });
    it("preserves strict-force reuse and dry-run without overlay or publication",()=>{
        const f=controlledFacade();f.files.set(f.diskPath,"existing");
        expect(f.api.materializeDisk({labId:"unit",force:"true",dryRun:true},f.options)).toMatchObject({reused:true,materialized:false});
        const dry=f.api.materializeDisk({labId:"unit",force:true,dryRun:true},f.options);
        expect(dry).toMatchObject({dryRun:true,materialized:false,plan:{args:["create","-f","qcow2","-F","raw","-b",f.sourcePath,f.diskPath]}});
        expect(f.commands).toEqual([]);expect(f.writes).toEqual([]);expect(f.denied).toEqual([]);
    });
    it("preserves unsupported and missing executable refusal without native command dispatch",()=>{
        const f=controlledFacade();
        expect(f.api.materializeDisk({labId:"unit"},{...f.options,env:{...f.environment,CCC_LAB_RUNNER_STATUS:"unsupported"}})).toMatchObject({error:"lab-provider-unsupported"});
        expect(f.api.materializeDisk({labId:"unit"},{...f.options,qemuImgPath:""})).toMatchObject({error:"qemu-img-unavailable"});
        expect(f.commands).toEqual([]);expect(f.writes).toEqual([]);expect(f.denied).toEqual([]);
    });
    it("uses the real native spawn adapter with bounded timeout and original environment identity",()=>{
        const f=controlledFacade();const {commandRunner,...nativeOptions}=f.options;void commandRunner;
        expect(f.api.materializeDisk({labId:"unit"},{...nativeOptions,providerCommandTimeoutMs:900000})).toMatchObject({materialized:true});
        expect(f.commands).toHaveLength(1);
        expect(f.commands[0].options).toEqual({cwd:f.labDir,env:f.environment,encoding:"utf8",timeout:600000,maxBuffer:8*1024*1024});
        expect(f.commands[0].options.env).toBe(f.environment);expect(f.denied).toEqual([]);
    });
    it("executes exact native command options before publishing through actual legacy disk handler",async()=>{
        const f=controlledFacade();
        const routed=content(await f.api.handleLinuxVmTool("device_disk_materialize",{backend:"linux-vm",deviceId:"unit"},f.options));
        expect(routed).toMatchObject({ok:true,materialized:true,disk:{forced:false,materializedAt:"frozen-time"}});
        expect(f.commands).toHaveLength(1);const command=f.commands[0];
        expect(command.args).toEqual(["create","-f","qcow2","-F","raw","-b",f.sourcePath,f.diskPath]);
        expect(command.options).toEqual({cwd:f.labDir,env:f.environment,timeoutMs:120000});expect(command.options.env).toBe(f.environment);
        expect(f.trace[0]).toBe("owner-lock");expect(f.trace.indexOf("command")).toBeLessThan(f.trace.findIndex(x=>x.startsWith("write:")));
        expect(JSON.parse(f.files.get(f.labDir+"/lab.json")!)).toMatchObject({extra:{raw:true},image:{disk:{kind:"qcow2-overlay"}}});expect(f.denied).toEqual([]);
    });
    it("preserves failure/throw and successful command partial effect on metadata failure",()=>{
        for(const mode of ["failure","throw","publication"]){
            const f=controlledFacade();if(mode==="publication")f.mode.publication=true;else f.mode.command=mode;
            let result:unknown,caught:unknown;try{result=f.api.materializeDisk({labId:"unit"},f.options);}catch(error){caught=error;}
            if(mode==="failure"){expect(result).toMatchObject({error:"qemu-img-create-failed",result:{status:17,stderr:"raw stderr",stdout:"raw stdout",sentinel:f.fault}});expect(f.files.has(f.diskPath)).toBe(false);}
            else expect(caught).toBe(f.fault);
            if(mode==="publication"){expect(f.files.get(f.diskPath)).toBe("overlay");expect(JSON.parse(f.files.get(f.labDir+"/lab.json")!)).not.toHaveProperty("image.disk");}
            expect(f.commands).toHaveLength(1);expect(f.denied).toEqual([]);
        }
    });
    it("keeps target listing passive through explicit and all-owner legacy routes",async()=>{
        const f=controlledFacade();f.update({runtimeState:"running",readiness:{latest:{state:"failed"}}});
        const explicit=content(await f.api.handleLinuxVmTool("device_target_list",{backend:"linux-vm",deviceId:"unit"},f.options));
        const all=content(await f.api.handleLinuxVmTool("device_target_list",{backend:"linux-vm"},f.options));
        expect(explicit.targets).toHaveLength(1);expect(all.targets).toEqual(explicit.targets);
        expect(explicit.targets[0]).toMatchObject({readiness:"failed",attachable:false,runtime:{pid:11,command:"qemu",startedAt:"time"}});
        expect(explicit.targets[0].runtime).not.toHaveProperty("secret");expect(f.commands).toEqual([]);expect(f.writes).toEqual([]);expect(f.trace).not.toContain("owner-lock");expect(f.denied).toEqual([]);
    });
    it("retains public list_images mapping to its actual handler and rejects omitted disk/target catalog names",async()=>{
        const f=controlledFacade();const catalog=f.load("device-lab-mcp/src/tools.mjs") as {TOOLS:Array<{name:string}>;toolOperation(name:string):string|undefined};
        const names=catalog.TOOLS.map(tool=>tool.name);expect(names).toContain("list_images");
        expect(catalog.toolOperation("list_images")).toBe("device_image_list");
        expect(content(await f.api.handleLinuxVmManagementTool(catalog.toolOperation("list_images")!,{backend:"linux-vm"},f.options))).toMatchObject({images:[]});
        expect(await f.api.handleLinuxVmManagementTool("device_image_list",{backend:"android-emulator"},f.options)).toBeUndefined();
        for(const name of ["disk_materialize","target_list","device_disk_materialize","device_target_list"]){expect(names).not.toContain(name);expect(catalog.toolOperation(name)).toBeUndefined();}
        expect(f.denied).toEqual([]);
    });
    it("counts denied capabilities before thrown and caught failures",()=>{
        const f=controlledFacade();let caught:unknown;try{f.unallocatedRead();}catch(error){caught=error;}
        expect(caught).toBe(f.fault);expect(f.denied).toEqual(["fs.openSync"]);expect(f.commands).toEqual([]);
    });
});

