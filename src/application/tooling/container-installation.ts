import type { ToolDefinition } from "../../domain/tool-registry.js";
import type { ContainerToolInstallationPorts, ContainerToolObservation } from "../../ports/tooling/container-installation.js";

function assertMutationSucceeded(result: ContainerToolObservation, operation: string): void {
    const timedOut = (result.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT"
        || result.status === 124
        || result.status === 137;
    if (timedOut) throw new Error(`${operation} timed out`);
    if (result.error || result.status !== 0) throw new Error(`${operation} failed`);
}

export function createContainerToolInstallation<ProbeHandle>(ports: ContainerToolInstallationPorts<ProbeHandle>) {
    function ensureClaude(target: string): undefined {
        const probe = ports.prepareClaudeProbe();
        const result = ports.captureClaudeProbe()(target, probe);
        if ((result.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT"
            || result.status === 124 || result.status === 137) throw new Error("Claude readiness probe timed out");
        if (result.error || result.status !== 0) throw new Error(`Claude readiness probe failed${ports.probeDiagnostic(result.stderr)}`);
        const status = (result.stdout ?? "").trim();
        const reported = new Set<string>();
        ports.reportProbeNotes(result.stderr, reported);
        if (status === "VALID") return;
        if (status.startsWith("RESTORED")) {
            const version = ports.sanitizeForTerminal(status.slice("RESTORED".length).trim());
            ports.captureLog()(version ? `Reusing claude ${version} from the shared volume.` : "Reusing claude from the shared volume.");
            return;
        }
        if (status !== "INSTALL") throw new Error("Claude readiness probe returned an invalid result");
        ports.captureLog()("Installing claude (first run)...");
        const installed = ports.captureClaudeInstall()(target);
        assertMutationSucceeded(installed, "Claude installation");
        const confirm = ports.captureClaudeProbe()(target, probe);
        const confirmStatus = (confirm.stdout ?? "").trim();
        if (confirm.error || confirm.status !== 0
            || (confirmStatus !== "VALID" && !confirmStatus.startsWith("RESTORED"))) {
            throw new Error(`Claude installation left no usable launcher${ports.probeDiagnostic(confirm.stderr)}`);
        }
        ports.reportProbeNotes(confirm.stderr, reported);
    }

    function ensureNpm(target: string, activeTool: ToolDefinition): undefined {
        const configuredBinary = activeTool.binary || activeTool.name;
        const tool = ports.getNpmTools().find(candidate => candidate.cmd === activeTool.name || candidate.cmd === configuredBinary);
        if (!tool) throw new Error(`Requested tool ${activeTool.name} has no npm installation definition`);
        const checkResult = ports.captureNpmProbe()(target, tool);
        if ((checkResult.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT") throw new Error("Container npm tool probe timed out");
        if (checkResult.error || checkResult.status !== 0) throw new Error("Container npm tool probe failed");
        if ((checkResult.stdout ?? "").trim() !== tool.cmd) return;
        const cached = ports.captureNpmCachedProbe()(target, tool);
        assertMutationSucceeded(cached, `Container ${tool.cmd} cached executable probe`);
        const cachedState = cached.stdout.trim();
        if (cachedState !== "READY" && cachedState !== "MISSING") throw new Error(`Container ${tool.cmd} cached executable probe returned an invalid result`);
        if (cachedState === "MISSING") {
            ports.captureLog()(`Installing ${tool.cmd}...`);
            const name = tool.pkg.split("/").pop();
            const scope = tool.pkg.includes("/") ? tool.pkg.split("/")[0] + "/" : "";
            const cleanupPattern = `"$gdir/${scope}.${name}-"*`;
            const cleaned = ports.captureNpmCleanup()(target, cleanupPattern);
            assertMutationSucceeded(cleaned, `Container ${tool.cmd} cleanup`);
            const shimCleaned = ports.captureNpmShimCleanup()(target, tool);
            assertMutationSucceeded(shimCleaned, `Container ${tool.cmd} shim cleanup`);
            const installed = ports.captureNpmInstall()(target, tool);
            assertMutationSucceeded(installed, `Container ${tool.cmd} installation`);
            const reshimmed = ports.captureNpmReshim()(target);
            assertMutationSucceeded(reshimmed, `Container ${tool.cmd} reshim`);
        }
        const wrapper = ports.captureNpmWrapper()(target, tool);
        assertMutationSucceeded(wrapper, `Container ${tool.cmd} wrapper creation`);
    }

    function ensureCodexBubblewrap(target: string): undefined {
        const session = ports.createBubblewrapSession(target);
        const existing = session.probe();
        if (existing.error || existing.status !== 42) {
            assertMutationSucceeded(existing, "Codex bubblewrap readiness probe");
            return;
        }
        ports.captureLog()("Installing bubblewrap for Codex...");
        const update = session.updatePackageIndex();
        assertMutationSucceeded(update, "Codex bubblewrap package index update");
        const install = session.install();
        assertMutationSucceeded(install, "Codex bubblewrap installation");
        assertMutationSucceeded(session.probe(), "Codex bubblewrap readiness check after installation");
    }

    function ensureUv(target: string): undefined {
        const checkResult = ports.captureUvProbe()(target);
        if ((checkResult.error as { code?: unknown } | undefined)?.code === "ETIMEDOUT") throw new Error("Container uv probe timed out");
        if (checkResult.error || (checkResult.status !== 0 && checkResult.status !== 1)) throw new Error("Container uv probe failed");
        if (checkResult.status === 0) return;
        ports.reportUvProgress();
        const installed = ports.captureUvInstall()(target);
        assertMutationSucceeded(installed, "Container uv installation");
    }
    return { ensureClaude, ensureNpm, ensureCodexBubblewrap, ensureUv };
}
