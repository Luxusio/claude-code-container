import { desktopField, desktopRecord, desktopSucceeded, desktopReadOnly, desktopInputFailure, DESKTOP_CONSOLE_TOOLS, hyperVConsoleKeyTokens, hyperVConsoleText, hyperVConsolePixel, parseGuestFocusWindow, parseWindowsGuestWindowList, validateWindowHandle, type DesktopRecord, type DesktopRequest, type DesktopTarget, type DesktopRpcResult, type DesktopCommand, type DesktopDirectAction } from '../domain/hyper-v-desktop-transfer.js';
import type { HyperVDesktopTransferPorts } from '../ports/hyper-v-desktop-transfer.js';
export function createHyperVDesktopTransferApplication<Console, Stage, Bytes extends {
    readonly length: number;
}>(ports: HyperVDesktopTransferPorts<Console, Stage, Bytes>) {
    async function invoke(ownerId: string, parsed: DesktopRequest, match: DesktopTarget): Promise<DesktopRpcResult> {
        const deviceId = String(parsed.deviceId);
        let device = match.device;
        const powershell = ports.executable("powershell.exe") || ports.executable("pwsh") || ports.executable("powershell");
        if (!powershell)
            return {
                status: 400, payload: {
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
                    status: 409, payload: {
                        ok: false, error: "hyper-v-incarnation-required", ownerId, backend: match.backend, deviceId, tool: parsed.tool
                    }
                };
            }
            if (!initialIncarnationId || expectedIncarnationId !== initialIncarnationId) {
                return {
                    status: 409, payload: {
                        ok: false, error: "hyper-v-incarnation-conflict", ownerId, backend: match.backend, deviceId, tool: parsed.tool
                    }
                };
            }
        }
        const reconciliation = await ports.repair(ownerId, match.stateKey, deviceId, device, powershell);
        if (!reconciliation.ok)
            return {
                status: reconciliation.status, payload: {
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
                status: 409, payload: {
                    ok: false, error: "missing-provider-metadata", missing: ["vmId", "vmName", "diskPath", "incarnationId"], backend: match.backend, deviceId
                }
            };
        }
        if (parsed.tool === "device_window_list" || parsed.tool === "device_focus_window") {
            if (match.backend === "windows-vm" && typeof parsed.params.helperTimeoutMs === "number" && parsed.params.helperTimeoutMs < 30000) {
                return {
                    status: 400, payload: {
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
                    command: parsed.tool === "device_focus_window"
                        ? ports.windowCommand(match.backend || "", windowHandle)
                        : ports.windowCommand(match.backend || "", null)
                },
            }, {
                ...match, device
            });
            if (result.status !== 200)
                return desktopInputFailure(result, parsed.tool);
            const payload: DesktopRecord = desktopRecord(result.payload) ? result.payload : {};
            const resultRecord: DesktopRecord = desktopRecord(payload.result) ? payload.result : {};
            try {
                const stdout = resultRecord.stdout;
                if (typeof stdout !== "string")
                    throw new Error("window-list-invalid-result");
                return {
                    status: 200, payload: {
                        ok: true, result: {
                            deviceId, tool: parsed.tool, ...(parsed.tool === "device_focus_window" ? parseGuestFocusWindow(stdout) : match.backend === "linux-vm" ? ports.linuxWindows(stdout) : parseWindowsGuestWindowList(stdout, ports.utf8Length(stdout))),
                        }
                    }
                };
            }
            catch (error) {
                return {
                    status: 502, payload: {
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
            const errorResult = (status: number, error: string): DesktopRpcResult => ({
                status, payload: {
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
                            status: 200, payload: {
                                ok: true, result: {
                                    ownerId, backend: match.backend, deviceId, tool: parsed.tool, provider: "hyper-v-console",
                                    width: capture.width, height: capture.height, incarnationId, capturedAt,
                                    mcpResult: {
                                        content: [
                                            {
                                                type: "image", data: capture.pngBase64, mimeType: "image/png"
                                            },
                                            {
                                                type: "text", text: JSON.stringify({
                                                    backend: match.backend, deviceId, width: capture.width, height: capture.height, incarnationId, capturedAt
                                                })
                                            },
                                        ]
                                    },
                                }
                            }
                        };
                    }
                    if (parsed.tool === "device_cursor_position" && !cursorMove) {
                        const cursor = await ports.cursor(client, identity);
                        return {
                            status: 200, payload: {
                                ok: true, result: {
                                    ownerId, backend: match.backend, deviceId, tool: parsed.tool, provider: "hyper-v-console", ...cursor, incarnationId
                                }
                            }
                        };
                    }
                    if (parsed.tool === "device_key") {
                        const keys = hyperVConsoleKeyTokens(parsed.params.key);
                        if (!keys)
                            return errorResult(400, "hyper-v-console-key-invalid");
                        await ports.input(client, {
                            ...identity, action: "key", keys
                        });
                    }
                    else if (parsed.tool === "device_type") {
                        const text = hyperVConsoleText(parsed.params.text);
                        if (text === null)
                            return errorResult(400, "hyper-v-console-text-invalid");
                        if (match.backend === "linux-vm") {
                            // Hyper-V's WMI TypeText reports success even when Linux does not
                            // receive the characters. Type through the verified guest X11
                            // session while retaining the owner/incarnation and per-VM lock.
                            const currentVms = await ports.vms(client, identity.selector.id);
                            if (currentVms.length !== 1 || currentVms[0].id.toLowerCase() !== vmId.toLowerCase()
                                || currentVms[0].name !== vmName || currentVms[0].notes !== identity.expectedNotes) {
                                return errorResult(409, "hyper-v-console-identity-mismatch");
                            }
                            if (currentVms[0].state !== "Running")
                                return errorResult(409, "hyper-v-display-unavailable");
                            const typed = await invoke(ownerId, {
                                ...parsed,
                                tool: "device_exec",
                                params: {
                                    ...parsed.params, command: ports.linuxTypeCommand(text)
                                },
                            }, match);
                            if (typed.status !== 200)
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
                            return errorResult(409, "hyper-v-console-screenshot-required");
                        const x = hyperVConsolePixel(parsed.tool === "device_drag" ? parsed.params.x1 : parsed.params.x, frame.width);
                        const y = hyperVConsolePixel(parsed.tool === "device_drag" ? parsed.params.y1 : parsed.params.y, frame.height);
                        if (x === null || y === null)
                            return errorResult(400, "hyper-v-console-pixel-invalid");
                        const pointer = {
                            ...identity, x, y, width: frame.width, height: frame.height, nativeWidth: frame.nativeWidth, nativeHeight: frame.nativeHeight
                        };
                        if (parsed.tool === "device_drag") {
                            const x2 = hyperVConsolePixel(parsed.params.x2, frame.width);
                            const y2 = hyperVConsolePixel(parsed.params.y2, frame.height);
                            if (x2 === null || y2 === null)
                                return errorResult(400, "hyper-v-console-pixel-invalid");
                            await ports.input(client, {
                                ...pointer, action: "drag", x2, y2, durationMs: Number(parsed.params.durationMs ?? 700)
                            });
                        }
                        else if (parsed.tool === "device_click" || parsed.tool === "device_double_click") {
                            const button = parsed.params.button === undefined ? "left" : parsed.params.button;
                            if (button !== "left" && button !== "right")
                                return errorResult(400, "hyper-v-console-button-invalid");
                            await ports.input(client, {
                                ...pointer, action: parsed.tool === "device_click" ? "click" : "doubleClick", button
                            });
                        }
                        else if (parsed.tool === "device_scroll") {
                            const direction = parsed.params.direction;
                            if (direction === "left" || direction === "right")
                                return errorResult(400, "hyper-v-console-scroll-unsupported");
                            if (direction !== "up" && direction !== "down")
                                return errorResult(400, "hyper-v-console-scroll-direction-invalid");
                            const amount = parsed.params.amount === undefined ? 1 : parsed.params.amount;
                            if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1 || amount > 10)
                                return errorResult(400, "hyper-v-console-scroll-amount-invalid");
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
                                        ...parsed.params, command: ports.linuxScrollCommand(direction, amount)
                                    },
                                }, match);
                                if (scrolled.status !== 200)
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
                            return errorResult(501, "broker-device-tool-not-supported");
                    }
                    return {
                        status: 200, payload: {
                            ok: true, result: {
                                ownerId, backend: match.backend, deviceId, tool: parsed.tool, provider: inputProvider, incarnationId, applied: true
                            }
                        }
                    };
                }
                catch (error) {
                    const providerError = ports.providerError(error);
                    const code = providerError ? providerError.code : ports.boundedErrorCode(error, "hyper-v-console-operation-failed");
                    const status = providerError?.validation ? 400
                        : ["hyper-v-console-identity-mismatch", "hyper-v-console-geometry-changed", "hyper-v-display-unavailable"].includes(code) ? 409
                            : code === "hyper-v-console-wmi-access-denied" ? 403 : 502;
                    return errorResult(status, code);
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
                    status: 409, payload: {
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
                    status: 409, payload: {
                        ok: false, error: ports.stateErrorCode(error) || (error instanceof Error ? error.message : "hyper-v-linux-ssh-private-key-invalid"), backend: match.backend, deviceId
                    }
                };
            }
            const timeoutMs = Math.min(300000, Math.max(1000, typeof parsed.params.helperTimeoutMs === "number" ? parsed.params.helperTimeoutMs : 30000));
            const common = {
                deviceRoot, privateRoot, sshPrivateKeyPath, knownHostsPath, guestUsername, networkAddress, timeoutMs
            };
            let providerCommand: DesktopCommand;
            let localPath: string | null = null;
            let stage: {
                handle: Stage;
                path: string;
            } | null = null;
            let sourceBytes: number | null = null;
            let downloadMaxBytes: number | null = null;
            try {
                if (parsed.tool === "device_exec") {
                    const ssh = ports.executable("ssh.exe") || ports.executable("ssh");
                    if (!ssh)
                        return {
                            status: 503, payload: {
                                ok: false, error: "missing-provider-command", missing: ["ssh"], backend: match.backend, deviceId
                            }
                        };
                    providerCommand = ports.sshCommand(common, ssh, typeof parsed.params.command === "string" ? parsed.params.command : "");
                }
                else {
                    const rawLocalPath = parsed.localPath || "";
                    localPath = ports.localPath(rawLocalPath, "hyper-v-linux-guest-transfer");
                    if (parsed.tool === "device_upload") {
                        const scp = ports.executable("scp.exe") || ports.executable("scp");
                        if (!scp)
                            return {
                                status: 503, payload: {
                                    ok: false, error: "missing-provider-command", missing: ["scp"], backend: match.backend, deviceId
                                }
                            };
                        stage = ports.allocateStage(privateRoot, "upload", "hyper-v-linux-guest-transfer-staging");
                        const maxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                        const source = ports.readSource(localPath, "hyper-v-linux-guest-upload", maxBytes);
                        if (source === null)
                            return {
                                status: 404, payload: {
                                    ok: false, error: "hyper-v-linux-guest-upload-source-missing", backend: match.backend, deviceId
                                }
                            };
                        sourceBytes = source.length;
                        ports.writeStage(privateRoot, stage.handle, source, "hyper-v-linux-guest-upload-staging");
                        providerCommand = ports.uploadCommand(common, scp, stage.path, parsed.remotePath || "");
                    }
                    else {
                        downloadMaxBytes = typeof parsed.params.maxFileBytes === "number" ? Math.min(parsed.params.maxFileBytes, 16 * 1024 * 1024) : 16 * 1024 * 1024;
                        const ssh = ports.executable("ssh.exe") || ports.executable("ssh");
                        if (!ssh)
                            return {
                                status: 503, payload: {
                                    ok: false, error: "missing-provider-command", missing: ["ssh"], backend: match.backend, deviceId
                                }
                            };
                        const remotePath = parsed.remotePath || "";
                        const encodedPath = ports.base64Text(remotePath);
                        providerCommand = ports.sshCommand(common, ssh, `set -o pipefail; p=$(printf %s ${encodedPath} | base64 -d); head -c ${downloadMaxBytes + 1} -- "$p" | base64 -w0`);
                    }
                }
            }
            catch (error) {
                return {
                    status: 400, payload: {
                        ok: false, error: ports.stateErrorCode(error) || (error instanceof Error ? error.message : "invalid-hyper-v-linux-guest-options"), backend: match.backend, deviceId
                    }
                };
            }
            const outputLimit = parsed.tool === "device_download" && downloadMaxBytes !== null
                ? Math.ceil((downloadMaxBytes + 1) / 3) * 4 + 4096
                : 32 * 1024;
            const execution = await ports.execute(providerCommand, timeoutMs, outputLimit);
            if (!desktopSucceeded(execution)) {
                if (stage)
                    ports.disposeStage(stage.handle);
                return {
                    status: 502,
                    payload: {
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
                    const encoded = String(execution.stdout || "").trim();
                    if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))
                        throw new Error("hyper-v-linux-guest-download-invalid-base64");
                    const downloaded = ports.decodeBase64(encoded);
                    if (downloaded.length > maxBytes) {
                        return {
                            status: 413, payload: {
                                ok: false, error: "hyper-v-linux-guest-download-source-too-large", ownerId, backend: match.backend, deviceId, bytes: downloaded.length, maxFileBytes: maxBytes
                            }
                        };
                    }
                    bytes = downloaded.length;
                    ports.writeDestination(localPath, downloaded, "hyper-v-linux-guest-download");
                }
                catch (error) {
                    return {
                        status: 502, payload: {
                            ok: false, error: ports.stateErrorCode(error) || "hyper-v-linux-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId
                        }
                    };
                }
            }
            else if (stage) {
                ports.disposeStage(stage.handle);
            }
            return {
                status: 200, payload: {
                    ok: true, result: {
                        ownerId, backend: match.backend, stateKey: match.stateKey, deviceId, tool: parsed.tool, provider: parsed.tool === "device_upload" ? "hyper-v-scp" : "hyper-v-ssh", status: 0, stdout: parsed.tool === "device_download" ? "" : execution.stdout || "", stderr: execution.stderr || "", ...(localPath ? {
                            localPath
                        } : {}), ...(parsed.remotePath ? {
                            remotePath: parsed.remotePath
                        } : {}), ...(bytes !== null ? {
                            bytes
                        } : {}), startsDevices: false
                    }
                }
            };
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
                    status: 409, payload: {
                        ok: false, error: "hyper-v-guest-metadata-invalid", backend: match.backend, deviceId
                    }
                };
            }
            try {
                ports.assertPrivateRoot(ownerId, "windows-vm", deviceId, privateRoot);
                const credentialAvailable = ports.readableSecret(credentialPath, "hyper-v-guest-credential");
                if (!credentialAvailable)
                    return {
                        status: 409, payload: {
                            ok: false, error: "hyper-v-guest-credential-unavailable", backend: match.backend, deviceId
                        }
                    };
            }
            catch (error) {
                return {
                    status: 409, payload: {
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
                                status: 404, payload: {
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
                if (transferStage)
                    ports.disposeStage(transferStage.handle);
                return {
                    status: 400, payload: {
                        ok: false, error: ports.stateErrorCode(error) || (error instanceof Error ? error.message : "invalid-hyper-v-guest-options"), backend: match.backend, deviceId
                    }
                };
            }
            const timeoutMs = Math.min(300000, Math.max(1000, typeof parsed.params.helperTimeoutMs === "number" ? parsed.params.helperTimeoutMs : 30000));
            let typedResult;
            try {
                typedResult = await ports.direct(powershell, timeoutMs, {
                    selector: {
                        kind: "id", id: vmId
                    }, expectedName: vmName,
                    expectedNotes: ports.ownershipNotes(ownerId, deviceId, incarnationId), credentialPath,
                }, guestAction);
            }
            catch (error) {
                if (transferStage)
                    ports.disposeStage(transferStage.handle);
                const providerError = ports.providerError(error);
                const code = providerError ? providerError.code : "guest-executor-failed";
                return {
                    status: providerError?.validation ? 400 : 502,
                    payload: {
                        ok: false,
                        error: "hyper-v-guest-provider-failed",
                        ownerId,
                        backend: match.backend,
                        deviceId,
                        execution: ports.redactExecution({
                            mode: "exec", provider: "hyper-v", status: null, error: code
                        }, "hyper-v-guest-provider-failed"),
                    },
                };
            }
            const observation = typedResult.action === "exec"
                ? {
                    ok: true as const, status: typedResult.status, stdout: typedResult.stdout, stderr: typedResult.stderr
                } : typedResult.action === "mkdir" || typedResult.action === "job"
                ? null
                : {
                    ok: true as const, localPath: typedResult.localPath, remotePath: typedResult.remotePath, bytes: typedResult.bytes
                };
            if (!observation)
                return {
                    status: 502, payload: {
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
                            status: 502, payload: {
                                ok: false, error: "hyper-v-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId
                            }
                        };
                    }
                    ports.writeDestination(transferLocalPath, downloaded, "hyper-v-guest-download");
                    observation.localPath = transferLocalPath;
                }
                catch (error) {
                    return {
                        status: 502, payload: {
                            ok: false, error: ports.stateErrorCode(error) || "hyper-v-guest-download-invalid-artifact", ownerId, backend: match.backend, deviceId
                        }
                    };
                }
                finally {
                    ports.disposeStage(transferStage.handle);
                }
            }
            else if (parsed.tool === "device_upload" && transferLocalPath && transferStage) {
                if (!("bytes" in observation) || observation.bytes !== uploadSourceBytes) {
                    ports.disposeStage(transferStage.handle);
                    return {
                        status: 502, payload: {
                            ok: false, error: "hyper-v-guest-upload-invalid-result", ownerId, backend: match.backend, deviceId
                        }
                    };
                }
                observation.localPath = transferLocalPath;
                ports.disposeStage(transferStage.handle);
            }
            const guestFailed = parsed.tool === "device_exec" && "status" in observation && observation.status !== 0;
            return {
                status: guestFailed ? 422 : 200,
                payload: {
                    ok: !guestFailed,
                    ...(guestFailed ? {
                        error: "hyper-v-guest-command-failed"
                    } : {}),
                    result: {
                        ownerId, backend: match.backend, stateKey: match.stateKey, deviceId, tool: parsed.tool, provider: "hyper-v-powershell-direct", ...observation, startsDevices: false
                    },
                },
            };
        }
        return {
            status: 501, payload: {
                ok: false, error: "broker-hyper-v-tool-not-supported"
            }
        };
    }
    return {
        invoke
    };
}
