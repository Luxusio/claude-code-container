import { CLAUDE_BIN_PATH } from "../domain/tool-layout.js";
import type { ToolDefinition } from "../domain/tool-registry.js";
import type { RequestedToolSetupPorts } from "../ports/requested-tool-setup.js";

export function createRequestedToolSetup(ports: RequestedToolSetupPorts) {
    for (const name of ["ensureClaudeLauncher", "ensureNpmTool", "ensureLauncherReady", "ensureCodexSandbox"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Requested tool setup requires a callable ${name} port.`);
        }
    }

    function ensure(target: string, activeTool: ToolDefinition): undefined {
        if (activeTool.name === "claude") {
            ports.ensureClaudeLauncher(target);
        } else {
            ports.ensureNpmTool(target, activeTool);
        }

        // Tool metadata and native setup share the pure domain launcher location.
        const configuredBinary = activeTool.binary || activeTool.name;
        const executablePath = activeTool.name === "claude"
            ? CLAUDE_BIN_PATH
            : `/home/ccc/.local/bin/${configuredBinary}`;
        ports.ensureLauncherReady(target, executablePath, activeTool);
        if (activeTool.name === "codex") ports.ensureCodexSandbox(target);
    }

    return { ensure };
}
