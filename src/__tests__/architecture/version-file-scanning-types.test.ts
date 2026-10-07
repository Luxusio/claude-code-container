import { describe, expect, it } from "vitest";
import { createVersionFileScanner } from "../../application/tooling/version-file-scanning.js";
import type { VersionScanEntry, VersionFileScanningPorts, VersionFileScanRequest } from "../../ports/tooling/version-file-scanning.js";
import { matchesPattern, scanVersionFiles, extractVersionHints, formatScannedFiles, formatVersionHints, type VersionHint } from "../../scanner.js";
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function contracts(ports: VersionFileScanningPorts, request: VersionFileScanRequest, entry: VersionScanEntry) {
    const scan = createVersionFileScanner(ports, new Set<string>());
    const proof: [
        Equal<keyof VersionFileScanningPorts, "listDirectoryEntries" | "observeFileByteSize" | "readVersionFileText" | "childPath" | "sourcePath">,
        Equal<keyof VersionFileScanRequest, "baseDirectory" | "directory" | "depth" | "maxDepth">,
        Equal<ReturnType<typeof scan>, Map<string, string>>,
        Equal<ReturnType<typeof scanVersionFiles>, Map<string, string>>,
        Equal<ReturnType<typeof extractVersionHints>, VersionHint[]>,
        Equal<ReturnType<typeof matchesPattern>, boolean>,
        Equal<ReturnType<typeof formatScannedFiles>, string>,
        Equal<ReturnType<typeof formatVersionHints>, string>,
        Equal<ReturnType<typeof ports.listDirectoryEntries>, readonly VersionScanEntry[]>,
        Equal<ReturnType<typeof ports.observeFileByteSize>, number>,
        Equal<ReturnType<typeof ports.readVersionFileText>, string>,
        Equal<ReturnType<typeof ports.childPath>, string>,
        Equal<ReturnType<typeof ports.sourcePath>, string>
    ] = [
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true,
            true
        ];
    void proof;
    scanVersionFiles("base");
    scanVersionFiles("base", "dir");
    scanVersionFiles("base", "dir", 1);
    scanVersionFiles("base", undefined, undefined, 4);
    const map = scan(request);
    map.set("x", "y");
    map.delete("x");
    const hints = extractVersionHints(map);
    hints.push({
        tool: "node",
        version: "22",
        source: "x"
    });
    hints[0].version = "23";
    hints[0].tool = "bun";
    hints[0].source = "y";
    // @ts-expect-error Ignored names are explicitly required.
    createVersionFileScanner(ports);
    // @ts-expect-error Every observation is required.
    createVersionFileScanner({}, new Set());
    createVersionFileScanner({
        ...ports,
        // @ts-expect-error Listing is synchronous.
        listDirectoryEntries: async () => []
    }, new Set());
    createVersionFileScanner({
        ...ports,
        // @ts-expect-error Size is synchronous.
        observeFileByteSize: async () => 0
    }, new Set());
    createVersionFileScanner({
        ...ports,
        // @ts-expect-error Reading is synchronous.
        readVersionFileText: async () => ""
    }, new Set());
    createVersionFileScanner({
        ...ports,
        // @ts-expect-error Child paths are synchronous.
        childPath: async () => ""
    }, new Set());
    createVersionFileScanner({
        ...ports,
        // @ts-expect-error Source paths are synchronous.
        sourcePath: async () => ""
    }, new Set());
    // @ts-expect-error Explicit request is required.
    scan();
    // @ts-expect-error Base directory is required.
    scan({
        directory: "x",
        depth: 0,
        maxDepth: 3
    });
    // @ts-expect-error Directory is required.
    scan({
        baseDirectory: "x",
        depth: 0,
        maxDepth: 3
    });
    // @ts-expect-error Depth is required.
    scan({
        baseDirectory: "x",
        directory: "x",
        maxDepth: 3
    });
    // @ts-expect-error Maximum depth is required.
    scan({
        baseDirectory: "x",
        directory: "x",
        depth: 0
    });
    // @ts-expect-error Ports are readonly.
    ports.listDirectoryEntries = () => [];
    // @ts-expect-error Ports are readonly.
    ports.observeFileByteSize = () => 0;
    // @ts-expect-error Ports are readonly.
    ports.readVersionFileText = () => "";
    // @ts-expect-error Ports are readonly.
    ports.childPath = () => "";
    // @ts-expect-error Ports are readonly.
    ports.sourcePath = () => "";
    // @ts-expect-error Structural entry observations are readonly.
    entry.name = "x";
    // @ts-expect-error Structural entry observations are readonly.
    entry.isDirectory = () => false;
    // @ts-expect-error Structural entry observations are readonly.
    entry.isFile = () => true;
    // @ts-expect-error Requests are readonly.
    request.baseDirectory = "x";
    // @ts-expect-error Requests are readonly.
    request.directory = "x";
    // @ts-expect-error Requests are readonly.
    request.depth = 0;
    // @ts-expect-error Requests are readonly.
    request.maxDepth = 0;
}
void contracts;
describe("version scanning public type contracts", () => {
    it("accepts structural entries and returns fresh mutable synchronous Maps", () => {
        const scan = createVersionFileScanner({
            listDirectoryEntries: () => [
                {
                    name: ".nvmrc",
                    isDirectory: () => false,
                    isFile: () => true
                }
            ],
            observeFileByteSize: () => 2,
            readVersionFileText: () => "22",
            childPath: (dir, name) => `${dir}/${name}`,
            sourcePath: (_base, file) => file
        }, new Set());
        const result = scan({
            baseDirectory: "x",
            directory: "x",
            depth: 0,
            maxDepth: 3
        });
        result.set("extra", "23");
        expect(result.get("extra")).toBe("23");
        expect(result).not.toHaveProperty("then");
    });
});
