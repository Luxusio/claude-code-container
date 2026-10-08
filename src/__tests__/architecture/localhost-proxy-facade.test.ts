import * as net from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { proxyConnection, startProxy, stopProxy, tryConnect, PROXY_PORT } from "../../localhost-proxy.js";
import { setupLocalhostProxy } from "../../localhost-proxy-setup.js";

const probe = vi.hoisted(() => ({ runtime: "docker", spawn: vi.fn(), reach: vi.fn(() => ({reachable:false,latencyMs:7})) }));
vi.mock("child_process", () => ({spawnSync:probe.spawn}));
vi.mock("../../container-runtime.js", () => ({runtimeCli:()=>probe.runtime,isContainerHostRemote:()=>true}));
vi.mock("../../network-reach.js", () => ({detectHostNetworkReach:probe.reach}));

const sockets = new Set<net.Socket>(); const servers = new Set<net.Server>();
function track(socket: net.Socket) { sockets.add(socket); return socket; }
async function listen(connection: (socket: net.Socket) => void) {
    const server = net.createServer(socket => connection(track(socket))); servers.add(server);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing private listener");
    return { server, port: address.port };
}
async function vacantPort() { const { server, port } = await listen(() => {}); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); servers.delete(server); return port; }
afterEach(async () => {
    for (const socket of sockets) socket.destroy(); sockets.clear();
    await Promise.all([...servers].map(server => server.listening ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve())); servers.clear();
    vi.restoreAllMocks(); vi.clearAllMocks();
});
it.each([false, true])("actual native Socket forwarding is bidirectional with fallback=%s", async fallback => {
    const received: Buffer[] = []; let remote!: net.Socket;
    const upstream = await listen(socket => { remote = socket; socket.on("data", chunk => { received.push(chunk); socket.write(Buffer.from("reply:" + chunk.toString())); }); });
    const localPort = fallback ? await vacantPort() : upstream.port;
    const proxy = await listen(socket => { void proxyConnection(socket, localPort, "127.0.0.1", "127.0.0.1", upstream.port); });
    const client = track(net.createConnection({ host: "127.0.0.1", port: proxy.port }));
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
    const local = await vacantPort(); const host = await vacantPort();
    const proxy = await listen(socket => { void proxyConnection(socket, local, "127.0.0.1", "127.0.0.1", host); });
    const client = track(net.createConnection({ host: "127.0.0.1", port: proxy.port })); const closed = once(client, "close");
    await closed; expect(client.destroyed).toBe(true);
}, 5000);
it("actual native dial returns the same connected Socket and preserves refusal error", async () => {
    const upstream = await listen(() => {}); const socket = track(await tryConnect("127.0.0.1", upstream.port));
    expect(socket).toBeInstanceOf(net.Socket); expect(socket.remotePort).toBe(upstream.port);
    await expect(tryConnect("127.0.0.1", await vacantPort())).rejects.toMatchObject({ code: "ECONNREFUSED" });
});
it("public start/stop binds an allocated loopback port and refuses missing original metadata", async () => {
    expect(PROXY_PORT).toBe(19999); const server = await startProxy(0); servers.add(server);
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing proxy address");
    expect(address.address).toBe("127.0.0.1"); expect(address.port).toBeGreaterThan(0);
    const client = track(net.createConnection({ host: "127.0.0.1", port: address.port })); await once(client, "close");
    expect(stopProxy(server)).toBeUndefined(); expect(server.listening).toBe(false);
}, 5000);
