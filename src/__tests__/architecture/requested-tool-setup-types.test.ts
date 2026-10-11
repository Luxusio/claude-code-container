import { describe, expect, it } from "vitest";
import { createRequestedToolSetup } from "../../application/requested-tool-setup.js";
import type { ensureTools } from "../../container-setup.js";
import { createDefaultToolCatalog, type ToolDefinition } from "../../domain/tool-registry.js";
import type { RequestedToolSetupPorts } from "../../ports/requested-tool-setup.js";

// Compile-only checks stay uncalled, including all references to the native facade.
function compileContracts(ports: RequestedToolSetupPorts, tool: ToolDefinition, facade: typeof ensureTools) {
    const app = createRequestedToolSetup(ports);
    const result: undefined = app.ensure("target", tool);
    const publicResult: void = facade("target", tool);
    void [result, publicResult];

    // @ts-expect-error The constructor requires its native capabilities.
    createRequestedToolSetup();
    // @ts-expect-error Claude installation is required.
    createRequestedToolSetup({ ensureNpmTool: ports.ensureNpmTool, probeLauncher: ports.probeLauncher, ensureCodexSandbox: ports.ensureCodexSandbox });
    // @ts-expect-error npm installation is required.
    createRequestedToolSetup({ ensureClaudeLauncher: ports.ensureClaudeLauncher, probeLauncher: ports.probeLauncher, ensureCodexSandbox: ports.ensureCodexSandbox });
    // @ts-expect-error Readiness observation is required.
    createRequestedToolSetup({ ensureClaudeLauncher: ports.ensureClaudeLauncher, ensureNpmTool: ports.ensureNpmTool, ensureCodexSandbox: ports.ensureCodexSandbox });
    // @ts-expect-error Codex sandbox setup is required.
    createRequestedToolSetup({ ensureClaudeLauncher: ports.ensureClaudeLauncher, ensureNpmTool: ports.ensureNpmTool, probeLauncher: ports.probeLauncher });
    // @ts-expect-error Claude installation must settle before readiness is checked.
    createRequestedToolSetup({ ...ports, ensureClaudeLauncher: async () => undefined });
    // @ts-expect-error npm installation must settle before readiness is checked.
    createRequestedToolSetup({ ...ports, ensureNpmTool: async () => undefined });
    // @ts-expect-error Sandbox setup must settle before synchronous completion.
    createRequestedToolSetup({ ...ports, ensureCodexSandbox: async () => undefined });
    // @ts-expect-error Launcher readiness must be observed synchronously.
    createRequestedToolSetup({ ...ports, probeLauncher: async () => ({ status: 0 }) });
}
void compileContracts;

describe("requested tool setup compile contracts", () => {
    it("returns undefined through the synchronous application API", () => {
        const app = createRequestedToolSetup({
            ensureClaudeLauncher: () => undefined,
            ensureNpmTool: () => undefined,
            probeLauncher: () => ({ status: 0 }),
            ensureCodexSandbox: () => undefined,
        });
        expect(app.ensure("target", createDefaultToolCatalog()[0]!)).toBeUndefined();
    });
});
