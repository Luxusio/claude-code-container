import { describe, expect, it } from "vitest";
import { createHostCredentialRefresh } from "../../application/credentials/host-refresh.js";
import { createNativeHostCredentialRefreshPorts } from "../../adapters/credentials/host-refresh.js";
import type { CredentialCommandObservation, HostCredentialRefreshPorts } from "../../ports/credentials/host-refresh.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function contracts(ports: HostCredentialRefreshPorts, observation: CredentialCommandObservation) {
    const refresh = createHostCredentialRefresh(ports);
    const proof: [Equal<keyof HostCredentialRefreshPorts, "refreshSsh" | "hostSshSourceExists" | "hostGitConfigExists" | "stageHostGitConfig" | "installHostGitConfig" | "reportSshRefreshFailure" | "reportGitCopyFailure" | "reportGitInstallFailure">, Equal<keyof CredentialCommandObservation, "status">, Equal<typeof observation.status, number | null>, Equal<ReturnType<typeof refresh.refreshSsh>, undefined>, Equal<ReturnType<typeof refresh.syncGit>, undefined>, Equal<ReturnType<typeof ports.refreshSsh>, CredentialCommandObservation>, Equal<ReturnType<typeof ports.stageHostGitConfig>, CredentialCommandObservation>, Equal<ReturnType<typeof ports.installHostGitConfig>, CredentialCommandObservation>, Equal<ReturnType<typeof ports.reportSshRefreshFailure>, undefined>, Equal<ReturnType<typeof createNativeHostCredentialRefreshPorts>, HostCredentialRefreshPorts>] = [true, true, true, true, true, true, true, true, true, true];
    void proof;
    // @ts-expect-error All eight ports are required.
    createHostCredentialRefresh({});
    // @ts-expect-error Target is required.
    refresh.refreshSsh();
    // @ts-expect-error Target is required.
    refresh.syncGit();
    // @ts-expect-error Runtime selector is required.
    createNativeHostCredentialRefreshPorts();
    // @ts-expect-error Runtime selector is synchronous.
    createNativeHostCredentialRefreshPorts(async () => "docker");
    // @ts-expect-error Status has no undefined contract.
    const invalid: CredentialCommandObservation = { status: undefined };
    void invalid;
    // @ts-expect-error Status is readonly.
    observation.status = 0;
    // @ts-expect-error Ports are readonly.
    ports.refreshSsh = () => ({ status: 0 });
    // @ts-expect-error Ports are readonly.
    ports.hostSshSourceExists = () => false;
    // @ts-expect-error Ports are readonly.
    ports.hostGitConfigExists = () => false;
    // @ts-expect-error Ports are readonly.
    ports.stageHostGitConfig = () => ({ status: 0 });
    // @ts-expect-error Ports are readonly.
    ports.installHostGitConfig = () => ({ status: 0 });
    // @ts-expect-error Ports are readonly.
    ports.reportSshRefreshFailure = () => undefined;
    // @ts-expect-error Ports are readonly.
    ports.reportGitCopyFailure = () => undefined;
    // @ts-expect-error Ports are readonly.
    ports.reportGitInstallFailure = () => undefined;
    createHostCredentialRefresh({ ...ports,
        // @ts-expect-error Commands must be synchronous.
        refreshSsh: async () => ({ status: 0 }) });
    createHostCredentialRefresh({ ...ports,
        // @ts-expect-error Reports must be synchronous undefined, not Promise<void>.
        reportGitInstallFailure: async () => {} });
    createHostCredentialRefresh({ ...ports,
        // @ts-expect-error Existence must be synchronous.
        hostGitConfigExists: async () => false });
}
void contracts;
describe("host refresh synchronous type contract", () => {
    it("returns undefined for both operations", () => {
        const refresh = createHostCredentialRefresh({ refreshSsh: () => ({ status: 0 }), hostSshSourceExists: () => false, hostGitConfigExists: () => false, stageHostGitConfig: () => ({ status: 0 }), installHostGitConfig: () => ({ status: 0 }), reportSshRefreshFailure: () => undefined, reportGitCopyFailure: () => undefined, reportGitInstallFailure: () => undefined });
        expect(refresh.refreshSsh("verified")).toBeUndefined();
        expect(refresh.syncGit("verified")).toBeUndefined();
    });
});
