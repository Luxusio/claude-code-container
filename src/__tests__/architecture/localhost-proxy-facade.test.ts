import * as net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { proxyConnection, startProxy, stopProxy, tryConnect, PROXY_PORT } from "../../localhost-proxy.js";
import { setupLocalhostProxy } from "../../localhost-proxy-setup.js";

const probe = vi.hoisted(() => ({ runtime: "docker", spawn: vi.fn(), reach: vi.fn(() => ({reachable:false,latencyMs:7})) }));
vi.mock("child_process", () => ({spawnSync:probe.spawn}));
vi.mock("../../container-runtime.js", () => ({runtimeCli:()=>probe.runtime,isContainerHostRemote:()=>true}));
vi.mock("../../network-reach.js", () => ({detectHostNetworkReach:probe.reach}));

const sockets = new Set<net.Socket>(); const servers = new Set<net.Server>();
function track(socket: net.Socket) { sockets.add(socket); return socket; }
const fixtureHost = "::1";
const refusalHolders = new Set<() => Promise<void>>();
async function listen(connection: (socket: net.Socket) => void) {
    const server = net.createServer(socket => connection(track(socket))); servers.add(server);
    server.listen(0, fixtureHost); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing private listener");
    return { server, port: address.port };
}
// Keep the exact refusal allocation bound until all native dials finish. A closed
// ephemeral listener is not an owned refusal endpoint, and IPv4 localhost may
// be transparently redirected by the container's existing proxy rules.
const refusalProgram = String.raw`
import socket, sys, os, json, time
root, nonce = sys.argv[1:]
if os.getcwd() != root or not (sys.flags.isolated and sys.flags.no_site):
    raise RuntimeError('invalid private refusal holder startup')
sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
try:
    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
    sock.bind(('::1', 0))
    generation = open('/proc/self/stat').read().split()[21] if sys.platform.startswith('linux') else str(time.monotonic_ns())
    print(json.dumps({'type':'ready','pid':os.getpid(),'pgid':os.getpgid(0) if hasattr(os, 'getpgid') else None,
        'generation':generation,'root':root,'nonce':nonce,'descriptor':sock.fileno(),
        'address':sock.getsockname(),'listening':sock.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN),
        'soError':sock.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR)}), flush=True)
    if sys.stdin.readline().strip() != nonce:
        raise RuntimeError('unauthenticated private refusal holder stop')
    print(json.dumps({'type':'before-close','nonce':nonce,'descriptor':sock.fileno(),
        'soError':sock.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR)}), flush=True)
finally:
    sock.close()
print(json.dumps({'type':'closed','nonce':nonce,'descriptor':sock.fileno()}), flush=True)
`;
interface RefusalReceipt {
    type: string; pid: number; pgid: number | null; generation: string;
    root: string; nonce: string; descriptor: number; address: [string, number, number, number];
    listening: number; soError: number;
}
async function refusalPort() {
    const directory = mkdtempSync(join(tmpdir(), "ccc-proxy-refusal-"));
    const nonce = randomBytes(24).toString("hex");
    const native = await vi.importActual<typeof import("child_process")>("child_process");
    const executable = process.platform === "win32" ? "python" : "/usr/bin/python3";
    const args = ["-I", "-S", "-c", refusalProgram, directory, nonce];
    const options = { cwd: directory, env: {}, stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"] };
    const child = native.spawn(executable, args, options);
    let stdout = "", stderr = "", stopped = false;
    let readyResolve!: (value: RefusalReceipt) => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<RefusalReceipt>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    child.stdout.on("data", chunk => {
        stdout += chunk.toString();
        if (stdout.includes("\n")) {
            try { readyResolve(JSON.parse(stdout.split("\n")[0])); }
            catch (error) { readyReject(error as Error); }
        }
    });
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.stdin.on("error", error => { stderr += `stdin: ${error.message}\n`; readyReject(error); });
    child.on("error", error => readyReject(new Error(`Private IPv6 refusal fixture requires ${executable}: ${error.message}; retained ${directory}`)));
    const joined = new Promise<{code:number|null; signal:NodeJS.Signals|null}>(resolve => child.on("close", (code, signal) => {
        readyReject(new Error(`Private IPv6 refusal holder closed before READY: ${stderr}; retained ${directory}`));
        resolve({code, signal});
    }));
    const stop = async () => {
        if (stopped) return;
        stopped = true;
        child.stdin.end(nonce + "\n");
        const result = await joined;
        writeFileSync(join(directory, "receipt.json"), JSON.stringify({executable,args,options,pid:child.pid,stdout,stderr,result}));
        try {
            expect(result).toEqual({code:0,signal:null}); expect(stderr).toBe("");
            const frames = stdout.trim().split("\n").map(line => JSON.parse(line));
            expect(frames).toHaveLength(3);
            expect(frames[1]).toMatchObject({type:"before-close",nonce,descriptor:frames[0].descriptor,soError:0});
            expect(frames[2]).toEqual({type:"closed",nonce,descriptor:-1});
        } catch (error) { throw new Error(`Private refusal holder cleanup failed; retained ${directory}: ${String(error)}`); }
        refusalHolders.delete(stop);
        rmSync(directory, {recursive:true,force:true});
    };
    refusalHolders.add(stop);
    const receipt = await ready;
    expect(receipt).toMatchObject({type:"ready",pid:child.pid,root:directory,nonce,listening:0,soError:0});
    expect(receipt.descriptor).toBeGreaterThanOrEqual(0);
    expect(receipt.generation).toMatch(/^\d+$/);
    if (process.platform !== "win32") expect(receipt.pgid).toBeGreaterThan(0);
    expect(receipt.address[0]).toBe(fixtureHost); expect(receipt.address[1]).toBeGreaterThan(0);
    return receipt.address[1] as number;
}
afterEach(async () => {
    for (const socket of sockets) socket.destroy(); sockets.clear();
    await Promise.all([...servers].map(server => server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve())); servers.clear();
    await Promise.all([...refusalHolders].map(stop => stop()));
    vi.restoreAllMocks(); vi.clearAllMocks();
});
it.each([false, true])("actual native Socket forwarding is bidirectional with fallback=%s", async fallback => {
    const received: Buffer[] = []; let remote!: net.Socket;
    const upstream = await listen(socket => { remote = socket; socket.on("data", chunk => { received.push(chunk); socket.write(Buffer.from("reply:" + chunk.toString())); }); });
    const localPort = fallback ? await refusalPort() : upstream.port;
    const proxy = await listen(socket => { void proxyConnection(socket, localPort, fixtureHost, fixtureHost, upstream.port); });
    const client = track(net.createConnection({ host: fixtureHost, port: proxy.port }));
    await once(client, "connect"); const response = once(client, "data"); client.write(Buffer.from("raw"));
    expect((await response)[0].toString()).toBe("reply:raw"); expect(Buffer.concat(received).toString()).toBe("raw");
    const unsolicited = once(client, "data"); remote.write(Buffer.from("from-upstream"));
    expect((await unsolicited)[0].toString()).toBe("from-upstream");
}, 5000);

it.each(["docker","podman"])("actual setup selects %s and exact 5000ms proc inspection without any TCP probe", runtime => {
    probe.runtime=runtime; probe.spawn.mockReturnValue({status:0}); const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    setupLocalhostProxy("private-container"); expect(probe.reach).toHaveBeenCalledWith("private-container",{timeoutMs:1500});
    const [command,args,options]=probe.spawn.mock.calls[0]; expect(command).toBe(runtime);
    expect(args.slice(0,4)).toEqual(["exec","private-container","bash","-c"]);
    expect(args[4]).toBe('while read -r slot local_address remote_address state rest; do if [[ "$local_address" == "0100007F:4E1F" && "$state" == "0A" ]]; then exit 0; fi; done < /proc/net/tcp; exit 1');
    expect(options).toEqual({encoding:"utf-8",stdio:["pipe","pipe","pipe"],timeout:5000}); expect(warn).not.toHaveBeenCalled();
});
it.each([
    ["0100007F:4E1F","0A",0], ["00000000:4E1F","0A",1], ["0200007F:4E1F","0A",1],
    ["0100007F:4E20","0A",1], ["0100007F:14E1F","0A",1], ["0100007F:4E1F","01",1],
])("actual production proc script inspects private table %s %s", async (address,state,status) => {
    probe.spawn.mockReturnValue({status:0}); setupLocalhostProxy("private-container");
    const script: string = probe.spawn.mock.calls[0][1][4];
    const actual = await vi.importActual<typeof import("child_process")>("child_process");
    const directory=mkdtempSync(join(tmpdir(),"ccc-proxy-proc-")); const table=join(directory,"tcp");
    try {
        writeFileSync(table,`sl local_address rem_address st rest\n0: ${address} 00000000:0000 ${state} rest\n`);
        const result=actual.spawnSync("/bin/bash",["-c",script.replace("/proc/net/tcp",'"$CCC_PRIVATE_TCP_TABLE"')],{
            encoding:"utf-8",timeout:1000,env:{...process.env,PATH:"",BASH_ENV:"",CCC_PRIVATE_TCP_TABLE:table},
        });
        expect(result.error).toBeUndefined(); expect(result.status).toBe(status); expect(result.stderr).toBe("");
    } finally {rmSync(directory,{recursive:true,force:true});}
});
it.each([{status:127},{status:null,error:new Error("timeout")},{status:0,error:new Error("spawn failure")}])("actual setup warns on native observation failure %o", result => {
    probe.runtime="podman"; probe.spawn.mockReturnValue(result); const warn=vi.spyOn(console,"warn").mockImplementation(()=>{});
    setupLocalhostProxy("private-container"); expect(warn.mock.calls).toEqual([
        ["[ccc] WARNING: localhost proxy daemon not detected — host port access may fail."],
        ["[ccc]   check `podman logs private-container` for entrypoint errors."],
    ]);
});
it("both failed private allocated dials close the actual native client", async () => {
    const local = await refusalPort(); const host = await refusalPort();
    const proxy = await listen(socket => { void proxyConnection(socket, local, fixtureHost, fixtureHost, host); });
    const client = track(net.createConnection({ host: fixtureHost, port: proxy.port })); const closed = once(client, "close");
    await closed; expect(client.destroyed).toBe(true);
}, 5000);
it("actual native dial returns the same connected Socket and preserves refusal error", async () => {
    const upstream = await listen(() => {}); const socket = track(await tryConnect(fixtureHost, upstream.port));
    expect(socket).toBeInstanceOf(net.Socket); expect(socket.remotePort).toBe(upstream.port);
    await expect(tryConnect(fixtureHost, await refusalPort())).rejects.toMatchObject({ code: "ECONNREFUSED" });
});
it("public start/stop binds an allocated loopback port and refuses missing original metadata", async () => {
    expect(PROXY_PORT).toBe(19999); const server = await startProxy(0); servers.add(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing proxy address");
    expect(address.address).toBe("127.0.0.1"); expect(address.port).toBeGreaterThan(0);
    const client = track(net.createConnection({ host: "127.0.0.1", port: address.port })); await once(client, "close");
    expect(stopProxy(server)).toBeUndefined(); expect(server.listening).toBe(false);
}, 5000);
