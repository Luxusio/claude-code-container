import {describe,expect,it,vi} from "vitest";
import {createContainerExec} from "../../application/container-exec.js";
import type {ContainerExecPorts} from "../../ports/container-exec.js";
import {createDefaultToolCatalog} from "../../domain/tool-registry.js";

function fixture(options:{running?:boolean;replace?:boolean}={}){
    const catalog=createDefaultToolCatalog(),events:string[]=[],entries:Array<[string,string]>=[],dispose=vi.fn(()=>{events.push("dispose");});
    let first=true;
    const ports:ContainerExecPorts={
        ensureRuntime:vi.fn(),resolveProject:()=>"/project/repo",ensureDirectories:vi.fn(),ensureProjectTools:async()=>{},
        projectId:()=>"repo-id",environment:()=>({LANG:"host-lang",TZ:"Host/Zone"}),platform:()=>"linux",terminalReady:()=>false,timezone:()=>"Detected/Zone",runtime:()=>"docker",
        tool:name=>catalog.find(tool=>tool.name===name),defaultTool:()=>catalog[0],
        detectWorktreeBranch:()=>null,assertWorktreeBranch:vi.fn(),
        async familyLock<T>(_id:string,operation:()=>Promise<T>|T):Promise<T>{return operation();},
        acquireOwnership:async()=>({lockFile:"/owned/session.lock",existingId:options.running?"final-id":null}),
        inspectSessionContainer:()=>({known:true,containerId:options.running?"final-id":null}),
        ensureClipboard:async()=>null,clipboardPortFile:()=>"/owned/clipboard.port",readClipboardPort:()=>"4321:token",
        worktreeMounts:()=>[],containerName:()=>"ccc-repo",
        containerStatus:()=>({exists:true,running:Boolean(options.running),containerId:options.running?"final-id":"setup-id",imageId:"image-id"}),
        sessionClaims:()=>["session.lock"],lockName:()=>"session.lock",prepareDeviceBroker:async()=>{},
        lifecycleLock<T>(_prefix:string,operation:()=>T):T{return operation();},
        async setupLock<T>(_prefix:string,operation:()=>Promise<T>|T):Promise<T>{return operation();},
        startContainer:(_path,_ensure,_mounts,_port,_profile,_recreate,_replacement,onReady,_expected,onStarted)=>{
            const id=options.replace&&first?"setup-id":"final-id";first=false;
            if(!options.running)onStarted(id);onReady(id,{startedByInvocation:!options.running});return "ccc-repo";
        },
        setSessionContainer:vi.fn(),setCleanupEnabled:vi.fn(),confirmOwnership:async()=>{},
        configLock<T>(operation:()=>T):T{return operation();},
        restoreConfig:vi.fn(()=>{events.push("restore");}),ensureUv:vi.fn(),buildMcpConfig:vi.fn(async()=>[]),setupProxy:vi.fn(),
        containerRunning:id=>id!=="setup-id",installTools:vi.fn(),ensureClaude:vi.fn(),prepareCodexConfig:vi.fn(),assertCodexState:vi.fn(),ensureCodexHarness:vi.fn(),
        syncClipboard:vi.fn(),ensureSocketAccess:vi.fn(),isRestartRequired:()=>false,isDockerDesktop:()=>false,
        attachClipboardImage:async(_path,args)=>({args}),runRuntimeSync:vi.fn(()=>({stdout:""})),
        forwardedEnvironment:()=>({forwarded:[["LANG","host-lang"],["TZ","Host/Zone"],["MISE_NODE_VERSION","host-node"]],skippedDueToLimit:[]}),
        createEnvironmentFile:vi.fn<ContainerExecPorts["createEnvironmentFile"]>(values=>{entries.push(...values);return {path:"/owned/exec.env",dispose};}),
        prepareCodexLaunch:vi.fn<ContainerExecPorts["prepareCodexLaunch"]>((_runtime,_prefix,command)=>({ok:true,command})),
        recoverCodexCommand:command=>command,runCommand:vi.fn(async()=>0),cleanupSession:vi.fn(()=>{events.push("cleanup");}),
        progress:vi.fn(),log:vi.fn(),error:vi.fn(),warn:vi.fn(),assetDirectory:"/native/assets",claudeBinaryPath:"/home/ccc/.local/bin/claude",containerEnvironment:["container","ccc"],
    };
    return {ports,entries,dispose,events,exec:createContainerExec(ports).exec};
}
describe("container exec application current behavior",()=>{
    it("uses the replacement ID for tool setup, clipboard, socket access and launch",async()=>{
        const f=fixture({replace:true});
        expect(await f.exec("/repo",["codex","resume","--last"])).toBe(0);
        expect(f.ports.installTools).toHaveBeenCalledWith("final-id",expect.objectContaining({name:"codex"}));
        expect(f.ports.prepareCodexConfig).toHaveBeenCalledWith("final-id",undefined);
        expect(f.ports.syncClipboard).toHaveBeenCalledWith("final-id","/native/assets");expect(f.ports.ensureSocketAccess).toHaveBeenCalledWith("final-id");
        const args=vi.mocked(f.ports.runCommand).mock.calls[0][1];expect(args).toContain("final-id");expect(args).not.toContain("setup-id");
    });
    it("reused containers rebuild MCP configuration and receive light setup without the heavy installers",async()=>{
        const f=fixture({running:true});expect(await f.exec("/repo",["codex"])).toBe(0);
        expect(f.ports.ensureUv).not.toHaveBeenCalled();expect(f.ports.setupProxy).not.toHaveBeenCalled();
        expect(f.ports.buildMcpConfig).toHaveBeenCalledWith(undefined,expect.any(Function));
        expect(f.ports.syncClipboard).toHaveBeenCalledWith("final-id","/native/assets");expect(f.ports.ensureSocketAccess).toHaveBeenCalledWith("final-id");
    });
    it("returns Codex preparation failure and cleans its owned artifact without launching",async()=>{
        const f=fixture();vi.mocked(f.ports.prepareCodexLaunch).mockReturnValue({ok:false,command:["codex"],status:9,error:"daemon unavailable"});
        expect(await f.exec("/repo",["codex"])).toBe(9);expect(f.ports.runCommand).not.toHaveBeenCalled();
        expect(f.dispose).toHaveBeenCalled();expect(f.events.slice(-3)).toEqual(["restore","dispose","cleanup"]);
    });
    it("explicit session environment overrides host forwarding and runtime defaults",async()=>{
        const f=fixture();await f.exec("/repo",["claude"],{env:{LANG:"session-lang",TZ:"Session/Zone",MISE_NODE_VERSION:"23",MISE_TRUSTED_CONFIG_PATHS:"/session/project"}});
        expect(Object.fromEntries(f.entries)).toMatchObject({LANG:"session-lang",TZ:"Session/Zone",MISE_NODE_VERSION:"23",MISE_TRUSTED_CONFIG_PATHS:"/session/project"});
        expect(vi.mocked(f.ports.runCommand).mock.calls[0][1]).toEqual(expect.arrayContaining(["--env-file","/owned/exec.env","final-id","/home/ccc/.local/bin/claude"]));
    });
    it("command failure restores configuration, disposes the owned artifact and cleans the session",async()=>{
        const f=fixture(),failure=new Error("command failed");vi.mocked(f.ports.runCommand).mockRejectedValue(failure);
        await expect(f.exec("/repo",["codex"])).rejects.toBe(failure);
        expect(f.events.slice(-3)).toEqual(["restore","dispose","cleanup"]);expect(f.dispose).toHaveBeenCalled();
    });
});
