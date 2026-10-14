import { safeSshText, guestSshInput, validateGuestAgent, publicLab, publicMaterializedResult, publicReadinessProbeResult, requireRunningLab, validQemuLabId } from "../domain/qemu-lifecycle.mjs";
import { inferQemuImageFormat, qemuCommandTimeout } from "../domain/qemu-image-disk-target.mjs";
/** @typedef {import('../domain/qemu-lifecycle.mjs').QemuLifecycleArguments} QemuLifecycleArguments */
/** @typedef {import('../domain/qemu-lifecycle.mjs').QemuLab} QemuLab */
/** @param {import('../ports/qemu-lifecycle.mjs').QemuLifecyclePorts} ports */
export function createQemuLifecycleApplication(ports) {

/** @param {QemuLifecycleArguments} [args] @param {string} [admittedLabId] */
function create(args = {}, admittedLabId) {
    if (Object.hasOwn(args, "labId") || Object.hasOwn(args, "deviceId")) {
        return { ok: false, error: "vm-creation-id-not-supported" };
    }
    const ctx = ports.scope();
    const unavailable = ports.runnerUnavailable(ctx);
    if (unavailable) return unavailable;
    const name = String(args.name || "").trim();
    if (!name) return { ok: false, error: "missing-lab-name" };
    const labId = admittedLabId ?? ports.labId();
    if (!validQemuLabId(labId)) return { ok: false, error: "invalid-lab-id" };
    const labDir = ports.labDirectory(ctx, labId);
    if (ports.metadataExists(ctx, labId)) return { ok: false, error: "lab-already-exists", labId };
    if (args.baseImageId && args.sourceImage) return { ok: false, error: "ambiguous-source-image" };
    const baseImage = args.baseImageId ? ports.resolveBaseImage(ctx, String(args.baseImageId)) : null;
    if (baseImage && !baseImage.ok) return baseImage;
    const source = baseImage ? { ok: true, path: baseImage.image.path } : ports.boundedSource(ctx, args.sourceImage, "source-image");
    if (!source.ok) return source;
    const guestSsh = validateGuestSsh(ctx, args);
    if (!guestSsh.ok) return guestSsh;
    const guestAgent = validateGuestAgent(args);
    if (!guestAgent.ok) return guestAgent;
    if (guestAgent.agent && !guestSsh.ssh) return { ok: false, error: "guest-agent-requires-guest-ssh" };
    ports.ensureDirectory(ports.allocatedPath(labDir, "disks"));
    ports.ensureDirectory(ports.allocatedPath(labDir, "snapshots"));
    ports.ensureDirectory(ports.allocatedPath(labDir, "artifacts"));
    const timestamp = ports.clock();
    const lab = {
        id: labId,
        name,
        ownerId: ctx.owner,
        provider: ports.providerName,
        runtimeState: "stopped",
        createdAt: timestamp,
        updatedAt: timestamp,
        resources: {
            memoryMb: Number.isInteger(args.memoryMb) ? args.memoryMb : 2048,
            cpus: Number.isInteger(args.cpus) ? args.cpus : 2,
        },
        image: {
            baseImageId: baseImage?.image?.id || null,
            sourceImage: source.path,
            diskImage: ports.allocatedPath(labDir, "disks", "root.qcow2"),
            format: baseImage?.image?.format || inferQemuImageFormat({}, source.path || "") || "qcow2",
        },
        paths: {
            labDir,
            workspaceDir: ports.allocatedPath(labDir, "workspace"),
            snapshotsDir: ports.allocatedPath(labDir, "snapshots"),
            artifactsDir: ports.allocatedPath(labDir, "artifacts"),
            exportsDir: ports.allocatedPath(ctx.ownerRoot, "exports", labId),
        },
        runtime: null,
        guest: {
            ssh: guestSsh.ssh,
            agent: guestAgent.agent,
        },
        snapshots: [],
        fileOperations: [],
    };
    ports.writeLab(ctx, lab);
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab) };
}

