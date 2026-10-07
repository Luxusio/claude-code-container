import { describe, expect, expectTypeOf, it } from "vitest";
import { createHostCredentialPaths } from "../../application/credentials/host-paths.js";
import type { HostCredentialPathPorts, CredentialDirectoryOptions } from "../../ports/credentials/host-paths.js";
import type { CredentialMount } from "../../domain/tool-registry.js";
import type * as facade from "../../docker.js";

function contracts(ports: HostCredentialPathPorts, mount: CredentialMount, publicApi: typeof facade) {
    type Names = "readContainerEnvironment" | "readVitestEnvironment" | "claudeProfilePath" | "codexProfilePath" | "homeDirectory" | "joinHostPath" | "createDirectory" | "packageParentPath" | "packageBasename";
    expectTypeOf<keyof HostCredentialPathPorts>().toEqualTypeOf<Names>();
    expectTypeOf<HostCredentialPathPorts>().toEqualTypeOf<Readonly<HostCredentialPathPorts>>();
    expectTypeOf<HostCredentialPathPorts>().toEqualTypeOf<Required<HostCredentialPathPorts>>();
    expectTypeOf<CredentialDirectoryOptions>().toEqualTypeOf<{ readonly recursive: true; readonly mode?: number }>();
    expectTypeOf<HostCredentialPathPorts["createDirectory"]>().toEqualTypeOf<(path: string, options: CredentialDirectoryOptions) => undefined>();
    expectTypeOf<HostCredentialPathPorts["readContainerEnvironment"]>().toEqualTypeOf<() => string | undefined>();
    expectTypeOf<HostCredentialPathPorts["readVitestEnvironment"]>().toEqualTypeOf<() => string | undefined>();
    expectTypeOf<HostCredentialPathPorts["claudeProfilePath"]>().toEqualTypeOf<(profile?: string) => string>();
    expectTypeOf<HostCredentialPathPorts["codexProfilePath"]>().toEqualTypeOf<(profile?: string) => string>();
    expectTypeOf<HostCredentialPathPorts["homeDirectory"]>().toEqualTypeOf<() => string>();
    expectTypeOf<HostCredentialPathPorts["joinHostPath"]>().toEqualTypeOf<(base: string, relative: string) => string>();
    expectTypeOf<HostCredentialPathPorts["packageParentPath"]>().toEqualTypeOf<(path: string) => string>();
    expectTypeOf<HostCredentialPathPorts["packageBasename"]>().toEqualTypeOf<(path: string) => string>();
    const api = createHostCredentialPaths(ports, "/packages");
    expectTypeOf(api.resolveCredentialHostPath).toEqualTypeOf<(mount: CredentialMount, profile?: string) => string>();
    expectTypeOf(api.ensureCredentialHostDir).toEqualTypeOf<typeof api.resolveCredentialHostPath>();
    expectTypeOf(publicApi.resolveCredentialHostPath).toEqualTypeOf<typeof api.resolveCredentialHostPath>();
    expectTypeOf(publicApi.ensureCredentialHostDir).toEqualTypeOf<typeof api.ensureCredentialHostDir>();
    api.resolveCredentialHostPath(mount); api.ensureCredentialHostDir(mount, "work");
    // @ts-expect-error Both construction inputs are required.
    createHostCredentialPaths(ports);
    // @ts-expect-error Package data is a required string.
    createHostCredentialPaths(ports, undefined);
    // @ts-expect-error No async filesystem capability.
    createHostCredentialPaths({ ...ports, createDirectory: async () => undefined }, "/packages");
    // @ts-expect-error No async environment capability.
    createHostCredentialPaths({ ...ports, readContainerEnvironment: async () => "docker" }, "/packages");
    // @ts-expect-error Every port is required.
    createHostCredentialPaths({}, "/packages");
    // @ts-expect-error Ports are readonly.
    ports.homeDirectory = () => "/replacement";
    // @ts-expect-error Recursive must be the true literal.
    const options: CredentialDirectoryOptions = { recursive: false };
    void options;
}
void contracts;
describe("host credential types", () => {
    it("retains an explicit two-input factory", () => { expect(createHostCredentialPaths.length).toBe(2); });
});
