import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";

const vmPackages = [
    "qemu-system-x86",
    "qemu-utils",
    "ovmf",
    "cpu-checker",
];

function readRepoFile(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf-8");
}

describe("container VM image prerequisites", () => {
    it.each(["Dockerfile", "Containerfile"])("%s includes QEMU/KVM userland packages", (path) => {
        const content = readRepoFile(path);

        for (const packageName of vmPackages) {
            expect(content).toContain(packageName);
        }
    });

    it.each(["Dockerfile", "Containerfile"])("%s bakes bundled CCC MCP servers into /opt/ccc/dist", (path) => {
        const content = readRepoFile(path);

        expect(content).toContain("FROM node:22-slim AS mcp-builder");
        expect(content).toContain("npm run build:x11-mcp && npm run build:device-lab-mcp && npm run build:lab-mcp");
        expect(content).toContain("COPY --from=mcp-builder --chown=ccc:ccc /build/dist/device-lab-mcp /opt/ccc/dist/device-lab-mcp");
        expect(content).toContain("COPY --from=mcp-builder --chown=ccc:ccc /build/dist/lab-mcp /opt/ccc/dist/lab-mcp");
    });
});
