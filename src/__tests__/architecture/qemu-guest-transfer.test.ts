import { describe, expect, it, vi } from "vitest";
import { createQemuGuestTransferApplication } from "../../../packages/device-lab/providers/application/qemu-guest-transfer.mjs";
import type { QemuGuestTransferPorts, QemuLab } from "../../../packages/device-lab/providers/ports/qemu-guest-transfer.mjs";

function transferPorts(): QemuGuestTransferPorts {
    const lab: QemuLab = {
        id: "lab", name: "Guest", ownerId: "owner", runtimeState: "running",
        resources: { memoryMb: 1024, cpus: 1 }, image: { diskImage: "/lab/disk" },
        paths: { labDir: "/lab", workspaceDir: "/lab/workspace", artifactsDir: "/lab/artifacts", snapshotsDir: "/lab/snapshots", exportsDir: "/lab/exports" },
    };
    return {
        ownerId: () => "owner", readLab: () => ({ ok: true, lab }), allowedGuestRoots: () => ["/workspace", "/artifacts"],
        pathWithinRoots: (roots, path) => roots.some(root => path === root || path.startsWith(`${root}/`)),
        workspaceRoot: () => "/source", sourcePathFacts: path => ({ sourcePath: path, allowedRoots: ["/source"], withinRoots: true }),
        workspacePathFacts: () => ({ workspaceDir: "/lab/workspace", insideLab: true }),
        defaultPullDestination: (_lab, name) => `/lab/artifacts/${name}`, destinationTimestamp: () => "time",
        resolvePullDestination: () => ({ ok: true, destinationPath: "/lab/artifacts/current" }),
        scanCopySource: path => ({ ok: true, sourceRoot: path, rootIsFile: false, files: [{ absPath: `${path}/file`, relPath: "file", size: 4 }], totalBytes: 4 }),
        copyPlan: (_plan, destination) => ({ ok: true, destinationPath: destination, files: 1, bytes: 4 }),
        transportRunner: () => () => ({ ok: true }), preflightTransport: () => ({ ok: true }),
        exists: () => false, removeDirectory: () => undefined, ensureDirectory: () => undefined,
        writeLab: () => undefined, clock: () => "completed",
    };
}

describe("QEMU guest transfer policy", () => {
    it("removes only the allocated pull destination when transport returns null without recording completion", () => {
        const ports = transferPorts();
        ports.transportRunner = () => () => null;
        const remove = vi.fn(ports.removeDirectory), publish = vi.fn(ports.writeLab);
        ports.removeDirectory = remove; ports.writeLab = publish;
        expect(createQemuGuestTransferApplication(ports).pull({ labId: "lab", guestPath: "/artifacts/run", destinationPath: "current" })).toMatchObject({
            ok: false, error: "guest-transport-unavailable", cleanedDestination: true,
        });
        expect(remove).toHaveBeenCalledWith("/lab/artifacts/current");
        expect(publish).not.toHaveBeenCalled();
    });

    it("preserves an existing destination when replacement is explicitly refused", () => {
        const ports = transferPorts();
        ports.exists = () => true;
        ports.transportRunner = () => { throw new Error("unexpected transport selection"); };
        ports.removeDirectory = () => { throw new Error("unexpected removal"); };
        expect(createQemuGuestTransferApplication(ports).pull({ labId: "lab", guestPath: "/artifacts/run", destinationPath: "current", replace: false })).toMatchObject({
            ok: false, error: "guest-pull-destination-exists", destinationPath: "/lab/artifacts/current",
        });
    });

    it("propagates failed cleanup without fabricating a failed-operation publication", () => {
        const ports = transferPorts(), fault = new Error("removal refused");
        ports.transportRunner = () => () => ({ ok: false });
        ports.removeDirectory = () => { throw fault; };
        const publish = vi.fn(ports.writeLab); ports.writeLab = publish;
        let observed: unknown;
        try { createQemuGuestTransferApplication(ports).pull({ labId: "lab", guestPath: "/artifacts/run", destinationPath: "current" }); }
        catch (error) { observed = error; }
        expect(observed).toBe(fault);
        expect(publish).not.toHaveBeenCalled();
    });

    it("retains a successful destination when recording completion throws", () => {
        const ports = transferPorts(), fault = new Error("publication refused");
        const remove = vi.fn(ports.removeDirectory); ports.removeDirectory = remove;
        const publish = vi.fn((_lab: QemuLab): undefined => { throw fault; }); ports.writeLab = publish;
        let observed: unknown;
        try { createQemuGuestTransferApplication(ports).pull({ labId: "lab", guestPath: "/artifacts/run", destinationPath: "current" }); }
        catch (error) { observed = error; }
        expect(observed).toBe(fault);
        expect(remove).not.toHaveBeenCalled();
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ fileOperations: [expect.objectContaining({
            type: "guest_pull", destinationPath: "/lab/artifacts/current", files: 1, bytes: 4, completedAt: "completed",
        })] }));
    });
});
