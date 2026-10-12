import { desktopField, desktopRecord, desktopSucceeded, desktopReadOnly, desktopInputFailure, DESKTOP_CONSOLE_TOOLS, hyperVConsoleKeyTokens, hyperVConsoleText, hyperVConsolePixel, validateWindowHandle, type DesktopRecord, type DesktopRequest, type DesktopTarget, type DesktopOutcome, type DesktopFailureCategory, type DesktopPreparedEffect, type DesktopDirectAction, type DesktopGuestIntent } from '../domain/hyper-v-desktop-transfer.js';
import type { HyperVDesktopTransferPorts } from '../ports/hyper-v-desktop-transfer.js';
export function createHyperVDesktopTransferApplication<Console, Stage, Bytes extends {
    readonly length: number;
}, Connection>(ports: HyperVDesktopTransferPorts<Console, Stage, Bytes, Connection>) {
    async function finalizeStage(operation:()=>Promise<DesktopOutcome>, stage:()=>{handle:Stage}|null, fallback:string):Promise<DesktopOutcome> {
        let outcome:DesktopOutcome;
        try { outcome=await operation(); }
        catch(error) { outcome={kind:'failure',category:'provider-failed',facts:{ok:false,error:ports.stateErrorCode(error)|| (error instanceof Error?error.message:fallback)}}; }
        const allocated=stage();
        if(allocated)try { ports.disposeStage(allocated.handle); }
        catch(error) {
            const cleanupError=ports.stateErrorCode(error)||(error instanceof Error?error.message:'hyper-v-transfer-cleanup-failed');
            outcome={kind:'failure',category:outcome.kind==='failure'?outcome.category:'provider-failed',facts:{...outcome.facts,ok:false,error:outcome.kind==='failure'?outcome.facts.error:'hyper-v-transfer-cleanup-failed',detail:{primary:outcome.facts,cleanupError,publicationCompleted:outcome.kind==='success'}}};
        }
        return outcome;
    }
    async function invoke(ownerId: string, parsed: DesktopRequest, match: DesktopTarget, nativeIntent?: DesktopGuestIntent): Promise<DesktopOutcome> {
        const deviceId = String(parsed.deviceId);
        let device = match.device;
        const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
        if (!powershell)
            return {
                kind: 'failure', category: 'invalid', facts: {
                    ok: false, error: "missing-provider-command", missing: ["powershell"], backend: match.backend, deviceId
                }
            };
        const initialIncarnationId = ports.incarnation(device);
        const pendingSnapshotJournal = ports.pendingJournal(ownerId, match.stateKey, deviceId);
        const cursorMove = parsed.tool === "device_cursor_position" && (parsed.params.x !== undefined || parsed.params.y !== undefined);
        if (!desktopReadOnly(parsed.tool) || cursorMove || pendingSnapshotJournal) {
            const expectedIncarnationId = parsed.params.incarnationId;
            if (!ports.validIncarnation(expectedIncarnationId)) {
                return {
                    kind: 'failure', category: 'conflict', facts: {
                        ok: false, error: "hyper-v-incarnation-required", ownerId, backend: match.backend, deviceId, tool: parsed.tool
                    }
                };
            }
            if (!initialIncarnationId || expectedIncarnationId !== initialIncarnationId) {
                return {
                    kind: 'failure', category: 'conflict', facts: {
                        ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend: match.backend, deviceId, tool: parsed.tool
                    }
                };
            }
        }
        const reconciliation = await ports.repair(ownerId, match.stateKey, deviceId, device, powershell);
        if (!reconciliation.ok)
            return {
                kind: 'failure', category: reconciliation.category, facts: {
                    ok: false, error: reconciliation.error, ownerId, backend: match.backend, deviceId, ...(reconciliation.detail ? {
                        detail: reconciliation.detail
                    } : {})
                }
            };
        device = reconciliation.device;
        const vmId = typeof device.vmId === "string" ? device.vmId : null;
        const vmName = typeof device.vmName === "string" ? device.vmName : null;
        const diskPath = typeof device.diskPath === "string" ? device.diskPath : null;
        const incarnationId = ports.incarnation(device);
        if (!vmId || !vmName || !diskPath || !incarnationId) {
            return {
                kind: 'failure', category: 'conflict', facts: {
                    ok: false, error: "missing-provider-metadata", missing: ["vmId", "vmName", "diskPath", "incarnationId"], backend: match.backend, deviceId
                }
            };
        }
        if (parsed.tool === "device_window_list" || parsed.tool === "device_focus_window") {
            if (match.backend === "windows-vm" && typeof parsed.params.helperTimeoutMs === "number" && parsed.params.helperTimeoutMs < 30000) {
                return {
                    kind: 'failure', category: 'invalid', facts: {
                        ok: false, error: parsed.tool === "device_focus_window" ? "window-focus-timeout-too-short" : "window-list-timeout-too-short", minimumTimeoutMs: 30000, deviceId
                    }
                };
            }
            let windowHandle: string | null = null;
            if (parsed.tool === "device_focus_window") {
                windowHandle = String(parsed.params.handle);
                validateWindowHandle(windowHandle);
            }
            const result = await invoke(ownerId, {
                ...parsed, tool: "device_exec",
                params: {
                    ...parsed.params, incarnationId,

                },
            }, {
                ...match, device
            }, parsed.tool === "device_focus_window" ? {kind:"focus",handle:windowHandle!} : {kind:"window-list"});
            if (result.kind !== 'success')
                return desktopInputFailure(result, parsed.tool);
            const payload: DesktopRecord = desktopRecord(result.facts) ? result.facts : {};
            const resultRecord: DesktopRecord = desktopRecord(payload.result) ? payload.result : {};
            try {
                if (parsed.tool === "device_focus_window" ? resultRecord.focused !== true : !desktopRecord(resultRecord.windows))
                    throw new Error("window-list-invalid-result");
                return {
                    kind: 'success', facts: {
                        ok: true, result: {
                            deviceId, tool: parsed.tool, ...(parsed.tool === "device_focus_window" ? {ok:true} : resultRecord.windows as DesktopRecord),
                        }
                    }
                };
            }
            catch (error) {
                return {
                    kind: 'failure', category: 'provider-failed', facts: {
                        ok: false, error: error instanceof Error ? error.message : "window-list-invalid-result", deviceId, tool: parsed.tool
                    }
                };
            }
        }
        if (DESKTOP_CONSOLE_TOOLS.has(parsed.tool)) {
            const identity = {
                selector: {
                    kind: "id" as const, id: vmId
                },
                expectedName: vmName,
                expectedNotes: ports.ownershipNotes(ownerId, deviceId, incarnationId),
            };
            const client = ports.createConsole(powershell);
            const errorResult = (category: DesktopFailureCategory, error: string): DesktopOutcome => ({
                kind: 'failure', category, facts: {
                    ok: false, error, ownerId, backend: match.backend, deviceId, tool: parsed.tool,
                    ...(["hyper-v-console-screenshot-required", "hyper-v-console-geometry-changed"].includes(error)
                        ? {
                            remedy: "Call device_screenshot again, then use its current incarnationId and image coordinates."
                        } : error === "hyper-v-display-unavailable"
                        ? {
                            remedy: "Start the VM and wait for its desktop, then call device_screenshot."
                        } : error === "hyper-v-console-identity-mismatch"
                        ? {
                            remedy: "Call device_inventory for the current owner VM, then take a new screenshot."
                        } : {}),
                },
            });
            return await ports.withConsoleLock(ownerId, match.backend || "", deviceId, async () => {
                try {
                    let inputProvider = "hyper-v-console";
                    if (parsed.tool === "device_screenshot") {
                        const capture = await ports.capture(client, identity);
                        const capturedAt = ports.timestamp();
                        ports.rememberFrame(ownerId, match.backend || "", deviceId, {
                            incarnationId, width: capture.width, height: capture.height,
                            nativeWidth: capture.nativeWidth, nativeHeight: capture.nativeHeight, capturedAt,
                        });
                        return {
                            kind: 'success', capture, facts: {
                                ok: true, result: {
                                    ownerId, backend: match.backend, deviceId, tool: parsed.tool, provider: "hyper-v-console",
                                    width: capture.width, height: capture.height, incarnationId, capturedAt,
                                }
                            }
                        };
                    }
                    if (parsed.tool === "device_cursor_position" && !cursorMove) {
                        const cursor = await ports.cursor(client, identity);
                        return {
                            kind: 'success', facts: {
                                ok: true, result: {
                                    ownerId, backend: match.backend, deviceId, tool: parsed.tool, provider: "hyper-v-console", ...cursor, incarnationId
                                }
                            }
                        };
                    }
                    if (parsed.tool === "device_key") {
                        const keys = hyperVConsoleKeyTokens(parsed.params.key);
                        if (!keys)
                            return errorResult("invalid", "hyper-v-console-key-invalid");
                        await ports.input(client, {
                            ...identity, action: "key", keys
                        });
                    }
                    else if (parsed.tool === "device_type") {
                        const text = hyperVConsoleText(parsed.params.text);
                        if (text === null)
                            return errorResult("invalid", "hyper-v-console-text-invalid");
                        if (match.backend === "linux-vm") {
                            // Hyper-V's WMI TypeText reports success even when Linux does not
                            // receive the characters. Type through the verified guest X11
                            // session while retaining the owner/incarnation and per-VM lock.
                            const currentVms = await ports.vms(client, identity.selector.id);
                            if (currentVms.length !== 1 || currentVms[0].id.toLowerCase() !== vmId.toLowerCase()
                                || currentVms[0].name !== vmName || currentVms[0].notes !== identity.expectedNotes) {
                                return errorResult("conflict", "hyper-v-console-identity-mismatch");
                            }
                            if (currentVms[0].state !== "Running")
                                return errorResult("conflict", "hyper-v-display-unavailable");
                            const typed = await invoke(ownerId, {
                                ...parsed,
                                tool: "device_exec",
                                params: {
                                    ...parsed.params
                                },
                            }, match, {kind:"type",text});
                            if (typed.kind !== 'success')
                                return desktopInputFailure(typed, parsed.tool);
                            inputProvider = "hyper-v-ssh-x11";
                        }
                        else {
                            await ports.input(client, {
                                ...identity, action: "type", text
                            });
                        }
                    }
                    else {
                        const frame = ports.frame(ownerId, match.backend || "", deviceId, incarnationId);
                        if (!frame)
                            return errorResult("conflict", "hyper-v-console-screenshot-required");
                        const x = hyperVConsolePixel(parsed.tool === "device_drag" ? parsed.params.x1 : parsed.params.x, frame.width);
                        const y = hyperVConsolePixel(parsed.tool === "device_drag" ? parsed.params.y1 : parsed.params.y, frame.height);
                        if (x === null || y === null)
                            return errorResult("invalid", "hyper-v-console-pixel-invalid");
                        const pointer = {
                            ...identity, x, y, width: frame.width, height: frame.height, nativeWidth: frame.nativeWidth, nativeHeight: frame.nativeHeight
                        };
                        if (parsed.tool === "device_drag") {
                            const x2 = hyperVConsolePixel(parsed.params.x2, frame.width);
                            const y2 = hyperVConsolePixel(parsed.params.y2, frame.height);
                            if (x2 === null || y2 === null)
                                return errorResult("invalid", "hyper-v-console-pixel-invalid");
                            await ports.input(client, {
                                ...pointer, action: "drag", x2, y2, durationMs: Number(parsed.params.durationMs ?? 700)
                            });
                        }
                        else if (parsed.tool === "device_click" || parsed.tool === "device_double_click") {
                            const button = parsed.params.button === undefined ? "left" : parsed.params.button;
                            if (button !== "left" && button !== "right")
                                return errorResult("invalid", "hyper-v-console-button-invalid");
                            await ports.input(client, {
                                ...pointer, action: parsed.tool === "device_click" ? "click" : "doubleClick", button
                            });
                        }
                        else if (parsed.tool === "device_scroll") {
                            const direction = parsed.params.direction;
                            if (direction === "left" || direction === "right")
                                return errorResult("invalid", "hyper-v-console-scroll-unsupported");
                            if (direction !== "up" && direction !== "down")
                                return errorResult("invalid", "hyper-v-console-scroll-direction-invalid");
                            const amount = parsed.params.amount === undefined ? 1 : parsed.params.amount;
                            if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > 10)
                                return errorResult("invalid", "hyper-v-console-scroll-amount-invalid");
                            if (match.backend === "linux-vm") {
                                // The synthetic mouse wheel does not reach the Linux X11 session. Keep the
                                // console pointer move (proven by clicks), then press the X11 wheel buttons.
                                await ports.input(client, {
                                    ...pointer, action: "cursor"
                                });
                                const scrolled = await invoke(ownerId, {
                                    ...parsed,
                                    tool: "device_exec",
                                    params: {
                                        ...parsed.params
                                    },
                                }, match, {kind:"scroll",direction,amount});
                                if (scrolled.kind !== 'success')
                                    return desktopInputFailure(scrolled, parsed.tool);
                                inputProvider = "hyper-v-ssh-x11";
                            }
                            else {
                                await ports.input(client, {
                                    ...pointer, action: "scroll", direction, amount
                                });
                            }
                        }
                        else if (parsed.tool === "device_cursor_position") {
                            await ports.input(client, {
                                ...pointer, action: "cursor"
                            });
                        }
                        else
                            return errorResult("unsupported", "broker-device-tool-not-supported");
                    }
                    return {
                        kind: 'success', facts: {
                            ok: true, result: {
                                ownerId, backend: match.backend, deviceId, tool: parsed.tool, provider: inputProvider, incarnationId, applied: true
                            }
                        }
                    };
                }
                catch (error) {
                    const providerError = ports.providerError(error);
                    const code = providerError ? providerError.code : ports.boundedErrorCode(error, "hyper-v-console-operation-failed");
                    const category: DesktopFailureCategory = providerError?.validation ? 'invalid'
                        : ["hyper-v-console-identity-mismatch", "hyper-v-console-geometry-changed", "hyper-v-display-unavailable"].includes(code) ? 'conflict'
                            : code === "hyper-v-console-wmi-access-denied" ? 'denied' : 'provider-failed';
                    return errorResult(category, code);
                }
            });
        }
        if (match.backend === "linux-vm" && (parsed.tool === "device_exec" || parsed.tool === "device_upload" || parsed.tool === "device_download")) {
            const deviceRoot = desktopField(device, "deviceRoot");
            const privateRoot = desktopField(device, "privateRoot");
            const sshPrivateKeyPath = desktopField(device, "sshPrivateKeyPath");
            const sshHostPublicKeyPath = desktopField(device, "sshHostPublicKeyPath");
            const sshHostKeyFingerprint = desktopField(device, "sshHostKeyFingerprint");
            const knownHostsPath = desktopField(device, "sshKnownHostsPath");
            const guestUsername = desktopField(device, "guestUsername");
            const networkAddress = desktopField(device, "networkAddress");
            const expected = ports.roots(ownerId, "linux-vm", deviceId);
            const expectedRoot = expected.deviceRoot, expectedPrivateRoot = expected.privateRoot;
            if (deviceRoot !== expectedRoot
                || privateRoot !== expectedPrivateRoot
                || sshPrivateKeyPath !== expected.sshPrivateKeyPath
                || sshHostPublicKeyPath !== expected.sshHostPublicKeyPath
                || knownHostsPath !== expected.knownHostsPath
                || !sshHostKeyFingerprint || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(sshHostKeyFingerprint)
                || !guestUsername || !networkAddress) {
                return {
                    kind: 'failure', category: 'conflict', facts: {
                        ok: false, error: "hyper-v-linux-guest-metadata-invalid", backend: match.backend, deviceId
                    }
                };
            }
            try {
                ports.assertPrivateRoot(ownerId, "linux-vm", deviceId, privateRoot);
                if (!ports.readableSecret(sshPrivateKeyPath, "hyper-v-linux-ssh-private-key"))
                    throw new Error("hyper-v-linux-ssh-private-key-unavailable");
                if (!ports.sshIdentity(ownerId, deviceId, sshHostPublicKeyPath, knownHostsPath, networkAddress, sshHostKeyFingerprint))
                    throw new Error("hyper-v-linux-ssh-host-identity-invalid");
            }
            catch (error) {
                return {
                    kind: 'failure', category: 'conflict', facts: {
                        ok: false, error: ports.stateErrorCode(error) || (error instanceof Error ? error.message : "hyper-v-linux-ssh-private-key-invalid"), backend: match.backend, deviceId
                    }
                };
            }
            const timeoutMs = Math.min(300000, Math.max(1000, typeof parsed.params.helperTimeoutMs === "number" ? parsed.params.helperTimeoutMs : 30000));
            const common = {
                deviceRoot, privateRoot, sshPrivateKeyPath, knownHostsPath, guestUsername, networkAddress, timeoutMs
            };
            let preparedEffect: DesktopPreparedEffect;
            let localPath: string | null = null;
            let stage: {
                handle: Stage;
                path: string;
            } | null = null;
            let sourceBytes: number | null = null;
            let downloadMaxBytes: number | null = null;
            return finalizeStage(async () => {
                try {
                    if (parsed.tool === "device_exec") {
                        const connection = ports.guestConnection("exec");
                        if (!connection)
                            return {
                                kind: 'failure', category: 'unavailable', facts: {
                                    ok: false, error: "missing-provider-command", missing: ["ssh"], backend: match.backend, deviceId
                                }
                            };
                        preparedEffect = ports.prepareGuestExec(common, connection, nativeIntent ?? {kind:"exec",command:typeof parsed.params.command === "string" ? parsed.params.command : ""});
                    }
                    else {
                        const rawLocalPath = parsed.localPath || "";
                        localPath = ports.localPath(rawLocalPath, "hyper-v-linux-guest-transfer");
                        if (parsed.tool === "device_upload") {
                            const connection = ports.guestConnection("upload");
                            if (!connection)
                                return {
                                    kind: 'failure', category: 'unavailable', facts: {
                                        ok: false, error: "missing-provider-command", missing: ["scp"], backend: match.backend, deviceId
                                    }
                                };
                            stage = ports.allocateStage(privateRoot, "upload", "hyper-v-linux-guest-transfer-staging");
                            const maxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                            const source = ports.readSource(localPath, "hyper-v-linux-guest-upload", maxBytes);
                            if (source === null) {
                                return {
                                    kind: 'failure', category: 'missing', facts: {
                                        ok: false, error: "hyper-v-linux-guest-upload-source-missing", backend: match.backend, deviceId
                                    }
                                };
                            }
                            sourceBytes = source.length;
                            ports.writeStage(privateRoot, stage.handle, source, "hyper-v-linux-guest-upload-staging");
                            preparedEffect = ports.prepareUpload(common, connection, stage.path, parsed.remotePath || "");
                        }
                        else {
                            downloadMaxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                            const connection = ports.guestConnection("read");
                            if (!connection)
                                return {
                                    kind: 'failure', category: 'unavailable', facts: {
                                        ok: false, error: "missing-provider-command", missing: ["ssh"], backend: match.backend, deviceId
                                    }
                                };
                            const remotePath = parsed.remotePath || "";
                            preparedEffect = ports.prepareRemoteRead(common, connection, remotePath, downloadMaxBytes);
                        }
                    }
                }
                catch (error) {
                    return {
                        kind: 'failure', category: 'invalid', facts: {
                            ok: false, error: ports.stateErrorCode(error) || (error instanceof Error ? error.message : "invalid-hyper-v-linux-guest-options"), backend: match.backend, deviceId
                        }
                    };
                }
                const outputLimit = parsed.tool === "device_download" && downloadMaxBytes !== null
                    ? downloadMaxBytes + 1
                    : 32 * 1024;
                const execution = await preparedEffect({ timeoutMs, outputLimit });
                if (!desktopSucceeded(execution) || execution.action !== (parsed.tool === "device_upload" ? "upload" : parsed.tool === "device_download" ? "download" : "exec")) {
                    return {
                        kind: 'failure', category: 'provider-failed', facts: {
                            ok: false,
                            error: "hyper-v-linux-guest-provider-failed",
                            ownerId,
                            backend: match.backend,
                            deviceId,
                            execution: ports.redactExecution(execution, "hyper-v-linux-guest-provider-failed"),
                        },
                    };
                }
                let bytes = sourceBytes;
                if (parsed.tool === "device_download" && localPath) {
                    try {
                        const maxBytes = downloadMaxBytes || 16 * 1024 * 1024;
                        const downloaded = execution.artifact as Bytes | undefined;
                        if (!downloaded) throw new Error("hyper-v-linux-guest-download-invalid-artifact");
                        if (downloaded.length > maxBytes) {
                            return {
                                kind: 'failure', category: 'too-large', facts: {
                                    ok: false, error: "hyper-v-linux-guest-download-source-too-large", ownerId, backend: match.backend, deviceId, bytes: downloaded.length, maxFileBytes: maxBytes
                                }
                            };
                        }
                        bytes = downloaded.length;
                        ports.writeDestination(localPath, downloaded, "hyper-v-linux-guest-download");
                    }
                    catch (error) {
                        return {
                            kind: 'failure', category: 'provider-failed', facts: {
                                ok: false, error: ports.stateErrorCode(error) || "hyper-v-linux-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId
                            }
                        };
                    }
                }
                return {
                    kind: 'success', facts: {
                        ok: true, result: {
                            ownerId, backend: match.backend, stateKey: match.stateKey, deviceId, tool: parsed.tool, provider: parsed.tool === "device_upload" ? "hyper-v-scp" : "hyper-v-ssh", status: 0, stdout: parsed.tool === "device_download" ? "" : execution.stdout || "", stderr: execution.stderr || "", ...(execution.windows ? {windows:execution.windows}:{}), ...(execution.focused ? {focused:true}:{}), ...(localPath ? {
                                localPath
                            } : {}), ...(parsed.remotePath ? {
                                remotePath: parsed.remotePath
                            } : {}), ...(bytes !== null ? {
                                bytes
                            } : {}), startsDevices: false
                        }
                    }
                };
            }, () => stage, "hyper-v-linux-guest-provider-failed");
        }
        if (parsed.tool === "device_exec" || parsed.tool === "device_upload" || parsed.tool === "device_download") {
            const deviceRoot = typeof device.deviceRoot === "string" ? device.deviceRoot : null;
            const privateRoot = typeof device.privateRoot === "string" ? device.privateRoot : null;
            const credentialPath = typeof device.guestCredentialPath === "string" ? device.guestCredentialPath : null;
            const expected = ports.roots(ownerId, "windows-vm", deviceId);
            const expectedRoot = expected.deviceRoot, expectedPrivateRoot = expected.privateRoot;
            const expectedCredential = expected.credentialPath;
            if (deviceRoot !== expectedRoot || privateRoot !== expectedPrivateRoot || credentialPath !== expectedCredential) {
                return {
                    kind: 'failure', category: 'conflict', facts: {
                        ok: false, error: "hyper-v-guest-metadata-invalid", backend: match.backend, deviceId
                    }
                };
            }
            try {
                ports.assertPrivateRoot(ownerId, "windows-vm", deviceId, privateRoot);
                const credentialAvailable = ports.readableSecret(credentialPath, "hyper-v-guest-credential");
                if (!credentialAvailable)
                    return {
                        kind: 'failure', category: 'conflict', facts: {
                            ok: false, error: "hyper-v-guest-credential-unavailable", backend: match.backend, deviceId
                        }
                    };
            }
            catch (error) {
                return {
                    kind: 'failure', category: 'conflict', facts: {
                        ok: false, error: ports.stateErrorCode(error) || "hyper-v-guest-credential-invalid", backend: match.backend, deviceId
                    }
                };
            }
            let guestAction: DesktopDirectAction;
            let transferLocalPath: string | null = null;
            let transferStage: {
                handle: Stage;
                path: string;
            } | null = null;
            let uploadSourceBytes: number | null = null;
            return finalizeStage(async () => {
                try {
                    if (parsed.tool === "device_exec") {
                        guestAction = {
                            action: "exec", command: typeof parsed.params.command === "string" ? parsed.params.command : ""
                        };
                    }
                    else {
                        const rawLocalPath = parsed.localPath || "";
                        const localPath = ports.localPath(rawLocalPath, "hyper-v-guest-transfer");
                        transferLocalPath = localPath;
                        if (parsed.tool === "device_upload") {
                            const maxBytes = typeof parsed.params.maxFileBytes === "number"
                                ? Math.min(parsed.params.maxFileBytes, 128 * 1024 * 1024)
                                : 16 * 1024 * 1024;
                            const source = ports.readSource(localPath, "hyper-v-guest-upload", maxBytes);
                            if (source === null)
                                return {
                                    kind: 'failure', category: 'missing', facts: {
                                        ok: false, error: "hyper-v-guest-upload-source-missing", backend: match.backend, deviceId
                                    }
                                };
                            uploadSourceBytes = source.length;
                            transferStage = ports.allocateStage(privateRoot, "upload", "hyper-v-guest-upload-staging");
                            ports.writeStage(privateRoot, transferStage.handle, source, "hyper-v-guest-upload-staging");
                            guestAction = {
                                action: "upload", localPath: transferStage.path, remotePath: parsed.remotePath || ""
                            };
                        }
                        else {
                            transferStage = ports.allocateStage(privateRoot, "download", "hyper-v-guest-download-staging");
                            const maxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                            guestAction = {
                                action: "download", localPath: transferStage.path, remotePath: parsed.remotePath || "", maxBytes
                            };
                        }
                    }
                }
                catch (error) {
                    return {
                        kind: 'failure', category: 'invalid', facts: {
                            ok: false, error: ports.stateErrorCode(error) || (error instanceof Error ? error.message : "invalid-hyper-v-guest-options"), backend: match.backend, deviceId
                        }
                    };
                }
                const timeoutMs = Math.min(300000, Math.max(1000, typeof parsed.params.helperTimeoutMs === "number" ? parsed.params.helperTimeoutMs : 30000));
                let nativeObservation;
                let typedResult;
                try {
                    nativeObservation = await ports.direct(powershell, timeoutMs, {
                        selector: {
                            kind: "id", id: vmId
                        }, expectedName: vmName,
                        expectedNotes: ports.ownershipNotes(ownerId, deviceId, incarnationId), credentialPath,
                    }, guestAction, nativeIntent);
                    typedResult = nativeObservation.result;
                }
                catch (error) {
                    const providerError = ports.providerError(error);
                    const code = providerError ? providerError.code : "guest-executor-failed";
                    return {
                        kind: 'failure', category: providerError?.validation ? 'invalid' : 'provider-failed',
                        facts: {
                            ok: false,
                            error: "hyper-v-guest-provider-failed",
                            ownerId,
                            backend: match.backend,
                            deviceId,
                            execution: ports.redactExecution({
                                ok:false, mode: "exec", provider: "hyper-v", status: null, error: code
                            }, "hyper-v-guest-provider-failed"),
                        },
                    };
                }
                const observation = nativeObservation?.ok && nativeObservation.action === guestAction.action && typedResult ? {...typedResult} : null;
                if (!observation)
                    return {
                        kind: 'failure', category: 'provider-failed', facts: {
                            ok: false, error: "hyper-v-guest-invalid-result", ownerId, backend: match.backend, deviceId
                        }
                    };
                if (parsed.tool === "device_download" && transferLocalPath && transferStage) {
                    try {
                        const maxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                        const downloaded = ports.readStage(transferStage.handle, maxBytes);
                        const downloadedBytes = downloaded?.length ?? null;
                        if (downloaded === null || downloadedBytes === null || !("bytes" in observation) || observation.bytes !== downloadedBytes) {
                            return {
                                kind: 'failure', category: 'provider-failed', facts: {
                                    ok: false, error: "hyper-v-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId
                                }
                            };
                        }
                        ports.writeDestination(transferLocalPath, downloaded, "hyper-v-guest-download");
                        observation.localPath = transferLocalPath;
                    }
                    catch (error) {
                        return {
                            kind: 'failure', category: 'provider-failed', facts: {
                                ok: false, error: ports.stateErrorCode(error) || "hyper-v-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId
                            }
                        };
                    }

                }
                else if (parsed.tool === "device_upload" && transferLocalPath && transferStage) {
                    if (!("bytes" in observation) || observation.bytes !== uploadSourceBytes) {
                        return {
                            kind: 'failure', category: 'provider-failed', facts: {
                                ok: false, error: "hyper-v-guest-upload-invalid-result", ownerId, backend: match.backend, deviceId
                            }
                        };
                    }
                    observation.localPath = transferLocalPath;
                }
                const guestFailed = nativeObservation?.guestFailed === true;
                return {
                    ...(guestFailed ? { kind: 'failure' as const, category: 'guest-failed' as const } : { kind: 'success' as const }),
                    facts: {
                        ok: !guestFailed,
                        ...(guestFailed ? {
                            error: "hyper-v-guest-command-failed"
                        } : {}),
                        result: {
                            ownerId, backend: match.backend, stateKey: match.stateKey, deviceId, tool: parsed.tool, provider: "hyper-v-powershell-direct", ...observation, ...(nativeObservation?.windows ? {windows:nativeObservation.windows}:{}), ...(nativeObservation?.focused ? {focused:true}:{}), startsDevices: false
                        },
                    },
                };
            }, () => transferStage, "hyper-v-guest-provider-failed");
        }
        return {
            kind: 'failure', category: 'unsupported', facts: {
                ok: false, error: "broker-hyper-v-tool-not-supported"
            }
        };
    }
    return {
        invoke
    };
}
