import { describe, expect, it, vi } from "vitest";
import { createQemuOwnedDataApplication } from "../../../packages/device-lab/providers/application/qemu-owned-data.mjs";
import type { QemuOwnedDataPorts } from "../../../packages/device-lab/providers/ports/qemu-owned-data.mjs";
import type { QemuOwnedLab as QemuLab } from "../../../packages/device-lab/providers/domain/qemu-owned-data.mjs";

function dataPorts(): { ports: QemuOwnedDataPorts; lab: QemuLab } {
    const lab: QemuLab = { id: "lab", name: "Guest", ownerId: "owner", runtimeState: "stopped", resources: { memoryMb: 1024, cpus: 1 }, image: { diskImage: "/lab/disk" }, paths: { labDir: "/lab", workspaceDir: "/lab/workspace", artifactsDir: "/lab/artifacts", snapshotsDir: "/lab/snapshots", exportsDir: "/lab/exports" } };
    const ports: QemuOwnedDataPorts = {
        ownerId: () => "owner", readLab: () => ({ ok: true, lab }), writeLab: () => undefined, clock: () => "now",
        workspaceRoot: () => "/source", sourcePathFacts: path => ({ sourcePath: path, allowedRoots: ["/source"], withinRoots: true }),
        workspacePathFacts: () => ({ destinationPath: "/lab/workspace", withinLab: true }), artifactRoots: () => ({ artifactsDir: "/lab/artifacts", workspaceDir: "/lab/workspace" }),
        exportRoot: () => "/lab/exports", defaultExportName: () => "run", resolvePath: (base, path) => path.startsWith("/") ? path : `${base}/${path}`,
        pathWithinRoots: (roots, path) => roots.some(root => path === root || path.startsWith(`${root}/`)),
        scanCopySource: path => ({ ok: true, sourceRoot: path, rootIsFile: false, files: [{ absPath: `${path}/file`, relPath: "file", size: 6 }], totalBytes: 6 }),
        copyFiles: (_plan, destination) => ({ ok: true, destinationPath: destination, files: 1, bytes: 6 }),
        diskPath: () => ({ ok: true, diskPath: "/lab/disk" }), fileExists: () => true, qemuImgPath: () => "/usr/bin/qemu-img", commandTimeoutMs: () => 1000,
        executeQemuImg: () => ({ ok: true, status: 0 }),
    };
    return { ports, lab };
}

describe("QEMU owned data", () => {
    it("does not publish copy history when the bounded copy refuses", () => {
        const { ports } = dataPorts(); ports.copyFiles = () => ({ ok: false, error: "copy-destination-exists" });
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).syncWorkspace({ labId: "lab", sourcePath: "/source", replace: false })).toMatchObject({ ok: false, error: "copy-destination-exists" });
        expect(publish).not.toHaveBeenCalled();
    });

    it("records exported file and byte totals at the owned destination", () => {
        const { ports } = dataPorts(), publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).exportArtifacts({ labId: "lab", sourcePath: "screens", destinationPath: "run" })).toMatchObject({ ok: true });
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ fileOperations: [expect.objectContaining({ type: "export_artifacts", destinationPath: "/lab/exports/run", files: 1, bytes: 6 })] }));
    });

    it("keeps metadata-only snapshots available when qemu-img is absent", () => {
        const { ports } = dataPorts(); ports.qemuImgPath = () => null;
        ports.executeQemuImg = () => { throw new Error("unexpected command"); };
        expect(createQemuOwnedDataApplication(ports).snapshotLab("create", { labId: "lab", snapshotName: "baseline" })).toMatchObject({ ok: true, disk: { diskSnapshot: false, reason: "qemu-img-unavailable" } });
    });

    it("does not publish successful snapshot metadata after native command failure", () => {
        const { ports } = dataPorts(); ports.executeQemuImg = () => ({ ok: false, status: 7 });
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).snapshotLab("create", { labId: "lab", snapshotName: "baseline" })).toMatchObject({ ok: false, error: "qemu-img-snapshot-failed" });
        expect(publish).not.toHaveBeenCalled();
    });
});
