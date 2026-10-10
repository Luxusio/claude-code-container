import { mayReplaceBrokerProtocol, brokerOwnerCleanupSucceeded, supervisionErrorDetail } from "../domain/broker-supervision.mjs";

/** @param {import("../ports/broker-supervision.mjs").BrokerSupervisionPorts} ports */
export function createBrokerSupervision(ports) {
    function cleanupOwnedBrokerChildrenOnExit() {
        for (const [pid, owned] of ports.ownedChildrenEntries()) {
            const child = owned?.child || owned;
            const expectedStartToken = owned?.processStartToken || null;
            if (expectedStartToken && ports.readBrokerProcessStartToken(pid) === expectedStartToken) {
                try { ports.signalChild(child, "SIGTERM"); } catch { /* preserve runtime evidence */ }
            }
            ports.deleteOwnedChild(pid);
        }
    }

    async function cleanupOwnedBrokerChildren() {
        /** @type {Map<number, string>} */
        const confirmedOwnedExits = new Map();
        for (const [pid, owned] of ports.ownedChildrenEntries()) {
            const child = owned?.child || owned;
            const expectedStartToken = owned?.processStartToken || null;
            if (!expectedStartToken || ports.readBrokerProcessStartToken(pid) !== expectedStartToken) {
                ports.deleteOwnedChild(pid);
                continue;
            }
            let termination = await ports.terminateBrokerProcess(pid, 500, expectedStartToken);
            if (!termination.ok
                && !termination.reason
                && ports.readBrokerProcessStartToken(pid) === expectedStartToken) {
                try { ports.signalChild(child, "SIGKILL"); } catch { /* checked below */ }
                termination = {
                    ok: await ports.waitForProcessExit(pid, 500),
                    pid,
                    reason: "forced-signal-cleanup",
                };
            }
            if (termination.ok && !ports.pidAlive(pid)) confirmedOwnedExits.set(pid, expectedStartToken);
            ports.deleteOwnedChild(pid);
        }
        const runtime = ports.readBrokerRuntime();
        const confirmedRuntimeExit = runtime
            && confirmedOwnedExits.get(Number(runtime.pid)) === runtime.processStartToken;
        if (confirmedRuntimeExit
            && runtime.managedBy === "device-lab-mcp"
            && runtime.ownerId === ports.ownerId()) {
            ports.removeBrokerRuntime(runtime);
        }
    }

    /** @param {import("../domain/broker-supervision.mjs").BrokerRuntime} runtime @param {number} port @param {import("../domain/broker-supervision.mjs").BrokerStatus|undefined} statusBroker @param {import("../domain/broker-supervision.mjs").BrokerSupervisionOptions} [options] */
    async function replaceVerifiedOwnedLegacyBroker(runtime, port, statusBroker, options = {}) {
        if (!mayReplaceBrokerProtocol(statusBroker?.protocolVersion, ports.protocolVersion)) return false;
        const verified = ports.verifiedOwnedLegacyBrokerProcess(
            runtime,
            port,
            statusBroker,
            options.portProcessResolver,
        );
        if (!verified) return false;
        const termination = await ports.terminateBrokerProcess(verified.pid, 3000, runtime.processStartToken);
        if (!termination.ok) return false;
        ports.deleteOwnedChild(verified.pid);
        return ports.removeBrokerRuntime(runtime);
    }

    /** @param {import("../domain/broker-supervision.mjs").BrokerSupervisionOptions} [options] @returns {Promise<import("../domain/broker-supervision.mjs").BrokerSetupResult>} */
    async function ensureBroker(options = {}) {
        const operation = ports.currentOperation();
        const setups = operation?.setups;
        const key = ports.setupCacheKey(options);
        // Only successful setup results are inserted into this operation-local map.
        if (setups?.has(key)) return /** @type {import("../domain/broker-supervision.mjs").BrokerSetupResult} */ (setups.get(key));
        try {
            const result = await ensureBrokerUncached(options);
            if (result.ok && operation?.setups === setups) setups?.set(key, result);
            else if (!result.ok) ports.invalidateBrokerSetup();
            return result;
        } catch (error) {
            ports.invalidateBrokerSetup();
            throw error;
        }
    }

    /** @param {import("../domain/broker-supervision.mjs").BrokerSupervisionOptions} [options] @returns {Promise<import("../domain/broker-supervision.mjs").BrokerSetupResult>} */
    async function ensureBrokerUncached(options = {}) {
        const owner = ports.ownerId();
        const launch = ports.normalizeLaunchOptions(options);
        const before = await ports.probeBrokerHealth(launch);
        if (before.available) {
            const existingRuntime = ports.readBrokerRuntime();
            const compatibility = await ports.probeCccHostBrokerProtocol(before.selected.host, before.selected.port, launch.timeoutMs);
            if (!compatibility.ok) {
                if (existingRuntime?.ownerId === owner && await replaceVerifiedOwnedLegacyBroker(
                    existingRuntime,
                    before.selected.port,
                    compatibility.body?.broker,
                    options,
                )) {
                    return ensureBrokerUncached(options);
                }
                return {
                    ok: false,
                    ownerId: owner,
                    launched: false,
                    reused: false,
                    error: "host-broker-incompatible",
                    runtime: existingRuntime,
                    host: before.selected.host,
                    port: before.selected.port,
                    compatibility,
                    attempts: [...before.attempts, { reason: "host-broker-protocol-mismatch", compatibility }],
                };
            }
            const ownerResolve = await ports.resolveBrokerOwner({
                hostCandidates: [before.selected.host],
                port: before.selected.port,
                timeoutMs: launch.timeoutMs,
            });
            if (ownerResolve.ok) {
                const processVerification = ports.reusableBrokerProcessVerification(
                    existingRuntime,
                    before.selected.port,
                    before.selected.host,
                    { statusBroker: compatibility.body?.broker },
                );
                if (!processVerification.ok) {
                    return {
                        ok: false,
                        ownerId: owner,
                        launched: false,
                        reused: false,
                        error: "broker-runtime-process-unverified",
                        runtime: existingRuntime,
                        host: before.selected.host,
                        port: before.selected.port,
                        ownerResolve,
                        attempts: [...before.attempts, { reason: "broker-reuse-process-unverified", processVerification }],
                    };
                }
                const verifiedRuntime = ports.persistVerifiedBrokerRuntime(
                    existingRuntime,
                    processVerification,
                    compatibility.body?.broker,
                );
                return ports.withSetupEvidence({
                    ok: true,
                    ownerId: owner,
                    launched: false,
                    reused: true,
                    runtime: verifiedRuntime,
                    host: before.selected.host,
                    port: before.selected.port,
                    attempts: [
                        ...before.attempts,
                        { reason: "broker-reuse-process-verified", processVerification },
                        { reason: "broker-owner-resolve-ready", ownerResolve },
                    ],
                }, before, ownerResolve);
            }
            const runtime = ports.readBrokerRuntime();
            const attempts = [...before.attempts, { reason: "broker-owner-resolve-incompatible", ownerResolve }];
            if (
                runtime?.managedBy === "device-lab-mcp"
                && runtime.ownerId === owner
                && Number(runtime.port) === Number(before.selected.port)
                && ports.pidAlive(runtime.pid)
            ) {
                const termination = await ports.terminateVerifiedBrokerRuntime(runtime, 3000, {
                    statusBroker: compatibility.body?.broker,
                });
                attempts.push({ reason: "incompatible-broker-termination", runtime, termination });
                if (!termination.ok) {
                    return {
                        ok: false,
                        ownerId: owner,
                        launched: false,
                        reused: false,
                        error: termination.reason === "unverified-broker-port-process"
                            ? "broker-runtime-process-unverified"
                            : "broker-incompatible-process-still-running",
                        runtime,
                        host: before.selected.host,
                        port: before.selected.port,
                        ownerResolve,
                        attempts,
                    };
                }
                ports.deleteOwnedChild(runtime.pid);
                if (!ports.removeBrokerRuntime(runtime)) return {
                    ok: false, ownerId: owner, error: "broker-runtime-generation-changed", runtime, attempts,
                };
            } else {
                return {
                    ok: false,
                    ownerId: owner,
                    launched: false,
                    reused: false,
                    error: ownerResolve.error || "broker-owner-resolve-unavailable",
                    runtime,
                    host: before.selected.host,
                    port: before.selected.port,
                    ownerResolve,
                    attempts,
                };
            }
        }

        const existing = ports.readBrokerRuntime();
        let expectedLaunchRuntime = existing;
        /** @type {import("../domain/broker-supervision.mjs").BrokerAttempt[]} */
        const stale = [];
        if (existing) {
            const existingPort = Number(existing.port);
            const runtimeTargetsRequestedPort = Number.isInteger(existingPort) && existingPort === Number(launch.port);
            if (existing.ownerId !== owner && runtimeTargetsRequestedPort) {
                return {
                    ok: false,
                    ownerId: owner,
                    error: "runtime-owned-by-another-owner",
                    runtime: existing,
                    attempts: [...before.attempts, { reason: "runtime-owned-by-another-owner", runtime: existing }],
                };
            } else if (existing.ownerId !== owner) {
                stale.push({ reason: "runtime-ignored-for-different-owner-and-port", runtime: existing, requestedPort: launch.port });
            } else if (!ports.pidAlive(existing.pid)) {
                stale.push({ reason: "runtime-pid-not-alive", runtime: existing });
                if (!ports.removeBrokerRuntime(existing)) return {
                    ok: false, ownerId: owner, error: "broker-runtime-generation-changed", runtime: existing,
                    attempts: [...before.attempts, ...stale],
                };
                expectedLaunchRuntime = null;
            } else {
                const existingProbe = await ports.probeBrokerHealth({
                    hostCandidates: [existing.host || launch.host],
                    port: existing.port || launch.port,
                    timeoutMs: launch.timeoutMs,
                });
                if (existingProbe.available) {
                    const compatibility = await ports.probeCccHostBrokerProtocol(existingProbe.selected.host, existingProbe.selected.port, launch.timeoutMs);
                    if (!compatibility.ok) {
                        if (await replaceVerifiedOwnedLegacyBroker(
                            existing,
                            existingProbe.selected.port,
                            compatibility.body?.broker,
                            options,
                        )) {
                            return ensureBrokerUncached(options);
                        }
                        return {
                            ok: false,
                            ownerId: owner,
                            launched: false,
                            reused: false,
                            error: "host-broker-incompatible",
                            runtime: existing,
                            host: existingProbe.selected.host,
                            port: existingProbe.selected.port,
                            compatibility,
                            attempts: [...before.attempts, ...existingProbe.attempts, { reason: "host-broker-protocol-mismatch", compatibility }],
                        };
                    }
                    const ownerResolve = await ports.resolveBrokerOwner({
                        hostCandidates: [existingProbe.selected.host],
                        port: existingProbe.selected.port,
                        timeoutMs: launch.timeoutMs,
                    });
                    if (ownerResolve.ok) {
                        const processVerification = ports.reusableBrokerProcessVerification(
                            existing,
                            existingProbe.selected.port,
                            existingProbe.selected.host,
                            { statusBroker: compatibility.body?.broker },
                        );
                        if (!processVerification.ok) {
                            return {
                                ok: false,
                                ownerId: owner,
                                launched: false,
                                reused: false,
                                error: "broker-runtime-process-unverified",
                                runtime: existing,
                                host: existingProbe.selected.host,
                                port: existingProbe.selected.port,
                                ownerResolve,
                                attempts: [
                                    ...before.attempts,
                                    ...existingProbe.attempts,
                                    { reason: "broker-reuse-process-unverified", processVerification },
                                ],
                            };
                        }
                        const verifiedRuntime = ports.persistVerifiedBrokerRuntime(
                            existing,
                            processVerification,
                            compatibility.body?.broker,
                        );
                        return ports.withSetupEvidence({
                            ok: true,
                            ownerId: owner,
                            launched: false,
                            reused: true,
                            runtime: verifiedRuntime,
                            host: existingProbe.selected.host,
                            port: existingProbe.selected.port,
                            attempts: [
                                ...before.attempts,
                                ...existingProbe.attempts,
                                { reason: "broker-reuse-process-verified", processVerification },
                                { reason: "broker-owner-resolve-ready", ownerResolve },
                            ],
                        }, existingProbe, ownerResolve);
                    }
                    stale.push({ reason: "runtime-owner-resolve-incompatible", runtime: existing, attempts: existingProbe.attempts, ownerResolve });
                    const termination = await ports.terminateVerifiedBrokerRuntime(existing, 1500, {
                        statusBroker: compatibility.body?.broker,
                    });
                    stale.push({ reason: "runtime-owner-resolve-incompatible-termination", runtime: existing, termination });
                    if (!termination.ok) {
                        return {
                            ok: false,
                            ownerId: owner,
                            error: "broker-runtime-process-unverified",
                            runtime: existing,
                            attempts: [...before.attempts, ...stale],
                        };
                    }
                    ports.deleteOwnedChild(existing.pid);
                    if (!ports.removeBrokerRuntime(existing)) return {
                    ok: false, ownerId: owner, error: "broker-runtime-generation-changed", runtime: existing,
                    attempts: [...before.attempts, ...stale],
                };
                expectedLaunchRuntime = null;
                } else {
                    /** @type {import("../domain/broker-supervision.mjs").BrokerStatus|null} */
                    let recoveryStatusBroker = null;
                    const recoveryProbe = await ports.waitForBrokerHealth({
                        host: existing.host || launch.host,
                        port: existing.port || launch.port,
                        timeoutMs: launch.launchTimeoutMs,
                    });
                    if (recoveryProbe.available) {
                        const compatibility = await ports.probeCccHostBrokerProtocol(recoveryProbe.selected.host, recoveryProbe.selected.port, launch.timeoutMs);
                        recoveryStatusBroker = compatibility.body?.broker || null;
                        if (!compatibility.ok) {
                            if (await replaceVerifiedOwnedLegacyBroker(
                                existing,
                                recoveryProbe.selected.port,
                                compatibility.body?.broker,
                                options,
                            )) {
                                return ensureBrokerUncached(options);
                            }
                            return {
                                ok: false,
                                ownerId: owner,
                                launched: false,
                                reused: false,
                                error: "host-broker-incompatible",
                                runtime: existing,
                                host: recoveryProbe.selected.host,
                                port: recoveryProbe.selected.port,
                                compatibility,
                                attempts: [...before.attempts, ...existingProbe.attempts, ...recoveryProbe.attempts, { reason: "host-broker-protocol-mismatch", compatibility }],
                            };
                        }
                        const ownerResolve = await ports.resolveBrokerOwner({
                            hostCandidates: [recoveryProbe.selected.host],
                            port: recoveryProbe.selected.port,
                            timeoutMs: launch.timeoutMs,
                        });
                        if (ownerResolve.ok) {
                            const processVerification = ports.reusableBrokerProcessVerification(
                                existing,
                                recoveryProbe.selected.port,
                                recoveryProbe.selected.host,
                                { statusBroker: compatibility.body?.broker },
                            );
                            if (!processVerification.ok) {
                                return {
                                    ok: false,
                                    ownerId: owner,
                                    launched: false,
                                    reused: false,
                                    error: "broker-runtime-process-unverified",
                                    runtime: existing,
                                    host: recoveryProbe.selected.host,
                                    port: recoveryProbe.selected.port,
                                    ownerResolve,
                                    attempts: [
                                        ...before.attempts,
                                        ...existingProbe.attempts,
                                        ...recoveryProbe.attempts,
                                        { reason: "broker-reuse-process-unverified", processVerification },
                                    ],
                                };
                            }
                            const verifiedRuntime = ports.persistVerifiedBrokerRuntime(
                                existing,
                                processVerification,
                                compatibility.body?.broker,
                            );
                            return ports.withSetupEvidence({
                                ok: true,
                                ownerId: owner,
                                launched: false,
                                reused: true,
                                runtime: verifiedRuntime,
                                host: recoveryProbe.selected.host,
                                port: recoveryProbe.selected.port,
                                attempts: [
                                    ...before.attempts,
                                    ...existingProbe.attempts,
                                    ...recoveryProbe.attempts,
                                    { reason: "broker-reuse-process-verified", processVerification },
                                    { reason: "broker-owner-resolve-ready", ownerResolve },
                                ],
                            }, recoveryProbe, ownerResolve);
                        }
                    }
                    const termination = await ports.terminateVerifiedBrokerRuntime(existing, 3000, {
                        statusBroker: recoveryStatusBroker,
                    });
                    stale.push({
                        reason: "runtime-health-check-failed",
                        runtime: existing,
                        attempts: [...existingProbe.attempts, ...recoveryProbe.attempts],
                        termination,
                    });
                    if (!termination.ok) {
                        return {
                            ok: false,
                            ownerId: owner,
                            error: termination.reason === "unverified-broker-port-process"
                                ? "broker-runtime-process-unverified"
                                : "broker-unresponsive-process-still-running",
                            runtime: existing,
                            attempts: [...before.attempts, ...stale],
                        };
                    }
                    ports.deleteOwnedChild(existing.pid);
                    if (!ports.removeBrokerRuntime(existing)) return {
                    ok: false, ownerId: owner, error: "broker-runtime-generation-changed", runtime: existing,
                    attempts: [...before.attempts, ...stale],
                };
                expectedLaunchRuntime = null;
                }
            }
        }

        const startedAt = ports.timestamp();
        let logPath = ports.pendingLogPath(owner);
        /** @type {number|null} */
        let logFd = null;
        /** @type {import("../domain/broker-supervision.mjs").BrokerChild|null} */
        let launchedChild = null;
        /** @type {import("../domain/broker-supervision.mjs").BrokerRuntime|null} */
        let launchedRuntime = null;
        try {
            if (!ports.executableExists(launch.command)) {
                return {
                    ok: false,
                    ownerId: owner,
                    error: "broker-launch-failed",
                    detail: "executable-not-found",
                    command: launch.command,
                    args: launch.args,
                    logPath,
                    attempts: [...before.attempts, ...stale],
                };
            }
            const log = ports.createBrokerLogFile(owner);
            logPath = log.path;
            logFd = log.descriptor;
            const { child, processStartToken } = await ports.launchOwnedChild(launch, logFd);
            launchedChild = child;
            const runtime = {
                name: ports.brokerName,
                ownerId: owner,
                pid: child.pid || null,
                host: launch.host,
                port: launch.port,
                command: launch.command,
                args: launch.args,
                logPath,
                startedAt,
                processStartToken,
                managedBy: "device-lab-mcp",
            };
            launchedRuntime = runtime;
            if (!ports.writeBrokerRuntime(runtime, expectedLaunchRuntime)) throw new Error("broker-runtime-generation-changed");
            const ready = await ports.waitForBrokerHealth({ host: launch.host, port: launch.port, timeoutMs: launch.launchTimeoutMs });
            if (ready.available) {
                const ownerResolve = await ports.waitForBrokerOwnerResolve(launch.host, launch.port, launch.launchTimeoutMs);
                if (ownerResolve.ok) {
                    const compatibility = await ports.probeCccHostBrokerProtocol(launch.host, launch.port, launch.timeoutMs);
                    if (!compatibility.ok) {
                        const launchCleanup = await ports.cleanupLaunchedBrokerRuntime(runtime, child, 3000);
                        return {
                            ok: false,
                            ownerId: owner,
                            launched: true,
                            reused: false,
                            error: "host-broker-incompatible",
                            runtime,
                            host: launch.host,
                            port: launch.port,
                            compatibility,
                            launchCleanup,
                            attempts: [
                                ...before.attempts,
                                ...stale,
                                ...ready.attempts,
                                { reason: "broker-launch-incompatible", compatibility },
                            ],
                        };
                    }
                    const launchProcessVerification = ports.launchedBrokerProcessVerification(
                        runtime,
                        launch.port,
                        launch.host,
                        compatibility.body?.broker,
                    );
                    const processVerification = launchProcessVerification.verification;
                    if (!processVerification.ok) {
                        const launchCleanup = await ports.cleanupLaunchedBrokerRuntime(runtime, child, 3000);
                        return {
                            ok: false,
                            ownerId: owner,
                            launched: true,
                            reused: false,
                            error: "broker-runtime-process-unverified",
                            runtime,
                            host: launch.host,
                            port: launch.port,
                            launchCleanup,
                            attempts: [
                                ...before.attempts,
                                ...stale,
                                ...ready.attempts,
                                { reason: "broker-launch-process-unverified", processVerification },
                            ],
                        };
                    }
                    const expectedPublishedRuntime = { ...runtime };
                    Object.assign(runtime, launchProcessVerification.runtime);
                    if (!ports.writeBrokerRuntime(runtime, expectedPublishedRuntime)) throw new Error("broker-runtime-generation-changed");
                    return ports.withSetupEvidence({
                        ok: true,
                        ownerId: ownerResolve.ownerId,
                        launched: true,
                        reused: false,
                        runtime,
                        host: launch.host,
                        port: launch.port,
                        attempts: [
                            ...before.attempts,
                            ...stale,
                            ...ready.attempts,
                            { reason: "broker-launch-process-verified", processVerification },
                            { reason: "broker-owner-resolve-ready", ownerResolve },
                        ],
                    }, ready, ownerResolve);
                }
                const launchCleanup = await ports.cleanupLaunchedBrokerRuntime(runtime, child, 3000);
                return {
                    ok: false,
                    ownerId: owner,
                    error: "broker-launch-owner-resolve-timeout",
                    detail: ownerResolve.selected
                        ? `${ownerResolve.error}: ${JSON.stringify(ownerResolve.selected)}`
                        : ports.brokerLogTail(logPath) || `broker owner resolution did not become ready within ${launch.launchTimeoutMs}ms`,
                    runtime,
                    launchCleanup,
                    ownerResolve,
                    attempts: [...before.attempts, ...stale, ...ready.attempts, { reason: "broker-owner-resolve-readiness-timeout", ownerResolve }],
                };
            }
            const launchCleanup = await ports.cleanupLaunchedBrokerRuntime(runtime, child, 1500);
            return {
                ok: false,
                ownerId: owner,
                error: "broker-launch-health-timeout",
                detail: ports.brokerLogTail(logPath) || `broker did not become healthy within ${launch.launchTimeoutMs}ms`,
                runtime,
                launchCleanup,
                attempts: [...before.attempts, ...stale, ...ready.attempts],
            };
        } catch (error) {
            const launchCleanup = launchedRuntime && launchedChild
                ? await ports.cleanupLaunchedBrokerRuntime(launchedRuntime, launchedChild, 1500)
                : (ports.removeBrokerRuntime(launchedRuntime), null);
            return {
                ok: false,
                ownerId: owner,
                error: "broker-launch-failed",
                detail: supervisionErrorDetail(error),
                command: launch.command,
                args: launch.args,
                logPath,
                ...(launchCleanup ? { launchCleanup } : {}),
                attempts: [...before.attempts, ...stale],
            };
        } finally {
            if (logFd !== null) {
                try {
                    ports.closeLog(logFd);
                } catch {
                    // Ignore log close failures.
                }
            }
        }
    }

    /** @param {import("../domain/broker-supervision.mjs").BrokerSupervisionOptions} [options] */
    async function brokerShutdown(options = {}) {
        ports.invalidateBrokerSetup();
        const owner = ports.ownerId();
        const runtime = ports.readBrokerRuntime();
        if (!runtime) return { ok: true, ownerId: owner, stopped: false, reason: "no-runtime" };
        if (runtime.ownerId !== owner) {
            return { ok: false, ownerId: owner, error: "runtime-owned-by-another-owner", runtime };
        }
        if (runtime.managedBy !== "device-lab-mcp") {
            return { ok: false, ownerId: owner, error: "runtime-not-managed-by-device-lab-mcp", runtime };
        }
        const status = await ports.probeCccHostBrokerProtocol(
            runtime.host || "127.0.0.1",
            Number(runtime.port) || 17373,
            options.timeoutMs || 1500,
        );
        const runtimeAlive = ports.pidAlive(runtime.pid);
        if (!runtimeAlive) {
            ports.deleteOwnedChild(runtime.pid);
            ports.removeBrokerRuntime(runtime);
            return {
                ok: true,
                ownerId: owner,
                stopped: false,
                reason: "runtime-pid-not-alive",
                runtime,
            };
        }
        const verified = runtimeAlive
            ? ports.verifiedBrokerProcess(
                runtime,
                Number(runtime.port),
                status.body?.broker || null,
            )
            : null;
        if (runtimeAlive && !verified) {
            return {
                ok: false,
                ownerId: owner,
                error: "broker-runtime-process-unverified",
                stopped: false,
                runtime,
            };
        }
        const cleanup = await ports.cleanupOwner(runtime, {
            reason: "mcp-broker-shutdown",
            stopDevices: options.stopDevices !== false,
            detachPhysical: options.detachPhysical !== false,
        }, options.cleanupTimeoutMs || options.timeoutMs || 1500, status.body?.broker || null, verified);

        let signaled = false;
        if (runtimeAlive && verified) {
            try {
                const termination = await ports.terminateBrokerProcess(
                    verified.pid,
                    options.force === true ? 500 : 1500,
                    verified.processStartToken || runtime.processStartToken || null,
                );
                if (!termination.ok) {
                    return {
                        ok: false,
                        ownerId: owner,
                        error: termination.reason || "broker-shutdown-timeout",
                        stopped: false,
                        runtime,
                        cleanup,
                    };
                }
                signaled = true;
            } catch (error) {
                return { ok: false, ownerId: owner, error: "broker-shutdown-failed", detail: supervisionErrorDetail(error), runtime, cleanup };
            }
        }
        ports.deleteOwnedChild(runtime.pid);
        ports.removeBrokerRuntime(runtime);
        const cleanupOk = brokerOwnerCleanupSucceeded(cleanup);
        return {
            ok: cleanupOk,
            ownerId: owner,
            ...(cleanupOk ? {} : { error: "broker-owner-cleanup-failed" }),
            stopped: signaled,
            runtime,
            cleanup,
        };
    }
    return { ensure: ensureBroker, shutdown: brokerShutdown, cleanupOwnedChildren: cleanupOwnedBrokerChildren, cleanupOwnedOnExit: cleanupOwnedBrokerChildrenOnExit };
}
