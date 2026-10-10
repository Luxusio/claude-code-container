import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultToolCatalog, findToolByName, findDefaultTool, getAllCredentialMounts, getNpmTools, type ToolDefinition } from "../../domain/tool-registry.js";

type Registry = typeof import("../../tool-registry.js");

// Restore original descriptors and every nested array even after a failed assertion.
function restoreGraph(root: object): () => void {
    const originals = new Map<object, PropertyDescriptorMap>();
    const capture = (value: object): void => {
        if (originals.has(value)) return;
        const descriptors = Object.getOwnPropertyDescriptors(value);
        originals.set(value, descriptors);
        for (const descriptor of Object.values(descriptors)) {
            if (descriptor.value !== null && typeof descriptor.value === "object") capture(descriptor.value);
        }
    };
    capture(root);
    return () => {
        for (const [value, descriptors] of originals) {
            for (const key of Reflect.ownKeys(value)) {
                if (!Object.prototype.hasOwnProperty.call(descriptors, key)) Reflect.deleteProperty(value, key);
            }
            Object.defineProperties(value, descriptors);
        }
    };
}

async function withRegistry(action: (registry: Registry, catalog: ToolDefinition[]) => void): Promise<void> {
    vi.resetModules();
    const registry = await import("../../tool-registry.js");
    const catalog = registry.getAllTools();
    const restore = restoreGraph(catalog);
    try { action(registry, catalog); } finally { restore(); }
}

afterEach(() => {
    vi.doUnmock("../../container-setup.js");
    vi.doUnmock("child_process");
    vi.doUnmock("node:child_process");
    vi.restoreAllMocks();
    vi.resetModules();
});

describe("actual tool registry compatibility facade", () => {
    it("imports without installer or native dependencies and shares one catalog across all getters", async () => {
        vi.doMock("../../container-setup.js", () => { throw new Error("facade imported installer"); });
        vi.doMock("child_process", () => { throw new Error("facade imported native process"); });
        vi.doMock("node:child_process", () => { throw new Error("facade imported native process"); });
        await withRegistry((registry, catalog) => {
            expect(registry.getAllTools()).toBe(catalog);
            expect(registry.getDefaultTool()).toBe(catalog[0]);
            for (const value of catalog) expect(registry.getToolByName(value.name)).toBe(value);
            expect(registry.getAllCredentialMounts()).toEqual(getAllCredentialMounts(catalog));
            expect(registry.getNpmTools()).toEqual(getNpmTools(catalog));
            const independent = createDefaultToolCatalog();
            expect(independent).toEqual(catalog);
            expect(independent).not.toBe(catalog);
            expect(independent[0]).not.toBe(registry.getDefaultTool());
        });
    });

    it("observes push, splice, reordering, renames and removal through every public query", async () => {
        await withRegistry((registry, catalog) => {
            const added = createDefaultToolCatalog()[1];
            added.name = "custom";
            catalog.push(added);
            expect(registry.getToolByName("custom")).toBe(added);
            expect(registry.getNpmTools().at(-1)).toEqual({ cmd: "custom", pkg: "@google/gemini-cli" });
            expect(registry.getAllCredentialMounts().at(-1)).toBe(added.credentialMounts[0]);
            const duplicate = createDefaultToolCatalog()[1];
            duplicate.name = "custom";
            catalog.unshift(duplicate);
            expect(registry.getToolByName("custom")).toBe(duplicate);
            catalog.reverse();
            expect(registry.getToolByName("custom")).toBe(added);
            const claude = registry.getDefaultTool();
            claude.name = "renamed";
            expect(registry.getDefaultTool()).toBeUndefined();
            expect(registry.getToolByName("renamed")).toBe(claude);
            claude.name = "claude";
            expect(registry.getDefaultTool()).toBe(claude);
            catalog.splice(catalog.indexOf(claude), 1);
            expect(registry.getDefaultTool()).toBeUndefined();
            expect(registry.getToolByName("claude")).toBeUndefined();
            for (const name of ["", "CLAUDE", "missing"]) expect(registry.getToolByName(name)).toBeUndefined();
            expect(registry.getAllTools()).toBe(catalog);
            expect(registry.getToolByName("custom")).toBe(findToolByName(catalog, "custom"));
            expect(registry.getDefaultTool()).toBe(findDefaultTool(catalog));
            catalog.splice(0);
            expect(registry.getAllTools()).toBe(catalog);
            expect(registry.getAllCredentialMounts()).toEqual([]);
            expect(registry.getNpmTools()).toEqual([]);
            expect(registry.getDefaultTool()).toBeUndefined();
        });
    });

    it("preserves fresh projections, shared mount objects and descriptor field mutation", async () => {
        await withRegistry((registry, catalog) => {
            const mounts = registry.getAllCredentialMounts();
            const next = registry.getAllCredentialMounts();
            expect(next).not.toBe(mounts);
            for (let index = 0; index < mounts.length; index++) expect(next[index]).toBe(mounts[index]);
            mounts[0].hostDir = "mutated";
            expect(catalog[0].credentialMounts[0].hostDir).toBe("mutated");
            expect(registry.getAllCredentialMounts()[0].hostDir).toBe("mutated");
            mounts.pop();
            expect(registry.getAllCredentialMounts()).toHaveLength(next.length);
            const npm = registry.getNpmTools(), again = registry.getNpmTools();
            expect(again).not.toBe(npm);
            for (let index = 0; index < npm.length; index++) expect(again[index]).not.toBe(npm[index]);
            npm[0].pkg = "only projection";
            expect(registry.getNpmTools()[0].pkg).toBe("@google/gemini-cli");
            catalog[1].name = "new-name";
            catalog[1].binary = "different-binary";
            catalog[1].installCommand = "npm install -g npm install -g custom";
            expect(registry.getNpmTools()[0]).toEqual({ cmd: "new-name", pkg: "npm install -g custom" });
            catalog[1].installCommand = "npm install -g ";
            expect(registry.getNpmTools()[0].pkg).toBe("");
            catalog[1].installCommand = " npm install -g excluded";
            expect(registry.getNpmTools().some(value => value.cmd === "new-name")).toBe(false);
        });
    });

});
