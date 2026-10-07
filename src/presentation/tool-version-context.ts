import type {VersionHint} from "../domain/tooling/version-files.js";

// Format scanned files for prompt
export function formatScannedFiles(files: Map<string, string>): string {
    if (files.size === 0) {
        return "No version files found in project.";
    }

    let output = "Detected version files:\n\n";
    files.forEach((content, path) => {
        // Truncate very long files, LLM can read full file if needed
        const truncated = content.length > 2000 ? content.slice(0, 2000) + "\n... (truncated, use Read tool for full content)" : content;
        output += `=== ${path} ===\n${truncated}\n\n`;
    });
    return output;
}

// Format hints for prompt
export function formatVersionHints(hints: VersionHint[]): string {
    if (hints.length === 0) return "";
    return "Pre-extracted versions:\n" + hints.map(h => `  ${h.tool} = "${h.version}" (from ${h.source})`).join("\n") + "\n\n";
}
