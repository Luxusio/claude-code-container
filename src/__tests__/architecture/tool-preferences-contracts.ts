import type { ToolDefinition } from "../../domain/tool-registry.js";
import { createToolPreferences } from "../../application/tool-preferences.js";
import type { ToolPreferencePorts } from "../../ports/tool-preferences.js";
import { getDefaultToolPreference, resolveTool, setDefaultToolPreference } from "../../tool-detect.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// Compile-only checks stay uncalled so the public facade never touches a real home.
function compileContracts(ports: ToolPreferencePorts) {
    const app = createToolPreferences(ports);
    const exact: [
        Equal<ReturnType<typeof app.getDefaultToolPreference>, string | null>,
        Equal<ReturnType<typeof app.setDefaultToolPreference>, void>,
        Equal<ReturnType<typeof app.resolveTool>, ToolDefinition>,
        Equal<Parameters<typeof app.resolveTool>, []>,
        Equal<ReturnType<typeof ports.readToolOverride>, string | undefined>,
        Equal<ReturnType<typeof ports.readSavedDefaultTool>, unknown>,
        Equal<ReturnType<typeof ports.findTool>, ToolDefinition | undefined>,
        Equal<ReturnType<typeof ports.getDefaultTool>, ToolDefinition>,
        Equal<ReturnType<typeof getDefaultToolPreference>, string | null>,
        Equal<ReturnType<typeof setDefaultToolPreference>, void>,
        Equal<Parameters<typeof setDefaultToolPreference>, [toolName: string]>,
        Equal<ReturnType<typeof resolveTool>, ToolDefinition>,
        Equal<Parameters<typeof resolveTool>, [env: Record<string, string | undefined>]>,
    ] = [true, true, true, true, true, true, true, true, true, true, true, true, true];
    void exact;

    // @ts-expect-error All preference capabilities are required.
    createToolPreferences({ readSavedDefaultTool: ports.readSavedDefaultTool, saveDefaultTool: ports.saveDefaultTool, findTool: ports.findTool, getDefaultTool: ports.getDefaultTool });
    // @ts-expect-error Ports are required.
    createToolPreferences();
    // @ts-expect-error Lookup must return a tool definition or undefined.
    createToolPreferences({ ...ports, findTool: (_name: string) => "codex" });
    // @ts-expect-error The override is a string or undefined.
    createToolPreferences({ ...ports, readToolOverride: () => 1 });
    // @ts-expect-error Saving takes a tool name.
    app.setDefaultToolPreference(1);
    // @ts-expect-error The application owns no environment input.
    app.resolveTool({ CCC_TOOL: "codex" });
}
void compileContracts;
