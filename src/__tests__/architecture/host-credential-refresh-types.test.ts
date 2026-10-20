import { describe, expect, it } from "vitest";
import { createHostCredentialRefresh } from "../../application/credentials/host-refresh.js";
import { createNativeHostCredentialRefreshPorts } from "../../adapters/credentials/host-refresh.js";
import type { CredentialCommandObservation, HostCredentialRefreshPorts, SshCredentialCopyFailureStage, SshCredentialCopyObservation } from "../../ports/credentials/host-refresh.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function contracts(ports: HostCredentialRefreshPorts, observation: CredentialCommandObservation, sshObservation: SshCredentialCopyObservation) {
    const refresh = createHostCredentialRefresh(ports);
    const proof: [
        Equal<keyof HostCredentialRefreshPorts, "refreshSsh" | "hostSshSourceExists" | "hostGitConfigExists" | "stageHostGitConfig" | "installHostGitConfig" | "reportSshRefreshFailure" | "reportGitCopyFailure" | "reportGitInstallFailure">,
        Equal<keyof CredentialCommandObservation, "status">,
        Equal<typeof observation.status, number | null>,
        Equal<ReturnType<typeof refresh.refreshSsh>, undefined>,
        Equal<ReturnType<typeof refresh.syncGit>, undefined>,
        Equal<ReturnType<typeof ports.refreshSsh>, SshCredentialCopyObservation>,
        Equal<ReturnType<typeof ports.stageHostGitConfig>, CredentialCommandObservation>,
        Equal<ReturnType<typeof ports.installHostGitConfig>, CredentialCommandObservation>,
        Equal<ReturnType<typeof ports.reportSshRefreshFailure>, undefined>,
        Equal<ReturnType<typeof createNativeHostCredentialRefreshPorts>, HostCredentialRefreshPorts>,
        Equal<keyof SshCredentialCopyObservation, "status" | "failureStage">,
        Equal<typeof sshObservation.failureStage, SshCredentialCopyFailureStage | undefined>,
        Equal<SshCredentialCopyFailureStage, "staging" | "archive-create" | "archive-read" | "extract" | "permissions" | "known-hosts" | "completion" | "publication">,
        Equal<Parameters<typeof ports.reportSshRefreshFailure>, [stage?: SshCredentialCopyFailureStage]>,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true];
    void proof;
    const statusOnlySsh: SshCredentialCopyObservation = observation;
    const statusOnlyGit: CredentialCommandObservation = sshObservation;
    void statusOnlySsh; void statusOnlyGit;
    ports.reportSshRefreshFailure();
    ports.reportSshRefreshFailure("permissions");
    // @ts-expect-error Failure stages are closed, not arbitrary diagnostic text.
    ports.reportSshRefreshFailure("permission denied at /host/private-key");
    // @ts-expect-error SSH failure stages cannot leak into the Git observation contract.
    const gitWithStage: CredentialCommandObservation = { status: 1, failureStage: "permissions" };
    void gitWithStage;
    // @ts-expect-error Unknown failure stages cannot enter SSH observations.
    const unknownStage: SshCredentialCopyObservation = { status: 1, failureStage: "unknown" };
    void unknownStage;
    // @ts-expect-error Failure stage is readonly.
    sshObservation.failureStage = "publication";
    // @ts-expect-error Raw diagnostic output is not part of the SSH observation contract.
    sshObservation.stderr;
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