/** @param {QemuLifecycleArguments} [args] */
function start(args = {}) {
    const ctx = ports.scope();
    const loaded = ports.readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const status = ports.providerStatus();
    const disk = ports.validateDisk(loaded.lab);
    if (!disk.ok) return disk;
    if (args.dryRun === true) {
        const needsMaterialize = Boolean(loaded.lab.image?.sourceImage) && !ports.diskExists(disk.diskPath);
        const materialized = needsMaterialize
            ? ports.imageDiskTargetApplication().materializeDisk({ labId: loaded.lab.id, dryRun: true })
            : { ok: true, materialized: false, reused: ports.diskExists(disk.diskPath), lab: loaded.lab };
        if (!materialized.ok) return { ok: /** @type {false} */ (false), error: "lab-disk-materialize-failed", materialized };
        const planLab = needsMaterialize
            ? {
                ...loaded.lab,
                image: {
                    ...loaded.lab.image,
                    diskImage: disk.diskPath,
                    disk: { kind: "qcow2-overlay", path: disk.diskPath, backingPath: loaded.lab.image.sourceImage, backingFormat: loaded.lab.image.format || "qcow2", planned: true },
                },
            }
            : loaded.lab;
        const planned = launch(planLab, ctx, status, true, needsMaterialize);
        if (!planned.ok) return { ok: /** @type {false} */ (false), error: "lab-start-failed", result: planned.presentation };
        return { ok: true, ownerId: ctx.owner, dryRun: true, lab: publicLab(planLab), ...planned.preview, providerStatus: status, materialized };
    }
    if (!status.available) return { ok: /** @type {false} */ (false), error: "lab-provider-unsupported", providerStatus: status };
    if (loaded.lab.runtimeState === "running") return { ownerId: ctx.owner, reused: true, ...prepareStartedLab(loaded.lab, true) };
    const shouldMaterialize = Boolean(loaded.lab.image?.sourceImage);
    const materialized = !shouldMaterialize
        ? { ok: true, materialized: false, skipped: true, reason: "source-image-not-configured", lab: loaded.lab }
        : ports.diskExists(disk.diskPath)
        ? { ok: true, materialized: false, reused: true, lab: loaded.lab }
        : ports.imageDiskTargetApplication().materializeDisk({ labId: loaded.lab.id });
    if (!materialized.ok) return { ok: /** @type {false} */ (false), error: "lab-disk-materialize-failed", materialized };
    const startLabState = materialized.lab || loaded.lab;
    const started = launch(startLabState, ctx, status, false, materialized.materialized === true);
    if (!started.ok) return { ok: /** @type {false} */ (false), error: "lab-start-failed", result: started.presentation };
    const timestamp = ports.clock();
    const lab = {
        ...startLabState,
        runtimeState: "running",
        updatedAt: timestamp,
        runtime: {
            runtimeId: ports.runtimeId(),
            ...started.runtime,
            startedAt: timestamp,
        },
    };
    ports.writeLab(ctx, lab);
    return { ownerId: ctx.owner, ...prepareStartedLab(lab), materialized: publicMaterializedResult(materialized), started: started.presentation };
}

/** @param {QemuLifecycleArguments} [args] */
function reboot(args = {}) {
    const ctx = ports.scope();
    const loaded = ports.readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    if (loaded.lab.runtimeState !== "running" && args.startIfStopped !== true) {
        return { ok: false, error: "lab-not-running", ownerId: ctx.owner, lab: publicLab(loaded.lab), hint: "pass startIfStopped=true to start a stopped lab through reboot" };
    }
    const status = ports.providerStatus();
    if (!status.available) return { ok: false, error: "lab-provider-unsupported", ownerId: ctx.owner, lab: publicLab(loaded.lab), providerStatus: status };
    const stopped = loaded.lab.runtimeState === "running"
        ? stop({ labId: loaded.lab.id, force: args.force === true })
        : { ok: true, ownerId: ctx.owner, lab: publicLab(loaded.lab), stopped: false };
    if (!stopped.ok) return { ok: false, error: "lab-reboot-stop-failed", stop: stopped };
    const started = start({ labId: loaded.lab.id });
    if (!started.ok) return { ok: false, error: "lab-reboot-start-failed", stop: stopped, start: started };
    return { ok: true, ownerId: ctx.owner, lab: started.lab, rebooted: true, stop: stopped, start: started };
}

