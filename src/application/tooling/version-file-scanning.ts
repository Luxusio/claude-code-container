import {matchesPattern} from "../../domain/tooling/version-files.js";
import type {VersionFileScanningPorts, VersionFileScanRequest} from "../../ports/tooling/version-file-scanning.js";

export function createVersionFileScanner(
    ports: VersionFileScanningPorts,
    ignoredDirectories: ReadonlySet<string>
): (request: VersionFileScanRequest) => Map<string, string> {
    for (const name of ["listDirectoryEntries", "observeFileByteSize", "readVersionFileText", "childPath", "sourcePath"] as const) {
        if (typeof ports?.[name] !== "function") {
            throw new TypeError(`Version file scanning requires a callable ${name} port.`);
        }
    }

    function scanVersionFiles({baseDirectory, directory, depth, maxDepth}: VersionFileScanRequest): Map<string, string> {
        const results = new Map<string, string>();
        if (depth > maxDepth) return results;

        try {
            const entries = ports.listDirectoryEntries(directory);

            for (const entry of entries) {
                const fullPath = ports.childPath(directory, entry.name);

                if (entry.isDirectory()) {
                    if (!ignoredDirectories.has(entry.name) && !entry.name.startsWith(".")) {
                        const subResults = scanVersionFiles({baseDirectory, directory: fullPath, depth: depth + 1, maxDepth});
                        subResults.forEach((content, path) => results.set(path, content));
                    }
                } else if (entry.isFile() && matchesPattern(entry.name)) {
                    try {
                        const size = ports.observeFileByteSize(fullPath);
                        // Skip files larger than 100KB
                        if (size <= 100 * 1024) {
                            const content = ports.readVersionFileText(fullPath);
                            const relPath = ports.sourcePath(baseDirectory, fullPath);
                            results.set(relPath, content);
                        }
                    } catch {
                        // Skip unreadable files
                    }
                }
            }
        } catch {
            // Skip unreadable directories
        }

        return results;
    }

    return scanVersionFiles;
}
