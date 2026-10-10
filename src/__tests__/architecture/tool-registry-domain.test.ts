import { describe, expect, it } from "vitest";
import { createDefaultToolCatalog, findToolByName, findDefaultTool, getAllCredentialMounts, getNpmTools, type ToolDefinition } from "../../domain/tool-registry.js";

function tool(name: string, installCommand = "other installer"): ToolDefinition {
    return { name, displayName: name, binary: `binary-${name}`, defaultFlags: [],
        credentialMounts: [], needsNodeRuntime: false, updateCommand: [], installCommand };
}

function expectFreshGraph(first: unknown, second: unknown): void {
    expect(first).toEqual(second);
    if (first !== null && typeof first === "object") {
        expect(first).not.toBe(second);
        for (const key of Object.keys(first)) {
            expectFreshGraph((first as Record<string, unknown>)[key],
                (second as Record<string, unknown>)[key]);
        }
    }
}

describe("explicit tool catalog domain", () => {
    it("constructs deeply independent default graphs with preserved optional metadata", () => {
        const first = createDefaultToolCatalog();
        const second = createDefaultToolCatalog();
        expectFreshGraph(first, second);
        expect(first.map(value => value.name)).toEqual(["claude", "gemini", "codex", "opencode"]);
        const before = structuredClone(second);
        for (const value of first) {
            value.name = "changed";
            value.defaultFlags.push("changed");
            value.updateCommand.push("changed");
            value.credentialMounts[0].hostDir = "changed";
            value.credentialMounts.push({ hostDir: "new", containerDir: "/new" });
            value.subcommands?.push("changed");
            value.subcommandsAcceptingDefaultFlags?.push("changed");
        }
        first.splice(0, 1);
        expect(second).toEqual(before);
        expect(createDefaultToolCatalog()).toEqual(before);
    });

    it("selects only from the supplied catalog and observes order and mutations", () => {
        const first = tool("duplicate"), last = tool("duplicate"), claude = tool("claude");
        const catalog = [first, claude, last];
        expect(findToolByName(catalog, "duplicate")).toBe(first);
        expect(findDefaultTool(catalog)).toBe(claude);
        expect(findToolByName([], "claude")).toBeUndefined();
        expect(findDefaultTool([])).toBeUndefined();
        for (const name of ["", "CLAUDE", "unknown"]) expect(findToolByName(catalog, name)).toBeUndefined();
        catalog.reverse();
        expect(findToolByName(catalog, "duplicate")).toBe(last);
        claude.name = "renamed";
        expect(findDefaultTool(catalog)).toBeUndefined();
        expect(findToolByName(catalog, "renamed")).toBe(claude);
        catalog.push(tool("claude"));
        expect(findDefaultTool(catalog)).toBe(catalog[3]);
        const anotherClaude = tool("claude");
        catalog.unshift(anotherClaude);
        expect(findDefaultTool(catalog)).toBe(anotherClaude);
    });

    it("flattens mounts in catalog order with fresh arrays and shared mount identities", () => {
        const first = tool("one"), second = tool("two");
        const mount = { hostDir: "relative", containerDir: "/absolute" };
        const other = { hostDir: "other", containerDir: "/other" };
        first.credentialMounts = [mount, other]; second.credentialMounts = [mount];
        const catalog = [first, second];
        const mounts = getAllCredentialMounts(catalog);
        expect(mounts).toEqual([mount, other, mount]);
        expect(mounts[0]).toBe(mount); expect(mounts[1]).toBe(other); expect(mounts[2]).toBe(mount);
        expect(getAllCredentialMounts(catalog)).not.toBe(mounts);
        mounts.pop();
        expect(second.credentialMounts).toEqual([mount]);
        mount.hostDir = "changed";
        expect(getAllCredentialMounts(catalog)[2].hostDir).toBe("changed");
        expect(getAllCredentialMounts([])).toEqual([]);
        catalog.reverse();
        expect(getAllCredentialMounts(catalog)).toEqual([mount, mount, other]);
    });

    it("projects exact npm prefixes and name rather than binary without mutating input", () => {
        const catalog = [tool("a", "npm install -g package"), tool("b", " npm install -g ignored"),
            tool("c", "npm install -g "), tool("d", "npm install -g npm install -g twice"),
            tool("e", "npm install -g"), tool("f", "NPM install -g ignored"), tool("g", "echo npm install -g ignored")];
        const before = structuredClone(catalog);
        const projected = getNpmTools(catalog);
        expect(projected).toEqual([{ cmd: "a", pkg: "package" }, { cmd: "c", pkg: "" },
            { cmd: "d", pkg: "npm install -g twice" }]);
        expect(catalog).toEqual(before);
        const again = getNpmTools(catalog);
        expect(again).not.toBe(projected);
        for (let index = 0; index < again.length; index++) expect(again[index]).not.toBe(projected[index]);
        projected[0].pkg = "changed";
        expect(getNpmTools(catalog)[0].pkg).toBe("package");
        expect(getNpmTools([])).toEqual([]);
    });

});
