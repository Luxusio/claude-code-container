export type ContainerSocketAccessProbe =
    | { kind: "usable" }
    | { kind: "requires-group"; user: string; gid: string }
    | { kind: "unavailable" };

export interface ContainerSocketAccessPorts {
    probe(target: string): ContainerSocketAccessProbe;
    grant(target: string, user: string, gid: string): { ok: boolean };
    warn(): undefined;
}
