/** Caller-owned stream facet; methods keep their original native receivers. */
export interface ForwardingStream<Chunk, Stream> {
    on(event: "data", listener: (chunk: Chunk) => void): Stream;
    on(event: "error" | "close", listener: () => void): Stream;
    removeListener(event: "data", listener: (chunk: Chunk) => void): Stream;
    write(chunk: Chunk): boolean;
    pipe(peer: Stream): Stream;
    destroy(): Stream;
}

export interface LocalhostProxyPorts<Stream> {
    readonly connect: (host: string, port: number) => Promise<Stream>;
}
