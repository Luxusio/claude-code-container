import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
    createLab,
    exportArtifacts,
    guestAgentProvision,
    guestAgentStatus,
    guestExec,
    guestPull,
    guestPush,
    importImage,
    labProviderStatus,
    listImages,
    listLabs,
    listTargets,
    materializeDisk,
    openSession,
    ownerId,
    probeReadiness,
    rebootLab,
    snapshotLab,
    syncWorkspace,
    startLab,
    stopLab,
    deleteLab,
} from "../../lab-mcp/src/provider.mjs";

describe("lab-mcp container-QEMU provider", () => {
    const roots: string[] = [];

    function tempRoot() {
        const root = mkdtempSync(join(tmpdir(), "ccc-lab-mcp-provider-test-"));
        roots.push(root);
        return root;
    }

    afterEach(() => {
        for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    });

    it("reports unsupported outside the lab-runner profile without requiring user configuration", () => {
        const root = tempRoot();
        const status = labProviderStatus({
            env: {},
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
        });

        expect(status).toEqual(expect.objectContaining({
            ok: true,
            provider: "container-qemu",
            available: false,
            status: "unsupported",
            unsupportedReason: "CCC_LAB_RUNNER is not enabled for this container",
            stateRoot: root,
            networkMode: "user",
        }));
    });

    it("reports lab-runner VM networking diagnostics without host TUN exposure", () => {
        const root = tempRoot();
        const status = labProviderStatus({
            env: {
                CCC_LAB_RUNNER: "1",
                CCC_LAB_RUNNER_STATUS: "ready",
                CCC_LAB_NET_MODE: "user",
            },
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
        });

        expect(status).toEqual(expect.objectContaining({
            ok: true,
            available: true,
            status: "ready",
            networkMode: "user",
        }));
        expect(status).not.toHaveProperty("tunPath");
    });

    it("creates and lists owner-scoped named labs under the lab state root", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "test" };
        const created = createLab({
            name: "Ubuntu Test",
            sourceImage: "images/base.qcow2",
            memoryMb: 4096,
            cpus: 4,
        }, { env, stateRoot: root, now: "2026-06-16T00:00:00.000Z" });

        expect(created.ok).toBe(true);
        expect(created.lab).toEqual(expect.objectContaining({
            id: "ubuntu-test",
            ownerId: ownerId(env),
            runtimeState: "stopped",
            resources: { memoryMb: 4096, cpus: 4 },
        }));
        expect(created.lab.image.sourceImage).toBe(join(root, "images/base.qcow2"));
        expect(existsSync(join(root, "owners", ownerId(env), "labs", "ubuntu-test", "lab.json"))).toBe(true);

        const listed = listLabs({ env, stateRoot: root });
        expect(listed.labs.map((lab) => lab.id)).toEqual(["ubuntu-test"]);
    });

    it("imports owner-scoped base images and creates labs from catalog ids", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "images" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        writeFileSync(join(root, "incoming", "ubuntu.qcow2"), "base-image");

        const imported = importImage({
            name: "Ubuntu Base",
            sourcePath: "incoming/ubuntu.qcow2",
        }, {
            env,
            stateRoot: root,
            now: "2026-06-16T04:00:00.000Z",
        });

        expect(imported).toEqual(expect.objectContaining({
            ok: true,
            image: expect.objectContaining({
                id: "ubuntu-base",
                format: "qcow2",
                copied: true,
                sizeBytes: 10,
            }),
        }));
        expect(imported.image.path).toBe(join(root, "owners", ownerId(env), "images", "ubuntu-base", "base.qcow2"));
        expect(readFileSync(imported.image.path, "utf8")).toBe("base-image");
        expect(listImages({ env, stateRoot: root }).images).toEqual([
            expect.objectContaining({ id: "ubuntu-base", path: imported.image.path }),
        ]);

        const lab = createLab({ name: "From Base", baseImageId: "ubuntu-base" }, { env, stateRoot: root });
        expect(lab).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                id: "from-base",
                image: expect.objectContaining({
                    baseImageId: "ubuntu-base",
                    sourceImage: imported.image.path,
                    format: "qcow2",
                }),
            }),
        }));
    });

    it("registers in-state base images without copying and validates image sources", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "image-policy" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        const raw = join(root, "incoming", "disk.raw");
        writeFileSync(raw, "raw-image");

        const registered = importImage({
            name: "Raw Base",
            imageId: "raw-base",
            sourcePath: "incoming/disk.raw",
            copy: false,
        }, { env, stateRoot: root });
        expect(registered).toEqual(expect.objectContaining({
            ok: true,
            image: expect.objectContaining({ id: "raw-base", path: raw, copied: false, format: "raw" }),
        }));

        expect(importImage({ name: "Outside", sourcePath: "/tmp/outside.qcow2" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "source-image-outside-lab-state-root",
        });
        const otherEnv = { CCC_PROFILE: "other-owner" };
        const otherOwnerPath = join(root, "owners", ownerId(otherEnv), "images", "other.qcow2");
        mkdirSync(join(root, "owners", ownerId(otherEnv), "images"), { recursive: true });
        writeFileSync(otherOwnerPath, "other");
        expect(importImage({ name: "Other Owner", sourcePath: otherOwnerPath }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "source-image-outside-owner-scope",
            sourcePath: otherOwnerPath,
        });
        expect(importImage({ name: "Missing Parent", sourcePath: "missing/base.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-not-found",
        }));
        writeFileSync(join(root, "incoming", "file-parent"), "not a directory");
        expect(importImage({ name: "File Parent", sourcePath: "incoming/file-parent/base.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-ancestor-not-directory",
        }));
        symlinkSync(raw, join(root, "incoming", "link.qcow2"));
        expect(importImage({ name: "Link", sourcePath: "incoming/link.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-symlink-rejected",
        }));
        const outsideDir = mkdtempSync(join(tmpdir(), "ccc-lab-outside-images-"));
        roots.push(outsideDir);
        writeFileSync(join(outsideDir, "parent-link.qcow2"), "outside");
        symlinkSync(outsideDir, join(root, "incoming", "outside-link"));
        expect(importImage({ name: "Parent Link", sourcePath: "incoming/outside-link/parent-link.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-symlink-ancestor-rejected",
        }));
        mkdirSync(join(root, "incoming", "dir.qcow2"));
        expect(importImage({ name: "Directory", sourcePath: "incoming/dir.qcow2" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "source-image-not-file",
        }));
        expect(importImage({ name: "Bad Format", sourcePath: "incoming/disk.raw", format: "vmdk" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "unsupported-image-format",
            format: "vmdk",
        });
        writeFileSync(join(root, "incoming", "disk.vmdk"), "vmdk");
        expect(importImage({ name: "Implicit Bad Format", sourcePath: "incoming/disk.vmdk" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "unsupported-image-format",
            format: undefined,
        });
        expect(importImage({ name: "Raw Base", imageId: "raw-base", sourcePath: "incoming/disk.raw" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "base-image-already-exists",
            imageId: "raw-base",
        });
        expect(importImage({ name: "Dot Dot", imageId: "..", sourcePath: "incoming/disk.raw" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-image-id",
        });
    });

    it("rejects source images outside the lab state root", () => {
        const root = tempRoot();
        const result = createLab({ name: "Bad Image", sourceImage: "/tmp/base.qcow2" }, { env: {}, stateRoot: root });
        expect(result).toEqual({ ok: false, error: "source-image-outside-lab-state-root" });
    });

    it("rejects missing base image ids and ambiguous lab image sources", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "lab-image-policy" };
        expect(createLab({ name: "Missing Base", baseImageId: "missing" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "base-image-not-found",
            imageId: "missing",
        });
        expect(createLab({ name: "Ambiguous", baseImageId: "base", sourceImage: "images/base.qcow2" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "ambiguous-source-image",
        });
        expect(createLab({ name: "Dot Dot Base", baseImageId: ".." }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-image-id",
        });
        expect(createLab({ name: "Dot Lab", labId: "." }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-lab-id",
        });
    });

    it("revalidates catalog backing files before creating labs from base images", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "image-revalidate" };
        mkdirSync(join(root, "incoming"), { recursive: true });
        const source = join(root, "incoming", "base.qcow2");
        writeFileSync(source, "base");
        const imported = importImage({ name: "Base", sourcePath: "incoming/base.qcow2", copy: false }, { env, stateRoot: root });
        expect(imported.ok).toBe(true);

        rmSync(source);
        symlinkSync("/tmp/outside.qcow2", source);
        expect(createLab({ name: "From Stale Base", baseImageId: "base" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "base-image-symlink-rejected",
        }));
        rmSync(source);
        rmSync(join(root, "incoming"), { recursive: true, force: true });
        expect(createLab({ name: "From Missing Parent", baseImageId: "base" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "base-image-not-found",
        }));
        mkdirSync(join(root, "incoming"), { recursive: true });
        writeFileSync(join(root, "incoming", "file-parent"), "not a directory");
        const metadataPath = join(root, "owners", ownerId(env), "images", "base", "image.json");
        const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
        writeFileSync(metadataPath, `${JSON.stringify({ ...metadata, path: join(root, "incoming", "file-parent", "base.qcow2") }, null, 2)}\n`);
        expect(createLab({ name: "From File Parent", baseImageId: "base" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "base-image-ancestor-not-directory",
        }));
    });

    it("plans, starts, stops, and deletes a lab only when lab-runner is ready", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ready",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "ready.qcow2"), "base");
        const created = createLab({ name: "Ready VM", sourceImage: "images/ready.qcow2" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const dryRun = startLab({ labId: "ready-vm", dryRun: true }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
        });
        expect(dryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            command: "/usr/bin/qemu-system-x86_64",
            materialized: expect.objectContaining({ ok: true, dryRun: true }),
            args: expect.arrayContaining(["-machine", "q35,accel=kvm:tcg", `file=${created.lab.image.diskImage},if=virtio,format=qcow2`]),
        }));
        expect(JSON.stringify(dryRun)).not.toContain("qemu-monitor.sock");

        const calls: unknown[] = [];
        const started = startLab({ labId: "ready-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
            commandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                if (command.endsWith("qemu-img")) {
                    writeFileSync(args[args.length - 1], "overlay");
                    return { ok: true, command, args };
                }
                return { ok: true, pid: 4242, command, args };
            },
        });
        expect(started.ok).toBe(true);
        expect(started.lab.runtimeState).toBe("running");
        expect(started.lab.runtime.pid).toBe(4242);
        expect(JSON.stringify(started)).not.toContain("qemu-monitor.sock");
        expect(started.materialized).toEqual(expect.objectContaining({ ok: true, materialized: true }));
        expect(calls).toHaveLength(2);
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/qemu-img",
            args: expect.arrayContaining(["create", "-f", "qcow2"]),
        }));
        expect(calls[1]).toEqual(expect.objectContaining({
            command: "/usr/bin/qemu-system-x86_64",
            args: expect.arrayContaining([expect.stringContaining(join("ready-vm", "disks", "root.qcow2"))]),
        }));

        const killed: number[] = [];
        const stopped = stopLab({ labId: "ready-vm" }, {
            env,
            stateRoot: root,
            killProcess: (pid: number) => { killed.push(pid); },
        });
        expect(stopped.ok).toBe(true);
        expect(killed).toEqual([4242]);
        expect(stopped.lab.runtimeState).toBe("stopped");

        const deleted = deleteLab({ labId: "ready-vm" }, { env, stateRoot: root });
        expect(deleted).toEqual(expect.objectContaining({ ok: true, labId: "ready-vm", deleted: true }));
        expect(listLabs({ env, stateRoot: root }).labs).toEqual([]);
    });

    it("materializes owner-scoped qcow2 overlay disks with qemu-img", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "materialize",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Materialize VM", sourceImage: "images/base.qcow2" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const commands: Array<{ command: string; args: string[] }> = [];
        const dryRun = materializeDisk({ labId: "materialize-vm", dryRun: true }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
        });
        expect(dryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            plan: expect.objectContaining({
                command: "/usr/bin/qemu-img",
                args: ["create", "-f", "qcow2", "-F", "qcow2", "-b", join(root, "images", "base.qcow2"), created.lab.image.diskImage],
            }),
        }));
        const startDryRun = startLab({ labId: "materialize-vm", dryRun: true }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
        });
        expect(startDryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            materialized: expect.objectContaining({
                ok: true,
                dryRun: true,
                diskImage: created.lab.image.diskImage,
            }),
            args: expect.arrayContaining([`file=${created.lab.image.diskImage},if=virtio,format=qcow2`]),
        }));

        const materialized = materializeDisk({ labId: "materialize-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: (command: string, args: string[]) => {
                commands.push({ command, args });
                writeFileSync(args[args.length - 1], "overlay");
                return { ok: true, command, args };
            },
            now: "2026-06-16T05:00:00.000Z",
        });
        expect(materialized).toEqual(expect.objectContaining({
            ok: true,
            materialized: true,
            disk: expect.objectContaining({
                kind: "qcow2-overlay",
                backingFormat: "qcow2",
                backingPath: join(root, "images", "base.qcow2"),
            }),
        }));
        expect(commands).toEqual([
            { command: "/usr/bin/qemu-img", args: ["create", "-f", "qcow2", "-F", "qcow2", "-b", join(root, "images", "base.qcow2"), created.lab.image.diskImage] },
        ]);
        expect(readFileSync(created.lab.image.diskImage, "utf8")).toBe("overlay");

        const reused = materializeDisk({ labId: "materialize-vm" }, { env, stateRoot: root });
        expect(reused).toEqual(expect.objectContaining({ ok: true, materialized: false, reused: true }));
    });

    it("recovers missing disk directories and keeps dry-run planning zero-config", () => {
        const root = tempRoot();
        const readyEnv = {
            CCC_PROFILE: "materialize-recovery",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Recovery VM", sourceImage: "images/base.qcow2" }, { env: readyEnv, stateRoot: root });
        expect(created.ok).toBe(true);
        rmSync(dirname(created.lab.image.diskImage), { recursive: true, force: true });
        const recovered = materializeDisk({ labId: "recovery-vm" }, {
            env: readyEnv,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: (_command: string, args: string[]) => {
                writeFileSync(args[args.length - 1], "overlay");
                return { ok: true, args };
            },
        });
        expect(recovered).toEqual(expect.objectContaining({ ok: true, materialized: true, diskImage: created.lab.image.diskImage }));
        expect(readFileSync(created.lab.image.diskImage, "utf8")).toBe("overlay");

        const unsupportedEnv = { CCC_PROFILE: "materialize-recovery" };
        rmSync(created.lab.image.diskImage, { force: true });
        const dryRun = startLab({ labId: "recovery-vm", dryRun: true }, { env: unsupportedEnv, stateRoot: root });
        expect(dryRun).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            providerStatus: expect.objectContaining({ available: false }),
            materialized: expect.objectContaining({
                ok: true,
                dryRun: true,
                plan: expect.objectContaining({
                    command: expect.any(String),
                    args: expect.arrayContaining([created.lab.image.diskImage]),
                }),
            }),
            args: expect.arrayContaining([`file=${created.lab.image.diskImage},if=virtio,format=qcow2`]),
        }));
    });

    it("does not boot stale disk metadata for source-less labs", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "stale-disk",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Stale Disk VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const labPath = join(root, "owners", ownerId(env), "labs", "stale-disk-vm", "lab.json");
        const metadata = JSON.parse(readFileSync(labPath, "utf8"));
        writeFileSync(labPath, `${JSON.stringify({ ...metadata, image: { ...metadata.image, disk: { kind: "qcow2-overlay", path: created.lab.image.diskImage } } }, null, 2)}\n`);
        const commands: Array<{ command: string; args: string[] }> = [];
        const started = startLab({ labId: "stale-disk-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            qemuImgPath: "/usr/bin/qemu-img",
            kvmAvailable: true,
            commandRunner: (command: string, args: string[]) => {
                commands.push({ command, args });
                return { ok: true, pid: 2222, command, args };
            },
        });
        expect(started).toEqual(expect.objectContaining({ ok: true }));
        expect(commands).toHaveLength(1);
        expect(commands[0].args.join("\n")).not.toContain("-drive");
        expect(commands[0].args.join("\n")).not.toContain(created.lab.image.diskImage);
    });

    it("canonicalizes tampered disk metadata paths and refuses running labs", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "materialize-policy",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Materialize Policy VM", sourceImage: "images/base.qcow2" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const labPath = join(root, "owners", ownerId(env), "labs", "materialize-policy-vm", "lab.json");
        const metadata = JSON.parse(readFileSync(labPath, "utf8"));
        const outsideDisk = join(root, "outside.qcow2");
        const outsideLabDir = mkdtempSync(join(tmpdir(), "ccc-lab-outside-metadata-"));
        roots.push(outsideLabDir);
        writeFileSync(outsideDisk, "outside");
        writeFileSync(labPath, `${JSON.stringify({
            ...metadata,
            paths: { ...metadata.paths, labDir: outsideLabDir },
            image: { ...metadata.image, diskImage: join(outsideLabDir, "escape-link", "..", "root.qcow2") },
        }, null, 2)}\n`);
        const materializeCommands: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
        const materialized = materializeDisk({ labId: "materialize-policy-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            providerCommandTimeoutMs: 999999,
            commandRunner: (command: string, args: string[], runOptions: { timeoutMs?: number }) => {
                materializeCommands.push({ command, args, timeoutMs: runOptions.timeoutMs });
                writeFileSync(args[args.length - 1], "overlay");
                return { ok: true, command, args };
            },
        });
        expect(materialized).toEqual(expect.objectContaining({ ok: true, diskImage: created.lab.image.diskImage }));
        expect(materializeCommands).toEqual([
            { command: "/usr/bin/qemu-img", args: ["create", "-f", "qcow2", "-F", "qcow2", "-b", join(root, "images", "base.qcow2"), created.lab.image.diskImage], timeoutMs: 600000 },
        ]);
        expect(readFileSync(outsideDisk, "utf8")).toBe("outside");
        expect(JSON.stringify(materialized)).not.toContain(outsideLabDir);

        const snapshotCommands: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
        expect(snapshotLab("create", { labId: "materialize-policy-vm", snapshotName: "unsafe" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            providerCommandTimeoutMs: 1,
            commandRunner: (command: string, args: string[], runOptions: { timeoutMs?: number }) => {
                snapshotCommands.push({ command, args, timeoutMs: runOptions.timeoutMs });
                return { ok: true, command, args };
            },
        })).toEqual(expect.objectContaining({ ok: true }));
        expect(snapshotCommands).toEqual([
            { command: "/usr/bin/qemu-img", args: ["snapshot", "-c", "unsafe", created.lab.image.diskImage], timeoutMs: 1 },
        ]);

        writeFileSync(labPath, `${JSON.stringify({ ...metadata, runtimeState: "running", runtime: { pid: 1 } }, null, 2)}\n`);
        expect(materializeDisk({ labId: "materialize-policy-vm" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "lab-running",
            labId: "materialize-policy-vm",
        });
    });

    it("rejects disk symlink escapes before materialize, start, or snapshot", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "materialize-symlink",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        mkdirSync(join(root, "images"), { recursive: true });
        writeFileSync(join(root, "images", "base.qcow2"), "base");
        const created = createLab({ name: "Materialize Symlink VM", sourceImage: "images/base.qcow2" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const outsideDir = mkdtempSync(join(tmpdir(), "ccc-lab-outside-disks-"));
        roots.push(outsideDir);
        rmSync(dirname(created.lab.image.diskImage), { recursive: true, force: true });
        symlinkSync(outsideDir, dirname(created.lab.image.diskImage));

        const expectedAncestor = {
            ok: false,
            error: "disk-image-symlink-ancestor-rejected",
            diskImage: created.lab.image.diskImage,
            ancestorPath: dirname(created.lab.image.diskImage),
        };
        expect(materializeDisk({ labId: "materialize-symlink-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
        })).toEqual(expectedAncestor);
        expect(startLab({ labId: "materialize-symlink-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 1234 }),
        })).toEqual(expectedAncestor);

        rmSync(dirname(created.lab.image.diskImage), { force: true });
        mkdirSync(dirname(created.lab.image.diskImage), { recursive: true });
        symlinkSync(join(outsideDir, "root.qcow2"), created.lab.image.diskImage);
        const expectedFinal = {
            ok: false,
            error: "disk-image-symlink-rejected",
            diskImage: created.lab.image.diskImage,
        };
        expect(startLab({ labId: "materialize-symlink-vm" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 1234 }),
        })).toEqual(expectedFinal);
        expect(snapshotLab("create", { labId: "materialize-symlink-vm", snapshotName: "unsafe" }, {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
        })).toEqual({
            ok: false,
            error: "qemu-img-snapshot-failed",
            result: expectedFinal,
        });
    });

    it("sanitizes provider runner failure details before returning start errors", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "start-fail",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Start Failure VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const failed = startLab({ labId: "start-failure-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: (_command: string, args: string[]) => ({ ok: false, args, stderr: "boom" }),
        });

        expect(failed).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-start-failed",
            result: expect.objectContaining({
                args: expect.arrayContaining(["unix:<provider-internal-monitor>,server,nowait"]),
            }),
        }));
        expect(JSON.stringify(failed)).not.toContain("qemu-monitor.sock");
    });

    it("lists targets without starting labs and records bounded sessions", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "targets" };
        const created = createLab({ name: "Target VM" }, { env, stateRoot: root, now: "2026-06-16T00:00:00.000Z" });
        expect(created.ok).toBe(true);

        const targets = listTargets({}, { env, stateRoot: root });
        expect(targets).toEqual(expect.objectContaining({
            ok: true,
            targets: [expect.objectContaining({
                id: "target-vm:vm",
                labId: "target-vm",
                targetKind: "lab-vm",
                runtimeState: "stopped",
                readiness: "stopped",
                attachable: false,
                sessionHints: expect.objectContaining({
                    monitor: "start-lab-before-opening-monitor-session",
                    metadata: "available",
                    guestSsh: "start-lab-before-opening-guest-session",
                    guestAgent: "start-lab-before-opening-agent-session",
                }),
            })],
        }));
        expect(listLabs({ env, stateRoot: root }).labs[0].runtimeState).toBe("stopped");

        const session = openSession({ labId: "target-vm", sessionId: "session-one", sessionType: "metadata" }, {
            env,
            stateRoot: root,
            now: "2026-06-16T00:05:00.000Z",
        });
        expect(session).toEqual(expect.objectContaining({
            ok: true,
            session: expect.objectContaining({
                id: "session-one",
                labId: "target-vm",
                targetKind: "lab-vm",
                state: "unavailable",
                authority: "lab-mcp-metadata",
                attach: expect.objectContaining({ kind: "metadata", available: true }),
            }),
        }));
        expect(listLabs({ env, stateRoot: root }).labs[0].sessions).toEqual([
            expect.objectContaining({ id: "session-one", state: "unavailable" }),
        ]);
    });

    it("opens monitor sessions for running labs without exposing host shell authority", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "session",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Session VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "session-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7777 }),
            now: "2026-06-16T01:00:00.000Z",
        });
        expect(started.ok).toBe(true);

        const session = openSession({ labId: "session-vm", sessionId: "monitor-session" }, {
            env,
            stateRoot: root,
            now: "2026-06-16T01:01:00.000Z",
        });

        expect(session).toEqual(expect.objectContaining({
            ok: true,
            target: expect.objectContaining({ attachable: true, readiness: "process-running" }),
            session: expect.objectContaining({
                id: "monitor-session",
                state: "open",
                authority: "lab-mcp-metadata",
                attach: expect.objectContaining({
                    kind: "bounded-monitor-proxy-required",
                    available: false,
                    requestedTargetReady: true,
                }),
            }),
        }));
        expect(JSON.stringify(listTargets({ labId: "session-vm" }, { env, stateRoot: root }))).not.toContain("qemu-monitor.sock");
        expect(JSON.stringify(session)).not.toContain("qemu-monitor.sock");
    });

    it("opens bounded guest SSH sessions for running labs without raw shell authority", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "session-ssh",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[] }> = [];
        const created = createLab({
            name: "Session SSH VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        expect(startLab({ labId: "session-ssh-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7878 }),
        }).ok).toBe(true);
        const readiness = probeReadiness({ labId: "session-ssh-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            readinessProbeRunner: () => ({
                ok: true,
                ready: true,
                state: "ready",
                diagnostics: {
                    providerArgs: ["-monitor", "unix:/tmp/qemu-monitor.sock,server,nowait"],
                    sshPath: "/usr/bin/ssh",
                    keyPath,
                    labPath: created.lab.paths.labDir,
                    args: ["secret"],
                },
            }),
        });
        expect(readiness.ok).toBe(true);
        const readinessFile = join(created.lab.paths.labDir, "lab.json");
        const rawReadiness = JSON.parse(readFileSync(readinessFile, "utf8"));
        rawReadiness.readiness.latest.state = `/usr/bin/ssh ${keyPath} ${created.lab.paths.labDir} qemu-monitor.sock secret-state`;
        writeFileSync(readinessFile, JSON.stringify(rawReadiness, null, 2));

        const session = openSession({ labId: "session-ssh-vm", sessionId: "guest-ssh-session", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });

        expect(session).toEqual(expect.objectContaining({
            ok: true,
            target: expect.objectContaining({
                attachable: true,
                sessionHints: expect.objectContaining({ guestSsh: "bounded-guest-ssh-session-available" }),
            }),
            session: expect.objectContaining({
                id: "guest-ssh-session",
                sessionType: "guest-ssh",
                state: "open",
                authority: "lab-mcp-bounded-guest-ssh",
                attach: expect.objectContaining({
                    kind: "bounded-guest-ssh",
                    available: true,
                    requestedTargetReady: true,
                    rawShellAvailable: false,
                    commandTool: "lab_guest_exec",
                    transferTools: ["lab_guest_push", "lab_guest_pull"],
                    capabilities: ["lab_guest_exec", "lab_guest_push", "lab_guest_pull"],
                    host: "127.0.0.1",
                    port: 2222,
                    user: "ccc",
                    keyConfigured: true,
                }),
            }),
        }));
        expect(calls).toEqual([]);
        expect(listLabs({ env, stateRoot: root }).labs[0].sessions).toEqual([
            expect.objectContaining({ id: "guest-ssh-session", sessionType: "guest-ssh", state: "open" }),
        ]);
        expect(JSON.stringify(session)).not.toContain(keyPath);
        expect(JSON.stringify(session)).not.toContain(created.lab.paths.labDir);
        expect(JSON.stringify(session)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(session)).not.toContain("qemu-monitor.sock");
        expect(JSON.stringify(session)).not.toContain("secret");
        expect(JSON.stringify(session)).not.toContain("secret-state");
        expect(JSON.stringify(session)).not.toContain("args");
        expect(session.lab.readiness).toBe("process-running");
        expect(session.target.readiness).toBe("process-running");
    });

    it("reports guest SSH session unavailable without invoking command runners", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "session-ssh-unavailable",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const otherEnv = { CCC_PROFILE: "session-ssh-unavailable-other" };
        const otherOwnerRoot = join(root, "owners", ownerId(otherEnv));
        mkdirSync(join(otherOwnerRoot, "keys"), { recursive: true });
        const otherKeyPath = join(otherOwnerRoot, "keys", "id_ed25519");
        writeFileSync(otherKeyPath, "other-private-key");
        const calls: Array<{ command: string; args: string[] }> = [];

        expect(createLab({ name: "Stopped SSH Session VM", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: keyPath }, { env, stateRoot: root }).ok).toBe(true);
        const stopped = openSession({ labId: "stopped-ssh-session-vm", sessionId: "stopped-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });
        expect(stopped.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "lab-not-running" }),
        }));

        expect(createLab({ name: "No SSH Session VM" }, { env, stateRoot: root }).ok).toBe(true);
        expect(startLab({ labId: "no-ssh-session-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7979 }),
        }).ok).toBe(true);
        const noSsh = openSession({ labId: "no-ssh-session-vm", sessionId: "no-ssh-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
        });
        expect(noSsh.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "guest-ssh-not-configured" }),
        }));

        expect(createLab({ name: "Missing SSH Tool VM", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: keyPath }, { env, stateRoot: root }).ok).toBe(true);
        expect(startLab({ labId: "missing-ssh-tool-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 8080 }),
        }).ok).toBe(true);
        const missingTool = openSession({ labId: "missing-ssh-tool-vm", sessionId: "missing-tool-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: null,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });
        expect(missingTool.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "guest-ssh-command-unavailable", missing: ["ssh"] }),
        }));

        const tampered = createLab({ name: "Tampered SSH Session VM", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: keyPath }, { env, stateRoot: root });
        expect(tampered.ok).toBe(true);
        expect(startLab({ labId: "tampered-ssh-session-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 8181 }),
        }).ok).toBe(true);
        const tamperedFile = join(tampered.lab.paths.labDir, "lab.json");
        const rawTampered = JSON.parse(readFileSync(tamperedFile, "utf8"));
        rawTampered.guest.ssh.keyPath = otherKeyPath;
        writeFileSync(tamperedFile, JSON.stringify(rawTampered, null, 2));
        const tamperedSession = openSession({ labId: "tampered-ssh-session-vm", sessionId: "tampered-guest-ssh", sessionType: "guest-ssh" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        });
        expect(tamperedSession.session).toEqual(expect.objectContaining({
            state: "unavailable",
            attach: expect.objectContaining({ available: false, reason: "guest-ssh-not-configured" }),
        }));

        expect(calls).toEqual([]);
        expect(JSON.stringify(stopped)).not.toContain(keyPath);
        expect(JSON.stringify(noSsh)).not.toContain(keyPath);
        expect(JSON.stringify(missingTool)).not.toContain(keyPath);
        expect(JSON.stringify(missingTool)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(tamperedSession)).not.toContain(otherKeyPath);
    });

    it("records bounded guest-agent status, readiness, and sessions without raw shell authority", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const created = createLab({
            name: "Guest Agent VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2200,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
        }, { env, stateRoot: root });
        expect(created).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        name: "ccc-agent",
                        protocol: "bounded-ssh-health-command",
                        healthCommandConfigured: true,
                    }),
                }),
            }),
        }));
        expect(JSON.stringify(created)).not.toContain(healthCommand);
        expect(startLab({ labId: "guest-agent-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7979 }),
        }).ok).toBe(true);

        const calls: Array<{ command: string; args: string[] }> = [];
        const options = {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, stdout: `ready ${keyPath} ${healthCommand}`, stderr: created.lab.paths.labDir };
            },
        };

        const status = guestAgentStatus({ labId: "guest-agent-vm", timeoutMs: 5000 }, options);
        expect(status).toEqual(expect.objectContaining({
            ok: true,
            status: expect.objectContaining({
                state: "ready",
                ok: true,
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-agent-readiness", status: "pass", agent: "ccc-agent" }),
                ]),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        lastStatus: expect.objectContaining({ state: "ready" }),
                    }),
                }),
            }),
        }));
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/ssh",
            args: expect.arrayContaining([healthCommand]),
        }));
        expect(JSON.stringify(status)).not.toContain(keyPath);
        expect(JSON.stringify(status)).not.toContain(healthCommand);

        const readiness = probeReadiness({ labId: "guest-agent-vm" }, options);
        expect(readiness).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "ready",
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-ssh-readiness", status: "pass" }),
                    expect.objectContaining({ name: "guest-agent-readiness", status: "pass", agent: "ccc-agent" }),
                ]),
            }),
        }));

        const session = openSession({ labId: "guest-agent-vm", sessionId: "agent-session", sessionType: "guest-agent" }, options);
        expect(session).toEqual(expect.objectContaining({
            ok: true,
            target: expect.objectContaining({
                sessionHints: expect.objectContaining({ guestAgent: "bounded-guest-agent-session-available" }),
            }),
            session: expect.objectContaining({
                id: "agent-session",
                sessionType: "guest-agent",
                state: "open",
                authority: "lab-mcp-bounded-guest-agent",
                attach: expect.objectContaining({
                    kind: "bounded-guest-agent",
                    available: true,
                    rawShellAvailable: false,
                    rawSocketAvailable: false,
                    statusTool: "lab_guest_agent_status",
                    provisionTool: "lab_guest_agent_provision",
                    commandTool: "lab_guest_exec",
                    transferTools: ["lab_guest_push", "lab_guest_pull"],
                    capabilities: ["lab_guest_agent_status", "lab_guest_agent_provision", "lab_guest_exec", "lab_guest_push", "lab_guest_pull"],
                    agent: expect.objectContaining({
                        name: "ccc-agent",
                        protocol: "bounded-ssh-health-command",
                        healthCommandConfigured: true,
                        provisionCommandConfigured: false,
                        lastStatus: expect.objectContaining({ state: "ready" }),
                    }),
                }),
            }),
        }));
        expect(JSON.stringify(session)).not.toContain(keyPath);
        expect(JSON.stringify(session)).not.toContain(created.lab.paths.labDir);
        expect(JSON.stringify(session)).not.toContain(healthCommand);
        expect(JSON.stringify(session)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(session)).not.toContain("args");
    });

    it("runs bounded guest-agent provisioning explicitly and during opted-in start without leaking commands", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent-provision",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const provisionCommand = "install-ccc-agent --mode bounded";
        const created = createLab({
            name: "Guest Agent Provision VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentProvisionCommand: provisionCommand,
        }, { env, stateRoot: root });
        expect(created).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        provisionCommandConfigured: true,
                        autoProvision: false,
                    }),
                }),
            }),
        }));
        expect(JSON.stringify(created)).not.toContain(provisionCommand);

        expect(guestAgentProvision({ labId: "guest-agent-provision-vm" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
        }));
        expect(startLab({ labId: "guest-agent-provision-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7980 }),
        }).guestAgentProvision).toBeUndefined();

        const calls: Array<{ command: string; args: string[] }> = [];
        const provisioned = guestAgentProvision({ labId: "guest-agent-provision-vm", timeoutMs: 7000 }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, stdout: `installed ${keyPath} ${provisionCommand}`, stderr: created.lab.paths.labDir };
            },
        });
        expect(provisioned).toEqual(expect.objectContaining({
            ok: true,
            status: expect.objectContaining({
                state: "ready",
                provisioned: true,
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-agent-provision", status: "pass", agent: "ccc-agent" }),
                ]),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        lastProvision: expect.objectContaining({ state: "ready", provisioned: true }),
                    }),
                }),
            }),
        }));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/ssh",
            args: expect.arrayContaining([provisionCommand]),
        }));
        expect(JSON.stringify(provisioned)).not.toContain(keyPath);
        expect(JSON.stringify(provisioned)).not.toContain(provisionCommand);
        expect(JSON.stringify(provisioned)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(provisioned)).not.toContain("args");

        const auto = createLab({
            name: "Guest Agent Auto Provision VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentProvisionCommand: provisionCommand,
            guestAgentAutoProvision: true,
        }, { env, stateRoot: root });
        expect(auto.ok).toBe(true);
        const autoCalls: Array<{ command: string; args: string[] }> = [];
        const started = startLab({ labId: "guest-agent-auto-provision-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7981 }),
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                autoCalls.push({ command, args });
                return { ok: true, status: 0, stdout: `auto ${provisionCommand}`, stderr: keyPath };
            },
        });
        expect(started).toEqual(expect.objectContaining({
            ok: true,
            guestAgentProvision: expect.objectContaining({
                ok: true,
                status: expect.objectContaining({ provisioned: true }),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        autoProvision: true,
                        lastProvision: expect.objectContaining({ provisioned: true }),
                    }),
                }),
            }),
        }));
        expect(autoCalls).toHaveLength(1);
        expect(autoCalls[0].args).toEqual(expect.arrayContaining([provisionCommand]));
        expect(JSON.stringify(started)).not.toContain(keyPath);
        expect(JSON.stringify(started)).not.toContain(provisionCommand);
        expect(JSON.stringify(started)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(started)).not.toContain("args");
    });

    it("does not auto-provision without a configured provision command and fails safely without guest SSH", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent-provision-guards",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const provisionCommand = "install-ccc-agent --mode bounded";

        const autoWithoutCommand = createLab({
            name: "Guest Agent Auto No Command VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentAutoProvision: true,
        }, { env, stateRoot: root });
        expect(autoWithoutCommand.ok).toBe(true);
        const autoCalls: Array<{ command: string; args: string[] }> = [];
        const autoStarted = startLab({ labId: "guest-agent-auto-no-command-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7982 }),
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                autoCalls.push({ command, args });
                return { ok: true, status: 0, stdout: "unexpected", stderr: "" };
            },
        });
        expect(autoStarted).toEqual(expect.objectContaining({
            ok: true,
            guestAgentProvision: undefined,
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        autoProvision: true,
                        provisionCommandConfigured: false,
                    }),
                }),
            }),
        }));
        expect(autoCalls).toHaveLength(0);

        const missingSsh = createLab({
            name: "Guest Agent Provision Missing SSH VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
            guestAgentProvisionCommand: provisionCommand,
        }, { env, stateRoot: root });
        expect(missingSsh.ok).toBe(true);
        expect(startLab({ labId: "guest-agent-provision-missing-ssh-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7983 }),
        }).ok).toBe(true);
        const labFile = join(missingSsh.lab.paths.labDir, "lab.json");
        const raw = JSON.parse(readFileSync(labFile, "utf8"));
        delete raw.guest.ssh;
        writeFileSync(labFile, JSON.stringify(raw, null, 2));
        const missingSshCalls: Array<{ command: string; args: string[] }> = [];
        const provisioned = guestAgentProvision({ labId: "guest-agent-provision-missing-ssh-vm" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
            sshCommandRunner: (command: string, args: string[]) => {
                missingSshCalls.push({ command, args });
                return { ok: true, status: 0, stdout: "unexpected", stderr: "" };
            },
        });
        expect(provisioned).toEqual(expect.objectContaining({
            ok: false,
            status: expect.objectContaining({
                state: "failed",
                provisioned: false,
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "guest-agent-provision", status: "fail", reason: "guest-ssh-not-configured" }),
                ]),
            }),
            lab: expect.objectContaining({
                guest: expect.objectContaining({
                    agent: expect.objectContaining({
                        lastProvision: expect.objectContaining({ state: "failed", provisioned: false }),
                    }),
                }),
            }),
        }));
        expect(missingSshCalls).toHaveLength(0);
        expect(JSON.stringify(provisioned)).not.toContain(provisionCommand);
        expect(JSON.stringify(provisioned)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(provisioned)).not.toContain("args");
    });

    it("sanitizes tampered persisted guest-agent status before public responses", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "guest-agent-tamper",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const healthCommand = "systemctl is-active ccc-agent";
        const provisionCommand = "install-ccc-agent --mode bounded";
        const created = createLab({
            name: "Guest Agent Tamper VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestAgentName: "ccc-agent",
            guestAgentHealthCommand: healthCommand,
        }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        expect(startLab({ labId: "guest-agent-tamper-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7978 }),
        }).ok).toBe(true);

        const labFile = join(created.lab.paths.labDir, "lab.json");
        const raw = JSON.parse(readFileSync(labFile, "utf8"));
        raw.guest.agent.provisionCommand = provisionCommand;
        raw.guest.agent.lastStatus = {
            id: "tampered",
            state: "ready",
            ok: true,
            diagnostics: {
                args: ["ssh", keyPath, healthCommand],
                stdout: `ready ${keyPath} ${healthCommand} ${created.lab.paths.labDir}`,
                stderr: `/tmp/noise ${created.lab.paths.artifactsDir}`,
            },
        };
        raw.guest.agent.statusHistory = [
            {
                id: "tampered-history",
                state: "ready",
                diagnostics: { stdout: `${keyPath} ${healthCommand} ${created.lab.paths.workspaceDir}` },
            },
        ];
        raw.guest.agent.lastProvision = {
            id: "tampered-provision",
            state: "ready",
            ok: true,
            diagnostics: {
                args: ["ssh", keyPath, provisionCommand],
                stdout: `installed ${keyPath} ${provisionCommand} ${created.lab.paths.labDir}`,
            },
        };
        raw.guest.agent.provisionHistory = [
            {
                id: "tampered-provision-history",
                state: "ready",
                diagnostics: { stdout: `${keyPath} ${provisionCommand} ${created.lab.paths.workspaceDir}` },
            },
        ];
        writeFileSync(labFile, JSON.stringify(raw, null, 2));

        const listed = listLabs({ env, stateRoot: root });
        const session = openSession({ labId: "guest-agent-tamper-vm", sessionType: "guest-agent" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            processExists: () => true,
        });

        const listedStatusJson = JSON.stringify(listed.labs[0].guest.agent.lastStatus);
        expect(listedStatusJson).not.toContain(keyPath);
        expect(listedStatusJson).not.toContain(healthCommand);
        expect(listedStatusJson).not.toContain(created.lab.paths.labDir);
        expect(listedStatusJson).not.toContain(created.lab.paths.artifactsDir);
        expect(listedStatusJson).not.toContain(created.lab.paths.workspaceDir);
        expect(listedStatusJson).not.toContain("args");
        const listedProvisionJson = JSON.stringify(listed.labs[0].guest.agent.lastProvision);
        expect(listedProvisionJson).not.toContain(keyPath);
        expect(listedProvisionJson).not.toContain(provisionCommand);
        expect(listedProvisionJson).not.toContain(created.lab.paths.labDir);
        expect(listedProvisionJson).not.toContain(created.lab.paths.workspaceDir);
        expect(listedProvisionJson).not.toContain("args");

        const sessionJson = JSON.stringify(session);
        expect(sessionJson).not.toContain(keyPath);
        expect(sessionJson).not.toContain(healthCommand);
        expect(sessionJson).not.toContain(provisionCommand);
        expect(sessionJson).not.toContain(created.lab.paths.labDir);
        expect(sessionJson).not.toContain(created.lab.paths.artifactsDir);
        expect(sessionJson).not.toContain(created.lab.paths.workspaceDir);
        expect(sessionJson).not.toContain("args");
        expect(session.session.attach.agent.lastStatus).toEqual(expect.objectContaining({
            id: "tampered",
            state: "ready",
        }));
        expect(session.session.attach.agent.lastProvision).toEqual(expect.objectContaining({
            id: "tampered-provision",
            state: "ready",
        }));
    });

    it("probes readiness with safe process metadata and reflects latest target state", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "readiness",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Readiness VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const stopped = probeReadiness({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            now: "2026-06-16T03:00:00.000Z",
        });
        expect(stopped).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
            readiness: expect.objectContaining({ state: "stopped" }),
        }));
        expect(stopped.lab.readiness).toBeUndefined();

        const started = startLab({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 4444 }),
            now: "2026-06-16T03:01:00.000Z",
        });
        expect(started.ok).toBe(true);

        const invalidTarget = probeReadiness({ labId: "readiness-vm", targetId: "other:vm" }, {
            env,
            stateRoot: root,
        });
        expect(invalidTarget).toEqual(expect.objectContaining({ ok: false, error: "target-not-found" }));

        const processOnly = probeReadiness({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            processExists: (pid: number) => pid === 4444,
            now: "2026-06-16T03:02:00.000Z",
        });
        expect(processOnly).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "process-running",
                checks: expect.arrayContaining([
                    expect.objectContaining({ name: "runtime-process", status: "pass", pid: 4444 }),
                    expect.objectContaining({ name: "guest-readiness", status: "skipped" }),
                ]),
            }),
            target: expect.objectContaining({ readiness: "process-running", attachable: true }),
        }));
        expect(listTargets({ labId: "readiness-vm" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            targets: [expect.objectContaining({
                readiness: "process-running",
                readinessProbe: expect.objectContaining({ state: "process-running" }),
            })],
        }));

        const ready = probeReadiness({ labId: "readiness-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            readinessProbeRunner: () => ({
                ok: true,
                ready: true,
                checks: [{ name: "guest-agent", status: "pass" }],
                diagnostics: {
                    kind: "bounded-probe",
                    raw: "unix:/tmp/qemu-monitor.sock,server,nowait",
                    providerArgs: ["-monitor", "unix:/tmp/qemu-monitor.sock,server,nowait", "-drive", "file=/host/private.qcow2"],
                    argv: ["-drive", "file=/host/other.qcow2"],
                    hostPath: "/host/private.qcow2",
                },
                args: ["-monitor", "unix:/tmp/qemu-monitor.sock,server,nowait"],
            }),
            now: "2026-06-16T03:03:00.000Z",
        });
        expect(ready).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "ready",
                checks: expect.arrayContaining([expect.objectContaining({ name: "guest-agent", status: "pass" })]),
            }),
            target: expect.objectContaining({ readiness: "ready" }),
        }));
        expect(JSON.stringify(ready)).not.toContain("qemu-monitor.sock");
        expect(JSON.stringify(ready)).not.toContain("/host/private.qcow2");
        expect(JSON.stringify(ready)).not.toContain("/host/other.qcow2");
    });

    it("uses bounded SSH metadata for default guest readiness and transport without exposing key paths", () => {
        const root = tempRoot();
        const workspace = tempRoot();
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "README.md"), "hello");
        writeFileSync(join(workspace, "src", "app.js"), "console.log('ssh');");
        const env = {
            CCC_PROFILE: "ssh-guest",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[] }> = [];
        const sshCommandRunner = (command: string, args: string[]) => {
            calls.push({ command, args });
            return { ok: true, status: 0, command, args, stdout: `ok ${keyPath}`, stderr: "" };
        };

        const created = createLab({
            name: "SSH Guest VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
            guestReadinessCommand: "test -f /tmp/ready",
        }, { env, stateRoot: root });
        expect(created).toEqual(expect.objectContaining({
            ok: true,
            lab: expect.objectContaining({
                guest: {
                    ssh: {
                        host: "127.0.0.1",
                        port: 2222,
                        user: "ccc",
                        keyConfigured: true,
                        readinessCommandConfigured: true,
                    },
                },
            }),
        }));
        expect(JSON.stringify(created)).not.toContain(keyPath);

        const started = startLab({ labId: "ssh-guest-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6161 }),
        });
        expect(started.ok).toBe(true);

        const readiness = probeReadiness({ labId: "ssh-guest-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner,
            now: "2026-06-17T01:00:00.000Z",
        });
        expect(readiness).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "ready",
                checks: expect.arrayContaining([expect.objectContaining({ name: "guest-ssh-readiness", status: "pass" })]),
            }),
        }));
        expect(calls[0]).toEqual(expect.objectContaining({
            command: "/usr/bin/ssh",
            args: expect.arrayContaining(["-p", "2222", "-i", keyPath, "ccc@127.0.0.1", "test -f /tmp/ready"]),
        }));
        expect(JSON.stringify(readiness)).not.toContain(keyPath);
        expect(JSON.stringify(readiness)).not.toContain("private-key");
        expect(JSON.stringify(readiness)).not.toContain("test -f /tmp/ready");

        mkdirSync(created.lab.paths.workspaceDir, { recursive: true });
        writeFileSync(join(created.lab.paths.workspaceDir, "preserve-before-ssh.txt"), "keep");
        const missingSshPush = guestPush({ labId: "ssh-guest-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            sshPath: null,
            scpPath: null,
        });
        expect(missingSshPush).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-transport-unavailable",
            missing: ["ssh", "scp"],
        }));
        expect(readFileSync(join(created.lab.paths.workspaceDir, "preserve-before-ssh.txt"), "utf8")).toBe("keep");
        expect(existsSync(join(created.lab.paths.workspaceDir, "README.md"))).toBe(false);

        const pushed = guestPush({ labId: "ssh-guest-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            sshPath: "/usr/bin/ssh",
            scpPath: "/usr/bin/scp",
            sshCommandRunner,
            now: "2026-06-17T01:01:00.000Z",
        });
        expect(pushed).toEqual(expect.objectContaining({
            ok: true,
            transport: expect.objectContaining({ guestPath: "/workspace/app", files: 2, bytes: 24 }),
        }));
        expect(calls).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: "/usr/bin/ssh", args: expect.arrayContaining(["ccc@127.0.0.1", "mkdir -p /workspace/app"]) }),
            expect.objectContaining({ command: "/usr/bin/scp", args: expect.arrayContaining(["-P", "2222", "-i", keyPath, "ccc@127.0.0.1:/workspace/app/"]) }),
        ]));
        expect(JSON.stringify(pushed)).not.toContain(keyPath);
        expect(JSON.stringify(pushed)).not.toContain("/usr/bin/scp");

        const preflightPullDir = join(created.lab.paths.artifactsDir, "preflight-pull");
        mkdirSync(preflightPullDir, { recursive: true });
        writeFileSync(join(preflightPullDir, "preserve.txt"), "keep");
        const missingSshPull = guestPull({ labId: "ssh-guest-vm", guestPath: "/artifacts/run", destinationPath: "preflight-pull" }, {
            env,
            stateRoot: root,
            sshPath: null,
            scpPath: null,
        });
        expect(missingSshPull).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-transport-unavailable",
            missing: ["ssh", "scp"],
        }));
        expect(readFileSync(join(preflightPullDir, "preserve.txt"), "utf8")).toBe("keep");

        const pulled = guestPull({ labId: "ssh-guest-vm", guestPath: "/artifacts/run", destinationPath: "ssh-pull" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            scpPath: "/usr/bin/scp",
            sshCommandRunner,
            now: "2026-06-17T01:02:00.000Z",
        });
        expect(pulled).toEqual(expect.objectContaining({
            ok: true,
            transport: expect.objectContaining({ guestPath: "/artifacts/run", files: 0, bytes: 0 }),
        }));
        expect(calls).toEqual(expect.arrayContaining([
            expect.objectContaining({ command: "/usr/bin/scp", args: expect.arrayContaining(["ccc@127.0.0.1:/artifacts/run/.", expect.stringContaining("ssh-pull/")]) }),
        ]));
        expect(JSON.stringify(pulled)).not.toContain(keyPath);
    });

    it("runs bounded guest commands over configured SSH without exposing provider internals", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ssh-exec",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[]; timeoutMs?: number; cwd?: string }> = [];
        let createdLabDir = "";
        let createdArtifactsDir = "";
        const sshCommandRunner = (command: string, args: string[], runOptions: { timeoutMs?: number; cwd?: string } = {}) => {
            calls.push({ command, args, timeoutMs: runOptions.timeoutMs, cwd: runOptions.cwd });
            return {
                ok: true,
                status: 0,
                command,
                args,
                stdout: `hello ${keyPath} ${createdLabDir}`,
                stderr: `spawnSync ${command} ETIMEDOUT ${createdArtifactsDir}`,
            };
        };

        const created = createLab({
            name: "SSH Exec VM",
            guestSshHost: "127.0.0.1",
            guestSshPort: 2222,
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        createdLabDir = created.lab.paths.labDir;
        createdArtifactsDir = created.lab.paths.artifactsDir;
        const started = startLab({ labId: "ssh-exec-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6262 }),
        });
        expect(started.ok).toBe(true);

        const executed = guestExec({ labId: "ssh-exec-vm", command: "uname -a", timeoutMs: 999999 }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner,
        });

        expect(executed).toEqual(expect.objectContaining({
            ok: true,
            timeoutMs: 600000,
            result: {
                ok: true,
                status: 0,
                stdout: "hello <provider-internal> <provider-internal>",
                stderr: "spawnSync <provider-internal> ETIMEDOUT <provider-internal>",
            },
        }));
        expect(executed).not.toHaveProperty("lab");
        expect(calls).toEqual([expect.objectContaining({
            command: "/usr/bin/ssh",
            args: ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=5", "-p", "2222", "-i", keyPath, "ccc@127.0.0.1", "uname -a"],
            timeoutMs: 600000,
            cwd: createdLabDir,
        })]);
        expect(JSON.stringify(executed)).not.toContain(keyPath);
        expect(JSON.stringify(executed)).not.toContain(createdLabDir);
        expect(JSON.stringify(executed)).not.toContain("/usr/bin/ssh");
        expect(JSON.stringify(executed)).not.toContain("uname -a");
        expect(JSON.stringify(executed)).not.toContain("args");
    });

    it("rejects guest exec when lab state or SSH prerequisites are not available", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ssh-exec-policy",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const calls: Array<{ command: string; args: string[] }> = [];

        expect(createLab({ name: "No SSH VM" }, { env, stateRoot: root }).ok).toBe(true);
        expect(guestExec({ labId: "no-ssh-vm", command: "id" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "lab-not-running",
            labId: "no-ssh-vm",
        });
        expect(startLab({ labId: "no-ssh-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6363 }),
        }).ok).toBe(true);
        expect(guestExec({ labId: "no-ssh-vm", command: "id" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-exec-unavailable",
            reason: "guest-ssh-not-configured",
        }));

        expect(createLab({
            name: "SSH Missing Binary VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root }).ok).toBe(true);
        expect(startLab({ labId: "ssh-missing-binary-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6464 }),
        }).ok).toBe(true);
        expect(guestExec({ labId: "ssh-missing-binary-vm", command: "id" }, {
            env,
            stateRoot: root,
            sshPath: null,
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0 };
            },
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-command-unavailable",
            missing: ["ssh"],
        }));
        expect(calls).toEqual([]);
    });

    it("validates guest exec commands and ignores tampered stored SSH metadata", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "ssh-exec-validation",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        const otherEnv = { CCC_PROFILE: "ssh-exec-other" };
        const otherOwnerRoot = join(root, "owners", ownerId(otherEnv));
        mkdirSync(join(otherOwnerRoot, "keys"), { recursive: true });
        const otherKeyPath = join(otherOwnerRoot, "keys", "id_ed25519");
        writeFileSync(otherKeyPath, "other-private-key");

        const created = createLab({
            name: "SSH Exec Validation VM",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        expect(startLab({ labId: "ssh-exec-validation-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6565 }),
        }).ok).toBe(true);

        expect(guestExec({ labId: "ssh-exec-validation-vm", command: "" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "missing-guest-command",
        });
        expect(guestExec({ labId: "ssh-exec-validation-vm", command: "echo\u0007bad" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-command",
        });
        expect(guestExec({ labId: "ssh-exec-validation-vm", command: "x".repeat(4097) }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-command",
        });

        const tamperedFile = join(created.lab.paths.labDir, "lab.json");
        const rawTampered = JSON.parse(readFileSync(tamperedFile, "utf8"));
        rawTampered.guest.ssh.keyPath = otherKeyPath;
        writeFileSync(tamperedFile, JSON.stringify(rawTampered, null, 2));
        const calls: Array<{ command: string; args: string[] }> = [];
        const tampered = guestExec({ labId: "ssh-exec-validation-vm", command: "id" }, {
            env,
            stateRoot: root,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, command, args };
            },
        });
        expect(tampered).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-exec-unavailable",
            reason: "guest-ssh-not-configured",
        }));
        expect(calls).toEqual([]);
        expect(JSON.stringify(tampered)).not.toContain(otherKeyPath);
    });

    it("validates bounded guest SSH metadata before creating labs", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "ssh-policy" };
        const ownerRoot = join(root, "owners", ownerId(env));
        mkdirSync(join(ownerRoot, "keys"), { recursive: true });
        const keyPath = join(ownerRoot, "keys", "id_ed25519");
        writeFileSync(keyPath, "private-key");
        symlinkSync(keyPath, join(ownerRoot, "keys", "linked"));
        const otherEnv = { CCC_PROFILE: "ssh-other" };
        const otherOwnerRoot = join(root, "owners", ownerId(otherEnv));
        mkdirSync(join(otherOwnerRoot, "keys"), { recursive: true });
        const otherKeyPath = join(otherOwnerRoot, "keys", "id_ed25519");
        writeFileSync(otherKeyPath, "other-private-key");

        expect(createLab({ name: "Missing User", guestSshHost: "127.0.0.1" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "guest-ssh-requires-host-and-user",
        });
        expect(createLab({ name: "Bad Port", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshPort: 70000 }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-ssh-port",
        });
        expect(createLab({ name: "Bad Host", guestSshHost: "bad host", guestSshUser: "ccc" }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "invalid-guest-ssh-host",
        });
        expect(createLab({ name: "Outside Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: "/tmp/outside-key" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-key-path-outside-allowed-roots",
        }));
        expect(createLab({ name: "Other Owner Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: otherKeyPath }, { env, stateRoot: root })).toEqual({
            ok: false,
            error: "guest-ssh-key-path-outside-owner-scope",
        });
        const homeStateRoot = mkdtempSync(join(homedir(), "ccc-lab-mcp-home-state-"));
        roots.push(homeStateRoot);
        const homeEnv = { CCC_PROFILE: "ssh-home-owner" };
        const homeOtherEnv = { CCC_PROFILE: "ssh-home-other" };
        const homeOtherRoot = join(homeStateRoot, "owners", ownerId(homeOtherEnv));
        mkdirSync(join(homeOtherRoot, "keys"), { recursive: true });
        const homeOtherKey = join(homeOtherRoot, "keys", "id_ed25519");
        writeFileSync(homeOtherKey, "other-private-key");
        expect(createLab({ name: "Home Other Owner Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: homeOtherKey }, { env: homeEnv, stateRoot: homeStateRoot })).toEqual({
            ok: false,
            error: "guest-ssh-key-path-outside-owner-scope",
        });
        expect(createLab({ name: "Link Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: join(ownerRoot, "keys", "linked") }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-ssh-key-symlink-rejected",
        }));
        const missing = createLab({ name: "Missing Key", guestSshHost: "127.0.0.1", guestSshUser: "ccc", guestSshKeyPath: join(ownerRoot, "keys", "missing") }, { env, stateRoot: root });
        expect(missing).toEqual({ ok: false, error: "guest-ssh-key-not-found" });
        expect(JSON.stringify(missing)).not.toContain(ownerRoot);

        const tampered = createLab({
            name: "Tampered SSH",
            guestSshHost: "127.0.0.1",
            guestSshUser: "ccc",
            guestSshKeyPath: keyPath,
        }, { env, stateRoot: root });
        expect(tampered.ok).toBe(true);
        const tamperedEnv = { ...env, CCC_LAB_RUNNER: "1", CCC_LAB_RUNNER_STATUS: "ready" };
        const tamperedFile = join(tampered.lab.paths.labDir, "lab.json");
        const rawTampered = JSON.parse(readFileSync(tamperedFile, "utf8"));
        rawTampered.guest.ssh.keyPath = otherKeyPath;
        writeFileSync(tamperedFile, JSON.stringify(rawTampered, null, 2));
        const startedTampered = startLab({ labId: "tampered-ssh" }, {
            env: tamperedEnv,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 7171 }),
        });
        expect(startedTampered.ok).toBe(true);
        const calls: Array<{ command: string; args: string[] }> = [];
        const tamperedReadiness = probeReadiness({ labId: "tampered-ssh" }, {
            env: tamperedEnv,
            stateRoot: root,
            processExists: () => true,
            sshPath: "/usr/bin/ssh",
            sshCommandRunner: (command: string, args: string[]) => {
                calls.push({ command, args });
                return { ok: true, status: 0, command, args };
            },
        });
        expect(tamperedReadiness).toEqual(expect.objectContaining({
            ok: true,
            readiness: expect.objectContaining({
                state: "process-running",
                checks: expect.arrayContaining([expect.objectContaining({ name: "guest-readiness", status: "skipped" })]),
            }),
        }));
        expect(calls).toEqual([]);
        expect(JSON.stringify(tamperedReadiness)).not.toContain(otherKeyPath);
    });

    it("records failed readiness when a running lab runtime process is gone", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "readiness-fail",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Readiness Fail VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "readiness-fail-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 5555 }),
        });
        expect(started.ok).toBe(true);

        const failed = probeReadiness({ labId: "readiness-fail-vm" }, {
            env,
            stateRoot: root,
            processExists: () => false,
            now: "2026-06-16T03:10:00.000Z",
        });

        expect(failed).toEqual(expect.objectContaining({
            ok: false,
            readiness: expect.objectContaining({
                state: "failed",
                diagnostics: { kind: "runtime-process-not-found" },
            }),
            target: expect.objectContaining({ readiness: "failed", attachable: false }),
        }));
    });

    it("does not expose stale ready probes after a lab stops", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "readiness-stop",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Readiness Stop VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "readiness-stop-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6666 }),
        });
        expect(started.ok).toBe(true);
        const ready = probeReadiness({ labId: "readiness-stop-vm" }, {
            env,
            stateRoot: root,
            processExists: () => true,
            readinessProbeRunner: () => ({ ready: true }),
        });
        expect(ready.target).toEqual(expect.objectContaining({ readiness: "ready" }));

        const stopped = stopLab({ labId: "readiness-stop-vm" }, {
            env,
            stateRoot: root,
            killProcess: () => {},
        });
        expect(stopped.ok).toBe(true);
        expect(stopped.lab.readiness.latest).toBeNull();
        const targets = listTargets({ labId: "readiness-stop-vm" }, { env, stateRoot: root });
        expect(targets).toEqual(expect.objectContaining({
            targets: [expect.objectContaining({
                runtimeState: "stopped",
                readiness: "stopped",
                attachable: false,
                readinessProbe: null,
            })],
        }));
        const session = openSession({ labId: "readiness-stop-vm", sessionId: "stopped-session" }, {
            env,
            stateRoot: root,
        });
        expect(session.target).toEqual(expect.objectContaining({
            runtimeState: "stopped",
            readiness: "stopped",
            readinessProbe: null,
        }));
        expect(session.lab.readiness.latest).toBeNull();
    });

    it("reboots running labs through stop/start gates and preserves named lab state", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "reboot",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Reboot VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "reboot-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 1111 }),
            now: "2026-06-16T02:00:00.000Z",
        });
        expect(started.ok).toBe(true);

        const killed: number[] = [];
        const starts: number[] = [];
        const rebooted = rebootLab({ labId: "reboot-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            killProcess: (pid: number) => { killed.push(pid); },
            commandRunner: () => {
                starts.push(1);
                return { ok: true, pid: 2222 };
            },
            now: "2026-06-16T02:05:00.000Z",
        });

        expect(rebooted.ok).toBe(true);
        expect(killed).toEqual([1111]);
        expect(starts).toEqual([1]);
        expect(rebooted.lab).toEqual(expect.objectContaining({
            id: "reboot-vm",
            runtimeState: "running",
            runtime: expect.objectContaining({ pid: 2222 }),
        }));
        expect(existsSync(join(root, "owners", ownerId(env), "labs", "reboot-vm", "lab.json"))).toBe(true);
    });

    it("requires explicit startIfStopped and provider readiness for stopped lab reboot", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "reboot-stopped",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Stopped Reboot VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        expect(rebootLab({ labId: "stopped-reboot-vm" }, { env, stateRoot: root })).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-not-running",
        }));

        const unsupported = rebootLab({ labId: "stopped-reboot-vm", startIfStopped: true }, {
            env: { ...env, CCC_LAB_RUNNER_STATUS: "unsupported", CCC_LAB_RUNNER_UNSUPPORTED_REASON: "no kvm" },
            stateRoot: root,
        });
        expect(unsupported).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-provider-unsupported",
            providerStatus: expect.objectContaining({ unsupportedReason: "no kvm" }),
        }));
    });

    it("preflights provider readiness before stopping a running lab for reboot", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "reboot-preflight",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Preflight VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "preflight-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 3333 }),
        });
        expect(started.ok).toBe(true);

        const killed: number[] = [];
        const rebooted = rebootLab({ labId: "preflight-vm" }, {
            env: { ...env, CCC_LAB_RUNNER_STATUS: "unsupported", CCC_LAB_RUNNER_UNSUPPORTED_REASON: "no kvm" },
            stateRoot: root,
            killProcess: (pid: number) => { killed.push(pid); },
        });

        expect(rebooted).toEqual(expect.objectContaining({
            ok: false,
            error: "lab-provider-unsupported",
            lab: expect.objectContaining({ runtimeState: "running", runtime: expect.objectContaining({ pid: 3333 }) }),
        }));
        expect(killed).toEqual([]);
        expect(listLabs({ env, stateRoot: root }).labs[0]).toEqual(expect.objectContaining({
            runtimeState: "running",
            runtime: expect.objectContaining({ pid: 3333 }),
        }));
    });

    it("records snapshots and invokes qemu-img snapshot commands for existing disks", () => {
        const root = tempRoot();
        const env = {
            CCC_PROFILE: "snap",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Snapshot VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        writeFileSync(created.lab.image.diskImage, "");

        const commands: Array<{ command: string; args: string[] }> = [];
        const options = {
            env,
            stateRoot: root,
            qemuImgPath: "/usr/bin/qemu-img",
            commandRunner: (command: string, args: string[]) => {
                commands.push({ command, args });
                return { ok: true, command, args };
            },
        };

        const snap = snapshotLab("create", { labId: "snapshot-vm", snapshotName: "Clean Base" }, options);
        expect(snap.ok).toBe(true);
        expect(snap.lab.snapshots.map((snapshot) => snapshot.name)).toEqual(["clean-base"]);

        const restore = snapshotLab("restore", { labId: "snapshot-vm", snapshotName: "clean-base" }, options);
        expect(restore.ok).toBe(true);
        expect(restore.lab.activeSnapshot).toBe("clean-base");

        const deleted = snapshotLab("delete", { labId: "snapshot-vm", snapshotName: "clean-base" }, options);
        expect(deleted.ok).toBe(true);
        expect(deleted.lab.snapshots).toEqual([]);
        expect(commands.map((entry) => entry.args.slice(0, 3))).toEqual([
            ["snapshot", "-c", "clean-base"],
            ["snapshot", "-a", "clean-base"],
            ["snapshot", "-d", "clean-base"],
        ]);
    });

    it("syncs an allowed workspace tree into owner-scoped lab state and records metadata", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-workspace-"));
        roots.push(workspace);
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "README.md"), "hello");
        writeFileSync(join(workspace, "src", "app.js"), "console.log('ok');");
        const env = { CCC_PROFILE: "sync" };
        const created = createLab({ name: "Sync VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);

        const synced = syncWorkspace({ labId: "sync-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            now: "2026-06-16T01:00:00.000Z",
        });

        expect(synced.ok).toBe(true);
        expect(readFileSync(join(created.lab.paths.workspaceDir, "README.md"), "utf8")).toBe("hello");
        expect(readFileSync(join(created.lab.paths.workspaceDir, "src", "app.js"), "utf8")).toBe("console.log('ok');");
        expect(synced.result).toEqual(expect.objectContaining({ files: 2, bytes: 23 }));
        expect(synced.lab.fileOperations).toEqual([
            expect.objectContaining({
                type: "sync_workspace",
                sourcePath: workspace,
                destinationPath: created.lab.paths.workspaceDir,
                files: 2,
                bytes: 23,
            }),
        ]);
    });

    it("exports bounded lab artifacts to an owner-scoped export directory and records metadata", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "export" };
        const created = createLab({ name: "Export VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        mkdirSync(join(created.lab.paths.artifactsDir, "screens"), { recursive: true });
        writeFileSync(join(created.lab.paths.artifactsDir, "screens", "shot.txt"), "pixels");

        const exported = exportArtifacts({
            labId: "export-vm",
            sourcePath: "screens",
            destinationPath: "run-1",
        }, { env, stateRoot: root, now: "2026-06-16T02:00:00.000Z" });

        expect(exported.ok).toBe(true);
        expect(readFileSync(join(created.lab.paths.exportsDir, "run-1", "shot.txt"), "utf8")).toBe("pixels");
        expect(exported.lab.fileOperations).toEqual([
            expect.objectContaining({
                type: "export_artifacts",
                sourcePath: join(created.lab.paths.artifactsDir, "screens"),
                destinationPath: join(created.lab.paths.exportsDir, "run-1"),
                files: 1,
                bytes: 6,
            }),
        ]);
    });

    it("plans and invokes bounded guest push and pull through an injected runner", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-guest-workspace-"));
        roots.push(workspace);
        mkdirSync(join(workspace, "src"), { recursive: true });
        writeFileSync(join(workspace, "README.md"), "hello");
        writeFileSync(join(workspace, "src", "app.js"), "console.log('guest');");
        const env = {
            CCC_PROFILE: "guest-transport",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        const created = createLab({ name: "Guest Transport VM" }, { env, stateRoot: root });
        expect(created.ok).toBe(true);
        const started = startLab({ labId: "guest-transport-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 5150 }),
        });
        expect(started.ok).toBe(true);

        const dryPush = guestPush({ labId: "guest-transport-vm", sourcePath: workspace, guestPath: "/workspace/app", dryRun: true }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(dryPush).toEqual(expect.objectContaining({
            ok: true,
            dryRun: true,
            transport: expect.objectContaining({
                action: "push",
                guestPath: "/workspace/app",
                files: 2,
                bytes: 26,
            }),
        }));

        mkdirSync(created.lab.paths.workspaceDir, { recursive: true });
        writeFileSync(join(created.lab.paths.workspaceDir, "preserve.txt"), "keep");
        const unavailable = guestPush({ labId: "guest-transport-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(unavailable).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-transport-unavailable",
        }));
        expect(readFileSync(join(created.lab.paths.workspaceDir, "preserve.txt"), "utf8")).toBe("keep");
        expect(existsSync(join(created.lab.paths.workspaceDir, "README.md"))).toBe(false);

        const existingPullDir = join(created.lab.paths.artifactsDir, "existing-pull");
        mkdirSync(existingPullDir, { recursive: true });
        writeFileSync(join(existingPullDir, "preserve.txt"), "keep");
        const unavailablePull = guestPull({ labId: "guest-transport-vm", guestPath: "/artifacts/run-1", destinationPath: "existing-pull" }, {
            env,
            stateRoot: root,
        });
        expect(unavailablePull).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-transport-unavailable",
        }));
        expect(readFileSync(join(existingPullDir, "preserve.txt"), "utf8")).toBe("keep");

        const calls: unknown[] = [];
        const pushed = guestPush({ labId: "guest-transport-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: (transport: unknown) => {
                calls.push(transport);
                return { ok: true, command: "ssh", args: ["secret"], socketPath: "/tmp/socket", copied: true, message: "ssh token secret /tmp/socket" };
            },
            now: "2026-06-16T06:00:00.000Z",
        });
        expect(pushed).toEqual(expect.objectContaining({
            ok: true,
            result: expect.objectContaining({ ok: true, copied: true, message: "<provider-internal>" }),
            transport: expect.objectContaining({ guestPath: "/workspace/app", files: 2, bytes: 26 }),
        }));
        expect(readFileSync(join(created.lab.paths.workspaceDir, "README.md"), "utf8")).toBe("hello");
        expect(JSON.stringify(pushed)).not.toContain("secret");
        expect(JSON.stringify(pushed)).not.toContain("token");
        expect(JSON.stringify(pushed)).not.toContain("ssh");
        expect(JSON.stringify(pushed)).not.toContain("socket");
        expect(calls).toEqual([
            expect.objectContaining({
                action: "push",
                stagedPath: created.lab.paths.workspaceDir,
                guestPath: "/workspace/app",
                files: 2,
                bytes: 26,
            }),
        ]);
        expect(pushed.lab.fileOperations).toEqual([
            expect.objectContaining({
                type: "guest_push",
                guestPath: "/workspace/app",
                files: 2,
                bytes: 26,
            }),
        ]);

        const pulled = guestPull({ labId: "guest-transport-vm", guestPath: "/artifacts/run-1", destinationPath: "guest-run" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                mkdirSync(join(transport.destinationPath, "logs"), { recursive: true });
                writeFileSync(join(transport.destinationPath, "logs", "out.txt"), "ok");
                return { ok: true, command: "scp", args: ["hidden"], pulled: true };
            },
            now: "2026-06-16T06:01:00.000Z",
        });
        expect(pulled).toEqual(expect.objectContaining({
            ok: true,
            result: { ok: true, pulled: true },
            transport: expect.objectContaining({ guestPath: "/artifacts/run-1", files: 1, bytes: 2 }),
        }));
        expect(readFileSync(join(created.lab.paths.artifactsDir, "guest-run", "logs", "out.txt"), "utf8")).toBe("ok");
        expect(JSON.stringify(pulled)).not.toContain("hidden");
        expect(pulled.lab.fileOperations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "guest_pull",
                guestPath: "/artifacts/run-1",
                destinationPath: join(created.lab.paths.artifactsDir, "guest-run"),
                files: 1,
                bytes: 2,
            }),
        ]));
    });

    it("rejects unsafe guest transport paths and stopped labs", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-guest-policy-workspace-"));
        roots.push(workspace);
        writeFileSync(join(workspace, "README.md"), "hello");
        const env = {
            CCC_PROFILE: "guest-policy",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        createLab({ name: "Guest Policy VM" }, { env, stateRoot: root });
        expect(guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/workspace" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        })).toEqual(expect.objectContaining({ ok: false, error: "lab-not-running" }));

        const started = startLab({ labId: "guest-policy-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6161 }),
        });
        expect(started.ok).toBe(true);
        expect(guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/etc/passwd" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: true }),
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-path-outside-allowed-roots",
            guestPath: "/etc/passwd",
        }));
        expect(guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/workspace/../escape" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: true }),
        })).toEqual(expect.objectContaining({ ok: false, error: "guest-path-path-traversal-rejected" }));
        expect(guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "/tmp/export" }, {
            env,
            stateRoot: root,
            guestTransportRunner: () => ({ ok: true }),
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-pull-destination-outside-artifacts",
            destinationPath: "/tmp/export",
        }));

        const failedPush = guestPush({ labId: "guest-policy-vm", sourcePath: workspace, guestPath: "/workspace/fail" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: false, message: "failed(path=/tmp/ccc.sock)" }),
            now: "2026-06-16T07:00:00.000Z",
        });
        expect(failedPush).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-push-failed",
            cleanedStagedPath: true,
            result: { ok: false, message: "<provider-internal>" },
        }));
        expect(existsSync(started.lab.paths.workspaceDir)).toBe(false);
        expect(failedPush.lab.fileOperations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "guest_push_failed",
                guestPath: "/workspace/fail",
                error: "guest-push-failed",
            }),
        ]));

        const partialDestination = join(started.lab.paths.artifactsDir, "partial");
        const failedPull = guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "partial" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                writeFileSync(join(transport.destinationPath, "partial.txt"), "partial");
                return { ok: false, message: "scp failed /tmp/partial.sock" };
            },
            now: "2026-06-16T07:01:00.000Z",
        });
        expect(failedPull).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-pull-failed",
            cleanedDestination: true,
            result: { ok: false, message: "<provider-internal>" },
        }));
        expect(existsSync(partialDestination)).toBe(false);
        expect(failedPull.lab.fileOperations).toEqual(expect.arrayContaining([
            expect.objectContaining({
                type: "guest_pull_failed",
                guestPath: "/artifacts/run",
                destinationPath: partialDestination,
                error: "guest-pull-failed",
            }),
        ]));

        const outside = mkdtempSync(join(tmpdir(), "ccc-lab-guest-pull-outside-"));
        roots.push(outside);
        mkdirSync(join(started.lab.paths.artifactsDir), { recursive: true });
        symlinkSync(outside, join(started.lab.paths.artifactsDir, "link"));
        expect(guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "link/out" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                mkdirSync(transport.destinationPath, { recursive: true });
                writeFileSync(join(transport.destinationPath, "out.txt"), "outside");
                return { ok: true };
            },
        })).toEqual(expect.objectContaining({
            ok: false,
            error: "guest-pull-destination-symlink-ancestor-rejected",
            ancestorPath: join(started.lab.paths.artifactsDir, "link"),
        }));
        expect(existsSync(join(outside, "out", "out.txt"))).toBe(false);

        const secretDestination = join(started.lab.paths.artifactsDir, "secret-pull");
        const secret = guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "secret-pull" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                writeFileSync(join(transport.destinationPath, ".env"), "TOKEN=secret");
                return { ok: true };
            },
        });
        expect(secret).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-looking-file",
            path: ".env",
            lab: expect.objectContaining({
                fileOperations: expect.arrayContaining([
                    expect.objectContaining({
                        type: "guest_pull_failed",
                        guestPath: "/artifacts/run",
                        destinationPath: secretDestination,
                        error: "copy-source-secret-looking-file",
                    }),
                ]),
            }),
            cleanedDestination: true,
            destinationPath: secretDestination,
        }));
        expect(existsSync(secretDestination)).toBe(false);

        const secretContentDestination = join(started.lab.paths.artifactsDir, "secret-content-pull");
        const secretContent = guestPull({ labId: "guest-policy-vm", guestPath: "/artifacts/run", destinationPath: "secret-content-pull" }, {
            env,
            stateRoot: root,
            guestTransportRunner: (transport: { destinationPath: string }) => {
                writeFileSync(join(transport.destinationPath, "config.txt"), "API_KEY=guest-secret-value-12345");
                return { ok: true };
            },
        });
        expect(secretContent).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "config.txt",
            pattern: "secret-assignment",
            cleanedDestination: true,
            destinationPath: secretContentDestination,
        }));
        expect(JSON.stringify(secretContent)).not.toContain("guest-secret-value-12345");
        expect(existsSync(secretContentDestination)).toBe(false);
    });

    it("rejects workspace source paths outside allowed roots before copying", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-outside-workspace-"));
        const allowed = mkdtempSync(join(tmpdir(), "ccc-lab-allowed-workspace-"));
        roots.push(workspace, allowed);
        writeFileSync(join(workspace, "file.txt"), "outside");
        const env = { CCC_PROFILE: "policy" };
        createLab({ name: "Policy VM" }, { env, stateRoot: root });

        const result = syncWorkspace({ labId: "policy-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [allowed],
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: "workspace-source-outside-allowed-roots",
            sourcePath: workspace,
            allowedRoots: [allowed],
        }));
    });

    it("rejects symlinks and secret-looking filenames before workspace sync", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-secret-workspace-"));
        roots.push(workspace);
        const env = { CCC_PROFILE: "secret" };
        createLab({ name: "Secret VM" }, { env, stateRoot: root });

        writeFileSync(join(workspace, ".env"), "TOKEN=secret");
        const secret = syncWorkspace({ labId: "secret-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(secret).toEqual(expect.objectContaining({ ok: false, error: "copy-source-secret-looking-file", path: ".env" }));

        rmSync(join(workspace, ".env"));
        writeFileSync(join(workspace, "target.txt"), "target");
        symlinkSync(join(workspace, "target.txt"), join(workspace, "link.txt"));
        const link = syncWorkspace({ labId: "secret-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(link).toEqual(expect.objectContaining({ ok: false, error: "copy-source-symlink-rejected", path: "link.txt" }));
    });

    it("rejects secret content before workspace sync and guest push", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-secret-content-workspace-"));
        roots.push(workspace);
        const secretValue = "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD";
        const env = {
            CCC_PROFILE: "secret-content",
            CCC_LAB_RUNNER: "1",
            CCC_LAB_RUNNER_STATUS: "ready",
        };
        createLab({ name: "Secret Content VM" }, { env, stateRoot: root });
        writeFileSync(join(workspace, "config.txt"), `token=${secretValue}\n`);

        const sync = syncWorkspace({ labId: "secret-content-vm", sourcePath: workspace }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(sync).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "config.txt",
            pattern: "github-token",
        }));
        expect(JSON.stringify(sync)).not.toContain(secretValue);

        const started = startLab({ labId: "secret-content-vm" }, {
            env,
            stateRoot: root,
            qemuPath: "/usr/bin/qemu-system-x86_64",
            kvmAvailable: true,
            commandRunner: () => ({ ok: true, pid: 6262 }),
        });
        expect(started.ok).toBe(true);

        const push = guestPush({ labId: "secret-content-vm", sourcePath: workspace, guestPath: "/workspace/app" }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
            guestTransportRunner: () => ({ ok: true }),
        });
        expect(push).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "config.txt",
            pattern: "github-token",
        }));
        expect(JSON.stringify(push)).not.toContain(secretValue);
    });

    it("returns a structured policy error when secret content scanning cannot read a workspace file", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-unreadable-workspace-"));
        roots.push(workspace);
        const env = { CCC_PROFILE: "unreadable-content" };
        const unreadable = join(workspace, "unreadable.txt");
        createLab({ name: "Unreadable Content VM" }, { env, stateRoot: root });
        writeFileSync(unreadable, "not-secret");
        chmodSync(unreadable, 0o000);

        try {
            try {
                readFileSync(unreadable, "utf8");
                return;
            } catch {
                // Expected on non-root test runners; root can still read 000 files.
            }

            const result = syncWorkspace({ labId: "unreadable-content-vm", sourcePath: workspace }, {
                env,
                stateRoot: root,
                allowedWorkspaceRoots: [workspace],
            });

            expect(result).toEqual(expect.objectContaining({
                ok: false,
                error: "copy-source-content-scan-failed",
                path: "unreadable.txt",
            }));
            expect(JSON.stringify(result)).not.toContain("not-secret");
        } finally {
            chmodSync(unreadable, 0o600);
        }
    });

    it("rejects oversized workspace files and excessive file counts before copying", () => {
        const root = tempRoot();
        const workspace = mkdtempSync(join(tmpdir(), "ccc-lab-limit-workspace-"));
        roots.push(workspace);
        const env = { CCC_PROFILE: "limits" };
        createLab({ name: "Limit VM" }, { env, stateRoot: root });

        writeFileSync(join(workspace, "big.txt"), "12345");
        const tooLarge = syncWorkspace({ labId: "limit-vm", sourcePath: workspace, maxFileBytes: 4 }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(tooLarge).toEqual(expect.objectContaining({ ok: false, error: "copy-source-file-too-large", path: "big.txt" }));

        rmSync(join(workspace, "big.txt"));
        writeFileSync(join(workspace, "a.txt"), "a");
        writeFileSync(join(workspace, "b.txt"), "b");
        const tooMany = syncWorkspace({ labId: "limit-vm", sourcePath: workspace, maxFiles: 1 }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(tooMany).toEqual(expect.objectContaining({ ok: false, error: "copy-source-too-many-files", maxFiles: 1 }));

        const tooLargeTree = syncWorkspace({ labId: "limit-vm", sourcePath: workspace, maxTotalBytes: 1 }, {
            env,
            stateRoot: root,
            allowedWorkspaceRoots: [workspace],
        });
        expect(tooLargeTree).toEqual(expect.objectContaining({ ok: false, error: "copy-source-too-large", maxTotalBytes: 1 }));
    });

    it("rejects artifact source and destination paths outside lab-owned roots", () => {
        const root = tempRoot();
        const outside = mkdtempSync(join(tmpdir(), "ccc-lab-outside-artifact-"));
        roots.push(outside);
        const env = { CCC_PROFILE: "artifact-policy" };
        createLab({ name: "Artifact Policy VM" }, { env, stateRoot: root });

        const source = exportArtifacts({ labId: "artifact-policy-vm", sourcePath: outside }, { env, stateRoot: root });
        expect(source).toEqual(expect.objectContaining({
            ok: false,
            error: "artifact-source-outside-lab-roots",
            sourcePath: outside,
        }));

        const traversal = exportArtifacts({ labId: "artifact-policy-vm", sourcePath: "../escape" }, { env, stateRoot: root });
        expect(traversal).toEqual(expect.objectContaining({ ok: false, error: "invalid-source-path" }));

        const destination = exportArtifacts({ labId: "artifact-policy-vm", destinationPath: "/tmp/export" }, { env, stateRoot: root });
        expect(destination).toEqual(expect.objectContaining({
            ok: false,
            error: "artifact-destination-outside-allowed-roots",
            destinationPath: "/tmp/export",
        }));

        const otherOwner = join(root, "owners", "other-owner", "exports", "artifact-policy-vm");
        const ownerEscape = exportArtifacts({ labId: "artifact-policy-vm", destinationPath: otherOwner }, { env, stateRoot: root });
        expect(ownerEscape).toEqual(expect.objectContaining({
            ok: false,
            error: "artifact-destination-outside-allowed-roots",
            destinationPath: otherOwner,
        }));
    });

    it("rejects secret content before artifact export", () => {
        const root = tempRoot();
        const env = { CCC_PROFILE: "artifact-secret-content" };
        const created = createLab({ name: "Artifact Secret Content VM" }, { env, stateRoot: root });
        const secretValue = "AKIA1234567890ABCDEF";
        mkdirSync(created.lab.paths.artifactsDir, { recursive: true });
        writeFileSync(join(created.lab.paths.artifactsDir, "result.txt"), `aws=${secretValue}\n`);

        const exported = exportArtifacts({ labId: "artifact-secret-content-vm" }, { env, stateRoot: root });

        expect(exported).toEqual(expect.objectContaining({
            ok: false,
            error: "copy-source-secret-content",
            path: "result.txt",
            pattern: "aws-access-key-id",
        }));
        expect(JSON.stringify(exported)).not.toContain(secretValue);
    });
});
