import type { ToolDefinition } from "../../domain/tool-registry.js";
import type { ContainerToolEffect, ContainerToolInstallationPorts, ContainerToolMutation } from "../../ports/tooling/container-installation.js";

export function createContainerToolInstallation<ProbeHandle, Evidence>(ports: ContainerToolInstallationPorts<ProbeHandle, Evidence>) {
    function requireMutation(result: ContainerToolEffect<Evidence>, mutation: ContainerToolMutation, command?: string): void {
        if (result.kind === "failed") {
            ports.fail({ kind: "mutation-failed", mutation, reason: result.reason, ...(command === undefined ? {} : { command }) }, result.evidence);
        }
    }

    function ensureClaude(target: string): undefined {
        const probe = ports.prepareClaudeProbe();
        const result = ports.probeClaude(target, probe);
        switch (result.kind) {
            case "failed":
                return ports.fail({ kind: "claude-probe-failed", reason: result.reason }, result.evidence);
            case "invalid":
                return ports.fail({ kind: "claude-probe-invalid" });
            case "valid":
                return;
            case "restored":
                ports.report({ kind: "claude-restored", version: result.version });
                return;
            case "install-needed": {
                ports.report({ kind: "claude-installing" });
                requireMutation(ports.installClaude(target), "claude-install");
                const confirmation = ports.confirmClaude(target, probe);
                if (confirmation.kind === "unusable") {
                    ports.fail({ kind: "claude-confirmation-failed" }, confirmation.evidence);
                }
                return;
            }
        }
    }

    function ensureNpm(target: string, activeTool: ToolDefinition): undefined {
        const configuredBinary = activeTool.binary || activeTool.name;
        const tool = ports.getNpmTools().find(candidate => candidate.cmd === activeTool.name || candidate.cmd === configuredBinary);
        if (!tool) return ports.fail({ kind: "npm-definition-missing", toolName: activeTool.name });
        const wrapper = ports.probeNpmWrapper(target, tool);
        if (wrapper.kind === "failed") return ports.fail({ kind: "npm-wrapper-failed", reason: wrapper.reason }, wrapper.evidence);
        if (wrapper.kind === "present") return;
        const cached = ports.probeNpmCache(target, tool);
        if (cached.kind === "failed") {
            return ports.fail({ kind: "mutation-failed", mutation: "npm-cache", reason: cached.reason, command: tool.cmd }, cached.evidence);
        }
        if (cached.kind === "invalid") return ports.fail({ kind: "npm-cache-invalid", command: tool.cmd });
        if (cached.kind === "missing") {
            ports.report({ kind: "npm-installing", command: tool.cmd });
            requireMutation(ports.cleanupNpmPackage(target, tool), "npm-cleanup", tool.cmd);
            requireMutation(ports.cleanupNpmShim(target, tool), "npm-shim-cleanup", tool.cmd);
            requireMutation(ports.installNpm(target, tool), "npm-install", tool.cmd);
            requireMutation(ports.reshimNpm(target), "npm-reshim", tool.cmd);
        }
        requireMutation(ports.writeNpmWrapper(target, tool), "npm-wrapper", tool.cmd);
    }

    function ensureCodexBubblewrap(target: string): undefined {
        const session = ports.createBubblewrapSession(target);
        const existing = session.probe();
        if (existing.kind === "failed") {
            return ports.fail({ kind: "mutation-failed", mutation: "bubblewrap-probe", reason: existing.reason }, existing.evidence);
        }
        if (existing.kind === "available") return;
        ports.report({ kind: "bubblewrap-installing" });
        requireMutation(session.updatePackageIndex(), "bubblewrap-update");
        requireMutation(session.install(), "bubblewrap-install");
        const confirmation = session.probe();
        if (confirmation.kind === "failed") {
            return ports.fail({ kind: "mutation-failed", mutation: "bubblewrap-confirmation", reason: confirmation.reason }, confirmation.evidence);
        }
        if (confirmation.kind === "missing") {
            ports.fail({ kind: "mutation-failed", mutation: "bubblewrap-confirmation", reason: "failure" });
        }
    }

    function ensureUv(target: string): undefined {
        const result = ports.probeUv(target);
        if (result.kind === "failed") return ports.fail({ kind: "uv-probe-failed", reason: result.reason }, result.evidence);
        if (result.kind === "available") return;
        ports.report({ kind: "uv-installing" });
        requireMutation(ports.installUv(target), "uv-install");
    }
    return { ensureClaude, ensureNpm, ensureCodexBubblewrap, ensureUv };
}
