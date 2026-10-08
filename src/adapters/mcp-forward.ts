import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { withCodexConfigLock } from "../codex-config-lock.js";
import { getClaudeJsonFile, getCodexConfigFile } from "../utils.js";
import type { McpConfigRegenerationPorts } from "../ports/mcp-forward.js";

/** Observe existence now; defer the native read until after parser selection. */
function readOptionalDocument(file: string): (() => string) | undefined {
    if (!existsSync(file)) return undefined;
    return () => readFileSync(file, "utf-8");
}

export function readHostMcpDocument(): (() => string) | undefined {
    return readOptionalDocument(join(homedir(), ".claude.json"));
}

function isPermissionError(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error.code === "EACCES" || error.code === "EPERM");
}

function codexConfigAccessError(action: "create" | "read" | "write", file: string, error: unknown): Error {
    const reason = error instanceof Error ? error.message : String(error);
    const hint = isPermissionError(error)
        ? ` This usually means ${file} or one of its parent directories is owned by another user. Fix it with: sudo chown -R "$USER:$USER" "${dirname(file)}"`
        : "";
    return new Error(`Unable to ${action} Codex config at ${file}: ${reason}.${hint}`);
}

export function createNativeMcpConfigPorts(): McpConfigRegenerationPorts<string, string> {
    return {
        resolveClaudeProfile: profile => getClaudeJsonFile(profile),
        readClaudeProfileDocument: file => readOptionalDocument(file),
        readHostMcpDocument: () => readHostMcpDocument(),
        withCodexProfileLock: (profile, operation) => withCodexConfigLock(operation, profile),
        prepareCodexProfile: profile => {
            const codexConfigFile = getCodexConfigFile(profile);
            try { mkdirSync(dirname(codexConfigFile), {recursive: true}); }
            catch (error) { throw codexConfigAccessError("create", codexConfigFile, error); }
            let existingText = "";
            if (existsSync(codexConfigFile)) {
                try { existingText = readFileSync(codexConfigFile, "utf-8"); }
                catch (error) { throw codexConfigAccessError("read", codexConfigFile, error); }
            }
            return {binding: codexConfigFile, existingText};
        },
        publishCodexProfile: (file, text) => {
            try { writeFileSync(file, text, {mode: 0o600}); }
            catch (error) { throw codexConfigAccessError("write", file, error); }
            return undefined;
        },
        get publishClaudeProfile() {
            // Select this invocation's native writer before JSON serialization.
            return ((write: typeof writeFileSync) => (file: string, text: string): undefined => {
                write(file, text, {mode: 0o600});
                return undefined;
            })(writeFileSync);
        },
    };
}
