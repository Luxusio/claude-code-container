import { androidWifiSerial, androidWifiTarget, androidWifiAttachNext, androidWirelessCommandPayload, androidWirelessDeviceList } from "../domain/android-wireless.mjs";

// Capture the invocation and inspection intrinsics before caller getters run.
const invoke = Reflect.apply;
const functionSource = (() => {}).toString;
const asyncSource = /^async\b/;
const matchesAsyncSource = asyncSource.exec;

/** Compose required capabilities without invoking native accessors or probes.
 * @param {import('../ports/android-wireless.mjs').AndroidWirelessPorts} ports
 */
export function createAndroidWirelessApplication(ports) {
    /** @param {any} capability @param {string} name */
    function requireSynchronousCapability(capability, name) {
        if (typeof capability !== "function" || invoke(matchesAsyncSource, asyncSource, [invoke(functionSource, capability, [])])) {
            throw new TypeError(`Android wireless requires synchronous ${name}`);
        }
        return capability;
    }

    for (const name of ["discover", "listDevices", "tcpip", "pair", "connect", "selectJsonPublisher", "selectTextPublisher"]) {
        const descriptor = Object.getOwnPropertyDescriptor(ports, name);
        if (!descriptor || (!("value" in descriptor) && typeof descriptor.get !== "function")) {
            throw new TypeError(`Android wireless requires synchronous ${name}`);
        }
        if ("value" in descriptor) requireSynchronousCapability(descriptor.value, name);
    }

    // Accessor capabilities remain lazy, then receive the same check at selection.
    /** @param {keyof import('../ports/android-wireless.mjs').AndroidWirelessPorts} name */
    function selectCapability(name) {
        return requireSynchronousCapability(ports[name], name);
    }

    /** @param {() => any} project */
    function publishJson(project) {
        const publish = invoke(selectCapability("selectJsonPublisher"), ports, []);
        return publish(project());
    }

    /** @param {string} error @param {any} [detail] */
    function wirelessFailure(error, detail = {}) {
        const publish = invoke(selectCapability("selectTextPublisher"), ports, []);
        return publish(false, JSON.stringify({ ok: false, error, ...detail }, null, 2));
    }

    /** @param {{adb: any}} discovery */
    function hostDevices(discovery) {
        if (!discovery.adb) return { available: false, missing: ["adb"], devices: [] };
        return androidWirelessDeviceList(invoke(selectCapability("listDevices"), ports, [discovery]));
    }

    /** @param {any} args */
    function handle(args) {
        const { backend = "android-device", action = "status", serial, host, port = 5555, pairHost, pairPort, pairingCode, connect = false, timeoutMs = 15000 } = args;
        if (backend !== "android-device") return undefined;
        const discovery = invoke(selectCapability("discover"), ports, []);
        if (!discovery.adb) return wirelessFailure("android-wireless-missing-adb", { missing: ["adb"] });

        if (action === "status") {
            return publishJson(() => ({
                ok: true,
                backend,
                provider: "adb",
                actions: ["status", "usb-tcpip", "pair", "connect"],
                hostDevices: hostDevices(discovery),
                notes: [
                    "usb-tcpip requires a USB-connected Android device already trusted by adb",
                    "pair requires an Android 11+ wireless debugging pairing host, port, and pairing code",
                    "device_attach still claims the owner-scoped physical lease after the transport is visible",
                ],
            }));
        }

        if (action === "usb-tcpip") {
            if (!serial) return wirelessFailure("android-wireless-usb-tcpip-requires-serial");
            const tcpipArgs = ["-s", serial, "tcpip", String(port || 5555)];
            const tcpip = invoke(selectCapability("tcpip"), ports, [discovery.adb, tcpipArgs, timeoutMs]);
            if (tcpip.status !== 0) {
                return wirelessFailure("android-wireless-usb-tcpip-failed", { command: androidWirelessCommandPayload(tcpipArgs, tcpip) });
            }
            const connectTarget = androidWifiTarget(host, port, "");
            if (connect || connectTarget) {
                if (!connectTarget) return wirelessFailure("android-wireless-connect-requires-host", { tcpip: androidWirelessCommandPayload(tcpipArgs, tcpip) });
                const connectArgs = ["connect", connectTarget];
                const connected = invoke(selectCapability("connect"), ports, [discovery.adb, connectArgs, timeoutMs]);
                if (connected.status !== 0) {
                    return wirelessFailure("android-wireless-connect-failed", {
                        tcpip: androidWirelessCommandPayload(tcpipArgs, tcpip),
                        command: androidWirelessCommandPayload(connectArgs, connected),
                    });
                }
                return publishJson(() => ({
                    ok: true,
                    backend,
                    action,
                    serial,
                    target: connectTarget,
                    tcpip: androidWirelessCommandPayload(tcpipArgs, tcpip),
                    connect: androidWirelessCommandPayload(connectArgs, connected),
                    stateMutated: false,
                    attachNext: androidWifiAttachNext(backend, connectTarget, port),
                }));
            }
            return publishJson(() => ({
                ok: true,
                backend,
                action,
                serial,
                tcpip: androidWirelessCommandPayload(tcpipArgs, tcpip),
                stateMutated: false,
            }));
        }

        if (action === "pair") {
            if (!pairHost || !pairPort || !pairingCode) return wirelessFailure("android-wireless-pair-requires-host-port-code");
            const pairTarget = androidWifiSerial(pairHost, pairPort);
            if (!pairTarget) return wirelessFailure("android-wireless-pair-requires-host-port-code");
            const pairArgs = ["pair", pairTarget, String(pairingCode)];
            const paired = invoke(selectCapability("pair"), ports, [discovery.adb, pairArgs, timeoutMs]);
            if (paired.status !== 0) {
                return wirelessFailure("android-wireless-pair-failed", { command: androidWirelessCommandPayload(pairArgs, paired, [2]) });
            }
            const connectTarget = androidWifiTarget(host, port, serial);
            if (connect || connectTarget) {
                if (!connectTarget) return wirelessFailure("android-wireless-connect-requires-host", { pair: androidWirelessCommandPayload(pairArgs, paired, [2]) });
                const connectArgs = ["connect", connectTarget];
                const connected = invoke(selectCapability("connect"), ports, [discovery.adb, connectArgs, timeoutMs]);
                if (connected.status !== 0) {
                    return wirelessFailure("android-wireless-connect-failed", {
                        pair: androidWirelessCommandPayload(pairArgs, paired, [2]),
                        command: androidWirelessCommandPayload(connectArgs, connected),
                    });
                }
                return publishJson(() => ({
                    ok: true,
                    backend,
                    action,
                    pairTarget,
                    target: connectTarget,
                    pair: androidWirelessCommandPayload(pairArgs, paired, [2]),
                    connect: androidWirelessCommandPayload(connectArgs, connected),
                    stateMutated: false,
                    attachNext: androidWifiAttachNext(backend, connectTarget, port),
                }));
            }
            return publishJson(() => ({
                ok: true,
                backend,
                action,
                pairTarget,
                pair: androidWirelessCommandPayload(pairArgs, paired, [2]),
                stateMutated: false,
            }));
        }

        if (action === "connect") {
            const connectTarget = androidWifiTarget(host, port, serial);
            if (!connectTarget) return wirelessFailure("android-wireless-connect-requires-host");
            const connectArgs = ["connect", connectTarget];
            const connected = invoke(selectCapability("connect"), ports, [discovery.adb, connectArgs, timeoutMs]);
            if (connected.status !== 0) return wirelessFailure("android-wireless-connect-failed", { command: androidWirelessCommandPayload(connectArgs, connected) });
            return publishJson(() => ({
                ok: true,
                backend,
                action,
                target: connectTarget,
                connect: androidWirelessCommandPayload(connectArgs, connected),
                stateMutated: false,
                attachNext: androidWifiAttachNext(backend, connectTarget, port),
            }));
        }

        return wirelessFailure("unsupported-android-wireless-action", { action });
    }
    return { handle };
}
