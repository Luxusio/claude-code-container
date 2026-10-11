/** @typedef {import("../ports/physical-stop.mjs").PhysicalDevice} PhysicalDevice */
/** @typedef {import("../ports/physical-stop.mjs").PhysicalLifecycle} PhysicalLifecycle */
/** @typedef {import("../ports/physical-stop.mjs").PhysicalExitResult} PhysicalExitResult */

/** Complete direct physical stop policy, composed only by trusted facades.
 * @param {import("../ports/physical-stop.mjs").PhysicalStopPorts} ports
 */
export function createPhysicalStopApplication(ports) {
    /** @param {string} deviceId @param {PhysicalDevice} device @param {string} operation */
    function claimLifecycle(deviceId, device, operation) {
        const lifecycle = { runtimeId: ports.runtimeId(), operation, claimedAt: ports.now() };
        const claimed = { ...device, lifecycle, status: operation === "detach" ? "detaching" : "stopping", updatedAt: ports.now() };
        return { lifecycle, transition: ports.transition(deviceId, device, claimed) };
    }

    /** @param {string} deviceId @param {PhysicalLifecycle} lifecycle */
    function currentLifecycleDevice(deviceId, lifecycle) {
        const current = ports.find(deviceId);
        return current?.lifecycle?.runtimeId === lifecycle.runtimeId ? current : null;
    }

    /** @param {string} deviceId @param {PhysicalLifecycle} lifecycle @param {PhysicalDevice} original @param {Partial<PhysicalDevice>} actual */
    function abortLifecycle(deviceId, lifecycle, original, actual = {}) {
        const current = currentLifecycleDevice(deviceId, lifecycle);
        if (!current) return { matched: false, found: Boolean(ports.find(deviceId)) };
        const restored = { ...current, status: original.status, ...actual, updatedAt: ports.now() };
        if (Object.prototype.hasOwnProperty.call(original, "lifecycle")) restored.lifecycle = original.lifecycle;
        else delete restored.lifecycle;
        return ports.transition(deviceId, current, restored);
    }

    /** @param {PhysicalDevice} device @param {string | null | undefined} [adb] @returns {Promise<PhysicalExitResult>} */
    async function cleanup(device, adb) {
        if (ports.backend === "android-device") {
            if (!device.recording?.active) return { exited: true };
            const recorderSignal = ports.signalRecording(device.recording, "SIGINT");
            const adbFallback = adb && device.serial ? ports.stopAdbRecording(adb, device.serial) : null;
            if (recorderSignal.signaled) {
                const exited = await ports.waitRecordingExit(device.recording.pid, 3000);
                if (exited) return { exited: true };
                return { exited: false, error: `Android real-device recording did not exit within 3000ms for ${device.id}; recording metadata and physical lease were preserved for retry.` };
            }
            if (recorderSignal.exited || adbFallback?.status === 0) return { exited: true };
            const signalFailure = recorderSignal.reason || "owned recorder signaling failed";
            const adbFailure = adbFallback
                ? adbFallback.stderr || adbFallback.stdout || `exit ${adbFallback.status}`
                : "ADB fallback unavailable";
            return { exited: false, error: `Android real-device recording cleanup failed for ${device.id}: ${signalFailure}; ${adbFailure}. Recording metadata and physical lease were preserved for retry.` };
        }

        const recording = await stopIosRecording(ports, device.recording, device.id);
        if (!recording.exited) return recording;
        const appium = await ports.stopOwnedAppium(device.appium, "iOS physical Appium");
        if (!appium.exited) {
            return { ...appium, recordingStopped: Boolean(device.recording?.active), error: `${appium.error}; Appium metadata and physical lease were preserved for retry.` };
        }
        return { exited: true };
    }

    /** @param {import("../ports/physical-stop.mjs").IosPhysicalStopPorts} iosPorts
     * @param {import("../ports/physical-stop.mjs").PhysicalRecording | null | undefined} recording
     * @param {string} deviceId @returns {Promise<PhysicalExitResult>}
     */
    async function stopIosRecording(iosPorts, recording, deviceId) {
        if (!recording?.active) return { exited: true };
        const recorderSignal = iosPorts.signalRecording(recording, "SIGINT");
        if (recorderSignal.reason === "runtime-process-exited") return { exited: true };
        if (!recorderSignal.signaled) {
            return { exited: false, error: `iOS physical recording process could not be safely stopped for ${deviceId} (${recorderSignal.reason || "unknown"}); recording metadata and physical lease were preserved for retry.` };
        }
        if (await iosPorts.waitRecordingExit(recording, 3000)) return { exited: true };
        return { exited: false, error: `iOS physical recording did not exit within 3000ms for ${deviceId}; recording metadata and physical lease were preserved for retry.` };
    }

    /** @param {string} deviceId @param {string} operation @param {{found: boolean}} transition
     * @returns {import("../ports/physical-stop.mjs").PhysicalStopOutcome} */
    function stateConflict(deviceId, operation, transition) {
        return { kind: "conflict", backend: ports.backend, deviceId, operation, found: transition.found };
    }

    /** @param {string} deviceId @returns {Promise<import("../ports/physical-stop.mjs").PhysicalStopOutcome>} */
    async function stop(deviceId) {
        const device = ports.find(deviceId);
        if (!device) return { kind: "missing" };
        const claim = claimLifecycle(deviceId, device, "stop");
        if (!claim.transition.matched) return stateConflict(deviceId, "stop-claim", claim.transition);
        const adb = ports.backend === "android-device" ? ports.discoverAdb() : undefined;
        const stopped = await cleanup(device, adb);
        if (!stopped.exited) {
            if (ports.backend === "ios-device") {
                abortLifecycle(deviceId, claim.lifecycle, device, stopped.recordingStopped
                    ? { recording: { ...device.recording, active: false, endedAt: ports.now() } }
                    : {});
            } else abortLifecycle(deviceId, claim.lifecycle, device);
            return { kind: "failure", error: stopped.error };
        }
        const current = currentLifecycleDevice(deviceId, claim.lifecycle);
        if (!current) return stateConflict(deviceId, "stop", { found: Boolean(ports.find(deviceId)) });
        const updated = { ...current, status: "attached", pid: null, appium: null, recording: null, updatedAt: ports.now() };
        delete updated.lifecycle;
        const transition = ports.transition(deviceId, current, updated);
        if (!transition.matched) return stateConflict(deviceId, "stop", transition);
        return { kind: "stopped", device: updated };
    }

    return { stop, claimLifecycle, currentLifecycleDevice, abortLifecycle, cleanup };
}
