import { requireRunningLab, publicLab } from "../domain/qemu-lifecycle.mjs";
import { normalizeGuestTransferPolicy, validateGuestTransferPath, validateGuestTransferSource, guestPullDestinationName, publicGuestTransferResult, guestTransferSucceeded, withGuestTransferOperation } from "../domain/qemu-guest-transfer.mjs";
/** @param {import("../ports/qemu-guest-transfer.mjs").QemuGuestTransferPorts} ports */
export function createQemuGuestTransferApplication(ports) {
    /** @param {import("../domain/qemu-lifecycle.mjs").QemuLab} lab @param {import("../ports/qemu-guest-transfer.mjs").QemuFileOperation} operation */
    function recordOperation(lab, operation) {
        const next = withGuestTransferOperation(lab, operation);
        ports.writeLab(next);
        return next;
    }
    /** @param {import("../ports/qemu-guest-transfer.mjs").QemuGuestTransferArgs} [args] */
    function push(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) {
            return loaded;
        }
        const running = requireRunningLab(loaded.lab);
        if (!running.ok) {
            return running;
        }
        const guest = validateGuestTransferPath(args.guestPath || "/workspace", "guest-path", ports.allowedGuestRoots());
        if (!guest.ok) {
            return guest;
        }
        if (!ports.pathWithinRoots(guest.allowedGuestRoots, guest.guestPath)) {
            return {
                ok: false, error: "guest-path-outside-allowed-roots", guestPath: guest.guestPath, allowedGuestRoots: guest.allowedGuestRoots
            };
        }
        const sourceInput = validateGuestTransferSource(args.sourcePath || ports.workspaceRoot());
        if (!sourceInput.ok) {
            return sourceInput;
        }
        const { sourcePath, allowedRoots, withinRoots } = ports.sourcePathFacts(sourceInput.path);
        if (!withinRoots) {
            return {
                ok: false, error: "workspace-source-outside-allowed-roots", sourcePath, allowedRoots
            };
        }
        const policy = normalizeGuestTransferPolicy(args);
        const plan = ports.scanCopySource(sourcePath, policy);
        if (!plan.ok) {
            return plan;
        }
        const { workspaceDir, insideLab } = ports.workspacePathFacts(loaded.lab);
        if (!insideLab) {
            return {
                ok: false, error: "workspace-destination-outside-lab"
            };
        }
        /** @type {import("../ports/qemu-guest-transfer.mjs").QemuGuestTransport} */
        const transport = {
            action: "push",
            labId: loaded.lab.id,
            sourcePath,
            stagedPath: workspaceDir,
            guestPath: guest.guestPath,
            files: plan.files.length,
            bytes: plan.totalBytes,
            replace: args.replace !== false,
            allowedGuestRoots: guest.allowedGuestRoots
        };
        if (args.dryRun === true) {
            return {
                ok: true, ownerId: ports.ownerId(), dryRun: true, lab: publicLab(loaded.lab), transport, policy
            };
        }
        const runner = ports.transportRunner(loaded.lab);
        if (typeof runner !== "function") {
            return {
                ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport, policy
            };
        }
        const preflight = ports.preflightTransport(loaded.lab, transport);
        if (!preflight.ok) {
            return {
                ...preflight, transport, policy
            };
        }
        const copied = ports.copyPlan(plan, workspaceDir, args.replace !== false);
        if (!copied.ok) {
            return copied;
        }
        const result = publicGuestTransferResult(runner({
            ...transport, stagedPath: copied.destinationPath
        }));
        if (result === null) {
            ports.removeDirectory(copied.destinationPath);
            return {
                ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport: {
                    ...transport, stagedPath: copied.destinationPath
                }, policy, cleanedStagedPath: true
            };
        }
        if (!guestTransferSucceeded(result)) {
            ports.removeDirectory(copied.destinationPath);
            const failedAt = ports.clock();
            const lab = recordOperation(loaded.lab, {
                type: "guest_push_failed",
                sourcePath,
                stagedPath: copied.destinationPath,
                guestPath: guest.guestPath,
                files: copied.files,
                bytes: copied.bytes,
                completedAt: failedAt,
                error: "guest-push-failed"
            });
            return {
                ok: false, error: "guest-push-failed", lab: publicLab(lab), result, transport: {
                    ...transport, stagedPath: copied.destinationPath
                }, policy, cleanedStagedPath: true
            };
        }
        const completedAt = ports.clock();
        const lab = recordOperation(loaded.lab, {
            type: "guest_push",
            sourcePath,
            stagedPath: copied.destinationPath,
            guestPath: guest.guestPath,
            files: copied.files,
            bytes: copied.bytes,
            completedAt
        });
        return {
            ok: true, ownerId: ports.ownerId(), lab: publicLab(lab), result, transport: {
                ...transport, stagedPath: copied.destinationPath
            }, policy
        };
    }
    /** @param {import("../ports/qemu-guest-transfer.mjs").QemuGuestTransferArgs} [args] */
    function pull(args = {}) {
        const loaded = ports.readLab(String(args.labId || ""));
        if (!loaded.ok) {
            return loaded;
        }
        const running = requireRunningLab(loaded.lab);
        if (!running.ok) {
            return running;
        }
        const guest = validateGuestTransferPath(args.guestPath || "/artifacts", "guest-path", ports.allowedGuestRoots());
        if (!guest.ok) {
            return guest;
        }
        if (!ports.pathWithinRoots(guest.allowedGuestRoots, guest.guestPath)) {
            return {
                ok: false, error: "guest-path-outside-allowed-roots", guestPath: guest.guestPath, allowedGuestRoots: guest.allowedGuestRoots
            };
        }
        const destination = ports.resolvePullDestination(loaded.lab, args.destinationPath || ports.defaultPullDestination(loaded.lab, guestPullDestinationName(ports.destinationTimestamp())));
        if (!destination.ok) {
            return destination;
        }
        const policy = normalizeGuestTransferPolicy(args);
        /** @type {import("../ports/qemu-guest-transfer.mjs").QemuGuestTransport} */
        const transport = {
            action: "pull",
            labId: loaded.lab.id,
            guestPath: guest.guestPath,
            destinationPath: destination.destinationPath,
            replace: args.replace !== false,
            allowedGuestRoots: guest.allowedGuestRoots
        };
        if (args.dryRun === true) {
            return {
                ok: true, ownerId: ports.ownerId(), dryRun: true, lab: publicLab(loaded.lab), transport, policy
            };
        }
        if (ports.exists(destination.destinationPath)) {
            if (args.replace === false) {
                return {
                    ok: false, error: "guest-pull-destination-exists", destinationPath: destination.destinationPath
                };
            }
        }
        const runner = ports.transportRunner(loaded.lab);
        if (typeof runner !== "function") {
            return {
                ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport, policy
            };
        }
        const preflight = ports.preflightTransport(loaded.lab, transport);
        if (!preflight.ok) {
            return {
                ...preflight, transport, policy
            };
        }
        if (ports.exists(destination.destinationPath)) {
            ports.removeDirectory(destination.destinationPath);
        }
        ports.ensureDirectory(destination.destinationPath);
        const result = publicGuestTransferResult(runner(transport));
        if (result === null) {
            ports.removeDirectory(destination.destinationPath);
            return {
                ok: false, error: "guest-transport-unavailable", reason: "no-bounded-guest-transport-runner-configured", transport, policy, cleanedDestination: true
            };
        }
        if (!guestTransferSucceeded(result)) {
            ports.removeDirectory(destination.destinationPath);
            const failedAt = ports.clock();
            const lab = recordOperation(loaded.lab, {
                type: "guest_pull_failed",
                guestPath: guest.guestPath,
                destinationPath: destination.destinationPath,
                completedAt: failedAt,
                error: "guest-pull-failed"
            });
            return {
                ok: false, error: "guest-pull-failed", lab: publicLab(lab), result, transport, policy, cleanedDestination: true
            };
        }
        const plan = ports.scanCopySource(destination.destinationPath, policy);
        if (!plan.ok) {
            ports.removeDirectory(destination.destinationPath);
            const failedAt = ports.clock();
            const lab = recordOperation(loaded.lab, {
                type: "guest_pull_failed",
                guestPath: guest.guestPath,
                destinationPath: destination.destinationPath,
                completedAt: failedAt,
                error: plan.error || "guest-pull-policy-failed"
            });
            return {
                ...plan, lab: publicLab(lab), destinationPath: destination.destinationPath, cleanedDestination: true
            };
        }
        const completedAt = ports.clock();
        const lab = recordOperation(loaded.lab, {
            type: "guest_pull",
            guestPath: guest.guestPath,
            destinationPath: destination.destinationPath,
            files: plan.files.length,
            bytes: plan.totalBytes,
            completedAt
        });
        return {
            ok: true,
            ownerId: ports.ownerId(),
            lab: publicLab(lab),
            result,
            transport: {
                ...transport, files: plan.files.length, bytes: plan.totalBytes
            },
            policy
        };
    }
    return {
        push, pull
    };
}
