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
        diskPath: () => ({ ok: true, diskPath: "/lab/disk" }), fileExists: () => true, qemuImgAvailable: () => true, commandTimeoutMs: () => 1000,
        executeSnapshot: () => ({ ok: true, status: 0 }),
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
        const { ports } = dataPorts(); ports.qemuImgAvailable = () => false;
        const execute = vi.fn(() => ({ ok: true, status: 0 })); ports.executeSnapshot = execute;
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).snapshotLab("create", { labId: "lab", snapshotName: "baseline" })).toMatchObject({ ok: true, disk: { diskSnapshot: false, reason: "qemu-img-unavailable" } });
        expect(execute).not.toHaveBeenCalled();
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ snapshots: [expect.objectContaining({ name: "baseline", diskSnapshot: false })] }));
    });

    it.each([7, 0])("does not publish successful snapshot metadata after semantic failure with status %s", (status) => {
        const { ports, lab } = dataPorts();
        const execute = vi.fn(() => ({ ok: false, status })); ports.executeSnapshot = execute;
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).snapshotLab("create", { labId: "lab", snapshotName: "baseline" })).toMatchObject({ ok: false, error: "qemu-img-snapshot-failed" });
        expect(execute).toHaveBeenCalledExactlyOnceWith("create", "baseline", "/lab/disk", lab, 1000);
        expect(publish).not.toHaveBeenCalled();
    });

    it("keeps metadata-only snapshots available when the disk is missing", () => {
        const { ports } = dataPorts(); ports.fileExists = () => false;
        const available = vi.fn(ports.qemuImgAvailable); ports.qemuImgAvailable = available;
        const execute = vi.fn(ports.executeSnapshot); ports.executeSnapshot = execute;
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).snapshotLab("create", { labId: "lab", snapshotName: "baseline" })).toMatchObject({ ok: true, disk: { diskSnapshot: false, reason: "disk-image-not-found" } });
        expect(available).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ snapshots: [expect.objectContaining({ name: "baseline", diskSnapshot: false })] }));
    });

    it("refuses an invalid disk before native availability or execution", () => {
        const { ports } = dataPorts(); ports.diskPath = () => ({ ok: false, error: "disk-outside-lab" });
        const available = vi.fn(ports.qemuImgAvailable); ports.qemuImgAvailable = available;
        const execute = vi.fn(ports.executeSnapshot); ports.executeSnapshot = execute;
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).snapshotLab("create", { labId: "lab", snapshotName: "baseline" })).toMatchObject({ ok: false, error: "qemu-img-snapshot-failed", result: { ok: false, error: "disk-outside-lab" } });
        expect(available).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it("propagates the exact native fault without publishing snapshot metadata", () => {
        const { ports, lab } = dataPorts();
        const fault = new Error("snapshot execution failed");
        const execute = vi.fn(() => { throw fault; }); ports.executeSnapshot = execute;
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        const application = createQemuOwnedDataApplication(ports);
        let caught: unknown;
        try { application.snapshotLab("create", { labId: "lab", snapshotName: "baseline" }); }
        catch (error) { caught = error; }
        expect(caught).toBe(fault);
        expect(execute).toHaveBeenCalledExactlyOnceWith("create", "baseline", "/lab/disk", lab, 1000);
        expect(publish).not.toHaveBeenCalled();
    });

    it("lists snapshots while running without observing or changing the disk", () => {
        const { ports, lab } = dataPorts(); lab.runtimeState = "running";
        const snapshots = [{ id: "baseline", name: "baseline", createdAt: "before", diskSnapshot: true }];
        lab.snapshots = snapshots; lab.activeSnapshot = "baseline";
        const disk = vi.fn(ports.diskPath); ports.diskPath = disk;
        const execute = vi.fn(ports.executeSnapshot); ports.executeSnapshot = execute;
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        expect(createQemuOwnedDataApplication(ports).snapshotLab("list", { labId: "lab" })).toEqual({ ok: true, ownerId: "owner", labId: "lab", snapshots, activeSnapshot: "baseline" });
        expect(disk).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(publish).not.toHaveBeenCalled();
    });

    it.each(["create", "restore", "delete"])("passes an admitted %s request and changes activeSnapshot only on restore", (action) => {
        const { ports, lab } = dataPorts(); lab.activeSnapshot = "previous";
        lab.snapshots = action === "create" ? [] : [{ id: "baseline", name: "baseline", createdAt: "before", diskSnapshot: true }];
        const execute = vi.fn(ports.executeSnapshot); ports.executeSnapshot = execute;
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        const result = createQemuOwnedDataApplication(ports).snapshotLab(action, { labId: "lab", snapshotName: "baseline" });
        expect(result).toMatchObject({ ok: true, action, snapshotName: "baseline" });
        expect(execute).toHaveBeenCalledExactlyOnceWith(action, "baseline", "/lab/disk", lab, 1000);
        expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            updatedAt: "now", activeSnapshot: action === "restore" ? "baseline" : "previous",
            snapshots: action === "delete" ? [] : [expect.objectContaining({ name: "baseline", diskSnapshot: true })],
        }));
    });

    it("retains the completed native effect when snapshot publication throws", () => {
        const { ports, lab } = dataPorts();
        const fault = new Error("snapshot publication failed"), effects: string[] = [];
        const execute = vi.fn(() => { effects.push("created baseline"); return { ok: true, status: 0 }; }); ports.executeSnapshot = execute;
        const publish = vi.fn(() => { throw fault; }); ports.writeLab = publish;
        let caught: unknown;
        try { createQemuOwnedDataApplication(ports).snapshotLab("create", { labId: "lab", snapshotName: "baseline" }); }
        catch (error) { caught = error; }
        expect(caught).toBe(fault);
        expect(effects).toEqual(["created baseline"]);
        expect(execute).toHaveBeenCalledExactlyOnceWith("create", "baseline", "/lab/disk", lab, 1000);
        expect(publish).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ snapshots: [expect.objectContaining({ name: "baseline", diskSnapshot: true })] }));
        expect(lab.snapshots).toBeUndefined();
    });
});
