import { androidWifiSerial, androidWifiTarget, androidWifiAttachNext, androidWirelessDeviceList } from "../domain/android-wireless.mjs";

/** @template Target @template Result
 * @param {import('../ports/android-wireless.mjs').AndroidWirelessPorts<Target,Result>} ports */
export function createAndroidWirelessApplication(ports) {
    /** @param {string} error @param {object} [detail] */
    function wirelessFailure(error, detail = {}) {
        return ports.textResult(false, JSON.stringify({ ok: false, error, ...detail }, null, 2));
    }
    /** @param {Target} target */
    function hostDevices(target) { return androidWirelessDeviceList(ports.listDevices(target)); }

    /** @param {import('../ports/android-wireless.mjs').AndroidWirelessArguments} args */
    function handle(args) {
        const { backend = "android-device", action = "status", serial, host, port = 5555, pairHost, pairPort, pairingCode, connect = false, timeoutMs = 15000 } = args;
        if (backend !== "android-device") return undefined;
        const discovery = ports.discover();
        if (!discovery.available) return wirelessFailure("android-wireless-missing-adb", { missing: ["adb"] });

        if (action === "status") {
            return ports.jsonResult({
                ok: true,
                backend,
                provider: "adb",
                actions: ["status", "usb-tcpip", "pair", "connect"],
                hostDevices: hostDevices(discovery.target),
                notes: [
                    "usb-tcpip requires a USB-connected Android device already trusted by adb",
                    "pair requires an Android 11+ wireless debugging pairing host, port, and pairing code",
                    "device_attach still claims the owner-scoped physical lease after the transport is visible",
                ],
            });
        }

        if (action === "usb-tcpip") {
            if (!serial) return wirelessFailure("android-wireless-usb-tcpip-requires-serial");
            const tcpip = ports.tcpip(discovery.target, serial, port || 5555, timeoutMs);
            if (tcpip.status !== 0) {
                return wirelessFailure("android-wireless-usb-tcpip-failed", { command: tcpip });
            }
            const connectTarget = androidWifiTarget(host, port, "");
            if (connect || connectTarget) {
                if (!connectTarget) return wirelessFailure("android-wireless-connect-requires-host", { tcpip });
                const connected = ports.connect(discovery.target, connectTarget, timeoutMs);
                if (connected.status !== 0) {
                    return wirelessFailure("android-wireless-connect-failed", {
                        tcpip,
                        command: connected,
                    });
                }
                return ports.jsonResult({
                    ok: true,
                    backend,
                    action,
                    serial,
                    target: connectTarget,
                    tcpip,
                    connect: connected,
                    stateMutated: false,
                    attachNext: androidWifiAttachNext(backend, connectTarget, port),
                });
            }
            return ports.jsonResult({
                ok: true,
                backend,
                action,
                serial,
                tcpip,
                stateMutated: false,
            });
        }

        if (action === "pair") {
            if (!pairHost || !pairPort || !pairingCode) return wirelessFailure("android-wireless-pair-requires-host-port-code");
            const pairTarget = androidWifiSerial(pairHost, pairPort);
            if (!pairTarget) return wirelessFailure("android-wireless-pair-requires-host-port-code");
            const paired = ports.pair(discovery.target, pairTarget, pairingCode, timeoutMs);
            if (paired.status !== 0) {
                return wirelessFailure("android-wireless-pair-failed", { command: paired });
            }
            const connectTarget = androidWifiTarget(host, port, serial);
            if (connect || connectTarget) {
                if (!connectTarget) return wirelessFailure("android-wireless-connect-requires-host", { pair: paired });
                const connected = ports.connect(discovery.target, connectTarget, timeoutMs);
                if (connected.status !== 0) {
                    return wirelessFailure("android-wireless-connect-failed", {
                        pair: paired,
                        command: connected,
                    });
                }
                return ports.jsonResult({
                    ok: true,
                    backend,
                    action,
                    pairTarget,
                    target: connectTarget,
                    pair: paired,
                    connect: connected,
                    stateMutated: false,
                    attachNext: androidWifiAttachNext(backend, connectTarget, port),
                });
            }
            return ports.jsonResult({
                ok: true,
                backend,
                action,
                pairTarget,
                pair: paired,
                stateMutated: false,
            });
        }

        if (action === "connect") {
            const connectTarget = androidWifiTarget(host, port, serial);
            if (!connectTarget) return wirelessFailure("android-wireless-connect-requires-host");
            const connected = ports.connect(discovery.target, connectTarget, timeoutMs);
            if (connected.status !== 0) return wirelessFailure("android-wireless-connect-failed", { command: connected });
            return ports.jsonResult({
                ok: true,
                backend,
                action,
                target: connectTarget,
                connect: connected,
                stateMutated: false,
                attachNext: androidWifiAttachNext(backend, connectTarget, port),
            });
        }

        return wirelessFailure("unsupported-android-wireless-action", { action });
    }
    return { handle };
}
