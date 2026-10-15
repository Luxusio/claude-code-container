import { androidWifiSerial, androidWifiTarget, androidWifiAttachNext } from "../domain/android-wireless.mjs";

/** @template Target
 * @param {import('../ports/android-wireless.mjs').AndroidWirelessPorts<Target>} ports */
export function createAndroidWirelessApplication(ports) {
    /** @param {string} error @param {object} [detail]
     * @param {import('../ports/android-wireless.mjs').AndroidWirelessPreparation} [preparation]
     * @returns {import('../ports/android-wireless.mjs').AndroidWirelessOutcome} */
    function refused(error, detail, preparation) {
        return { kind: "refused", error, ...(detail ? { detail } : {}), ...(preparation ? { preparation } : {}) };
    }
    /** @param {string} error @param {import('../ports/android-wireless.mjs').AndroidWirelessEvidence} evidence
     * @param {import('../ports/android-wireless.mjs').AndroidWirelessPreparation} [preparation]
     * @returns {import('../ports/android-wireless.mjs').AndroidWirelessOutcome} */
    function failed(error, evidence, preparation) {
        return { kind: "command-failed", error, evidence, ...(preparation ? { preparation } : {}) };
    }

    /** @param {import('../ports/android-wireless.mjs').AndroidWirelessArguments} args
     * @returns {import('../ports/android-wireless.mjs').AndroidWirelessOutcome|undefined} */
    function handle(args) {
        const { backend = "android-device", action = "status", serial, host, port = 5555, pairHost, pairPort, pairingCode, connect = false, timeoutMs = 15000 } = args;
        if (backend !== "android-device") return undefined;
        const discovery = ports.discover();
        if (!discovery.available) return refused("android-wireless-missing-adb", { missing: ["adb"] });

        if (action === "status") {
            return { kind: "status", hostDevices: ports.listDevices(discovery.target) };
        }
        if (action === "usb-tcpip") {
            if (!serial) return refused("android-wireless-usb-tcpip-requires-serial");
            const tcpip = ports.tcpip(discovery.target, serial, port || 5555, timeoutMs);
            if (!tcpip.ok) return failed("android-wireless-usb-tcpip-failed", tcpip.evidence);
            const preparation = { kind: /** @type {const} */ ("tcpip"), evidence: tcpip.evidence };
            const connectTarget = androidWifiTarget(host, port, "");
            if (connect || connectTarget) {
                if (!connectTarget) return refused("android-wireless-connect-requires-host", undefined, preparation);
                const connected = ports.connect(discovery.target, connectTarget, timeoutMs);
                if (!connected.ok) return failed("android-wireless-connect-failed", connected.evidence, preparation);
                return {
                    kind: "completed", action, serial, target: connectTarget, preparation, connection: connected.evidence,
                    attachNext: androidWifiAttachNext(backend, connectTarget, port),
                };
            }
            return { kind: "completed", action, serial, preparation };
        }
        if (action === "pair") {
            if (!pairHost || !pairPort || !pairingCode) return refused("android-wireless-pair-requires-host-port-code");
            const pairTarget = androidWifiSerial(pairHost, pairPort);
            if (!pairTarget) return refused("android-wireless-pair-requires-host-port-code");
            const paired = ports.pair(discovery.target, pairTarget, pairingCode, timeoutMs);
            if (!paired.ok) return failed("android-wireless-pair-failed", paired.evidence);
            const preparation = { kind: /** @type {const} */ ("pair"), evidence: paired.evidence };
            const connectTarget = androidWifiTarget(host, port, serial);
            if (connect || connectTarget) {
                if (!connectTarget) return refused("android-wireless-connect-requires-host", undefined, preparation);
                const connected = ports.connect(discovery.target, connectTarget, timeoutMs);
                if (!connected.ok) return failed("android-wireless-connect-failed", connected.evidence, preparation);
                return {
                    kind: "completed", action, pairTarget, target: connectTarget, preparation, connection: connected.evidence,
                    attachNext: androidWifiAttachNext(backend, connectTarget, port),
                };
            }
            return { kind: "completed", action, pairTarget, preparation };
        }
        if (action === "connect") {
            const connectTarget = androidWifiTarget(host, port, serial);
            if (!connectTarget) return refused("android-wireless-connect-requires-host");
            const connected = ports.connect(discovery.target, connectTarget, timeoutMs);
            if (!connected.ok) return failed("android-wireless-connect-failed", connected.evidence);
            return {
                kind: "completed", action, target: connectTarget, connection: connected.evidence,
                attachNext: androidWifiAttachNext(backend, connectTarget, port),
            };
        }
        return refused("unsupported-android-wireless-action", { action });
    }
    return { handle };
}