/** @param {QemuLifecycleArguments} [args] */
function stop(args = {}) {
    const ctx = ports.scope();
    const loaded = ports.readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const runtime = loaded.lab.runtime;
    if (loaded.lab.runtimeState !== "running" && !runtime) {
        return { ok: true, ownerId: ctx.owner, lab: publicLab(loaded.lab), stopped: false };
    }
    const observed = ports.inspectRuntime(runtime);
    if (observed.status !== "match" && observed.status !== "exited") {
        return { ok: false, error: "lab-stop-process-identity-unverified", reason: observed.status, labId: loaded.lab.id };
    }
    if (observed.status === "match") {
        if (ports.legacyKillAvailable()) {
            try {
                ports.legacyKill(runtime?.pid);
            } catch (error) {
                const failure = /** @type {{code?:unknown,message?:unknown}} */ (error);
                if (failure?.code !== "ESRCH") return { ok: false, error: "lab-stop-failed", message: failure.message };
            }
        } else {
            const signaled = ports.signalRuntime(/** @type {import('../domain/qemu-lifecycle.mjs').QemuRuntime} */ (runtime), args.force ? "SIGKILL" : "SIGTERM");
            if (!signaled.signaled && signaled.reason !== "runtime-process-exited") {
                return { ok: false, error: "lab-stop-process-identity-unverified", reason: signaled.reason, labId: loaded.lab.id };
            }
        }
        const exited = ports.waitRuntimeExit(/** @type {import('../domain/qemu-lifecycle.mjs').QemuRuntime} */ (runtime), qemuCommandTimeout(args.timeoutMs, 1000));
        if (!exited.exited) return { ok: false, error: "lab-stop-runtime-not-exited", reason: exited.reason, labId: loaded.lab.id };
    }
    const lab = { ...loaded.lab, runtimeState: "stopped", updatedAt: ports.clock(), runtime: null };
    ports.writeLab(ctx, lab);
    return { ok: true, ownerId: ctx.owner, lab: publicLab(lab), stopped: true };
}

/** @param {QemuLifecycleArguments} [args] */
function deleteLab(args = {}) {
    const ctx = ports.scope();
    const loaded = ports.readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    if (loaded.lab.runtimeState === "running" || loaded.lab.runtime) {
        if (args.force !== true) return { ok: false, error: "lab-running", labId: loaded.lab.id };
        const stopped = stop({ labId: loaded.lab.id, force: true, timeoutMs: args.timeoutMs });
        if (!stopped.ok) return { ok: false, error: "lab-delete-stop-failed", labId: loaded.lab.id, stop: stopped };
    }
    ports.removeLabDirectory(ctx, loaded.lab.id);
    return { ok: true, ownerId: ctx.owner, labId: loaded.lab.id, deleted: true };
}

/** @param {QemuLifecycleArguments} [args] */
function guestAgentProvision(args = {}) {
    const ctx = ports.scope();
    const loaded = ports.readLab(ctx, String(args.labId || ""));
    if (!loaded.ok) return loaded;
    const running = requireRunningLab(loaded.lab);
    if (!running.ok) return running;
    const agent = loaded.lab.guest?.agent;
    if (!agent) return { ok: false, error: "guest-agent-not-configured", ownerId: ctx.owner, labId: loaded.lab.id };
    if (!agent.provisionCommand) return { ok: false, error: "guest-agent-provision-not-configured", ownerId: ctx.owner, labId: loaded.lab.id };
    const timeoutMs = qemuCommandTimeout(args.timeoutMs, 30000);
    const probe = !loaded.lab.guest?.ssh
        ? { ok: false, provisioned: false, checks: [{ name: "guest-agent-provision", status: "fail", reason: "guest-ssh-not-configured", agent: agent.name }], diagnostics: { kind: "guest-agent-provision", available: false, agent: agent.name } }
        : ports.provisionGuestAgent({ lab: loaded.lab, timeoutMs }, ctx);
    const checkedAt = /** @type {string} */ (ports.clock());
    const status = publicReadinessProbeResult({
        id: `guest-agent-provision-${checkedAt.replace(/[^0-9A-Za-z._-]+/g, "-").replace(/-+$/g, "")}`,
        labId: loaded.lab.id,
        provider: loaded.lab.provider || ports.providerName,
        checkedAt,
        timeoutMs,
        state: probe?.ok === true ? "ready" : "failed",
        ok: probe?.ok === true,
        provisioned: probe?.provisioned === true,
        checks: Array.isArray(probe?.checks) ? probe.checks : [],
        diagnostics: probe?.diagnostics || { kind: "guest-agent-provision", available: false },
    });
    const history = Array.isArray(agent.provisionHistory) ? agent.provisionHistory : [];
    const next = {
        ...loaded.lab,
        updatedAt: checkedAt,
        guest: {
            ...(loaded.lab.guest || {}),
            agent: {
                ...agent,
                lastProvision: status,
                provisionHistory: [...history.filter((entry) => entry.id !== status.id), status].slice(-50),
            },
        },
    };
    ports.writeLab(ctx, next);
    return { ok: status.state !== "failed", ownerId: ctx.owner, lab: publicLab(next), status };
}

