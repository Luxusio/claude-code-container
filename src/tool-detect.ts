// src/tool-detect.ts - Tool preference detection and resolution
//
// Resolves which AI coding tool to use via layered precedence:
//   Layer 1: CCC_TOOL environment variable
//   Layer 2: Saved preference in ~/.ccc/config.json
//   Layer 3: Default tool (claude)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getDefaultTool, getToolByName, type ToolDefinition } from "./tool-registry.js";
import { DATA_DIR } from "./utils.js";

const CONFIG_FILE = join(DATA_DIR, "config.json");

/**
 * Read saved default tool preference from ~/.ccc/config.json
 * Returns null if not set or file cannot be read.
 */
export function getDefaultToolPreference(): string | null {
    if (!existsSync(CONFIG_FILE)) return null;
    try {
        const raw = readFileSync(CONFIG_FILE, "utf-8");
        const config = JSON.parse(raw) as Record<string, unknown>;
        const value = config["defaultTool"];
        return typeof value === "string" ? value : null;
    } catch {
        return null;
    }
}

/**
 * Save default tool preference to ~/.ccc/config.json.
 * Preserves existing keys in the config file.
 */
export function setDefaultToolPreference(toolName: string): void {
    let existing: Record<string, unknown> = {};
    if (existsSync(CONFIG_FILE)) {
        try {
            existing = JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) as Record<string, unknown>;
        } catch {
            existing = {};
        }
    } else {
        mkdirSync(DATA_DIR, { recursive: true });
    }
    const updated = { ...existing, defaultTool: toolName };
    writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), "utf-8");
}

/**
 * Resolve which tool to use given the environment.
 * Layer 1: CCC_TOOL env var
 * Layer 2: Saved preference (~/.ccc/config.json)
 * Layer 3: getDefaultTool() (claude)
 */
export function resolveTool(env: Record<string, string | undefined>): ToolDefinition {
    // Layer 1: CCC_TOOL env var
    const envTool = env["CCC_TOOL"];
    if (envTool) {
        const tool = getToolByName(envTool);
        if (tool) return tool;
    }

    // Layer 2: Saved preference
    const savedPref = getDefaultToolPreference();
    if (savedPref) {
        const tool = getToolByName(savedPref);
        if (tool) return tool;
    }

    // Layer 3: Default (claude)
    return getDefaultTool();
}
