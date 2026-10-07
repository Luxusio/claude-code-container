import { expect, it } from "vitest";
import { createContainerToolInstallation } from "../../application/tooling/container-installation.js";
import type { ContainerToolInstallationPorts, BubblewrapSession } from "../../ports/tooling/container-installation.js";
import type * as Native from "../../container-setup.js";
function contracts(ports: ContainerToolInstallationPorts<symbol>, session: BubblewrapSession, native: typeof Native) {
    const app = createContainerToolInstallation(ports);
    const effect: undefined = app.ensureClaude("target");
    const legacy: void = native.ensureClaudeInContainer("target");
    // @ts-expect-error Target is required.
    app.ensureUv();
    // @ts-expect-error Opaque probe handle cannot be inspected as string.
    const script: string = ports.prepareClaudeProbe();
    // @ts-expect-error Core operations are synchronous.
    const pending: Promise<unknown> = app.ensureUv("target");
    // @ts-expect-error Preserve historical public void contract.
    const strictNative: undefined = native.ensureUvAvailable("target");
    void [effect, legacy, script, pending, strictNative];
    // @ts-expect-error prepareClaudeProbe required.
    createContainerToolInstallation({ ...ports, prepareClaudeProbe: undefined });
    // @ts-expect-error prepareClaudeProbe readonly.
    ports.prepareClaudeProbe = ports.prepareClaudeProbe;
    // @ts-expect-error prepareClaudeProbe synchronous.
    createContainerToolInstallation({ ...ports, prepareClaudeProbe: async (...args: Parameters<typeof ports.prepareClaudeProbe>) => ports.prepareClaudeProbe(...args) });
    // @ts-expect-error captureClaudeProbe required.
    createContainerToolInstallation({ ...ports, captureClaudeProbe: undefined });
    // @ts-expect-error captureClaudeProbe readonly.
    ports.captureClaudeProbe = ports.captureClaudeProbe;
    // @ts-expect-error captureClaudeProbe synchronous.
    createContainerToolInstallation({ ...ports, captureClaudeProbe: async (...args: Parameters<typeof ports.captureClaudeProbe>) => ports.captureClaudeProbe(...args) });
    // @ts-expect-error captureClaudeInstall required.
    createContainerToolInstallation({ ...ports, captureClaudeInstall: undefined });
    // @ts-expect-error captureClaudeInstall readonly.
    ports.captureClaudeInstall = ports.captureClaudeInstall;
    // @ts-expect-error captureClaudeInstall synchronous.
    createContainerToolInstallation({ ...ports, captureClaudeInstall: async (...args: Parameters<typeof ports.captureClaudeInstall>) => ports.captureClaudeInstall(...args) });
    // @ts-expect-error getNpmTools required.
    createContainerToolInstallation({ ...ports, getNpmTools: undefined });
    // @ts-expect-error getNpmTools readonly.
    ports.getNpmTools = ports.getNpmTools;
    // @ts-expect-error getNpmTools synchronous.
    createContainerToolInstallation({ ...ports, getNpmTools: async (...args: Parameters<typeof ports.getNpmTools>) => ports.getNpmTools(...args) });
    // @ts-expect-error captureNpmProbe required.
    createContainerToolInstallation({ ...ports, captureNpmProbe: undefined });
    // @ts-expect-error captureNpmProbe readonly.
    ports.captureNpmProbe = ports.captureNpmProbe;
    // @ts-expect-error captureNpmProbe synchronous.
    createContainerToolInstallation({ ...ports, captureNpmProbe: async (...args: Parameters<typeof ports.captureNpmProbe>) => ports.captureNpmProbe(...args) });
    // @ts-expect-error captureNpmCachedProbe required.
    createContainerToolInstallation({ ...ports, captureNpmCachedProbe: undefined });
    // @ts-expect-error captureNpmCachedProbe readonly.
    ports.captureNpmCachedProbe = ports.captureNpmCachedProbe;
    // @ts-expect-error captureNpmCachedProbe synchronous.
    createContainerToolInstallation({ ...ports, captureNpmCachedProbe: async (...args: Parameters<typeof ports.captureNpmCachedProbe>) => ports.captureNpmCachedProbe(...args) });
    // @ts-expect-error captureNpmCleanup required.
    createContainerToolInstallation({ ...ports, captureNpmCleanup: undefined });
    // @ts-expect-error captureNpmCleanup readonly.
    ports.captureNpmCleanup = ports.captureNpmCleanup;
    // @ts-expect-error captureNpmCleanup synchronous.
    createContainerToolInstallation({ ...ports, captureNpmCleanup: async (...args: Parameters<typeof ports.captureNpmCleanup>) => ports.captureNpmCleanup(...args) });
    // @ts-expect-error captureNpmShimCleanup required.
    createContainerToolInstallation({ ...ports, captureNpmShimCleanup: undefined });
    // @ts-expect-error captureNpmShimCleanup readonly.
    ports.captureNpmShimCleanup = ports.captureNpmShimCleanup;
    // @ts-expect-error captureNpmShimCleanup synchronous.
    createContainerToolInstallation({ ...ports, captureNpmShimCleanup: async (...args: Parameters<typeof ports.captureNpmShimCleanup>) => ports.captureNpmShimCleanup(...args) });
    // @ts-expect-error captureNpmInstall required.
    createContainerToolInstallation({ ...ports, captureNpmInstall: undefined });
    // @ts-expect-error captureNpmInstall readonly.
    ports.captureNpmInstall = ports.captureNpmInstall;
    // @ts-expect-error captureNpmInstall synchronous.
    createContainerToolInstallation({ ...ports, captureNpmInstall: async (...args: Parameters<typeof ports.captureNpmInstall>) => ports.captureNpmInstall(...args) });
    // @ts-expect-error captureNpmReshim required.
    createContainerToolInstallation({ ...ports, captureNpmReshim: undefined });
    // @ts-expect-error captureNpmReshim readonly.
    ports.captureNpmReshim = ports.captureNpmReshim;
    // @ts-expect-error captureNpmReshim synchronous.
    createContainerToolInstallation({ ...ports, captureNpmReshim: async (...args: Parameters<typeof ports.captureNpmReshim>) => ports.captureNpmReshim(...args) });
    // @ts-expect-error captureNpmWrapper required.
    createContainerToolInstallation({ ...ports, captureNpmWrapper: undefined });
    // @ts-expect-error captureNpmWrapper readonly.
    ports.captureNpmWrapper = ports.captureNpmWrapper;
    // @ts-expect-error captureNpmWrapper synchronous.
    createContainerToolInstallation({ ...ports, captureNpmWrapper: async (...args: Parameters<typeof ports.captureNpmWrapper>) => ports.captureNpmWrapper(...args) });
    // @ts-expect-error createBubblewrapSession required.
    createContainerToolInstallation({ ...ports, createBubblewrapSession: undefined });
    // @ts-expect-error createBubblewrapSession readonly.
    ports.createBubblewrapSession = ports.createBubblewrapSession;
    // @ts-expect-error createBubblewrapSession synchronous.
    createContainerToolInstallation({ ...ports, createBubblewrapSession: async (...args: Parameters<typeof ports.createBubblewrapSession>) => ports.createBubblewrapSession(...args) });
    // @ts-expect-error captureUvProbe required.
    createContainerToolInstallation({ ...ports, captureUvProbe: undefined });
    // @ts-expect-error captureUvProbe readonly.
    ports.captureUvProbe = ports.captureUvProbe;
    // @ts-expect-error captureUvProbe synchronous.
    createContainerToolInstallation({ ...ports, captureUvProbe: async (...args: Parameters<typeof ports.captureUvProbe>) => ports.captureUvProbe(...args) });
    // @ts-expect-error captureUvInstall required.
    createContainerToolInstallation({ ...ports, captureUvInstall: undefined });
    // @ts-expect-error captureUvInstall readonly.
    ports.captureUvInstall = ports.captureUvInstall;
    // @ts-expect-error captureUvInstall synchronous.
    createContainerToolInstallation({ ...ports, captureUvInstall: async (...args: Parameters<typeof ports.captureUvInstall>) => ports.captureUvInstall(...args) });
    // @ts-expect-error reportProbeNotes required.
    createContainerToolInstallation({ ...ports, reportProbeNotes: undefined });
    // @ts-expect-error reportProbeNotes readonly.
    ports.reportProbeNotes = ports.reportProbeNotes;
    // @ts-expect-error reportProbeNotes synchronous.
    createContainerToolInstallation({ ...ports, reportProbeNotes: async (...args: Parameters<typeof ports.reportProbeNotes>) => ports.reportProbeNotes(...args) });
    // @ts-expect-error probeDiagnostic required.
    createContainerToolInstallation({ ...ports, probeDiagnostic: undefined });
    // @ts-expect-error probeDiagnostic readonly.
    ports.probeDiagnostic = ports.probeDiagnostic;
    // @ts-expect-error probeDiagnostic synchronous.
    createContainerToolInstallation({ ...ports, probeDiagnostic: async (...args: Parameters<typeof ports.probeDiagnostic>) => ports.probeDiagnostic(...args) });
    // @ts-expect-error sanitizeForTerminal required.
    createContainerToolInstallation({ ...ports, sanitizeForTerminal: undefined });
    // @ts-expect-error sanitizeForTerminal readonly.
    ports.sanitizeForTerminal = ports.sanitizeForTerminal;
    // @ts-expect-error sanitizeForTerminal synchronous.
    createContainerToolInstallation({ ...ports, sanitizeForTerminal: async (...args: Parameters<typeof ports.sanitizeForTerminal>) => ports.sanitizeForTerminal(...args) });
    // @ts-expect-error captureLog required.
    createContainerToolInstallation({ ...ports, captureLog: undefined });
    // @ts-expect-error captureLog readonly.
    ports.captureLog = ports.captureLog;
    // @ts-expect-error captureLog synchronous.
    createContainerToolInstallation({ ...ports, captureLog: async (...args: Parameters<typeof ports.captureLog>) => ports.captureLog(...args) });
    // @ts-expect-error reportUvProgress required.
    createContainerToolInstallation({ ...ports, reportUvProgress: undefined });
    // @ts-expect-error reportUvProgress readonly.
    ports.reportUvProgress = ports.reportUvProgress;
    // @ts-expect-error reportUvProgress synchronous.
    createContainerToolInstallation({ ...ports, reportUvProgress: async (...args: Parameters<typeof ports.reportUvProgress>) => ports.reportUvProgress(...args) });
    // @ts-expect-error Nested probe readonly.
    session.probe = session.probe;
    // @ts-expect-error Nested probe synchronous.
    const invalidprobe: BubblewrapSession = { ...session, probe: async () => ({status:0}) };
    void invalidprobe;
    // @ts-expect-error Nested updatePackageIndex readonly.
    session.updatePackageIndex = session.updatePackageIndex;
    // @ts-expect-error Nested updatePackageIndex synchronous.
    const invalidupdatePackageIndex: BubblewrapSession = { ...session, updatePackageIndex: async () => ({status:0}) };
    void invalidupdatePackageIndex;
    // @ts-expect-error Nested install readonly.
    session.install = session.install;
    // @ts-expect-error Nested install synchronous.
    const invalidinstall: BubblewrapSession = { ...session, install: async () => ({status:0}) };
    void invalidinstall;
}
void contracts;
it("has four synchronous operation methods without constructor capabilities", () => {
    const ports = new Proxy({} as ContainerToolInstallationPorts<symbol>, {get(){throw new Error("constructor effect");}});
    expect(Object.keys(createContainerToolInstallation(ports))).toHaveLength(4);
});