/** @param {QemuLab} lab @param {boolean} [reused] */
function prepareStartedLab(lab, reused = false) {
    const agent = lab.guest?.agent;
    const prepare = agent?.autoProvision === true && Boolean(agent.provisionCommand)
        && (!reused || agent.lastProvision?.ok !== true);
    const provision = prepare ? guestAgentProvision({ labId: lab.id }) : null;
    return {
        ok: provision?.ok !== false,
        ...(provision?.ok === false ? { error: "lab-guest-agent-provision-failed" } : {}),
        lab: (provision && "lab" in provision ? provision.lab : undefined) || publicLab(lab),
        guestAgentProvision: provision ? {
            ok: provision.ok,
            ...(provision.error ? { error: provision.error } : {}),
            ...("status" in provision && provision.status ? { status: provision.status } : {}),
        } : undefined,
    };
}

/** @param {import('../ports/qemu-lifecycle.mjs').QemuScope} ctx @param {QemuLifecycleArguments} [args] @returns {{ok:true,ssh:import('../domain/qemu-lifecycle.mjs').QemuSsh|null}|import('../ports/qemu-lifecycle.mjs').QemuFailure} */
function validateGuestSsh(ctx, args = {}) {
    const input = guestSshInput(args);
    const values = Object.values(input).filter((value) => value !== undefined && value !== null && value !== "");
    if (values.length === 0) return { ok: true, ssh: null };
    if (!input.host || !input.user) return { ok: false, error: "guest-ssh-requires-host-and-user" };
    const host = safeSshText(String(input.host), "guest-ssh-host", /^[A-Za-z0-9._:-]+$/, 255);
    if (!host.ok) return host;
    const user = safeSshText(String(input.user), "guest-ssh-user", /^[A-Za-z0-9._-]+$/, 64);
    if (!user.ok) return user;
    const port = input.port === undefined || input.port === null || input.port === "" ? 22 : Number(input.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: "invalid-guest-ssh-port" };
    const key = ports.resolveSshKey(ctx, input.keyPath);
    if (!key.ok) return key;
    const readinessCommand = input.readinessCommand === undefined || input.readinessCommand === null || input.readinessCommand === ""
        ? "true"
        : String(input.readinessCommand);
    if (readinessCommand.length > 512 || /[\u0000-\u001f]/.test(readinessCommand)) {
        return { ok: false, error: "invalid-guest-readiness-command" };
    }
    return {
        ok: true,
        ssh: {
            host: host.value,
            port,
            user: user.value,
            keyPath: key.path,
            readinessCommand,
        },
    };
}

/** @param {QemuLab} lab @param {import('../ports/qemu-lifecycle.mjs').QemuScope} ctx @param {{available:boolean,qemu:string|null}} status @param {boolean} dryRun @param {boolean} preferDiskImage */
function launch(lab, ctx, status, dryRun, preferDiskImage) {
    const materializedDisk = lab.image?.disk?.path || null;
    const disk = preferDiskImage && materializedDisk
        ? materializedDisk
        : materializedDisk && ports.diskExists(materializedDisk)
            ? materializedDisk
            : ports.diskExists(lab.image.diskImage)
                ? lab.image.diskImage
                : lab.image.sourceImage;
    return ports.launch({
        ownerId: lab.ownerId,
        labId: lab.id,
        memoryMb: lab.resources.memoryMb,
        cpus: lab.resources.cpus,
        labDirectory: lab.paths.labDir,
        diskImage: disk || null,
        dryRun,
    }, ctx, status);
}

    return { create, start, stop, reboot, delete: deleteLab, provisionGuestAgent: guestAgentProvision, validateGuestSsh };
}
