import { describe, expect, it } from "vitest";
import { createHostCredentialRefresh } from "../../application/credentials/host-refresh.js";
import type { CredentialCommandObservation, HostCredentialRefreshPorts, SshCredentialCopyFailureStage, SshCredentialCopyObservation } from "../../ports/credentials/host-refresh.js";

function fixture(status?: number | null, exists = true, fault?: string) {
    const rawStatus = arguments.length === 0 ? 0 : status;
    const trace: string[] = [];
    const sentinel = { fault };
    const observe = (name: string) => {
        trace.push(name);
        if (fault === name) throw sentinel;
    };
    const observation = (name: string): CredentialCommandObservation => {
        const richObservation = {
            get status() { observe(`${name}:status`); return rawStatus as number | null; },
            get error() { throw Error("error must remain unread"); },
            get stdout() { throw Error("stdout must remain unread"); },
            get stderr() { throw Error("stderr must remain unread"); },
        };
        return richObservation;
    };
    let ports: HostCredentialRefreshPorts = {
        refreshSsh(target) { expect(this).toBe(ports); observe(`ssh:${target}`); return observation("ssh"); },
        hostSshSourceExists() { expect(this).toBe(ports); observe("ssh:exists"); return exists; },
        hostGitConfigExists() { expect(this).toBe(ports); observe("git:exists"); return exists; },
        stageHostGitConfig(target) { expect(this).toBe(ports); observe(`stage:${target}`); return observation("stage"); },
        installHostGitConfig(target) { expect(this).toBe(ports); observe(`install:${target}`); return observation("install"); },
        reportSshRefreshFailure() { expect(this).toBe(ports); observe("ssh:report"); return undefined; },
        reportGitCopyFailure() { expect(this).toBe(ports); observe("stage:report"); return undefined; },
        reportGitInstallFailure() { expect(this).toBe(ports); observe("install:report"); return undefined; },
    };
    return { get ports() { return ports; }, set ports(value: HostCredentialRefreshPorts) { ports = value; }, trace, sentinel };
}
function caught(action: () => unknown) { try { action(); } catch (error) { return error; } throw Error("Expected exception"); }
describe("host credential refresh policy", () => {
    it("validates all eight required callable ports without effects", () => {
        const f = fixture();
        createHostCredentialRefresh(f.ports);
        for (const key of Object.keys(f.ports)) {
            for (const invalid of [undefined, null, false, 1, "call"])
                expect(() => createHostCredentialRefresh({ ...f.ports, [key]: invalid } as unknown as HostCredentialRefreshPorts)).toThrow();
        }
        expect(f.trace).toEqual([]);
    });
    it.each([0, 1, -1, null, undefined, NaN])("SSH raw status %s runs before conditional source observation", status => {
        for (const exists of [true, false]) {
            const f = fixture(status, exists);
            expect(createHostCredentialRefresh(f.ports).refreshSsh("verified-id")).toBeUndefined();
            expect(f.trace).toEqual(["ssh:verified-id", "ssh:status", ...(status === 0 ? [] : ["ssh:exists", ...(exists ? ["ssh:report"] : [])])]);
        }
    });
    it.each(["staging", "archive-create", "archive-read", "extract", "permissions", "known-hosts", "completion", "publication", undefined] as const)("forwards only the optional SSH failure stage %s after observing the source", stage => {
        const f = fixture(1);
        const report = f.ports.reportSshRefreshFailure;
        const reported: (SshCredentialCopyFailureStage | undefined)[] = [];
        const observation: SshCredentialCopyObservation = {
            get status() { f.trace.push("ssh:status"); return 1; },
            get failureStage() { f.trace.push("ssh:failureStage"); return stage; },
        };
        f.ports = {
            ...f.ports,
            refreshSsh() { f.trace.push("ssh:verified-id"); return observation; },
            reportSshRefreshFailure(value) { reported.push(value); return report.call(f.ports, value); },
        };
        expect(createHostCredentialRefresh(f.ports).refreshSsh("verified-id")).toBeUndefined();
        expect(f.trace).toEqual(["ssh:verified-id", "ssh:status", "ssh:exists", "ssh:failureStage", "ssh:report"]);
        expect(reported).toEqual([stage]);
    });
    it.each([{ status: 0, exists: true }, { status: 1, exists: false }])("leaves failureStage unread for SSH status $status and source-exists $exists", ({ status, exists }) => {
        const f = fixture(status, exists);
        f.ports = {
            ...f.ports,
            refreshSsh() { return { status, get failureStage(): SshCredentialCopyFailureStage { throw Error("failureStage must remain unread"); } }; },
        };
        expect(createHostCredentialRefresh(f.ports).refreshSsh("verified-id")).toBeUndefined();
        expect(f.trace).toEqual(status === 0 ? [] : ["ssh:exists"]);
    });
    it("propagates a failureStage getter exception after the existing source gate", () => {
        const f = fixture(1);
        f.ports = {
            ...f.ports,
            refreshSsh() { return { status: 1, get failureStage(): SshCredentialCopyFailureStage { f.trace.push("ssh:failureStage"); throw f.sentinel; } }; },
        };
        expect(caught(() => createHostCredentialRefresh(f.ports).refreshSsh("verified-id"))).toBe(f.sentinel);
        expect(f.trace).toEqual(["ssh:exists", "ssh:failureStage"]);
    });
    it("missing Git skips both commands", () => {
        const f = fixture(0, false);
        expect(createHostCredentialRefresh(f.ports).syncGit("verified-id")).toBeUndefined();
        expect(f.trace).toEqual(["git:exists"]);
    });
    it.each([0, 1, -1, null, undefined, NaN])("Git stage raw status %s controls install", status => {
        const f = fixture(status);
        expect(createHostCredentialRefresh(f.ports).syncGit("verified-id")).toBeUndefined();
        expect(f.trace).toEqual(["git:exists", "stage:verified-id", "stage:status", ...(status === 0 ? ["install:verified-id", "install:status"] : ["stage:report"])]);
    });
    it.each([1, null, undefined])("reports install failure %s after successful copy", status => {
        const f = fixture(status);
        f.ports = { ...f.ports, stageHostGitConfig: () => ({ status: 0 }) };
        expect(createHostCredentialRefresh(f.ports).syncGit("verified-id")).toBeUndefined();
        expect(f.trace).toEqual(["git:exists", "install:verified-id", "install:status", "install:report"]);
    });
    it.each(["ssh:verified-id", "ssh:status", "ssh:exists", "ssh:report", "git:exists", "stage:verified-id", "stage:status", "stage:report", "install:verified-id", "install:status", "install:report"])("propagates exact thrown value at %s", fault => {
        const f = fixture(1, true, fault);
        if (fault.startsWith("install")) f.ports = { ...f.ports, stageHostGitConfig: () => ({ status: 0 }) };
        const operation = createHostCredentialRefresh(f.ports);
        expect(caught(() => fault.startsWith("ssh") ? operation.refreshSsh("verified-id") : operation.syncGit("verified-id"))).toBe(f.sentinel);
        expect(f.trace.at(-1)).toBe(fault);
    });
});
