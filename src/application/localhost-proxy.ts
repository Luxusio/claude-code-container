import { HOST_PROXY_ADDRESS, LOCAL_PROXY_ADDRESS } from "../domain/localhost-proxy.js";
import type { ForwardingStream, LocalhostProxyPorts } from "../ports/localhost-proxy.js";

export function createLocalhostProxy<Chunk, Stream extends ForwardingStream<Chunk, Stream>>(ports: LocalhostProxyPorts<Stream>) {
    const connectionGetter = ports && Object.getOwnPropertyDescriptor(ports, "connect")?.get;
    if (!ports || (!connectionGetter && typeof ports.connect !== "function")) throw new TypeError("Localhost proxy requires connect");
    async function proxyConnection(
        client: Stream, originalPort: number,
        localAddr: string = LOCAL_PROXY_ADDRESS,
        hostAddr: string = HOST_PROXY_ADDRESS,
        hostPort?: number,
    ): Promise<void> {
        const fallbackPort = hostPort ?? originalPort;
        const pendingData: Chunk[] = [];
        const onData = (chunk: Chunk) => pendingData.push(chunk);
        client.on("data", onData);
        let upstream: Stream;
        try { upstream = await ports.connect(localAddr, originalPort); }
        catch {
            try { upstream = await ports.connect(hostAddr, fallbackPort); }
            catch { client.destroy(); return; }
        }
        client.removeListener("data", onData);
        for (const chunk of pendingData) upstream.write(chunk);
        client.pipe(upstream);
        upstream.pipe(client);
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
    }
    return {proxyConnection};
}
