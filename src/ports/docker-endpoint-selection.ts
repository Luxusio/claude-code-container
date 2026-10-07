export interface DockerEndpointSelectionPorts {
    readContextOverride(): string | undefined;
    readHostOverride(): string | undefined;
    inspectContextEndpoint(context: string | undefined): string | null;
}
