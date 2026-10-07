import {readdirSync, readFileSync, statSync} from "fs";
import {join, relative} from "path";
import {COMMON_IGNORE_DIRS} from "./utils.js";
import {createVersionScanIgnoredDirectories} from "./domain/tooling/version-files.js";
import {createVersionFileScanner} from "./application/tooling/version-file-scanning.js";

export {matchesPattern, extractVersionHints} from "./domain/tooling/version-files.js";
export type {VersionHint} from "./domain/tooling/version-files.js";
export {formatScannedFiles, formatVersionHints} from "./presentation/tool-version-context.js";

const scanVersionFilesWithPorts = createVersionFileScanner({
    listDirectoryEntries: directory => readdirSync(directory, {withFileTypes: true}),
    observeFileByteSize: file => statSync(file).size,
    readVersionFileText: file => readFileSync(file, "utf-8"),
    childPath: join,
    sourcePath: relative
}, createVersionScanIgnoredDirectories(COMMON_IGNORE_DIRS));

// Scan project for version files and return their contents
export function scanVersionFiles(baseDir: string, dir: string = baseDir, depth: number = 0, maxDepth: number = 3): Map<string, string> {
    return scanVersionFilesWithPorts({baseDirectory: baseDir, directory: dir, depth, maxDepth});
}
