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
        let upstream: Stream | undefined;
        let terminated = false;
        const releasePending = () => {
            client.removeListener("data", onData);
            pendingData.length = 0;
        };
        const onClientTerminated = () => {
            terminated = true;
            releasePending();
            upstream?.destroy();
        };
        client.on("data", onData);
        client.on("error", onClientTerminated);
        client.on("close", onClientTerminated);
        if (terminated || client.destroyed) { onClientTerminated(); return; }
        try {
            const connect = ports.connect;
            if (terminated || client.destroyed) { onClientTerminated(); return; }
            upstream = await connect.call(ports, localAddr, originalPort);
        }
        catch {
            if (terminated || client.destroyed) { onClientTerminated(); return; }
            try {
                const connect = ports.connect;
                if (terminated || client.destroyed) { onClientTerminated(); return; }
                upstream = await connect.call(ports, hostAddr, fallbackPort);
            }
            catch {
                releasePending();
                if (!terminated && !client.destroyed) client.destroy();
                return;
            }
        }
        if (terminated || client.destroyed) { onClientTerminated(); return; }
        upstream.on("error", () => client.destroy());
        upstream.on("close", () => client.destroy());
        client.removeListener("data", onData);
        try {
            for (const chunk of pendingData) {
                if (terminated || client.destroyed) { onClientTerminated(); return; }
                upstream.write(chunk);
            }
        }
        finally { pendingData.length = 0; }
        if (terminated || client.destroyed) { onClientTerminated(); return; }
        client.pipe(upstream);
        if (terminated || client.destroyed) { onClientTerminated(); return; }
        upstream.pipe(client);
    }
    return {proxyConnection};
}
