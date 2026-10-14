import { qemuCommandTimeout } from "../domain/qemu-image-disk-target.mjs";
import { publicLab } from "../domain/qemu-lifecycle.mjs";
import { normalizeGuestTransferPolicy as normalizePolicy, withGuestTransferOperation } from "../domain/qemu-guest-transfer.mjs";
import { ownedDataPath, snapshotName as parseSnapshotName } from "../domain/qemu-owned-data.mjs";
/** @typedef {import('../ports/qemu-owned-data.mjs').QemuOwnedDataArguments} Args */
/** @typedef {import('../domain/qemu-owned-data.mjs').QemuOwnedLab} Lab */
/** @param {import('../ports/qemu-owned-data.mjs').QemuOwnedDataPorts} ports */
export function createQemuOwnedDataApplication(ports) {
    /** @param {Lab} lab @param {import('../ports/qemu-guest-transfer.mjs').QemuFileOperation} operation */
    function recordFileOperation(lab, operation) {
        const next = withGuestTransferOperation(lab, operation);
        ports.writeLab(next);
        return next;
    }
    /** @param {string} action @param {Lab} lab @param {string} name */
    function snapshotDisk(action, lab, name) {
        const disk = ports.diskPath(lab);
        if (!disk.ok) return disk;
        if (!ports.fileExists(disk.diskPath)) return { ok: true, diskSnapshot: false, reason: "disk-image-not-found" };
        if (!ports.qemuImgAvailable()) return { ok: true, diskSnapshot: false, reason: "qemu-img-unavailable" };
        return ports.executeSnapshot(action, name, disk.diskPath, lab, qemuCommandTimeout(ports.commandTimeoutMs(), 120000));
    }
    /** @param {Lab} lab @param {unknown} value @returns {{ok:true,sourcePath:string}|import('../ports/qemu-owned-data.mjs').QemuOwnedDataFailure} */
    function artifactSource(lab, value) {
        const roots = ports.artifactRoots(lab);
        const parsed = ownedDataPath(value || roots.artifactsDir, "source-path");
        if (!parsed.ok) return parsed;
        const candidate = ports.resolvePath(roots.artifactsDir, parsed.path || "");
        const allowedRoots = [roots.artifactsDir, roots.workspaceDir];
        if (!ports.pathWithinRoots(allowedRoots, candidate)) {
            return { ok: false, error: "artifact-source-outside-lab-roots", sourcePath: candidate, allowedRoots };
        }
        return { ok: true, sourcePath: candidate };
    }
    /** @param {Lab} lab @param {unknown} value @returns {{ok:true,destinationPath:string}|import('../ports/qemu-owned-data.mjs').QemuOwnedDataFailure} */
    function exportDestination(lab, value) {
        const exportsDir = ports.exportRoot(lab);
        const defaultName = ports.defaultExportName();
        const parsed = ownedDataPath(value || ports.resolvePath(exportsDir, defaultName), "destination-path");
        if (!parsed.ok) return parsed;
        const candidate = ports.resolvePath(exportsDir, parsed.path || "");
        const allowedRoots = [exportsDir];
        if (!ports.pathWithinRoots(allowedRoots, candidate)) {
            return { ok: false, error: "artifact-destination-outside-allowed-roots", destinationPath: candidate, allowedRoots };
        }
        return { ok: true, destinationPath: candidate };
    }
    /** @param {string} action @param {Args} [args] */
    function snapshotLab(action, args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        if (action === "list") {
            const snapshots = Array.isArray(loaded.lab.snapshots) ? loaded.lab.snapshots : [];
            return { ok: true, ownerId: ports.ownerId(), labId: loaded.lab.id, snapshots, activeSnapshot: loaded.lab.activeSnapshot || null };
        }
        if (loaded.lab.runtimeState === "running") return { ok: false, error: "lab-running", labId: loaded.lab.id };
        const snapshotName = parseSnapshotName(args.snapshotName);
        if (!snapshotName) return { ok: false, error: "invalid-snapshot-name" };
        const snapshots = Array.isArray(loaded.lab.snapshots) ? loaded.lab.snapshots : [];
        const existingIndex = snapshots.findIndex((snapshot) => snapshot.name === snapshotName);
        if (action === "create" && existingIndex >= 0) return { ok: false, error: "snapshot-already-exists", snapshotName };
        if (action !== "create" && existingIndex < 0) return { ok: false, error: "snapshot-not-found", snapshotName };
        const disk = snapshotDisk(action, loaded.lab, snapshotName);
        if (disk && disk.ok === false) return { ok: false, error: "qemu-img-snapshot-failed", result: disk };
        const timestamp = ports.clock();
        const nextSnapshots = action === "create"
            ? [...snapshots, { id: snapshotName, name: snapshotName, createdAt: timestamp, diskSnapshot: disk.diskSnapshot !== false }]
            : snapshots.filter((snapshot) => snapshot.name !== snapshotName || action === "restore");
        const lab = {
            ...loaded.lab,
            updatedAt: timestamp,
            activeSnapshot: action === "restore" ? snapshotName : loaded.lab.activeSnapshot,
            snapshots: nextSnapshots,
        };
        ports.writeLab(lab);
        return { ok: true, ownerId: ports.ownerId(), lab: publicLab(lab), snapshotName, action, disk };
    }

    /** @param {Args} [args] */
    function syncWorkspace(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        const sourceInput = ownedDataPath(args.sourcePath || ports.workspaceRoot(), "source-path");
        if (!sourceInput.ok) return sourceInput;
        const { sourcePath, allowedRoots, withinRoots } = ports.sourcePathFacts(sourceInput.path || "");
        if (!withinRoots) {
            return { ok: false, error: "workspace-source-outside-allowed-roots", sourcePath, allowedRoots };
        }
        const policy = normalizePolicy(args);
        const plan = ports.scanCopySource(sourcePath, policy);
        if (!plan.ok) return plan;
        const { destinationPath: workspaceDir, withinLab } = ports.workspacePathFacts(loaded.lab);
        if (!withinLab) return { ok: false, error: "workspace-destination-outside-lab" };
        const copied = ports.copyFiles(plan, workspaceDir, args.replace !== false);
        if (!copied.ok) return copied;
        const completedAt = ports.clock();
        const lab = recordFileOperation(loaded.lab, {
            type: "sync_workspace",
            sourcePath,
            destinationPath: copied.destinationPath,
            files: copied.files,
            bytes: copied.bytes,
            completedAt,
        });
        return { ok: true, ownerId: ports.ownerId(), lab: publicLab(lab), result: copied, policy };
    }

    /** @param {Args} [args] */
    function exportArtifacts(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) return loaded;
        const source = artifactSource(loaded.lab, args.sourcePath);
        if (!source.ok) return source;
        const destination = exportDestination(loaded.lab, args.destinationPath);
        if (!destination.ok) return destination;
        const policy = normalizePolicy(args);
        const plan = ports.scanCopySource(source.sourcePath, policy);
        if (!plan.ok) return plan;
        const copied = ports.copyFiles(plan, destination.destinationPath, args.replace !== false);
        if (!copied.ok) return copied;
        const completedAt = ports.clock();
        const lab = recordFileOperation(loaded.lab, {
            type: "export_artifacts",
            sourcePath: source.sourcePath,
            destinationPath: copied.destinationPath,
            files: copied.files,
            bytes: copied.bytes,
            completedAt,
        });
        return { ok: true, ownerId: ports.ownerId(), lab: publicLab(lab), result: copied, policy };
    }
    return { syncWorkspace, exportArtifacts, snapshotLab };
}
