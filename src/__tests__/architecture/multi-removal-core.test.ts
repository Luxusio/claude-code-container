import { describe, expect, it } from "vitest";
import { createMultiWorkspaceRemoval } from "../../application/workspace/multi-removal.js";
import type { MultiRemovalPorts, MultiRemovalRequest } from "../../ports/workspace/multi-removal.js";
import type { WorkspaceEntry } from "../../domain/workspace/source-entry.js";

const names = ["scanSource", "destinationPath", "pathExists", "assertWorkspaceIdentity", "worktreeMatches", "unmanagedPathRefusal", "captureWorktreeIdentity", "captureRegistration", "removeRegisteredEntry", "scanWorkspace", "captureCopiedIdentity", "quarantineCopiedEntry", "remainingNames", "quarantineWorkspace", "relayEntryError"] as const;
const request: MultiRemovalRequest = { repositoryPath: "source", destinationPath: "workspace", branch: "topic", options: undefined };
const repo: WorkspaceEntry = { name: "repo", path: "source/repo", isGitRepo: true };
const copy: WorkspaceEntry = { name: "copy", path: "source/copy", isGitRepo: false };
function fixture(entries: WorkspaceEntry[] = [repo, copy]) {
    const trace: string[] = [];
    const workspace: symbol = Symbol("workspace"), entry: symbol = Symbol("entry"), registration: symbol = Symbol("registration");
    const existing = new Set(["workspace", ...entries.map(e => `workspace/${e.name}`)]);
    const ports: MultiRemovalPorts<typeof workspace, typeof entry, typeof registration> = {
        scanSource: r => { expect(r).toBe(request); trace.push("source"); return entries; },
        destinationPath: (r, name) => { expect(r).toBe(request); trace.push(`destination:${name}`); return `workspace/${name}`; },
        pathExists: path => { trace.push(`exists:${path}`); return existing.has(path); },
        assertWorkspaceIdentity: (r, identity) => { expect(r).toBe(request); expect(identity).toBe(workspace); trace.push("assert"); },
        worktreeMatches: (source, destination) => { expect(source).toBe(repo.path); expect(destination).toBe("workspace/repo"); trace.push("match"); return true; },
        unmanagedPathRefusal: destination => `unmanaged:${destination}`,
        captureWorktreeIdentity: destination => { expect(destination).toBe("workspace/repo"); trace.push("repo-identity"); return entry; },
        captureRegistration: (r, source, destination, identity) => { expect(r).toBe(request); expect(source).toBe(repo.path); expect(destination).toBe("workspace/repo"); expect(identity).toBe(entry); trace.push("registration"); return registration; },
        removeRegisteredEntry: (r, source, destination, identity, receipt, force) => { expect(r).toBe(request); expect(source).toBe(repo.path); expect(identity).toBe(entry); expect(receipt).toBe(registration); expect(force).toBe(false); trace.push("remove-repo"); existing.delete(destination); },
        scanWorkspace: r => { expect(r).toBe(request); trace.push("scan-workspace"); return []; },
        captureCopiedIdentity: destination => { expect(destination).toBe("workspace/copy"); trace.push("copy-identity"); return entry; },
        quarantineCopiedEntry: (r, destination, identity) => { expect(r).toBe(request); expect(identity).toBe(entry); trace.push("remove-copy"); existing.delete(destination); },
        remainingNames: r => { expect(r).toBe(request); trace.push("remaining"); return []; },
        quarantineWorkspace: (r, identity) => { expect(r).toBe(request); expect(identity).toBe(workspace); trace.push("remove-workspace"); },
        relayEntryError: (name, destination, error) => { trace.push(`relay:${name}:${destination}`); return `${name}:${String(error)}`; },
    };
    return { ports, trace, workspace, entry, registration, existing };
}
describe("multi removal application boundaries", () => {
    it("validates every required port without performing effects", () => {
        const f = fixture(); createMultiWorkspaceRemoval(f.ports); expect(f.trace).toEqual([]);
        for (const name of names) for (const value of [undefined, null, 1, {}]) {
            expect(() => createMultiWorkspaceRemoval({ ...f.ports, [name]: value } as never)).toThrow(new TypeError(`Multi workspace removal requires a callable ${name} port.`));
        }
        expect(f.trace).toEqual([]);
    });
    it("relays opaque identities and original request in source order, publishing mutable results", () => {
        const f = fixture(); const result = createMultiWorkspaceRemoval(f.ports)(request, f.workspace);
        expect(result).toEqual({ removed: ["repo", "copy"], errors: [] });
        expect(f.trace).toEqual(["source", "destination:repo", "exists:workspace/repo", "assert", "match", "repo-identity", "registration", "remove-repo", "destination:copy", "exists:workspace/copy", "assert", "scan-workspace", "copy-identity", "remove-copy", "exists:workspace/copy", "exists:workspace", "assert", "remaining", "remove-workspace"]);
        result.removed.push("mutable"); result.errors = ["mutable"];
    });
    it("skips missing entries before identity or authority observations", () => {
        const f = fixture([repo]); f.existing.clear();
        expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace)).toEqual({ removed: [], errors: [] });
        expect(f.trace).toEqual(["source", "destination:repo", "exists:workspace/repo", "exists:workspace"]);
    });
    it.each(["scanSource", "destinationPath", "pathExists", "assertWorkspaceIdentity", "worktreeMatches", "captureWorktreeIdentity"] as const)("preserves uncaught %s failure identity", name => {
        const f = fixture([repo]); const fault = Object.freeze({ fault: name });
        f.ports = { ...f.ports, [name]: () => { throw fault; } };
        let caught: unknown; try { createMultiWorkspaceRemoval(f.ports)(request, f.workspace); } catch (error) { caught = error; }
        expect(caught).toBe(fault); expect(f.trace).not.toContain("remove-workspace");
    });
    it.each(["captureRegistration", "removeRegisteredEntry"] as const)("relays unknown %s failures and asserts root before returning existing errors", name => {
        const f = fixture([repo]); const fault = Symbol("fault"); let relayed: unknown;
        f.ports = { ...f.ports, [name]: () => { throw fault; }, relayEntryError: (n, destination, error) => { expect(n).toBe("repo"); expect(destination).toBe("workspace/repo"); relayed = error; return "native refusal"; } };
        expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace)).toEqual({ removed: [], errors: ["native refusal"] });
        expect(relayed).toBe(fault); expect(f.trace.slice(-2)).toEqual(["exists:workspace", "assert"]); expect(f.trace).not.toContain("remaining");
    });
    it("lets an error relay failure escape without final cleanup", () => {
        const f = fixture([repo]); const fault = Symbol("relay"); f.ports = { ...f.ports, captureRegistration: () => { throw 0; }, relayEntryError: () => { throw fault; } };
        let caught: unknown; try { createMultiWorkspaceRemoval(f.ports)(request, f.workspace); } catch (e) { caught = e; }
        expect(caught).toBe(fault); expect(f.trace).not.toContain("exists:workspace");
    });
    it("reads the registered force getter inside catch only after registration", () => {
        const f = fixture([repo]); const fault = Symbol("getter"); const observed: string[] = [];
        const r = { ...request, options: { get force(): boolean { observed.push("force"); throw fault; } } };
        const ports = { ...f.ports, scanSource: () => [repo], destinationPath: () => "workspace/repo", assertWorkspaceIdentity: () => {}, captureRegistration: () => { observed.push("registration"); return f.registration; }, relayEntryError: (_n: string, _d: string, e: unknown) => { expect(e).toBe(fault); return "getter failure"; } };
        expect(createMultiWorkspaceRemoval(ports)(r, f.workspace)).toEqual({ removed: [], errors: ["getter failure"] });
        expect(observed).toEqual(["registration", "force"]); expect(f.trace).not.toContain("remove-repo");
    });
    it("keeps unmatched force and refusal failures outside the repo catch", () => {
        for (const failingGetter of [true, false]) {
            const f = fixture([repo]); const fault = Symbol("outside");
            const r = { ...request, options: { get force(): boolean { if (failingGetter) throw fault; return false; } } };
            const ports = { ...f.ports, scanSource: () => [repo], destinationPath: () => "workspace/repo", assertWorkspaceIdentity: () => {}, worktreeMatches: () => false, unmanagedPathRefusal: () => { throw fault; } };
            let caught: unknown; try { createMultiWorkspaceRemoval(ports)(r, f.workspace); } catch (e) { caught = e; }
            expect(caught).toBe(fault); expect(f.trace).not.toContain("exists:workspace");
        }
    });
    it("relays a copied post-quarantine exists failure before publishing removal", () => {
        const f = fixture([copy]); const fault = Symbol("exists"); let count = 0;
        const exists = f.ports.pathExists;
        f.ports = { ...f.ports, pathExists: path => { if (path === "workspace/copy" && count++ === 1) throw fault; return exists(path); }, relayEntryError: (_n, _d, error) => { expect(error).toBe(fault); return "postexists failure"; } };
        expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace)).toEqual({ removed: [], errors: ["postexists failure"] });
        expect(f.trace).not.toContain("remaining");
    });
    it("adds final workspace assertion failures even when entry errors already exist", () => {
        const f = fixture([repo]); let assertions = 0;
        f.ports = { ...f.ports, captureRegistration: () => { throw 0; }, relayEntryError: () => "entry failure", assertWorkspaceIdentity: () => { if (++assertions === 2) throw new Error("root replaced"); } };
        expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace)).toEqual({ removed: [], errors: ["entry failure", "Failed to remove workspace directory: root replaced"] });
        expect(assertions).toBe(2); expect(f.trace).not.toContain("remaining");
    });
    it.each(["assertWorkspaceIdentity", "scanWorkspace", "captureCopiedIdentity", "quarantineCopiedEntry"] as const)("catches copied-entry %s failures", name => {
        const f = fixture([copy]); const fault = {}; let count = 0;
        f.ports = { ...f.ports, [name]: () => { if (count++ === 0) throw fault; }, relayEntryError: (_n, _p, e) => { expect(e).toBe(fault); return "copy failure"; } } as typeof f.ports;
        expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace)).toEqual({ removed: [], errors: ["copy failure"] });
    });
    it("refuses copies becoming repositories and paths recreated after quarantine", () => {
        for (const becameGit of [true, false]) {
            const f = fixture([copy]); f.ports = { ...f.ports, scanWorkspace: () => becameGit ? [{ ...copy, isGitRepo: true }] : [], quarantineCopiedEntry: () => {} };
            expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace)).toEqual({ removed: [], errors: [`copy: ${becameGit ? "became a Git repository before deletion" : "path was recreated during deletion"}`] });
            expect(f.trace).not.toContain("remove-workspace");
        }
    });
    it("uses strict entry force after registration capture, then final truthiness with fresh ordered Git refusal", () => {
        const f = fixture([repo]); const observed: string[] = [];
        const options = { get force() { observed.push("force"); return "truthy" as unknown as boolean; } };
        const r = { ...request, options };
        const ports = { ...f.ports, scanSource: () => [repo], destinationPath: () => "workspace/repo", assertWorkspaceIdentity: () => {}, captureRegistration: () => { observed.push("registration"); return f.registration; }, removeRegisteredEntry: (_r: MultiRemovalRequest, _s: string, destination: string, _i: typeof f.entry, _receipt: typeof f.registration, force: boolean) => { expect(force).toBe(false); f.existing.delete(destination); }, remainingNames: () => ["z", "a"], scanWorkspace: () => [{ ...repo, name: "z" }, { ...repo, name: "a" }] };
        expect(createMultiWorkspaceRemoval(ports)(r, f.workspace)).toEqual({ removed: ["repo"], errors: ["Workspace ownership changed before deletion (z, a)."] });
        expect(observed).toEqual(["registration", "force", "force"]); expect(f.trace).not.toContain("remove-workspace");
    });
    it("unmatched worktrees read strict force outside catch and never capture authority", () => {
        for (const force of [true, false, "truthy"]) {
            const f = fixture([repo]); const r = { ...request, options: { force: force as boolean } };
            const ports = { ...f.ports, scanSource: () => [repo], destinationPath: () => "workspace/repo", assertWorkspaceIdentity: () => {}, worktreeMatches: () => false, remainingNames: () => ["repo"], scanWorkspace: () => [repo] };
            const result = createMultiWorkspaceRemoval(ports)(r, f.workspace);
            expect(result.errors[0]).toBe(force === true ? "Workspace ownership changed before deletion (repo)." : "unmanaged:workspace/repo");
            expect(f.trace).not.toContain("repo-identity");
        }
    });
    it.each([null, undefined])("retains nullish final-catch property-access failure for %s", fault => {
        const f = fixture([]); f.ports = { ...f.ports, remainingNames: () => { throw fault; } };
        expect(() => createMultiWorkspaceRemoval(f.ports)(request, f.workspace)).toThrow(TypeError);
    });
    it("retains final error.message access and ordinary nonempty refusal", () => {
        const f = fixture([]); f.ports = { ...f.ports, remainingNames: () => ["one", "two"] };
        expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace).errors).toEqual(["Workspace directory not empty (2 items remaining). Use -f to force."]);
        f.ports = { ...f.ports, remainingNames: () => { throw "raw"; } };
        expect(createMultiWorkspaceRemoval(f.ports)(request, f.workspace).errors).toEqual(["Failed to remove workspace directory: undefined"]);
    });
});
